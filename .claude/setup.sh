#!/bin/bash
# ──────────────────────────────────────────────
# EClaw Cloud Session Setup Script
# ──────────────────────────────────────────────
# All env vars should be set in Claude Code
# cloud environment settings (Environment variables).
# This script reads them and writes backend/.env.
# ──────────────────────────────────────────────

set -e

echo "🦞 EClaw session setup starting..."

# ── 1. GitHub CLI ────────────────────────────
if ! command -v gh &>/dev/null; then
    echo "  Installing gh CLI..."
    sudo apt-get update -qq && sudo apt-get install -y -qq gh 2>/dev/null
fi

if [ -n "$GH_TOKEN" ]; then
    echo "$GH_TOKEN" | gh auth login --with-token 2>/dev/null
    echo "  ✅ gh CLI authenticated"
else
    echo "  ⚠️  GH_TOKEN not set — gh CLI won't be authenticated"
fi

# ── 2. Backend .env (from cloud env vars) ────
ENV_FILE="backend/.env"
echo "  Writing $ENV_FILE..."

# List of all keys to sync from cloud env vars to .env
ENV_KEYS=(
    SECRETS_BACKUP_PASSWORD
    TAPPAY_PARTNER_KEY
    TAPPAY_MERCHANT_ID
    SEAL_KEY
    TEST_DEVICE_ID
    TEST_DEVICE_SECRET
    TEST_ENTITY_ID
    BROADCAST_TEST_DEVICE_ID
    BROADCAST_TEST_DEVICE_SECRET
    GOOGLE_CLIENT_ID
    FACEBOOK_APP_ID
    FACEBOOK_APP_SECRET
)

# Write all available env vars
> "$ENV_FILE"  # truncate
for key in "${ENV_KEYS[@]}"; do
    val="${!key}"
    if [ -n "$val" ]; then
        echo "$key=$val" >> "$ENV_FILE"
    fi
done

COUNT=$(wc -l < "$ENV_FILE")
echo "  ✅ $ENV_FILE written ($COUNT keys)"

# ── 3. Node.js check ────────────────────────
if command -v node &>/dev/null; then
    echo "  ✅ Node.js $(node -v)"
else
    echo "  ⚠️  Node.js not found"
fi

echo "🦞 Setup complete!"
