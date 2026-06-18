# P1-I: Smoke E2E + Uninstall Verification

## 目標

驗證 EClaw Desktop 可以正確執行基本流程（install → OAuth → bind agent → uninstall），並確保卸載後無殘留項目。

## 驗證矩陣（spec §12）

### macOS Smoke Test

| Step | 驗證項目 | 预期结果 |
|------|---------|---------|
| 1 | Fresh install from signed `.dmg` | 安裝成功，App 在 Applications |
| 2 | Launch app | Window 出現，CSP 正常，無 crash |
| 3 | OAuth flow（Google 登入）| 瀏覽器開啟 → callback → Keychain 有 cred |
| 4 | Bind one agent（`device_register` + `device_bind_with_code`）| botSecret 寫入 Keychain |
| 5 | Restart app | Session 恢復，不需重新 OAuth |
| 6 | Uninstall | dmg 卸載乾淨 |
| 7 | Post-uninstall: Keychain | 無 EClaw 項目 |
| 8 | Post-uninstall: LaunchAgent | 無殘留 plist |
| 9 | Post-uninstall: ~/Library/Application Support/EClaw Desktop/ | 目錄已刪除 |
| 10 | Post-uninstall: update cache | 無殘留 |

### Windows Smoke Test

| Step | 驗證項目 | 预期结果 |
|------|---------|---------|
| 1 | Fresh install from signed `.msi` | 安裝成功 |
| 2 | Launch app | Window 出現，無 crash |
| 3 | OAuth flow | Credential Manager 有 cred |
| 4 | Bind one agent | botSecret 寫入 CredMgr |
| 5 | Restart app | Session 恢復 |
| 6 | Uninstall | MSI 卸載乾淨 |
| 7 | Post-uninstall: Credential Manager | 無 EClaw 項目 |
| 8 | Post-uninstall: HKCU uninstall key | 已清除 |
| 9 | Post-uninstall: %LOCALAPPDATA%\EClaw Desktop\ | 目錄已刪除 |
| 10 | Post-uninstall: firewall rule | 無殘留規則 |

## 產出

- **macOS smoke video/GIF**：redacted（移除 OAuth 期間的敏感 UI），用於內部文件
- **Uninstall verification output**：所有 remaining items 列表（應為空）
- **Windows VM follow-up**：ADR-001 PoC scope（待 Windows VM 可用時執行）

## 依賴

- P1-A, P1-B, P1-C, P1-D, P1-E, P1-F, P1-G, P1-H 全部完成 ✅

## 實作限制

此卡 primarily **手動 E2E test**，需要在 actual macOS/Windows 機器上執行：
- Tauri dev mode 或 built app
- Actual OAuth flow（需要 browser + Google account）
- Actual uninstall（需要系統管理員權限）

`screenshots/` 目錄存放記錄截圖（redacted）。`eclaw-desktop/src-tauri/tests/smoke_test.rs` 為基礎框架，實際 full E2E 需手動執行。

## Acceptance Criteria

- [ ] macOS smoke: install → OAuth → bind → uninstall 全流程跑通
- [ ] Uninstall 後無殘留項目（Keychain / LaunchAgent 等全部為空）
- [ ] Redacted smoke video/GIF 可用於內部文件
- [ ] Windows smoke 待 VM 可用後執行（ADR-001 scope）
