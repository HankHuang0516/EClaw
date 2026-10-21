#!/bin/zsh
set -eu

# Follow Wishlist's existing host-managed sign-in and outbound polling pattern.
# Only the Dream Buddy callback capability is separate; no MiniMax auth is copied.
worker_token=$(/usr/bin/security find-generic-password \
  -s com.hankhuang.dream-buddy.minimax-worker-token -a DreamBuddyMiniMaxWorker -w)
if (( ${#worker_token} < 32 )); then
  print -u2 'Dream Buddy worker credential is unavailable'
  exit 1
fi
export DREAM_BUDDY_WORKER_TOKEN="$worker_token"
unset worker_token
export DREAM_BUDDY_MCODE_DATA_DIR="${HOME}/.minimax"
export DREAM_BUDDY_MCODE_BIN="${HOME}/.cache/hank-internal/dream-buddy-minimax-cli/node_modules/.bin/mcode"
export PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
script_dir=${0:A:h}
cd "$script_dir"
exec /opt/homebrew/bin/node "$script_dir/poller.js"
