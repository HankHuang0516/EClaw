# Env Vars Encrypted Persistence + JIT Approval — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the ephemeral in-memory env vars cache (30-min TTL) with AES-256-GCM encrypted DB persistence and real-time JIT user approval via Socket.IO.

**Architecture:** Env vars are encrypted with a server-side `SEAL_KEY` and stored in a new `device_vars` PostgreSQL table. When a bot requests vars, the server emits a Socket.IO event to the device owner's Portal/App; the owner must explicitly approve (with a 3-second cooldown). Approved state is cached for 5 minutes to reduce popup frequency.

**Tech Stack:** Node.js `crypto` (AES-256-GCM), PostgreSQL, Socket.IO, Kotlin (Android Material 3 dialog)

**Design Doc:** `docs/plans/2026-03-03-env-vars-encrypted-persistence-design.md`

---

## Task 1: DB Schema + Crypto Helpers (`backend/db.js`)

**Files:**
- Modify: `backend/db.js:48-180` (createTables function)
- Modify: `backend/db.js:777-806` (module.exports)

**Step 1: Add `device_vars` table to `createTables()`**

After the `cross_device_contacts` index creation (line ~172), before the `console.log('[DB] Database tables ready')` at line 174, add:

```javascript
// Encrypted device variables (env vars vault)
await client.query(`
    CREATE TABLE IF NOT EXISTS device_vars (
        device_id       TEXT PRIMARY KEY REFERENCES devices(device_id) ON DELETE CASCADE,
        encrypted_vars  TEXT NOT NULL,
        iv              TEXT NOT NULL,
        auth_tag        TEXT NOT NULL,
        var_keys        TEXT[] DEFAULT '{}',
        is_locked       BOOLEAN DEFAULT FALSE,
        updated_at      BIGINT NOT NULL
    )
`);
```

**Step 2: Add CRUD helper functions**

Before the `module.exports` block (line ~777), add these functions:

```javascript
// ============================================
// Device Vars (Encrypted Vault)
// ============================================

async function upsertDeviceVars(deviceId, encryptedVars, iv, authTag, varKeys, isLocked) {
    if (!pool) return false;
    try {
        await pool.query(
            `INSERT INTO device_vars (device_id, encrypted_vars, iv, auth_tag, var_keys, is_locked, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (device_id)
             DO UPDATE SET encrypted_vars = $2, iv = $3, auth_tag = $4, var_keys = $5, is_locked = $6, updated_at = $7`,
            [deviceId, encryptedVars, iv, authTag, varKeys, isLocked, Date.now()]
        );
        return true;
    } catch (err) {
        console.error(`[DB] Failed to upsert device_vars for ${deviceId}:`, err.message);
        return false;
    }
}

async function getDeviceVars(deviceId) {
    if (!pool) return null;
    try {
        const result = await pool.query(
            'SELECT encrypted_vars, iv, auth_tag, var_keys, is_locked, updated_at FROM device_vars WHERE device_id = $1',
            [deviceId]
        );
        return result.rows[0] || null;
    } catch (err) {
        console.error(`[DB] Failed to get device_vars for ${deviceId}:`, err.message);
        return null;
    }
}

async function getDeviceVarsMeta(deviceId) {
    if (!pool) return null;
    try {
        const result = await pool.query(
            'SELECT var_keys, is_locked FROM device_vars WHERE device_id = $1',
            [deviceId]
        );
        return result.rows[0] || null;
    } catch (err) {
        console.error(`[DB] Failed to get device_vars meta for ${deviceId}:`, err.message);
        return null;
    }
}

async function deleteDeviceVars(deviceId) {
    if (!pool) return false;
    try {
        await pool.query('DELETE FROM device_vars WHERE device_id = $1', [deviceId]);
        return true;
    } catch (err) {
        console.error(`[DB] Failed to delete device_vars for ${deviceId}:`, err.message);
        return false;
    }
}
```

**Step 3: Export the new functions**

Add to `module.exports` at line ~806, before the closing `}`:

```javascript
    // Device vars (encrypted vault)
    upsertDeviceVars,
    getDeviceVars,
    getDeviceVarsMeta,
    deleteDeviceVars
```

**Step 4: Verify**

Run: `node -e "const db = require('./db'); console.log(Object.keys(db));"` from `backend/`
Expected: output includes `upsertDeviceVars`, `getDeviceVars`, `getDeviceVarsMeta`, `deleteDeviceVars`

**Step 5: Commit**

```bash
git add backend/db.js
git commit -m "feat(db): add device_vars table + CRUD helpers for encrypted env vars"
```

---

## Task 2: Encryption Helpers + Remove Old Cache (`backend/index.js`)

**Files:**
- Modify: `backend/index.js:1511-1516` (remove `deviceVarsCache` + setInterval)
- Modify: `backend/index.js` (add encryption helpers near top of file)

**Step 1: Add encryption/decryption helpers**

After the `const crypto = require('crypto');` line (or near the existing `crypto.randomBytes` usage), add:

```javascript
// ============================================
// ENV VARS ENCRYPTION (AES-256-GCM)
// ============================================
const SEAL_KEY_HEX = process.env.SEAL_KEY;

function encryptVars(varsObj) {
    if (!SEAL_KEY_HEX) throw new Error('SEAL_KEY not configured');
    const key = Buffer.from(SEAL_KEY_HEX, 'hex');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    let encrypted = cipher.update(JSON.stringify(varsObj), 'utf8', 'base64');
    encrypted += cipher.final('base64');
    const authTag = cipher.getAuthTag();
    return {
        encrypted,
        iv: iv.toString('hex'),
        authTag: authTag.toString('hex')
    };
}

function decryptVars(encrypted, ivHex, authTagHex) {
    if (!SEAL_KEY_HEX) throw new Error('SEAL_KEY not configured');
    const key = Buffer.from(SEAL_KEY_HEX, 'hex');
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encrypted, 'base64', 'utf8');
    decrypted += decipher.final('utf8');
    return JSON.parse(decrypted);
}
```

**Step 2: Replace `deviceVarsCache` with approval caches**

At lines 1511-1516, replace:

```javascript
// Local vars cache — in-memory only, never written to DB
const deviceVarsCache = new Map(); // deviceId → { vars: {KEY:VALUE}, syncedAt: ms }
setInterval(() => {
    const cut = Date.now() - 30 * 60 * 1000;
    for (const [id, e] of deviceVarsCache) if (e.syncedAt < cut) deviceVarsCache.delete(id);
}, 5 * 60 * 1000);
```

With:

```javascript
// JIT approval cache — deviceId → { approvedAt, expiresAt }
const varsApprovalCache = new Map();
// Pending approval requests — deviceId → { requestId, resolvers: [{ resolve, reject }], timer }
const varsApprovalPending = new Map();
const VARS_APPROVAL_TTL = 5 * 60 * 1000; // 5 minutes
const VARS_APPROVAL_TIMEOUT = 60 * 1000; // 60 seconds
```

**Step 3: Verify no broken references**

Search for any remaining `deviceVarsCache` references — all should be in the endpoint handlers (Tasks 3-5) and `pushToBot()` (Task 6) which will be updated in later tasks.

**Step 4: Commit**

```bash
git add backend/index.js
git commit -m "feat: add AES-256-GCM encryption helpers + replace deviceVarsCache with approval cache"
```

---

## Task 3: Rewrite `POST /api/device-vars` (`backend/index.js`)

**Files:**
- Modify: `backend/index.js:7417-7439` (POST endpoint)

**Step 1: Replace the POST handler**

Replace the entire `app.post('/api/device-vars', ...)` handler (lines 7417-7439) with:

```javascript
// POST /api/device-vars — client syncs local vars to server (encrypted DB)
// Auth: deviceSecret
app.post('/api/device-vars', async (req, res) => {
    const { deviceId, deviceSecret, vars, locked } = req.body;
    if (!deviceId || !deviceSecret) {
        return res.status(400).json({ success: false, error: 'deviceId and deviceSecret required' });
    }
    const device = devices[deviceId];
    if (!device || device.deviceSecret !== deviceSecret) {
        return res.status(403).json({ success: false, error: 'Invalid credentials' });
    }
    if (vars !== null && typeof vars !== 'object') {
        return res.status(400).json({ success: false, error: 'vars must be an object' });
    }
    if (!SEAL_KEY_HEX) {
        return res.status(500).json({ success: false, error: 'Encryption not configured' });
    }

    // Sanitize: only string keys + string values
    const sanitized = {};
    for (const [k, v] of Object.entries(vars || {})) {
        if (typeof k === 'string' && k.length > 0 && typeof v === 'string') {
            sanitized[k] = v;
        }
    }

    const isLocked = locked === true;
    const varKeys = Object.keys(sanitized);

    try {
        const { encrypted, iv, authTag } = encryptVars(sanitized);
        await db.upsertDeviceVars(deviceId, encrypted, iv, authTag, varKeys, isLocked);
        res.json({ success: true, count: varKeys.length });
    } catch (err) {
        console.error(`[Vars] Failed to save vars for ${deviceId}:`, err.message);
        res.status(500).json({ success: false, error: 'Failed to save variables' });
    }
});
```

**Step 2: Verify**

Test with curl:
```bash
curl -X POST https://eclawbot.com/api/device-vars \
  -H "Content-Type: application/json" \
  -d '{"deviceId":"TEST_ID","deviceSecret":"TEST_SECRET","vars":{"TEST_KEY":"test_value"}}'
```
Expected: `{ "success": true, "count": 1 }`

**Step 3: Commit**

```bash
git add backend/index.js
git commit -m "feat: POST /api/device-vars now encrypts + persists to DB"
```

---

## Task 4: Rewrite `GET /api/device-vars` with JIT Approval (`backend/index.js`)

**Files:**
- Modify: `backend/index.js:7441-7462` (GET endpoint)

**Step 1: Replace the GET handler**

Replace the entire `app.get('/api/device-vars', ...)` handler (lines 7441-7462) with:

```javascript
// GET /api/device-vars — bot reads vars (JIT approval required)
// Auth: botSecret (entity must be bound to the device)
app.get('/api/device-vars', async (req, res) => {
    const { deviceId, botSecret } = req.query;
    if (!deviceId || !botSecret) {
        return res.status(400).json({ success: false, error: 'deviceId and botSecret required' });
    }
    const device = devices[deviceId];
    if (!device) {
        return res.status(404).json({ success: false, error: 'Device not found' });
    }

    // Authenticate bot
    const allEntities = Object.values(device.entities || {});
    const botEntity = allEntities.find(e => e.isBound && e.botSecret === botSecret);
    if (!botEntity) {
        return res.status(403).json({ success: false, error: 'Invalid botSecret' });
    }

    // Check if vars exist in DB
    const row = await db.getDeviceVars(deviceId);
    if (!row) {
        return res.json({ success: true, vars: {}, hint: 'No vars saved — owner has not configured any variables' });
    }

    // Check lock
    if (row.is_locked) {
        return res.status(403).json({ success: false, error: 'locked', message: 'Variables are locked by owner' });
    }

    // Check approval cache
    const cached = varsApprovalCache.get(deviceId);
    if (cached && Date.now() < cached.expiresAt) {
        try {
            const vars = decryptVars(row.encrypted_vars, row.iv, row.auth_tag);
            return res.json({ success: true, vars });
        } catch (err) {
            console.error(`[Vars] Decrypt failed for ${deviceId}:`, err.message);
            return res.status(500).json({ success: false, error: 'Decryption failed' });
        }
    }

    // Check if owner is online via Socket.IO
    const sockets = await io.in(`device:${deviceId}`).fetchSockets();
    if (sockets.length === 0) {
        return res.status(403).json({ success: false, error: 'owner_offline', message: 'Device owner is not online — open Portal or App to approve' });
    }

    // Check if there's already a pending approval for this device
    const pending = varsApprovalPending.get(deviceId);
    if (pending) {
        // Piggyback on the existing approval request
        try {
            const approved = await new Promise((resolve, reject) => {
                pending.resolvers.push({ resolve, reject });
            });
            if (!approved) {
                return res.status(403).json({ success: false, error: 'denied', message: 'Access denied by owner' });
            }
            const vars = decryptVars(row.encrypted_vars, row.iv, row.auth_tag);
            return res.json({ success: true, vars });
        } catch (err) {
            if (err.message === 'timeout') {
                return res.status(408).json({ success: false, error: 'timeout', message: 'Approval request timed out (60s)' });
            }
            return res.status(500).json({ success: false, error: err.message });
        }
    }

    // Create new approval request
    const requestId = crypto.randomBytes(8).toString('hex');
    const entityName = botEntity.name || `Entity ${botEntity.entityId}`;
    const varKeys = row.var_keys || [];

    try {
        const approved = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                varsApprovalPending.delete(deviceId);
                const entry = varsApprovalPending.get(deviceId);
                // Already deleted, just reject all
                reject(new Error('timeout'));
            }, VARS_APPROVAL_TIMEOUT);

            const entry = {
                requestId,
                resolvers: [{ resolve, reject }],
                timer
            };
            varsApprovalPending.set(deviceId, entry);

            // Emit to all connected clients for this device
            io.to(`device:${deviceId}`).emit('vars:approval-request', {
                requestId,
                entityName,
                varKeys,
                expiresAt: Date.now() + VARS_APPROVAL_TIMEOUT
            });
        });

        if (!approved) {
            return res.status(403).json({ success: false, error: 'denied', message: 'Access denied by owner' });
        }

        // Approved — decrypt and return
        const vars = decryptVars(row.encrypted_vars, row.iv, row.auth_tag);
        varsApprovalCache.set(deviceId, {
            approvedAt: Date.now(),
            expiresAt: Date.now() + VARS_APPROVAL_TTL
        });
        return res.json({ success: true, vars });
    } catch (err) {
        if (err.message === 'timeout') {
            return res.status(408).json({ success: false, error: 'timeout', message: 'Approval request timed out (60s)' });
        }
        console.error(`[Vars] Approval error for ${deviceId}:`, err.message);
        return res.status(500).json({ success: false, error: 'Approval failed' });
    }
});
```

**Step 2: Commit**

```bash
git add backend/index.js
git commit -m "feat: GET /api/device-vars with JIT approval via Socket.IO"
```

---

## Task 5: Rewrite `DELETE /api/device-vars` + Socket.IO Listener (`backend/index.js`)

**Files:**
- Modify: `backend/index.js:7464-7477` (DELETE endpoint)
- Modify: `backend/index.js:66-74` (Socket.IO connection handler)

**Step 1: Replace the DELETE handler**

Replace lines 7464-7477 with:

```javascript
// DELETE /api/device-vars — client clears all vars
// Auth: deviceSecret
app.delete('/api/device-vars', async (req, res) => {
    const { deviceId, deviceSecret } = req.body;
    if (!deviceId || !deviceSecret) {
        return res.status(400).json({ success: false, error: 'deviceId and deviceSecret required' });
    }
    const device = devices[deviceId];
    if (!device || device.deviceSecret !== deviceSecret) {
        return res.status(403).json({ success: false, error: 'Invalid credentials' });
    }
    await db.deleteDeviceVars(deviceId);
    varsApprovalCache.delete(deviceId);
    res.json({ success: true });
});
```

**Step 2: Add `vars:approval-response` Socket.IO listener**

In the `io.on('connection', ...)` handler (line ~66-74), add the approval response listener inside the connection handler, after the `socket.join(...)` line:

```javascript
io.on('connection', (socket) => {
    const deviceId = socket.deviceId;
    socket.join(`device:${deviceId}`);
    console.log(`[Socket.IO] Connected: device ${deviceId} (${io.engine.clientsCount} total)`);

    // Handle vars approval response from Portal/App
    socket.on('vars:approval-response', (data) => {
        const { requestId, approved } = data || {};
        const pending = varsApprovalPending.get(deviceId);
        if (!pending || pending.requestId !== requestId) return;

        clearTimeout(pending.timer);
        varsApprovalPending.delete(deviceId);

        for (const { resolve } of pending.resolvers) {
            resolve(approved === true);
        }
    });

    socket.on('disconnect', () => {
        console.log(`[Socket.IO] Disconnected: device ${deviceId}`);
    });
});
```

**Step 3: Fix the timeout handler in Task 4**

The timeout handler in GET has a bug — it deletes the entry then tries to get it again. Fix by resolving all pending resolvers before deleting:

In the GET handler's `setTimeout` callback, replace with:

```javascript
const timer = setTimeout(() => {
    const entry = varsApprovalPending.get(deviceId);
    if (entry && entry.requestId === requestId) {
        varsApprovalPending.delete(deviceId);
        for (const { reject } of entry.resolvers) {
            reject(new Error('timeout'));
        }
    }
}, VARS_APPROVAL_TIMEOUT);
```

**Step 4: Commit**

```bash
git add backend/index.js
git commit -m "feat: DELETE /api/device-vars + Socket.IO vars:approval-response handler"
```

---

## Task 6: Update `pushToBot()` Env Vars Hint (`backend/index.js`)

**Files:**
- Modify: `backend/index.js:5874-5880` (env vars hint in pushToBot)

**Step 1: Replace the deviceVarsCache check**

Replace lines 5874-5880:

```javascript
// Append local vars hint if any are cached (keys only — fetch values via API)
const cachedVars = deviceVarsCache.get(deviceId);
if (cachedVars && Object.keys(cachedVars.vars).length > 0) {
    const varKeys = Object.keys(cachedVars.vars).join(', ');
    const apiBase = process.env.API_BASE || 'https://eclawbot.com';
    messageContent += `\n\n[Local Variables available: ${varKeys}]\nexec: curl -s "${apiBase}/api/device-vars?deviceId=${deviceId}&botSecret=${entity.botSecret}"`;
}
```

With:

```javascript
// Append local vars hint from DB (keys only, no decryption needed)
try {
    const varsMeta = await db.getDeviceVarsMeta(deviceId);
    if (varsMeta && !varsMeta.is_locked && varsMeta.var_keys && varsMeta.var_keys.length > 0) {
        const varKeys = varsMeta.var_keys.join(', ');
        const apiBase = process.env.API_BASE || 'https://eclawbot.com';
        messageContent += `\n\n[Local Variables available: ${varKeys}]\nNote: Reading vars requires owner approval (60s timeout).\nexec: curl -s "${apiBase}/api/device-vars?deviceId=${deviceId}&botSecret=${entity.botSecret}"`;
    }
} catch (err) {
    // Non-critical — just skip the hint
}
```

**Important:** Verify that `pushToBot()` is already an `async` function. If not, it must be marked `async` for the `await` to work. (It should already be async based on the WebSocket flow.)

**Step 2: Verify no remaining `deviceVarsCache` references**

Search the entire `backend/index.js` for `deviceVarsCache`. There should be zero remaining references.

**Step 3: Commit**

```bash
git add backend/index.js
git commit -m "feat: pushToBot() reads var keys from DB instead of in-memory cache"
```

---

## Task 7: Web Portal — Approval Dialog (`backend/public/portal/shared/socket.js`)

**Files:**
- Modify: `backend/public/portal/shared/socket.js`

**Step 1: Add `vars:approval-request` listener**

Inside the `initPortalSocket()` function, after the `portalSocket.on('entity:update', ...)` handler (line ~43), add:

```javascript
    portalSocket.on('vars:approval-request', (data) => {
        showVarsApprovalDialog(data);
    });
```

**Step 2: Add the approval dialog function**

At the bottom of the file (before the closing `document.addEventListener('click', ...)` block at line 194), add:

```javascript
// ============================================
// Vars Approval Dialog (JIT Authorization)
// ============================================

let varsApprovalTimer = null;

function showVarsApprovalDialog(data) {
    const { requestId, entityName, varKeys, expiresAt } = data;

    // Remove any existing dialog
    const existing = document.getElementById('varsApprovalOverlay');
    if (existing) existing.remove();
    if (varsApprovalTimer) clearInterval(varsApprovalTimer);

    const t = (key, fallback) => typeof i18n !== 'undefined' ? i18n.t(key) : fallback;

    const overlay = document.createElement('div');
    overlay.id = 'varsApprovalOverlay';
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.6);backdrop-filter:blur(4px);z-index:10000;display:flex;align-items:center;justify-content:center;';

    const keysHtml = varKeys.length > 0
        ? varKeys.map(k => `<code style="background:#f0f0f0;padding:2px 8px;border-radius:4px;font-size:13px;">${k}</code>`).join(' ')
        : '<em>(' + t('vars_no_keys', 'no variables') + ')</em>';

    overlay.innerHTML = `
        <div style="background:#fff;border-radius:16px;padding:32px;max-width:420px;width:90%;box-shadow:0 8px 32px rgba(0,0,0,0.3);text-align:center;">
            <div style="font-size:40px;margin-bottom:12px;">&#x1f510;</div>
            <h3 style="margin:0 0 8px;font-size:18px;">${t('vars_approval_title', 'Variable Access Request')}</h3>
            <p style="margin:0 0 16px;color:#555;font-size:14px;">
                <strong>${entityName}</strong> ${t('vars_approval_body', 'wants to read your variables')}
            </p>
            <div style="margin:0 0 20px;text-align:left;padding:12px;background:#f8f8f8;border-radius:8px;">
                ${keysHtml}
            </div>
            <div style="display:flex;gap:12px;justify-content:center;">
                <button id="varsApprovalDeny" style="padding:10px 24px;border:1px solid #ddd;border-radius:8px;background:#fff;cursor:pointer;font-size:14px;">
                    ${t('vars_deny', 'Deny')}
                </button>
                <button id="varsApprovalAllow" disabled style="padding:10px 24px;border:none;border-radius:8px;background:#ccc;color:#fff;cursor:not-allowed;font-size:14px;min-width:120px;">
                    ${t('vars_allow', 'Allow')} (3s)
                </button>
            </div>
            <p id="varsApprovalCountdown" style="margin:12px 0 0;color:#999;font-size:12px;"></p>
        </div>
    `;

    document.body.appendChild(overlay);

    const allowBtn = document.getElementById('varsApprovalAllow');
    const denyBtn = document.getElementById('varsApprovalDeny');
    const countdownEl = document.getElementById('varsApprovalCountdown');

    // 3-second cooldown on Allow button
    let cooldown = 3;
    const cooldownInterval = setInterval(() => {
        cooldown--;
        if (cooldown > 0) {
            allowBtn.textContent = `${t('vars_allow', 'Allow')} (${cooldown}s)`;
        } else {
            clearInterval(cooldownInterval);
            allowBtn.disabled = false;
            allowBtn.style.background = '#4CAF50';
            allowBtn.style.cursor = 'pointer';
            allowBtn.textContent = t('vars_allow', 'Allow');
        }
    }, 1000);

    // Auto-timeout countdown
    const timeoutMs = expiresAt - Date.now();
    let remaining = Math.ceil(timeoutMs / 1000);
    countdownEl.textContent = `${t('vars_auto_deny', 'Auto-deny in')} ${remaining}s`;
    varsApprovalTimer = setInterval(() => {
        remaining--;
        if (remaining <= 0) {
            respond(false);
        } else {
            countdownEl.textContent = `${t('vars_auto_deny', 'Auto-deny in')} ${remaining}s`;
        }
    }, 1000);

    function respond(approved) {
        clearInterval(cooldownInterval);
        clearInterval(varsApprovalTimer);
        varsApprovalTimer = null;
        overlay.remove();
        if (portalSocket && portalSocket.connected) {
            portalSocket.emit('vars:approval-response', { requestId, approved });
        }
    }

    allowBtn.addEventListener('click', () => respond(true));
    denyBtn.addEventListener('click', () => respond(false));
}
```

**Step 3: Commit**

```bash
git add backend/public/portal/shared/socket.js
git commit -m "feat: add JIT vars approval dialog to Portal shared socket handler"
```

---

## Task 8: Update `env-vars.html` — Lock + Sync Flow

**Files:**
- Modify: `backend/public/portal/env-vars.html:452-473` (toggleLock, syncVarsToServer)

**Step 1: Update `syncVarsToServer()` to always send real vars + lock flag**

Replace lines 460-473:

```javascript
async function syncVarsToServer() {
    if (!currentUser) return;
    const locked = isLocked();
    const vars = loadLocalVars(); // always send real vars (lock is a separate flag)
    try {
        await apiCall('POST', '/api/device-vars', {
            deviceId: currentUser.deviceId,
            deviceSecret: currentUser.deviceSecret,
            vars,
            locked
        });
    } catch (e) {
        // silent — non-critical background sync
    }
}
```

Key change: always sends real vars (not `{}` when locked). The `locked` boolean is now a separate field.

**Step 2: Add info section about encryption**

After the bot hint section (around line 476-480), add a user-facing info section explaining the encryption + JIT approval logic. Add an info box below the main vars card:

Find the `renderBotHint()` function and after it, add a new section to the page that explains:

```javascript
function renderSecurityInfo() {
    const el = document.getElementById('securityInfo');
    if (!el) return;
    const t = (key, fallback) => typeof i18n !== 'undefined' ? i18n.t(key) : fallback;
    el.innerHTML = `
        <div style="margin-top:16px;padding:16px;background:#f0f7ff;border-radius:12px;border:1px solid #d0e3ff;">
            <h4 style="margin:0 0 8px;font-size:14px;">&#x1f512; ${t('vars_security_title', 'Security')}</h4>
            <ul style="margin:0;padding-left:20px;font-size:13px;color:#555;line-height:1.8;">
                <li>${t('vars_security_encrypted', 'Variables are encrypted (AES-256-GCM) before storage')}</li>
                <li>${t('vars_security_approval', 'Bot access requires your real-time approval (popup)')}</li>
                <li>${t('vars_security_cache', 'Approval is cached for 5 minutes to reduce popups')}</li>
                <li>${t('vars_security_lock', 'Lock immediately blocks all bot access')}</li>
                <li>${t('vars_security_offline', 'If you are offline, bots cannot access variables')}</li>
            </ul>
        </div>
    `;
}
```

Add a `<div id="securityInfo"></div>` in the HTML body and call `renderSecurityInfo()` in `DOMContentLoaded`.

**Step 3: Commit**

```bash
git add backend/public/portal/env-vars.html
git commit -m "feat: env-vars.html sends lock as separate flag + adds security info section"
```

---

## Task 9: Remove Duplicate `syncVarsToServer()` from `mission.html`

**Files:**
- Modify: `backend/public/portal/mission.html:1575-1595` (remove duplicate function)
- Modify: `backend/public/portal/mission.html:642` (update call)

**Step 1: Replace duplicate `syncVarsToServer()` in mission.html**

Replace lines 1575-1595 with a version that sends the `locked` flag:

```javascript
// ========== Variables (local .env vault) ==========
const VARS_STORAGE_KEY = () => `eclawLocalVars_${currentUser?.deviceId || 'default'}`;

function loadLocalVars() {
    try { return JSON.parse(localStorage.getItem(VARS_STORAGE_KEY()) || '{}'); }
    catch { return {}; }
}

// Background sync only — UI lives in env-vars.html
async function syncVarsToServer() {
    if (!currentUser) return;
    const locked = localStorage.getItem(`eclawVarsLocked_${currentUser.deviceId}`) === 'true';
    const vars = loadLocalVars(); // always send real vars
    try {
        await apiCall('POST', '/api/device-vars', {
            deviceId: currentUser.deviceId,
            deviceSecret: currentUser.deviceSecret,
            vars,
            locked
        });
    } catch (e) { /* silent */ }
}
```

Key change: sends real vars always, with `locked` as separate boolean.

**Step 2: Commit**

```bash
git add backend/public/portal/mission.html
git commit -m "fix: mission.html syncVarsToServer sends lock as separate flag"
```

---

## Task 10: Update Bot Skill Documentation (`backend/E-claw_mcp_skill.md`)

**Files:**
- Modify: `backend/E-claw_mcp_skill.md:1364-1407` (Section 10)

**Step 1: Replace the env vars section**

Replace the existing Section 10 content (lines 1364-1407) with:

```markdown
## 10. Local Variables (Encrypted Device Vault)

Users can store private tokens and API keys in their device's encrypted vault.
Variables are **encrypted at rest** (AES-256-GCM) in the database.

### `GET /api/device-vars` — Read local variables

    exec: curl -s "https://eclawbot.com/api/device-vars?deviceId=DEVICE_ID&botSecret=BOT_SECRET"

**Important:** Reading variables requires **real-time owner approval**. When you call this endpoint:

1. The device owner receives a popup in their Portal or App
2. They have 60 seconds to approve or deny
3. If approved, the variables are decrypted and returned
4. Approval is cached for 5 minutes — subsequent reads within 5 minutes don't require re-approval

**Response (approved):**
```json
{ "success": true, "vars": { "CLAUDE_OAUTH_TOKEN": "sk-ant-oat...", "MY_API_KEY": "abc123" } }
```

**Error responses:**

| HTTP Status | Error | Meaning |
|---|---|---|
| 403 | `locked` | Owner has locked the variables — do not retry |
| 403 | `owner_offline` | Owner is not online — cannot approve. Ask owner to open Portal/App |
| 403 | `denied` | Owner denied your request |
| 408 | `timeout` | Owner didn't respond within 60 seconds |

**Auth:** `botSecret` of any entity bound to the same device.

### When to use

Each push notification you receive will include a hint at the bottom if vars are available:

    [Local Variables available: CLAUDE_OAUTH_TOKEN, MY_API_KEY]
    Note: Reading vars requires owner approval (60s timeout).
    exec: curl -s "https://eclawbot.com/api/device-vars?deviceId=...&botSecret=..."

When you see this, call the endpoint to retrieve the token values you need.
If you receive `owner_offline`, inform the user they need to open their Portal or App for you to access the variables.
If you receive `timeout`, you may retry once after a short delay.
```

**Step 2: Commit**

```bash
git add backend/E-claw_mcp_skill.md
git commit -m "docs: update env vars skill doc with JIT approval flow + error codes"
```

---

## Task 11: Android — Socket.IO Approval Dialog

**Files:**
- Modify: `app/src/main/java/com/hank/clawlive/MissionControlActivity.kt`

**Step 1: Add Socket.IO listener for `vars:approval-request`**

In `MissionControlActivity.kt`, find where Socket.IO events are registered (likely in `onCreate` or `initSocket`). Add a listener:

```kotlin
socket.on("vars:approval-request") { args ->
    if (args.isNotEmpty()) {
        val data = args[0] as? JSONObject ?: return@on
        val requestId = data.optString("requestId")
        val entityName = data.optString("entityName", "Bot")
        val varKeys = mutableListOf<String>()
        val keysArray = data.optJSONArray("varKeys")
        if (keysArray != null) {
            for (i in 0 until keysArray.length()) {
                varKeys.add(keysArray.getString(i))
            }
        }
        runOnUiThread {
            showVarsApprovalDialog(requestId, entityName, varKeys)
        }
    }
}
```

**Step 2: Add approval dialog function**

```kotlin
private fun showVarsApprovalDialog(requestId: String, entityName: String, varKeys: List<String>) {
    val keysText = if (varKeys.isNotEmpty()) varKeys.joinToString(", ") else getString(R.string.vars_no_keys)

    val dialog = MaterialAlertDialogBuilder(this)
        .setTitle(getString(R.string.vars_approval_title))
        .setMessage(getString(R.string.vars_approval_body, entityName, keysText))
        .setPositiveButton(getString(R.string.vars_allow), null) // set later for countdown
        .setNegativeButton(getString(R.string.vars_deny)) { _, _ ->
            emitApprovalResponse(requestId, false)
        }
        .setCancelable(false)
        .create()

    dialog.show()

    // 3-second cooldown on Allow button
    val allowBtn = dialog.getButton(AlertDialog.BUTTON_POSITIVE)
    allowBtn.isEnabled = false
    allowBtn.text = "${getString(R.string.vars_allow)} (3s)"

    val handler = Handler(Looper.getMainLooper())
    var countdown = 3
    val countdownRunnable = object : Runnable {
        override fun run() {
            countdown--
            if (countdown > 0) {
                allowBtn.text = "${getString(R.string.vars_allow)} (${countdown}s)"
                handler.postDelayed(this, 1000)
            } else {
                allowBtn.isEnabled = true
                allowBtn.text = getString(R.string.vars_allow)
                allowBtn.setOnClickListener {
                    emitApprovalResponse(requestId, true)
                    dialog.dismiss()
                }
            }
        }
    }
    handler.postDelayed(countdownRunnable, 1000)

    // Auto-dismiss after 60 seconds
    handler.postDelayed({
        if (dialog.isShowing) {
            emitApprovalResponse(requestId, false)
            dialog.dismiss()
        }
    }, 60_000)
}

private fun emitApprovalResponse(requestId: String, approved: Boolean) {
    val data = JSONObject().apply {
        put("requestId", requestId)
        put("approved", approved)
    }
    socket?.emit("vars:approval-response", data)
}
```

**Step 3: Add string resources**

In `app/src/main/res/values/strings.xml`:

```xml
<string name="vars_approval_title">Variable Access Request</string>
<string name="vars_approval_body">%1$s wants to read your variables:\n\n%2$s</string>
<string name="vars_allow">Allow</string>
<string name="vars_deny">Deny</string>
<string name="vars_no_keys">no variables</string>
```

**Step 4: Update `syncVarsToServer()` in MissionControlActivity**

Find the existing `syncVarsToServer()` function and update it to send the `locked` flag:

```kotlin
private fun syncVarsToServer() {
    val vars = LocalVarsManager.getInstance(this).getAll()
    val locked = getSharedPreferences("realbot_prefs", MODE_PRIVATE)
        .getBoolean("eclawVarsLocked_${deviceId}", false)
    lifecycleScope.launch {
        try {
            api.syncLocalVars(SyncLocalVarsRequest(deviceId, deviceSecret, vars, locked))
        } catch (_: Exception) { /* silent */ }
    }
}
```

Update `SyncLocalVarsRequest` data class to include `locked`:

```kotlin
data class SyncLocalVarsRequest(
    val deviceId: String,
    val deviceSecret: String,
    val vars: Map<String, String>,
    val locked: Boolean = false
)
```

**Step 5: Verify compilation**

Run: `JAVA_HOME="/c/Program Files/Android/Android Studio/jbr" ./gradlew.bat compileDebugKotlin`
Expected: BUILD SUCCESSFUL

**Step 6: Commit**

```bash
git add app/
git commit -m "feat(android): add JIT vars approval dialog + sync locked flag"
```

---

## Task 12: Generate SEAL_KEY + Final Verification

**Step 1: Generate SEAL_KEY**

Run locally:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Copy the output (64 hex characters). This is your `SEAL_KEY`.

**Step 2: Add to local `.env`**

Add `SEAL_KEY=<generated_key>` to `backend/.env`

**Step 3: Add to Railway env vars**

Go to Railway dashboard → realbot service → Variables → Add `SEAL_KEY` with the generated value.

**Step 4: Add to `.env.example`**

Add a placeholder line to `backend/.env.example`:
```
SEAL_KEY=your-64-hex-char-seal-key-here
```

**Step 5: Local smoke test**

Start the server locally and test:
```bash
# Save vars
curl -X POST http://localhost:3000/api/device-vars \
  -H "Content-Type: application/json" \
  -d '{"deviceId":"TEST","deviceSecret":"TEST_SECRET","vars":{"MY_KEY":"my_value"}}'

# Read vars (should trigger approval or return owner_offline)
curl "http://localhost:3000/api/device-vars?deviceId=TEST&botSecret=BOT_SECRET"
```

**Step 6: Commit .env.example**

```bash
git add backend/.env.example
git commit -m "chore: add SEAL_KEY placeholder to .env.example"
```

---

## Task 13: Merge + Deploy

**Step 1: Merge to main**

```bash
git checkout main
git merge feature/env-vars-encrypted-persistence
git push origin main
```

**Step 2: Verify Railway deployment**

Watch Railway logs for successful startup. Verify `[DB] Database tables ready` appears (confirms `device_vars` table created).

**Step 3: Production smoke test**

Test the full flow: save a var in Portal → open env-vars page → have a bot read → verify approval popup appears.

---

## Summary of All Files Changed

| File | Task | Changes |
|---|---|---|
| `backend/db.js` | 1 | Add `device_vars` CREATE TABLE + 4 CRUD functions + exports |
| `backend/index.js` | 2-6 | Crypto helpers, approval cache, rewrite 3 endpoints, Socket.IO listener, pushToBot hint |
| `backend/public/portal/shared/socket.js` | 7 | Add `vars:approval-request` listener + approval dialog UI |
| `backend/public/portal/env-vars.html` | 8 | Send `locked` flag, add security info section |
| `backend/public/portal/mission.html` | 9 | Update `syncVarsToServer` to send `locked` flag |
| `backend/E-claw_mcp_skill.md` | 10 | Rewrite Section 10 with JIT approval docs |
| `app/.../MissionControlActivity.kt` | 11 | Socket.IO approval dialog, sync locked flag |
| `app/.../ClawApiService.kt` | 11 | Add `locked` to `SyncLocalVarsRequest` |
| `app/.../res/values/strings.xml` | 11 | Add approval dialog strings |
| `backend/.env.example` | 12 | Add `SEAL_KEY` placeholder |
