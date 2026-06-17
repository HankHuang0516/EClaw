# Cross-surface E2E Matrix — Baseline Run Definition

OODA-R Phase 3 #8 (`card_42ffca0d29ce22b369d55ca4`). This file is the canonical
record of **what the gate covers** and **what a passing baseline looks like**.
CI workflow: `.github/workflows/e2e-matrix-ci.yml` → job **`matrix`** → check
context **`Cross-surface E2E Matrix / matrix`**.

## The matrix — 5 flows × 3 surfaces = 15 cells

Flows (`matrix-def.js` `FLOWS`) × Surfaces (`PLATFORMS`):

| Flow key                  | What it verifies                                                                 | Auth |
|---------------------------|---------------------------------------------------------------------------------|------|
| `login_refresh`           | `index.html?authReason=token_expired&return_to=…` shows `#authReasonBanner` + return_to passes the portal allowlist (pain-4 bounce receiving end) | light |
| `redirect`                | `/r/profile?publicCode=…` 302s to `/p/{code}` with a `traceId` (universal entry) | light |
| `message_send`            | Offline: `EclawOutbox.enqueue` persists to `localStorage` + renders `.msg-outbox-queued` bubble. Online: same bubble flips to `.msg-outbox-sending` (card_751 outbox / 情緒價值 #2) | light |
| `kanban_lifecycle`        | Card `todo→in_progress→done` via the API the optimistic UI calls, then renders in `kanban.html`; self-cleans the marker card | **secrets** |
| `agent_reply_visibility`  | Self-seeds a bot reply via `/api/transform`, then asserts `chat.html` renders a received `.chat-bubble` with a non-empty `.chat-source` sender | **secrets** |

Surfaces: `desktop` (1366×900, default UA), `mobile` (390×844, iOS Safari UA),
`webview` (390×844, `EClawAndroid/1.0.88` UA → app-webview branches).

## Baseline = all 15 cells PASS

A green baseline requires the BROADCAST_TEST throwaway creds (the `secrets` rows
above). With them set, **expected = 15 pass / 0 fail / 0 pending**.

The runner exits non-zero on **any** `fail` **or** `pending` cell. `pending` is no
longer an expected state (all 5 drivers exist) — a pending cell means a flow key
lost its driver in `drivers.js` (regression / bad merge) and fails the gate.

### Transient-503 hardening (does NOT red the gate)

The two secret-bound drivers (`kanban_lifecycle`, `agent_reply_visibility`) hit
**live prod**, which can intermittently throw HTTP 503/429 or a cold-path timeout.
Every prod call in those drivers now goes through `fetchWithRetry` (in `drivers.js`):
classifier `TRANSIENT_ERROR_RE` + status≥500/429 → retry up to 5× with backoff
(`min(30s, 2s × attempt)`, ≈20s window). This mirrors the canonical retry pattern
in `openclaw-channel-eclaw/src/client.ts` ("retry transient message delivery
failures", 21989abc).

If a 503/429 **still** survives that retry window, the driver returns
`{ transient: true }` and the runner marks the cell **`TRNS`** — reported loudly in
`summary.txt` but **not counted as a fail** (it does not exit non-zero). Rationale:
a sustained prod infra blip is not a product regression and must not red a required
merge gate. `agent_reply_visibility` additionally **polls** chat history (8 × 3s)
for the seeded marker instead of a single fixed 3s wait — this was the root cause of
the desktop-flaps / mobile+webview-pass flake (the first surface tested raced the
async `transform→chat_messages` write). Expected healthy baseline is still
**15 pass / 0 fail / 0 transient**; a `transient` cell is the safety net, not the norm.

### Local dry-run without secrets (auth-light subset)

```
node backend/tests/e2e/matrix/run-matrix.js
```

Without `MATRIX_TEST_DEVICE_ID`/`MATRIX_TEST_DEVICE_SECRET`, the two write/seed
drivers **fail fast** (by design — never commit creds, #6 ruling). The 9
auth-light cells (`login_refresh`, `redirect`, `message_send` × 3 surfaces) still
run and must all pass:

```
cells=15  pass=9  fail=6  pending=0
```

(The 6 "fail" cells there are the two secret-bound flows × 3 surfaces throwing
"missing MATRIX_TEST_DEVICE_ID / MATRIX_TEST_DEVICE_SECRET" — that is the expected
no-secret local signal, not a flow regression.)

## Setup (Globe-user / CI operator)

To get the full green baseline in CI, set on the repo:

- **Secret** `MATRIX_TEST_DEVICE_ID` — a throwaway BROADCAST_TEST device id.
- **Secret** `MATRIX_TEST_DEVICE_SECRET` — its device secret.
- **Variable** `MATRIX_TEST_ENTITY_ID` (optional, default `1`) — the bound,
  assignable entity on that device ("E2E Bot B").
- **Variable** `MATRIX_TEST_ENTITY_PUBLIC_CODE` (optional, default `ldsntq`) —
  speakTo target for the self-seeded reply.
- **Variable** `MATRIX_BASE` (optional, default `https://eclawbot.com`) — target origin.

These are read in `.github/workflows/e2e-matrix-ci.yml`. The device must be a
disposable test device — drivers create, mutate, and self-clean marker rows.

## Artifacts

Every run writes to `MATRIX_ARTIFACT_DIR` (CI: `matrix-artifacts/`, uploaded as
`e2e-matrix-<run_id>`):

- `summary.txt` — human verdict table (PASS/FAIL/PEND per cell).
- `summary.json` — `{ base, counts, results[] }` machine summary.
- `<flow>__<surface>.png` — one screenshot per cell.

## ? icon / empty-state guidance

- A cell shows **FAIL** with "missing MATRIX_TEST_DEVICE_ID…" → the repo secrets
  are not set; that flow is secret-bound. Add the secrets above. Not a code bug.
- A cell shows **PEND** → a driver is missing for that flow key in `drivers.js`.
  Restore it; the matrix is supposed to be fully implemented.
- `login_refresh`/`message_send` FAIL with a nav timeout → prod cold-path; the
  drivers already retry once. A persistent timeout is a real prod-availability
  signal worth an episode (see card OODA-R self-improvement slot).

## Making this a required merge check

Add `Cross-surface E2E Matrix / matrix` to branch protection for `main` (separate
card — do not flip protection here). Once required, a failing matrix entry blocks
merge of any PR touching the watched paths (portal, shared, route-registry,
redirect-router, the matrix itself).

## OODA-R self-improvement

On a CI matrix failure, write an episode: pain id / affected flow / surface. Axis:
cross-surface regression / WebView↔native parity drift. Feedback ingest: CI run
results + the 5 flow child-card retros + prod incidents → matrix-expansion
proposal. If the same regression class recurs N≥3 times, promote a new flow into
this permanent set.
