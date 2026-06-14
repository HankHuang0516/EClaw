#!/bin/bash
#
# hourly-auto-process-cards.sh
#
# Hourly cron that auto-claims stale TODO kanban sub-cards for entity #2
# (the commander). For each eligible card, spawn a `bridge-auth U##` terminal
# via ~/.claude/bin/unit.py and dispatch the card's work-package so the
# sub-card moves itself to in_progress and works on its own.
#
# Card filter: status=todo AND assignedBots∋ENTITY_ID AND age > 1h
# Dispatch limit: MAX_CARDS (default 2)
# Mode: DRY_RUN=1 prints the plan without spawning
#
# Env:
#   DEVICE_ID            Owner device (default 480def4c-2183-4d8e-afd0-b131ae89adcc)
#   BOT_SECRET           Owner bot secret (read from backend/.env if unset)
#   ENTITY_ID            Commander entity id (default 2)
#   ENDPOINT             API base (default https://eclawbot.com)
#   MAX_CARDS            Max cards to dispatch per run (default 2)
#   MIN_AGE_SECONDS      Minimum card age (default 3600 = 1h)
#   DRY_RUN              1 = log only, no spawn (default 0)
#   LOG_FILE             Log path (default /tmp/hourly-auto-process.log)
#
# Exit:
#   0  success (may have dispatched 0 cards)
#   1  configuration error (missing creds)
#   2  API error (cards fetch failed)

set -euo pipefail

# ── Config ───────────────────────────────────────────────────────────────
DEVICE_ID="${DEVICE_ID:-480def4c-2183-4d8e-afd0-b131ae89adcc}"
ENTITY_ID="${ENTITY_ID:-2}"
ENDPOINT="${ENDPOINT:-https://eclawbot.com}"
MAX_CARDS="${MAX_CARDS:-2}"
MIN_AGE_SECONDS="${MIN_AGE_SECONDS:-3600}"
DRY_RUN="${DRY_RUN:-0}"
LOG_FILE="${LOG_FILE:-/tmp/hourly-auto-process.log}"
UNIT_PY="${UNIT_PY:-$HOME/.claude/bin/unit.py}"

# Fall back to backend/.env for BOT_SECRET when not provided
if [ -z "${BOT_SECRET:-}" ]; then
  ENV_FILE="$(cd "$(dirname "$0")/.." && pwd)/.env"
  if [ -f "$ENV_FILE" ]; then
    BOT_SECRET="$(grep -E '^(BROADCAST_TEST_DEVICE_SECRET|BOT_SECRET)=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"' || true)"
  fi
fi

log() {
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" | tee -a "$LOG_FILE" >&2
}

if [ -z "${BOT_SECRET:-}" ]; then
  log "ERROR: BOT_SECRET unset and not found in backend/.env"
  exit 1
fi

log "── hourly-auto-process start (DRY_RUN=$DRY_RUN MAX=$MAX_CARDS MIN_AGE=${MIN_AGE_SECONDS}s)"

# ── Fetch + filter cards ────────────────────────────────────────────────
URL="${ENDPOINT}/api/mission/cards?deviceId=${DEVICE_ID}&botSecret=${BOT_SECRET}&entityId=${ENTITY_ID}&status=todo&limit=100"
CARDS_JSON="$(curl -sS --max-time 30 "$URL")" || {
  log "ERROR: cards fetch failed"
  exit 2
}

# Pick top-N eligible cards: assignedBots∋ENTITY_ID and age > MIN_AGE_SECONDS.
# Output: id<TAB>title (newline-separated)
ELIGIBLE="$(printf '%s' "$CARDS_JSON" | python3 -c '
import json, sys, time
data = json.load(sys.stdin)
entity_id  = int(sys.argv[1])
min_age_ms = int(sys.argv[2]) * 1000
max_cards  = int(sys.argv[3])
now_ms = int(time.time() * 1000)
cards = data.get("cards", []) or []
out = []
for c in cards:
    if c.get("status") != "todo":
        continue
    if entity_id not in (c.get("assignedBots") or []):
        continue
    age = now_ms - int(c.get("statusChangedAt") or c.get("createdAt") or 0)
    if age < min_age_ms:
        continue
    out.append((age, c["id"], (c.get("title") or "").replace("\t"," ").replace("\n"," ")))
out.sort(key=lambda r: -r[0])
for _, cid, title in out[:max_cards]:
    print(f"{cid}\t{title}")
' "$ENTITY_ID" "$MIN_AGE_SECONDS" "$MAX_CARDS")"

COUNT="$(printf '%s\n' "$ELIGIBLE" | grep -c . || true)"
log "eligible cards: $COUNT"

if [ "$COUNT" -eq 0 ]; then
  log "nothing to dispatch"
  exit 0
fi

# ── Dispatch each eligible card ──────────────────────────────────────────
DISPATCHED=0
while IFS=$'\t' read -r CID TITLE; do
  [ -z "$CID" ] && continue
  log "→ card=$CID  title=${TITLE:0:80}"

  if [ "$DRY_RUN" = "1" ]; then
    log "  [DRY_RUN] would spawn bridge-auth + dispatch $CID"
    DISPATCHED=$((DISPATCHED + 1))
    continue
  fi

  if [ ! -x "$UNIT_PY" ]; then
    log "  ERROR: unit.py not executable at $UNIT_PY — skipping spawn"
    continue
  fi

  # Spawn a fresh worker window (bridge-auth handshake).
  SHORT="${CID#card_}"
  SHORT="${SHORT:0:8}"
  ROLE="auto-$SHORT"
  SPAWN_OUT="$("$UNIT_PY" spawn "$ROLE" 2>&1 || true)"
  UID_TAG="$(printf '%s' "$SPAWN_OUT" | awk 'NR==1 {print $1}')"
  if [ -z "$UID_TAG" ] || ! printf '%s' "$UID_TAG" | grep -qE '^U[0-9]+$'; then
    log "  ERROR: spawn failed: $SPAWN_OUT"
    continue
  fi

  # Dispatch the bridge-auth command; the worker reads the card itself.
  DISPATCH_CMD="bridge-auth $UID_TAG $CID"
  "$UNIT_PY" dispatch "$UID_TAG" "$DISPATCH_CMD" >/dev/null 2>&1 || {
    log "  ERROR: dispatch failed for $UID_TAG → $CID"
    continue
  }
  log "  spawned $UID_TAG ← $DISPATCH_CMD"
  DISPATCHED=$((DISPATCHED + 1))
done <<< "$ELIGIBLE"

log "── done. dispatched=$DISPATCHED"
exit 0
