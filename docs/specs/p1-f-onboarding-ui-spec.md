# P1-F: 30s Onboarding UI + 三段式流程

## 目標

新用戶首次開啟 EClaw Desktop，30 秒內完成初始設定。

## 三段式流程

### Screen 1: Globe-user（歡迎頁）
- 大型 Globe 圖示（🌐）+ 登入按鈕
- 顯示 "Welcome to EClaw Desktop"
- Google OAuth 登入按鈕
- 點擊後啟動 OAuth flow

### Screen 2: Setup（配置頁）
- OAuth 成功後進入
- 顯示 "Setting up your desktop..."
- Agent endpoint 自動探測中（progress spinner）
- 成功：顯示發現的 agents
- 失敗：顯示警告但允許繼續

### Screen 3: ✅（完成頁）
- 大型 ✓ 圖示
- "You're all set!"
- App window 可以開始使用

## 技術實作

- 純 HTML/CSS/JS（不使用框架）
- `index.html` 替換為單頁 App
- Tauri `invoke()` 呼叫 Rust commands
- `credential_get()` 檢查是否已登入
- `agent_probe()` 自動探測 endpoints

## 狀態機

```
LOADING → WELCOME (無 credential)
       → SETUP (有 credential, 未完成配置)
       → READY (配置完成)
```

### ? Icon Tooltip 說明

每個 screen 都有一個「？」按鈕，展開說明：

**Welcome screen ?**：
- 「為什麼需要 Google 登入？」→ 「EClaw 使用您的 Google 帳號來驗證身份，不會讀取您的 Gmail 或 Google Drive 資料。」

**Setup screen ?**：
- 「資料存在哪裡？」→ 「您的登入憑證會加密保存在電腦的 Keychain（macOS）或 Credential Manager（Windows），不會上傳到任何伺服器。」
- 「什麼是 Agent 探測？」→ 「EClaw 會掃描本機，找出已安裝的 EClaw AI 夥伴程式。」

**Ready screen ?**：
- 「登出會怎樣？」→ 「您的凭据会被清除，可随时重新登录。」

## Acceptance Criteria

- [ ] 首次開啟顯示 Globe-user 歡迎頁（< 3s）
- [ ] Google OAuth 登入按鈕可點擊
- [ ] OAuth 完成後自動進入 Setup 頁
- [ ] Agent probe 自動執行（10s timeout）
- [ ] Setup 完成後進入 Ready 頁
- [ ] 30s 內可完成全流程（假設已有 Google 登入狀態）
- [ ] 每個 screen 有「？」按鈕，展開正確的說明文字
