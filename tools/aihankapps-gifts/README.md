# 節日禮包自動化

一份活動檔同時決定三件事：遊戲內信箱的發放、作品集（<https://eclawbot.com/AiHankApps/>）的禮包公告、對外宣傳文案。節日到了由每日排程照本文件執行，不需要人工核准（規則見 [POLICY.md](POLICY.md)）。

## 範圍

- **遊戲**：`games.json` 裡 `enabled: true` 的遊戲，目前是《REBOUND：元素戰機》與《活字戰紀：雙城烽火》。只列已公開上架、而且伺服器有信箱可以遠端發禮的遊戲；未發佈或沒有收禮管道的遊戲不列入。
- **節日**：`calendar.json` 的 `occurrences`。農曆節日的國曆日期是事先查好寫進去的，程式不推算。
- **獎勵**：每款遊戲在 `games.json` 的 `tiers` 定義 `standard` 與 `major` 兩個等級，活動只會使用這兩組內容。

## 檔案

| 檔案 | 用途 |
|---|---|
| `calendar.json` | 節日、日期、開始時刻（台北 10:00）、公告提前天數（14）、寄送期天數（7）、同一款遊戲兩檔活動的最短間隔（21 天） |
| `games.json` | 參與遊戲、獎勵項目與上限、兩個獎勵等級、發放介面 |
| `campaigns/<id>.json` | 一檔活動的全部內容：時間、每款遊戲的獎勵、遊戲內信件、五種語言的公告文案、核准紀錄、寄送回條。核准後除了回條不可再改 |
| `promo/<id>.md` | 產生出來的對外宣傳文案：五種語言的社群貼文、itch.io devlog、遊戲內信件 |
| `backend/public/AiHankApps/gift-campaigns.js` | 產生出來的作品集資料檔，由 `gift-sidebar.js` 顯示。不要手改 |
| `HOLD` | 這個檔案存在時，停止起草、核准與發放。內容寫原因 |

## 一檔活動的時間軸

以開始時刻 T（節日當天台北 10:00）為準：

| 時間 | 發生什麼 |
|---|---|
| T − 14 天 | 起草活動檔並自動核准，開「公告」PR。合併後作品集出現「即將開始」與倒數，宣傳文案同時產生 |
| T | 第一次寄送：當下所有帳號各一封。核對後開「回條」PR，作品集顯示已寄出幾封 |
| T + 1 天 到 T + 6 天 | 每天用同一把鍵再寄一次，只有這段期間新加入的帳號會收到 |
| T + 7 天之後的第一次執行 | 最後補寄一次，開「最終回條」PR |
| T + 1 個日曆月（台北時間） | 領取截止，伺服器拒絕領取；作品集的公告自動收起，改列在「過去的活動」 |

領取期限固定是一個台北日曆月，因為 REBOUND 伺服器對限期活動信就是這樣計算，兩邊必須一致。

## 每日流程

排程任務每天執行一次。指令都在已同步到 `origin/main` 的工作副本根目錄執行。

```bash
node tools/aihankapps-gifts/cli.js tick
```

依輸出處理：

| 輸出 | 動作 |
|---|---|
| `nothing due` | 結束，一行回報 |
| `HOLD: …` | 什麼都不做，回報原因 |
| `due: draft <id>`、`due: review_draft <id>` | 執行「公告」 |
| `due: deliver <id> <game> (record first\|final)` | 執行「寄送」，帶上括號裡的 `--record` 值 |
| `due: redeliver <id> <game>` | 只跑 `deliver … --commit`，不記錄、不開 PR |
| `due: finalize <id> <game> (record final)` | 執行「寄送」，`--record final` |
| `warning: calendar_needs_extension` | 查官方行事曆，補下一年度的 `occurrences`，開 PR |
| `warning: missed_occurrence <id>` | 公告期已經錯過，不補發；回報 Hank |
| `warning: game_disabled …` | 該遊戲被停用，略過並回報 |

### 公告

公告一旦上線就是對玩家的承諾，所以先確認兩週後寄得出去。在暫存資料夾起草一份，對活動裡的每款遊戲跑一次只讀的連線檢查；這一步不會動到工作副本：

```bash
node tools/aihankapps-gifts/cli.js draft --campaign-dir /tmp/gift-check/campaigns
node tools/aihankapps-gifts/cli.js status <id> <game> --campaign-dir /tmp/gift-check/campaigns
```

每款遊戲的 `issues` 都是空的、`audience` 有數字、`mails` 是 0 才算通過。任何一款沒過就到此為止，把輸出回報給 Hank；隔天排程會再檢查一次。

通過後才正式起草：

```bash
node tools/aihankapps-gifts/cli.js draft
node tools/aihankapps-gifts/cli.js build
node tools/aihankapps-gifts/cli.js validate
```

`draft` 的輸出裡 `approved: true` 才往下做。`approved: false` 時 `failed` 會列出沒過的檢查：不要為了讓它通過去改 `games.json`、`calendar.json` 或核准規則。把剛寫出、還沒進版控的 `campaigns/<id>.json` 刪掉讓工作副本保持乾淨，然後把 `failed` 回報給 Hank；隔天排程會重新起草、重新判斷。

核准後開 PR（活動檔、`gift-campaigns.js`、`index.html` 的版本參數、`promo/<id>.md`），照 EClaw 的規定走：PR CI 全綠 → 貼 `docs/code-review-checklist.md` 的自我審查留言 → squash merge → 確認 main 的 CI → 等 Railway 部署 → 開 <https://eclawbot.com/AiHankApps/> 確認公告出現。最後把 `promo/<id>.md` 交給 Hank。

### 寄送

```bash
node tools/aihankapps-gifts/cli.js status  <id> <game>
node tools/aihankapps-gifts/cli.js deliver <id> <game> --commit --record first
```

先跑 `status`：`issues` 必須是空的，`audience`（會收到的帳號數）要合理。再跑 `deliver`。輸出的 `issues` 只要不是空的就停下來，不重試、不記錄回條，把輸出回報給 Hank。

`--record first` 或 `--record final` 成功時會把回條（寄出封數、核對時間）寫進活動檔。接著：

```bash
node tools/aihankapps-gifts/cli.js build
node tools/aihankapps-gifts/cli.js validate
```

然後開「回條」PR，流程同上。同一天兩款遊戲的回條放在同一個 PR。

## 發放怎麼進到遊戲

`deliver` 與 `status` 用 `railway ssh` 進到遊戲自己的容器，在裡面呼叫遊戲自己的發信程式，用的是容器裡原本就有的資料庫連線。本工具不讀取、不保存任何遊戲的密鑰或資料庫網址，只收回一行結果。

| 遊戲 | 呼叫的程式 | 防重複 | 期限 |
|---|---|---|---|
| REBOUND：元素戰機 | `server/src/admin.mjs` 的 `dispatchOperationalMail`，`kind: limited_campaign`、`all_players` | 每位玩家每把鍵一封（`ops:<鍵>`） | 伺服器依開始時刻算一個台北日曆月，過期拒領 |
| 活字戰紀：雙城烽火 | `/app/mailbox.js` 的 `PostgresMailbox.deliver`，`product: dual-city`、`allAccounts` | 每個帳號每把鍵一封；同鍵內容不同會被拒絕 | `expiresAt` 等於活動檔的領取截止，過期拒領 |

兩款遊戲的腳本都會先比對容器裡發信程式的雜湊與 `games.json` 的 `toolSha256` 是否相同（REBOUND 是 `src/admin.mjs`、`src/campaign-deadline.mjs`，雙城烽火是 `mailbox.js`、`send-mail.js`），`status` 與 `deliver` 都會檢查。不同就停（`deployed_mail_tool_changed`），不連資料庫也不寄送：代表遊戲的發信程式改過，要先重讀它的規則、對本機副本重新演練、更新 `lib/adapters/` 裡對應的介面與雜湊，再發放。

雙城烽火的收件帳號是玩家第一次打開遊戲內信箱（或外觀頁）時才建立的，沒開過的玩家寄送當下不在名單裡。所以公告會提醒雙城的玩家先打開一次信箱（`games.json` 的 `receiveNotes`）；活動期間才打開的，由每天的補寄送到。REBOUND 的帳號在第一次進遊戲時就建立，不需要這個提醒。

寄送後的核對由工具自己做：每個帳號恰好一封、信上的期限等於公告的期限、REBOUND 當下所有玩家都有信。任何一項不符就列在 `issues`。

## 停止、取消

- **全部暫停**：在本資料夾建立 `HOLD` 檔（內容寫原因）並合併到 main。移除後恢復。
- **取消一檔還沒開始的活動**：把活動檔的 `status` 改成 `cancelled`，`build` 後開 PR。公告與宣傳文案會消失，之後也不會寄送。
- **已經寄出的信**：本工具沒有收回功能。需要時由該遊戲的專案處理。

## 預覽與演練

用自訂資料夾放樣本活動，不會動到正式的活動檔與作品集檔案：

```bash
node tools/aihankapps-gifts/cli.js draft --now 2026-12-11T02:30:00Z --campaign-dir /tmp/gifts/campaigns
node tools/aihankapps-gifts/cli.js build --campaign-dir /tmp/gifts/campaigns --public-dir /tmp/gifts/site --promo-dir /tmp/gifts/promo
```

`--public-dir` 要先放一份 `index.html`。

發放可以對本機的遊戲伺服器副本演練（本機 Postgres 套用遊戲的 schema）：

```bash
GIFT_APP_DIR=<遊戲伺服器原始碼資料夾> DATABASE_URL=postgres://localhost/<演練資料庫> \
  node tools/aihankapps-gifts/cli.js deliver <id> <game> --commit --target local --campaign-dir <樣本資料夾>
```

雙城烽火另有測試環境，可以只讀地檢查連線與雜湊：`cli.js status <id> typeforge-twin-cities --target test`。

測試：`cd backend && npx jest --testPathPattern='tests/jest/(aihankapps-gifts|portfolio-gift-sidebar)\.test\.js$'`。樣式要寫到檔名：只寫 `aihankapps-gifts` 的話，資料夾名稱含這幾個字的工作副本會跑整套測試。工作副本在 `.worktrees/` 底下時再加 `--testPathIgnorePatterns='/node_modules/'`。

## 新增遊戲、節日或下一年度

- **遊戲**：在 `games.json` 加一筆（名稱、獎勵項目與上限、兩個等級、發放介面；玩家要先做什麼才收得到信，寫在 `receiveNotes`），並在 `lib/adapters/` 寫一個介面（`payload`／`problems`／`script`／`interpret`）。先對本機副本演練過再啟用。
- **節日**：在 `calendar.json` 的 `holidays` 加名稱與等級，在 `occurrences` 加日期。同一款遊戲的兩檔活動至少隔 21 天。
- **下一年度**：每年補 `occurrences`。農曆節日以行政院人事行政總處公布的行事曆為準。
