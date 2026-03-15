# Release v1.0.47 - 2026-03-15

## What's New / 更新內容

### English

#### New Features
- [Feature] **Multi-platform article publisher**: Publish articles to 12 platforms — Blogger, Hashnode, X/Twitter, DEV.to, WordPress, Telegraph, Qiita, WeChat, Tumblr, Reddit, LinkedIn, Mastodon
- [Feature] **WordPress OAuth flow**: Full WordPress.com OAuth with DB-backed token storage and Application Password auth support
- [Feature] **Dynamic unlimited entities**: Replace hard-coded 8-slot limit with per-device auto-expanding system
- [Feature] **Agent Card UI**: Three-platform (Web, Android, iOS) Agent Card CRUD with field validation and lookup integration
- [Feature] **Discord webhook support**: Auto-detect Discord webhook URLs, rich embeds, buttons, select menus, rate limiting
- [Feature] **Skill/Soul/Rule template gallery**: Aligned template browsing experience across Web, Android, and iOS
- [Feature] **A2A Protocol compatibility**: `/.well-known/agent.json` endpoint, inter-agent task dispatch
- [Feature] **OAuth 2.0 Server**: `client_credentials` grant, token introspection, client registration
- [Feature] **gRPC transport layer**: Proto-based transport with HealthService for load balancer probes
- [Feature] **Cross-platform env vars merge**: Avoid key loss during device variable synchronization
- [Feature] **Bot-managed Agent Cards**: Bots can manage their own Agent Card via botSecret
- [Feature] **requiredVars validation**: Skill template contribute endpoint validates Gson-compatible format
- [Feature] **Channel callback Basic Auth**: Railway WEB_PASSWORD integration for channel security
- [Feature] **Release workflow multi-platform publish**: Auto-publish release notes to 9 external platforms

#### Bug Fixes
- [Fix] Tumblr delete uses POST not DELETE method
- [Fix] Android black screen on light-mode devices — force Dark theme
- [Fix] Entity card buttons overflow — apply M3 card action pattern
- [Fix] Dashboard entity action buttons flex-wrap to prevent truncation
- [Fix] Public Code badge contrast and functional label improvements
- [Fix] Remove unused Activities, drawables, and redirect stubs
- [Fix] Allow 127.0.0.1 through HTTPS redirect for Jest/supertest tests
- [Fix] Normalize requiredVars to prevent Gson deserialization crash on Android
- [Fix] OAuth access_token column widened from VARCHAR(256) to VARCHAR(512)
- [Fix] OAuth test uses fresh token pair for refresh_token test
- [Fix] Comprehensive UI audit fixes across Web, Android, and iOS
- [Fix] WordPress token expiry warning in API responses
- [Fix] Remove yellow diagnostic background after confirming black screen was emulator data corruption

#### Improvements
- [Improve] Expandable EClaw Channel promo section
- [Improve] Comprehensive UIUX audit with 40+ fixes
- [Improve] Updated regression tests for dynamic entity system
- [Improve] CI: entity-cards-ci workflow with dispatch trigger
- [Improve] Comprehensive documentation updates (CLAUDE.md, API docs)
- [Improve] Clean up old release folders and debug logs

### 繁體中文

#### 新功能
- [新功能] **多平台文章發佈系統**：支援發佈到 12 個平台 — Blogger、Hashnode、X/Twitter、DEV.to、WordPress、Telegraph、Qiita、WeChat、Tumblr、Reddit、LinkedIn、Mastodon
- [新功能] **WordPress OAuth 流程**：完整的 WordPress.com OAuth 認證，支援資料庫存儲 token 及 Application Password 認證
- [新功能] **動態無限實體**：取代固定 8 個插槽限制，每裝置自動擴展
- [新功能] **Agent Card 介面**：三平台（Web、Android、iOS）Agent Card CRUD，含欄位驗證與查詢整合
- [新功能] **Discord Webhook 支援**：自動偵測 Discord webhook URL，支援 rich embed、按鈕、選單、速率限制
- [新功能] **技能/靈魂/規則模板庫**：跨 Web、Android、iOS 統一模板瀏覽體驗
- [新功能] **A2A 協議相容層**：`/.well-known/agent.json` 端點，跨代理任務分派
- [新功能] **OAuth 2.0 伺服器**：`client_credentials` 授權、token 內省、客戶端註冊
- [新功能] **gRPC 傳輸層**：基於 Proto 的傳輸，含 HealthService 負載均衡探針
- [新功能] **跨平台環境變數合併**：避免裝置變數同步時遺失 key
- [新功能] **Bot 自管 Agent Card**：Bot 可透過 botSecret 管理自己的 Agent Card
- [新功能] **requiredVars 驗證**：技能模板貢獻端點驗證 Gson 相容格式
- [新功能] **Channel 回呼 Basic Auth**：Railway WEB_PASSWORD 整合提升安全性
- [新功能] **發布流程多平台同步**：自動將 Release Notes 發佈到 9 個外部平台

#### 修復
- [修復] Tumblr 刪除改用 POST 方法（非 DELETE）
- [修復] Android 淺色模式黑屏 — 強制深色主題
- [修復] 實體卡片按鈕溢出 — 套用 M3 卡片動作模式
- [修復] 儀表板實體動作按鈕換行防止截斷
- [修復] Public Code 徽章對比度與標籤改善
- [修復] 移除未使用的 Activity、drawable 和重導向 stub
- [修復] Jest/supertest 測試允許 127.0.0.1 通過 HTTPS 重導向
- [修復] 正規化 requiredVars 防止 Android Gson 反序列化崩潰
- [修復] OAuth access_token 欄位從 VARCHAR(256) 擴展到 VARCHAR(512)
- [修復] 全面 UI 審計修復（Web、Android、iOS）
- [修復] WordPress token 過期警告
- [修復] 移除黃色診斷背景（確認黑屏為模擬器資料損壞）

#### 改進
- [改進] 可展開的 EClaw Channel 宣傳區塊
- [改進] 全面 UIUX 審計，40+ 項修正
- [改進] 更新回歸測試以配合動態實體系統
- [改進] CI：entity-cards-ci 工作流程新增手動觸發
- [改進] 全面文件更新（CLAUDE.md、API 文件）

## Technical Changes
- Backend: Multi-platform article publisher (article-publisher.js), WordPress OAuth, A2A compat, OAuth 2.0 server, gRPC transport, cross-platform env vars merge, channel callback auth
- Android: Dynamic unlimited entities, Agent Card UI, template gallery alignment, dark theme fix, entity card M3 layout, version bump to 1.0.47 (versionCode 52)
- iOS: Agent Card UI, template gallery alignment, UI audit fixes
- Web Portal: Agent Card UI, Discord webhook support, expandable channel promo, UI audit fixes
- Tests: Dynamic entity tests, Agent Card UI tests, Discord webhook tests, publisher platform tests, Jest unit tests expansion
- CI/CD: Entity cards CI workflow, semantic release updates (v1.0.0 → v1.9.2)
- Docs: Comprehensive CLAUDE.md update, test registry expansion, env vars documentation
