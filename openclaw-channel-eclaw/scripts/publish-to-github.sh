#!/usr/bin/env bash
# publish-to-github.sh
# Push openclaw-channel-eclaw to its own GitHub repo
#
# Usage:
#   1. Create empty repo on GitHub: https://github.com/new
#      Name: openclaw-channel-eclaw
#      Visibility: Public
#      Do NOT initialize with README
#
#   2. Run this script from the openclaw-channel-eclaw/ directory:
#      bash scripts/publish-to-github.sh

set -e

REMOTE_URL="https://github.com/HankHuang0516/openclaw-channel-eclaw.git"
PLUGIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "Plugin directory: $PLUGIN_DIR"
echo "Remote: $REMOTE_URL"
echo ""

cd "$PLUGIN_DIR"

# Check if already a git repo
if [ -d ".git" ]; then
  echo "✓ Already a git repo"
else
  echo "→ Initializing git repo..."
  git init
  git branch -M main
fi

# Check if remote exists
if git remote get-url origin &>/dev/null; then
  echo "✓ Remote 'origin' already set"
else
  echo "→ Adding remote origin..."
  git remote add origin "$REMOTE_URL"
fi

# Stage and commit
echo "→ Staging files..."
git add .
git status

echo ""
echo "→ Committing..."
git commit -m "feat: initial publish @eclaw/openclaw-channel

OpenClaw channel plugin for E-Claw — AI live wallpaper chat platform for Android.
Enables OpenClaw bots to communicate with E-Claw users as a native channel." || echo "(nothing to commit)"

echo ""
echo "→ Pushing to GitHub..."
git push -u origin main

echo ""
echo "✅ Done! Check: $REMOTE_URL"
echo ""
echo "Next steps:"
echo "  1. npm login && npm publish --access public"
echo "  2. Post in OpenClaw GitHub Discussions (Show and Tell)"
echo "  3. Submit PR to awesome-openclaw-plugins"
