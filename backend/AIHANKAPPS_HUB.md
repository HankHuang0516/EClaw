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
- `backend/aihankapps-hub/` — `index.html`, `hub.css`, `hub-data.js` (data layer), `hub-charts.js` (SVG charts, no library), `hub-app.js` (views and interaction).
- `backend/public/AiHankApps/index.html` — the portfolio's shortcut row carries the "管理中樞" link.
- `tools/aihankapps-hub/` — the operator's collector and the back-end read scripts; see its README.
- `backend/tests/jest/aihankapps-hub.test.js`, `aihankapps-hub-store.test.js`, plus a real-server block in `admin-auth.test.js`.

## Adding a source

1. In this server's database: add a `section(...)` in `createData()` that fills `daily` (per app and day) or `latest`, using `readOnly()` for database reads. Select counts and dates only. In another back-end's database: add an entry to `tools/aihankapps-hub/backends.js` instead, and the new metric to `IMPORT_METRICS` if it is not there.
2. Name the new series in `METRICS` in `hub-data.js` (`parts`, `type`, `group`), and add a row to `sourceRows()`.
3. Extend the fake pool and the expectations in `aihankapps-hub.test.js`.

## Checking a deployment

Anonymous: `curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' -H 'Accept: text/html' https://eclawbot.com/AiHankApps/hub/` should print `302` and the login URL; `/api/aihankapps/hub/data` should print `401`; `/api/aihankapps/hub/access` should answer `{"success":true,"admin":false}`; `/api/aihankapps/hub/services` should print `401`. The signed-in view needs an administrator's existing browser session; do not collect credentials to test it.
