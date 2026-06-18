//! EClaw Desktop — P1-C: OS Credential Store
//! Stores OAuth tokens in macOS Keychain or Windows Credential Manager.
//!
//! Scope:
//! - credential_store: stores full credential envelope in OS store
//! - credential_get: returns {access_token, expires_at} only (renderer-safe)
//! - credential_delete: removes entry from OS store
//! - install_id_get: returns install UUID from config file
//!
//! Security: refresh_token NEVER goes to renderer. Only access_token+expires.
//!
//! Dependencies: P1-A (scaffold), P1-B (oauth_exchange calls credential_store)

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;
use tauri::command;

// ---------------------------------------------------------------------------
// Types
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

/// What the renderer receives from credential_get (no refresh_token!)
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
        // Create new install with UUID
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
    // Simple UUID v4 generation (no external crate needed)
    let bytes: [u8; 16] = rand::random();
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

    // Use security CLI to store generic password item
    let output = Command::new("security")
        .args(&[
            "add-generic-password",
            "-s", service,
            "-a", account,
            "-w", &password,
        ])
        .output()
        .map_err(|e| format!("security cli error: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // If item already exists, delete and retry
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
// Windows Credential Manager (via windows crate)
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
fn credmgr_store(envelope: &CredentialEnvelope) -> Result<(), String> {
    use std::ptr;

    let target = format!("EClawDesktop:{}", envelope.install_id);
    let password = serde_json::to_string(envelope)
        .map_err(|e| format!("serialize: {}", e))?;

    let wide_target: Vec<u16> = target.encode_utf16().chain(std::iter::once(0)).collect();
    let wide_password: Vec<u16> = password.encode_utf16().chain(std::iter::once(0)).collect();

    // Use windows crate to call CredWriteW
    unsafe {
        use windows::Win32::Security::Credentials::{
            CredWriteW, CredDeleteW, CREDENTIALW, CRED_TYPE_GENERIC, CRED_PERSIST_LOCAL_MACHINE,
        };
        use windows::core::PCWSTR;

        let cred = CREDENTIALW {
            Flags: Default::default(),
            Type: CRED_TYPE_GENERIC,
            TargetName: PCWSTR(wide_target.as_ptr() as *const u16),
            Comment: PCWSTR::null(),
            LastWritten: Default::default(),
            CredentialBlobSize: (wide_password.len() * 2) as u32,
            CredentialBlob: PCWSTR(wide_password.as_ptr() as *const u16) as *mut u8,
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
                    &blob.chunks_exact(2)
                        .map(|c| u16::from_le_bytes([c[0], c[1]]))
                        .collect::<Vec<u16>>()
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
// Cross-platform stubs
// ---------------------------------------------------------------------------

#[cfg(not(target_os = "macos"))]
#[cfg(not(target_os = "windows"))]
fn keychain_store(_envelope: &CredentialEnvelope) -> Result<(), String> {
    Err("OS Credential Store not supported on this platform".to_string())
}

#[cfg(not(target_os = "macos"))]
#[cfg(not(target_os = "windows"))]
fn keychain_get(_install_id: &str) -> Result<Option<CredentialEnvelope>, String> {
    Err("OS Credential Store not supported on this platform".to_string())
}

#[cfg(not(target_os = "macos"))]
#[cfg(not(target_os = "windows"))]
fn keychain_delete(_install_id: &str) -> Result<bool, String> {
    Err("OS Credential Store not supported on this platform".to_string())
}

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

// ---------------------------------------------------------------------------
// Tauri Commands
// ---------------------------------------------------------------------------

/// P1-C: Store credential envelope in OS Credential Store.
/// Called by P1-B after successful OAuth token exchange.
#[command]
pub fn credential_store(
    refresh_token: String,
    id_token: String,
    expires_at: i64,
) -> Result<(), String> {
    let install_id = ensure_config_exists()?;
    let access_token = String::new(); // Set by P1-B after refresh
    let refresh_expires_at = expires_at + (90 * 24 * 60 * 60); // ~90 days

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

/// P1-C: Update access_token in existing credential envelope.
/// Used by token refresh logic.
#[command]
pub fn credential_update_access_token(access_token: String, expires_at: i64) -> Result<(), String> {
    let install_id = ensure_config_exists()?;
    let mut envelope = os_get(&install_id)?
        .ok_or("No stored credential found")?;

    envelope.access_token = access_token;
    envelope.expires_at = expires_at;
    os_store(&envelope)
}

/// P1-C: Get stored credential for renderer.
/// SECURITY: Returns ONLY {access_token, expires_at}. NEVER returns refresh_token.
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

/// P1-C: Get full envelope (internal use only — not exposed to renderer).
/// Used by P1-D for backend API calls.
#[command]
pub fn credential_get_full() -> Result<Option<CredentialEnvelope>, String> {
    let install_id = ensure_config_exists()?;
    os_get(&install_id)
}

/// P1-C: Delete credential from OS store.
#[command]
pub fn credential_delete() -> Result<bool, String> {
    let install_id = ensure_config_exists()?;
    os_delete(&install_id)
}

/// P1-C: Get install UUID.
#[command]
pub fn install_id_get() -> Result<String, String> {
    ensure_config_exists()
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
// Stubs (P1-B/P1-E)
// ---------------------------------------------------------------------------

#[command]
pub async fn oauth_start() -> Result<serde_json::Value, String> {
    Err("P1-B not implemented: OAuth flow is handled by card_dd7e7e3a9d3056df71f1aca3".to_string())
}

#[command]
pub async fn oauth_cancel() -> Result<(), String> {
    Err("P1-B not implemented".to_string())
}

#[command]
pub async fn agent_probe() -> Result<Vec<AgentInfo>, String> {
    Err("P1-E not implemented: Agent probe is handled by card_630f5575ed11a8bc35a04e0f".to_string())
}

// ---------------------------------------------------------------------------
// App Entry
// ---------------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
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
            agent_probe,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
