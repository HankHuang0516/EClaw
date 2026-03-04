# E-Claw — AI Live Wallpaper

> Retro E-Pet meets AI Live Wallpaper

[![Release](https://img.shields.io/github/v/release/HankHuang0516/realbot)](https://github.com/HankHuang0516/realbot/releases/latest)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Android-green.svg)](https://www.android.com)
[![Backend](https://img.shields.io/badge/backend-Railway-purple.svg)](https://railway.app)

Bring your Android wallpaper to life with a 90s Tamagotchi soul — powered by AI Bots, 24/7.

---

## Features

| Feature | Description |
|---------|-------------|
| 🦐 **AI Live Wallpaper** | Up to 4 AI-driven entities moving freely on your wallpaper |
| 🤖 **OpenClaw Bot Integration** | Two-way communication with AI bots via Webhook + exec-curl |
| 💬 **Real-time Chat** | Long-press the wallpaper to chat with entities; full message history |
| 🔔 **Push Notifications** | Bot-initiated messages in instruction-first format |
| 📊 **Web Portal** | Cross-device entity management, status view, and remote control |
| 📡 **Device Telemetry** | Structured debug buffer with AI-assisted troubleshooting |
| 🔐 **Google Account Login** | Bind a Google account; data restored automatically after reinstall |
| 📈 **Free / Premium Plans** | Built-in gatekeeper — free bots: 15 messages/day; own bots: unlimited |
| 🛠️ **Mission Control** | Assign skills and rules to bots; community-contributed skill templates |

---

## Architecture

```
┌─────────────────────┐     ┌──────────────────────┐
│   Android App       │     │   Web Portal         │
│   (Kotlin)          │     │   (HTML/JS)          │
│                     │     │                      │
│  Live Wallpaper     │     │  Entity Management   │
│  Chat UI            │◄────►  Bot Config          │
│  Push Receiver      │     │  Telemetry Viewer    │
└─────────┬───────────┘     └────────┬─────────────┘
          │                          │
          │    HTTPS / REST API      │
          ▼                          ▼
┌─────────────────────────────────────────────────┐
│              Backend (Railway)                   │
│              Node.js + Express                   │
│                                                  │
│  /api/bind      /api/broadcast   /api/transform  │
│  /api/chat      /api/logs        /api/telemetry  │
│                                                  │
│         PostgreSQL (persistent store)            │
└────────────────────────┬────────────────────────┘
                         │  Webhook Push + exec+curl
                         ▼
              ┌──────────────────────┐
              │  OpenClaw Platform   │
              │  (Zeabur)            │
              │                      │
              │  AI Bot Instances    │
              │  (up to 4 per device)│
              └──────────────────────┘
```

- **4 entity slots** per device (0–3), independently bindable
- **Bots** communicate via Webhook push (incoming) + exec+curl (`POST /api/transform`)
- **Railway** auto-deploys on push to `main` (watches the `backend/` folder)

---

## Quick Start

### Prerequisites

- Android 8.0+ device
- Node.js 18+
- PostgreSQL (or Railway's managed PostgreSQL)

### Local Backend Development

```bash
git clone https://github.com/HankHuang0516/realbot.git
cd realbot/backend
npm install
cp .env.example .env   # fill in DATABASE_URL, etc.
npm run dev
# → Server running on http://localhost:3000
```

### Deploy to Railway

```bash
# Connect this repo to Railway.
# Set environment variables in the Railway dashboard: DATABASE_URL  PORT  NODE_ENV
git push origin main   # Railway auto-deploys from backend/ on push to main
```

### Android App

1. Download the latest `.aab` / `.apk` from [GitHub Releases](https://github.com/HankHuang0516/realbot/releases/latest)
2. Set as Live Wallpaper → long-press Settings → enter your `deviceId`
3. Open the Web Portal to bind AI entities

---

## Project Structure

```
realbot/
├── app/                          # Android app (Kotlin)
│   └── src/main/
│       ├── java/                 # App source code
│       └── res/                  # Resources, layouts, strings
├── backend/                      # Node.js backend (Railway)
│   ├── index.js                  # Express server entry point
│   ├── public/                   # Web Portal (HTML/JS/CSS)
│   ├── data/
│   │   └── skill-templates.json  # Community skill template registry
│   ├── device-telemetry.js       # Telemetry buffer module
│   └── tests/                    # Regression test suite
├── openclaw-channel-eclaw/       # npm package: @eclaw/openclaw-channel
├── google_play/                  # Store assets (icon, feature graphic)
├── RELEASE_HISTORY.md            # Version history with commit hashes
├── PRIVACY_POLICY.md             # Privacy policy
└── CLAUDE.md                     # AI assistant instructions
```

---

## Regression Tests

```bash
# Bot API response rate (target: 90%+)
node backend/tests/test-bot-api-response.js

# Full broadcast flow (delivery, speak-to, chat history)
node backend/tests/test-broadcast.js
```

Requires `TEST_DEVICE_ID` / `BROADCAST_TEST_DEVICE_ID` + `BROADCAST_TEST_DEVICE_SECRET` in `backend/.env`.

---

## Documentation

- [Privacy Policy](PRIVACY_POLICY.md)
- [Backend API Reference](backend/README.md)
- [MCP Skill Guide](backend/E-claw_mcp_skill.md)
- [Release History](RELEASE_HISTORY.md)

---

## Contributing

### General

Issues and pull requests are welcome!

1. Fork the repo
2. Create a feature branch: `git checkout -b feat/your-feature`
3. Commit your changes
4. Open an issue to discuss before sending a PR

**Feature Parity Rule**: All user-facing features must be kept in sync between the Web Portal and the Android App.

---

### Contributing a Skill Template

Skill templates appear in Mission Control's **Add Skill** dialog. Anyone can contribute a new template by editing [`backend/data/skill-templates.json`](backend/data/skill-templates.json) and opening a PR.

#### Template Schema

```json
{
  "id": "unique-slug",
  "label": "display name",
  "icon": "🔧",
  "title": "Skill title (pre-filled in dialog)",
  "url": "https://github.com/your/repo",
  "author": "Your GitHub username",
  "updatedAt": "YYYY-MM-DD",
  "requiredVars": [
    {
      "key": "MY_API_KEY",
      "hint": "sk-...",
      "description": "Get it from https://example.com/settings/api"
    }
  ],
  "steps": "Plain-text installation steps shown to the user.\n\n== Step 1 ==\n..."
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | URL-safe unique slug (e.g. `my-skill`) |
| `label` | Yes | Short display name for the template chip |
| `icon` | No | Emoji icon shown on the chip |
| `title` | Yes | Pre-filled skill title in the dialog |
| `url` | No | Link to the skill's source repo |
| `author` | Yes | Your name or GitHub handle |
| `updatedAt` | Yes | Date of last update (`YYYY-MM-DD`) |
| `requiredVars` | No | List of env vars the skill needs. Users are prompted to enter these when they apply the template. |
| `steps` | No | Plain-text setup instructions shown in the skill dialog |

#### `requiredVars` Format

Each entry in `requiredVars` prompts the user for a value that is saved to their device's **Environment Variables** (encrypted, per-device):

```json
{
  "key": "CLAUDE_CODE_OAUTH_TOKEN",
  "hint": "sk-ant-oat01-...",
  "description": "Claude CLI OAuth token — get it from claude.ai/settings/api"
}
```

#### Example PR Checklist

- [ ] `id` is unique across all existing templates
- [ ] `steps` are written in English
- [ ] `requiredVars[].description` includes a URL where users can obtain the value
- [ ] `updatedAt` is set to today's date
- [ ] Template has been tested locally

---

## License

[MIT License](LICENSE) © 2026 HankHuang0516
