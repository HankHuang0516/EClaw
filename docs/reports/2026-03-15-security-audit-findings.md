# EClaw Security Audit Report — 2026-03-15

Automated security audit covering backend modules, API endpoints, and authentication patterns.

**Methodology**: OWASP Top 10 2025, Node.js security best practices, manual code review of all backend modules.

---

## P0 — Critical (Immediate Fix Required)

### Issue 1: SSRF bypass in `/api/bot/web-fetch`

- **File**: `backend/bot-tools.js`, line 214
- **CVSS**: 9.0

The private IP blocklist is incomplete. Bypass vectors:
1. IPv6 localhost: `http://[::1]/`, `http://[::ffff:127.0.0.1]/`
2. Missing `172.16.0.0/12` (Docker/cloud internal)
3. Cloud metadata: `http://169.254.169.254/latest/meta-data/` (Railway/AWS credentials)
4. IPv6 private: `fc00::/7`, `fe80::/10`
5. DNS rebinding: hostname resolves to public then internal IP
6. Decimal IP: `http://2130706433/` = `127.0.0.1`

**Current code**:
```javascript
if (hostname === 'localhost' || hostname === '127.0.0.1' ||
    hostname.startsWith('192.168.') || hostname.startsWith('10.') ||
    hostname === '0.0.0.0') {
```

**Fix**: Resolve hostname to IP before validation, block all RFC 1918/4193/6598 ranges + cloud metadata `169.254.0.0/16`.

---

### Issue 2: Unauthenticated `/api/debug/devices` — full device enumeration

- **File**: `backend/index.js`, line 5609
- **CVSS**: 9.1

Zero authentication on debug endpoint that exposes:
- All device IDs and entity counts
- Entity names, characters, states, messages
- Webhook presence, message queue lengths
- Unread message counts

**Fix**: Add `adminAuth, adminCheck` middleware, or remove in production.

---

### Issue 3: Unauthenticated `/api/feedback/photo/:photoId` — IDOR photo leak

- **File**: `backend/index.js`, line 8460
- **CVSS**: 8.6

Photos served by numeric ID with no authentication. Trivially enumerable:
```bash
for i in $(seq 1 1000); do curl -o "photo_$i.jpg" "https://eclawbot.com/api/feedback/photo/$i"; done
```

**Fix**: Add deviceId+deviceSecret check and verify photo ownership (`photo.device_id === deviceId`).

---

## P1 — High (Fix This Sprint)

### Issue 4: OAuth client secret timing attack

- **File**: `backend/oauth-server.js`, line 285
- **CVSS**: 7.5

Client secret compared with `!==` (non-constant-time). Timing analysis can extract the secret byte-by-byte.

**Fix**: Use `crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b))`.

---

### Issue 5: Database SSL `rejectUnauthorized: false` in production

- **File**: `backend/db.js`, lines 27-29
- **CVSS**: 7.4

Disabling SSL cert validation allows MITM on the DB connection. All device secrets, passwords, tokens transit in interceptable form.

**Fix**: Set `rejectUnauthorized: true` with Railway's CA cert, or use Railway internal networking.

---

### Issue 6: Cross-device feedback data leak via `/api/feedback/pending-debug`

- **File**: `backend/index.js`, line 8160
- **CVSS**: 7.2

Endpoint authenticates the device but returns ALL pending feedback from ALL devices, not filtered by the requesting device.

**Fix**: Filter by device: `getPendingDebugFeedback(chatPool, limit, deviceId)` or restrict to admin.

---

### Issue 7: Admin info disclosure via `/api/admin/gatekeeper/debug`

- **File**: `backend/index.js`, line 1410
- **CVSS**: 7.5

Any authenticated device (not admin-only) can see:
- Complete list of developer/admin device IDs
- Email addresses from `user_accounts`
- Admin flags

**Fix**: Add `adminAuth, adminCheck` middleware (same as `/api/admin/stats`).

---

## P2 — Medium (addressed separately, not filed as issues)

| Finding | File | Description |
|---------|------|-------------|
| ReDoS in gatekeeper regex | gatekeeper.js:33-53 | `.{0,30}` with backtracking on adversarial input |
| Weak JWT secret fallback | index.js:3584,3672 | `'dev-secret-change-in-production'` default |
| Missing CSRF on state-changing ops | index.js (multiple) | POST endpoints accept query params |
| Missing rate limits on mission API | mission.js | No throttle on create/delete |
| Plaintext secret in channel callback | channel-api.js:642 | Basic auth creds stored unencrypted |

---

## GitHub Issue Templates

Below are the 7 issues ready to be created. Copy-paste each `curl` command after setting a valid `GH_TOKEN`.

### P0 Issue 1: SSRF
```bash
curl -X POST -H "Authorization: Bearer $GH_TOKEN" -H "Content-Type: application/json" \
  "https://api.github.com/repositories/1150444936/issues" \
  -d '{
    "title": "[P0/Security] SSRF bypass in /api/bot/web-fetch — IPv6, 172.16.x, cloud metadata accessible",
    "labels": ["bug", "security", "P0"],
    "body": "See docs/reports/2026-03-15-security-audit-findings.md Issue 1"
  }'
```

### P0 Issue 2: Debug Devices
```bash
curl -X POST -H "Authorization: Bearer $GH_TOKEN" -H "Content-Type: application/json" \
  "https://api.github.com/repositories/1150444936/issues" \
  -d '{
    "title": "[P0/Security] Unauthenticated /api/debug/devices exposes all device and entity data",
    "labels": ["bug", "security", "P0"],
    "body": "See docs/reports/2026-03-15-security-audit-findings.md Issue 2"
  }'
```

### P0 Issue 3: Photo IDOR
```bash
curl -X POST -H "Authorization: Bearer $GH_TOKEN" -H "Content-Type: application/json" \
  "https://api.github.com/repositories/1150444936/issues" \
  -d '{
    "title": "[P0/Security] Unauthenticated /api/feedback/photo/:photoId — enumerable photo access",
    "labels": ["bug", "security", "P0"],
    "body": "See docs/reports/2026-03-15-security-audit-findings.md Issue 3"
  }'
```

### P1 Issue 4-7: (similar pattern, change title/body reference)
