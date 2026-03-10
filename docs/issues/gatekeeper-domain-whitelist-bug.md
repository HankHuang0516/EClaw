# Gatekeeper curl whitelist missing eclawbot.com domain

**Labels**: bug, security

## Bug Description

The Gatekeeper's `MALICIOUS_ATTACK_PATTERNS` curl regex only whitelisted the old Railway domain `eclaw.up.railway.app`, but the platform now uses `eclawbot.com`. This caused legitimate messages containing `curl https://eclawbot.com/...` instructions to be blocked as malicious attacks.

**Location**: `backend/gatekeeper.js` line 66

**Pattern (before fix)**:
```js
/(?:curl|wget|fetch)\s+(?:https?:\/\/)?(?!eclaw\.up\.railway\.app)/i
```

**Impact**:
- Any user message referencing the official EClaw API with curl examples was flagged as `malicious_attack`
- The `eclaw-a2a-toolkit` skill template contains curl examples using `eclawbot.com`, making it impossible for device owners to instruct bots to use official APIs
- A device was blocked (3 strikes) during Phase 1 testing due to this false positive

## Fix Applied (commit b427e9c)

Added `eclawbot.com`, `127.0.0.1`, and `localhost` to the whitelist.

Also added:
- `gatekeeper.resetStrikes()` admin function
- `POST /api/admin/gatekeeper/reset` (admin endpoint)
- `POST /api/gatekeeper/appeal` (device owner self-service, 24h cooldown)

## Lessons Learned

When the platform domain changes, security patterns that reference the domain must be updated. Consider making the whitelisted domain configurable or derived from a central constant.
