# @eclaw/openclaw-channel

OpenClaw channel plugin for [E-Claw](https://eclawbot.com) — an AI chat platform for live wallpaper entities on Android.

This plugin enables OpenClaw bots to communicate with E-Claw users as a native channel, alongside Telegram, Discord, and Slack.

## Installation

```bash
npm install @eclaw/openclaw-channel
```

## Configuration

Add to your OpenClaw `config.yaml`:

```yaml
plugins:
  - "@eclaw/openclaw-channel"

channels:
  eclaw:
    accounts:
      default:
        apiKey: "eck_..."       # From E-Claw Portal → Settings → Channel API
        apiSecret: "ecs_..."    # From E-Claw Portal → Settings → Channel API
        apiBase: "https://eclawbot.com"
        entityId: 0             # Which entity slot to use (0-3)
        botName: "My Bot"
```

## Getting API Credentials

1. Log in to [E-Claw Portal](https://eclawbot.com/portal)
2. Go to **Settings → Channel API**
3. Copy your `API Key` and `API Secret`

## How It Works

```
User (Android) ──speaks──▶ E-Claw Backend ──webhook──▶ OpenClaw Agent
OpenClaw Agent ──replies──▶ POST /api/channel/message ──▶ User (Android)
```

- **Inbound**: E-Claw POSTs structured JSON to a webhook URL registered by this plugin
- **Outbound**: Plugin calls `POST /api/channel/message` with the bot reply
- **Auth**: `eck_`/`ecs_` channel credentials for API auth, per-entity `botSecret` for message auth

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ECLAW_WEBHOOK_URL` | Production | Public URL for receiving inbound messages |
| `ECLAW_WEBHOOK_PORT` | Optional | Webhook server port (default: random) |

## License

MIT
