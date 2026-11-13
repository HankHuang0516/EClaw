# EClaw Hub candidate review — 2026-11-13

Candidate branch: `codex/hub-eclaw-admin-migration-20261113`, based on
`c31fb2219`. This is a website/backend candidate; no native build or store
submission is produced. Production verification remains pending an authorized
PR merge and Railway deployment.

## Function and interface review

Manual reuse/quality/efficiency review traced each of the eleven original data
requests, the ten detail sections, private field projection and request lifecycle.
The Hub's existing summary cells, table wrappers, Timehut insight and drill-down
styles are reused. Each source can fail and be retried separately. No fetched
private records are written to disk, telemetry or browser storage; deliberate
quote-to-chat handoff uses only a short status/count excerpt.

Local Chrome QA used a synthetic-only Express fixture (example.invalid accounts,
no production credentials/data). Verified desktop and 390×844 mobile layouts,
light/dark mode, all ten sections, search, QA hiding, insight filtering, sorting,
local pages, Paper older cursor, MiniGame error detail selection, escaped hostile
HTML, partial source failure and immediate clearing on 403. Mobile document width
was 390px with scrollWidth 390px; wide tables scroll inside their wrapper. Browser
console errors/warnings: none observed. Screenshots and machine-readable section
results are retained in the private project QA directory, not public site assets.

The old admin entry redirects only after its existing account/admin check. The
explicit operations entry keeps existing mutation confirmations and auth. The
Hub does not execute those writes during migration or validation. Existing
non-Web client behavior and store/report catalogs are preserved.

## Candidate icon self-check

The previous Hub EClaw icon/favicon had no H layer. The candidate uses
`backend/aihankapps-hub/eclaw-icon.png` for its EClaw app image and favicon;
this exact asset is on the private Hub file allowlist.

- True no-H original: `backend/public/AiHankApps/icons/store-eclawbot-b9c71ad835a0.jpg`.
- Selected original H: `backend/public/AiHankApps/brand/h-watermark-general-italic.png`, the same existing general-app H used by the portfolio.
- Full original canvas: 512×512, unchanged composition/position. Only the selected H layer is composited at x=382, y=365, width=56, height=59, inside the scene's lower-right area. It is not a separate row, bar, footer or external badge.
- Original H strokes, colors and alpha are preserved; no redraw, new font, tint, opacity adjustment, artwork crop, padding or border was introduced.
- Pixel comparison against the actual no-H JPEG decode: differences outside the H rectangle = **0**.
- Visually inspected the exact output at full size and 32/48/64px, including rounded platform-like masks. H remains within the image/mask and does not cover the phone, characters or title. Conclusion: **浮水印存在／樣式正確**. Small-size clear letter recognition is not claimed or required.
- The local Hub's actual header image resolved to `eclaw-icon.png`. Its HTML favicon reference points to the same asset; the browser automation extension adds its own temporary badge at runtime.

SHA-256 of source original: `b9c71ad835a015ceab9448bf5ccf2cac091f8329766d63409a9cefdcc87a0b27`.

SHA-256 of selected H: `29bb4c6f54024441b675d9f04233dc0283dcc3dff2b78fbb08cd61581d61b9fa`.

SHA-256 of candidate output: `984f7785d273ba797881612680aa2899d712ed3635357d40cfff884d9bf54bf8`.

This candidate review does not substitute for fetching the exact deployed asset
and checking the affected authenticated production view after publication.

## Local checks

Final scoped run: **324 tests passed in 9 suites**, including 89 EClaw Hub
contracts and 24 Bot snapshot contracts. Full backend lint passed with nine
pre-existing unused-variable warnings and zero errors; new EClaw modules have
zero lint warnings. JavaScript syntax checks and the strict existing i18n
reference check passed. The standalone EClaw text dictionary has 15 complete
locales × 167 keys (2,505 translations), with tests covering key parity,
fallback and interpolation. No Simplify tool was executed or required.

CI status is recorded on the PR rather than inferred from these local checks.
