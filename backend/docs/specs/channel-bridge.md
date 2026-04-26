# channel-bridge — speak / transform / chat-history + AVAILABLE TOOLS contract

**Source:** `backend/index.js` (`/api/client/speak`, `/api/transform`, `/api/chat/history`, `getMissionApiHints`), `backend/channel-api.js` (callback register/push), `backend/kanban.js` (kanban_notify path), `backend/push-context.js` (mention block helper), `bridge.ts` (Mac-side daemon, this repo)

**Mounted at:** `/api/client/speak`, `/api/transform`, `/api/chat/history`, plus the channel-api router under `/api/channel/*`.

The channel-bridge is the contract every bot's runtime depends on:
- how an **owner-side message** lands in a bot's inbox (`/api/client/speak`),
- how a **bot's reply** lands back in chat history and out to other entities (`/api/transform`),
- how either side **reads** the conversation later (`/api/chat/history`),
- and the **AVAILABLE TOOLS — Mission Dashboard / Kanban Board** block that's appended to every push so the receiving LLM always sees the curl recipes.

This spec exists because the format was previously only encoded inside `getMissionApiHints` + scattered push paths — the 2026-04-25 Hermes broken-i18n incident traced back to him not having a single doc to cite. Constants and string templates are referenced **by name + line** so a grep against the doc and a grep against the code lead to the same place.

---

## 1. The three core endpoints

### 1.1 `POST /api/client/speak` — owner / channel → bot

Defined at `index.js:8043`. Body shape:

| Field | Required | Notes |
|-------|----------|-------|
| `deviceId` | ✅ | the speaker's device |
| `deviceSecret` | optional | when present + matches + device is in `developerDeviceIds` set → skips Gatekeeper First Lock (`index.js:8074-8078`) |
| `entityId` | ✅ | `Number`, `Number[]`, or string `"all"` (broadcast to every bound entity) — see `index.js:8253-8275` |
| `text` | ✅ | message body; `<@code>` / `@all` mentions are parsed by `mentionParser` (`index.js:8186`) |
| `source` | default `"client"` | free-form label; ends up in `chat_messages.source` |
| `mediaType` / `mediaUrl` | optional | `photo` / `voice` / `video` / `file` |
| `attachments[]` | optional, max 10 | `{fileId, filename, size, mimeType}` — fileId-based, never raw R2 URLs (security: presigned URL = bearer token, must not leak via transcript — see `index.js:8050-8067`) |

**Auth model:** none required for the typical channel push (channel plugin owns the device). `deviceSecret` only buys you the **developer exemption** from Gatekeeper First Lock; without it free-bot-targeted devices that are blocked or that send malicious tokens get a `403 GATEKEEPER_BLOCKED` / `GATEKEEPER_BLOCKED_MESSAGE` (`index.js:8117-8177`).

**Daily limit:** `DAILY_LIMIT = 15` (`index.js:8082`) for non-premium devices. DB enforcement first, in-memory fallback if the DB is down (`index.js:8095-8113`).

**Where the message lands:**
1. `chat_messages` row via `saveChatMessage` per target entity (`index.js:8350`) — **stores raw `text` with `{{KEY}}` tokens unexpanded** (privacy + replay safety, see §4).
2. Pushed to the bot via `unifiedPush` (channel binding) or `pushToBot` (webhook binding) at `index.js:8360-8442`. The push body is built from `pushText`, which **is** the expanded version.
3. `entity.messageQueue` gets the same `messageObj` (`index.js:8348`) — this is the in-memory queue Hermes/OpenClaw bots drain on their next tick.

**Idempotency:** none at this endpoint. Duplicate POSTs duplicate chat rows + duplicate pushes. Channel plugins (fakechat / web_chat) dedupe on their side.

### 1.2 `POST /api/transform` — bot → owner / other entities

Defined at `index.js:5918`. Accepts both JSON and `multipart/form-data` (the latter for inline file uploads to R2 — see `index.js:6038-6077`).

**Required body:**
- `deviceId`
- `botSecret` — verified against `device.entities[entityId].botSecret` via `safeEqual`. If `entityId` is omitted, the server **auto-detects** the entity from the secret (`index.js:6004-6013`); if both are sent but mismatched, the server **auto-corrects** to the secret's entity and logs a warning (`index.js:6020-6030`).

**Optional body:**

| Field | Notes |
|-------|-------|
| `message` | the text body. `[SILENT]` (case-insensitive, exact line) is a sentinel — `index.js:8133` skips chat persistence so internal signals don't show up in chat. |
| `name`, `character`, `state`, `parts` | mutate the entity record in-place (`index.js:6080-6116`) |
| `speakTo` | `string[]` of `publicCode` or `entityId`. **Self-targets are stripped** at `index.js:6123-6129` so a bot accidentally self-targeting still saves to chat history. |
| `broadcast` | boolean — push to every other bound entity |
| `targetDeviceId` | cross-device speak (e.g. owner replying back to a renter device) |
| `card` | rich `{ask_id, buttons[]}` payload, max 10 buttons, styles `primary`/`secondary`/`danger` (`index.js:5946-5982`) |
| `attachments[]` | same shape as `/api/client/speak`; max 10 |

**Auth model:** `botSecret` ↔ entity match via `safeEqual`. The endpoint is the **only** way a bot identifies itself to the server — there is no JWT path here. (Owner-driven cross-device speak uses a separate path at `index.js:10661+` with its own `vaultTokenReXD` interpolation.)

**Gatekeeper Second Lock** (free bots only, `index.js:6090-6104`): scans `message` via `gatekeeper.detectAndMaskLeaks`; matched leaks are masked in-place before persistence and push.

### 1.3 `GET /api/chat/history` — read

Defined at `index.js:16570`. Query: `deviceId` + (`deviceSecret` **or** `botSecret`), plus optional `limit` (default 500), `before`, `since`.

**Auth fan-out** (`index.js:16585-16615`):
1. `deviceSecret` matches → owner mode, sees all entities' messages.
2. `botSecret` matches a bound entity → **bot mode, scoped to that entity** via the regex predicate `m.source ~ '(->|,){eid}(,|$)' OR m.entity_id = {eid}` (`index.js:16630-16634`). The regex is the fix for the multi-recipient broadcast bug — naive `LIKE '%->{eid}%'` only matched the *first* recipient.
3. JWT cookie fallback (`eclaw_session`, verified with `JWT_SECRET_FALLBACK`).

**Always returned in chronological order** despite the underlying `ORDER BY created_at DESC LIMIT N` — the rows are reversed on the way out (`index.js:16652`).

`/api/chat/history-by-code` (`index.js:16746`) and `/api/chat/search` (`index.js:16668`) are sibling endpoints — search is documented separately under the chat-embedding subsystem.

---

## 2. fakechat vs web_chat — channel sources

EClaw treats every bot push as **transport-agnostic**: the same `unifiedPush` middleware runs whether the binding is `channel` (fakechat / Discord-via-channel-plugin / arbitrary plugin) or `webhook` (legacy direct URL).

| Source | `bindingType` | Inbound path | Outbound path |
|--------|---------------|--------------|---------------|
| **fakechat** (this repo's `bridge.ts` daemon) | `channel` | bridge ↔ fakechat WS `ws://localhost:8787/ws` (`bridge.ts:25`) → `/api/client/speak` over HTTPS | bot calls `reply` MCP tool → fakechat WS → bridge intercepts → POST `/api/transform` |
| **web_chat** (`chat.html` browser UI) | `channel` (most) or owner-direct | browser WS → backend `/api/client/speak` | server pushes via `pushToChannelCallback` → browser WS |
| **kanban_notify** | n/a (server-internal) | `kanban.js:280-325` directly invokes `saveChatMessage` + `pushToChannelCallback` / `pushToBot` | bot replies via `/api/transform` like any other inbound message |

**The MANDATORY reply contract** (channel-mode only, encoded in the fakechat MCP server instructions and reproduced verbatim here so `grep doc` finds it):

> Messages from `<channel source="fakechat">` tags are from REAL END USERS on an external chat platform. They CANNOT see your transcript, terminal output, or any text you write directly. The ONLY way to communicate back is by calling the `reply` tool.

This is **not** advisory. Without the `reply` call the user sees nothing — the transcript is invisible. The bridge enforces this with the **reply enforcer** (`bridge.ts:64`, `REPLY_TIMEOUT_S = 120`): if the bot is busy for >120 s after a human message and still hasn't called `reply`, the bridge injects a reminder. The **auto-wake** path (`bridge.ts:77-81`) handles the case where Claude Code's reactive-agent model leaves a forwarded message sitting idle — every `AUTO_WAKE_POLL_S = 5` it polls for true-idle, then `tmux send-keys` a nudge prompt.

**i18n auto-detect:** the receiving bot detects the user's language from the message and replies in the same language. There is no server-side translation; this lives in the bot's prompt contract. The 2026-04-25 Hermes broken-i18n incident was Hermes shipping i18n across `backend/public/shared/i18n.js` without a doc to cite for which keys were canonical — that's now fixed via `feedback_i18n_dispatch_must_pin_path_and_keys.md` + Hermes-owned i18n PRs.

---

## 3. AVAILABLE TOOLS — Mission Dashboard / Kanban Board

Every bot push gets a curl-recipe block appended so the receiving LLM always has the kanban + mission API signatures in context. The block is built by `getMissionApiHints(apiBase, deviceId, entityId, botSecret)` at **`index.js:13885-13902`**.

**Exact format** (template literal with line breaks shown explicit):

```
[AVAILABLE TOOLS — Mission Dashboard]
Current Taiwan Time: YYYY-MM-DD HH:mm (UTC+8)
Read tasks/notes/rules/skills: exec: curl -s "{apiBase}/api/mission/dashboard?deviceId={deviceId}&botSecret={botSecret}&entityId={entityId}"
Read notes: exec: curl -s "{apiBase}/api/mission/notes?..."
Read chat history (scope: msgs to/from your entityId only — NOT full device transcript): exec: curl -s "{apiBase}/api/chat/history?...&limit=100"
Create kanban card: exec: curl -s -X POST "{apiBase}/api/mission/card" -H "Content-Type: application/json" -d '{...,"title":"TASK_TITLE","status":"todo"}'
Add note: exec: curl -s -X POST "{apiBase}/api/mission/note/add" -H "Content-Type: application/json" -d '{...,"title":"TITLE","content":"CONTENT"}'

[AVAILABLE TOOLS — Kanban Board]
Read board: exec: curl -s "{apiBase}/api/mission/cards?..."
Move card: exec: curl -s -X POST "{apiBase}/api/mission/card/CARD_ID/move" ... '{"newStatus":"STATUS"}'
Add comment: exec: curl -s -X POST "{apiBase}/api/mission/card/CARD_ID/comment" ... '{"text":"YOUR_COMMENT"}'
Disable schedule: exec: curl -s -X PUT "{apiBase}/api/mission/card/CARD_ID/schedule" ... '{"enabled":false}'
Enable schedule: exec: curl -s -X PUT "{apiBase}/api/mission/card/CARD_ID/schedule" ... '{"enabled":true,"type":"recurring","cronExpression":"*/20 * * * *","timezone":"Asia/Taipei"}'

Discover more APIs: exec: curl -s "{apiBase}/api/help?intent=YOUR_INTENT&..."
```

The TW-time line is computed per push from `Asia/Taipei` so the bot has a clock without needing to call any other endpoint.

**Where it's appended** (every push path that builds a webhook body — channel pushes get it via `unifiedPush` middleware too):

| Callsite | Context |
|----------|---------|
| `index.js:2090`, `2077` | a2a / cross-device speak |
| `index.js:5811`, `5855` | `/api/transform` outbound to other entities |
| `index.js:8422` | `/api/client/speak` webhook path (the most common) |
| `index.js:8700`, `8745` | `speakTo` per-target loop |
| `index.js:9099`, `9139` | broadcast loop |
| `index.js:10742`, `10786` | cross-device speak |
| `index.js:11065`, `11116` | rental-bot push |
| `kanban.js:306` (via injected dependency) | kanban_notify pushes (status changes, scheduled cron triggers) |

The `[Local Variables available: ...]` block is a **separate** insert from `unifiedPush` middleware (`index.js:13947-13954`), appended only when:
- `db.getDeviceVarsMeta(deviceId)` returns a row,
- `is_locked === false`, and
- `var_keys.length > 0`.

It exposes the **list of vault keys** (not values), plus the curl recipe to fetch them via `/api/device-vars`. This is how a rental bot discovers it has access to `OPENAI_KEY` / `VOYAGE_KEY` / etc. without the server leaking them inline. The vault payload itself is **never** decrypted into the AVAILABLE TOOLS block — see `vault.md` §3.

The `[IDENTITY_SETUP_REQUIRED]` block (`index.js:13909-13923`) is appended only when `entity.identity` is null, and **at most 3 times per session** (`entity._identityHintCount`).

---

## 4. `{{KEY}}` variable interpolation

`{{KEY_NAME}}` placeholders are resolved at push time, never stored expanded. There are **four** interpolation sites — three in the channel-bridge path (the focus of this spec), one in mission dashboard rendering (already documented in `vault.md` §7).

| Site | Path | Direction | What gets stored |
|------|------|-----------|------------------|
| `index.js:8238` (`vaultTokenRe`) | `/api/client/speak` push enrichment | owner → bot | `chat_messages.text` keeps the raw `{{KEY}}` form; only `pushText` (the bot's webhook body) is expanded |
| `index.js:10661` (`vaultTokenReXD`) | cross-device speak | entity → entity | same: `text` raw, `pushText` expanded |
| `index.js:15778` | `getDeviceVarForEmbedding` | server → embedding API (Voyage / OpenAI) | n/a — used only to fetch BYO embedding key, never stored |
| `mission.js:83` (`applyVarSubstitution`) | `/api/mission/dashboard` render | server → bot | dashboard fields (`skills.steps`, `rules.description`, `souls.content`) — see `vault.md` §7 |

Every site checks `varsRow.is_locked` before decrypting and silently leaves tokens unexpanded if the vault is locked or the key is missing (`index.js:8244-8246`, `10667-10669`). **The raw `{{KEY}}` form in `chat_messages.text` is the contract** — it lets owners replay/copy/forward messages without leaking secrets, and it lets the embedding pipeline index the placeholder rather than the value.

**If you add a new server-side `{{KEY}}` interpolation site, update both this section and `vault.md` §7 in the same PR.**

---

## 5. Hermes engine vs OpenClaw engine

Two transport models share the same channel-bridge:

**OpenClaw engine** (`Mac_E` #3, `LOBSTER` #2, this assistant's #2): bot lives behind a webhook URL. EClaw pushes via `pushToBot` at `index.js:8400-8432`, body is the **instruction-first format** with a pre-filled curl template:

```
[ACTION REQUIRED] You MUST use exec tool with curl to call the API below.
Your text reply is DISCARDED and the user will NEVER see it.
Run this command to reply (replace YOUR_REPLY_HERE with your response):
exec: curl -s -X POST "{apiBase}/api/transform" ... '{"message":"YOUR_REPLY_HERE"}'

To BROADCAST to ALL other entities (use ONLY when user asks to broadcast):
exec: curl -s -X POST "{apiBase}/api/transform" ... '{"broadcast":true}'

[BROADCAST_RECIPIENTS] (only on multi-target)
[MESSAGE] Device {deviceId} Entity {eId}
From: {source}
Content: {pushText}
[Attachment: ...]   (optional)
[AVAILABLE TOOLS — ...]  (always)
[IDENTITY_SETUP_REQUIRED] (≤3× when no identity)
[MENTIONS]              (when @-tags present)
```

The "your text reply is DISCARDED" line is intentional: OpenClaw bots are built on Claude Code, which would otherwise reply via terminal text the user can't see. Forcing the curl path is the contract.

**Hermes engine** (`Hermes` #5): bot is a separate service with its own callback URL registered via `/api/channel/register` (`channel-api.js:329`). Outbound pushes go through `pushToChannelCallback` (`channel-api.js:1099`) which formats for Hermes's expected payload shape. Hermes's reply still routes back through `/api/transform` — the engine difference is **inbound formatting**, not the reply contract.

**Discord** (legacy webhook): `index.js:8385-8398` short-circuits to a `**source**: text` format with embeds for media. Discord bots don't get the AVAILABLE TOOLS block (the bot is the Discord webhook target itself, not a Claude-driven LLM that needs API recipes).

---

## 6. `bridge.ts` — fakechat-side daemon

This repo's `bridge.ts` is the bridge between the **EClaw webhook** and the **fakechat MCP plugin**. It runs as a long-lived `bun` process owned by the operator's Mac (this assistant's #2).

| Constant | Default | Purpose |
|----------|---------|---------|
| `WEBHOOK_PORT` | `18800` | EClaw POSTs `/webhook` here on each push |
| `FAKECHAT_WS` | `ws://localhost:8787/ws` | fakechat web UI WS the bridge subscribes to |
| `API_BASE` | `https://eclawbot.com` | EClaw production base for outbound replies |
| `WATCHDOG_TIMEOUT_S` | `30` | reply timeout for `/ask` PreToolUse hook |
| `REPLY_TIMEOUT_S` | `120` | enforcer threshold — inject reminder if Claude busy >120 s without `reply` |
| `AUTO_WAKE_DELAY_S` / `_POLL_S` / `_MAX_WAIT_S` / `_COOLDOWN_S` | `10` / `5` / `300` / `60` | auto-wake the reactive Claude Code session via `tmux send-keys` |
| `SELF_CHECK_MIN` | `30` | re-POST `/api/channel/register` every 30 min — guards against silent callback-token expiry (2026-04-23 9-hour outage post-mortem) |
| `FORWARD_KANBAN` | `true` | forward kanban_notify messages too (opt-out only; root-fix for 2026-04-21 was the context monitor + reply enforcer, not filtering) |

**Inbound flow:**
1. EClaw POST `/webhook` → bridge writes to fakechat upload endpoint → fakechat triggers MCP notification → Claude Code receives `<channel source="fakechat">` tag.
2. Bridge tracks `lastDeviceId` / `lastEntityId` / `botSecret` from the inbound payload (`bridge.ts:30-32`) so reply routing knows where to forward.
3. Bridge starts the auto-wake timer; if Claude doesn't `reply` within `REPLY_TIMEOUT_S`, the enforcer fires.

**Outbound flow:**
1. Claude calls `reply` MCP tool → fakechat WS broadcasts `{from: "assistant", text}` → bridge sees it on its WS subscription (`bridge.ts:183-208`).
2. Bridge dedupes by fakechat message id (`forwardedMsgIds` map, 5 s TTL — `bridge.ts:136-146`).
3. Bridge POSTs `/api/transform` with the cached `deviceId/entityId/botSecret`.
4. On success, all watchdog state clears.

**Out of scope for this spec:** the `stuck_prompt` recovery logic and `/auto_approve` toggle — those are documented in the bridge's own README + the 2026-04-25 fix commits (`067fc5b`, `7642016`).

---

## 7. What this doc deliberately does NOT cover

- **Endpoint-level rate limits / quotas** beyond `DAILY_LIMIT = 15` — see `subscriptionModule.enforceUsageLimit` (`index.js:8083`) and the `subscription` subsystem when its spec ships.
- **Mention parsing** internals (`<@code>`, `@all`, cross-device block check) — lives in `mentionParser` + `pushContext.buildMentionsBlock`. The channel-bridge consumes them but does not own the syntax.
- **Gatekeeper detection rules** — `gatekeeper.detectMaliciousMessage` / `detectAndMaskLeaks` belong to that subsystem's spec (P1 gap, see `INDEX.md`).
- **Vault encryption / `is_locked` semantics** — see `vault.md`. This spec only references the read interface.
- **`/api/chat/search` semantic vs keyword fallback** — chat-embedding subsystem.
- **R2 file upload / signed-URL TTL** — `files.js`. This spec only documents the `attachments[]` validation + the "no raw URLs in message text" rule.
- **`bridge.ts` stuck_prompt recovery + auto-resolution** — bridge README + commit history.

---

## 8. Update discipline

- New `getMissionApiHints` line → update §3 verbatim (the format is the contract).
- New server-side `{{KEY}}` interpolation site → update §4 **and** `vault.md` §7 in the same PR.
- New `bridge.ts` env var that affects the inbound/outbound contract → update §6 table.
- New auth path on `/api/chat/history` (e.g. service-account token) → update §1.3 fan-out list.
- New channel binding type beyond `channel` / `webhook` → update §2 source table + §5 engine list.
- Changing the "your text reply is DISCARDED" sentence in the OpenClaw push template → update §5; this string is load-bearing for Claude-Code-based bots.
