# AiHankApps 管理中樞 collector

Reads daily counts from the back-ends that keep their own databases (the game servers and Wishlist) and imports them
into the admin hub at `https://eclawbot.com/AiHankApps/hub/`. See `backend/AIHANKAPPS_HUB.md` for what the hub shows.

```
node tools/aihankapps-hub/collect.js                   # read every back-end, show what would be sent, send nothing
node tools/aihankapps-hub/collect.js --commit          # read, then import into the hub
node tools/aihankapps-hub/collect.js --only rebound    # one back-end: rebound, summit, wishlist, wishlist-users, railway, timehut, attention, claude-usage
```

## How it works

1. For each entry in `backends.js`, a small script runs inside that back-end's own container over `railway ssh`
   (the same channel as `tools/aihankapps-gifts`). It uses the container's own database connection, asks only
   `SELECT` questions, each in its own read-only transaction with a 20 s limit, and prints one `GIFT_RESULT` line of
   daily counts and totals. No row, account, device or message content leaves the container.
2. `collect.js` checks the result (`toEnvelope`): only that back-end's apps, only metrics the hub knows, nothing after
   the collection day, at most 60 KB.
3. With `--commit`, it runs `backend/scripts/aihankapps-hub-import.js` inside the EClaw container, which stores the
   envelope in the hub's own `aihankapps_hub_*` tables in one transaction.

The operator's Railway login is the only credential involved. The tool never reads a connection string or a database
secret, and the numbers are printed only as counts of series ("plays(2026-10-20…21 天)"), not values.

The `railway` source is the exception to "inside each container": it runs on this Mac (`railway-metrics.js`). It runs
`railway whoami` to refresh the CLI login, then uses that session token, in memory only, for read-only queries to
Railway's metrics API: per production service, data received and sent (uploads/downloads), CPU, memory, volume space
and the latest deployment status. The envelope carries them as `infra` rows plus daily `netInMb` / `netOutMb` series.

| id | Railway project / service | Apps | Reads |
|---|---|---|---|
| `rebound` | rebound-live / rebound-api | REBOUND | players, runs, purchases (Google purchased, Apple non-sandbox), mailbox, weekly retention |
| `summit` | noble-fascination / summit-battle-api | 雙城烽火, 巔峰之戰 | leaderboard players and scores, battles, accounts and recent sign-ins, cosmetic purchases (not tests), mailbox, retention |
| `wishlist` | thorough-presence / wishlist-app | Wishlist.ai | accounts, messages, listings, completed TWD purchases, conversations, retention |
| `wishlist-users` | thorough-presence / wishlist-app | Wishlist.ai | one fact per account for the Weesh page's 帳戶智慧數據庫: counts and times, the display name and a masked sign-in address (see `backend/AIHANKAPPS_HUB.md`) |
| `railway` | every project above, plus EClaw and 時光相簿 (metrics API, no ssh) | every app with a Railway service | traffic in/out, CPU, memory, volume space, latest deployment |
| `timehut` | Timehut / Timehunt (HTTPS, no ssh) | 時光相簿 | account counts only: total (not deleted), new in 7 / 30 days, deleted |

The `timehut` source also runs on this Mac. 時光相簿 keeps its accounts in its server's own files, so the server answers
the counts itself at `GET /api/internal/account-stats` (backend 1.0.114+), only to `Authorization: Bearer <key>`. The
key is the Railway variable `TIMEHUT_STATS_KEY` on the Timehut service and, on this Mac, the file
`~/.config/aihankapps-hub/timehut-stats-key` (mode 600; the collector refuses a file others can read). It is never in
git, never printed and never sent to the EClaw server; only the four counts are imported.

## Running it on a schedule

Nothing here schedules it. On Hank's Mac a LaunchAgent runs the whole collector daily and the `railway` source hourly
(see the hub memory notes). The hub warns when a source has not been imported for 36 hours. Runs need the operator's
Railway login on the machine that runs them.

## Tests

`backend/tests/jest/aihankapps-hub-store.test.js` runs each back-end script against a stand-in database and checks
that every question is a read-only `SELECT` and that only counts come back.

## 上架警示板（`attention`，2026-11-12）

Wishlist 的上架排程在這台 Mac 上維護一份「自己解不了的問題」清單，它們的工具把摘要寫到 `~/.local/share/aihankapps-hub/attention-summary.json`。`--only attention` 只把這份摘要送進中樞：需要人處理的每一項在警示頁變成一則嚴重警示（需要人為介入），排程還在自己處理的不顯示。摘要檔不存在時這個來源回報讀取失敗，其他來源不受影響。

要看中樞目前有哪些警示（給排程自動處理用），在 EClaw 容器裡跑 `node backend/scripts/aihankapps-hub-alerts.js --brief`（經 `railway ssh`，唯讀）。

## Claude 用量（`--only claude-usage`，2026-11-13）

中樞右上角的電池是 Claude 訂閱方案的每週用量還剩多少。這個來源在這台 Mac 上執行 `claude -p "/usage" --output-format json`：那是 CLI 的本機指令，不呼叫模型（回答裡 `num_turns` 是 0、token 是 0；只要不是，這次讀數就不採用），所以不耗 token。只匯入百分比與重置時間。每小時那個 LaunchAgent 的 `--only` 清單要包含 `claude-usage`；找不到 `claude` 時可用環境變數 `CLAUDE_BIN` 指定路徑。

## 警示處理排程（`triage.js`，2026-11-13）

Hank：「確保排程可以自主處理判斷所有的警示問題 如果需要人為介入就讓排程發一個警示把詳情打上去 讓我看到需要我怎麼幫忙」。

- `triage.js`：排程唯一能用的工具（`pending`、`show`、`note`、`raise`、`resolve`、`notes`、`acks`、`kick`、`pull`），每個子命令都經由 `railway ssh` 呼叫 EClaw 容器裡的 `backend/scripts/aihankapps-hub-alerts.js`／`aihankapps-hub-note.js`／`aihankapps-hub-import.js`。`pull` 用中樞金鑰檔（同 `timehut` 來源）讀拾光的 `GET /api/internal/feedback`（後端 1.0.119 起），App 與 LINE 的回報各自匯入。
- 確認與對策（2026-11-13）：Hank 在中樞按「確認」、在旁邊寫的對策，排程都讀得到。每則待處理警示帶 `ack`（有沒有確認、對策文字）；還沒回覆的對策以 `reason: "plan"` 排在 `pending` 最前面，警示已解除的也一樣；`acks` 列出近期全部。排程寫了 note 之後才算回覆過。
- `TRIAGE.md`：排程的判斷規則（每一類警示怎麼判斷、怎麼寫 note／ask）。要調整排程的行為就改這份，合併到 main 後下一輪自動生效。
- `triage-runner.zsh`：裝成 `~/.local/bin/aihankapps-hub-triage`，由 `~/Library/LaunchAgents/tw.aihankapps.hub-triage.plist` 每 15 分鐘執行一次。沒有待處理的警示就不叫模型（不耗 token）。日誌在 `~/Library/Logs/aihankapps-hub-triage/`。
- 停用：`launchctl bootout gui/$(id -u)/tw.aihankapps.hub-triage`。立刻跑一次：`launchctl kickstart gui/$(id -u)/tw.aihankapps.hub-triage`。

