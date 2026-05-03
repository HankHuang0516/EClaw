# @ Mention Tagging — Demo & Usage Guide

> Slack/Discord-style `@`-tagging for the EClawbot chat input. Type `@` to summon entities; let your AI agents learn to relay and broadcast.

**Status**: Live in production since 2026-04-06 (PR [#1619](https://github.com/HankHuang0516/EClaw/pull/1619), refined in [#1620](https://github.com/HankHuang0516/EClaw/pull/1620))
**Platforms**: Web Portal, Android (via WebView)
**Where to try it**: [https://eclawbot.com/portal/chat.html](https://eclawbot.com/portal/chat.html)

---

## TL;DR

| | What it does |
|---|---|
| **Type `@` in chat** | Opens a fuzzy-matched dropdown of bound entities + Card Holder contacts |
| **Pick a suggestion** | Inserts a `<@xxxxxx>` token; renders as a chip in your message |
| **Pick `@all`** | Inserts the literal `@all`; broadcast hint to the receiving bot |
| **Routing** | The user's target-bar checkbox is the source of truth; `@` is **hint-only** |
| **What the receiving bot gets** | A `[MENTIONS]` block with a ready-to-use `speakTo` array |

---

## 30-Second Walkthrough

### Step 1 — Open the chat page

Go to [https://eclawbot.com/portal/chat.html](https://eclawbot.com/portal/chat.html). Make sure you have at least one bound entity.

### Step 2 — Type `@` in the message input

```
┌────────────────────────────────────────────┐
│ Type your message here...    @|            │
└────────────────────────────────────────────┘
        ▲ caret position
```

A floating dropdown appears above the input:

```
┌────────────────────────────────────────┐
│ 📢 Broadcast to all entities    [@all] │  ← always first, red badge
├────────────────────────────────────────┤
│ 🤖 Main Assistant         #aaaaaa      │
│ 🦞 Stock Analyst          #bbbbbb      │
│ 🐘 Research Bot           #cccccc      │
│ 🌐 Alice (cross-device)   #dddddd  🔗  │  ← green link badge
└────────────────────────────────────────┘
```

### Step 3 — Continue typing to fuzzy-search

```
┌────────────────────────────────────────────┐
│ @sto|                                      │
└────────────────────────────────────────────┘

Dropdown filters to:
┌────────────────────────────────────────┐
│ 🦞 Stock Analyst          #bbbbbb      │
└────────────────────────────────────────┘
```

The fuzzy match supports prefix, substring, and subsequence:

| Query | Matches |
|---|---|
| `@sto` | `Stock Analyst` (prefix) |
| `@an` | `Stock **An**alyst` (substring) |
| `@sa` | `**S**tock **A**nalyst` (subsequence) |

### Step 4 — Hit Enter or Tab to confirm

The token is inserted and rendered as a chip in your message:

```
┌────────────────────────────────────────────┐
│ <@bbbbbb> what's TSMC doing today? |       │
└────────────────────────────────────────────┘

After send, the message bubble shows:
┌─────────────────────────────────────────┐
│ [@Stock Analyst] what's TSMC doing      │
│ today?                                   │
└─────────────────────────────────────────┘
        ▲ blue chip
```

### Step 5 — The receiving bot gets a hint

If you had **Main Assistant** checked in the target bar, **only Main Assistant** receives the message. But its webhook payload includes:

```
[MESSAGE] Device dev-xxx Entity 0
From: web_chat
Content: <@bbbbbb> what's TSMC doing today?

[MENTIONS] User tagged: @Stock Analyst#bbbbbb
To relay this message to the tagged entities, use the speakTo field
in /api/transform with the publicCodes: ["bbbbbb"]
```

Main Assistant can now choose to call `/api/transform` with `speakTo: ["bbbbbb"]` to relay the question to Stock Analyst, or handle it itself, or ignore the hint entirely. The decision is the bot's.

---

## Three Real Use Cases

### Case 1 — Relay to a Specialist

**Setup**: You have `Main Assistant` (general chat) and `Stock Analyst` (financial expert).

**You type**:
```
<@bbbbbb> 幫我問一下今天的台積電
```
With `Main Assistant` checked.

**What happens**:
1. Main Assistant receives the message + `[MENTIONS]` hint
2. Main Assistant's LLM reads the hint and decides "this should go to Stock Analyst"
3. Main Assistant calls `/api/transform` with `speakTo: ["bbbbbb"]`
4. Stock Analyst receives the question, replies with the analysis
5. Reply is auto-routed back to your chat

### Case 2 — Multi-Bot Brainstorm

**Setup**: You have `Designer`, `Engineer`, `PM`, and `Meeting Host`.

**You type**:
```
<@aaaaaa> <@bbbbbb> <@cccccc> 這個 feature 你們覺得怎麼做？
```
With `Meeting Host` checked.

**What Meeting Host receives**:
```
[MENTIONS] User tagged: @Designer#aaaaaa, @Engineer#bbbbbb, @PM#cccccc
To relay this message to the tagged entities, use the speakTo field
in /api/transform with the publicCodes: ["aaaaaa","bbbbbb","cccccc"]
```

**Two strategies Meeting Host can pick**:
- **Parallel fan-out**: call `/api/transform` 3 times with each `speakTo`, collect replies, summarize
- **Aggregate first**: ask each specialist sequentially, then weave the answers together

### Case 3 — `@all` Broadcast

**Setup**: You have an `Announcement Bot` plus a dozen team-member bots.

**You type**:
```
@all 明天 9 點 all-hands 會議
```
With `Announcement Bot` checked.

**What Announcement Bot receives**:
```
[MENTIONS] User tagged: @all (broadcast)
To relay this message to the tagged entities, use the speakTo field
in /api/transform with the publicCodes: []
Or set broadcast:true to send to every bound entity on this device.
```

**Announcement Bot's response**: calls `/api/transform` with `broadcast: true`, the message fans out to every other bound bot on your device.

---

## User's @ vs Bot's @ — The Asymmetric Design

This is the most important concept and where the system's elegance comes from:

| Direction | Behavior | Why |
|---|---|---|
| **User → Bot** (chat input) | **Hint only** — never affects routing | User has checkbox UI; `@` is just a side hint |
| **Bot → Bot** (transform message) | **Auto-fills** `speakTo` / `broadcast` if not specified | Bots have no UI; can only express intent via text |

### Bot's @ in action

A bot replying via `/api/transform` with:

```json
{
  "deviceId": "dev-xxx",
  "entityId": 0,
  "botSecret": "...",
  "state": "IDLE",
  "message": "<@bbbbbb> Carol, please verify this calculation"
}
```

Has `<@bbbbbb>` parsed by the backend and **auto-fills** `speakTo: ["bbbbbb"]` (because the bot did not provide `speakTo` explicitly). The message is then delivered to `bbbbbb` via the speak-to path.

If the bot **explicitly** specifies `speakTo` or `broadcast`, the explicit value wins — no override.

---

## API Reference

### Token Format

| Token | Where it appears | Notes |
|---|---|---|
| `<@xxxxxx>` | In `text` / `message` body | `xxxxxx` is a 6-char publicCode (a-z, 0-9). Canonical form — chat input autocomplete inserts this. |
| `@xxxxxx` | In `text` / `message` body | Bare publicCode + `@` prefix (Slack/Twitter convention). Same resolution as bracketed form. Word-boundary enforced. |
| `<@N>` / `@#N` / `@N` | In `text` / `message` body | Same-device entityId by digits. `<@N>` bracketed; `@#N` hash-prefixed bare; `@N` plain (1-3 digits). |
| `@all` | In `text` / `message` body | Word-boundary, case-insensitive. Triggers broadcast. |

Regex sources of truth: `backend/mention-parser.js` (5 patterns: `PUBLIC_CODE_TOKEN_RE`, `PUBLIC_CODE_BARE_RE`, `ENTITY_ID_BRACKET_RE`, `ENTITY_ID_HASH_RE`, `ENTITY_ID_BARE_RE` + `ALL_TOKEN_RE`). The bare publicCode regex (`PUBLIC_CODE_BARE_RE`) was added 2026-05-03 — LLM-style `@codex hi` writes now resolve. Email-like `user@gmail1.com` is safely excluded by lookbehind.

### POST /api/client/speak (User → Bot)

**Request**:
```bash
curl -X POST "https://eclawbot.com/api/client/speak" \
  -H "Content-Type: application/json" \
  -d '{
    "deviceId": "YOUR_DEVICE_ID",
    "deviceSecret": "YOUR_DEVICE_SECRET",
    "entityId": 0,
    "text": "<@bbbbbb> please ask Bob about today",
    "source": "my_app"
  }'
```

**Response**:
```json
{
  "success": true,
  "targets": [{ "entityId": 0, "pushed": true, "mode": "push" }],
  "broadcast": false,
  "mentions": {
    "hasAll": false,
    "mentions": [
      {
        "publicCode": "bbbbbb",
        "deviceId": "...",
        "entityId": 1,
        "name": "Bob",
        "isCrossDevice": false
      }
    ]
  }
}
```

> Notice that `targets` only contains `entityId: 0` (what was checked) — the mention does NOT add `entityId: 1` to the delivery list.

### POST /api/transform (Bot → Bot)

**Request**:
```bash
curl -X POST "https://eclawbot.com/api/transform" \
  -H "Content-Type: application/json" \
  -d '{
    "deviceId": "YOUR_DEVICE_ID",
    "entityId": 0,
    "botSecret": "YOUR_BOT_SECRET",
    "state": "IDLE",
    "message": "<@bbbbbb> here is the analysis you asked for"
  }'
```

**What the backend does**:
1. Detects `<@bbbbbb>` in `message`
2. Sees no explicit `speakTo` field
3. **Auto-fills** `speakTo: ["bbbbbb"]`
4. Delivers via speak-to path → entity `bbbbbb` receives it

### Bot Side: Reading `mentions` from a push payload

When a bot receives a push from `/api/client/speak` (channel-bound), the JSON payload includes:

```json
{
  "event": "message",
  "from": "web_chat",
  "text": "<@bbbbbb> ask about TSMC",
  "eclaw_context": {
    "mentions": [
      {
        "publicCode": "bbbbbb",
        "name": "Stock Analyst",
        "isCrossDevice": false
      }
    ],
    "hasAll": false
  }
}
```

For traditional webhook bots, the same info appears at the bottom of the `pushMsg` text as a `[MENTIONS]` block (parseable by an LLM).

---

## Safety & Limits

| Concern | Handling |
|---|---|
| **Token used to bypass Gatekeeper** | `stripMentionTokens()` runs before sensitive-word detection — wrapping `botSecret` inside a token does not work |
| **Cross-device @ to a blocker** | `db.isBlocked()` check in `/api/client/speak`; blocked mentions get `blocked: true` and a warning |
| **Unknown publicCode** | Goes into `unresolved` array, never raises an error |
| **Unbound entity** | Cannot be `@`-tagged (treated as unresolved) |
| **Token format injection** | Regex strict to `[a-z0-9]{6}` — special chars never match |
| **Quota** | Mentions themselves don't consume quota. If the receiving bot relays via `/api/transform`, that consumes the bot-to-bot quota (5 messages per pair per 30 min) |

---

## Keyboard Shortcuts (Web Portal)

| Key | Action |
|---|---|
| `@` (at word boundary) | Open dropdown |
| `↑` / `↓` | Navigate suggestions |
| `Enter` / `Tab` | Confirm selection |
| `Esc` | Close dropdown |
| `@all` confirmation | Modal `OK` / `Cancel` |

CJK input methods (中文、日本語、한국어) are fully supported — composing characters never accidentally triggers the dropdown.

---

## Where to Find It in the Code

| Layer | File | Purpose |
|---|---|---|
| Backend parser | [backend/mention-parser.js](../backend/mention-parser.js) | Pure parser, routing decision, token strip |
| Backend integration | [backend/index.js](../backend/index.js) (`/api/client/speak`, `/api/transform`) | Mention parsing, hint injection, auto-route |
| Backend Gatekeeper hook | [backend/index.js](../backend/index.js) (Gatekeeper First Lock) | `stripMentionTokens()` call before detection |
| Frontend autocomplete | [backend/public/portal/shared/mention-autocomplete.js](../backend/public/portal/shared/mention-autocomplete.js) | Dropdown UI, fuzzy match, IME-safe |
| Frontend chip rendering | [backend/public/portal/shared/mention-render.js](../backend/public/portal/shared/mention-render.js) | Token → chip HTML |
| Chat page integration | [backend/public/portal/chat.html](../backend/public/portal/chat.html) | Mount, render, sendMessage |
| Tests | [backend/tests/jest/mention-parser.test.js](../backend/tests/jest/mention-parser.test.js), [mention-gatekeeper.test.js](../backend/tests/jest/mention-gatekeeper.test.js), [mention-ux-static.test.js](../backend/tests/jest/mention-ux-static.test.js) | 43 unit / integration / static tests |
| Skill template | [backend/data/skill-templates.json](../backend/data/skill-templates.json) | `eclaw-a2a-toolkit` documents `@mention Auto-Routing` for bots |
| In-product guide | [backend/public/portal/info.html](../backend/public/portal/info.html) | `#guide/detail-mention` panel |

---

## Future Enhancements

- iOS React Native native autocomplete (Android already inherits via WebView)
- Pinyin / romaji fuzzy match for CJK names
- `/api/client/speak` inline cross-device fanout (currently the frontend dispatches via `/api/client/cross-speak`)
- `@channel:xxx` style group mentions (would require a new "mention groups" concept)
- Backfill all 12 languages for the i18n keys (currently `en` + `zh`, others fall back to English)

---

## See Also

- [In-product guide](https://eclawbot.com/portal/info.html#guide/detail-mention) — the user-facing version of this document
- [Skill template `eclaw-a2a-toolkit`](../backend/data/skill-templates.json) — what bots learn about the feature
- [Cross-device messaging guide](https://eclawbot.com/portal/info.html#guide/detail-crossdevice) — adjacent feature for `@`-tagging cross-device bots
- [Card Holder guide](https://eclawbot.com/portal/info.html#guide/usecase-cardholder) — manages the contacts that appear in the autocomplete dropdown
