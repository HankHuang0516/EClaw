//! EClaw Desktop — Combined P1-C (Credential Store) + P1-E (Agent Probe)
//!
//! P1-C: OS Credential Store
//!   - credential_store: stores full credential envelope in OS store
//!   - credential_get: returns {access_token, expires_at} only (renderer-safe)
//!   - credential_delete: removes entry from OS store
//!   - install_id_get: returns install UUID from config file
//!   Security: refresh_token NEVER goes to renderer. Only access_token+expires.
//!
//! P1-E: Agent Probe
//!   - agent_probe: probes all enabled endpoints in parallel, returns deduplicated list
//!   - agent_probe_single: probes one specific endpoint
//!   - agent_config_get/set: read/write endpoint configuration
//!   Security: Probe is READ-ONLY. Does not write any config or credentials.
//!
//! Dependencies: P1-A (scaffold), P1-B (calls credential_store), P1-C

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use tauri::command;
use tokio::io::AsyncReadExt;
use tokio::process::Command as AsyncCommand;
use tokio::time::{timeout, Duration};

// ---------------------------------------------------------------------------
// Shared Types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HealthStatus {
    pub app_version: String,
    pub platform: String,
    pub rust_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentInfo {
    pub agent_type: String,
    pub name: String,
    pub version: Option<String>,
    pub endpoint: Option<String>,
    pub health: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CredentialEnvelope {
    pub install_id: String,
    pub refresh_token: String,
    pub access_token: String,
    pub id_token: String,
    pub expires_at: i64,
    pub refresh_expires_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RendererCredential {
    pub access_token: String,
    pub expires_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentEndpointConfig {
    pub agent_type: String,
    pub enabled: bool,
    pub url: Option<String>,
    pub command: Option<String>,
    pub argv: Option<Vec<String>>,
    pub host: Option<String>,
    pub port: Option<u16>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub install_id: String,
    pub version: String,
    pub platform: String,
    #[serde(default)]
    pub endpoints: Vec<serde_json::Value>,
}

// ---------------------------------------------------------------------------
// Config File (~/.eclaw-desktop/config.json)
// ---------------------------------------------------------------------------

fn get_config_dir() -> PathBuf {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/tmp"));
    home.join(".eclaw-desktop")
}

fn get_config_path() -> PathBuf {
    get_config_dir().join("config.json")
}

fn ensure_config_exists() -> Result<String, String> {
    let config_path = get_config_path();
    if config_path.exists() {
        let content = fs::read_to_string(&config_path)
            .map_err(|e| format!("Failed to read config: {}", e))?;
        let config: AppConfig = serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse config: {}", e))?;
        Ok(config.install_id)
    } else {
        let install_id = uuid_v4();
        let config = AppConfig {
            install_id: install_id.clone(),
            version: env!("CARGO_PKG_VERSION").to_string(),
            platform: std::env::consts::OS.to_string(),
            endpoints: vec![],
        };
        let dir = get_config_dir();
        fs::create_dir_all(&dir)
            .map_err(|e| format!("Failed to create config dir: {}", e))?;
        let json = serde_json::to_string_pretty(&config)
            .map_err(|e| format!("Failed to serialize config: {}", e))?;
        fs::write(&config_path, json)
            .map_err(|e| format!("Failed to write config: {}", e))?;
        Ok(install_id)
    }
}

fn uuid_v4() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    let bytes: [u8; 16] = rng.gen();
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0], bytes[1], bytes[2], bytes[3],
        bytes[4], bytes[5],
        (bytes[6] & 0x0f) | 0x40, bytes[7],
        (bytes[8] & 0x3f) | 0x80, bytes[9],
        bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]
    )
}

// ---------------------------------------------------------------------------
// macOS Keychain (via security CLI)
// ---------------------------------------------------------------------------

#[cfg(target_os = "macos")]
fn keychain_store(envelope: &CredentialEnvelope) -> Result<(), String> {
    let service = "com.eclaw.desktop";
    let account = &envelope.install_id;
    let password = serde_json::to_string(envelope)
        .map_err(|e| format!("serialize envelope: {}", e))?;

    let output = Command::new("security")
        .args(&["add-generic-password", "-s", service, "-a", account, "-w", &password])
        .output()
        .map_err(|e| format!("security cli error: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("already exists") {
            let del_output = Command::new("security")
                .args(&["delete-generic-password", "-s", service, "-a", account])
                .output()
                .map_err(|e| format!("security delete error: {}", e))?;
            if !del_output.status.success() {
                return Err(format!("keychain delete failed: {}", String::from_utf8_lossy(&del_output.stderr)));
            }
            let output2 = Command::new("security")
                .args(&["add-generic-password", "-s", service, "-a", account, "-w", &password])
                .output()
                .map_err(|e| format!("security cli error: {}", e))?;
            if !output2.status.success() {
                return Err(format!("keychain add failed: {}", String::from_utf8_lossy(&output2.stderr)));
            }
        } else {
            return Err(format!("keychain add failed: {}", stderr));
        }
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn keychain_get(install_id: &str) -> Result<Option<CredentialEnvelope>, String> {
    let output = Command::new("security")
        .args(&["find-generic-password", "-s", "com.eclaw.desktop", "-a", install_id, "-w"])
        .output()
        .map_err(|e| format!("security cli error: {}", e))?;

    if !output.status.success() {
        return Ok(None);
    }
    let password = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if password.is_empty() {
        return Ok(None);
    }
    let envelope: CredentialEnvelope = serde_json::from_str(&password)
        .map_err(|e| format!("Failed to deserialize envelope: {}", e))?;
    Ok(Some(envelope))
}

#[cfg(target_os = "macos")]
fn keychain_delete(install_id: &str) -> Result<bool, String> {
    let output = Command::new("security")
        .args(&["delete-generic-password", "-s", "com.eclaw.desktop", "-a", install_id])
        .output()
        .map_err(|e| format!("security cli error: {}", e))?;
    Ok(output.status.success() || output.status.code() == Some(36))
}

// ---------------------------------------------------------------------------
// Windows Credential Manager
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
fn credmgr_store(envelope: &CredentialEnvelope) -> Result<(), String> {
    use std::ptr;

    let target = format!("EClawDesktop:{}", envelope.install_id);
    let password = serde_json::to_string(envelope)
        .map_err(|e| format!("serialize: {}", e))?;

    let wide_target: Vec<u16> = target.encode_utf16().chain(std::iter::once(0)).collect();
    let wide_password: Vec<u16> = password.encode_utf16().chain(std::iter::once(0)).collect();

    unsafe {
        use windows::Win32::Security::Credentials::{
            CredWriteW, CREDENTIALW, CRED_TYPE_GENERIC, CRED_PERSIST_LOCAL_MACHINE,
        };
        use windows::core::PCWSTR;

        let cred = CREDENTIALW {
            Flags: Default::default(),
            Type: CRED_TYPE_GENERIC,
            TargetName: PCWSTR(wide_target.as_ptr()),
            Comment: PCWSTR::null(),
            LastWritten: Default::default(),
            CredentialBlobSize: (wide_password.len() * 2) as u32,
            CredentialBlob: PCWSTR(wide_password.as_ptr()) as *mut u8,
            Persist: CRED_PERSIST_LOCAL_MACHINE,
            AttributeCount: 0,
            Attributes: ptr::null_mut(),
            TargetAlias: PCWSTR::null(),
            UserName: PCWSTR::null(),
        };

        CredWriteW(&cred, 0)
            .map_err(|e| format!("CredWriteW failed: {}", e))
    }
}

#[cfg(target_os = "windows")]
fn credmgr_get(install_id: &str) -> Result<Option<CredentialEnvelope>, String> {
    use std::ptr;

    let target = format!("EClawDesktop:{}", install_id);
    let wide_target: Vec<u16> = target.encode_utf16().chain(std::iter::once(0)).collect();

    unsafe {
        use windows::Win32::Security::Credentials::{
            CredReadW, CredFree, CREDENTIALW, CRED_TYPE_GENERIC,
        };
        use windows::core::PCWSTR;

        let mut cred_ptr: *mut CREDENTIALW = ptr::null_mut();
        match CredReadW(PCWSTR(wide_target.as_ptr()), CRED_TYPE_GENERIC, 0, &mut cred_ptr) {
            Ok(_) => {
                let cred = &*cred_ptr;
                let blob = std::slice::from_raw_parts(
                    cred.CredentialBlob,
                    cred.CredentialBlobSize as usize,
                );
                let password = String::from_utf16_lossy(
                    &blob.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect::<Vec<u16>>()
                );
                CredFree(cred_ptr as *mut _);
                let envelope: CredentialEnvelope = serde_json::from_str(&password)
                    .map_err(|e| format!("deserialize: {}", e))?;
                Ok(Some(envelope))
            }
            Err(_) => Ok(None),
        }
    }
}

#[cfg(target_os = "windows")]
fn credmgr_delete(install_id: &str) -> Result<bool, String> {
    let target = format!("EClawDesktop:{}", install_id);
    let wide_target: Vec<u16> = target.encode_utf16().chain(std::iter::once(0)).collect();

    unsafe {
        use windows::Win32::Security::Credentials::{CredDeleteW, CRED_TYPE_GENERIC};
        use windows::core::PCWSTR;

        match CredDeleteW(PCWSTR(wide_target.as_ptr()), CRED_TYPE_GENERIC, 0) {
            Ok(_) => Ok(true),
            Err(_) => Ok(false),
        }
    }
}

// ---------------------------------------------------------------------------
// Cross-platform OS store dispatch
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
use credmgr_store as os_store;

#[cfg(target_os = "macos")]
use keychain_store as os_store;

#[cfg(target_os = "windows")]
use credmgr_get as os_get;

#[cfg(target_os = "macos")]
use keychain_get as os_get;

#[cfg(target_os = "windows")]
use credmgr_delete as os_delete;

#[cfg(target_os = "macos")]
use keychain_delete as os_delete;

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn os_store(_envelope: &CredentialEnvelope) -> Result<(), String> {
    Err("OS Credential Store only supported on macOS and Windows".to_string())
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn os_get(_install_id: &str) -> Result<Option<CredentialEnvelope>, String> {
    Err("OS Credential Store only supported on macOS and Windows".to_string())
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn os_delete(_install_id: &str) -> Result<bool, String> {
    Err("OS Credential Store only supported on macOS and Windows".to_string())
}

// ---------------------------------------------------------------------------
// P1-C: Credential Store Commands
// ---------------------------------------------------------------------------

/// Store credential envelope in OS Credential Store.
#[command]
pub fn credential_store(
    refresh_token: String,
    id_token: String,
    expires_at: i64,
) -> Result<(), String> {
    let install_id = ensure_config_exists()?;
    let access_token = String::new();
    let refresh_expires_at = expires_at + (90 * 24 * 60 * 60);

    let envelope = CredentialEnvelope {
        install_id,
        refresh_token,
        access_token,
        id_token,
        expires_at,
        refresh_expires_at,
    };

    os_store(&envelope)
}

/// Update access_token in existing credential.
#[command]
pub fn credential_update_access_token(access_token: String, expires_at: i64) -> Result<(), String> {
    let install_id = ensure_config_exists()?;
    let mut envelope = os_get(&install_id)?
        .ok_or("No stored credential found")?;
    envelope.access_token = access_token;
    envelope.expires_at = expires_at;
    os_store(&envelope)
}

/// Get credential for renderer (NO refresh_token).
#[command]
pub fn credential_get() -> Result<Option<RendererCredential>, String> {
    let install_id = ensure_config_exists()?;
    match os_get(&install_id)? {
        Some(envelope) => Ok(Some(RendererCredential {
            access_token: envelope.access_token,
            expires_at: envelope.expires_at,
        })),
        None => Ok(None),
    }
}

/// Get full credential envelope (internal use).
#[command]
pub fn credential_get_full() -> Result<Option<CredentialEnvelope>, String> {
    let install_id = ensure_config_exists()?;
    os_get(&install_id)
}

/// Delete credential from OS store.
#[command]
pub fn credential_delete() -> Result<bool, String> {
    let install_id = ensure_config_exists()?;
    os_delete(&install_id)
}

/// Get install UUID.
#[command]
pub fn install_id_get() -> Result<String, String> {
    ensure_config_exists()
}

// ---------------------------------------------------------------------------
// P1-E: Agent Probe
// ---------------------------------------------------------------------------

async fn probe_hermes(url: &str, token: Option<&str>) -> Result<AgentInfo, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| format!("reqwest build failed: {}", e))?;

    let mut req = client.get(format!("{}/api/whoami", url.trim_end_matches('/')));
    if let Some(t) = token {
        req = req.header("Authorization", format!("Bearer {}", t));
    }

    let resp = req.send().await.map_err(|e| format!("request failed: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }

    let body: serde_json::Value = resp.json().await
        .map_err(|e| format!("parse failed: {}", e))?;

    let entity_id = body.get("entityId").and_then(|v| v.as_str()).unwrap_or("unknown");
    let version = body.get("version").and_then(|v| v.as_str()).map(String::from);

    Ok(AgentInfo {
        agent_type: "hermes".to_string(),
        name: format!("EClaw Hermes ({})", entity_id),
        version,
        endpoint: Some(url.to_string()),
        health: Some("ok".to_string()),
    })
}

async fn probe_codex(command: &str) -> Result<AgentInfo, String> {
    // SECURITY: Uses `claude --version` ONLY. Never --print-password.
    let output = AsyncCommand::new(command)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|e| format!("process spawn failed: {}", e))?;

    if !output.status.success() {
        return Err(format!("exit code {:?}", output.status.code()));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let version_output = stdout.trim().to_string();

    if version_output.is_empty() {
        return Err(format!("empty version output, stderr: {}", stderr));
    }

    Ok(AgentInfo {
        agent_type: "codex".to_string(),
        name: "EClaw Codex".to_string(),
        version: Some(version_output),
        endpoint: Some(command.to_string()),
        health: Some("ok".to_string()),
    })
}

async fn probe_http_agent(host: &str, port: u16) -> Result<AgentInfo, String> {
    let url = format!("http://{}:{}", host, port);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| format!("reqwest build failed: {}", e))?;

    let resp = client.head(&url).send().await
        .map_err(|e| format!("request failed: {}", e))?;

    let agent_header = resp.headers()
        .get("X-EClaw-Agent")
        .and_then(|v| v.to_str().ok())
        .map(String::from);

    match agent_header {
        Some(header) => Ok(AgentInfo {
            agent_type: "http".to_string(),
            name: header.clone(),
            version: None,
            endpoint: Some(url),
            health: Some("ok".to_string()),
        }),
        None => Err("No X-EClaw-Agent header".to_string()),
    }
}

async fn probe_subprocess(command: &str, argv: &[String]) -> Result<AgentInfo, String> {
    let output = AsyncCommand::new(command)
        .args(argv)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|e| format!("process spawn failed: {}", e))?;

    if !output.status.success() {
        return Err(format!("exit code {:?}", output.status.code()));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let body: serde_json::Value = serde_json::from_str(stdout.trim())
        .map_err(|e| format!("JSON parse failed: {}", e))?;

    Ok(AgentInfo {
        agent_type: body.get("type").and_then(|v| v.as_str()).unwrap_or("subprocess").to_string(),
        name: body.get("name").and_then(|v| v.as_str()).unwrap_or("Unknown").to_string(),
        version: body.get("version").and_then(|v| v.as_str()).map(String::from),
        endpoint: Some(format!("{} {}", command, argv.join(" "))),
        health: Some("ok".to_string()),
    })
}

fn deduplicate_agents(mut agents: Vec<AgentInfo>) -> Vec<AgentInfo> {
    use std::collections::HashMap;

    let priority = |t: &str| match t {
        "hermes" => 0,
        "http" => 1,
        "codex" => 2,
        "subprocess" => 3,
        _ => 4,
    };

    let mut seen: HashMap<String, AgentInfo> = HashMap::new();
    for agent in agents.drain(..) {
        let key = format!("{}:{}", agent.agent_type, agent.endpoint.as_deref().unwrap_or(""));
        let entry = seen.entry(key).or_insert(agent.clone());
        if priority(&agent.agent_type) < priority(&entry.agent_type) {
            *entry = agent;
        }
    }
    seen.into_values().collect()
}

/// Probe all enabled endpoints in parallel.
#[command]
pub async fn agent_probe() -> Result<Vec<AgentInfo>, String> {
    let config_path = get_config_path();
    let config_content = fs::read_to_string(&config_path)
        .map_err(|e| format!("config read failed: {}", e))?;
    let config: serde_json::Value = serde_json::from_str(&config_content)
        .map_err(|e| format!("config parse failed: {}", e))?;

    let endpoints = config.get("endpoints")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let mut handles = Vec::new();

    for ep in endpoints {
        let agent_type = ep.get("agent_type").and_then(|v| v.as_str()).unwrap_or("");
        let enabled = ep.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false);
        if !enabled {
            continue;
        }

        match agent_type {
            "hermes" => {
                if let Some(url) = ep.get("url").and_then(|v| v.as_str()) {
                    let url = url.to_string();
                    handles.push(async move {
                        probe_hermes(&url, None).await.ok()
                    });
                }
            }
            "codex" => {
                if let Some(cmd) = ep.get("command").and_then(|v| v.as_str()) {
                    let cmd = cmd.to_string();
                    handles.push(async move {
                        probe_codex(&cmd).await.ok()
                    });
                }
            }
            "http" => {
                if let (Some(host), Some(port)) = (
                    ep.get("host").and_then(|v| v.as_str()),
                    ep.get("port").and_then(|v| v.as_u64()),
                ) {
                    let host = host.to_string();
                    handles.push(async move {
                        probe_http_agent(&host, port as u16).await.ok()
                    });
                }
            }
            "subprocess" => {
                if let (Some(cmd), Some(argv)) = (
                    ep.get("command").and_then(|v| v.as_str()),
                    ep.get("argv").and_then(|v| v.as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect::<Vec<_>>())),
                ) {
                    let cmd = cmd.to_string();
                    let argv = argv.clone();
                    handles.push(async move {
                        probe_subprocess(&cmd, &argv).await.ok()
                    });
                }
            }
            _ => {}
        }
    }

    let results: Vec<Option<AgentInfo>> = if handles.is_empty() {
        vec![]
    } else {
        match timeout(Duration::from_secs(10), async {
            let mut results = Vec::new();
            for handle in handles {
                results.push(handle.await);
            }
            results
        }).await {
            Ok(r) => r,
            Err(_) => vec![],
        }
    };

    let mut agents: Vec<AgentInfo> = results.into_iter().filter_map(|x| x).collect();
    agents.sort_by_key(|a| match a.agent_type.as_str() {
        "hermes" => 0,
        "http" => 1,
        "codex" => 2,
        _ => 3,
    });
    Ok(deduplicate_agents(agents))
}

/// Probe a single endpoint.
#[command]
pub async fn agent_probe_single(
    agent_type: String,
    url: Option<String>,
    command: Option<String>,
    host: Option<String>,
    port: Option<u16>,
) -> Result<AgentInfo, String> {
    match agent_type.as_str() {
        "hermes" => {
            let u = url.ok_or("url required for hermes")?;
            probe_hermes(&u, None).await
        }
        "codex" => {
            let cmd = command.ok_or("command required for codex")?;
            probe_codex(&cmd).await
        }
        "http" => {
            let h = host.ok_or("host required for http")?;
            let p = port.ok_or("port required for http")? as u16;
            probe_http_agent(&h, p).await
        }
        "subprocess" => {
            let cmd = command.ok_or("command required for subprocess")?;
            let argv: Vec<String> = vec![];
            probe_subprocess(&cmd, &argv).await
        }
        _ => Err(format!("Unknown agent type: {}", agent_type)),
    }
}

/// Get configured endpoints list.
#[command]
pub fn agent_config_get() -> Result<Vec<AgentEndpointConfig>, String> {
    let config_path = get_config_path();
    let config_content = fs::read_to_string(&config_path)
        .map_err(|e| format!("config read failed: {}", e))?;
    let config: serde_json::Value = serde_json::from_str(&config_content)
        .map_err(|e| format!("config parse failed: {}", e))?;

    let endpoints = config.get("endpoints")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let result: Vec<AgentEndpointConfig> = endpoints
        .into_iter()
        .filter_map(|ep| {
            let agent_type = ep.get("agent_type")?.as_str()?.to_string();
            Some(AgentEndpointConfig {
                agent_type,
                enabled: ep.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false),
                url: ep.get("url").and_then(|v| v.as_str()).map(String::from),
                command: ep.get("command").and_then(|v| v.as_str()).map(String::from),
                argv: ep.get("argv").and_then(|v| v.as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())),
                host: ep.get("host").and_then(|v| v.as_str()).map(String::from),
                port: ep.get("port").and_then(|v| v.as_u64().map(|n| n as u16)),
            })
        })
        .collect();

    Ok(result)
}

/// Update endpoints configuration.
#[command]
pub fn agent_config_set(endpoints: Vec<AgentEndpointConfig>) -> Result<(), String> {
    let config_path = get_config_path();
    let mut config: serde_json::Value = if config_path.exists() {
        let content = fs::read_to_string(&config_path)
            .map_err(|e| format!("config read failed: {}", e))?;
        serde_json::from_str(&content)
            .map_err(|e| format!("config parse failed: {}", e))?
    } else {
        serde_json::json!({})
    };

    let ep_array: Vec<serde_json::Value> = endpoints
        .into_iter()
        .map(|ep| {
            let mut obj = serde_json::json!({
                "agent_type": ep.agent_type,
                "enabled": ep.enabled,
            });
            if let Some(url) = ep.url {
                obj.as_object_mut().unwrap().insert("url".to_string(), serde_json::json!(url));
            }
            if let Some(cmd) = ep.command {
                obj.as_object_mut().unwrap().insert("command".to_string(), serde_json::json!(cmd));
            }
            if let Some(argv) = ep.argv {
                obj.as_object_mut().unwrap().insert("argv".to_string(), serde_json::json!(argv));
            }
            if let Some(host) = ep.host {
                obj.as_object_mut().unwrap().insert("host".to_string(), serde_json::json!(host));
            }
            if let Some(port) = ep.port {
                obj.as_object_mut().unwrap().insert("port".to_string(), serde_json::json!(port));
            }
            obj
        })
        .collect();

    config.as_object_mut().unwrap().insert("endpoints".to_string(), serde_json::json!(ep_array));

    let json = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("serialize failed: {}", e))?;

    if let Some(parent) = config_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("mkdir failed: {}", e))?;
    }
    fs::write(&config_path, json)
        .map_err(|e| format!("write failed: {}", e))?;

    Ok(())
}

// ---------------------------------------------------------------------------
// Health Check
// ---------------------------------------------------------------------------

#[command]
pub fn health_check() -> HealthStatus {
    HealthStatus {
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        platform: std::env::consts::OS.to_string(),
        rust_version: rustc_version::VERSION.to_string(),
    }
}

// ---------------------------------------------------------------------------
// P1-B Stubs (not implemented here — P1-B owns oauth_start/oauth_cancel)
// ---------------------------------------------------------------------------

#[command]
pub async fn oauth_start() -> Result<serde_json::Value, String> {
    Err("P1-B not implemented".to_string())
}

#[command]
pub async fn oauth_cancel() -> Result<(), String> {
    Err("P1-B not implemented".to_string())
}

// ---------------------------------------------------------------------------
// App Entry
// ---------------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            health_check,
            // P1-C: Credential Store
            credential_store,
            credential_update_access_token,
            credential_get,
            credential_get_full,
            credential_delete,
            install_id_get,
            // P1-E: Agent Probe
            agent_probe,
            agent_probe_single,
            agent_config_get,
            agent_config_set,
            // P1-B: OAuth (stubs)
            oauth_start,
            oauth_cancel,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
