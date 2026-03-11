#!/bin/bash
# ──────────────────────────────────────────────
# EClaw Cloud Session Setup Script
# ──────────────────────────────────────────────
# Configure these as Environment Variables in
# Claude Code cloud environment settings:
#
#   GH_TOKEN                  — GitHub personal access token
#   BROADCAST_TEST_DEVICE_ID  — Test device ID (for regression tests)
#   BROADCAST_TEST_DEVICE_SECRET — Test device secret
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

# ── 2. Backend .env (for regression tests) ───
ENV_FILE="backend/.env"
if [ ! -f "$ENV_FILE" ]; then
    echo "  Creating $ENV_FILE..."
    touch "$ENV_FILE"
fi

# Write test credentials if available
if [ -n "$BROADCAST_TEST_DEVICE_ID" ]; then
    grep -q "BROADCAST_TEST_DEVICE_ID" "$ENV_FILE" 2>/dev/null || \
        echo "BROADCAST_TEST_DEVICE_ID=$BROADCAST_TEST_DEVICE_ID" >> "$ENV_FILE"
fi
if [ -n "$BROADCAST_TEST_DEVICE_SECRET" ]; then
    grep -q "BROADCAST_TEST_DEVICE_SECRET" "$ENV_FILE" 2>/dev/null || \
        echo "BROADCAST_TEST_DEVICE_SECRET=$BROADCAST_TEST_DEVICE_SECRET" >> "$ENV_FILE"
fi

# ── 3. Node.js check ────────────────────────
if command -v node &>/dev/null; then
    echo "  ✅ Node.js $(node -v)"
else
    echo "  ⚠️  Node.js not found"
fi

echo "🦞 Setup complete!"
