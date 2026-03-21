# Shareable Chat Link + QR Code

## Overview
Add a shareable public URL + QR code for each entity, accessible from the Card Holder. The URL opens a chat interface that works for both registered and unregistered users.

## URL Format
```
https://eclawbot.com/c/<publicCode>
```
Example: `https://eclawbot.com/c/abc123` (25 chars total — shortest possible with the domain)

## Architecture

### 1. Backend Route (`GET /c/:code`)
In `backend/index.js`, add a route that serves `share-chat.html` for any valid publicCode.

```js
app.get('/c/:code', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/portal/share-chat.html'));
});
```

### 2. New Page: `backend/public/portal/share-chat.html`
A standalone chat page that:
- Extracts `code` from URL path (`/c/abc123`)
- Calls `GET /api/entity/lookup?code=abc123` to display entity info (name, avatar, agent card)
- Detects auth state via `GET /api/auth/me` (cookie check)

**Three UI States:**

| State | Entity Selector | Message Behavior |
|-------|----------------|-----------------|
| Not logged in | "本人" only (disabled selector) | On send → registration modal popup |
| Logged in, unverified | "本人" only | Messages show grey + "需要驗證信箱" subtitle; queued in DB |
| Logged in, verified | "本人" + own entities dropdown | Normal cross-speak |

### 3. Pending Message Queue (unverified users)

**New DB table**: `pending_cross_messages`
```sql
CREATE TABLE IF NOT EXISTS pending_cross_messages (
  id SERIAL PRIMARY KEY,
  sender_device_id TEXT NOT NULL,
  sender_entity_id INT DEFAULT -1,  -- -1 = "本人" (owner)
  target_code TEXT NOT NULL,
  text TEXT NOT NULL,
  media_type TEXT,
  media_url TEXT,
  created_at BIGINT NOT NULL
);
```

**New endpoint**: `POST /api/chat/pending-cross-speak`
- Requires JWT cookie (registered but unverified OK)
- Saves message to `pending_cross_messages`
- Returns `{ success: true, pendingId, status: "pending_verification" }`

**Flush on verification**: In `GET /api/auth/verify-email` handler, after setting `email_verified = true`:
1. Query `pending_cross_messages WHERE sender_device_id = user.deviceId`
2. For each pending message, execute the cross-speak logic (resolve target, queue to entity, save chat history, push webhook)
3. Delete flushed rows
4. Redirect to `/portal/index.html?verified=true` (existing behavior)

### 4. Share UI on Card Holder

On `card-holder.html`, add a "Share" button per entity card that opens a modal with:
- **Short URL**: `https://eclawbot.com/c/<publicCode>` with copy button
- **QR Code**: Generated client-side via `qrcode-generator` (no npm dependency — use CDN or inline lib)
- Copy QR as image button
- Download QR as PNG button

### 5. QR Code Generation
Use a lightweight client-side QR library. Options:
- **Inline minimal QR encoder** (~3KB minified, no external dependency)
- Or CDN: `https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.min.js`

Generate SVG/Canvas QR on the fly when the share modal opens.

## File Changes

| File | Change |
|------|--------|
| `backend/index.js` | Add `GET /c/:code` route; add `POST /api/chat/pending-cross-speak`; modify verify-email to flush pending messages |
| `backend/auth.js` | Modify verify-email handler to call pending message flush callback |
| `backend/db.js` | Add `pending_cross_messages` table creation |
| `backend/public/portal/share-chat.html` | **NEW** — shareable chat page |
| `backend/public/portal/card-holder.html` | Add share button + modal with URL + QR |
| `backend/data/skill-templates.json` | Add new endpoints to `eclaw-a2a-toolkit` |

## Flow Diagrams

### Unregistered User Flow
```
Visit /c/abc123
  → Lookup entity info (public)
  → Show chat UI (sender: "本人", no selector)
  → User types message, clicks send
  → Registration modal appears (email + password)
  → User registers → POST /api/auth/register
  → JWT cookie set, page reloads state
  → Message appears grey + "需要驗證信箱"
  → Message saved to pending_cross_messages
  → User verifies email (link in email)
  → Backend flushes pending messages via cross-speak
  → Next visit: messages render normally
```

### Registered User Flow
```
Visit /c/abc123
  → Lookup entity info (public)
  → GET /api/auth/me → user authenticated
  → GET /api/entities → show entity selector + "本人"
  → User picks sender entity, types message
  → POST /api/client/cross-speak (normal flow)
  → Real-time chat via Socket.IO
```

## Brainstorm: Edge Cases & Conflicts

1. **publicCode is null for unbound entities** — Share button only shows for entities with publicCode (bound entities). Card Holder already only shows bound entities, so this is fine.

2. **Rate limiting** — Cross-device settings (blacklist, whitelist, rate_limit) apply normally. Unverified pending messages are rate-checked at flush time.

3. **Gatekeeper** — Pending messages go through Gatekeeper at flush time, not at queue time. This prevents circumventing security.

4. **Entity goes offline/unbinds between queue and flush** — At flush time, if target entity no longer exists, skip the message (mark as failed, don't retry).

5. **Multiple pending messages** — User can queue multiple messages before verifying. All flushed in order on verification.

6. **Browser state after registration** — After inline registration, page should update to show the grey messages without full reload. Use JS state management.

7. **"本人" sender identity** — When sending as owner (not an entity), `fromEntityId = -1` or use client/cross-speak which doesn't require a bound entity. The existing `/api/client/cross-speak` already supports owner-as-sender.

8. **SEO** — The `/c/:code` page should have proper meta tags for link previews (OG tags with entity name/avatar).

## Testing Plan
- Jest test: pending-cross-speak endpoint validation
- Integration test: full flow (register → queue → verify → flush)
- Card Holder share button UI test
