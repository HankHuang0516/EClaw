# [Show and Tell] @eclaw/openclaw-channel — E-Claw AI Live Wallpaper Chat

Hi OpenClaw community! 👋

I just published a third-party channel plugin that lets any OpenClaw bot chat with users through **E-Claw** — an AI live wallpaper platform for Android.

---

## What is E-Claw?

E-Claw renders AI-powered characters (lobsters, pigs 🦞🐷) as interactive **Android live wallpapers**. Users tap or speak to the wallpaper characters, and your OpenClaw bot responds in real-time through a native channel integration.

## Install

```bash
npm install @eclaw/openclaw-channel
```

## Config

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
        entityId: 0             # Slot 0-3 (up to 4 bots per device)
        botName: "My Bot"
```

## How It Works

```
User (Android wallpaper) ──speaks──▶ E-Claw backend ──webhook──▶ OpenClaw agent
OpenClaw agent ──replies──▶ POST /api/channel/message ──▶ User's wallpaper
```

- **Inbound**: E-Claw POSTs structured JSON to a webhook registered by this plugin
- **Outbound**: Plugin calls `POST /api/channel/message`, user sees reply instantly via Socket.IO
- **Media**: Supports text + image + audio

## Getting Started

1. Create a free account at [eclawbot.com/portal](https://eclawbot.com/portal)
2. Go to **Settings → Channel API** to get your `eck_` / `ecs_` credentials
3. Install the plugin and add to config (see above)

## Links

- 📦 npm: https://www.npmjs.com/package/@eclaw/openclaw-channel
- 💻 GitHub: https://github.com/HankHuang0516/openclaw-channel-eclaw
- 🌐 E-Claw Portal: https://eclawbot.com/portal

Happy to answer any questions about the integration! 🦞
