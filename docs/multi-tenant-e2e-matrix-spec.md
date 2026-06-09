# Compliance Part B Slice 2/3 — Multi-tenant E2E Matrix Spec

**Card**: card_25021d746bfdc31e29a167ef (Strategic compliance Part B).
**Parent**: card_923709f59ecb0c1cd66bc786 (Weekly compliance + multi-tenant audit cron).
**Author**: #2 LOBSTER, 2026-06-10 01:42 TW.
**Status**: Draft. Implementation card filed after merge + Hank confirms ship-now.

## Position in the larger plan

| Slice | Scope | Status |
|-------|-------|--------|
| 1     | Modular routers (entity-status, agent-improvement) via jest pool-mocks | ✓ shipped PR #3273 (7/7 pass) |
| 2     | Visual surfaces (chat/kanban/dashboard/settings) via Playwright on prod | **This spec, implementation deferred** |
| 3     | Consolidated baseline JSON (like docs/compliance-baseline-2026-06-09.json) | **This spec, implementation deferred** |
| 4     | Part C cron + delta alerting | Deferred to follow-up card under parent |

Slice 1 covered the surfaces whose entity-isolation lives in SQL `WHERE` clauses inside exported helpers — straightforward jest with pool mocks. Slices 2/3 must hit live prod because chat.html / kanban.html / dashboard.html / settings.html scope by entity at the browser-state layer (URL params + sessionStorage + cross-script side-channels). The only way to prove no leakage is to drive two real entity sessions in parallel.

## Slice 2 — Playwright multi-tenant visual matrix

### Pre-flight (run once, not per row)

1. Resolve `PROD_E2E_DEVICE_ID` + `PROD_E2E_DEVICE_SECRET` from `backend/.env` (per `reference_prod_e2e_creds.md`).
   - Never paste literals into PR/comments/screenshots.
2. Sanity probe: `curl https://eclawbot.com/api/entities?deviceId=...&deviceSecret=...` → confirm at least 2 entity rows.
3. Pick two entity ids for the matrix: `ENT_A = 2` (LOBSTER), `ENT_B = 5` (Hermes) — both exist on the test device.

### Per-row procedure (4 visual rows)

For each `(surface, viewport)` combo in:
```
SURFACES = ["chat.html", "kanban.html", "dashboard.html", "settings.html"]
VIEWPORTS = [(390, 844, "mobile"), (1280, 800, "desktop")]
```

Do:
1. `browser_resize` to the viewport.
2. `browser_navigate` to `https://eclawbot.com/portal/<surface>?deviceId=...&deviceSecret=...&entityId=ENT_A` — open as entity A.
3. Wait 1.5s for the page to settle (`i18n.apply()` is async).
4. `browser_evaluate` returning a tag-shaped snapshot of what the page renders for entity A.
   - chat.html: capture the message list DOM (no entity_B name should appear in entity_A's own-message bubbles).
   - kanban.html: capture the columns + visible cards. Note any card with `assignedBots` excluding ENT_A.
   - dashboard.html: capture the entity-picker state + visible card-count metric.
   - settings.html: capture every `<input>` value + the currently selected entity row.
5. Screenshot: `destructive-modal-<surface>-<viewport>-<WxH>.png` style filename, mobile + desktop variants.
6. Repeat steps 2-5 with `entityId=ENT_B` to get entity B's snapshot.
7. Cross-compare:
   - `ent_a_snapshot` MUST NOT contain entity B's PII (deviceId+entityId combos, names, custom titles).
   - `ent_b_snapshot` MUST NOT contain entity A's PII.
   - Console errors before/after entity-switch must be zero delta (per the existing destructive-modals playbook rule).

### Per-row PASS criteria

```
PASS — multi-tenant E2E <surface>/<viewport>
ent_a leaks: 0    ent_b leaks: 0
console error delta: 0
screenshot_a: <fileId>    screenshot_b: <fileId>
```

### Per-row FAIL handling

```
FAIL — multi-tenant E2E <surface>/<viewport>
leak_direction: ent_a → sees ent_b's "<excerpt>"
file: <surface line N>
screenshot: <path>
```

Per [memory feedback_e2e_post_deploy_real_url]: never /move card done on FAIL. File a child card per leak; that child carries the fix.

### Important rails

- Drive Playwright MCP from THIS same Claude Code session — never `claude -p` (per `feedback_never_dash_p`).
- Console errors must be measured pre/post entity-switch only — pre-existing baseline noise (the `/api/wallet/balance` 401 etc.) is not counted (per the destructive-modals playbook).
- Same screenshot-size discipline as the Hermes H2 roadmap audit earlier today: sips compress to ≤1024px before /file upload; fall back to SendUserFile if the kanban /file gate rejects with payload_too_large.

## Slice 3 — Consolidated baseline JSON

After Slice 2 runs, emit `docs/multi-tenant-baseline-2026-06-XX.json`:

```jsonc
{
  "ran_at": "2026-06-XX...",          // wall clock; not Date.now() (per [memory feedback_…])
  "device_id": "[redacted]",          // hash of deviceId so the file is shareable
  "ent_a_entity_id": 2,
  "ent_b_entity_id": 5,
  "rows": [
    {
      "surface": "chat.html",
      "viewport": "mobile",
      "pass": true,
      "ent_a_leaks": 0,
      "ent_b_leaks": 0,
      "console_error_delta": 0,
      "screenshot_a": "<fileId>",
      "screenshot_b": "<fileId>"
    },
    // ...one row per surface × viewport
  ],
  "summary": {
    "total_combos": 8,                 // 4 surfaces × 2 viewports
    "pass_count": 8,
    "fail_count": 0,
    "child_cards_filed": []
  }
}
```

This baseline becomes the input for Part C's delta-alerting cron (separate card, deferred).

## Acceptance for Slice 2/3 PR

- 8/8 combos PASS, OR
- N/8 combos PASS + (8-N) child cards filed per FAIL, AND
- `docs/multi-tenant-baseline-2026-06-XX.json` committed, AND
- Wire-back comment on parent card_923709f5 with PR URL + baseline JSON path + pass/fail breakdown.

## Out of scope

- API-level rows (5/6/7 in the original matrix): /api/transform, /api/client/speak, /api/mission/cards. These don't have router exports so end-to-end isolation is best proved by Slice 1 (modular routers) + live curl probes the operator can run ad-hoc. If Hank wants formal coverage, that's a separate jest-w/-supertest harness whose value-vs-effort is debatable; recommend deferring.
- Fixing newly-discovered leaks (one child card per finding).
- Part C cron wiring (parent card_923709f5 Part C).

## Open question for Hank

Run Slice 2 NOW (during working hours, with supervision), OR defer until the Slice 3 baseline cadence is decided? The Playwright run is ~10-15 min of MCP activity and produces 8 screenshots that I should be online to validate.
