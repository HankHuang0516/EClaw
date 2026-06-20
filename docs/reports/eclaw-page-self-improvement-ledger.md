# EClaw Page Self-Improvement Ledger

Tracks the rotating UI/UX self-improvement pass across user-facing EClaw pages and screens. Each run should choose one page that has not already been handled in the current cycle. When every page/screen has an entry, start the next cycle from the top.

## Cycle 1

| Date | Page / Surface | Status | Branch / PR | Verification | Notes / TODO |
| --- | --- | --- | --- | --- | --- |
| 2026-06-20 | Shared destructive confirm modal (`backend/public/portal/shared/api.js`) | Production verified from previous merged UI PR | PR [#3577](https://github.com/HankHuang0516/EClaw/pull/3577), merged at `2026-06-20T07:56:15Z` | `https://eclawbot.com/api/health` 200; `/api/version` `build_hash=d848c993e112a37b9750a371ded17b3ae743c700`; live `api.js` includes `eclawConfirmDialogIn`; Playwright desktop `1280x800` and mobile `390x844` modal check passed with no overflow/console errors | Previous run deployment is live. No remaining production TODO found for this item. |
| 2026-06-20 | `/portal/invite-qr-generator.html` | Production verified from previous merged UI PR | `codex/ui-self-improvement-20260620`; PR [#3579](https://github.com/HankHuang0516/EClaw/pull/3579), merged as `54879c63eb1e62315b6b7ca6a244472ef862cf89` | `https://eclawbot.com/api/health` 200; `/api/version` `build_hash=51608880d9518c7b08abb8707ab143a08c5cd351` includes later main commits after #3579; live `/portal/invite-qr-generator.html?code=QA2026` Playwright full-page desktop `1366x900`, mobile `390x844`, and split-pane `500x900` checks passed with no horizontal overflow, clipped controls, console errors, or page errors; screenshot/vision review found readable hierarchy, consistent spacing, intact fallback/status copy, and unobstructed buttons/footer | Previous run deployment is live. No remaining production TODO found for this item. |
| 2026-06-20 | `/portal/about-founder.html` | Local validated; draft PR pending | `codex/ui-about-founder-20260620`; PR pending | `node backend/scripts/i18n-check.js`; `NODE_PATH=/Users/hank/Desktop/Project/EClaw/backend/node_modules /Users/hank/Desktop/Project/EClaw/backend/node_modules/.bin/jest tests/jest/portal-static-ids.test.js --runInBand`; inline script parse check; local Playwright full-page desktop `1366x900`, mobile `390x844`, and split-pane `500x900` checks passed with public nav/footer, product visual, copy-link success state, no horizontal overflow, no clipped controls, and no console/page errors; screenshot/vision review found clear hero rhythm, consistent card spacing, readable article hierarchy, unblocked focus/share area, and complete footer across all three viewports | After merge: verify production `/api/health`, `/api/version` build hash, and live `/portal/about-founder.html` desktop/mobile/split-pane screenshots. |

## Current Cycle Queue Notes

- Next suggested page after the about-founder PR: `/portal/stories/index.html` because it is another public-facing page with loading/empty-state and card-grid polish opportunities.
- Avoid repeating `/portal/invite-qr-generator.html` or `/portal/about-founder.html` until Cycle 1 is complete unless a follow-up bug is reported.
