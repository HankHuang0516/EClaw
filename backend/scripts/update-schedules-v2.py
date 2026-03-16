#!/usr/bin/env python3
"""Update audit schedules to use closed-loop endpoints:
  POST /api/bot/audit-log  — structured findings
  POST /api/bot/github-issue — create GH issues for critical findings
"""

import json
import subprocess

DEVICE_ID = "480def4c-2183-4d8e-afd0-b131ae89adcc"
DEVICE_SECRET = "3a4ddb10-2609-42b6-908a-f9d446c97ff9-7cff9697-6391-415d-a282-4e8aea3be49a"
BASE = "https://eclawbot.com"

SCHEDULES = {
    # ─────────────────────────────────────────────────
    # #51 — Skill Template URL Validation + Quality Audit
    # Closed-loop: audit-log + github-issue for dead URLs
    # ─────────────────────────────────────────────────
    51: {
        "label": "Daily Skill Template URL Validation + Quality Audit",
        "message": r"""DAILY TASK: Validate skill template URLs and audit template quality.

== HOW TO GET YOUR CREDENTIALS ==
Look at the [AVAILABLE TOOLS — Mission Dashboard] section appended BELOW this message.
Find the pre-filled curl command and extract:
- DEVICE_ID = value after "deviceId=" in that URL
- BOT_SECRET = value after "botSecret=" in that URL

== IMPORTANT ==
APIs are on https://eclawbot.com (external), NOT inside OpenClaw. Use exec + curl.

== STEP 1: Get all skill templates ==
exec: curl -s "https://eclawbot.com/api/skill-templates"

Parse the JSON. You get an array with fields: id, label, icon, title, url, author, updatedAt, requiredVars, steps.

== STEP 2: Pick 15 templates to validate ==
Select 15 templates. Prioritize ones with GitHub URLs that you haven't checked recently.

== STEP 3: Validate each template's URL ==
For each template with a url field starting with "https://github.com/":
exec: curl -s -o /dev/null -w "%{http_code}" "TEMPLATE_URL"

Record: template id, url, HTTP status code.
- 200 = alive, 404 = dead, 301/302 = redirected

== STEP 4: Audit template quality ==
For each template, check:
1. Has non-empty "steps" field?
2. Has "requiredVars" array?
3. Has "author" set?
4. "updatedAt" within last 6 months?

== STEP 5: Submit structured audit results ==
exec: curl -s -X POST "https://eclawbot.com/api/bot/audit-log" -H "Content-Type: application/json" -d '{"deviceId":"DEVICE_ID","botSecret":"BOT_SECRET","entityId":1,"type":"url-validation","severity":"SEVERITY","summary":"SUMMARY_TEXT","findings":[{"item":"TEMPLATE_ID (URL)","status":"ok|dead|stale|warning","detail":"HTTP_STATUS or quality issue","suggestion":"Remove dead template|Update URL|Add missing steps"}]}'

Set severity to:
- "info" if all 15 templates are healthy
- "warning" if 1-3 have issues
- "critical" if 4+ have issues

Each finding needs: item (template ID + URL), status (ok|dead|stale|warning), detail, suggestion.

== STEP 6: Create GitHub issues for dead URLs ==
For EACH template with a dead URL (404), create a GitHub issue:
exec: curl -s -X POST "https://eclawbot.com/api/bot/github-issue" -H "Content-Type: application/json" -d '{"deviceId":"DEVICE_ID","botSecret":"BOT_SECRET","entityId":1,"title":"[Skill Template] Dead URL: TEMPLATE_ID","body":"## Dead Skill Template URL\n\n- **Template ID:** TEMPLATE_ID\n- **URL:** TEMPLATE_URL\n- **HTTP Status:** 404\n- **Author:** AUTHOR\n\n### Suggested Action\nRemove from registry or update URL.\n\n### Context\nDetected by automated URL validation audit.","labels":["skill-template","stale"]}'

== STEP 7: Store findings in Mission Dashboard ==
Use the noteTitle and noteContent from the audit-log response:
exec: curl -s -X POST "https://eclawbot.com/api/mission/note/add" -H "Content-Type: application/json" -d '{"deviceId":"DEVICE_ID","botSecret":"BOT_SECRET","title":"NOTE_TITLE_FROM_AUDIT","content":"NOTE_CONTENT_FROM_AUDIT","category":"audit"}'

== STEP 8: Brief summary via transform ==
Send a 1-line summary via transform: "URL審計: X/15 OK, Y dead, Z stale. Issues filed: N"

== RULES ==
- Process exactly 15 templates per run
- Do NOT modify or delete templates — only report and file issues
- Only create GitHub issues for DEAD URLs (404), not for quality warnings
- Max 5 GitHub issues per day (API limit)"""
    },

    # ─────────────────────────────────────────────────
    # #52 — Agent Card Maintenance
    # Closed-loop: audit-log for card status
    # ─────────────────────────────────────────────────
    52: {
        "label": "Daily Agent Card Maintenance",
        "message": r"""DAILY TASK: Maintain and update Agent Cards for all entities on this device.

== HOW TO GET YOUR CREDENTIALS ==
Look at the [AVAILABLE TOOLS — Mission Dashboard] section appended BELOW this message.
Find the pre-filled curl command and extract:
- DEVICE_ID = value after "deviceId=" in that URL
- BOT_SECRET = value after "botSecret=" in that URL

== IMPORTANT ==
APIs are on https://eclawbot.com (external), NOT inside OpenClaw. Use exec + curl.

== STEP 1: Check current entity status ==
exec: curl -s "https://eclawbot.com/api/entities?deviceId=DEVICE_ID&deviceSecret=BOT_SECRET"

For each entity, check if "agentCard" is non-null. Note which entities are missing Agent Cards.

== STEP 2: Create Agent Card for entities missing one ==
For each entity WITHOUT an Agent Card:
exec: curl -s -X PUT "https://eclawbot.com/api/entity/agent-card" -H "Content-Type: application/json" -d '{"deviceId":"DEVICE_ID","deviceSecret":"BOT_SECRET","entityId":ENTITY_ID,"agentCard":{"description":"DESCRIPTION","capabilities":[{"id":"cap-id","name":"Capability Name","description":"What it does"}],"protocols":["A2A"],"tags":["eclaw","iot"],"version":"1.0"}}'

Entity role descriptions:
- Entity 0: "EClaw platform monitor — daily reporting, template curation, content publishing, ecosystem health"
- Entity 1: "EClaw skill expert — skill template discovery, URL validation, social media skill sharing"
- Entity 2: "EClaw research analyst — A2A protocol research, API auditing, multi-platform article publishing"

Required: "description" (string, max 500 chars)
Optional: "capabilities" (array max 10, each has id/name/description), "protocols", "tags" (max 20), "version", "website", "contactEmail"

== STEP 3: Verify A2A discovery endpoint ==
exec: curl -s "https://eclawbot.com/.well-known/agent.json"

Confirm valid JSON response.

== STEP 4: Submit audit log ==
exec: curl -s -X POST "https://eclawbot.com/api/bot/audit-log" -H "Content-Type: application/json" -d '{"deviceId":"DEVICE_ID","botSecret":"BOT_SECRET","entityId":0,"type":"agent-card","severity":"SEVERITY","summary":"SUMMARY","findings":[{"item":"Entity #N","status":"ok|missing|stale","detail":"Card present|Missing card|Card outdated","suggestion":"Create card|Update description"}]}'

== STEP 5: Store in Mission Dashboard ==
exec: curl -s -X POST "https://eclawbot.com/api/mission/note/add" -H "Content-Type: application/json" -d '{"deviceId":"DEVICE_ID","botSecret":"BOT_SECRET","title":"NOTE_TITLE","content":"NOTE_CONTENT","category":"audit"}'

== STEP 6: Brief summary via transform ==
"Agent Card: X/N entities have cards. Created: Y, Updated: Z. A2A endpoint: OK/FAIL"

== RULES ==
- Do NOT overwrite existing Agent Cards unless they're clearly outdated (>7 days)
- Capabilities should reflect actual scheduled tasks for that entity
- Max 10 capabilities, 20 tags per card"""
    },

    # ─────────────────────────────────────────────────
    # #53 — API Health Monitoring
    # Closed-loop: audit-log + github-issue for DOWN status
    # ─────────────────────────────────────────────────
    53: {
        "label": "API Health Monitoring (Every 6h)",
        "message": r"""PERIODIC TASK: EClaw Platform Health Monitoring (runs 3x daily).

== HOW TO GET YOUR CREDENTIALS ==
Look at the [AVAILABLE TOOLS — Mission Dashboard] section appended BELOW this message.
Find the pre-filled curl command and extract:
- DEVICE_ID = value after "deviceId=" in that URL
- BOT_SECRET = value after "botSecret=" in that URL

== IMPORTANT ==
APIs are on https://eclawbot.com (external), NOT inside OpenClaw. Use exec + curl.

== STEP 1: Core API Health (7 endpoints) ==
Test each and record HTTP status + response time:

exec: curl -s -o /dev/null -w "%{http_code} %{time_total}s" "https://eclawbot.com/api/health"
exec: curl -s -o /dev/null -w "%{http_code} %{time_total}s" "https://eclawbot.com/api/version"
exec: curl -s -o /dev/null -w "%{http_code} %{time_total}s" "https://eclawbot.com/api/skill-templates"
exec: curl -s -o /dev/null -w "%{http_code} %{time_total}s" "https://eclawbot.com/api/soul-templates"
exec: curl -s -o /dev/null -w "%{http_code} %{time_total}s" "https://eclawbot.com/api/rule-templates"
exec: curl -s -o /dev/null -w "%{http_code} %{time_total}s" "https://eclawbot.com/api/auth/oauth/providers"
exec: curl -s -o /dev/null -w "%{http_code} %{time_total}s" "https://eclawbot.com/.well-known/agent.json"

== STEP 2: Auth-required endpoints (3 endpoints) ==
exec: curl -s -o /dev/null -w "%{http_code} %{time_total}s" "https://eclawbot.com/api/entities?deviceId=DEVICE_ID&deviceSecret=BOT_SECRET"
exec: curl -s -o /dev/null -w "%{http_code} %{time_total}s" "https://eclawbot.com/api/schedules?deviceId=DEVICE_ID&deviceSecret=BOT_SECRET"
exec: curl -s -o /dev/null -w "%{http_code} %{time_total}s" "https://eclawbot.com/api/mission/dashboard?deviceId=DEVICE_ID&deviceSecret=BOT_SECRET"

== STEP 3: Publisher check ==
exec: curl -s "https://eclawbot.com/api/publisher/platforms"
Count platforms with configured=true.

== STEP 4: Submit structured audit results ==
Build findings array — one entry per endpoint tested:

exec: curl -s -X POST "https://eclawbot.com/api/bot/audit-log" -H "Content-Type: application/json" -d '{"deviceId":"DEVICE_ID","botSecret":"BOT_SECRET","entityId":2,"type":"api-health","severity":"SEVERITY","summary":"Core: X/7 OK, Auth: Y/3 OK, Publisher: Z configured. Slow: LIST","findings":[{"item":"/api/health","status":"ok","detail":"200 0.12s"},{"item":"/api/skill-templates","status":"warning","detail":"200 3.2s","suggestion":"Response slow >2s, check DB query performance"}]}'

Severity rules:
- "info" = all endpoints 200, none >2s
- "warning" = 1-2 endpoints failed or slow
- "critical" = 3+ endpoints failed

== STEP 5: Create GitHub issue if DEGRADED/DOWN ==
Only if severity is "critical" (3+ failures):
exec: curl -s -X POST "https://eclawbot.com/api/bot/github-issue" -H "Content-Type: application/json" -d '{"deviceId":"DEVICE_ID","botSecret":"BOT_SECRET","entityId":2,"title":"[Health] Platform degraded: N endpoints failing","body":"## Platform Health Alert\n\n**Time:** DATETIME UTC\n**Status:** DEGRADED/DOWN\n\n### Failed Endpoints\n- ENDPOINT: STATUS DETAIL\n\n### Action Required\nInvestigate server logs and restart if necessary.","labels":["infrastructure","bug"]}'

== STEP 6: Store in Mission Dashboard ==
exec: curl -s -X POST "https://eclawbot.com/api/mission/note/add" -H "Content-Type: application/json" -d '{"deviceId":"DEVICE_ID","botSecret":"BOT_SECRET","title":"NOTE_TITLE","content":"NOTE_CONTENT","category":"audit"}'

== STEP 7: Brief summary via transform ==
"[Health] Core: X/7, Auth: Y/3, Publisher: Z. Status: HEALTHY/DEGRADED/DOWN"

== RULES ==
- Only create GitHub issues for CRITICAL severity (3+ failures)
- HEALTHY = all 200, none >2s; DEGRADED = 1-2 issues; DOWN = 3+
- Keep transform reports under 200 chars"""
    },

    # ─────────────────────────────────────────────────
    # #55 — OpenAPI Spec Audit
    # Closed-loop: audit-log + github-issue for gaps
    # ─────────────────────────────────────────────────
    55: {
        "label": "Weekly OpenAPI Spec Completeness Audit (Sunday)",
        "message": r"""WEEKLY TASK (Sunday 2AM): OpenAPI Specification Completeness Audit.

== HOW TO GET YOUR CREDENTIALS ==
Look at the [AVAILABLE TOOLS — Mission Dashboard] section appended BELOW this message.
Find the pre-filled curl command and extract:
- DEVICE_ID = value after "deviceId=" in that URL
- BOT_SECRET = value after "botSecret=" in that URL

== IMPORTANT ==
APIs are on https://eclawbot.com (external), NOT inside OpenClaw. Use exec + curl.

== STEP 1: Fetch the OpenAPI spec ==
exec: curl -s "https://eclawbot.com/api/docs/openapi.yaml"

Parse YAML. List all paths under "paths:". Count total documented endpoints.

== STEP 2: Probe endpoint groups ==
Test these groups. 400/401/403 = exists, 404 = not exist.

exec: curl -s -o /dev/null -w "%{http_code}" "https://eclawbot.com/api/health"
exec: curl -s -o /dev/null -w "%{http_code}" "https://eclawbot.com/api/version"
exec: curl -s -o /dev/null -w "%{http_code}" "https://eclawbot.com/api/auth/oauth/providers"
exec: curl -s -o /dev/null -w "%{http_code}" -X POST "https://eclawbot.com/api/auth/register" -H "Content-Type: application/json" -d "{}"
exec: curl -s -o /dev/null -w "%{http_code}" -X POST "https://eclawbot.com/api/auth/login" -H "Content-Type: application/json" -d "{}"
exec: curl -s -o /dev/null -w "%{http_code}" -X POST "https://eclawbot.com/api/oauth/clients" -H "Content-Type: application/json" -d "{}"
exec: curl -s -o /dev/null -w "%{http_code}" "https://eclawbot.com/.well-known/agent.json"
exec: curl -s -o /dev/null -w "%{http_code}" "https://eclawbot.com/api/publisher/platforms"
exec: curl -s -o /dev/null -w "%{http_code}" "https://eclawbot.com/api/publisher/health"
exec: curl -s -o /dev/null -w "%{http_code}" "https://eclawbot.com/api/mission/dashboard?deviceId=DEVICE_ID&deviceSecret=BOT_SECRET"
exec: curl -s -o /dev/null -w "%{http_code}" "https://eclawbot.com/api/contacts?deviceId=DEVICE_ID&deviceSecret=BOT_SECRET"
exec: curl -s -o /dev/null -w "%{http_code}" "https://eclawbot.com/api/notifications/vapid-key"
exec: curl -s -o /dev/null -w "%{http_code}" "https://eclawbot.com/api/device-telemetry/summary?deviceId=DEVICE_ID&deviceSecret=BOT_SECRET"
exec: curl -s -o /dev/null -w "%{http_code}" "https://eclawbot.com/api/feedback?deviceId=DEVICE_ID&deviceSecret=BOT_SECRET"
exec: curl -s -o /dev/null -w "%{http_code}" "https://eclawbot.com/api/bot/audit-log" -X POST -H "Content-Type: application/json" -d "{}"
exec: curl -s -o /dev/null -w "%{http_code}" "https://eclawbot.com/api/bot/github-issue" -X POST -H "Content-Type: application/json" -d "{}"

== STEP 3: Compare and classify ==
- Exists (non-404) AND in spec → documented
- Exists (non-404) AND NOT in spec → UNDOCUMENTED GAP
- In spec AND returns 404 → STALE (removed endpoint still in spec)

== STEP 4: Submit structured audit ==
exec: curl -s -X POST "https://eclawbot.com/api/bot/audit-log" -H "Content-Type: application/json" -d '{"deviceId":"DEVICE_ID","botSecret":"BOT_SECRET","entityId":2,"type":"openapi-audit","severity":"SEVERITY","summary":"Spec paths: N, Probed: M, Documented: X, Gaps: Y, Stale: Z, Coverage: P%","findings":[{"item":"/api/publisher/health","status":"missing","detail":"Endpoint exists (200) but not in OpenAPI spec","suggestion":"Add to openapi.yaml with schema"},{"item":"/api/old-endpoint","status":"stale","detail":"In spec but returns 404","suggestion":"Remove from openapi.yaml"}]}'

Severity: "info" if coverage >80%, "warning" if 60-80%, "critical" if <60%.

== STEP 5: Create GitHub issue for significant gaps ==
If there are >3 undocumented endpoints, create ONE consolidated issue:
exec: curl -s -X POST "https://eclawbot.com/api/bot/github-issue" -H "Content-Type: application/json" -d '{"deviceId":"DEVICE_ID","botSecret":"BOT_SECRET","entityId":2,"title":"[OpenAPI] N undocumented endpoints found","body":"## OpenAPI Spec Gaps\n\n**Date:** YYYY-MM-DD\n**Coverage:** P%\n\n### Undocumented Endpoints\n- `/api/endpoint1` — exists (STATUS), needs schema\n- `/api/endpoint2` — exists (STATUS), needs schema\n\n### Stale Entries\n- `/api/old` — returns 404, remove from spec\n\n### Suggested Action\nAdd missing endpoints to `backend/openapi.yaml` with request/response schemas.","labels":["documentation"]}'

== STEP 6: Store in Mission Dashboard ==
exec: curl -s -X POST "https://eclawbot.com/api/mission/note/add" -H "Content-Type: application/json" -d '{"deviceId":"DEVICE_ID","botSecret":"BOT_SECRET","title":"NOTE_TITLE","content":"NOTE_CONTENT","category":"audit"}'

== RULES ==
- Only safe GET or empty POST bodies (never create real data)
- Create at most 1 GitHub issue per audit run
- Focus on gaps, not fixing them"""
    },

    # ─────────────────────────────────────────────────
    # #56 — Cross-platform Parity Audit
    # Closed-loop: audit-log + github-issue for gaps
    # ─────────────────────────────────────────────────
    56: {
        "label": "Weekly Cross-platform Feature Parity Audit (Wednesday)",
        "message": r"""WEEKLY TASK (Wednesday 2PM): Cross-platform Feature Parity Audit.

== HOW TO GET YOUR CREDENTIALS ==
Look at the [AVAILABLE TOOLS — Mission Dashboard] section appended BELOW this message.
Find the pre-filled curl command and extract:
- DEVICE_ID = value after "deviceId=" in that URL
- BOT_SECRET = value after "botSecret=" in that URL

== IMPORTANT ==
APIs are on https://eclawbot.com (external), NOT inside OpenClaw. Use exec + curl.

== STEP 1: Probe API feature groups ==
Test each group (200/400/401 = exists, 404 = not exist):

exec: curl -s -o /dev/null -w "%{http_code}" "https://eclawbot.com/api/entities?deviceId=DEVICE_ID&deviceSecret=BOT_SECRET"
exec: curl -s -o /dev/null -w "%{http_code}" "https://eclawbot.com/api/entity/agent-card?deviceId=DEVICE_ID&deviceSecret=BOT_SECRET&entityId=0"
exec: curl -s -o /dev/null -w "%{http_code}" -X POST "https://eclawbot.com/api/chat/history" -H "Content-Type: application/json" -d '{"deviceId":"DEVICE_ID","deviceSecret":"BOT_SECRET","entityId":0}'
exec: curl -s -o /dev/null -w "%{http_code}" "https://eclawbot.com/api/mission/dashboard?deviceId=DEVICE_ID&deviceSecret=BOT_SECRET"
exec: curl -s -o /dev/null -w "%{http_code}" "https://eclawbot.com/api/schedules?deviceId=DEVICE_ID&deviceSecret=BOT_SECRET"
exec: curl -s -o /dev/null -w "%{http_code}" "https://eclawbot.com/api/contacts?deviceId=DEVICE_ID&deviceSecret=BOT_SECRET"
exec: curl -s -o /dev/null -w "%{http_code}" "https://eclawbot.com/api/device-vars?deviceId=DEVICE_ID&deviceSecret=BOT_SECRET"
exec: curl -s -o /dev/null -w "%{http_code}" "https://eclawbot.com/api/feedback?deviceId=DEVICE_ID&deviceSecret=BOT_SECRET"
exec: curl -s -o /dev/null -w "%{http_code}" "https://eclawbot.com/api/publisher/platforms"
exec: curl -s -o /dev/null -w "%{http_code}" "https://eclawbot.com/api/device-telemetry/summary?deviceId=DEVICE_ID&deviceSecret=BOT_SECRET"
exec: curl -s -o /dev/null -w "%{http_code}" "https://eclawbot.com/api/notifications/vapid-key"

== STEP 2: Check Web Portal pages ==
exec: curl -s -o /dev/null -w "%{http_code}" "https://eclawbot.com/portal/dashboard.html"
exec: curl -s -o /dev/null -w "%{http_code}" "https://eclawbot.com/portal/chat.html"
exec: curl -s -o /dev/null -w "%{http_code}" "https://eclawbot.com/portal/mission.html"
exec: curl -s -o /dev/null -w "%{http_code}" "https://eclawbot.com/portal/schedule.html"
exec: curl -s -o /dev/null -w "%{http_code}" "https://eclawbot.com/portal/settings.html"
exec: curl -s -o /dev/null -w "%{http_code}" "https://eclawbot.com/portal/env-vars.html"
exec: curl -s -o /dev/null -w "%{http_code}" "https://eclawbot.com/portal/files.html"
exec: curl -s -o /dev/null -w "%{http_code}" "https://eclawbot.com/portal/feedback.html"
exec: curl -s -o /dev/null -w "%{http_code}" "https://eclawbot.com/portal/card-holder.html"

== STEP 3: Compile parity matrix ==
14 feature areas: Entity CRUD, Chat, Mission, Scheduler, Settings, File Manager, Feedback, Card Holder, Env Vars, Notifications, Publisher, AI Support, Screen Control, Telemetry.

For each: API exists? Web page exists?

== STEP 4: Submit structured audit ==
exec: curl -s -X POST "https://eclawbot.com/api/bot/audit-log" -H "Content-Type: application/json" -d '{"deviceId":"DEVICE_ID","botSecret":"BOT_SECRET","entityId":2,"type":"parity-audit","severity":"SEVERITY","summary":"APIs: X/14, Web pages: Y/9, Full stack: Z","findings":[{"item":"Publisher","status":"missing","detail":"API exists but no Web Portal page","suggestion":"Add /portal/publisher.html"},{"item":"AI Support","status":"ok","detail":"API + Web both exist"}]}'

Use status "ok" for features with both API and Web, "missing" for gaps.

== STEP 5: Create GitHub issue for significant gaps ==
If >2 features have missing Web pages or APIs:
exec: curl -s -X POST "https://eclawbot.com/api/bot/github-issue" -H "Content-Type: application/json" -d '{"deviceId":"DEVICE_ID","botSecret":"BOT_SECRET","entityId":2,"title":"[Parity] N features missing cross-platform support","body":"## Cross-platform Parity Gaps\n\n**Date:** YYYY-MM-DD\n\n### API-only (no Web Portal page)\n- Feature: DETAIL\n\n### Web-only (no API)\n- Feature: DETAIL\n\n### Action Required\nAdd missing pages/APIs to achieve feature parity.","labels":["feature-parity","enhancement"]}'

== STEP 6: Store in Mission Dashboard ==
exec: curl -s -X POST "https://eclawbot.com/api/mission/note/add" -H "Content-Type: application/json" -d '{"deviceId":"DEVICE_ID","botSecret":"BOT_SECRET","title":"NOTE_TITLE","content":"NOTE_CONTENT","category":"audit"}'

== RULES ==
- READ-ONLY audit — do not create or modify data
- Create at most 1 GitHub issue per audit run"""
    },

    # ─────────────────────────────────────────────────
    # #57 — Community Engagement Monitor
    # Closed-loop: audit-log + mission TODO for urgent comments
    # ─────────────────────────────────────────────────
    57: {
        "label": "Daily Community Engagement Monitor (DEV.to/Hashnode)",
        "message": r"""DAILY TASK: Monitor community engagement on EClaw's published articles.

== HOW TO GET YOUR CREDENTIALS ==
Look at the [AVAILABLE TOOLS — Mission Dashboard] section appended BELOW this message.
Find the pre-filled curl command and extract:
- DEVICE_ID = value after "deviceId=" in that URL
- BOT_SECRET = value after "botSecret=" in that URL

== IMPORTANT ==
APIs are on https://eclawbot.com (external), NOT inside OpenClaw. Use exec + curl.
This is a READ-ONLY monitoring task. Do NOT post comments or replies.

== STEP 1: Check DEV.to articles and comments ==
exec: curl -s "https://dev.to/api/articles?username=eclaw&per_page=5"

For each article, extract: id, title, comments_count, public_reactions_count, page_views_count.

For articles with comments_count > 0:
exec: curl -s "https://dev.to/api/comments?a_id=ARTICLE_ID"

Note NEW comments (posted in last 24 hours).

== STEP 2: Check Hashnode articles ==
exec: curl -s -X POST "https://gql.hashnode.com" -H "Content-Type: application/json" -d '{"query":"{ publication(host:\"eclaw.hashnode.dev\") { posts(first:5) { edges { node { id title views reactionCount comments(first:5) { edges { node { id content dateAdded author { name } } } } } } } } }"}'

Extract: title, views, reactionCount, comment count.

== STEP 3: Check Mastodon engagement ==
exec: curl -s "https://mastodon.social/api/v1/accounts/lookup?acct=eclaw"
Get account ID, then:
exec: curl -s "https://mastodon.social/api/v1/accounts/ACCOUNT_ID/statuses?limit=5"
Note: replies_count, reblogs_count, favourites_count.

== STEP 4: Submit structured audit ==
exec: curl -s -X POST "https://eclawbot.com/api/bot/audit-log" -H "Content-Type: application/json" -d '{"deviceId":"DEVICE_ID","botSecret":"BOT_SECRET","entityId":2,"type":"community-engagement","severity":"SEVERITY","summary":"DEV.to: X articles Y comments Z reactions. Hashnode: A articles B comments C reactions. Mastodon: D posts E replies.","findings":[{"item":"DEV.to: Article Title","status":"ok","detail":"5 comments, 12 reactions"},{"item":"Hashnode: Article Title","status":"warning","detail":"New question comment needs response","suggestion":"Reply to user question about A2A setup"}]}'

Use "warning" status for comments that need official response.

== STEP 5: Create Mission TODOs for urgent items ==
If any comment is a question about EClaw, a bug report, or negative feedback:
exec: curl -s -X POST "https://eclawbot.com/api/mission/todo/add" -H "Content-Type: application/json" -d '{"deviceId":"DEVICE_ID","botSecret":"BOT_SECRET","title":"[Community] PLATFORM: Reply to COMMENTER about TOPIC","priority":2}'

Priority: 2 (medium) for questions, 3 (high) for bug reports, 1 (low) for general.

== STEP 6: Store in Mission Dashboard ==
exec: curl -s -X POST "https://eclawbot.com/api/mission/note/add" -H "Content-Type: application/json" -d '{"deviceId":"DEVICE_ID","botSecret":"BOT_SECRET","title":"NOTE_TITLE","content":"NOTE_CONTENT","category":"audit"}'

== STEP 7: Brief transform summary ==
"[Community] DEV.to: X comments Y reactions | Hashnode: A comments B reactions | Mastodon: C replies. Urgent: N"

== RULES ==
- READ ONLY — do NOT post replies, comments, or reactions
- Only create Mission TODOs for genuinely important comments
- Maximum 3 TODOs per run to avoid spam
- If no new engagement, just send "no new activity" via transform"""
    },
}


def update_schedule(schedule_id, data):
    payload = {
        "deviceId": DEVICE_ID,
        "deviceSecret": DEVICE_SECRET,
        **data,
    }
    body = json.dumps(payload, ensure_ascii=False)
    result = subprocess.run(
        ["curl", "-s", "-X", "PUT",
         f"{BASE}/api/schedules/{schedule_id}",
         "-H", "Content-Type: application/json",
         "-d", body],
        capture_output=True, text=True, timeout=30
    )
    try:
        resp = json.loads(result.stdout)
        return resp
    except Exception:
        return {"error": result.stdout[:200]}


if __name__ == "__main__":
    for sid, data in SCHEDULES.items():
        print(f"Updating #{sid} ({data['label']})...", end=" ")
        resp = update_schedule(sid, data)
        if resp.get("success"):
            print("OK")
        else:
            print(f"FAILED: {resp.get('error', resp)}")
    print("\nDone!")
