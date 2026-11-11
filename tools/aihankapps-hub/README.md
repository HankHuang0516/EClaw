# AiHankApps 管理中樞 collector

Reads daily counts from the back-ends that keep their own databases (the game servers and Wishlist) and imports them
into the admin hub at `https://eclawbot.com/AiHankApps/hub/`. See `backend/AIHANKAPPS_HUB.md` for what the hub shows.

```
node tools/aihankapps-hub/collect.js                   # read every back-end, show what would be sent, send nothing
node tools/aihankapps-hub/collect.js --commit          # read, then import into the hub
node tools/aihankapps-hub/collect.js --only rebound    # one back-end: rebound, summit, wishlist, railway
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
| `railway` | every project above, plus EClaw and 時光相簿 (metrics API, no ssh) | every app with a Railway service | traffic in/out, CPU, memory, volume space, latest deployment |

## Running it on a schedule

Nothing here schedules it. On Hank's Mac a LaunchAgent runs the whole collector daily and the `railway` source hourly
(see the hub memory notes). The hub warns when a source has not been imported for 36 hours. Runs need the operator's
Railway login on the machine that runs them.

## Tests

`backend/tests/jest/aihankapps-hub-store.test.js` runs each back-end script against a stand-in database and checks
that every question is a read-only `SELECT` and that only counts come back.
