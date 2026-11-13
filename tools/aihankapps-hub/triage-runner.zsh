#!/bin/zsh
# AiHankApps 管理中樞：警示處理排程（Hank 2026-11-13「確保排程可以自主處理判斷所有的警示問題 如果需要人為介入就讓排程發一個警示把詳情打上去
# 讓我看到需要我怎麼幫忙 我全程只盯管理中樞 不會盯排程的每次結果 所以不要pending在排程的每個session中」）。
#
# Installed as ~/.local/bin/aihankapps-hub-triage, started every 15 minutes by ~/Library/LaunchAgents/tw.aihankapps.hub-triage.plist.
#   1. Fetches triage.js, TRIAGE.md and the railway transport from EClaw's main branch (public); keeps the previous copy
#      when GitHub cannot be reached.
#   2. `triage.js pull`: imports 拾光AI雲端相簿's App and LINE problem reports into the hub (no model, no tokens).
#   3. `triage.js pending`: the alerts nobody has judged yet, or whose judgement is due again. Nothing pending → done.
#   4. Otherwise one headless Claude run (Sonnet) judges them by TRIAGE.md. It may only run triage.js and read a few log
#      files: no other shell command, no file writes, no web, no MCP servers, no user settings (--setting-sources project).
#   5. If the model cannot finish three runs in a row, this script itself raises a "needs you" alert in the hub, so a stuck
#      schedule is seen where Hank looks, never only in this log.
# Logs: ~/Library/Logs/aihankapps-hub-triage/triage-YYYYMMDD.log (two weeks kept).
# Stop: launchctl bootout gui/$(id -u)/tw.aihankapps.hub-triage     Run now: launchctl kickstart gui/$(id -u)/tw.aihankapps.hub-triage
set -u
umask 077
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$HOME/.local/bin"
WORK="$HOME/.local/share/aihankapps-hub-triage"
LOGS="$HOME/Library/Logs/aihankapps-hub-triage"
STATE="$WORK/state"
RAW="https://raw.githubusercontent.com/HankHuang0516/EClaw/main"
FILES=(tools/aihankapps-hub/triage.js tools/aihankapps-hub/TRIAGE.md tools/aihankapps-gifts/lib/adapters/transport.js)
MODEL="${AIHANKAPPS_TRIAGE_MODEL:-sonnet}"
CLAUDE_SECONDS=1500

mkdir -p "$STATE" "$WORK/run" "$LOGS"
exec >> "$LOGS/triage-$(date +%Y%m%d).log" 2>&1
find "$LOGS" -name 'triage-*.log' -mtime +14 -delete 2>/dev/null

# One run at a time; a lock left by a crash expires after 40 minutes (longer than one model run).
find "$WORK/.lock" -maxdepth 0 -mmin +40 -exec rmdir {} \; 2>/dev/null
if ! mkdir "$WORK/.lock" 2>/dev/null; then exit 0; fi
trap 'rmdir "$WORK/.lock" 2>/dev/null' EXIT
log() { echo "$(date '+%F %T') $*"; }

# --- 1. code from main (a local checkout can be tested with AIHANKAPPS_TRIAGE_CODE=/path/to/EClaw)
if [[ -n "${AIHANKAPPS_TRIAGE_CODE:-}" ]]; then
  CODE="$AIHANKAPPS_TRIAGE_CODE"
else
  CODE="$WORK/code"; NEXT="$WORK/code.next"; rm -rf "$NEXT"; ok=1
  for f in $FILES; do
    mkdir -p "$NEXT/${f:h}"
    curl -fsS -m 60 --retry 2 -o "$NEXT/$f" "$RAW/$f" && [[ -s "$NEXT/$f" ]] || { ok=0; log "download failed: $f"; }
  done
  if [[ $ok = 1 ]] && node --check "$NEXT/tools/aihankapps-hub/triage.js"; then rm -rf "$CODE" && mv "$NEXT" "$CODE"; else rm -rf "$NEXT"; fi
fi
TOOL="$CODE/tools/aihankapps-hub/triage.js"
if [[ ! -f "$TOOL" || ! -f "$CODE/tools/aihankapps-hub/TRIAGE.md" ]]; then log "no copy of the triage tool yet"; exit 1; fi
num() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const v=JSON.parse(s);console.log(v.success?(v[process.argv[1]]??""):"")}catch{console.log("")}})' "$1"; }

# --- 2. 拾光 reports
log "pull: $(node "$TOOL" pull | tr -d '\n' | cut -c1-300)"

# --- 3. what is due
PENDING="$(node "$TOOL" pending)"
count="$(print -r -- "$PENDING" | num pending)"
if [[ -z "$count" ]]; then
  fails=$(( $(cat "$STATE/hub-failures" 2>/dev/null || echo 0) + 1 )); echo $fails > "$STATE/hub-failures"
  log "pending failed ($fails in a row): $(print -r -- "$PENDING" | cut -c1-300)"
  exit 1
fi
echo 0 > "$STATE/hub-failures"
if [[ "$count" = 0 ]]; then log "nothing pending"; echo 0 > "$STATE/model-failures"; exit 0; fi

# The same list as last time, within the hour: the last run is still being retried on the next tick, not every 15 minutes.
fp="$(print -r -- "$PENDING" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s);console.log(require("crypto").createHash("sha256").update(v.alerts.map(a=>a.id+" "+a.reason).sort().join("\n")).digest("hex"))})')"
if [[ "$fp" = "$(cat "$STATE/last-fp" 2>/dev/null)" && -n "$(find "$STATE/last-fp" -mmin -60 2>/dev/null)" ]]; then log "$count pending, same as the last run under an hour ago; waiting"; exit 0; fi
echo "$fp" > "$STATE/last-fp"

# --- 4. one model run
log "$count pending → $MODEL"
PROMPT="$(sed "s#TRIAGE_TOOL#$TOOL#g" "$CODE/tools/aihankapps-hub/TRIAGE.md")

## 這次的資料

- 現在時間：$(TZ=Asia/Taipei date '+%F %H:%M')（台北）
- 工具：node $TOOL
- 待處理的警示（pending 的輸出）：

\`\`\`json
$PENDING
\`\`\`"
cd "$WORK/run"
ALLOWED=("Bash(node $TOOL:*)"
  "Read(/$HOME/Library/Logs/aihankapps-hub-collector/**)" "Read(/$HOME/Library/Logs/aihankapps-report-watchdog/**)" "Read(/$HOME/Library/Logs/aihankapps-hub-triage/**)"
  "Read(/$HOME/.local/share/AiHankApps/analytics/daily-report-latest.json)" "Read(//Volumes/codex_2T/codex_project/Wishlist/fb-manual-pipeline-20261021/runs/claude/**)")
perl -e 'alarm shift; exec @ARGV' "$CLAUDE_SECONDS" claude -p "$PROMPT" --model "$MODEL" --setting-sources project --strict-mcp-config --permission-mode default \
  --allowedTools "${ALLOWED[@]}" --disallowedTools Write Edit NotebookEdit WebFetch WebSearch Task Agent --no-session-persistence < /dev/null | tail -5
code=${pipestatus[1]}
log "model run exit $code"

# --- 5. did it finish?
AFTER="$(node "$TOOL" pending)"
left="$(print -r -- "$AFTER" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const v=JSON.parse(s);console.log(v.success?v.alerts.filter(a=>a.reason==="new").length:"")}catch{console.log("")}})')"
if [[ "$left" = 0 ]]; then
  echo 0 > "$STATE/model-failures"
  if [[ -f "$STATE/raised-stuck" ]]; then node "$TOOL" resolve human-alert-schedule-stuck --note "排程恢復了：$(TZ=Asia/Taipei date '+%m/%d %H:%M') 這一輪把所有新警示都判斷完。" >/dev/null && rm -f "$STATE/raised-stuck"; fi
  log "done; nothing new left"
  exit 0
fi
mf=$(( $(cat "$STATE/model-failures" 2>/dev/null || echo 0) + 1 )); echo $mf > "$STATE/model-failures"
log "model left ${left:-?} new alerts unjudged ($mf in a row)"
if [[ $mf -ge 3 && ! -f "$STATE/raised-stuck" ]]; then
  node "$TOOL" raise alert-schedule-stuck --title "警示處理排程卡住了" \
    --ask "排程連續 $mf 輪沒辦法把新警示判斷完（最後一次結束代碼 $code）。請看這台 Mac 的 ~/Library/Logs/aihankapps-hub-triage/ 最新日誌，常見原因是 Claude 額度用完或登入失效。" \
    --note "還沒判斷的新警示有 ${left:-?} 則；排程仍會每 15 分鐘再試。" && touch "$STATE/raised-stuck"
fi
exit 1
