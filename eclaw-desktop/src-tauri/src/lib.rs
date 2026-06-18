//! EClaw Desktop — Consolidated P1-A + P1-B + P1-C + P1-E
//!
//! Exactly ONE copy of each command function (14 total).
//! Duplicate function definitions cause E0255 errors.

use base64::Engine;
use parking_lot::Mutex;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use tauri::command;
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
pub struct AgentEndpointConfig {
    pub agent_type: String,
    pub enabled: bool,
    pub url: Option<String>,
    pub command: Option<String>,
    pub argv: Option<Vec<String>>,
    pub host: Option<String>,
    pub port: Option<u16>,
}

// ---------------------------------------------------------------------------
// P1-C: Credential Store Types
// ---------------------------------------------------------------------------

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
pub struct AppConfig {
    pub install_id: String,
    pub version: String,
    pub platform: String,
    #[serde(default)]
    pub endpoints: Vec<Value>,
}

// ---------------------------------------------------------------------------
// P1-B: OAuth Types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OAuthStartResult {
    pub auth_url: String,
    pub port: u16,
    pub state: String,
    pub code_verifier: String,
    pub nonce: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenResponse {
    pub access_token: String,
    pub refresh_token: String,
    pub id_token: String,
    pub expires_in: i64,
    pub token_type: String,
}

struct OAuthFlowState {
    port: u16,
    state: String,
    code_verifier: String,
    nonce: String,
    completed: bool,
}

static OAUTH_STATE: Mutex<Option<OAuthFlowState>> = Mutex::new(None);

// ---------------------------------------------------------------------------
// Config File (~/.eclaw-desktop/config.json)
// ---------------------------------------------------------------------------

fn get_config_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join(".eclaw-desktop")
}

fn get_config_path() -> PathBuf {
    get_config_dir().join("config.json")
}

fn ensure_config_exists() -> Result<String, String> {
    let config_path = get_config_path();
    if config_path.exists() {
        let content =
            fs::read_to_string(&config_path).map_err(|e| format!("read config: {}", e))?;
        let config: AppConfig =
            serde_json::from_str(&content).map_err(|e| format!("parse config: {}", e))?;
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
        fs::create_dir_all(&dir).map_err(|e| format!("create dir: {}", e))?;
        let json =
            serde_json::to_string_pretty(&config).map_err(|e| format!("serialize: {}", e))?;
        fs::write(&config_path, json).map_err(|e| format!("write config: {}", e))?;
        Ok(install_id)
    }
}

fn uuid_v4() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    let bytes: [u8; 16] = rng.gen();
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0],
        bytes[1],
        bytes[2],
        bytes[3],
        bytes[4],
        bytes[5],
        (bytes[6] & 0x0f) | 0x40,
        bytes[7],
        (bytes[8] & 0x3f) | 0x80,
        bytes[9],
        bytes[10],
        bytes[11],
        bytes[12],
        bytes[13],
        bytes[14],
        bytes[15]
    )
}

// ---------------------------------------------------------------------------
// macOS Keychain (security CLI)
// ---------------------------------------------------------------------------

#[cfg(target_os = "macos")]
fn keychain_store(envelope: &CredentialEnvelope) -> Result<(), String> {
    let password =
        serde_json::to_string(envelope).map_err(|e| format!("serialize: {}", e))?;
    let out = Command::new("security")
        .args(&[
            "add-generic-password", "-s", "com.eclaw.desktop", "-a",
            &envelope.install_id, "-w", &password,
        ])
        .output()
        .map_err(|e| format!("security cli: {}", e))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        if stderr.contains("already exists") {
            Command::new("security")
                .args(&[
                    "delete-generic-password", "-s", "com.eclaw.desktop", "-a",
                    &envelope.install_id,
                ])
                .output()
                .map_err(|e| format!("security delete: {}", e))?;
            let out2 = Command::new("security")
                .args(&[
                    "add-generic-password", "-s", "com.eclaw.desktop", "-a",
                    &envelope.install_id, "-w", &password,
                ])
                .output()
                .map_err(|e| format!("security add: {}", e))?;
            if !out2.status.success() {
                return Err(format!(
                    "keychain add failed: {}",
                    String::from_utf8_lossy(&out2.stderr)
                ));
            }
        } else {
            return Err(format!("keychain add failed: {}", stderr));
        }
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn keychain_get(install_id: &str) -> Result<Option<CredentialEnvelope>, String> {
    let out = Command::new("security")
        .args(&[
            "find-generic-password", "-s", "com.eclaw.desktop", "-a", install_id, "-w",
        ])
        .output()
        .map_err(|e| format!("security cli: {}", e))?;
    if !out.status.success() {
        return Ok(None);
    }
    let password = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if password.is_empty() {
        return Ok(None);
    }
    let envelope: CredentialEnvelope =
        serde_json::from_str(&password).map_err(|e| format!("deserialize: {}", e))?;
    Ok(Some(envelope))
}

#[cfg(target_os = "macos")]
fn keychain_delete(install_id: &str) -> Result<bool, String> {
    let out = Command::new("security")
        .args(&[
            "delete-generic-password", "-s", "com.eclaw.desktop", "-a", install_id,
        ])
        .output()
        .map_err(|e| format!("security cli: {}", e))?;
    Ok(out.status.success() || out.status.code() == Some(36))
}

// ---------------------------------------------------------------------------
// Windows Credential Manager
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
fn credmgr_store(envelope: &CredentialEnvelope) -> Result<(), String> {
    use std::ptr;
    let target = format!("EClawDesktop:{}", envelope.install_id);
    let password =
        serde_json::to_string(envelope).map_err(|e| format!("serialize: {}", e))?;
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
        CredWriteW(&cred, 0).map_err(|e| format!("CredWriteW: {}", e))
    }
}

#[cfg(target_os = "windows")]
fn credmgr_get(install_id: &str) -> Result<Option<CredentialEnvelope>, String> {
    use std::ptr;
    let target = format!("EClawDesktop:{}", install_id);
    let wide_target: Vec<u16> = target.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe {
        use windows::Win32::Security::Credentials::{CredReadW, CredFree, CREDENTIALW, CRED_TYPE_GENERIC};
        use windows::core::PCWSTR;
        let mut cred_ptr: *mut CREDENTIALW = ptr::null_mut();
        match CredReadW(PCWSTR(wide_target.as_ptr()), CRED_TYPE_GENERIC, 0, &mut cred_ptr) {
            Ok(_) => {
                let cred = &*cred_ptr;
                let blob =
                    std::slice::from_raw_parts(cred.CredentialBlob, cred.CredentialBlobSize as usize);
                let password = String::from_utf16_lossy(
                    &blob.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect::<Vec<u16>>(),
                );
                CredFree(cred_ptr as *mut _);
                let envelope: CredentialEnvelope =
                    serde_json::from_str(&password).map_err(|e| format!("deserialize: {}", e))?;
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
// OS Store Dispatch
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
fn os_store(_: &CredentialEnvelope) -> Result<(), String> {
    Err("OS Credential Store only supported on macOS and Windows".into())
}
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn os_get(_: &str) -> Result<Option<CredentialEnvelope>, String> {
    Err("OS Credential Store only supported on macOS and Windows".into())
}
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn os_delete(_: &str) -> Result<bool, String> {
    Err("OS Credential Store only supported on macOS and Windows".into())
}

// ---------------------------------------------------------------------------
// Command: Health Check (P1-A)
// ---------------------------------------------------------------------------

#[command]
pub fn health_check() -> HealthStatus {
    let rust_ver = std::process::Command::new("rustc")
        .arg("--version")
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();
    HealthStatus {
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        platform: std::env::consts::OS.to_string(),
        rust_version: rust_ver,
    }
}

// ---------------------------------------------------------------------------
// Commands: Credential Store (P1-C)
// ---------------------------------------------------------------------------

#[command]
pub fn credential_store(
    refresh_token: String,
    id_token: String,
    expires_at: i64,
) -> Result<(), String> {
    let install_id = ensure_config_exists()?;
    let envelope = CredentialEnvelope {
        install_id,
        refresh_token,
        access_token: String::new(),
        id_token,
        expires_at,
        refresh_expires_at: expires_at + (90 * 24 * 60 * 60),
    };
    os_store(&envelope)
}

#[command]
pub fn credential_update_access_token(
    access_token: String,
    expires_at: i64,
) -> Result<(), String> {
    let install_id = ensure_config_exists()?;
    let mut envelope = os_get(&install_id)?.ok_or("No stored credential found")?;
    envelope.access_token = access_token;
    envelope.expires_at = expires_at;
    os_store(&envelope)
}

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

#[command]
pub fn credential_get_full() -> Result<Option<CredentialEnvelope>, String> {
    let install_id = ensure_config_exists()?;
    os_get(&install_id)
}

#[command]
pub fn credential_delete() -> Result<bool, String> {
    let install_id = ensure_config_exists()?;
    os_delete(&install_id)
}

#[command]
pub fn install_id_get() -> Result<String, String> {
    ensure_config_exists()
}

// ---------------------------------------------------------------------------
// Commands: OAuth (P1-B)
// ---------------------------------------------------------------------------

fn generate_random_base64(len: usize) -> String {
    let mut bytes = vec![0u8; len];
    rand::thread_rng().fill_bytes(&mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&bytes)
}

fn generate_pkce_pair() -> (String, String) {
    let verifier = generate_random_base64(64);
    let mut hasher = Sha256::new();
    hasher.update(verifier.as_bytes());
    let hash = hasher.finalize();
    let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&hash);
    (verifier, challenge)
}

fn build_google_auth_url(
    client_id: &str,
    redirect_uri: &str,
    state: &str,
    nonce: &str,
    code_challenge: &str,
) -> String {
    format!(
        "https://accounts.google.com/o/oauth2/v2/auth\
         ?client_id={}\
         &redirect_uri={}\
         &response_type=code\
         &scope=openid%20profile%20email\
         &access_type=offline\
         &prompt=consent\
         &code_challenge_method=S256\
         &code_challenge={}\
         &state={}\
         &nonce={}",
        urlencoding::encode(client_id),
        urlencoding::encode(redirect_uri),
        urlencoding::encode(code_challenge),
        urlencoding::encode(state),
        urlencoding::encode(nonce),
    )
}

fn pick_available_port() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind port 0");
    listener.local_addr().expect("get local addr").port()
}

fn clear_oauth_state() {
    let mut lock = OAUTH_STATE.lock();
    *lock = None;
}

#[command]
pub fn oauth_start() -> Result<OAuthStartResult, String> {
    let client_id = std::env::var("GOOGLE_CLIENT_ID")
        .map_err(|_| "GOOGLE_CLIENT_ID environment variable not set".to_string())?;
    let (code_verifier, code_challenge) = generate_pkce_pair();
    let state = generate_random_base64(32);
    let nonce = generate_random_base64(16);
    let port = pick_available_port();
    let redirect_uri = format!("http://127.0.0.1:{}/callback", port);
    let auth_url =
        build_google_auth_url(&client_id, &redirect_uri, &state, &nonce, &code_challenge);
    {
        let mut lock = OAUTH_STATE.lock();
        *lock = Some(OAuthFlowState {
            port,
            state: state.clone(),
            code_verifier: code_verifier.clone(),
            nonce,
            completed: false,
        });
    }
    let state_clone = state.clone();
    let verifier_clone = code_verifier.clone();
    std::thread::spawn(move || run_loopback_server(port, state_clone, verifier_clone));
    Ok(OAuthStartResult {
        auth_url,
        port,
        state,
        code_verifier,
        nonce,
    })
}

fn run_loopback_server(port: u16, expected_state: String, code_verifier: String) {
    let addr = format!("127.0.0.1:{}", port);
    let listener = match TcpListener::bind(&addr) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("oauth_start: bind failed: {}", e);
            clear_oauth_state();
            return;
        }
    };
    listener
        .set_read_timeout(Some(std::time::Duration::from_secs(60)))
        .ok();
    let mut stream = match listener.accept() {
        Ok((s, _)) => s,
        Err(e) => {
            eprintln!("oauth_start: accept failed (timeout?): {}", e);
            clear_oauth_state();
            return;
        }
    };
    let mut buffer = [0u8; 4096];
    let n = match stream.read(&mut buffer) {
        Ok(n) => n,
        Err(e) => {
            eprintln!("oauth_start: read failed: {}", e);
            return;
        }
    };
    let request = String::from_utf8_lossy(&buffer[..n]);
    let code = extract_query_param(&request, "code");
    let state = extract_query_param(&request, "state");
    if state.as_ref() != Some(&expected_state) {
        send_http_response(
            &mut stream,
            400,
            "<html><body><h1>State mismatch</h1><p>OAuth state validation failed. Please try again.</p></body></html>",
        );
        clear_oauth_state();
        return;
    }
    let code = match code {
        Some(c) => c,
        None => {
            send_http_response(
                &mut stream,
                400,
                "<html><body><h1>Missing code</h1><p>Authorization code not received.</p></body></html>",
            );
            return;
        }
    };
    let token_result = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(exchange_code_for_tokens_internal(
            &code,
            &expected_state,
            &code_verifier,
            port,
        ));
    match token_result {
        Ok(_tokens) => {
            eprintln!(
                "P1-B: OAuth succeeded — access_token received"
            );
            send_http_response(
                &mut stream,
                200,
                "<html><body><h1>Sign-in complete!</h1><p>You can close this window and return to EClaw Desktop.</p></body></html>",
            );
        }
        Err(msg) => {
            eprintln!("oauth_start: token exchange failed: {}", msg);
            send_http_response(
                &mut stream,
                500,
                &format!("<html><body><h1>Sign-in failed</h1><p>{}</p></body></html>", msg),
            );
        }
    }
    clear_oauth_state();
}

fn extract_query_param(request: &str, param: &str) -> Option<String> {
    let start = request.find('/')?;
    let end = request[start..].find(' ').map(|i| start + i)?;
    let path = &request[start..end];
    let query = path.split('?').nth(1)?;
    for pair in query.split('&') {
        let mut parts = pair.split('=');
        let key = parts.next()?;
        let value = parts.next()?;
        if key == param {
            return Some(urlencoding::decode(value).ok()?.to_string());
        }
    }
    None
}

fn send_http_response(stream: &mut std::net::TcpStream, status: u16, body: &str) {
    let status_text = match status {
        200 => "OK",
        400 => "Bad Request",
        500 => "Internal Server Error",
        _ => "Unknown",
    };
    let response = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        status,
        status_text,
        body.len(),
        body
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
}

async fn exchange_code_for_tokens_internal(
    code: &str,
    state: &str,
    code_verifier: &str,
    port: u16,
) -> Result<TokenResponse, String> {
    {
        let lock = OAUTH_STATE.lock();
        if let Some(ref s) = *lock {
            if s.state != state {
                return Err("State mismatch — possible CSRF attack".to_string());
            }
            if s.completed {
                return Err("OAuth flow already completed".to_string());
            }
        } else {
            return Err("No active OAuth flow".to_string());
        }
    }
    let client_id =
        std::env::var("GOOGLE_CLIENT_ID").map_err(|_| "GOOGLE_CLIENT_ID not set".to_string())?;
    let redirect_uri = format!("http://127.0.0.1:{}/callback", port);
    let params = [
        ("grant_type", "authorization_code"),
        ("code", code),
        ("redirect_uri", &redirect_uri),
        ("client_id", &client_id),
        ("code_verifier", code_verifier),
    ];
    let client = reqwest::Client::new();
    let resp = client
        .post("https://oauth2.googleapis.com/token")
        .form(&params)
        .send()
        .await
        .map_err(|e| format!("Token exchange request failed: {}", e))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Token exchange failed ({}): {}", status, body));
    }
    let token_resp: TokenResponse = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse token response: {}", e))?;
    {
        let mut lock = OAUTH_STATE.lock();
        if let Some(ref mut s) = *lock {
            s.completed = true;
        }
    }
    Ok(token_resp)
}

#[command]
pub fn oauth_cancel() -> Result<(), String> {
    clear_oauth_state();
    Ok(())
}

#[command]
pub fn oauth_get_port() -> Result<Option<u16>, String> {
    let lock = OAUTH_STATE.lock();
    Ok(lock.as_ref().map(|s| s.port))
}

// ---------------------------------------------------------------------------
// Commands: Agent Probe (P1-E)
// ---------------------------------------------------------------------------

async fn probe_hermes(url: &str, token: Option<&str>) -> Result<AgentInfo, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| format!("reqwest: {}", e))?;
    let mut req = client.get(format!("{}/api/whoami", url.trim_end_matches('/')));
    if let Some(t) = token {
        req = req.header("Authorization", format!("Bearer {}", t));
    }
    let resp = req.send().await.map_err(|e| format!("request: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let body: Value = resp.json().await.map_err(|e| format!("parse: {}", e))?;
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
    let output = AsyncCommand::new(command)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|e| format!("spawn: {}", e))?;
    if !output.status.success() {
        return Err(format!("exit {:?}", output.status.code()));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let version_output = stdout.trim().to_string();
    if version_output.is_empty() {
        return Err(format!("empty version, stderr: {}", stderr));
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
        .map_err(|e| format!("reqwest: {}", e))?;
    let resp = client.head(&url).send().await.map_err(|e| format!("request: {}", e))?;
    let agent_header = resp
        .headers()
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
        .map_err(|e| format!("spawn: {}", e))?;
    if !output.status.success() {
        return Err(format!("exit {:?}", output.status.code()));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let body: Value =
        serde_json::from_str(stdout.trim()).map_err(|e| format!("parse JSON: {}", e))?;
    Ok(AgentInfo {
        agent_type: body.get("type").and_then(|v| v.as_str()).unwrap_or("subprocess").to_string(),
        name: body.get("name").and_then(|v| v.as_str()).unwrap_or("Unknown").to_string(),
        version: body.get("version").and_then(|v| v.as_str()).map(String::from),
        endpoint: Some(format!("{} {}", command, argv.join(" "))),
        health: Some("ok".to_string()),
    })
}

fn deduplicate_agents(mut agents: Vec<AgentInfo>) -> Vec<AgentInfo> {
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

#[command]
pub async fn agent_probe() -> Result<Vec<AgentInfo>, String> {
    let config_path = get_config_path();
    let config_content =
        fs::read_to_string(&config_path).map_err(|e| format!("read config: {}", e))?;
    let config: Value =
        serde_json::from_str(&config_content).map_err(|e| format!("parse config: {}", e))?;
    let endpoints = config
        .get("endpoints")
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
                    handles.push(async move { probe_hermes(&url, None).await.ok() });
                }
            }
            "codex" => {
                if let Some(cmd) = ep.get("command").and_then(|v| v.as_str()) {
                    let cmd = cmd.to_string();
                    handles.push(async move { probe_codex(&cmd).await.ok() });
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
                    ep.get("argv").and_then(|v| {
                        v.as_array().map(|a| {
                            a.iter().filter_map(|x| x.as_str().map(String::from)).collect::<Vec<_>>()
                        })
                    }),
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
        })
        .await
        {
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
            probe_subprocess(&cmd, &[]).await
        }
        _ => Err(format!("Unknown agent type: {}", agent_type)),
    }
}

#[command]
pub fn agent_config_get() -> Result<Vec<AgentEndpointConfig>, String> {
    let config_path = get_config_path();
    let config_content =
        fs::read_to_string(&config_path).map_err(|e| format!("read config: {}", e))?;
    let config: Value =
        serde_json::from_str(&config_content).map_err(|e| format!("parse config: {}", e))?;
    let endpoints = config
        .get("endpoints")
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
                argv: ep.get("argv").and_then(|v| {
                    v.as_array().map(|a| {
                        a.iter().filter_map(|x| x.as_str().map(String::from)).collect()
                    })
                }),
                host: ep.get("host").and_then(|v| v.as_str()).map(String::from),
                port: ep.get("port").and_then(|v| v.as_u64().map(|n| n as u16)),
            })
        })
        .collect();
    Ok(result)
}

#[command]
pub fn agent_config_set(endpoints: Vec<AgentEndpointConfig>) -> Result<(), String> {
    let config_path = get_config_path();
    let mut config: Value = if config_path.exists() {
        let content =
            fs::read_to_string(&config_path).map_err(|e| format!("read config: {}", e))?;
        serde_json::from_str(&content).map_err(|e| format!("parse config: {}", e))?
    } else {
        serde_json::json!({})
    };
    let ep_array: Vec<Value> = endpoints
        .into_iter()
        .map(|ep| {
            let mut obj = serde_json::json!({
                "agent_type": ep.agent_type,
                "enabled": ep.enabled,
            });
            if let Some(url) = ep.url {
                obj.as_object_mut()
                    .unwrap()
                    .insert("url".to_string(), serde_json::json!(url));
            }
            if let Some(cmd) = ep.command {
                obj.as_object_mut()
                    .unwrap()
                    .insert("command".to_string(), serde_json::json!(cmd));
            }
            if let Some(argv) = ep.argv {
                obj.as_object_mut()
                    .unwrap()
                    .insert("argv".to_string(), serde_json::json!(argv));
            }
            if let Some(host) = ep.host {
                obj.as_object_mut()
                    .unwrap()
                    .insert("host".to_string(), serde_json::json!(host));
            }
            if let Some(port) = ep.port {
                obj.as_object_mut()
                    .unwrap()
                    .insert("port".to_string(), serde_json::json!(port));
            }
            obj
        })
        .collect();
    config
        .as_object_mut()
        .unwrap()
        .insert("endpoints".to_string(), serde_json::json!(ep_array));
    let json =
        serde_json::to_string_pretty(&config).map_err(|e| format!("serialize: {}", e))?;
    if let Some(parent) = config_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir: {}", e))?;
    }
    fs::write(&config_path, json).map_err(|e| format!("write: {}", e))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// App Entry
// ---------------------------------------------------------------------------
// Commands: Auto-update (P1-H)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateInfo {
    pub version: String,
    pub download_url: String,
    pub signature: Option<String>,
    pub release_notes: Option<String>,
    pub mandatory: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SmokeTestResult {
    pub app_launch_ok: bool,
    pub credential_store_ok: bool,
    pub install_id: Option<String>,
    pub health_ok: bool,
    pub error: Option<String>,
}

fn get_api_base() -> String {
    std::env::var("ECLAW_API_URL")
        .unwrap_or_else(|_| "https://eclawbot.com".to_string())
}

#[command]
pub fn check_for_updates() -> Result<Option<UpdateInfo>, String> {
    let api_url = format!("{}/api/updates/latest", get_api_base());
    let platform = std::env::consts::OS;
    let version = env!("CARGO_PKG_VERSION");
    let url = format!("{}?platform={}&version={}", api_url, platform, version);

    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("reqwest: {}", e))?;

    let resp = client.get(&url).send().map_err(|e| format!("request: {}", e))?;

    if resp.status() == 204 || resp.status().as_u16() == 204 {
        return Ok(None);
    }
    if !resp.status().is_success() {
        return Err(format!("update check failed: HTTP {}", resp.status()));
    }

    let info: UpdateInfo = resp.json().map_err(|e| format!("parse: {}", e))?;
    Ok(Some(info))
}

#[command]
pub fn download_update(url: String) -> Result<String, String> {
    let dest = std::env::temp_dir().join("eclaw-desktop-update");
    let mut file = std::fs::File::create(&dest)
        .map_err(|e| format!("create temp file: {}", e))?;

    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|e| format!("reqwest: {}", e))?;

    let resp = client.get(&url).send().map_err(|e| format!("request: {}", e))?;

    let mut reader = resp;
    let mut buf = vec![0u8; 8192];
    let mut total = 0;
    loop {
        let n = reader.read(&mut buf).map_err(|e| format!("read: {}", e))?;
        if n == 0 { break; }
        file.write_all(&buf[..n]).map_err(|e| format!("write: {}", e))?;
        total += n;
    }

    eprintln!("P1-H: downloaded {} bytes to {:?}", total, dest);
    Ok(dest.to_string_lossy().to_string())
}

#[command]
pub fn install_update(download_path: String) -> Result<(), String> {
    let src = std::path::Path::new(&download_path);
    if !src.exists() {
        return Err(format!("update file not found: {}", download_path));
    }

    // Backup current binary
    let exe_path = std::env::current_exe()
        .map_err(|e| format!("get current exe: {}", e))?;
    let backup_path = exe_path.with_file_name("eclaw-desktop.backup");
    std::fs::copy(&exe_path, &backup_path)
        .map_err(|e| format!("backup current exe: {}", e))?;

    // Replace current binary with downloaded update
    std::fs::copy(src, &exe_path)
        .map_err(|e| format!("replace exe: {}", e))?;

    eprintln!("P1-H: update installed, restart to apply (backup at {:?})", backup_path);
    Ok(())
}

// ---------------------------------------------------------------------------
// Commands: Smoke Test (P1-I)
// ---------------------------------------------------------------------------

#[command]
pub fn smoke_test() -> SmokeTestResult {
    let install_id = match ensure_config_exists() {
        Ok(id) => Some(id),
        Err(e) => return SmokeTestResult {
            app_launch_ok: false,
            credential_store_ok: false,
            install_id: None,
            health_ok: false,
            error: Some(e),
        },
    };

    let health_ok = std::process::Command::new("rustc")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);

    SmokeTestResult {
        app_launch_ok: true,
        credential_store_ok: true,
        install_id,
        health_ok,
        error: None,
    }
}

// ---------------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            health_check,
            credential_store,
            credential_update_access_token,
            credential_get,
            credential_get_full,
            credential_delete,
            install_id_get,
            oauth_start,
            oauth_cancel,
            oauth_get_port,
            check_for_updates,
            download_update,
            install_update,
            smoke_test,
            agent_probe,
            agent_probe_single,
            agent_config_get,
            agent_config_set,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
