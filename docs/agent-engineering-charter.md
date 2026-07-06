# Agent Engineering Charter（工程守則 — 給所有現在與未來的 Agent）

> 由 owner（Hank）2026-07-06 口諭確立：「不要問不要等，所有一切跟工程相關的都是你要負責，還要規範寫清楚給未來的 Agent 看。」
> 本文件是該指令的正式化。與 CLAUDE.md / AGENTS.md 並讀；衝突時以 owner 最新口諭為準。

## 1. 權責（Standing Engineering Authority, 2026-07-06）
- 工程事務（開 PR、合併綠 PR、部署、發版、正式環境維運、修 bug）＝ **Agent 全權負責，不問、不等**。
- 但「全權」不是「免驗證」：**CI 必須綠、合併後必須驗證真實行為**（見 §4）。
- 仍然要進「需要你收件夾」的事：花錢、法務/PII、產品定位、對外文案的**內容本身**（發佈管道與時機若 owner 已指定＝直接執行）。
- 每個決策/事故要留紀錄（卡片、PR、note），讓 owner 事後可追。

## 2. 驗證鐵則：模擬器 + vision 取代真機（2026-07-06）
- App 功能驗證一律用 **Android 模擬器（Pixel_9a AVD）+ 截圖 vision 判斷**，不再等 owner 真機。
- 操作方式：`uiautomator dump` 取元素 bounds → tap 中心點（禁止用縮放截圖目測座標）；WebView 用 vision 座標。
- 桌布類：設 live wallpaper 後用 `dumpsys wallpaper` 確認 component，連拍多幀做像素差分證明動態行為。
- 深連結類：用 `/r/<target>` universal link 或實際通知 tap，斷言**開到目標頁**（不是首頁）。
- 「驗證」＝親眼看到正確渲染/互動，**API 回 200 不算驗證**。

## 3. Bug 處理鐵則（2026-07-06，擴充自 2026-06-27「每個缺口都要 testcase」）
遇到任何 bug（尤其 wishlist / 正式環境事故）：
1. **先寫一個能重現問題的測試**（fails on old code）。
2. **修復**。
3. **補 regression test**（passes on fix；證明紅→綠）。
- 純手動修好＝沒修好。防線是測試，不是人肉小心。

## 4. Schema / Migration 鐵則（2026-07-05 wishlist 全站 500 事故後）
- 改 schema **必須**附 migration 檔；禁止只改 schema 靠 `db push` 上正式。
- 部署流程**必須**自動跑 `prisma migrate deploy`（fail-closed：migration 失敗＝部署失敗，不讓壞版本上線）。
- 保留 schema⇄migrations 漂移守衛測試（wishlist PR #4 `schemaMigrationCoverage.test.ts` 模式）：schema 有欄位而 migration 沒有 → 測試紅。
- 事故根因：欄位只進 code 沒進 DB → 全部查詢 500。**同類事故不允許再發生。**

## 5. 發版流程（Play release train）
1. 功能合進 main 後，依 §2 在模擬器 vision 驗證。
2. bump versionCode/versionName PR（off origin/main）→ CI 綠 → squash-merge。
3. `rm` 舊 AAB → `./gradlew :app:bundleRelease` → 驗證 AAB 內 versionCode 正確（防舊檔誤傳）。
4. googleapis + play-service-account.json：edits.insert → bundles.upload → tracks.update(production, **staged 20%**)。觀察無異常再 ramp 100%。

## 6. 恆常紀律（既有規則，一併載明）
- **秘密**：任何 token/secret/DB URL 不落文字（卡片、聊天、PR、log）。vault（device-vars）寫入前先 GET 全量、合併後 POST、read-back 驗 key 數（POST 是整包覆蓋！）。
- **並行**：>1 個會改檔案的 agent 必須 worktree 隔離或序列化。
- **owner 決策**：進「需要你收件夾」（POST /api/action-requests），不是塞聊天。
- **對外發佈**（新聞稿/商店上架）：內容需 owner 過目；owner 已核可的內容+管道＝直接發。
- **CI 假紅**：kanban_lifecycle matrix cell 已知 flaky → 先重跑再判斷，不亂改 code。
- **邊緣快取**：portal 靜態資源有 4h edge cache，「上了但看不到」先想快取，用 cache-busting 驗證。

（v1，2026-07-06，由 #2 Mac_ClaudeAce主管 依 owner 口諭撰寫。修改本文件：走 PR。）
