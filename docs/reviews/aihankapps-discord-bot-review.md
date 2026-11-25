# AiHankApps Discord bot review

Hank asked on 2026-11-25 for every portfolio app to talk to its users the Discord way, all three phases at once, and then to switch from clicking through his account to a bot after Discord signed the account out twice. The server, channels, roles, AutoMod, Community mode, onboarding and the permanent invite were set up by hand; this PR adds the bot that does the rest. Details: `backend/AIHANKAPPS_DISCORD.md`.

## Checklist

- ✅ A1 Logic: setup runs once per `SETUP_VERSION` and only fills empty topics and missing tags; reports are inserted with `ON CONFLICT DO NOTHING` and only for posts in the #問題回報 forum from the last 30 days; a reply is sent once per (post, state) and a deleted post is skipped; releases and gifts are compared with the previous run and the first run only records. Without `AIHANKAPPS_DISCORD_BOT_TOKEN` nothing starts.
- ✅ A2 Tests: `backend/tests/jest/aihankapps-discord.test.js` (8): forum tags, post → report mapping, release and gift diffs including the first-run rule, setup idempotence and the exact REST calls (rules pinned, custom topics kept, no mentions), schedule note → one fixed reply + tag + archive, no token → off and no secret in status, rate-limit retry. Existing hub inbox and hub suites pass.
- ⚠️ A3 Return shape: `GET /api/aihankapps/discord/status` answers `{ success: true, enabled, guildId, lastCycle, lastError, lastAnnounce, setup, reports, replies }` behind the existing admin middleware.
- ✅ A4 Not fixed: per-app Discord account linking inside the apps (needs app releases); an AI helper and leaderboards in Discord; muting or deleting posts from the hub. Post bodies are stored on the hub like other reports; the schedule's notes never go to Discord.
- ✅ A5 Security: the token comes only from a Railway variable, is sent only to discord.com, and is never logged, stored or returned (asserted). All posts disable mentions. Discord text is cleaned of control characters and length-capped before storage; the admin-only, no-store hub keeps it. No new public endpoint; the bot cannot be driven from the web.
- ⚠️ B1 /api/help NO-OP: admin-only status endpoint, not an entity API.
- ✅ B2 Docs: `AIHANKAPPS_DISCORD.md` (new), `AIHANKAPPS_HUB.md` (Discord reports).
- ⚠️ B3 i18n NO-OP: Discord posts and hub labels are Traditional Chinese like the rest of the hub; no `data-i18n` page strings.
- ✅ B4 Info/promo: the portfolio Discord link is a separate change once the bot is live.
- ✅ B5 Debug: `GET /api/aihankapps/discord/status` (admin) shows the bot's last cycle, counts and last error.
