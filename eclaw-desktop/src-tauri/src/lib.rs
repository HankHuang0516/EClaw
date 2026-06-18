//! EClaw Desktop — P1-A: Tauri 2 scaffold + command layer framework
//! All business logic stubs (OAuth, Credential, Agent Probe) return errors
//! pointing to their respective implementation cards.

use serde::{Deserialize, Serialize};
use tauri::command;

/// P1-A: Health check — verifies the Rust backend is reachable.
#[command]
pub fn health_check() -> HealthStatus {
    HealthStatus {
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        platform: std::env::consts::OS.to_string(),
        rust_version: rust_version::VERSION.to_string(),
    }
}

/// P1-B stub: OAuth flow will be implemented in P1-B.
/// Currently returns an error so the renderer knows it is not yet implemented.
#[command]
pub async fn oauth_start() -> Result<String, String> {
    Err("P1-B not implemented: OAuth flow is handled by card_dd7e7e3a9d3056df71f1aca3".to_string())
}

/// P1-C stub: Credential store will be implemented in P1-C.
/// Returns None to indicate no stored credential exists yet.
#[command]
pub async fn credential_get() -> Result<Option<serde_json::Value>, String> {
    Err("P1-C not implemented: OS Credential Store is handled by card_7c15a7d095db68e27fee54d3".to_string())
}

/// P1-C stub: Store credential envelope in OS Credential Store.
/// Currently returns an error.
#[command]
pub async fn credential_store(
    _refresh_token: String,
    _id_token: String,
    _expires_at: i64,
) -> Result<(), String> {
    Err("P1-C not implemented: OS Credential Store is handled by card_7c15a7d095db68e27fee54d3".to_string())
}

/// P1-E stub: Agent probe will be implemented in P1-E.
/// Currently returns an empty list.
#[command]
pub async fn agent_probe() -> Result<Vec<AgentInfo>, String> {
    Err("P1-E not implemented: Agent probe is handled by card_630f5575ed11a8bc35a04e0f".to_string())
}

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            health_check,
            oauth_start,
            credential_get,
            credential_store,
            agent_probe,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
