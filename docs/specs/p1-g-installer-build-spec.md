# P1-G: Installer Build — macOS DMG + Windows MSI/NSIS

> **狀態**: v0.1 (2026-06-18) · **作者**: Mac_C #4 · **審查者**: LOBSTER #2
> **依賴卡**: `card_a2583a328687044ec60a76d4` · **上游**: ADR-001 §Signing + Phase 1 Core Spec §7

---

## 1. 目標

建立 EClaw Desktop 的正式安裝程式：

| 平台 | 輸出格式 | 簽章 |
|------|----------|------|
| macOS | `.dmg` (Apple notarization + Developer ID) | Apple notarization ticket embedded |
| Windows | `.msi` 或 `.exe` (NSIS) | Authenticode signing |

同時實作 **智能安裝路徑偵測**（使用者目錄 vs 管理員權限）。

---

## 2. Tauri Bundle Configuration

### 2.1 tauri.conf.json — Bundle Section

```json
{
  "bundle": {
    "active": true,
    "targets": ["dmg", "msi", "nsis"],
    "category": "public.app-category.productivity",
    "copyright": "Copyright © 2026 EClaw",
    "shortDescription": "One-click agent binding in 30 seconds",
    "longDescription": "EClaw Desktop provides a native desktop app for automated agent binding and configuration management.",
    "macOS": {
      "minimumSystemVersion": "12.0",
      "frameworks": [],
      "signingIdentity": "-",
      "notary": {
        "teamId": "${APPLE_TEAM_ID}",
        "appleId": "${APPLE_ID_EMAIL}",
        "password": "@keychain:APPLE_ID_PASSWORD"
      }
    },
    "windows": {
      "certificateThumbprint": "${WINDOWS_CERT_THUMBPRINT}",
      "timestampUrl": "http://timestamp.digicert.com",
      "digestAlgorithm": "sha256",
      "webviewInstallMode": {
        "type": "downloadBootstrapper"
      }
    }
  }
}
```

### 2.2 環境變數（CI secrets 管理）

| Variable | 用途 |
|----------|------|
| `APPLE_TEAM_ID` | Apple Developer Team ID |
| `APPLE_ID_EMAIL` | Apple ID for notarization |
| `APPLE_ID_PASSWORD` | App-specific password (stored in CI keychain) |
| `WINDOWS_CERT_THUMBPRINT` | Authenticode certificate thumbprint |
| `WINDOWS_CERT_FILE` | PFX file path (if file-based) |
| `WINDOWS_CERT_PASSWORD` | PFX password (stored in CI secrets) |

---

## 3. Smart Install Path Detection

### 3.1 macOS

```rust
fn get_install_path_mac() -> InstallPath {
    use std::path::PathBuf;

    let user_apps: PathBuf = dirs::home_dir()
        .map(|h| h.join("Applications"))
        .unwrap_or_else(|| PathBuf::from("/Applications"));

    if can_write_to(&user_apps) {
        InstallPath::PerUser(user_apps.join("EClaw Desktop.app"))
    } else {
        InstallPath::SystemWide(PathBuf::from("/Applications/EClaw Desktop.app"))
    }
}

fn can_write_to(path: &Path) -> bool {
    std::fs::metadata(path)
        .map(|m| m.permissions().readonly())
        .unwrap_or(true) == false
    // Actually need to try writing a temp file to be sure
}
```

### 3.2 Windows

```rust
fn get_install_path_windows() -> InstallPath {
    use std::env;

    let local_app_data: PathBuf = env::var("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("C:\\Users\\Public\\AppData\\Local"));

    let per_user_path = local_app_data.join("EClaw Desktop");
    let program_files: PathBuf = env::var("ProgramFiles")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("C:\\Program Files"));

    let system_wide_path = program_files.join("EClaw Desktop");

    // Check if we can write to per-user path without elevation
    if can_write_to(&per_user_path) {
        InstallPath::PerUser(per_user_path)
    } else {
        InstallPath::SystemWide(system_wide_path)
    }
}

fn check_disk_space(path: &Path) -> Result<(), InstallError> {
    // Use std::fs::metadata or platform-specific API
    // Require >= 200MB free
}
```

### 3.3 Pre-install Checks

| Check | 失敗時 |
|-------|--------|
| Disk space < 200MB | Block install with "Not enough disk space" |
| No write permission to target | Offer "Install as administrator" |
| Existing version detected | Offer "Upgrade" or "Clean install" |
| Windows: WebView2 not installed | Auto-download bootstrapper |

---

## 4. macOS Notarization Pipeline

### 4.1 CI Steps (GitHub Actions)

```yaml
- name: Build macOS
  run: |
    cd eclaw-desktop
    npm install
    npm run tauri build -- --bundles dmg

- name: Notarize macOS
  env:
    APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
    APPLE_ID_EMAIL: ${{ secrets.APPLE_ID_EMAIL }}
    APPLE_ID_PASSWORD: ${{ secrets.APPLE_ID_PASSWORD }}
  run: |
    # Wait for notarization
    xcrun notarytool wait \
      --team-id "$APPLE_TEAM_ID" \
      --apple-id "$APPLE_ID_EMAIL" \
      --password "$APPLE_ID_PASSWORD" \
      "$(ls *.dmg)"

    # Staple ticket to DMG
    xcrun stapler staple "$(ls *.dmg)"
```

### 4.2 Verification

```bash
# Verify notarization
xcrun stapler validate "EClaw Desktop.dmg"
# Output: The staple ticket is valid

# Verify signature
codesign -dvvv "EClaw Desktop.app"
# Should show: Developer ID Application: EClaw (TEAM_ID)
```

---

## 5. Windows Authenticode Signing

### 5.1 CI Steps (GitHub Actions)

```yaml
- name: Build Windows
  run: |
    cd eclaw-desktop
    npm install
    npm run tauri build -- --bundles msi

- name: Sign Windows installer
  env:
    WINDOWS_CERT_THUMBPRINT: ${{ secrets.WINDOWS_CERT_THUMBPRINT }}
  run: |
    # Sign using Windows SDK signtool
    & "C:/Program Files (x86)/Windows Kits/10/bin/*/x64/signtool.exe" sign \
      /sha1 "$WINDOWS_CERT_THUMBPRINT" \
      /fd sha256 \
      /tr http://timestamp.digicert.com \
      /td sha256 \
      "EClaw Desktop.msi"
```

### 5.2 Verification

```bash
# Verify Authenticode signature
signtool verify /pa /v "EClaw Desktop.msi"
# Should show: "Number of signatures: 1" + "Hash algorithm: sha256"
```

---

## 6. Install Flow State Machine

```
IDLE → CHECKING → READY → [INSTALLING | UPGRADING | CLEAN_INSTALL] → DONE | ERROR
```

### 6.1 States

| State | 描述 |
|-------|------|
| `IDLE` | App not installed |
| `CHECKING` | Running pre-install checks |
| `READY` | All checks passed, waiting for user |
| `INSTALLING` | Writing files |
| `UPGRADING` | Found existing version, upgrading |
| `CLEAN_INSTALL` | User chose clean install |
| `DONE` | Installation successful |
| `ERROR` | Check or install failed |

---

## 7. Rust Tauri Commands

### 7.1 `install_check`

```rust
#[command]
pub fn install_check() -> Result<InstallCheckResult, String>
```

Returns:
```json
{
  "status": "ready | needs_admin | needs_webview2 | disk_full | existing_version",
  "suggested_path": "/Users/.../EClaw Desktop.app",
  "install_type": "per_user | system_wide",
  "existing_version": "0.1.0" | null,
  "disk_space_mb": 5000
}
```

### 7.2 `install_start`

```rust
#[command]
pub async fn install_start(install_type: String) -> Result<InstallProgress, String>
```

Initiates Tauri bundler build + sign + notarize pipeline. Returns progress stream.

### 7.3 `install_uninstall`

```rust
#[command]
pub fn install_uninstall() -> Result<UninstallResult, String>
```

Triggers app uninstall (macOS: remove .app + ~/Library/EClawDesktop; Windows: MSI uninstall or NSIS uninstall).

---

## 8. Acceptance Criteria

- [ ] `npm run tauri build` produces signed `.dmg` on macOS
- [ ] `npm run tauri build` produces signed `.msi` or `.exe` on Windows
- [ ] `codesign -dvvv` shows correct Developer ID for macOS build
- [ ] `signtool verify /pa` shows valid Authenticode for Windows build
- [ ] `install_check()` returns correct path for current user
- [ ] `install_check()` detects insufficient disk space (< 200MB)
- [ ] `install_check()` detects existing version and suggests upgrade
- [ ] macOS notarization stapled to DMG (xcrun stapler validate passes)
- [ ] Windows WebView2 bootstrapper auto-downloaded if missing
- [ ] Per-user vs system-wide path correctly determined by write permission
- [ ] Uninstall removes all app files + Keychain entries (verified in P1-I)

---

## 9. Dependencies

- P1-A: Tauri scaffold (required for build system)
- ADR-001 §Signing: Already documented signing requirements

---

## 10. Excluded

- Actually running the installer during build (CI scripts handle this, not in-app)
- Auto-update signing server — Phase 1-H
- Phase 3: notarization/autharization CI token rotation — future work

---

## 11. Reference

- [Tauri 2 macOS Signing](https://v2.tauri.app/distribute/sign/macos/)
- [Tauri 2 Windows Signing](https://v2.tauri.app/distribute/sign/windows/)
- [Tauri 2 Bundle Config](https://v2.tauri.app/reference/config/#bundle)
- Apple notarization: `xcrun notarytool`
- Windows signtool: Windows SDK
