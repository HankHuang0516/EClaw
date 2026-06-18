# P1-C: OS Credential Store Integration — macOS Keychain + Windows Credential Manager

> **狀態**: v0.1 (2026-06-18) · **作者**: Mac_C #4 · **審查者**: LOBSTER #2
> **依賴卡**: `card_7c15a7d095db68e27fee54d3` · **上游**: Phase 1 Core Spec §2 + ADR-001 §Token Storage

---

## 1. 目標

實作 EClaw Desktop 的 credential envelope 持久化，儲存於各平台的 OS-level 安全儲存：

| 平台 | 儲存後端 |
|------|----------|
| macOS | Keychain (`security` CLI 或 `keychain` crate) |
| Windows | Credential Manager (DPAPI-backed) |
| Linux | libsecret / Secret Service (未列入 MVP) |

核心原則：**Refresh token 永不離開 OS Credential Store，renderer 永遠拿不到。**

---

## 2. Credential Envelope 結構

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CredentialEnvelope {
    pub install_id: String,       // UUID v4, generated at install time
    pub refresh_token: String,    // OAuth refresh token (NEVER exposed to renderer)
    pub access_token: String,    // Current access token (in-memory only in renderer)
    pub id_token: String,        // OIDC id_token
    pub expires_at: i64,         // Unix timestamp of access_token expiry
    pub refresh_expires_at: i64, // Unix timestamp of refresh_token expiry
}
```

### 2.1 Envelope vs Renderer

| 欄位 | credential_store | credential_get (to renderer) |
|------|-----------------|------------------------------|
| install_id | ✅ | ✅ |
| refresh_token | ✅ stored | ❌ NEVER |
| access_token | ✅ | ✅ |
| id_token | ✅ | ✅ |
| expires_at | ✅ | ✅ |
| refresh_expires_at | ✅ | ❌ (optional) |

---

## 3. macOS Keychain

### 3.1 Keychain Item 寫入

```rust
use std::process::Command;

fn keychain_store(envelope: &CredentialEnvelope) -> Result<(), CredentialError> {
    let service = "com.eclaw.desktop";
    let account = &envelope.install_id;
    let password = serde_json::to_string(envelope).map_err(|e| format!("serialize: {}", e))?;

    let output = Command::new("security")
        .args(&[
            "add-generic-password",
            "-s", service,
            "-a", account,
            "-w", &password,
            "-S", // use iOS Keychain availability
        ])
        .output()
        .map_err(|e| format!("security cli: {}", e))?;

    if !output.status.success() {
        return Err(format!("keychain add failed: {}", String::from_utf8_lossy(&output.stderr)));
    }
    Ok(())
}
```

### 3.2 Keychain 讀取

```rust
fn keychain_get(install_id: &str) -> Result<Option<CredentialEnvelope>, CredentialError> {
    let output = Command::new("security")
        .args(&["find-generic-password", "-s", "com.eclaw.desktop", "-a", install_id, "-w"])
        .output()
        .map_err(|e| format!("security cli: {}", e))?;

    if !output.status.success() {
        return Ok(None); // Item not found is not an error
    }

    let password = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if password.is_empty() {
        return Ok(None);
    }

    let envelope: CredentialEnvelope = serde_json::from_str(&password)
        .map_err(|e| format!("deserialize: {}", e))?;
    Ok(Some(envelope))
}
```

### 3.3 Keychain 刪除

```rust
fn keychain_delete(install_id: &str) -> Result<bool, CredentialError> {
    let output = Command::new("security")
        .args(&["delete-generic-password", "-s", "com.eclaw.desktop", "-a", install_id])
        .output()
        .map_err(|e| format!("security cli: {}", e))?;

    // exit code 0 = deleted, 36 = item not found (treat as success)
    Ok(output.status.success() || output.status.code() == Some(36))
}
```

---

## 4. Windows Credential Manager

### 4.1 Windows API (via `windows` crate)

```rust
// Using the windows-rs crate for Credential Manager access
use windows::core::PCWSTR;
use windows::Win32::Security::Credentials::{
    CredWriteW, CredReadW, CredDeleteW, CredFree,
    CREDENTIALW, CRED_TYPE_GENERIC, CRED_PERSIST_LOCAL_MACHINE,
};

const SERVICE_NAME: &str = "EClawDesktop";

fn to_wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn cred_store(envelope: &CredentialEnvelope) -> Result<(), CredentialError> {
    let target = format!("{}:{}", SERVICE_NAME, envelope.install_id);
    let password = serde_json::to_string(envelope).map_err(|e| format!("{}", e))?;
    let wide_target = to_wide(&target);
    let wide_password = to_wide(&password);

    let cred = CREDENTIALW {
        Flags: Default::default(),
        Type: CRED_TYPE_GENERIC,
        TargetName: PCWSTR(wide_target.as_ptr()),
        Comment: PCWSTR::null(),
        LastWritten: Default::default(),
        CredentialBlobSize: (wide_password.len() * 2) as u32,
        CredentialBlob: PCWSTR(wide_password.as_ptr()) as *mut _,
        Persist: CRED_PERSIST_LOCAL_MACHINE,
        AttributeCount: 0,
        Attributes: std::ptr::null_mut(),
        TargetAlias: PCWSTR::null(),
        UserName: PCWSTR::null(),
    };

    unsafe {
        CredWriteW(&cred, 0)
            .map_err(|e| format!("CredWriteW failed: {}", e))
    }
}

fn cred_get(install_id: &str) -> Result<Option<CredentialEnvelope>, CredentialError> {
    let target = format!("{}:{}", SERVICE_NAME, install_id);
    let wide_target = to_wide(&target);

    let mut cred_ptr: *mut CREDENTIALW = std::ptr::null_mut();
    unsafe {
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
```

---

## 5. Rust Command Layer

### 5.1 `credential_store`

```rust
#[command]
pub async fn credential_store(
    refresh_token: String,
    id_token: String,
    expires_at: i64,
) -> Result<(), String>
```

Reads `install_id` from config file (`~/.eclaw-desktop/config.json`), then stores full envelope in OS Credential Store.

### 5.2 `credential_get`

```rust
#[command]
pub async fn credential_get() -> Result<Option<serde_json::Value>, String>
```

Returns to renderer:
```json
{
  "access_token": "...",
  "expires_at": 1234567890
}
```

**Never** returns `refresh_token` to renderer.

### 5.3 `credential_delete`

```rust
#[command]
pub async fn credential_delete() -> Result<bool, String>
```

Deletes credential from OS store. Returns `true` if deleted, `false` if not found.

### 5.4 `install_id_get`

```rust
#[command]
pub fn install_id_get() -> Result<String, String>
```

Returns the install UUID from `~/.eclaw-desktop/config.json`.

---

## 6. Config File (`~/.eclaw-desktop/config.json`)

Created on first launch if not exists:

```json
{
  "installId": "uuid-v4",
  "version": "0.1.0",
  "platform": "darwin"
}
```

This file is **not secret** — it contains no tokens.

---

## 7. Rust Dependencies (Cargo.toml additions)

```toml
# For Windows
[target.'cfg(windows)'.dependencies]
windows = { version = "0.58", features = [
    "Win32_Security_Credentials",
    "Win32_Foundation",
] }

# For macOS (if not using security CLI)
keychain = { version = "0.2", features = ["macos"] }
```

For simplicity in MVP, use `security` CLI on macOS (no extra crate needed) and `windows` crate on Windows.

---

## 8. Security Requirements

- [ ] `refresh_token` never written to disk, localStorage, IndexedDB, log, or crash report
- [ ] `credential_get()` to renderer strips `refresh_token` and `refresh_expires_at`
- [ ] Each installId is a unique UUID v4 (not derivable from device fingerprint alone)
- [ ] Config file (`config.json`) contains no secrets
- [ ] Credential store entry deleted on app uninstall (verified in P1-I)
- [ ] Multiple app instances on same machine cannot read each other's tokens

---

## 9. Error Handling

| 錯誤 | 處理 |
|------|------|
| Keychain/CredMgr not accessible | Return error, do not fall back to file storage |
| Credential entry not found | `credential_get()` returns `Ok(None)` |
| Corrupted JSON in store | Return error, log (no secret), do not crash |
| Disk full (config write) | Return error |

---

## 10. Acceptance Criteria

- [ ] `credential_store()` writes to macOS Keychain on macOS, Credential Manager on Windows
- [ ] `credential_get()` returns only `{access_token, expires_at}`, never `refresh_token`
- [ ] App reinstall with same installId reads same credential
- [ ] `credential_delete()` removes entry from store
- [ ] Config file `~/.eclaw-desktop/config.json` created on first launch with valid UUID v4
- [ ] `install_id_get()` returns the install UUID
- [ ] Two app instances on same machine have separate installId → separate Keychain entries
- [ ] Refresh token rotation (getting new refresh token) updates existing Keychain entry
- [ ] Token never appears in renderer, logs, or disk

---

## 11. Dependencies

- P1-A: Tauri scaffold (required, provides `lib.rs` command registration)
- P1-B: `oauth_exchange()` calls `credential_store()` after token exchange

---

## 12. Excluded

- Token refresh logic (refresh when access_token expires) — handled by P1-D or P1-C refresh helper
- Linux support — not in MVP scope
- Biometric unlock (Touch ID / Windows Hello) — Phase 3+
