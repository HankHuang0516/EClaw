# AiHankApps 管理中樞 (admin hub)

`/AiHankApps/hub/` is the back-office overview for the app portfolio: every app's numbers in one place, for signed-in EClaw administrators only. Requested by Hank on 2026-11-10 ("只有登入eclaw管理者才能看到的額外頁面 / 所有作品後台的管理中樞 / 監控後台每一款APP所有數據"); the mock-up he approved is not in this repository.

## Access boundary

- The page (HTML, scripts, styles) and `GET /api/aihankapps/hub/data` pass through the existing `authModule.authMiddleware` and `authModule.adminMiddleware` (`user_accounts.is_admin`), unchanged. No account, role or credential is added.
- `/AiHankApps/hub` is reserved in `index.js` before anonymous pageview tracking and the public static mount, like `/AiHankApps/admin-demos`. The page files live in `backend/aihankapps-hub/`, outside `public/`, and only the names in `PAGE_FILES` are served. Nothing falls through to a public file.
- An anonymous browser opening the page is redirected to `/portal/?return_to=%2FAiHankApps%2Fhub%2F` (the login page honours exactly that path). A signed-in account that is not an administrator gets a plain 403 page. Scripts, styles and the API get 401/403 JSON. While the server is starting everything answers 503.
- The public portfolio shows a "管理中樞" shortcut to everyone (Hank, 2026-11-11). Following it without a session leads to the login page and back; a non-administrator gets the 403 page. `GET /api/aihankapps/hub/access` still answers everyone with `{ success, admin }` and nothing else, for scripts; the portfolio no longer asks it.
- Responses are `private, no-store, no-transform` (so Cloudflare injects nothing the policy would block), same-origin, `noindex`, with a content security policy that allows only this path's own scripts and styles (plus the Google Fonts stylesheet the portfolio already uses) and same-origin requests.
- This repository is public, so the page's code is readable there. Its numbers are not: nothing read from the database is written to a file or committed, and tests use synthetic rows only.

## What it reads

Read-only, aggregates only. Each database read runs in its own `BEGIN READ ONLY` transaction with `SET LOCAL statement_timeout = 8000`.

| Source id | From | Gives |
|---|---|---|
| `catalog` | `public/AiHankApps/app-catalog.json` | apps, categories, store status, links |
| `store` | `public/AiHankApps/reports/data.js` (the public APP 趨勢 report, regenerated daily after 09:00 Taipei by the report watchdog) | Google Play installs, App Store first downloads, AdMob revenue, crash/ANR events, rating, review counts |
| `traffic` | `app_portfolio_traffic_daily` | portfolio views, introduction views, store clicks per app and day |
| `community` | `app_portfolio_likes`, `_comments`, `_beta_feedback` | counts, average beta rating |
| `feedback` | `fraud_app_feedback_reports` | counts |
| `eclaw` | `user_accounts`, in-memory devices | account totals, sign-ups per day, device and entity counts (test devices excluded) |
| `eclawChat` | `chat_messages` | messages and active devices per Taipei day, last 190 days, rescanned at most every 10 minutes |
| `dreambuddy` | `dream_buddy_inference_jobs`, `dream_buddy_ad_transactions` | conversation turns, completed/failed, active devices, rewarded ads per day |
| `eclawPayments` | `tappay_transactions` (`status = 'success'`, TWD), `topup_orders` (`paid`, not refunded) | EClawbot payments and amounts per day |
| `imports` | `aihankapps_hub_daily`, `_facts`, `_sources` (see below) | the game servers' and Wishlist's daily counts, current totals and weekly retention, as last imported |
| `services` | `aihankapps_hub_probes` (see below) | each back-end's availability and response time: 24 hours in five-minute buckets, 90 days |
| `imports` (`infra`) | `aihankapps_hub_infra`, written by the `railway` collector source | every Railway production service: data received (uploads) and sent (downloads), CPU, memory, volume space, latest deployment status; 24 hourly and 30 daily values |

The page also reads the public `/api/aihankapps/ops/*` API (worker CPU and finished work, Wishlist listings) directly, and `GET /api/aihankapps/hub/services` (admin only) for the latest health check of each back-end.

Not connected, and shown as such on the page's 資料來源 view:

- **Timehut's own server.** Its accounts and photo queue live in the server's own files, with no aggregate reader yet. The hub shows its health check and its AI workers.
- **Usage of apps without a server** (most store apps). They do not report usage; that needs an in-app reporting change and a new release of each app.
- **Store sales amounts.** The store report only carries AdMob revenue, and the game servers record purchase counts, not amounts. EClawbot and Wishlist amounts are real (their own payment tables).

### Service checks

`aihankapps-hub-store.js` lists the watched back-ends (`SERVICES`) with fixed public health URLs; nothing in a request can choose a host or path. Once a minute (`node-cron`, started from `index.js` unless `NODE_ENV=test` or `AIHANKAPPS_HUB_COLLECTOR=0`) this server asks each one, with a 10 s timeout and no redirects, and judges the answer by the service's own health body where it has one. Results are added to `aihankapps_hub_probes`: five-minute buckets kept 14 days, hourly buckets kept 400 days, pruned daily at 04:23. A bucket without a check is unknown (this server was not running), never "down".

### Railway service resources

Hank asked for the back-ends' upload/download traffic and more monitoring (2026-11-11). The collector's `railway` source (`tools/aihankapps-hub/railway-metrics.js`) runs on the operator's Mac, refreshes the Railway CLI login with `railway whoami` and reads Railway's metrics API with that session, read-only: per production service, NETWORK_RX/TX (shown as 上傳／下載), CPU, memory, volume use and size, and the latest deployment. Values are stored per service in `aihankapps_hub_infra` (one row per service, replaced on each import) and as the daily `netInMb` / `netOutMb` series of each service's first app (the 後台傳入／傳出 metrics). The page shows them in a 後台資源 table on the live view and on each app page, and raises 後台空間快滿 (≥ 80 %, ≥ 95 % critical) and 後台部署失敗 (latest deployment FAILED or CRASHED). The session token is used in memory for those requests only.

### Imported back-end numbers

The game servers (REBOUND; 活字戰紀's 雙城烽火 and 巔峰之戰) and Wishlist keep their own databases in other Railway projects, which this server cannot reach. The operator's collector, `tools/aihankapps-hub/collect.js`, reads them inside each back-end's own container over `railway ssh`, then runs `backend/scripts/aihankapps-hub-import.js` inside this server's container to store the result. There is no HTTP write API, and no connection string or secret passes through the tool.

- Every back-end question is a `SELECT` in its own read-only transaction with a 20 s limit, returns counts and dates only, and a failing question is noted while the rest continue.
- An import is one envelope (`schemaVersion: 1`, `source`, `collectedAt`, daily `series`, current `facts`, `notes`), checked whole by `validateEnvelope()`: catalog apps, known metrics (`IMPORT_METRICS`), real dates, nothing after the collection day, finite non-negative values, bounded sizes. It is stored in one transaction: values upserted, that source's facts replaced, its receipt updated.
- Imported series reach the page as `x.<metric>` (for example `x.activeUsers`) and join the matching hub metrics. The page warns when a source has not been imported for 36 hours.
- The collector runs from the operator's Mac (a LaunchAgent there runs it daily and the `railway` source hourly). Nothing in this repository schedules it; the page warns when a source has not been imported for 36 hours.

### Notification IDs and the alert lookup

Hank asked on 2026-11-11 for a 複製通知 ID button on every alert so an AI can look the problem up. Each alert carries `ref`: its type and subject (`worker-bad-timehut-mcode`), for a worker the monitor's issue code (`.server_poll_failed`), and for alerts with a fixed start the Taipei start time (`store-stale@20261102-1639`). The same problem keeps the same ID across reloads and browsers; a different problem or a new start gives a new ID. The page shows it under each alert with a copy button.

`GET /api/aihankapps/hub/alerts` (admin) answers the active alerts as the page computes them: the server runs the page's own `hub-data.js` in a `vm` sandbox whose fetch reaches only the hub answer, the latest service checks and the public `ops/catalog` and `ops/latest` (over loopback), cached 20 s. Each alert has `id` (the notification ID), `type`, `severity`, `title`, `detail`, `rule`, `condition`, `source`, `since`, `basis` (the raw values the rule looked at; times in epoch ms, also in `basisTaipei`). `GET /api/aihankapps/hub/alerts/<ID>` answers one: exact ID first, otherwise the same alert type (`matchedBy: "type"`); a cleared alert is 404 with `activeIds`.

### What the listing schedules cannot fix themselves (需要人為介入)

Hank asked on 2026-11-12 for a severe alert whenever the Wishlist listing work truly needs him, and for everything else to be cleared without him so the alerts get fewer. The listing schedules on the operator's Mac keep a board of open problems with two kinds of entry: `human` (only a person can clear it: a sign-in, a verification to pass by hand, a failed key, a decision) and `healing` (a schedule or tool is expected to clear it; left open too long it becomes `human`). Their own tool writes a summary of the board to `~/.local/share/aihankapps-hub/attention-summary.json`.

The collector's `attention` source carries that summary to the hub as one fact on Wishlist (`attention`: the number that needs a person, the number being healed, and at most 12 entries with id, kind, platform, title, detail, start and count; entries that need a person are kept first). The page raises one severe alert per `human` entry (`attention-<id>`, rule 需要人為介入) and nothing for `healing` entries; an entry that leaves the board clears its alert with the next import. The summary travels over the same operator-only import as every other collector source; there is no HTTP write API and nothing about it is public.

`node backend/scripts/aihankapps-hub-alerts.js [--brief]`, run inside the EClaw container over `railway ssh`, prints the active alerts exactly as the page computes them (same IDs as `GET /api/aihankapps/hub/alerts`), so a schedule on the operator's Mac can see which alerts are open, clear the ones a tool can clear and leave the rest. It is read-only and adds no API or session: it loads the hub's data from this service's database, makes one fresh health check per back-end and reads the public ops answers over loopback. The EClaw device count and the running server's minute-by-minute service checks live in that server's memory and are not reproduced.

### Problem reports and the alert schedule (2026-11-13)

Hank asked on 2026-11-13 for every app's problem reports to show up as hub alerts, for a schedule to judge every alert by itself, and for anything that needs him to become an alert that says exactly how he can help, because he only watches the hub ("我全程只盯管理中樞 不會盯排程的每次結果 所以不要pending在排程的每個session中").

**Reports** (`aihankapps-hub-inbox.js`, section `inbox` of the data answer, last 30 days, at most 60 per source): EClawbot's own `feedback` table; its automatic `[passive-health]` reports (an entity still unhealthy after self-repair) are folded into one alert per entity and Taipei day (`fb-eclaw-health-e<N>@<YYYYMMDD>`); 詐騙帝國's `fraud_app_feedback_reports`; the portfolio's `app_portfolio_beta_feedback` rows with a comment or a rating of 3 or less; and 拾光AI雲端相簿's App and LINE reports, which its server keeps and the schedule imports into the hub's own `aihankapps_hub_feedback` (sources `timehut-app`, `timehut-line`; receipts in `aihankapps_hub_sources` as `feedback-timehut-*`, so a stopped import shows as stale like any collector). This is the one place the hub reads message text. The data answer stays admin-only and private/no-store. Device ids, device secrets, log snapshots and device state are never selected. Each report is an alert (rule 新的問題回饋, notification ID `fb-<source>-<id>`) with `quote` = the report's words, until the schedule closes it.

**Notes** (`aihankapps_hub_notes`): what the schedule decided about one notification ID. `auto` = being handled or clears by itself (shown under the alert); `done` = closed (a closed report disappears; a computed alert still shows while its condition holds); `human` = only Hank can clear it: the alert becomes severe, titled 需要你處理：…, with `ask` saying what to do. A note can stand alone (`human-<slug>`, rule 排程請你處理) for a problem no rule shows. Notes are written only by `backend/scripts/aihankapps-hub-note.js` over `railway ssh`; there is no HTTP write API. Notes refuse anything that looks like a key or a phone number, and a `human` note must say what to do.

**The schedule** runs on the operator's Mac: `~/.local/bin/aihankapps-hub-triage` (source `tools/aihankapps-hub/triage-runner.zsh`) every 15 minutes from `tw.aihankapps.hub-triage`. It imports 拾光's reports (`triage.js pull`), lists what is due (`triage.js pending`: never judged, `auto` older than 6 hours, `human` older than 12 hours; the Wishlist board's `attention-*` alerts are left to the listing schedules), and only when something is due starts one headless Claude run (Sonnet) with `tools/aihankapps-hub/TRIAGE.md`. That run may only call `triage.js` (`note`, `raise`, `resolve`, `show`, `notes`, `kick` of three hub jobs) and read a few log files: no other shell, no writes, no web, no MCP servers, no user settings. If three runs in a row leave new alerts unjudged, the script itself raises `human-alert-schedule-stuck`, so a stuck schedule shows up where Hank looks.

### Muted alert kinds and the app page's alerts (2026-11-13)

Hank asked on 2026-11-13 for a 以後略過類似警告 button: pressing it folds every alert of that kind into one item kept on the page at information level. The kind is the alert's type (`id` in the data layer, e.g. `feedback-eclaw-health`, `rating-alpha`, `collector-stale-summit`). `POST /api/aihankapps/hub/mutes` `{ type, label, sampleRef }` stores it in `aihankapps_hub_mutes` and `DELETE /api/aihankapps/hub/mutes/<type>` undoes it. These are the API's only writes: admin session, plus an `Origin` of eclawbot.com (anything else is 403); every other non-GET request is 405. The page folds that kind's alerts into `muted-<type>` (rule 已略過的類似警告, severity info), listing the members, and keeps the item with zero members so the mute can be undone (取消略過). Never mutable: the schedule's own asks (`human`), folds, and individual people's reports (`feedback-eclaw`, `-fraud`, `-beta`, `-timehut-app`, `-timehut-line`). The alert schedule skips folds.

Hank also asked the same day why the sidebar showed a warning icon while the app page showed nothing. Each app page now starts with 這款 APP 的警示: the alerts behind that app's sidebar dot (`D.alertsFor`), ordered by urgency, each with its reason, the schedule's judgement and what Hank is asked to do. The sidebar tooltip names them.

### Account sign-ups

`ACCOUNT_APPS` in `aihankapps-hub.js` lists the apps that have accounts (Hank, 2026-11-11). `accounts` in the data answer and `GET /api/aihankapps/hub/accounts` give one row per catalog app: `status` `connected` (total, new in 7 / 30 days), `not_connected` (the app has accounts but no read-only count is wired; `note` says what is missing), `none` (no account sign-up) or `unknown` (not confirmed; currently Vibe帝國, whose game source was not mounted during the 2026-11-11 inventory). REBOUND only creates a guest record per install, so it is `none`. Counts only. EClawbot is counted from `user_accounts`; Wishlist and 雙城烽火／巔峰之戰 from facts the collector imports (`usersTotal` / `accountsTotal`, `accountsNew7d`, `accountsNew30d`). 時光相簿 keeps its accounts in its own server's files, so since backend 1.0.114 (2026-11-11) that server answers the counts itself: `GET /api/internal/account-stats` on the Timehut server returns `{ total, last7d, last30d, deleted, asOf }` (numbers only; deleted accounts are not in `total`) to one shared key (`Authorization: Bearer`, Railway variable `TIMEHUT_STATS_KEY` on the Timehut service; anything else is 401). The collector's `timehut` source calls it from the operator's Mac with the key from `~/.config/aihankapps-hub/timehut-stats-key` (mode 600, never in git or logs) and imports `accountsTotal`, `accountsNew7d`, `accountsNew30d` and `accountsDeleted`. The EClaw server holds no Timehut key. The overview shows them in the 帳號註冊人數 card.

### Weesh 帳戶智慧數據庫 (per-account detail)

Hank asked on 2026-11-13 for the Weesh page to have what 拾光's page has: every account, what it has done, and what needs attention. The collector's `wishlist-users` source (`DETAIL` in `tools/aihankapps-hub/backends.js`) runs inside the Wishlist container through the same read-only channel as `wishlist` and imports one fact per account (`wlUser` + a 10-character code) plus one `wlUsersMeta`. These facts have no `label`, so the plain number grid never shows them; `backend/aihankapps-hub/hub-weesh.js` draws them on the Weesh page (`#app-weesh`): totals, the step every account has reached (signed up → has wishes or listings → talking → meetup arranged → meetup completed), 智慧洞察, a searchable and sortable table, and a detail panel per account with its last 30 days.

What crosses over, per account: counts and times (wishes, lists, listings by status, conversations, messages sent, unread replies, source inquiries, meetups, purchases, follows, devices with notifications on, AI uses, feedback, daily activity for 30 days), the account's display name, and its sign-in address **masked inside the database** (two characters and the domain of an email, the last three digits of a phone number). The code is a hash of the account number; the number itself stays in the container. Never read: passwords, one-time codes, any token, the API key itself, real name, address, birthday, or the words and photos of any wish, listing or message. The collector's test (`wishlist-users: one fact per account`) holds the script to this.

One import carries at most 190 accounts and 44 KB: the most recently active keep their detail, the rest are left out and counted (`dropped`), and the totals still include them. Zeros and empty values are not sent; the page reads a missing part as zero. There is no sign-in time in Wishlist's database, so 最近動作 is the last wish, listing, message, source inquiry, purchase or device registration.

## Rules the numbers follow

- A day the source does not know is `null` and is drawn as a gap. Only live counters are zero-filled, and only from the day they started counting.
- A source that cannot be read is reported as `{ ok: false }`; the rest of the answer still arrives, and the page raises an alert.
- Each metric's period ends on its own last complete day: the store report lags by up to two weeks, live sources stop at yesterday. Every tile and chart states its dates.
- A previous period is compared only when every source of that metric was already recording through all of it. Otherwise the comparison is left blank rather than computed against missing days.
- The only target shown is the one the Wishlist listing report publishes (listings per hour). No other target exists yet.
- Alerts are computed from the current numbers and disappear when the condition clears. "確認" is remembered in that browser only.

## Files

- `backend/aihankapps-hub.js` — access gate, page router, data API.
- `backend/aihankapps-hub-store.js` — the hub's own tables: service checks and imported numbers.
- `backend/scripts/aihankapps-hub-import.js` — the import step, run by the collector inside this server's container.
- `backend/aihankapps-hub-inbox.js` — problem reports from every app and the alert schedule's notes (tables `aihankapps_hub_feedback`, `aihankapps_hub_notes`).
- `backend/scripts/aihankapps-hub-note.js` — writes or lists the schedule's notes, run inside this server's container; `aihankapps-hub-alerts.js` prints the active alerts.
- `backend/aihankapps-hub/` — `index.html`, `hub.css`, `hub-data.js` (data layer), `hub-charts.js` (SVG charts, no library), `hub-app.js` (views and interaction).
- `backend/public/AiHankApps/index.html` — the portfolio's shortcut row carries the "管理中樞" link.
- `tools/aihankapps-hub/` — the operator's collector and the back-end read scripts, and the alert schedule (`triage.js`, `TRIAGE.md`, `triage-runner.zsh`); see its README.
- `backend/tests/jest/aihankapps-hub.test.js`, `aihankapps-hub-store.test.js`, `aihankapps-hub-inbox.test.js`, `aihankapps-hub-triage.test.js`, plus a real-server block in `admin-auth.test.js`.

## Adding a source

1. In this server's database: add a `section(...)` in `createData()` that fills `daily` (per app and day) or `latest`, using `readOnly()` for database reads. Select counts and dates only. In another back-end's database: add an entry to `tools/aihankapps-hub/backends.js` instead, and the new metric to `IMPORT_METRICS` if it is not there.
2. Name the new series in `METRICS` in `hub-data.js` (`parts`, `type`, `group`), and add a row to `sourceRows()`.
3. Extend the fake pool and the expectations in `aihankapps-hub.test.js`.

## Checking a deployment

Anonymous: `curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' -H 'Accept: text/html' https://eclawbot.com/AiHankApps/hub/` should print `302` and the login URL; `/api/aihankapps/hub/data` should print `401`; `/api/aihankapps/hub/access` should answer `{"success":true,"admin":false}`; `/api/aihankapps/hub/services` should print `401`. The signed-in view needs an administrator's existing browser session; do not collect credentials to test it.
