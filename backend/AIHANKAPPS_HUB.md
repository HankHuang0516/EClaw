# AiHankApps 管理中樞 (admin hub)

`/AiHankApps/hub/` is the back-office overview for the app portfolio: every app's numbers in one place, for signed-in EClaw administrators only. Requested by Hank on 2026-11-10 ("只有登入eclaw管理者才能看到的額外頁面 / 所有作品後台的管理中樞 / 監控後台每一款APP所有數據"); the mock-up he approved is not in this repository.

## Access boundary

- The page (HTML, scripts, styles) and `GET /api/aihankapps/hub/data` pass through the existing `authModule.authMiddleware` and `authModule.adminMiddleware` (`user_accounts.is_admin`), unchanged. No account, role or credential is added.
- `/AiHankApps/hub` is reserved in `index.js` before anonymous pageview tracking and the public static mount, like `/AiHankApps/admin-demos`. The page files live in `backend/aihankapps-hub/`, outside `public/`, and only the names in `PAGE_FILES` are served. Nothing falls through to a public file.
- An anonymous browser opening the page is redirected to `/portal/?return_to=%2FAiHankApps%2Fhub%2F` (the login page honours exactly that path). A signed-in account that is not an administrator gets a plain 403 page. Scripts, styles and the API get 401/403 JSON. While the server is starting everything answers 503.
- `GET /api/aihankapps/hub/access` answers everyone with `{ success, admin }` and nothing else. The public portfolio (`public/AiHankApps/hub-entry.js`) uses it to add the "管理中樞" shortcut for administrators; for everyone else nothing is added to the page.
- Responses are `private, no-store`, same-origin, `noindex`, with a content security policy that allows only this path's own scripts and styles (plus the Google Fonts stylesheet the portfolio already uses) and same-origin requests.
- This repository is public, so the page's code is readable there. Its numbers are not: nothing read from the database is written to a file or committed, and tests use synthetic rows only.

## What it reads

Read-only, aggregates only. Each database read runs in its own `BEGIN READ ONLY` transaction with `SET LOCAL statement_timeout = 8000`.

| Source id | From | Gives |
|---|---|---|
| `catalog` | `public/AiHankApps/app-catalog.json` | apps, categories, store status, links |
| `store` | `public/AiHankApps/reports/data.js` (the public APP 趨勢 report, regenerated weekly) | Google Play installs, App Store first downloads, AdMob revenue, crash/ANR events, rating, review counts |
| `traffic` | `app_portfolio_traffic_daily` | portfolio views, introduction views, store clicks per app and day |
| `community` | `app_portfolio_likes`, `_comments`, `_beta_feedback` | counts, average beta rating |
| `feedback` | `fraud_app_feedback_reports` | counts |
| `eclaw` | `user_accounts`, in-memory devices | account totals, sign-ups per day, device and entity counts (test devices excluded) |
| `eclawChat` | `chat_messages` | messages and active devices per Taipei day, last 190 days, rescanned at most every 10 minutes |
| `dreambuddy` | `dream_buddy_inference_jobs`, `dream_buddy_ad_transactions` | conversation turns, completed/failed, active devices, rewarded ads per day |

The page also reads the public `/api/aihankapps/ops/*` API (worker CPU and finished work, Wishlist listings) directly.

Not connected yet, and shown as such on the page's 資料來源 view: the game servers, the Timehut server, service uptime, in-app events (active users, retention, funnels) and in-app purchase revenue.

## Rules the numbers follow

- A day the source does not know is `null` and is drawn as a gap. Only live counters are zero-filled, and only from the day they started counting.
- A source that cannot be read is reported as `{ ok: false }`; the rest of the answer still arrives, and the page raises an alert.
- Each metric's period ends on its own last complete day: the store report lags by up to two weeks, live sources stop at yesterday. Every tile and chart states its dates.
- A previous period is compared only when every source of that metric was already recording through all of it. Otherwise the comparison is left blank rather than computed against missing days.
- The only target shown is the one the Wishlist listing report publishes (listings per hour). No other target exists yet.
- Alerts are computed from the current numbers and disappear when the condition clears. "確認" is remembered in that browser only.

## Files

- `backend/aihankapps-hub.js` — access gate, page router, data API.
- `backend/aihankapps-hub/` — `index.html`, `hub.css`, `hub-data.js` (data layer), `hub-charts.js` (SVG charts, no library), `hub-app.js` (views and interaction).
- `backend/public/AiHankApps/hub-entry.js` — the administrators-only shortcut on the public portfolio.
- `backend/tests/jest/aihankapps-hub.test.js`, plus a real-server block in `admin-auth.test.js`.

## Adding a source

1. Add a `section(...)` in `createData()` that fills `daily` (per app and day) or `latest`, using `readOnly()` for database reads. Select counts and dates only.
2. Name the new series in `METRICS` in `hub-data.js` (`parts`, `type`, `group`), and add a row to `sourceRows()`.
3. Extend the fake pool and the expectations in `aihankapps-hub.test.js`.

## Checking a deployment

Anonymous: `curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' -H 'Accept: text/html' https://eclawbot.com/AiHankApps/hub/` should print `302` and the login URL; `/api/aihankapps/hub/data` should print `401`; `/api/aihankapps/hub/access` should answer `{"success":true,"admin":false}`. The signed-in view needs an administrator's existing browser session; do not collect credentials to test it.
