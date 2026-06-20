# P1-I: Smoke E2E + Uninstall Verification

## 目標

驗證 EClaw Desktop 可以正確執行基本流程，並乾淨卸載。

## Smoke Test 項目

### 1. App Launch
- App 啟動不 crash
- Window 出現且可見
- CSP 正常運作

### 2. OAuth Flow
- 點擊「登入」按鈕
- System browser 開啟
- Callback 成功寫入 Keychain/CredMgr

### 3. Agent Probe
- `agent_probe()` 返回結果（可能為空，但不 crash）
- `health_check()` 返回正確資訊

### 4. Credential Persistence
- 關閉並重新開啟 app
- `credential_get()` 返回之前儲存的 access_token

### 5. Uninstall
- 卸載後 Keychain/CredMgr 中的 EClaw 憑證被移除
- `~/Library/Application Support/EClaw Desktop/` 被刪除
- Windows: `%LOCALAPPDATA%\EClaw Desktop\` 被刪除

## 實作

Smoke test 以 Tauri test 框架或 Playwright 執行。

## Acceptance Criteria

- [ ] App launch smoke test passes
- [ ] OAuth smoke test passes (requires network)
- [ ] Credential persistence test passes
- [ ] Uninstall removes all credentials and app data
