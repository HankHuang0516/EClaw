# AiHankApps 作品集 Discord 機器人

Hank, 2026-11-25: 作品集內的所有 APP 用 Discord 經營模式跟用戶互動。The server "AiHank 作品集" (guild `1574788250583957615`, invite https://discord.gg/NsWTjBVSkf) was set up by hand in the Discord web app: categories, one channel per app, the #問題回報 forum, roles (管理員, 內測者, 贊助者), the private 🧪 內測專區, AutoMod (mention spam, suspected spam, flagged words, a Chinese scam/advertising keyword list), Community mode and onboarding (one question that opens each app's channel). Clicking through a user account was stopped after Discord signed the account out twice; everything else is done by this bot through Discord's REST API.

## What the bot does (`aihankapps-discord.js`)

- **Setup** (once per `SETUP_VERSION`): adds the app tags and the moderated 處理中 / 已處理 tags to the #問題回報 forum and sets its guideline; gives every app channel a topic if it has none; posts and pins the community rules in #rules; posts one intro in #新版本, #活動禮包 and #內測招募.
- **Problem reports** (every 2 minutes): each new #問題回報 post (last 30 days) is stored as a hub problem report — `aihankapps_hub_feedback`, source `discord`, notification ID `fb-discord-<post id>`, app from the post's tag (`portfolio` for 其他作品 or no tag). It appears on the hub as 新的問題回饋 and the alert schedule judges it like every other report. The receipt `feedback-discord` in `aihankapps_hub_sources` shows when the forum was last read.
- **Replies**: when the schedule writes a note on that ID, the bot posts one fixed sentence in the post (處理中 for `auto`/`human`, 已處理 for `done`) and sets the matching tag; `done` also archives the post. The schedule's own words stay on the hub.
- **Announcements** (every 10 minutes): a new App Store version, a new App Store or Google Play listing in `public/AiHankApps/app-catalog.json` → #新版本; an approved gift campaign from `public/AiHankApps/gift-campaigns.js` → #活動禮包 when it is announced and when sending starts. The first run only records the current catalog and campaigns.

No gateway connection and no message-content intent: the bot only reads the forum it owns and the first message of each post.

## Configuration

| Railway variable (EClaw service) | |
|---|---|
| `AIHANKAPPS_DISCORD_BOT_TOKEN` | the bot token; without it the bot is off. Set it in Railway only; it is never logged, stored or returned. |
| `AIHANKAPPS_DISCORD_GUILD_ID` | optional, defaults to the server above |
| `AIHANKAPPS_DISCORD=0` | turns the bot off without removing the token |

State (setup receipts, replied posts, last catalog, announced campaigns) lives in `aihankapps_discord_state`. `GET /api/aihankapps/discord/status` (EClaw admin session) shows whether it is on, the last cycle, report and reply counts, the last announcement and the last error message — no token, no message text, no user names.

## Creating the bot (Hank, once)

1. https://discord.com/developers/applications → New Application → name `AiHank 作品集`.
2. Bot → Reset Token → copy it and paste it into the EClaw service's Railway variable `AIHANKAPPS_DISCORD_BOT_TOKEN` (nowhere else). Privileged intents stay off.
3. Invite it with only the permissions it needs (view channels, send messages, send messages in threads, read history, embed links, manage messages, pin messages, manage channels for topics and forum tags, manage threads for tags and archiving):
   `https://discord.com/oauth2/authorize?client_id=<APPLICATION ID>&scope=bot&permissions=2252091871554576&guild_id=1574788250583957615&disable_guild_select=true`
4. Railway redeploys with the variable; the first cycle runs 15 seconds after start.
