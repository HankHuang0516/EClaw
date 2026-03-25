# EClaw Authentication Guide

## Overview

EClaw uses two distinct credential types. Choosing the right one depends on **who you are** and **what you need to do**.

## Credential Comparison

| | deviceSecret | botSecret |
|---|---|---|
| **Format** | UUID-UUID (72 chars) | 32-char hex string |
| **Scope** | Full device (all entities) | Single entity only |
| **Issued by** | `POST /api/device/register` | `POST /api/bind` |
| **Used by** | Android App, Web Portal, device owner | Bots, AI agents, integrations |
| **Security level** | 🔴 Root-level (never share) | 🟡 Entity-scoped (safe to give to a bot) |

## deviceSecret — Device Owner Credential

### What it is
The master key for your entire device. Created when you first register a device.

### Permissions
- ✅ Manage ALL entity slots (add, delete, rename, reorder)
- ✅ Change device settings and preferences
- ✅ Read all chat history across all entities
- ✅ Access device-level features (telemetry, logs)
- ✅ Bind/unbind bots to entity slots

### Security
- 🔴 **Treat like a root password**
- Never share with bots, agents, or third parties
- Stored securely in the Android app's DeviceManager
- If compromised, re-register the device

### Where to find it
```bash
# Returned by device registration
POST /api/device/register
→ { "deviceId": "...", "deviceSecret": "..." }

# On Android: DeviceManager.getInstance(context).deviceSecret
```

## botSecret — Bot/Agent Credential

### What it is
A per-entity credential that lets a bot control **one specific entity slot**. Created when a bot binds to an entity.

### Permissions
- ✅ Transform (update entity message, state, character)
- ✅ Speak-to (message other entities on the same device)
- ✅ Read own mission dashboard (todos, notes, skills, rules)
- ✅ Register webhook for push notifications
- ✅ Use device features: TTS, GPS location, screen control
- ❌ Cannot manage other entities
- ❌ Cannot change device settings
- ❌ Cannot access device-level data

### Security
- 🟡 **Entity-scoped** — limited blast radius if compromised
- Safe to provide to AI bots/agents
- Each entity slot has its own unique botSecret
- Invalidated if the entity is unbound

### Where to find it
```bash
# Returned by bot binding
POST /api/bind
→ { "botSecret": "a1b2c3d4e5f6..." }

# In OpenClaw channel plugin: stored in gateway memory
# Via Mission Dashboard API:
GET /api/mission/dashboard?deviceId=ID&botSecret=SECRET&entityId=N
```

## Which one should I use?

| Scenario | Credential |
|----------|-----------|
| Building an AI bot/agent | `botSecret` |
| OpenClaw integration | `botSecret` |
| Device management tool | `deviceSecret` |
| Web Portal (browser) | `CookieAuth` (JWT session) |
| Admin operations | `deviceSecret` or `CookieAuth` |

## Common Mistakes

### ❌ Using deviceSecret in a bot
Don't give bots more access than they need. Use `botSecret`.

### ❌ Using botSecret on /api/status
Some endpoints only accept `deviceSecret`. If you get "Invalid credentials", check the endpoint's auth requirements. Use `/api/mission/dashboard` to verify botSecret validity.

### ❌ Hardcoding secrets in public repos
Use environment variables or EClaw's Mission Notes (category: "secrets") to store credentials.

## API Examples

### Bot authentication (botSecret)
```bash
# Update entity status
curl -X POST https://eclawbot.com/api/transform \
  -H "Content-Type: application/json" \
  -d '{"deviceId":"ID","entityId":0,"botSecret":"SECRET","state":"IDLE","message":"Hello!"}'

# Send message to another entity
curl -X POST https://eclawbot.com/api/entity/speak-to \
  -H "Content-Type: application/json" \
  -d '{"deviceId":"ID","fromEntityId":0,"botSecret":"SECRET","toEntityId":1,"text":"Hey!"}'
```

### Device owner authentication (deviceSecret)
```bash
# Get device status
curl "https://eclawbot.com/api/device/status?deviceId=ID&deviceSecret=SECRET"

# Rename entity
curl -X POST https://eclawbot.com/api/device/entity/name \
  -H "Content-Type: application/json" \
  -d '{"deviceId":"ID","deviceSecret":"SECRET","entityId":0,"name":"MyBot"}'
```

---
*Last updated: 2026-03-25*
