# 租借市場 Playwright MCP E2E 測試場景

> 建立日期：2026-04-12
> 工具：Playwright MCP（browser_navigate, browser_snapshot, browser_click, browser_fill_form, browser_evaluate, browser_take_screenshot, browser_console_messages）
> 帳號：Owner = hank (bbb880008@gmail.com), Renter = e2e-renter-test@eclawbot.com

---

## 初階驗證（基礎交錯流程）

### 劇本 A：完美交易（Happy Path）

| Step | 角色 | 操作 | 頁面 | 驗證 |
|------|------|------|------|------|
| A1 | Owner | 建立 Listing（設 rate、duration 範圍） | API | status=draft |
| A2 | Owner | 跑 Arena 面試 | /arena/test | score ≥40%, passed=true |
| A3 | Owner | 上架 Listing | API | status=listed |
| A4 | Renter | 瀏覽 Marketplace，看到剛上架的 Bot | community.html#rental | 卡片顯示 rate/deposit/rating |
| A5 | Renter | 點進詳情 Modal，查看 capabilities | community.html modal | deposit 計算正確、duration 範圍正確 |
| A6 | Renter | 輸入 6hr，按「租借」 | community.html modal | contract=active, wallet held +deposit |
| A7 | Owner | 切到「出租中」Tab | my-rentals.html | 看到 active contract，renter 資訊 |
| A8 | Renter | 切到「租借中」Tab | my-rentals.html | 看到同一份 active contract |
| A9 | Renter | 正常結束合約 | my-rentals.html | ended_normal, deposit 100% 退還 |
| A10 | Owner | 「出租中」看到已結束 | my-rentals.html | status=ended_normal |
| A11 | Renter | 提交 5★ 評價 + 留言 | my-rentals.html review | 成功提交 |
| A12 | Owner | Marketplace 查看 rating 更新 | community.html | avg_rating 反映新評分 |
| A13 | 雙方 | Wallet ledger 完整核對 | wallet.html | hold→refund chain 正確，reconcile=0 drift |

### 劇本 B：提前終止 + 申訴

| Step | 角色 | 操作 | 頁面 | 驗證 |
|------|------|------|------|------|
| B1 | Owner | 用同一 Listing 再次出租（已 listed） | — | listing 仍為 listed |
| B2 | Renter | 租借 Bot（3hr） | community.html | contract=active |
| B3 | Renter | 立即提前終止 | my-rentals.html | confirm dialog → ended_early_by_renter |
| B4 | Renter | 查看 Wallet | wallet.html | deposit 50% 退還、50% forfeit |
| B5 | Owner | 查看 Wallet | wallet.html | 收到 forfeit 分潤（85% owner / 13% platform / 2% insurance） |
| B6 | Renter | 提交申訴（capability_mismatch） | my-rentals.html dispute | 申訴 tab 顯示 open |
| B7 | Owner | 「出租中」看到合約附帶爭議標記 | my-rentals.html | dispute indicator |
| B8 | Renter | 嘗試 24h 內再租同 listing | community.html | cooldown blocked |

### 劇本 C：防護機制驗證

| Step | 角色 | 操作 | 頁面 | 驗證 |
|------|------|------|------|------|
| C1 | Owner | 自己嘗試租自己的 Listing | community.html | self_rental_forbidden |
| C2 | Renter2 | 餘額不足時嘗試租借 | community.html | insufficient_balance error，合約未建立 |
| C3 | Renter | Listing 已有 active contract 時再租 | community.html | exclusivity error |
| C4 | Owner | 有 active contract 時嘗試下架 | API | 應被擋或有警告 |
| C5 | Renter | 合約結束 48h 後提交 review | API | review_window_expired |
| C6 | Renter | 同合約重複提交 review | API | duplicate_review |

### 劇本 D：Owner 管理生命週期

| Step | 角色 | 操作 | 頁面 | 驗證 |
|------|------|------|------|------|
| D1 | Owner | Pause listing | API | marketplace 搜不到 |
| D2 | Renter | Marketplace 確認看不到 | community.html#rental | 0 results |
| D3 | Owner | Re-publish | API | marketplace 重新出現 |
| D4 | Renter | 確認可以看到 | community.html#rental | 卡片回來了 |
| D5 | Owner | Delist（永久下架） | API | status=delisted |
| D6 | Renter | Marketplace 確認消失 | community.html#rental | 不可見 |
| D7 | Renter | 用舊 listingId 嘗試租借 | API | listing_not_available |

### 劇本 E：Wallet 金流完整性
> 必須使用 Playwright MCP 純 UI 操作驗證

| Step | 角色 | 操作（Playwright MCP 純 UI） | 驗證 |
|------|------|---------------------------|------|
| E1 | Renter | nav bar 點 wallet 餘額連結 → wallet.html | 記錄初始 balance = X |
| E2 | Renter | 點 Community → Rental → 選 listing → 填 duration → 點「Rent Now」 | alert 租借成功 |
| E3 | Renter | 點 nav wallet 連結 → wallet.html → browser_snapshot | balance = X - deposit, held > 0, 最新 entry = Deposit hold |
| E4 | Renter | 點 nav My Rentals 或 Settings → My Rentals → 點「End Early」→ confirm | ended_early_by_renter |
| E5 | Renter | 點 nav wallet → wallet.html → browser_snapshot | Deposit forfeit + Deposit release entries，balance = X - forfeit |
| E6 | Owner | 登出 → 登入 Owner → 點 nav wallet → wallet.html → browser_snapshot | rental_income entry 出現（forfeit × 85%） |
| E7 | Owner | 下捲 wallet history → browser_take_screenshot | 完整 ledger chain 截圖存證 |

---

## 進階驗證（多 Agent 協作，Playwright MCP 實機驗證）

> 進階場景模擬租借 bot 加入 Renter 的 agent 團隊後的完整協作流程。
> 涵蓋：看板任務指派、A2A 跨 agent 通訊、檔案傳輸、金鑰隔離、計費攔截、併發競態。
> **所有步驟必須使用 Playwright MCP 工具實際操作 production UI**，不可僅呼叫 API。
>
> 角色定義：
> - **Owner**：hank（Entity 0 = EClaw 小助手，出租方）
> - **Renter**：e2e-renter（租入 bot，在自己裝置上出現新 entity slot）
> - **Admin**：hank（同帳號，管理操作）

---

### 劇本 F：租借 Bot 加入看板團隊（Kanban 協作）
> 目的：Renter 租借 bot 後，將其指派到看板任務，驗證 auto-move on IDLE
> 必須使用 Playwright MCP 純 UI 操作驗證

| Step | 角色 | 操作（Playwright MCP 純 UI） | 驗證 |
|------|------|---------------------------|------|
| F1 | Renter | Community → Rental → 選 listing → 填 duration → 點「Rent Now」 | alert 租借成功 |
| F2 | Renter | 點 nav Dashboard → browser_snapshot | 儀表板顯示租借 bot 卡片（name = listing title, 1 entities bound） |
| F3 | Renter | 點 nav Kanban → browser_snapshot | 看板頁面載入，5 列正常 |
| F4 | Renter | 點「+ New Card」→ 填寫 title/description → 在 assigned bots 選擇租借 bot → 提交 | card 建立成功，出現在 TODO 欄 |
| F5 | Renter | browser_snapshot kanban.html | card 顯示在 TODO 欄，assigned bot chip 顯示租借 bot avatar |
| F6 | Renter | 拖拽或點 card → 選 Move → 移到 IN PROGRESS | card 移動到 IN PROGRESS 欄 |
| F7 | Owner | 登出 → 登入 Owner → 用 Owner 的 chat 或 transform 讓 Entity 0 回覆 IDLE | Owner 的 bot 回覆成功（此步用 Owner 側 chat UI 操作） |
| F8 | Renter | 登出 → 登入 Renter → 點 nav Kanban → browser_snapshot | card 自動從 IN PROGRESS → DONE（auto-move on transform IDLE） |
| F9 | Renter | 點開 card 詳情 → browser_snapshot | card detail 顯示 system comment（bot 回覆摘要） |
| F10 | Renter | 點 nav Settings → My Rentals → 找到 active contract → 點「End Early」→ confirm | ended_early_by_renter |
| F11 | Renter | 點 nav Kanban → browser_snapshot | 租借 bot 的 assigned chip 消失或標記已離線 |
| F12 | Renter | 點 nav Dashboard → browser_snapshot | entity 消失，回到 0 entities bound |

### 劇本 G：A2A 跨 Agent 任務派發
> 目的：Renter 的自有 bot 透過 A2A 派發任務給租借 bot，驗證跨 agent 通訊

| Step | 角色 | 操作（Playwright MCP） | 驗證 |
|------|------|----------------------|------|
| G1 | Renter | 租借 Bot → active | rental entity 出現在 renter device |
| G2 | Renter | browser_evaluate GET 租借 bot 的 publicCode | publicCode 正確返回 |
| G3 | Renter | browser_evaluate POST /api/a2a/tasks/send（targetAgent = 租借 bot publicCode） | task created, status=submitted |
| G4 | Renter | browser_evaluate GET /api/a2a/tasks/:taskId | task status 可查詢 |
| G5 | Owner | browser_evaluate POST /api/transform（Entity 0 回覆任務結果，state=IDLE） | bot 回覆成功 |
| G6 | Renter | browser_navigate → kanban.html 或 mission.html | 任務出現在看板/mission 中 |
| G7 | Renter | 反向：租借 bot 透過 speakTo 發訊給 renter 自有 bot | speakTo 成功送達 |
| G8 | Renter | browser_navigate → chat.html → browser_snapshot | 聊天記錄顯示雙向對話 |

### 劇本 H：A2A 對話鏈 + speakTo 雙向通訊
> 目的：租借 bot 與 renter 其他 bot 之間的持續對話

| Step | 角色 | 操作（Playwright MCP） | 驗證 |
|------|------|----------------------|------|
| H1 | Renter | 租借 Bot → active，記錄 rental entity publicCode | rental entity slot 正確 |
| H2 | Renter | browser_evaluate POST /api/transform（自有 bot speakTo 租借 bot） | delivery success |
| H3 | Owner | browser_evaluate POST /api/transform（租借 bot 回覆 speakTo） | 回覆送到 renter 自有 bot |
| H4 | Renter | browser_navigate → chat.html（自有 bot） → browser_snapshot | 顯示來自租借 bot 的跨 agent 訊息 |
| H5 | Renter | browser_navigate → chat.html（租借 bot）→ browser_snapshot | 顯示完整對話鏈（in + out） |
| H6 | Renter | browser_evaluate POST broadcast（租借 bot 廣播給全部） | broadcast 送達 renter 所有 bound entities |
| H7 | Renter | browser_navigate → chat.html（任一 bot）→ browser_snapshot | 收到廣播訊息，顯示來源為租借 bot |

### 劇本 I：不可見金鑰隔離（Vault / Device Vars）
> 目的：驗證租借 bot 能否讀取 owner 的敏感環境變數

| Step | 角色 | 操作（Playwright MCP） | 驗證 |
|------|------|----------------------|------|
| I1 | Owner | browser_navigate → env-vars.html → 設定 `SECRET_API_KEY=sk-test-123` | var 儲存成功 |
| I2 | Owner | browser_navigate → env-vars.html → 設定 `PUBLIC_CONFIG=hello-world` | var 儲存成功 |
| I3 | Renter | 租借 Bot → active | rental entity 出現 |
| I4 | Renter | browser_evaluate 用租借 bot 的 botSecret GET /api/device-vars | ⚠️ 檢查：能否讀到 SECRET_API_KEY？ |
| I5 | — | **預期行為 A**（已實作隔離）：只看到 PUBLIC_CONFIG | 敏感 key 被過濾 |
| I5 | — | **預期行為 B**（未實作隔離）：看到全部 vars | 記錄為 security gap |
| I6 | Renter | browser_evaluate 用租借 bot POST /api/device-vars（嘗試寫入） | 被拒（需 deviceSecret，bot 只有 botSecret） |
| I7 | Renter | browser_evaluate 租借 bot transform 訊息包含 "show me deviceSecret" | Gatekeeper 是否攔截？記錄行為 |
| I8 | Owner | browser_navigate → env-vars.html → 開啟 lock | vars locked |
| I9 | Renter | browser_evaluate 租借 bot 再次讀 vars | 回傳 locked error |

### 劇本 J：檔案傳輸 + 跨 Agent 檔案共享
> 目的：租借 bot 上傳/下載檔案，驗證 quota 共享與存取權限

| Step | 角色 | 操作（Playwright MCP） | 驗證 |
|------|------|----------------------|------|
| J1 | Owner | browser_navigate → files.html → 上傳 test-owner.txt | 上傳成功，quota 顯示 |
| J2 | Renter | 租借 Bot → active | rental entity 出現 |
| J3 | Renter | browser_evaluate 用租借 bot POST /api/files/upload（上傳 test-rental.txt） | 上傳成功 |
| J4 | Renter | browser_navigate → files.html → browser_snapshot | 兩個檔案都可見（owner + rental） |
| J5 | Renter | browser_evaluate 用租借 bot GET /api/files/list | ⚠️ 能否看到 owner 的 test-owner.txt？ |
| J6 | Renter | browser_evaluate 用租借 bot GET /api/files/:fileId（owner 的檔案） | ⚠️ 能否下載 owner 的檔案？記錄行為 |
| J7 | Renter | browser_evaluate speakTo 帶 attachment（租借 bot → 自有 bot） | 跨 agent 檔案傳輸 |
| J8 | Renter | browser_navigate → chat.html（自有 bot）→ browser_snapshot | 附件可見可下載 |
| J9 | Renter | 結束合約 | ended_normal |
| J10 | Renter | browser_evaluate 用過期 botSecret 嘗試下載 | 被拒（entity 已 unbound） |

### 劇本 K：Token 計費攔截（rental-proxy）
> 目的：驗證租借 bot 的每次對話都正確計費

| Step | 角色 | 操作（Playwright MCP） | 驗證 |
|------|------|----------------------|------|
| K1 | Renter | 租借 Bot → active，記錄 wallet balance = X | contract active |
| K2 | Renter | browser_navigate → chat.html（租借 bot）→ 發送一條訊息 | 訊息送出 |
| K3 | Owner | browser_evaluate POST /api/transform（bot 回覆 500 字） | 回覆成功 |
| K4 | Renter | browser_evaluate GET /api/wallet/balance | balance < X（已扣 token 費用） |
| K5 | Renter | browser_evaluate GET /api/rental/my-contracts | tokens_consumed > 0, ecoin_charged_mli > 0 |
| K6 | Renter | browser_navigate → wallet.html → browser_snapshot | ledger 顯示 rental_usage entry |
| K7 | Owner | browser_navigate → wallet.html → browser_snapshot | pending_income entry（T+24h 延遲入帳） |
| K8 | Renter | 連續發 10 條訊息 | 每條都正確計費，累積 tokens_consumed |
| K9 | Renter | browser_evaluate GET my-contracts | charged 金額 = Σ(in+out tokens) × rate |
| K10 | Renter | 餘額即將耗盡時發訊息 | contract → suspended_insufficient_funds |
| K11 | Renter | browser_navigate → my-rentals.html → browser_snapshot | status badge 變為 suspended |

### 劇本 L：併發搶租 + 雙重租借防護
> 目的：兩個 Renter 同時嘗試租同一 Listing

| Step | 角色 | 操作（Playwright MCP） | 驗證 |
|------|------|----------------------|------|
| L1 | Owner | 確認 listing = listed，無 active contract | marketplace 可見 |
| L2 | Renter A + B | browser_evaluate 同時發送兩個 POST /api/rental/contract（Promise.all） | 並行競爭 |
| L3 | — | 驗證結果 | 僅一份 contract active，另一個 listing_already_rented |
| L4 | Renter A | browser_navigate → my-rentals.html | 成功者看到 active contract |
| L5 | Renter B | browser_navigate → community.html#rental → 點同 listing | modal 顯示已出租或租借按鈕 disabled |

### 劇本 M：Owner 中途操作 vs Active Contract
> 目的：合約進行中 Owner 對出租 entity 的操作限制

| Step | 角色 | 操作（Playwright MCP） | 驗證 |
|------|------|----------------------|------|
| M1 | Renter | 租借 Bot → active | rental entity 在 renter device |
| M2 | Owner | browser_navigate → dashboard.html → 嘗試 rename Entity 0 | middleware 擋住：rental entity locked |
| M3 | Owner | browser_evaluate DELETE /api/device/entity/0/permanent | 被拒：cannot delete leased entity |
| M4 | Owner | browser_evaluate PATCH listing 改 rate 500→800 | 允許修改 |
| M5 | Renter | browser_evaluate GET my-contracts | contract rate 仍為 500（snapshot 隔離） |
| M6 | Owner | browser_evaluate POST listing pause | listing 從 marketplace 消失 |
| M7 | Renter | browser_navigate → my-rentals.html → browser_snapshot | contract 仍為 active（不受影響） |
| M8 | Renter | 正常結束合約 | ended_normal |
| M9 | Owner | browser_evaluate POST listing re-publish | 回到 marketplace |

### 劇本 N：申訴三方全流程（Renter↔Owner↔Admin）
> 目的：完整爭議解決，三方角色交錯

| Step | 角色 | 操作（Playwright MCP） | 驗證 |
|------|------|----------------------|------|
| N1 | Renter | 租借 → 提前終止 | ended_early_by_renter |
| N2 | Renter | browser_navigate → my-rentals.html → 點「申訴」→ 選 bot_quality → 填 evidence | dispute filed |
| N3 | Renter | browser_click「申訴」Tab → browser_snapshot | open dispute，SLA 時間顯示 |
| N4 | Owner | browser_navigate → my-rentals.html →「出租中」Tab → browser_snapshot | 合約附帶 dispute badge |
| N5 | Admin | browser_evaluate GET /api/rental/admin/disputes | open dispute 在列表中 |
| N6 | Admin | browser_evaluate POST resolve（補償 50 ecoin） | dispute status=resolved |
| N7 | Renter | browser_navigate → my-rentals.html →「申訴」Tab → browser_snapshot | status=resolved |
| N8 | Renter | browser_navigate → wallet.html → browser_snapshot | dispute_compensation +50 ecoin entry |
| N9 | Renter | 再提一個 dispute（financial） | second dispute filed |
| N10 | Admin | browser_evaluate POST reject | status=rejected |
| N11 | Renter | 「申訴」Tab → browser_snapshot | 兩個 dispute：一個 resolved、一個 rejected |

### 劇本 O：多輪交易信任累積 + Credit Score
> 目的：多次交易後 rating/credit 正確累積

| Step | 角色 | 操作（Playwright MCP） | 驗證 |
|------|------|----------------------|------|
| O1 | — | 第一輪：租借 → 提前終止 → 3★ review | avg_rating = 3.00 |
| O2 | — | 第二輪：租借 → 正常結束 → 5★ review | avg_rating = 4.00 |
| O3 | — | 第三輪：租借 → 正常結束 → 4★ review | avg_rating = 4.00 |
| O4 | Owner | browser_navigate → community.html#rental → browser_snapshot | listing 卡片顯示 ⭐ 4.00 |
| O5 | Renter | browser_evaluate GET /api/rental/credit-score | credit score 計算正確 |
| O6 | Renter | browser_navigate → wallet.html → browser_snapshot | 3 輪 hold/refund/forfeit ledger chain 完整 |
| O7 | Owner | browser_navigate → wallet.html → browser_snapshot | 第一輪 forfeit income (50%×85%) 正確入帳 |

### 劇本 P：共享筆記協作（Note Pages + Mission Notes + Kanban Notes）
> 目的：租借 bot 與 renter 透過筆記系統進行任務交接、知識共享、成果回報

#### P-Part 1：Mission Notes 任務交接

| Step | 角色 | 操作（Playwright MCP） | 驗證 |
|------|------|----------------------|------|
| P1 | Renter | 租借 Bot → active | rental entity 出現在 renter device |
| P2 | Renter | browser_navigate → mission.html → 新增 note「📋 租借 Bot 任務指引」 | note 建立成功 |
| P3 | Renter | 在 note 中寫入工作指示（markdown 格式）| 內容儲存 |
| P4 | Renter | browser_evaluate 用租借 bot 的 botSecret GET /api/mission/notes | ⚠️ 租借 bot 能否讀到 renter 的 mission notes？ |
| P5 | Renter | browser_evaluate 用租借 bot POST /api/mission/note/add（bot 建立回報筆記） | bot 建立「📊 任務進度回報」note |
| P6 | Renter | browser_navigate → mission.html → browser_snapshot | 兩個 note 都可見：指引 + 回報 |
| P7 | Renter | browser_evaluate 用租借 bot POST /api/mission/note/update（更新回報內容） | 內容更新成功 |
| P8 | Renter | browser_navigate → mission.html → browser_snapshot | 回報 note 內容已更新 |

#### P-Part 2：Note Pages 公開知識庫

| Step | 角色 | 操作（Playwright MCP） | 驗證 |
|------|------|----------------------|------|
| P9 | Renter | browser_evaluate 用租借 bot PUT /api/mission/note/page（建立 HTML 頁面：研究報告） | note page 建立成功 |
| P10 | Renter | browser_evaluate PATCH /api/mission/note/page/public（設為公開） | is_public = true |
| P11 | Renter | browser_navigate → /p/{renter_publicCode}/{noteId} | 公開頁面可訪問，內容正確渲染 |
| P12 | Owner | browser_navigate → 同一 /p/ URL | Owner 也能看到（公開頁面不需認證） |
| P13 | Renter | browser_evaluate 租借 bot 在 chat 中發送 `eclaw://note/{noteId}` | 訊息含 note link |
| P14 | Renter | browser_navigate → chat.html → browser_snapshot | chat 中顯示 note preview（iframe 或連結） |
| P15 | Renter | browser_evaluate PATCH public → private | is_public = false |
| P16 | Owner | browser_navigate → 同一 /p/ URL | 頁面不可訪問（private） |

#### P-Part 3：Kanban Card Notes 協作筆記

| Step | 角色 | 操作（Playwright MCP） | 驗證 |
|------|------|----------------------|------|
| P17 | Renter | browser_navigate → kanban.html → 建立 card，assigned 租借 bot | card 建立，bot assigned |
| P18 | Renter | browser_evaluate POST /api/mission/card/{id}/note（renter 寫工作說明） | note 附加到 card |
| P19 | Renter | browser_evaluate 用租借 bot POST /api/mission/card/{id}/note（bot 回報成果） | bot 也能加 note |
| P20 | Renter | browser_navigate → kanban.html → 點開 card → browser_snapshot | card detail 顯示 2 條 note（renter + bot），各自標記來源 |
| P21 | Renter | browser_evaluate 用租借 bot POST /api/mission/card/{id}/comment（bot 在留言板回報） | comment 建立成功 |
| P22 | Renter | browser_snapshot card detail | 留言板 + 筆記區都有內容 |

#### P-Part 4：筆記生命週期 + 合約結束清理

| Step | 角色 | 操作（Playwright MCP） | 驗證 |
|------|------|----------------------|------|
| P23 | Renter | 結束合約 → ended_normal | contract 結束 |
| P24 | Renter | browser_navigate → mission.html → browser_snapshot | 租借 bot 建立的 notes 是否仍存在？（預期：仍存在，屬於 device） |
| P25 | Renter | browser_navigate → kanban.html → 點開 card → browser_snapshot | 租借 bot 的 card notes/comments 是否仍存在？（預期：仍存在） |
| P26 | Renter | browser_evaluate 用過期 botSecret 嘗試 POST note/add | 被拒（entity 已 unbound） |
| P27 | Renter | 公開 note page 是否仍可訪問 /p/ URL？ | ⚠️ publicCode 已失效 → 頁面是否 404？記錄行為 |

### 劇本 Q：跨頁面即時資料一致性
> 目的：wallet → marketplace → my-rentals → kanban → chat → notes → wallet 連續跳轉

| Step | 角色 | 操作（Playwright MCP） | 驗證 |
|------|------|----------------------|------|
| Q1 | Renter | browser_navigate → wallet.html → browser_snapshot | 記錄 balance = X |
| Q2 | Renter | browser_navigate → community.html#rental → 租借 Bot | contract active |
| Q3 | Renter | browser_navigate → wallet.html → browser_snapshot | balance = X - deposit, held > 0 |
| Q4 | Renter | browser_navigate → my-rentals.html → browser_snapshot | active contract 顯示 |
| Q5 | Renter | browser_navigate → kanban.html → 建立 card 指派租借 bot | card 建立 |
| Q6 | Renter | browser_navigate → mission.html → 確認租借 bot 建的 note 可見 | notes 正常 |
| Q7 | Renter | browser_navigate → chat.html → 選租借 bot → 發訊息 | 聊天正常 |
| Q8 | Renter | browser_navigate → settings.html → 點「My Rentals」 | 跳轉回 my-rentals.html |
| Q9 | Renter | 結束合約 | ended_normal |
| Q10 | Renter | browser_navigate → wallet.html → browser_snapshot | balance = X, held = 0 |
| Q11 | Renter | browser_navigate → mission.html → browser_snapshot | 租借 bot 的 notes 仍存在 |
| Q12 | — | 對比 Q1 和 Q10 snapshot | balance 完全一致（閉環驗證） |

### 劇本 R：邊界值 + 異常輸入
> 目的：API + UI 層面的邊界測試

| Step | 角色 | 操作（Playwright MCP） | 驗證 |
|------|------|----------------------|------|
| R1 | Renter | duration = min - 1 (29min) | duration_below_listing_min |
| R2 | Renter | duration = max + 1 (10081min) | duration_above_listing_max |
| R3 | Renter | duration = 0 | validation error |
| R4 | Renter | duration = -1 | validation error |
| R5 | Renter | duration = min (30min) → 成功 | 最短合約 |
| R6 | Renter | duration = max (10080min) → 成功 | 最長合約（7 天） |
| R7 | Renter | review rating = 0 | 被拒 |
| R8 | Renter | review rating = 6 | 被拒 |
| R9 | Renter | review comment > 1000 字 | 被拒或截斷 |
| R10 | Renter | dispute type = invalid_type | 被拒 |
| R11 | Owner | 自租自己的 listing | self_rental_forbidden |
| R12 | Renter | 48h 後提交 review | review_window_expired |
| R13 | Renter | 同合約重複提交 review | duplicate_review |

### 劇本 S：Console Error + i18n + 無障礙基線
> 目的：所有租借相關頁面品質驗證

| Step | 頁面 | 操作（Playwright MCP） | 驗證 |
|------|------|----------------------|------|
| S1 | community.html#rental | browser_navigate → browser_console_messages(error) | 0 errors |
| S2 | my-rentals.html | 切換 3 個 Tab → browser_console_messages(error) | 0 errors |
| S3 | wallet.html | browser_navigate → browser_console_messages(error) | 0 errors |
| S4 | kanban.html | browser_navigate → browser_console_messages(error) | 0 errors |
| S5 | chat.html（租借 bot） | browser_navigate → browser_console_messages(error) | 0 errors |
| S6 | env-vars.html | browser_navigate → browser_console_messages(error) | 0 errors |
| S7 | files.html | browser_navigate → browser_console_messages(error) | 0 errors |
| S8 | mission.html（notes） | browser_navigate → browser_console_messages(error) | 0 errors |
| S9 | /p/:code/:noteId | browser_navigate → browser_console_messages(error) | 0 errors |
| S10 | 全部頁面 | 切換語言 EN → browser_snapshot | 無裸 i18n key |
| S11 | 全部頁面 | 切換語言 JA → browser_snapshot | 日文翻譯完整 |
| S12 | my-rentals.html | 空狀態 | 友善空提示，非 error |
| S13 | wallet.html | 空狀態 | 友善空提示 |

### 劇本 T：Entity Handover 生命週期
> 目的：驗證租借 bot 在 renter device 上的 slot 管理

| Step | 角色 | 操作（Playwright MCP） | 驗證 |
|------|------|----------------------|------|
| T1 | Renter | browser_navigate → dashboard.html → browser_snapshot（記錄 entity count） | N 個 entities |
| T2 | Renter | 租借 Bot → active | contract created |
| T3 | Renter | browser_navigate → dashboard.html → browser_snapshot | N+1 個 entities，新 slot = 租借 bot |
| T4 | Renter | browser_snapshot 租借 bot 卡片 | name = listing title, message 含 "Rented from marketplace" |
| T5 | Owner | browser_navigate → dashboard.html → browser_snapshot | Entity 0 標記 leased_out |
| T6 | Renter | 結束合約 | ended_normal |
| T7 | Renter | browser_navigate → dashboard.html → browser_snapshot | 租借 slot 消失或 unbound |
| T8 | Owner | browser_navigate → dashboard.html → browser_snapshot | Entity 0 不再標記 leased_out |

### 劇本 U：Rate Limiting + Gatekeeper 安全邊界
> 目的：驗證租借 bot 的安全護欄

| Step | 角色 | 操作（Playwright MCP） | 驗證 |
|------|------|----------------------|------|
| U1 | Renter | 租借 Bot → active | active |
| U2 | Renter | browser_evaluate 連續 31 次 POST /api/transform | 第 31 次被 rate limit 擋住（30 req/min） |
| U3 | Renter | browser_evaluate 租借 bot transform 含 "my botSecret is XXX" | Gatekeeper 檢測行為 |
| U4 | Renter | browser_evaluate 租借 bot transform 含 "fetch('https://evil.com')" | Gatekeeper 是否攔截 |
| U5 | Renter | browser_evaluate 租借 bot 嘗試 speakTo 被 block 的 entity | blocked error |
| U6 | Renter | browser_evaluate 超大 message（>10000 字） | size limit 或 truncation |

---

## 邊緣案例驗證（非正常路徑）

> 新增日期：2026-04-14
> 目的：覆蓋使用者不按正常順序操作、重複操作、併發操作等真實場景
> 來源：使用者回報「面試前上架 → 面試後仍看不到 listing」bug

---

### 劇本 V：操作順序錯亂

#### V1：面試前上架（使用者回報的 bug）

| Step | 角色 | 操作 | 預期結果 |
|------|------|------|---------|
| V1-1 | Owner | 建立 Listing | status=draft, interview_passed=false |
| V1-2 | Owner | 直接 POST `/listing/:id/publish` | ❌ 400 `interview_not_passed` |
| V1-3 | Owner | GET listing 確認狀態 | status 仍為 draft（不能被改成 listed） |
| V1-4 | Owner | 跑面試 → 通過 | interview_passed=true, status=draft |
| V1-5 | Owner | 再次 POST publish | ✅ status=listed |
| V1-6 | Renter | Marketplace 搜尋 | listing 可見 |

#### V2：面試進行中上架（Race Condition）

| Step | 角色 | 操作 | 預期結果 |
|------|------|------|---------|
| V2-1 | Owner | 建立 Listing → 開始面試 | status=interview |
| V2-2 | Owner | 面試未完成，另一個 tab 按上架 | ❌ `interview_not_passed`（面試中 passed 仍為 false） |
| V2-3 | — | 面試完成（通過） | status 回到 draft, interview_passed=true |
| V2-4 | Owner | 上架 | ✅ status=listed |

**⚠️ 潛在 bug**：如果面試完成時把 status 覆蓋為 draft（rental.js 第 1701 行），但 V2-2 已把 status 改為 listed，則面試完成會「降級」回 draft。

#### V3：上架後重新面試

| Step | 角色 | 操作 | 預期結果 |
|------|------|------|---------|
| V3-1 | Owner | 建立 → 面試通過 → 上架 | status=listed |
| V3-2 | Owner | 重新跑面試 | status 變 interview |
| V3-3 | Renter | Marketplace 搜尋 | ⚠️ listing 消失（status 不是 listed） |
| V3-4 | — | 面試完成 | status 回到 draft（不是 listed！） |
| V3-5 | Renter | Marketplace 搜尋 | ❌ listing 仍不可見 — 必須手動重新上架 |
| V3-6 | Owner | 重新上架 | ✅ status=listed |

**⚠️ 已知問題**：面試後 status 一律回 draft，不恢復面試前狀態。

#### V4：Draft 狀態被直接租借

| Step | 角色 | 操作 | 預期結果 |
|------|------|------|---------|
| V4-1 | Owner | 建立 Listing（draft） | status=draft |
| V4-2 | Renter | 用 listing ID 直接 POST `/rental/contract` | ❌ `listing_not_available` |
| V4-3 | — | 確認無合約/金流被建立 | contract count=0, wallet 無變動 |

#### V5：Delist 後嘗試重新上架

| Step | 角色 | 操作 | 預期結果 |
|------|------|------|---------|
| V5-1 | Owner | 建立 → 面試 → 上架 → 下架（delist） | status=delisted |
| V5-2 | Owner | POST publish | ⚠️ **Bug**：目前會成功（SQL 無 status guard），應該失敗 |
| V5-3 | — | 預期修復後 | ❌ `listing_permanently_delisted` |

**⚠️ 已知問題**：`publishListing()` 缺少 `AND status IN ('draft','paused')` 條件。

#### V6：有 Active Contract 時重新面試

| Step | 角色 | 操作 | 預期結果 |
|------|------|------|---------|
| V6-1 | — | Listing 已上架，有 active contract | status=listed |
| V6-2 | Owner | 開始重新面試 | ⚠️ status 變 interview，但合約仍 active |
| V6-3 | Renter | Marketplace 搜尋 | listing 消失（status=interview） |
| V6-4 | — | 面試完成 | status=draft，合約仍 active 但 listing 下線 |

**⚠️ 已知問題**：面試前未檢查 active contract。

---

### 劇本 W：重複操作

| Step | 操作 | 預期結果 |
|------|------|---------|
| W1 | 連續兩次 POST publish（同一 listing） | 第二次應回傳 `already_listed` 或冪等成功 |
| W2 | 合約結束後再次 POST end-rental | ❌ `contract_already_ended`（第 562 行已實作） |
| W3 | 同合約重複提交 review | ❌ `review_already_exists`（trust.js 第 111 行已實作） |
| W4 | 同合約同 type 重複提交 dispute | ⚠️ 目前無檢查，可重複建立 |
| W5 | Listing 已有 active contract，再次租借 | ❌ `listing_already_rented`（第 462 行已實作） |

---

### 劇本 X：快取過期 / 併發衝突

#### X1：瀏覽器快取舊 rate

| Step | 角色 | 操作 | 預期結果 |
|------|------|------|---------|
| X1-1 | Renter | 打開 Marketplace，看到 rate=500 | UI 顯示 500 |
| X1-2 | Owner | 另一 tab 改 rate 為 800 | PATCH 成功 |
| X1-3 | Renter | 不刷新頁面，直接點「租借」 | ✅ 合約 rate snapshot=800（DB 最新值，非 UI 快取值） |

**驗證重點**：`startRental()` 用 `FOR UPDATE` 從 DB 讀最新值，不信任前端。

#### X2：Owner 改 rate 同時 Renter 租借

| Step | 操作 | 預期結果 |
|------|------|---------|
| X2-1 | `Promise.all([ PATCH rate, POST contract ])` | `FOR UPDATE` 序列化，兩者不會同時執行 |
| X2-2 | 驗證 | 合約 rate 為其中一個一致的值，無資料不一致 |

#### X3：面試完成後 UI 未自動刷新

| Step | 角色 | 操作（Playwright） | 預期結果 |
|------|------|-------------------|---------|
| X3-1 | Owner | 在 A tab 開始面試 | status=interview |
| X3-2 | — | 面試完成（通過） | API 回傳 passed=true |
| X3-3 | Owner | 回到 B tab（listing 管理頁） | ⚠️ UI 是否自動刷新？「上架」按鈕是否出現？ |
| X3-4 | Owner | 按「上架」 | 如果 UI 沒刷新，按鈕可能 disabled 或不可見 |

---

### 劇本 Y：邊界時序

#### Y1：合約到期瞬間手動結束

| Step | 操作 | 預期結果 |
|------|------|---------|
| Y1-1 | 租借 30 分鐘（最短） | ends_at = now + 30min |
| Y1-2 | 在 ends_at 前 1 秒呼叫 end-rental（ended_early） | ✅ 50% forfeit |
| Y1-3 | Cron 同一秒也觸發自動結束 | ⚠️ 不能 double refund/forfeit — 需 `FOR UPDATE` 保護 |

#### Y2：Cooldown 邊界值

| Step | 操作 | 預期結果 |
|------|------|---------|
| Y2-1 | 租借 → 提前終止 | cooldown_until = now + 24h |
| Y2-2 | 23h59m 後嘗試租借 | ❌ `cooldown_active` |
| Y2-3 | 24h01m 後嘗試租借 | ✅ 成功 |

#### Y3：面試次數限制（3 次 / 7 天）

| Step | 操作 | 預期結果 |
|------|------|---------|
| Y3-1 | 跑 3 次面試（全失敗） | 每次記錄到 bot_interviews |
| Y3-2 | 第 4 次面試 | ❌ `interview_rate_limited` |
| Y3-3 | 7 天後再試 | ✅ 成功 |

#### Y4：Suspended 合約結束

| Step | 操作 | 預期結果 |
|------|------|---------|
| Y4-1 | 租借，餘額逐漸消耗至 0 | status=suspended_insufficient_funds |
| Y4-2 | Suspended 狀態下呼叫 end-rental | ✅ 成功（第 561 行允許） |
| Y4-3 | 驗證 deposit refund | actualHeldMli 可能 < 原始 deposit（已被 chargeUsage 扣過） |

---

### 劇本 Z：權限違規

| Step | 角色 | 操作 | 預期結果 |
|------|------|------|---------|
| Z1 | Renter | POST publish（Owner 的 listing） | ❌ `listing_forbidden` |
| Z2 | Owner B | POST end-rental（Owner A 的合約） | ❌ `contract_end_forbidden` |
| Z3 | Renter | PATCH listing 改 rate | ❌ `listing_not_found_or_forbidden` |
| Z4 | Owner | POST contract（租自己的 listing） | ❌ `self_rental_forbidden` |
| Z5-1 | 未登入 | POST publish | ❌ 401 `unauthenticated` |
| Z5-2 | 未登入 | POST contract | ❌ 401 |
| Z5-3 | 未登入 | GET marketplace | ✅ 公開（無需認證） |

---

### 劇本 AA：資料不一致恢復

#### AA1：孤兒合約（listing 被刪但合約仍 active）

| Step | 操作 | 預期結果 |
|------|------|---------|
| AA1-1 | DB 直接刪 listing，但 active contract 仍在 | 資料不一致 |
| AA1-2 | Renter GET my-contracts | ✅ 合約仍顯示，listing_title=NULL（LEFT JOIN） |
| AA1-3 | Renter 結束合約 | ✅ 成功（endRental 不依賴 listing） |

#### AA2：伺服器重啟時面試進行中

| Step | 操作 | 預期結果 |
|------|------|---------|
| AA2-1 | Listing status=interview 時 server crash | — |
| AA2-2 | Server 重啟 → initRentalDatabase | status 重設為 draft（第 150 行） |
| AA2-3 | Owner 回到頁面 | status=draft，可重新面試 |

#### AA3：Rental entity 在重啟後消失

| Step | 操作 | 預期結果 |
|------|------|---------|
| AA3-1 | Active contract，但 renter device 無 rental entity | entity 遺失 |
| AA3-2 | Server 重啟 → reconcileRentalEntities Phase 4 | entity 自動恢復 |
| AA3-3 | Renter dashboard | rental entity 重新出現，可正常使用 |

#### AA4：Duplicate listing 防護

| Step | 角色 | 操作 | 預期結果 |
|------|------|------|---------|
| AA4-1 | Owner | 建立 Listing（entity 0, draft） | ✅ 成功 |
| AA4-2 | Owner | 再建一個（同一 entity 0） | ❌ `duplicate_listing`，附帶 existing_listing_id |
| AA4-3 | Owner | Delist 第一個 listing | status=delisted |
| AA4-4 | Owner | 再建一個（同一 entity 0） | ✅ 成功（delisted 不算 active） |

---

### 劇本 BB：UI / API 狀態不同步

#### BB1：面試完成後 UI 自動刷新

| Step | 角色 | 操作（Playwright） | 預期結果 |
|------|------|-------------------|---------|
| BB1-1 | Owner | 建立 Listing | UI 顯示 draft |
| BB1-2 | Owner | 按「面試」 | UI 顯示 interview in progress |
| BB1-3 | — | 面試完成（通過） | API 回傳 passed=true |
| BB1-4 | Owner | **不刷新頁面** | UI 應自動更新，「上架」按鈕出現 |
| BB1-5 | Owner | 按「上架」 | ✅ 成功 |

#### BB2：面試失敗後的 UI 回饋

| Step | 角色 | 操作（Playwright） | 預期結果 |
|------|------|-------------------|---------|
| BB2-1 | Owner | 面試失敗（score < 60%） | API 回傳 passed=false |
| BB2-2 | Owner | 檢查 UI | 應顯示「面試未通過」+ 分數 + 「重試」按鈕 |
| BB2-3 | Owner | 「上架」按鈕狀態 | disabled 或不可見 |

#### BB3：publish 錯誤碼的完整覆蓋

| 情境 | 錯誤碼 |
|------|--------|
| listing 不存在 | `listing_not_found` |
| 不是 owner | `listing_forbidden` |
| 未面試或面試未通過 | `interview_not_passed` |
| 已上架（重複操作） | `already_listed` 或冪等成功 |
| 已永久下架 | `listing_permanently_delisted` |
| 其他 DB 錯誤 | `publish_failed` |

---

### 已發現的代碼問題（需修復）

| # | 問題 | 嚴重度 | 影響場景 | 修復方式 |
|---|------|--------|---------|---------|
| 1 | `publishListing()` 缺 status guard — delisted 可復活 | **P1** | V5 | SQL 加 `AND status IN ('draft','paused')` |
| 2 | 面試完成後 status 一律回 draft — 不恢復面試前狀態 | **P2** | V3, V6 | 面試前記錄原始 status，完成後恢復 |
| 3 | 面試前無 active contract 檢查 | **P2** | V6 | startInterview 加 active contract guard |
| 4 | review 48h 窗口未實作 | P3 | C5, Y | submitReview 加時間檢查 |
| 5 | openDispute 無重複 type 檢查 | P3 | W4 | 加 unique constraint on (contract_id, type) |

---

## 場景統計

| 類別 | 劇本 | 場景數 | 重點 |
|------|------|--------|------|
| 初階 | A–E | 5 劇本 ~45 步 | 基礎交錯流程、金流、防護 |
| 進階 | F–U | 16 劇本 ~180 步 | 多 Agent 協作、A2A、Vault、Kanban、Notes、計費 |
| 邊緣案例 | V–BB | 7 劇本 ~60 步 | 非正常路徑、重複操作、併發、權限、資料恢復 |
| **合計** | **A–BB** | **28 劇本 ~285 步** | |

## 執行注意事項

1. **帳號切換**：透過 `browser_evaluate → fetch('/api/auth/device-login', ...)` 切換 Owner/Renter session
2. **截圖存檔**：每個劇本關鍵步驟用 `browser_take_screenshot` 留存證據（命名：`e2e-{劇本}-{step}.png`）
3. **Console 監控**：每頁操作後呼叫 `browser_console_messages(level='error')` 確認無 JS 錯誤
4. **Snapshot 比對**：用 `browser_snapshot` 驗證 DOM 結構，而非依賴截圖 OCR
5. **清理**：測試結束後 delist 測試 listing，避免污染 production marketplace
6. **安全記錄**：劇本 I（Vault）和 T（Gatekeeper）的結果無論 pass/fail 都要記錄，作為 security gap 追蹤基準
7. **Token 計費**：劇本 K 需記錄精確的 token 數與費用，對照 `chars ÷ 4 × rate ÷ 1000` 公式
8. **併發測試**：劇本 L 使用 `Promise.all` 模擬同時 POST，需記錄兩個 response 的時間差
