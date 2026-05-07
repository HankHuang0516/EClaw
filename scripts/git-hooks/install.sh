#!/usr/bin/env bash
# Install EClaw shared git hooks for this checkout.
# Idempotent: safe to re-run after pulls / fresh clones / new worktrees.
#
# Why this exists: the default `.git/hooks/` directory is per-checkout and
# is NOT versioned, so the 2026-05-07 force-push guard kept getting lost on
# fresh clones and worktrees. Pointing core.hooksPath at this versioned
# directory means every checkout gets the guard automatically once this
# script has been run once.
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "${repo_root}"

git config core.hooksPath scripts/git-hooks
chmod +x scripts/git-hooks/pre-push scripts/git-hooks/install.sh

echo "[EClaw hooks] core.hooksPath -> scripts/git-hooks"
echo "[EClaw hooks] active hooks:"
ls -1 scripts/git-hooks/ | sed 's/^/  - /'
