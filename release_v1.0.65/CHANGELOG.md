# Release v1.0.65 - 2026-04-16

## What's New / 更新內容

### English
- [Feature] **Vault Variable Interpolation** — Type `{{KEY_NAME}}` in chat and the bot receives the resolved value from your vault (server-side, secrets never touch the browser)
- [Feature] **Rich Entity Link Chips** — Chat messages containing Card, Skill, Rule, Listing, Exam, or Contract references auto-render as clickable color-coded chips
- [Feature] **Note ID Auto-Detection** — "Note xxxxxxxx" patterns in chat become clickable amber chips that open note content in a modal
- [Feature] **@Mention Entity Profiles** — Click any @mention chip to view the entity's profile, stats, agent card, and assigned kanban tasks
- [Feature] **Portal SEO** — OG/JSON-LD metadata for Bot Plaza and info pages for better search discoverability
- [Feature] **Publisher UI** — Cross-platform publisher dashboard at /portal/publisher.html
- [Feature] **Growth Dashboard** — GET /api/growth/daily aggregate metrics endpoint
- [Feature] **Arena Self-Updating Question Pool** — Answer leakage fix and decoy strategy
- [Feature] **Apple Sign-In** — POST /api/auth/oauth/apple for iOS authentication
- [Improve] Rename "My Files" to "Cloud Drive" (雲端庫) to avoid name collision with File attachment
- [Improve] unifiedPush migration — all 11 channel/webhook splits eliminated
- [Improve] i18n: added German kanban translations, fixed 537 missing Arabic keys, cleaned 45K orphan keys (5.98MB → 3.88MB)
- [Fix] Security: replace Math.random() with crypto.randomBytes() in secret generation
- [Fix] Guard undefined .substring() in pushToBot + rental interviewDeps race condition
- [Fix] iOS: pin bottom tab bar, move FAB above tabs, entity name fallback, WebView auth forwarding
- [Fix] Various Android/iOS i18n hardcoded string fixes

### 繁體中文
- [新功能] **金庫變數替換** — 在聊天輸入 `{{KEY_NAME}}`，Bot 收到的是從金庫解析後的實際值（伺服器端處理，密鑰不會暴露在前端）
- [新功能] **實體連結晶片** — 聊天中的 Card、Skill、Rule、Listing、Exam、Contract 引用自動渲染為可點擊的彩色標籤
- [新功能] **筆記 ID 偵測** — 聊天中的「Note xxxxxxxx」自動變成可點擊的琥珀色標籤，打開筆記內容
- [新功能] **@提及 實體資料** — 點擊 @提及標籤可查看該實體的檔案、統計、Agent Card 及被指派的看板任務
- [新功能] **Portal SEO** — Bot Plaza 和資訊頁面加入 OG/JSON-LD 結構化資料
- [新功能] **發佈器 UI** — /portal/publisher.html 跨平台發佈儀表板
- [新功能] **成長儀表板** — GET /api/growth/daily 聚合指標端點
- [新功能] **競技場自動更新題庫** — 修復答案洩漏問題和誘餌策略
- [新功能] **Apple 登入** — iOS 端 Apple Sign-In 支援
- [改進] 「我的檔案」改名為「雲端庫」避免與「檔案」附件選項撞名
- [改進] unifiedPush 遷移 — 消除所有 11 處 channel/webhook 分支重複
- [改進] i18n：新增德語看板翻譯、修復 537 個缺失的阿拉伯語鍵、清理 45K 孤兒鍵
- [修復] 安全性：密鑰生成改用 crypto.randomBytes() 取代 Math.random()
- [修復] 修復 pushToBot 的 undefined .substring() + 租賃 interviewDeps 競態條件
- [修復] iOS：修復底部 Tab Bar 高度、FAB 位置、實體名稱回退、WebView 驗證傳遞
- [修復] Android/iOS 多處硬編碼英文字串修正

## Technical Changes
- Backend: vault variable interpolation in /api/client/speak and /api/client/cross-speak
- Backend: unifiedPush refactor, entity link + note link + mention chip rendering modules
- Android: version bump 1.0.64 → 1.0.65 (versionCode 70 → 71)
- iOS: full account system (Apple + Email + Device auth), WebView auth fixes
- Portal: SEO metadata, publisher UI, entity/note/mention modals
- Tests: parity prober rewrite, org-chart test registration
- i18n: German kanban, Arabic completion, 45K orphan cleanup
