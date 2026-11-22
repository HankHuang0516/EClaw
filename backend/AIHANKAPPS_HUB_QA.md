# Private Timehut GIF reviews

Hank (2026-11-22) requested ten numbered operation GIFs, a separate feedback UX per item, human-intervention alerts and hourly follow-up on new comments. The original ten fixes are already approved; revised 08/09 uses the approved embedded tag-save design. This surface never implies full E2E acceptance.

The Timehut page (`/AiHankApps/hub/#app-timehut`) mounts `hub-qa.js`. GIFs are fetched only after pressing Play. Every review/API/media byte uses the existing administrator gate and private/no-store headers. Original GIFs are stored in the existing private R2 bucket under `aihankapps-hub/qa/`, outside the public Git repository and outside the device-file expiration table. Only an operator over the existing Railway deployment channel may upload media or publish snapshots/results. SHA-256 and GIF signature checks verify these newly uploaded review assets, not pCloud backups.

Routes, also discoverable in `/api/help`'s existing hub category:

- `GET /api/aihankapps/hub/qa/timehut?after=0`: current batch, append-only comments after this ID (500/page), all results, `nextCursor`, `hasMore`. Never returns object-storage keys or capability URLs.
- `GET /api/aihankapps/hub/qa/timehut/media/01`: original GIF, proxied with administrator authentication.
- `POST /api/aihankapps/hub/qa/timehut/comments`: `{requestId: UUID, item: "01", revision, decision: "comment"|"changes"|"approve", body}`. Administrator and exact same-origin required. A retry with the same UUID/content returns the original row; changed content is 409. Stale revisions are 409; drafts remain in the page module across rerenders. No HTTP update/delete/import endpoints exist.
- `GET /api/debug/aihankapps-hub-qa` is available only outside production or in the debug environment, with the same administrator gate. Production operator reads supply the corresponding audit state.

Own tables: `aihankapps_hub_qa_batches`, `aihankapps_hub_qa_comments`, `aihankapps_hub_qa_results`. No product/account/photo tables are modified. Comments and operator responses are append-only. Results reference the same item and optional exact comment ID; a stable `result_key` makes retries idempotent and rejects a changed response. Snapshot publication verifies all ten media originals before replacement. Existing comments retain their original revision even after a new GIF is published.

Operator commands (only the operator's existing Railway login; no exported database/R2 credentials):

```
node tools/aihankapps-hub/qa.js upload /PRIVATE/uploads.json
node tools/aihankapps-hub/qa.js publish /PRIVATE/batch.json
node tools/aihankapps-hub/qa.js read 0
node tools/aihankapps-hub/qa.js result /PRIVATE/result.json
```

Uploads JSON: ten `{item,path,sha256,size}` entries. Batch JSON: fixed `id=timehut-batch01`, `app=timehut`, ten items `{id,revision,sha256,bytes,mediaKey,title,before,after,status,releaseStatus}`, current platform coverage and limitations. Results JSON: `{key,item,commentId?,body}`. Signed PUT capabilities exist only in the operator bridge's memory. Do not redirect raw `prepare-media` output to files.

Hourly Codex heartbeat `gif-e2e` belongs to the original E2E chat. Durable workflow/checkpoint: `/Volumes/codex_2T/TimehutQAExports/route-coverage-20261115/hub-review/WORKFLOW.md`. Read every page of new comments, record each processing state before advancing the cursor, find root cause, fix and run the relevant actual E2E, then append results to the same item. New product UI candidates still require Hank's numbered operation-GIF approval before application. Never interpret silence, a plain comment, or a checkbox as approval of another revision. Preserve the full C1–C7 denominators and font ceiling 150%.

Raise/update the existing standalone hub note `human-timehut-qa-review-batch01` through `triage.js raise`/`note`, with app `timehut`. Its `ask` links to the review and says what Hank should do. Reuse the ID while unchanged; resolve/supersede it only when the corresponding human request is handled. A new review occurrence after results uses a new stable revision-specific ID so an old acknowledgement cannot hide a new request. Keep coverage-progress state separate from decisions: incomplete automated E2E is not itself an unapproved UI change.

All approved fixes must be integrated into each formal Timehut source/update with a release manifest and affected E2E, preserving concurrent release work. A QA-only application or this hub deployment is not a native store release. Each formal release still requires its actual packaged H watermark inspection, CI and ordinary release checks. No marketing/guide/catalog/report or public app page is changed by this private feature.
