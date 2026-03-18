#!/usr/bin/env python3
"""Update schedules #51, #52, #53, #55, #56, #57 with concrete, executable steps."""

import json
import os
import subprocess
import sys

DEVICE_ID = "480def4c-2183-4d8e-afd0-b131ae89adcc"
DEVICE_SECRET = "3a4ddb10-2609-42b6-908a-f9d446c97ff9-7cff9697-6391-415d-a282-4e8aea3be49a"
BASE = "https://eclawbot.com"

SCHEDULES = {
    # ─────────────────────────────────────────────────
    # #51 — was "Skill Template Categorization" (BROKEN: no category field)
    # Redesigned to: Skill Template URL Validation + Quality Audit
    # ─────────────────────────────────────────────────
    51: {
        "label": "Daily Skill Template URL Validation + Quality Audit",
        "message": """DAILY TASK: Validate skill template URLs and audit template quality.

== HOW TO GET YOUR CREDENTIALS ==
Look at the [AVAILABLE TOOLS — Mission Dashboard] section appended BELOW this message.
Find the pre-filled curl command and extract:
- DEVICE_ID = value after "deviceId=" in that URL
- BOT_SECRET = value after "botSecret=" in that URL

== IMPORTANT ==
APIs are on https://eclawbot.com (external), NOT inside OpenClaw. Use exec + curl.

== STEP 1: Get all skill templates ==
exec: curl -s "https://eclawbot.com/api/skill-templates"

Parse the JSON response. You will get an array of templates with fields:
  id, label, icon, title, url, author, updatedAt, requiredVars, steps

== STEP 2: Pick 15 templates to validate ==
Select 15 templates. Prioritize templates you haven't checked before.
Keep a mental list of previously checked templates and rotate through them.

== STEP 3: Validate each template's GitHub URL ==
For each selected template that has a url field starting with "https://github.com/":
exec: curl -s -o /dev/null -w "%{http_code}" "TEMPLATE_URL"

Record: template id, url, HTTP status code.
- 200 = alive
- 404 = dead (repo deleted or renamed)
- 301/302 = redirected (note new URL)

== STEP 4: Audit template quality ==
For each of the 15 templates, check these quality criteria:
1. Has non-empty "steps" field? (templates without steps are incomplete)
2. Has "requiredVars" array with at least 1 entry? (templates needing env vars should declare them)
3. Has "author" field set? (should credit the author)
4. "updatedAt" is within the last 6 months? (stale templates may be outdated)

== STEP 5: Report via transform ==
Send a concise report with:
- Dead URLs (404): list template IDs and URLs
- Redirected URLs (301/302): list template IDs, old URL, new URL
- Incomplete templates (missing steps or requiredVars): list template IDs
- Stale templates (updatedAt > 6 months ago): list template IDs
- Summary: X/15 healthy, Y dead, Z incomplete

Format as Traditional Chinese. Keep it under 500 characters.

== RULES ==
- Process exactly 15 templates per run
- Do NOT try to modify or categorize templates — just validate and report
- If all 15 are healthy, just send a brief "all OK" summary
- Rotate which templates you check each day"""
    },

    # ─────────────────────────────────────────────────
    # #52 — Agent Card Ecosystem Builder
    # Fixed: removed vague "search for external agents", made concrete
    # ─────────────────────────────────────────────────
    52: {
        "label": "Daily Agent Card Maintenance",
        "message": """DAILY TASK: Maintain and update Agent Cards for all entities on this device.

== HOW TO GET YOUR CREDENTIALS ==
Look at the [AVAILABLE TOOLS — Mission Dashboard] section appended BELOW this message.
Find the pre-filled curl command and extract:
- DEVICE_ID = value after "deviceId=" in that URL
- BOT_SECRET = value after "botSecret=" in that URL

== IMPORTANT ==
APIs are on https://eclawbot.com (external), NOT inside OpenClaw. Use exec + curl.

== STEP 1: Check current entity status ==
exec: curl -s "https://eclawbot.com/api/entities?deviceId=DEVICE_ID&deviceSecret=BOT_SECRET"

For each entity, check if "agentCard" field exists and is non-null.
Note which entities are missing Agent Cards.

== STEP 2: Create Agent Card for entities missing one ==
For each entity WITHOUT an Agent Card, create one using:
exec: curl -s -X PUT "https://eclawbot.com/api/entity/agent-card" -H "Content-Type: application/json" -d '{"deviceId":"DEVICE_ID","deviceSecret":"BOT_SECRET","entityId":ENTITY_ID,"agentCard":{"description":"DESCRIPTION","capabilities":["cap1","cap2"],"protocols":["A2A"],"tags":["eclaw","iot"],"version":"1.0"}}'

Use these role descriptions:
- Entity 0: "EClaw platform monitor — daily reporting, template curation, content publishing, ecosystem health"
- Entity 1: "EClaw skill expert — skill template discovery, URL validation, social media skill sharing"
- Entity 2: "EClaw research analyst — A2A protocol research, API auditing, multi-platform article publishing"

Required field: "description" (string, non-empty)
Optional fields: "capabilities" (array, max 10), "protocols" (array), "tags" (array, max 20), "version" (string), "website" (string URL), "contactEmail" (string email)

== STEP 3: Update existing Agent Cards if stale ==
For entities that ALREADY have an Agent Card, check if the description still matches their current role. If it's been more than 7 days since last update, refresh the card:
exec: curl -s -X PUT "https://eclawbot.com/api/entity/agent-card" -H "Content-Type: application/json" -d '{"deviceId":"DEVICE_ID","deviceSecret":"BOT_SECRET","entityId":ENTITY_ID,"agentCard":{"description":"UPDATED_DESC","capabilities":[...],"protocols":["A2A"],"version":"1.1"}}'

== STEP 4: Verify A2A discovery endpoint ==
exec: curl -s "https://eclawbot.com/.well-known/agent.json"

Confirm the endpoint returns valid JSON with agent card data.

== STEP 5: Report via transform ==
Send summary: how many entities checked, cards created, cards updated, A2A endpoint status.
Format as Traditional Chinese, under 300 characters.

== RULES ==
- Do NOT overwrite existing Agent Cards unless updating stale info
- Capabilities should reflect what the entity actually does (based on its schedules)
- Maximum 10 capabilities per card
- Maximum 20 tags per card"""
    },

    # ─────────────────────────────────────────────────
    # #53 — API Health Monitoring (already good, minor improvements)
    # ─────────────────────────────────────────────────
    53: {
        "label": "API Health Monitoring (Every 6h)",
        "message": """PERIODIC TASK: EClaw Platform Health Monitoring (runs 3x daily).

== HOW TO GET YOUR CREDENTIALS ==
Look at the [AVAILABLE TOOLS — Mission Dashboard] section appended BELOW this message.
Find the pre-filled curl command and extract:
- DEVICE_ID = value after "deviceId=" in that URL
- BOT_SECRET = value after "botSecret=" in that URL

== IMPORTANT ==
APIs are on https://eclawbot.com (external), NOT inside OpenClaw. Use exec + curl.

== STEP 1: Core API Health (7 endpoints) ==
Test each endpoint and record HTTP status code + response time:

exec: curl -s -o /dev/null -w "%{http_code} %{time_total}s" "https://eclawbot.com/api/health"
exec: curl -s -o /dev/null -w "%{http_code} %{time_total}s" "https://eclawbot.com/api/version"
exec: curl -s -o /dev/null -w "%{http_code} %{time_total}s" "https://eclawbot.com/api/skill-templates"
exec: curl -s -o /dev/null -w "%{http_code} %{time_total}s" "https://eclawbot.com/api/soul-templates"
exec: curl -s -o /dev/null -w "%{http_code} %{time_total}s" "https://eclawbot.com/api/rule-templates"
exec: curl -s -o /dev/null -w "%{http_code} %{time_total}s" "https://eclawbot.com/api/auth/oauth/providers"
exec: curl -s -o /dev/null -w "%{http_code} %{time_total}s" "https://eclawbot.com/.well-known/agent.json"

Expected: all return 200.

== STEP 2: Auth-required endpoints (3 endpoints) ==
exec: curl -s -o /dev/null -w "%{http_code} %{time_total}s" "https://eclawbot.com/api/entities?deviceId=DEVICE_ID"
exec: curl -s -o /dev/null -w "%{http_code} %{time_total}s" "https://eclawbot.com/api/status?deviceId=DEVICE_ID&botSecret=BOT_SECRET&entityId=2"
exec: curl -s -o /dev/null -w "%{http_code} %{time_total}s" "https://eclawbot.com/api/mission/dashboard?deviceId=DEVICE_ID&botSecret=BOT_SECRET&entityId=2"

Expected: all return 200.

== STEP 3: Publisher platform check ==
exec: curl -s "https://eclawbot.com/api/publisher/platforms"

Count how many platforms have configured=true. Note any with configured=false.

== STEP 4: Compose health report ==
Format:
  [Health] YYYY-MM-DD HH:MM
  Core: X/7 OK | Auth: Y/3 OK | Publisher: Z configured
  Slow (>2s): [list or "none"]
  Errors: [list or "none"]
  Status: HEALTHY / DEGRADED / DOWN

Send via transform as a short message (<300 chars).

== RULES ==
- HEALTHY = all endpoints 200, none >2s
- DEGRADED = 1-2 endpoints failed or slow
- DOWN = 3+ endpoints failed
- Only add a Mission Dashboard note if DEGRADED or DOWN
- Keep reports concise — no need to list every endpoint if all OK"""
    },

    # ─────────────────────────────────────────────────
    # #55 — Weekly OpenAPI Spec Completeness Audit (already good)
    # ─────────────────────────────────────────────────
    55: {
        "label": "Weekly OpenAPI Spec Completeness Audit (Sunday)",
        "message": """WEEKLY TASK (Sunday 2AM): OpenAPI Specification Completeness Audit.

== HOW TO GET YOUR CREDENTIALS ==
Look at the [AVAILABLE TOOLS — Mission Dashboard] section appended BELOW this message.
Find the pre-filled curl command and extract:
- DEVICE_ID = value after "deviceId=" in that URL
- BOT_SECRET = value after "botSecret=" in that URL

== IMPORTANT ==
APIs are on https://eclawbot.com (external), NOT inside OpenClaw. Use exec + curl.

== STEP 1: Fetch the OpenAPI spec ==
exec: curl -s "https://eclawbot.com/api/docs/openapi.yaml"

Parse the YAML. List all paths defined in the spec under the "paths:" section.
Count total number of documented endpoints.

== STEP 2: Probe endpoint groups to find undocumented ones ==
Test these endpoint groups. A response of 400/401/403 means the endpoint EXISTS (just needs auth).
A 404 means it does NOT exist. Record each result.

Core:
exec: curl -s -o /dev/null -w "%{http_code}" "https://eclawbot.com/api/health"
exec: curl -s -o /dev/null -w "%{http_code}" "https://eclawbot.com/api/version"

Auth:
exec: curl -s -o /dev/null -w "%{http_code}" "https://eclawbot.com/api/auth/oauth/providers"
exec: curl -s -o /dev/null -w "%{http_code}" -X POST "https://eclawbot.com/api/auth/register" -H "Content-Type: application/json" -d "{}"
exec: curl -s -o /dev/null -w "%{http_code}" -X POST "https://eclawbot.com/api/auth/login" -H "Content-Type: application/json" -d "{}"

OAuth:
exec: curl -s -o /dev/null -w "%{http_code}" -X POST "https://eclawbot.com/api/oauth/clients" -H "Content-Type: application/json" -d "{}"

A2A:
exec: curl -s -o /dev/null -w "%{http_code}" "https://eclawbot.com/.well-known/agent.json"

Publisher:
exec: curl -s -o /dev/null -w "%{http_code}" "https://eclawbot.com/api/publisher/platforms"
exec: curl -s -o /dev/null -w "%{http_code}" "https://eclawbot.com/api/publisher/health"

Mission:
exec: curl -s -o /dev/null -w "%{http_code}" "https://eclawbot.com/api/mission/dashboard?deviceId=DEVICE_ID&deviceSecret=BOT_SECRET"

Contacts:
exec: curl -s -o /dev/null -w "%{http_code}" "https://eclawbot.com/api/contacts?deviceId=DEVICE_ID&deviceSecret=BOT_SECRET"

Notifications:
exec: curl -s -o /dev/null -w "%{http_code}" "https://eclawbot.com/api/notifications/vapid-key"

Telemetry:
exec: curl -s -o /dev/null -w "%{http_code}" "https://eclawbot.com/api/device-telemetry/summary?deviceId=DEVICE_ID&deviceSecret=BOT_SECRET"

Feedback:
exec: curl -s -o /dev/null -w "%{http_code}" "https://eclawbot.com/api/feedback?deviceId=DEVICE_ID&deviceSecret=BOT_SECRET"

Schedules:
exec: curl -s -o /dev/null -w "%{http_code}" "https://eclawbot.com/api/schedules?deviceId=DEVICE_ID&deviceSecret=BOT_SECRET"

== STEP 3: Compare and report ==
For each endpoint tested:
- If it exists (non-404) AND is in the OpenAPI spec → documented
- If it exists (non-404) AND NOT in the OpenAPI spec → UNDOCUMENTED (gap)
- If it's in the spec AND returns 404 → STALE (spec lists a removed endpoint)

Report format:
  [OpenAPI Audit] YYYY-MM-DD
  Spec paths: N
  Endpoints probed: M
  Documented: X
  Undocumented (gaps): Y — list them
  Stale (removed): Z — list them
  Coverage: X/(X+Y) = P%

== STEP 4: Save findings ==
If coverage < 80% or >3 undocumented endpoints found, add a Mission Dashboard note:
exec: curl -s -X POST "https://eclawbot.com/api/mission/note/add" -H "Content-Type: application/json" -d '{"deviceId":"DEVICE_ID","deviceSecret":"BOT_SECRET","title":"OpenAPI Audit YYYY-MM-DD","content":"FINDINGS_HERE","category":"audit"}'

Otherwise, just send a brief summary via transform.

== RULES ==
- Only test with safe GET or empty POST bodies (never create real data)
- 400/401/403 = endpoint exists, 404 = does not exist
- Focus on documentation gaps, not fixing them"""
    },

    # ─────────────────────────────────────────────────
    # #56 — Cross-platform Parity Audit
    # Fixed: replaced private GitHub URL with direct API probing
    # ─────────────────────────────────────────────────
    56: {
        "label": "Weekly Cross-platform Feature Parity Audit (Wednesday)",
        "message": """WEEKLY TASK (Wednesday 2PM): Cross-platform Feature Parity Audit.

Compare what EClaw APIs support vs what each client platform (Web, Android, iOS) uses.

== HOW TO GET YOUR CREDENTIALS ==
Look at the [AVAILABLE TOOLS — Mission Dashboard] section appended BELOW this message.
Find the pre-filled curl command and extract:
- DEVICE_ID = value after "deviceId=" in that URL
- BOT_SECRET = value after "botSecret=" in that URL

== IMPORTANT ==
APIs are on https://eclawbot.com (external), NOT inside OpenClaw. Use exec + curl.

== STEP 1: Probe all feature API groups ==
Test each API group and record which ones return 200 (or 400/401 = exists):

Entity Management:
exec: curl -s -o /dev/null -w "%{http_code}" "https://eclawbot.com/api/entities?deviceId=DEVICE_ID&deviceSecret=BOT_SECRET"
exec: curl -s -o /dev/null -w "%{http_code}" "https://eclawbot.com/api/entity/agent-card?deviceId=DEVICE_ID&deviceSecret=BOT_SECRET&entityId=0"

Chat:
exec: curl -s -o /dev/null -w "%{http_code}" -X POST "https://eclawbot.com/api/chat/history" -H "Content-Type: application/json" -d '{"deviceId":"DEVICE_ID","deviceSecret":"BOT_SECRET","entityId":0}'

Mission Dashboard:
exec: curl -s -o /dev/null -w "%{http_code}" "https://eclawbot.com/api/mission/dashboard?deviceId=DEVICE_ID&deviceSecret=BOT_SECRET"

Scheduler:
exec: curl -s -o /dev/null -w "%{http_code}" "https://eclawbot.com/api/schedules?deviceId=DEVICE_ID&deviceSecret=BOT_SECRET"

Notifications:
exec: curl -s -o /dev/null -w "%{http_code}" "https://eclawbot.com/api/notifications/vapid-key"

Card Holder:
exec: curl -s -o /dev/null -w "%{http_code}" "https://eclawbot.com/api/contacts?deviceId=DEVICE_ID&deviceSecret=BOT_SECRET"

Env Vars:
exec: curl -s -o /dev/null -w "%{http_code}" "https://eclawbot.com/api/device-vars?deviceId=DEVICE_ID&deviceSecret=BOT_SECRET"

Feedback:
exec: curl -s -o /dev/null -w "%{http_code}" "https://eclawbot.com/api/feedback?deviceId=DEVICE_ID&deviceSecret=BOT_SECRET"

Publisher:
exec: curl -s -o /dev/null -w "%{http_code}" "https://eclawbot.com/api/publisher/platforms"

Telemetry:
exec: curl -s -o /dev/null -w "%{http_code}" "https://eclawbot.com/api/device-telemetry/summary?deviceId=DEVICE_ID&deviceSecret=BOT_SECRET"

AI Support:
exec: curl -s -o /dev/null -w "%{http_code}" -X POST "https://eclawbot.com/api/ai-support/chat" -H "Content-Type: application/json" -d '{"deviceId":"DEVICE_ID","deviceSecret":"BOT_SECRET"}'

== STEP 2: Check Web Portal page availability ==
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
For each feature, note:
- API available? (from Step 1)
- Web Portal page exists? (from Step 2)
- Known platform support: Web=Yes if portal page returns 200, Android/iOS=Unknown (can't test from server)

Feature areas to compare:
1. Entity CRUD + Agent Card
2. Chat (text + images)
3. Mission Dashboard
4. Scheduler
5. Settings / Preferences
6. File Manager
7. Feedback
8. Card Holder
9. Env Vars
10. Notifications
11. Publisher
12. AI Support
13. Screen Control
14. Telemetry

== STEP 4: Report ==
Send via transform:
  [Parity Audit] YYYY-MM-DD
  APIs available: X/14
  Web Portal pages: Y/9
  Features with full stack (API+Web): Z
  API-only (no Web page): list
  Web-only (no API): list

If significant gaps found (>2 features missing Web pages), add a Mission note.

== RULES ==
- This is a READ-ONLY audit — do not create or modify any data
- 200/400/401/403 = endpoint exists, 404 = does not exist
- Focus on identifying gaps between API and UI coverage"""
    },

    # ─────────────────────────────────────────────────
    # #57 — Community Engagement
    # Fixed: read-only monitoring, no posting (bot doesn't have API keys)
    # ─────────────────────────────────────────────────
    57: {
        "label": "Daily Community Engagement Monitor (DEV.to/Hashnode)",
        "message": """DAILY TASK: Monitor community engagement on EClaw's published articles.

== HOW TO GET YOUR CREDENTIALS ==
Look at the [AVAILABLE TOOLS — Mission Dashboard] section appended BELOW this message.
Find the pre-filled curl command and extract:
- DEVICE_ID = value after "deviceId=" in that URL
- BOT_SECRET = value after "botSecret=" in that URL

== IMPORTANT ==
APIs are on https://eclawbot.com (external), NOT inside OpenClaw. Use exec + curl.
This is a READ-ONLY monitoring task. Do NOT post comments or replies.

== STEP 1: Check DEV.to articles and comments ==
Get latest 5 articles:
exec: curl -s "https://dev.to/api/articles?username=eclaw&per_page=5"

For each article, extract: id, title, comments_count, public_reactions_count, page_views_count.

For articles with comments_count > 0, check the comments:
exec: curl -s "https://dev.to/api/comments?a_id=ARTICLE_ID"

Note any NEW comments (posted in the last 24 hours). Record: commenter name, comment snippet (first 100 chars), timestamp.

== STEP 2: Check Hashnode articles ==
exec: curl -s -X POST "https://gql.hashnode.com" -H "Content-Type: application/json" -d '{"query":"{ publication(host:\\"eclaw.hashnode.dev\\") { posts(first:5) { edges { node { id title views reactionCount comments(first:5) { edges { node { id content dateAdded author { name } } } } } } } } }"}'

Parse the response. For each post, extract: title, views, reactionCount, comment count.
Note any new comments from the last 24 hours.

== STEP 3: Check Mastodon engagement ==
exec: curl -s "https://mastodon.social/api/v1/accounts/lookup?acct=eclaw"

Get the account ID, then check recent statuses:
exec: curl -s "https://mastodon.social/api/v1/accounts/ACCOUNT_ID/statuses?limit=5"

For each status, note: replies_count, reblogs_count, favourites_count.

== STEP 4: Compose engagement report ==
Send via transform in Traditional Chinese:

  [社群互動] YYYY-MM-DD
  DEV.to: X篇文章, Y則留言, Z個反應
  Hashnode: X篇文章, Y則留言, Z個反應
  Mastodon: X則貼文, Y則回覆, Z個轉發

  新留言 (24h): [list if any, or "無"]

Keep under 500 characters.

== STEP 5: Flag urgent items ==
If any comment is:
- A question about EClaw (needs official response)
- A bug report
- A negative/critical comment

Add a Mission Dashboard TODO:
exec: curl -s -X POST "https://eclawbot.com/api/mission/todo/add" -H "Content-Type: application/json" -d '{"deviceId":"DEVICE_ID","deviceSecret":"BOT_SECRET","text":"[社群] PLATFORM: SUMMARY_OF_COMMENT","priority":"medium"}'

== RULES ==
- READ ONLY — do NOT post replies, comments, or reactions
- Only flag genuinely important comments as Mission TODOs
- If no new engagement, just send a brief "no new activity" report
- Check all 3 platforms even if one has no articles yet"""
    },
}


def update_schedule(schedule_id, data):
    """Update a schedule via PUT /api/schedules/:id"""
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
    except:
        return {"error": result.stdout[:200], "stderr": result.stderr[:200]}


if __name__ == "__main__":
    for sid, data in SCHEDULES.items():
        print(f"Updating schedule #{sid} ({data['label']})...", end=" ")
        resp = update_schedule(sid, data)
        if resp.get("success"):
            print("OK ✓")
        else:
            print(f"FAILED: {resp.get('error', resp)}")
    print("\nDone!")
