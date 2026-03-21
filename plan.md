# Fix: Cross-Device Message Routing Control

## Problem

When a channel-bound bot receives a cross-device message, **every subsequent reply** from that bot gets auto-routed to the cross-device sender — the bot has no control over this.

**Root cause**: `entity.messageQueue.findLast(m => m.crossDevice)` always finds the same cross-device message because:
1. Channel bots never poll (`POST /api/bot/pending-messages`), so the queue is never cleared
2. Neither `/api/transform` nor `/api/channel/message` consume (remove) the cross-device message after auto-routing
3. There's no field for bots to specify `targetDeviceId` or opt-out of auto-routing

**Impact**: ALL messages from the bot get forwarded to the cross-device sender, not just the intended reply.

---

## Solution: Consume + Optional `targetDeviceId`

### Change 1: Consume cross-device message after auto-route

After auto-routing a reply, **remove the consumed cross-device message** from the queue so it doesn't trigger again.

**Files**:
- `backend/index.js` (~line 3055-3073) — `/api/transform`
- `backend/channel-api.js` (~line 601-641) — `/api/channel/message`

**Logic** (both endpoints, identical):
```javascript
// AFTER auto-route save + notify:
const crossIdx = entity.messageQueue.findLastIndex(m => m.crossDevice);
if (crossIdx >= 0) {
    entity.messageQueue.splice(crossIdx, 1);
}
```

**Behavior change**:
- Before: Every reply triggers auto-route → sender gets ALL messages
- After: Only the FIRST reply after each cross-device message triggers auto-route → one reply per incoming cross-device message

### Change 2: Add optional `targetDeviceId` to `/api/channel/message` and `/api/transform`

Allow bots to **explicitly specify** which device to route their reply to.

**Files**:
- `backend/index.js` — `/api/transform` endpoint
- `backend/channel-api.js` — `POST /message` endpoint

**New optional field**: `targetDeviceId` (string)

**Routing priority**:
```
1. if (targetDeviceId specified) → route to that device, skip auto-route
2. else if (pendingCross in queue) → auto-route + consume (Change 1)
3. else → local only (no cross-device routing)
```

**Implementation for both endpoints**:
```javascript
const { targetDeviceId } = req.body; // new optional field

if (targetDeviceId) {
    // Explicit routing — bot controls the target
    const targetDevice = devices[targetDeviceId];
    if (targetDevice) {
        saveChatMessage(targetDeviceId, 0, message, replySource, false, true);
        // Notify target device
        notifyDevice(targetDeviceId, { ... }).catch(() => {});
        serverLog('info', 'cross_speak_push', `[EXPLICIT_ROUTE] ...`);
    }
    // Do NOT consume queue — explicit routing is independent
} else if (hasCrossRoute) {
    // Auto-route (existing logic) + consume
    saveChatMessage(pendingCross.fromDeviceId, senderEntityId, message, replySource, false, true);
    // ... notify ...
    // Consume the cross-device message
    const crossIdx = entity.messageQueue.findLastIndex(m => m.crossDevice);
    if (crossIdx >= 0) entity.messageQueue.splice(crossIdx, 1);
}
```

### Change 3: Include `fromDeviceId` in channel push payload

When the server pushes a `cross_device_message` to a channel bot, ensure `fromDeviceId` is in the payload so the bot can use it as `targetDeviceId` later.

**Files**: `backend/index.js` — entity cross-speak (line 5313-5330), client cross-speak (line 6234-6250)

**Status**: `fromDeviceId` already exists in the client cross-speak payload (line 6246) but is **missing** from the entity cross-speak payload (lines 5313-5330). Need to add it.

### Change 4: Update `eclaw-a2a-toolkit` skill template

Add `targetDeviceId` documentation to the skill template so bots know they can use it.

**File**: `backend/data/skill-templates.json` — `eclaw-a2a-toolkit` entry

---

## Affected Code Paths

| File | Lines | Change |
|------|-------|--------|
| `backend/index.js` | ~3055-3073 | Add consume + targetDeviceId to transform |
| `backend/index.js` | ~5313-5330 | Add `fromDeviceId` to entity cross-speak channel payload |
| `backend/channel-api.js` | ~557-673 | Add consume + targetDeviceId to channel message |
| `backend/data/skill-templates.json` | eclaw-a2a-toolkit | Document targetDeviceId |

## Existing Tests to Update

| Test File | What to Update |
|-----------|---------------|
| `backend/tests/jest/transform-cross-route.test.js` | Add tests: consume after route, targetDeviceId explicit routing |
| `backend/tests/jest/cross-speak-channel.test.js` | Add tests: channel message consume, targetDeviceId |

## New Regression Test

| Test | File | Description |
|------|------|-------------|
| Cross-device routing control | `backend/tests/jest/channel-cross-route.test.js` | Channel bot: auto-consume, targetDeviceId, multiple cross-device messages |

---

## Risk Assessment

- **Breaking change?**: No — `targetDeviceId` is optional, default behavior just adds consumption (which fixes the bug)
- **Backward compat**: Bots that don't send `targetDeviceId` get improved behavior (one-reply-per-message instead of infinite routing)
- **Edge case**: Bot that intentionally wants to send multiple replies to cross-device sender → they should use `targetDeviceId` explicitly for the 2nd+ reply
- **Queue integrity**: `splice` only removes the specific consumed message, not the entire queue
