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

## Acceptance Criteria

- [ ] 首次開啟顯示 Globe-user 歡迎頁（< 3s）
- [ ] Google OAuth 登入按鈕可點擊
- [ ] OAuth 完成後自動進入 Setup 頁
- [ ] Agent probe 自動執行（10s timeout）
- [ ] Setup 完成後進入 Ready 頁
- [ ] 30s 內可完成全流程
