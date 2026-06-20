# EClaw Page Self-Improvement Ledger

Tracks the rotating UI/UX self-improvement pass across user-facing EClaw pages and screens. Each run should choose one page that has not already been handled in the current cycle. When every page/screen has an entry, start the next cycle from the top.

## Cycle 1

| Date | Page / Surface | Status | Branch / PR | Verification | Notes / TODO |
| --- | --- | --- | --- | --- | --- |
| 2026-06-20 | Shared destructive confirm modal (`backend/public/portal/shared/api.js`) | Production verified from previous merged UI PR | PR [#3577](https://github.com/HankHuang0516/EClaw/pull/3577), merged at `2026-06-20T07:56:15Z` | `https://eclawbot.com/api/health` 200; `/api/version` `build_hash=d848c993e112a37b9750a371ded17b3ae743c700`; live `api.js` includes `eclawConfirmDialogIn`; Playwright desktop `1280x800` and mobile `390x844` modal check passed with no overflow/console errors | Previous run deployment is live. No remaining production TODO found for this item. |
| 2026-06-20 | `/portal/invite-qr-generator.html` | Production verified | `codex/ui-self-improvement-20260620`; PR [#3579](https://github.com/HankHuang0516/EClaw/pull/3579), merged at `2026-06-20T10:23:38Z` | Local pre-merge: `node scripts/i18n-check.js`; targeted Jest; `portal-static-ids` Jest; syntax checks; inline script parse; Playwright desktop `1366x900` and mobile `390x844` success + QR-fallback smoke. CI: ESLint, Jest, i18n syntax, Critical portal pages, Settings help invariant, matrix, and Required PR CI gate passed. Production: `/api/health` 200; `/api/version` `build_hash=54879c63eb1e62315b6b7ca6a244472ef862cf89`; live `/portal/invite-qr-generator.html?code=QA2026` desktop/mobile smoke passed with no overflow/console errors and nonblank `qrgCanvas`. | Previous TODO completed. No remaining production TODO found for this item. |

## Current Cycle Queue Notes

- Next suggested page: `/portal/about-founder.html` because it is standalone, public-facing, and has clear opportunities for mobile share/copy success states without touching core auth workflows.
- Avoid repeating `/portal/invite-qr-generator.html` until Cycle 1 is complete unless a follow-up bug is reported.
