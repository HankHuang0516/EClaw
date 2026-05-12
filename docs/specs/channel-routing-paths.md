# Channel Routing Paths

> Status: Implemented (Phase 1–4 complete as of 2026-05-12)
> Source proposal: `proposal_channel_key_on_transform.md` (distilled here)
> Related: PR #2285 (senderHint), PR #2299 (auto-router), channel-bot-context-parity-design (2026-03-07)

---

## Overview

EClaw supports **two distinct channel routing paths** for bridge-to-entity messaging. They serve different use cases and are both intentionally preserved.

---

## Path A — Thin-pipe: `/api/channel/message`

### Design intent

A simple, stateless relay. The bridge holds a `botSecret` and sends a single HTTP call. The server delivers the message and nothing more.

**Canonical use cases:**
- Discord webhook forwarders
- IoT sensor relays
- REST bridges with no LLM runtime
- Any integration that needs delivery only, no agent context

### What it does NOT provide

- `@`-mention auto-routing (server ignores mention tokens)
- A2A queue side-effects (`messageQueue`, `pendingA2A`)
- Entity `state` management
- `chatSource` audit trail showing the bridge identity

### Auth

```
channel_api_key + botSecret
```

### When Phase 0 auto-router was added (PR #2299)

Even this thin-pipe path gained minimal `senderHint`-based routing after PR #2299 backfilled an auto-router. This makes it viable for LLM bridges that cannot do channel registration — but it is still not the preferred path for LLM runtimes, because it lacks the full transform side-effect stack.

---

## Path B — Full-stack: `/api/transform` + `X-Channel-Key`

### Design intent

Let an LLM bridge act as the entity's runtime, with full access to the transform side-effect stack, without storing `botSecret` in the bridge process.

**Canonical use cases:**
- Claude Code bridge (`claude-code-eclaw-channel`)
- Codex CLI bridge (`codex-eclaw-bridge`)
- Hermes agent bridge
- Any LLM runtime that needs mention routing, A2A, or state management

### What it provides (on top of Path A)

| Feature | Detail |
|---|---|
| `@`-mention auto-routing | Server resolves `@N`, `@#N`, `@publicCode` tokens and fills `speakTo` |
| A2A queue side-effects | `messageQueue` writes, `pendingA2A` chaining |
| Entity `state` management | `state` parameter accepted and persisted (ACL: `state` permission) |
| `chatSource` audit trail | `entity:N:CHAR via:<channelName>` — visible in chat history |
| No `botSecret` in bridge | Bridge only holds `ECLAW_API_KEY`; server validates ACL per request |

### Auth

```
Header: X-Channel-Key: <ECLAW_API_KEY>
Body:   { "deviceId": "...", "entityId": N, "actAs": "channel", "message": "...", ... }
```

### ACL model

Channel registration (one-time, via `POST /api/channel/registrations`) defines which entities the bridge may act as, and which permissions each entity has:

```jsonc
{
  "allowedEntities": [
    { "entityId": 1, "permissions": ["speak", "state", "a2a"] },
    { "entityId": 2, "permissions": ["speak"] }
  ]
}
```

Permissions are checked per-request. A missing permission returns 403 with the specific missing capability.

---

## Decision Tree: Which path to use?

```
Does your bridge have an LLM runtime?
  YES → Does it need @-mention routing, A2A, or state?
          YES → Path B (transform + channelKey)        ← preferred
          NO  → Path A or Path B, both work
  NO  → Is it a pure relay (Discord, IoT, REST forwarder)?
          YES → Path A (channel/message)               ← appropriate
          NO  → Path B still works if you do registration
```

**Short rule:** LLM bridge → Path B. Pure relay → Path A.

---

## Evolution history

| Phase | When | What happened |
|---|---|---|
| Pre-Phase 0 | Before 2026-03 | Only Path A existed. LLM bridges stored botSecret and called `/api/channel/message`. |
| Phase 0 | 2026-03-07 | channel-bot-context-parity-design proposed; senderHint added to Path A (PR #2285); auto-router backfilled (PR #2299). |
| Phase 1 | 2026-03 | Path B designed and implemented: `channel_registrations` table, ACL, `X-Channel-Key` auth on `/api/transform`. |
| Phase 2 | 2026-04 | Bridge-side opt-in: `ECLAW_PREFER_TRANSFORM_VIA_CHANNEL_KEY=true` in claude-code-eclaw-channel. |
| Phase 3 | 2026-04–05 | Monitoring: `chatSource via:` adoption rate, ACL deny events tracked. |
| Phase 4 | 2026-05-12 | Documentation convergence. Path A marked `legacy thin-pipe` in skill templates. Path B documented as default for LLM bridges. No deprecation of Path A (third-party integrators protected). |

---

## Why Path A was NOT deprecated

Three reasons:

1. **Thin-pipe use case is legitimate** — Discord webhooks, IoT integrations, simple REST forwarders do not need the full transform stack.
2. **Phase 0 auto-router (PR #2299)** backfilled enough routing capability to make Path A viable even for simple LLM bridges that skip channel registration.
3. **Third-party integrators** rely on the stable `channel_api_key + botSecret` contract. Breaking it has ecosystem cost with no proportional benefit.

---

## Related documents

- `proposal_channel_key_on_transform.md` — original design proposal (now archived here in distilled form)
- `channel-bridge.md` — channel bridge spec
- `docs/plans/channel-bot-context-parity-design.md` — original context parity design
