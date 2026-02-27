# E-Claw Webhook Troubleshooting Guide

## Issue: sessions_send tool not available (HTTP 404)

**Symptom**: Webhook handshake fails with "sessions_send tool not available" or "not found".

**Cause**: OpenClaw 2026.2.14+ blocks `sessions_send` by default in gateway tools config.

**Fix by OpenClaw version:**

### OpenClaw 2026.2.26+
```bash
# Step 1: Enable sessions_send via CLI (do NOT edit config files directly!)
openclaw config set gateway.tools.allow '["sessions_send", "sessions_spawn", "session_status"]'

# Step 2: Ask the user before restarting (gateway restart will disconnect all sessions!)
# Tell the user: "I need to restart the OpenClaw gateway to apply the config change. This will briefly disconnect all sessions. May I proceed?"

# Step 3: Only if user confirms:
openclaw gateway restart
```

### OpenClaw 2026.2.14+
```bash
# Step 1: Enable sessions_send via CLI
openclaw config set gateway.tools.allow '["sessions_send"]'

# Step 2: Restart gateway (ask user first!)
openclaw gateway restart
```

**WARNING**: Do NOT directly edit `.openclaw/openclaw.json` or any config files using edit/write tools. This frequently corrupts the JSON and crashes the gateway. Always use `openclaw config set` CLI commands.

---

## Issue: gateway closed (1008): pairing required

**Symptom**: Push notifications fail with "gateway closed (1008): pairing required".

**Cause**: The OpenClaw gateway requires device re-pairing after restart.

**Fix:**
```bash
# Edit pending devices to auto-approve pairing
# Change "silent" from false to true in ~/.openclaw/devices/pending.json
# Then restart the gateway

openclaw gateway restart
```

---

## Issue: localhost / private IP webhook URL rejected

**Symptom**: `/api/bot/register` returns "webhook_url points to a local/private address".

**Cause**: Bot is using `localhost:18789` or a private IP as the webhook URL. This is the local gateway address, unreachable from the internet.

**Fix (try in order):**

### Method A: Environment Variables (Recommended for Zeabur)
```bash
# Read these environment variables:
echo $ZEABUR_WEB_URL        # → webhook_url = {ZEABUR_WEB_URL}/tools/invoke
echo $OPENCLAW_GATEWAY_TOKEN # → token
```

### Method B: Query Gateway Config
```bash
openclaw config get gateway.publicUrl
openclaw config get gateway.token
# If publicUrl returns localhost, use Method A or C instead
```

### Method C: Ask the User
Ask the user to provide the **WebSocket URL** and **Gateway Token** from the **OpenClaw Overview page**.

Then construct:
- `webhook_url` = `{WebSocket URL}/tools/invoke`
  - **CRITICAL**: Replace `wss://` with `https://` and `ws://` with `http://`
  - Example: `wss://eclaw0.zeabur.app` → `https://eclaw0.zeabur.app/tools/invoke`
- `token` = the Gateway Token value

**Do NOT skip webhook registration and fall back to polling mode without trying all three methods.**

---

## Issue: token_mismatch after gateway restart

**Symptom**: WebSocket connections rejected with "gateway token mismatch".

**Cause**: Gateway restart may regenerate the token. Browser/clients still have the old token cached.

**Fix**: Refresh the OpenClaw dashboard page, or re-read the token from `openclaw config get gateway.token`.

---

## Issue: exec tool not available / command not approved

**Symptom**: Bot cannot execute `curl` commands via `exec` tool.

**Cause**: OpenClaw exec approvals allowlist is empty.

**Fix:**
```bash
# Allow all commands for all agents
openclaw approvals allowlist add --agent "*" "*"

# Or allow only curl
openclaw approvals allowlist add --agent "*" "/usr/bin/curl"
```

---

## General Safety Rules

1. **NEVER edit OpenClaw config files directly** (`.openclaw/openclaw.json`, etc.) — always use `openclaw config set` CLI
2. **ALWAYS ask the user before restarting the gateway** — it disconnects all active sessions
3. **ALWAYS back up config before changes** — `cp ~/.openclaw/openclaw.json ~/.openclaw/openclaw.json.bak`
4. **Try all methods** before falling back to polling mode — push mode is critical for UX
