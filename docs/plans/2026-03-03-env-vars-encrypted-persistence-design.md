# Env Vars Encrypted Persistence + JIT Approval

**Date:** 2026-03-03
**Issue:** [#121](https://github.com/HankHuang0516/realbot/issues/121) — Env vars lost after 30-min cache TTL
**Status:** Design approved, pending implementation

---

## Problem

Env vars are stored only in browser localStorage / Android EncryptedSharedPreferences, synced to a server in-memory `Map` with 30-minute TTL. After TTL expires (or server restart), bots get empty vars. No encryption at rest.

## Solution: Approach B — JIT + 5-min Approval Cache

Encrypt env vars in PostgreSQL with AES-256-GCM. Bot access requires real-time user approval via Socket.IO popup. After approval, cache the "approved" state for 5 minutes to reduce popup frequency.

---

## 1. Data Layer

### DB Schema — `device_vars` table

```sql
CREATE TABLE IF NOT EXISTS device_vars (
    device_id       TEXT PRIMARY KEY REFERENCES devices(device_id) ON DELETE CASCADE,
    encrypted_vars  TEXT NOT NULL,         -- AES-256-GCM ciphertext (base64)
    iv              TEXT NOT NULL,         -- initialization vector (hex, 12 bytes)
    auth_tag        TEXT NOT NULL,         -- GCM authentication tag (hex, 16 bytes)
    var_keys        TEXT[] DEFAULT '{}',   -- plaintext key names (for push hints, no decryption needed)
    is_locked       BOOLEAN DEFAULT FALSE, -- lock state (replaces client-side-only lock)
    updated_at      BIGINT NOT NULL        -- timestamp ms
);
```

### Encryption

- **Algorithm:** AES-256-GCM (authenticated encryption)
- **Key:** `SEAL_KEY` env var — 32-byte hex string, generated once via `crypto.randomBytes(32).toString('hex')`
- **IV:** Fresh random 12 bytes per write
- **Plaintext:** `JSON.stringify({ KEY: VALUE, ... })`
- **Node.js:** `crypto.createCipheriv('aes-256-gcm', key, iv)` / `crypto.createDecipheriv(...)`

### In-memory approval cache

```javascript
const varsApprovalCache = new Map();
// deviceId -> { approvedAt: number, expiresAt: number }
// TTL: 5 minutes from approval time
```

### Removal

The existing `deviceVarsCache` Map and its `setInterval` cleanup are **removed entirely**.

---

## 2. JIT Approval Flow

### Sequence

```
Bot                    Server                   Portal/App (Socket.IO)
 |                       |                           |
 | GET /api/device-vars  |                           |
 |---------------------->|                           |
 |                       | 1. locked? -> 403         |
 |                       | 2. approval cache valid?  |
 |                       |    -> decrypt & return     |
 |                       | 3. Socket.IO room empty?  |
 |                       |    -> 403 owner_offline    |
 |                       |                           |
 |                       | emit vars:approval-request|
 |                       |-------------------------->|
 |                       |                           | Show popup
 |                       |                           | (3s cooldown)
 |                       |                           | User confirms
 |                       | vars:approval-response    |
 |                       |<--------------------------|
 |                       |                           |
 |                       | Decrypt from DB           |
 |                       | Set approval cache (5min) |
 | 200 { vars: {...} }   |                           |
 |<----------------------|                           |
```

### Key behaviors

| Scenario | Result |
|---|---|
| Vars locked | `403 { error: 'locked', message: 'Variables are locked by owner' }` |
| Approval cache valid (< 5min) | Decrypt from DB, return immediately |
| No Socket.IO client connected | `403 { error: 'owner_offline', message: 'Device owner is not online' }` |
| User approves | Decrypt, return, cache approval for 5 min |
| User denies | `403 { error: 'denied', message: 'Access denied by owner' }` |
| 60s timeout, no response | `408 { error: 'timeout', message: 'Approval request timed out' }` |
| Duplicate pending request | Queue — only one popup at a time per device |

### Pending request tracking

```javascript
const varsApprovalPending = new Map();
// deviceId -> { requestId, resolve, reject, timer }
```

Prevents multiple simultaneous popups for the same device. If a second bot request arrives while one is pending, it waits for the same approval result.

---

## 3. Write Path (Save Flow)

### Before (current)

Portal -> localStorage -> `POST /api/device-vars` -> in-memory Map (30min TTL)

### After (new)

Portal -> localStorage (kept as local cache) -> `POST /api/device-vars` -> encrypt + upsert DB

### Endpoint changes

**`POST /api/device-vars`** — Save vars
- Auth: `deviceId` + `deviceSecret` (unchanged)
- Body: `{ deviceId, deviceSecret, vars: { KEY: VALUE }, locked?: boolean }`
- New: encrypt vars with SEAL_KEY -> upsert `device_vars` table
- New: extract key names -> store in `var_keys` column
- New: store `locked` flag if provided
- Response: `{ success: true, count: N }` (unchanged)

**`GET /api/device-vars`** — Bot reads vars
- Auth: `deviceId` + `botSecret` (unchanged)
- New: JIT approval flow (see Section 2)

**`DELETE /api/device-vars`** — Clear vars
- Auth: `deviceId` + `deviceSecret` (unchanged)
- New: delete row from `device_vars` + clear approval cache

### Lock mechanism

- Lock: `POST /api/device-vars` with `{ vars: {}, locked: true }`
  - Stores empty encrypted blob + `is_locked = true`
- Unlock: `POST /api/device-vars` with real vars + `locked: false`
  - Re-syncs from localStorage, `is_locked = false`
- When locked, bot requests are **immediately rejected** (no popup)

---

## 4. Push Notification Integration

In `pushToBot()`, replace the `deviceVarsCache` check with:

1. Query `device_vars` for existence + lock status (lightweight `SELECT var_keys, is_locked FROM device_vars WHERE device_id = $1`)
2. If exists and not locked, append to push message:
   ```
   [Local Variables available: KEY1, KEY2]
   Note: Reading vars requires owner approval (60s timeout).
   exec: curl -s ".../api/device-vars?deviceId=...&botSecret=..."
   ```
3. If locked or no row, don't append

The `var_keys` column avoids decrypting the full blob just to list key names.

---

## 5. Frontend — Web Portal

### Approval popup (in `shared/socket.js`)

Added to all Portal pages via the shared Socket.IO handler:

```javascript
portalSocket.on('vars:approval-request', (data) => {
    // data = { requestId, entityName, varKeys, expiresAt }
    showVarsApprovalDialog(data);
});
```

### Approval dialog UI

- Full-screen overlay with blur backdrop
- Title: "Bot '{entityName}' wants to read your variables"
- Lists var key names (not values)
- "Allow" button: disabled for 3 seconds (countdown: "Allow (3s)" -> "Allow (2s)" -> "Allow")
- "Deny" button: always enabled
- Auto-dismiss at 60s with auto-deny
- Emits: `portalSocket.emit('vars:approval-response', { requestId, approved: true/false })`

### Lock toggle

Behavior unchanged from user perspective. Backend call now includes `locked: true/false` flag.

### env-vars.html changes

- `syncVarsToServer()` now always sends real vars (lock state is a separate flag, not `{}`)
- Remove the pattern of sending `{}` when locked

---

## 6. Frontend — Android App

### Socket.IO listener

In `MissionControlActivity` (or a dedicated service):
- Listen for `vars:approval-request` event
- Show Material 3 AlertDialog with same content as web
- 3-second button countdown
- Emit response via Socket.IO

### Background handling

If app is not in foreground:
- Show notification that navigates user to approval screen in-app
- User must open app to see context and approve (more secure than action buttons)

### Feature parity with Web

- Save vars to server (encrypt + DB)
- Lock toggle
- JIT approval popup
- 3-second cooldown on approve button

---

## 7. Migration Plan

1. **DB migration:** Create `device_vars` table (auto-run on startup via `db.js`)
2. **Generate SEAL_KEY:** `crypto.randomBytes(32).toString('hex')` -> add to Railway env vars
3. **Deploy:** Existing in-memory cache data is lost (acceptable — users re-sync on next Portal visit)
4. **Remove:** `deviceVarsCache` Map, its `setInterval` cleanup, and `mission.html`'s duplicate `syncVarsToServer()`
5. **Backward compat:** None needed — env vars are ephemeral by nature, no data to migrate

---

## 8. Security Considerations

- **Encryption at rest:** Vars encrypted with AES-256-GCM in DB; SEAL_KEY in env var only
- **No plaintext values in DB:** Only key names are stored plaintext (for push hints)
- **User-in-the-loop:** Every bot access requires explicit human approval (or cached approval within 5 min)
- **3-second cooldown:** Prevents accidental approval
- **Lock = immediate deny:** No popup, no waiting
- **Offline = immediate deny:** Bot cannot access vars without owner present
- **GCM auth tag:** Prevents tampering with encrypted data

## 9. Files to modify

| File | Changes |
|---|---|
| `backend/db.js` | Add `device_vars` table creation + CRUD helpers |
| `backend/index.js` | Replace `deviceVarsCache` with DB ops + JIT approval flow |
| `backend/public/portal/shared/socket.js` | Add `vars:approval-request` listener + dialog |
| `backend/public/portal/env-vars.html` | Update save/lock to use new API fields |
| `backend/public/portal/mission.html` | Remove duplicate `syncVarsToServer()`, use shared version |
| `app/.../MissionControlActivity.kt` | Add Socket.IO approval dialog |
| `backend/E-claw_mcp_skill.md` | Update env vars documentation for bots (approval flow, timeout, error codes) |
| `backend/public/portal/env-vars.html` | Add user-facing info section explaining encryption + JIT approval logic |
