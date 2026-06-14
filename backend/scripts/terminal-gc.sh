#!/bin/bash
#
# terminal-gc.sh
#
# Hourly memory janitor. When free memory is low, walk the U## bridge
# registry in ~/.claude/bin/units.json and close terminals whose bound
# kanban card is already `done` (or whose window has gone dead).
#
# Algorithm:
#   1. Read vm_stat → free MB
#   2. If free MB >= FREE_MB_THRESHOLD AND not FORCE=1, exit (no work)
#   3. List registered units via unit.py list
#   4. For each U## whose role looks like "auto-<8hex>":
#      - resolve card_<full> from the EClaw API (status check)
#      - if card.status in (done, archived) OR window is dead → kill U##
#   5. Log summary to LOG_FILE
#
# Env:
#   FREE_MB_THRESHOLD  Aggressive-close threshold in MB (default 200)
#   DEVICE_ID          Owner device (default 480def4c-...)
#   BOT_SECRET         Owner bot secret (read from backend/.env if unset)
#   ENTITY_ID          Commander entity id (default 2)
#   ENDPOINT           API base (default https://eclawbot.com)
#   DRY_RUN            1 = log only, no kill (default 0)
#   FORCE              1 = ignore memory threshold and scan anyway
#   LOG_FILE           Log path (default /tmp/terminal-gc.log)
#
# Exit:
#   0  success (may have closed 0 terminals)
#   1  configuration error

set -euo pipefail

FREE_MB_THRESHOLD="${FREE_MB_THRESHOLD:-200}"
DEVICE_ID="${DEVICE_ID:-480def4c-2183-4d8e-afd0-b131ae89adcc}"
ENTITY_ID="${ENTITY_ID:-2}"
ENDPOINT="${ENDPOINT:-https://eclawbot.com}"
DRY_RUN="${DRY_RUN:-0}"
FORCE="${FORCE:-0}"
LOG_FILE="${LOG_FILE:-/tmp/terminal-gc.log}"
UNIT_PY="${UNIT_PY:-$HOME/.claude/bin/unit.py}"

if [ -z "${BOT_SECRET:-}" ]; then
  ENV_FILE="$(cd "$(dirname "$0")/.." && pwd)/.env"
  if [ -f "$ENV_FILE" ]; then
    BOT_SECRET="$(grep -E '^(BROADCAST_TEST_DEVICE_SECRET|BOT_SECRET)=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"' || true)"
  fi
fi

log() {
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" | tee -a "$LOG_FILE" >&2
}

# ── free-memory probe ────────────────────────────────────────────────────
FREE_MB="$(vm_stat | awk '
  /page size of/  {gsub(/[^0-9]/, "", $0); ps=$0+0}
  /Pages free/    {gsub(/[^0-9]/, "", $3); pf=$3+0}
  END {if (ps==0) ps=16384; printf "%d", (pf*ps)/1048576}
')"
log "── terminal-gc start (free=${FREE_MB}MB threshold=${FREE_MB_THRESHOLD}MB DRY_RUN=$DRY_RUN FORCE=$FORCE)"

if [ "$FORCE" != "1" ] && [ "$FREE_MB" -ge "$FREE_MB_THRESHOLD" ]; then
  log "memory ok — skipping aggressive sweep"
  exit 0
fi

if [ ! -x "$UNIT_PY" ]; then
  log "ERROR: unit.py not executable at $UNIT_PY"
  exit 1
fi

# ── enumerate units ──────────────────────────────────────────────────────
# unit.py list format:
#   ID    winId  alive  status    role
#   U07     1234  yes    done      auto-2a7b0d69
UNIT_LIST="$("$UNIT_PY" list 2>/dev/null || true)"
if [ -z "$UNIT_LIST" ] || ! printf '%s' "$UNIT_LIST" | grep -qE '^U[0-9]+'; then
  log "no units registered"
  exit 0
fi

# Each row: U##<SP>winId<SP>alive<SP>status<SP>role
ROWS="$(printf '%s\n' "$UNIT_LIST" | awk '/^U[0-9]+/ {print $1"\t"$3"\t"$5}')"
CLOSED=0
SCANNED=0

while IFS=$'\t' read -r UID_TAG ALIVE ROLE; do
  [ -z "$UID_TAG" ] && continue
  SCANNED=$((SCANNED + 1))

  # Dead window → prune the registry entry.
  if [ "$ALIVE" != "yes" ]; then
    log "→ $UID_TAG  window dead — pruning"
    if [ "$DRY_RUN" != "1" ]; then
      "$UNIT_PY" kill "$UID_TAG" >/dev/null 2>&1 || true
      CLOSED=$((CLOSED + 1))
    fi
    continue
  fi

  # Only manage auto-spawned bridges (role prefix "auto-").
  if ! printf '%s' "$ROLE" | grep -qE '^auto-[0-9a-f]+'; then
    log "→ $UID_TAG  role=$ROLE — not auto-managed, skipping"
    continue
  fi

  PREFIX="${ROLE#auto-}"
  if [ -z "${BOT_SECRET:-}" ]; then
    log "→ $UID_TAG  BOT_SECRET unset — cannot check card status, skipping"
    continue
  fi

  # Look up the card whose id starts with card_<PREFIX>. The shell uses
  # role=auto-<first-8-hex>, so we list all cards (any status) and match.
  CARDS_URL="${ENDPOINT}/api/mission/cards?deviceId=${DEVICE_ID}&botSecret=${BOT_SECRET}&entityId=${ENTITY_ID}&includeArchived=true&limit=200"
  CARD_STATUS="$(curl -sS --max-time 20 "$CARDS_URL" \
    | python3 -c "
import json, sys
prefix='card_$PREFIX'
data=json.load(sys.stdin)
for c in (data.get('cards') or []):
    if (c.get('id') or '').startswith(prefix):
        print(c.get('status') or '')
        sys.exit()
print('')
" 2>/dev/null || echo "")"

  log "→ $UID_TAG  role=$ROLE  card_status=${CARD_STATUS:-unknown}"

  case "$CARD_STATUS" in
    done|archived|"")
      if [ "$DRY_RUN" = "1" ]; then
        log "  [DRY_RUN] would close $UID_TAG"
      else
        "$UNIT_PY" kill "$UID_TAG" >/dev/null 2>&1 \
          && log "  closed $UID_TAG" \
          || log "  ERROR closing $UID_TAG"
        CLOSED=$((CLOSED + 1))
      fi
      ;;
    *)
      log "  keep — card still active"
      ;;
  esac
done <<< "$ROWS"

# Final free-memory probe for the log line.
FREE_MB_AFTER="$(vm_stat | awk '
  /page size of/  {gsub(/[^0-9]/, "", $0); ps=$0+0}
  /Pages free/    {gsub(/[^0-9]/, "", $3); pf=$3+0}
  END {if (ps==0) ps=16384; printf "%d", (pf*ps)/1048576}
')"
log "── done. scanned=$SCANNED closed=$CLOSED free_before=${FREE_MB}MB free_after=${FREE_MB_AFTER}MB"
exit 0
