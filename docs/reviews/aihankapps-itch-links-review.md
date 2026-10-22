# AiHankApps itch.io links review

The three games whose itch.io pages are public get an itch.io link next to their existing store links:

| Card | communityId | itch.io page |
|---|---|---|
| 紙上彈兵 | `paper-flick-soldiers` | https://lolwarden0516.itch.io/paper-flick-soldiers |
| 元素戰機350 (REBOUND) | `rebound` | https://lolwarden0516.itch.io/rebound |
| 活字戰紀：雙城烽火 | `typeforge-twin-cities` | https://lolwarden0516.itch.io/typeforge-twin-cities |

螞蟻王國 (Anthill), 活字戰記：巔峰之戰 and Vibe帝國 are still drafts on itch.io and get no link. The itch.io pages hold a cover, screenshots and the existing App Store / Google Play links; they offer no download, so the new actions say "View on itch.io" / 「在 itch.io 查看」 rather than "download".

## What changed

- `itchUrl` is added to the three records in `app-catalog.json`, the generated `app-catalog.js` (regenerated with the same compact `JSON.stringify` form, which reproduces the committed file byte-for-byte for the untouched catalog) and the embedded `appList` in `index.html`. Removing the three keys reproduces the previous catalog exactly.
- `reports/release.json` keeps its date, data, renderer, content hash and artifact hashes; only `catalogHash` is refreshed with the reporting tool's own `fingerprint()` of the new catalog, the same one-line refresh as #5198.
- Portfolio cards: `createStoreLink` gains an `itch` branch and `createCard` appends it after Google Play / App Store when `itchUrl` is present. The store row is appended whenever it has children, which is identical to the old `googlePackage || iosId` condition for every existing record. The link opens a new tab with `rel="noreferrer"` like the other store links and has an accessible name such as 「紙上彈兵：在 itch.io 查看」.
- `itch-icon.svg` is a new self-contained storefront mark (two paths, no scripts or external references, colour `#f0524f`, about 3.3:1 against the store-button background). `community-v5.css` gives `a.store-link.itch` the same 17 px mark + label treatment as the existing store marks; the rule is scoped to card store links so other itch.io links keep their text. `index.html` loads the stylesheet as `community-v5.css?v=itch-links-20261022` because the CSS is browser-cacheable while the HTML is `no-store`.
- Introduction toolbar (`intro-toolbar-v2.js/css`): an itch.io action is added only when the catalog record (or, without the catalog, the page's `data-itch`) has a URL, so there is no disabled itch.io state and other guides are unchanged. Below 900 px a lone third action spans the row instead of leaving a half-width gap.
- Guides: 紙上彈兵 adds an itch.io button to its `#download` row and one sentence; 活字戰紀 updates the `#download` sentence that points to the persistent toolbar. Both pages bump the toolbar CSS/JS and catalog query strings to `itch-links-20261022` and carry `data-itch` as the fallback.
- Not changed: app icons, H watermark layers, other cards, other guides, analytics, community, gift campaign, report data and `guide-sync-status.json` (no in-repo consumer; its hashes are produced by the external sync).

## Checklist

- ✅ A1 Logic: cards and toolbars add the itch.io action only when a URL exists; Google Play / App Store branches, statuses and order are untouched. A rendered-DOM comparison of all 17 cards against the previous rule found no differences except the three new itch.io links.
- ✅ A2 Tests: new `backend/tests/jest/aihankapps-itch-links.test.js` (6 tests) covers catalog JSON/JS parity and the exact public set, the embedded card list, `createStoreLink` behaviour extracted from the page, the toolbar script run against the real guide attributes with and without the catalog (and a guide without itch.io), the guide download rows, the icon and the absence of draft slugs. Two deliberate mutations of the card branch and one of the toolbar branch each made the suite fail; the files were restored byte-for-byte. Reporting regression 97/97, the CI release-integrity step, strict `i18n-check`, Jest `i18n-syntax`, ESLint (0 errors, 9 existing warnings) pass. Locally (Node 25) the full Jest suite passed 7601 tests with 5 failures, in two different sets of unrelated suites: one set caused by `ECLAW_*` variables exported by Hank's shell, the other by HTTP parse errors / a 404-vs-409 under full parallel load in a clean environment. Each set passes when re-run on its own in a clean environment. None of them touch AiHankApps; GitHub's Node 20 Backend CI is the authoritative full run. The intro-site checker reports the same single pre-existing false positive as `main` (`mailto:` treated as a local asset) and nothing new.
- ⚠️ A3 Return shape NO-OP: no API or response change.
- ✅ A4 What this does NOT fix: itch.io clicks are not counted by portfolio analytics (it tracks only view/intro/google/apple and the table has a CHECK constraint); the pre-existing H overlay overlap below; the stalled production deployment below; the intro-site checker's `mailto:` false positive. The canonical authoring project `app-showcase-site` is still unrecovered, so a later catalog or guide sync from it must carry `itchUrl` and these guide edits, or it will drop them; its out-of-repo guide gate may also need to accept the extra action.
- ✅ A5 Security: static public links only, `target="_blank"` with `noreferrer` / `noopener noreferrer`; no secrets, auth, payments, form or data writes. Local previews ran on 127.0.0.1, where portfolio analytics does not count.
- ⚠️ B1 API help NO-OP: no endpoint added or changed.
- ✅ B2 Docs: this review. No other doc describes the store row.
- ⚠️ B3 i18n NO-OP: the portfolio and these guides are Traditional Chinese editorial pages without `data-i18n` keys; "itch.io" is a brand name like the existing "Google Play" / "App Store" labels. Both required i18n checks pass.
- ✅ B4 Info/promo: the portfolio cards and both introduction pages are the surfaces being updated.
- ⚠️ B5 Debug NO-OP: no backend, security or data logic.

Manual reuse, quality and efficiency review: reused `createStoreLink`, the existing mark CSS pattern and `storeAction`; one new 337-byte SVG; no new dependency or request. The optional simplify skill was not run.

## Rendered checks

Local static preview (`backend/public` on 127.0.0.1) at 1024×768 and 390×844: three cards show Google Play / App Store / itch.io, 17 cards otherwise unchanged, no horizontal overflow (`scrollWidth` 390 on mobile). Both guides show the itch.io toolbar action (`在itch.io查看…`); on mobile it takes its own full-width row, which makes the sticky toolbar one 36 px row taller on these two pages only. Screenshots were inspected visually.

## H watermark self-check (this website update)

- Scope: portfolio card icons, the two edited guides' favicon/hero images, and the new itch.io mark.
- Sources: card H overlay layers `brand/h-watermark-game-italic.png` (sha256 `b33f49f2bc7e2e54…`) and `brand/h-watermark-general-italic.png` (`29bb4c6f54024441…`); card icons from `icons/`; Anthill uses its baked icon. All are byte-identical to `main` and to the files currently served by https://eclawbot.com/AiHankApps/. The overlay CSS (44 px, lower right, inside the 104 px icon) is the one already live. The itch.io mark is a third-party platform mark like the Google Play / App Store marks, not an app icon.
- Checked at the real 104 px card size on desktop and mobile, and magnified 2× / 3× for all 17 cards.
- Result: the H is present, uses the existing italic layers, stays inside the icon and does not form its own row or band. **However, the existing overlay covers title text** on 紙上彈兵 (「兵」), 元素戰機350 ("ELEMENT"), 活字戰記：巔峰之戰 (「戰」), Vibe帝國 (「國」) and EClawbot ("OpenClaw"). Under the H policy covering text is a HOLD condition. This PR does not change it, but the self-check for this release is therefore **not passed**, and merging/publishing needs Hank's decision.
- The two guides show the store icon without an H overlay, as they already do in production; unchanged here.

## Deployment state at review time

Production (`/api/health` startedAt 2026-10-21T07:01Z) runs `5945589a4` (#5243). #5251, #5252 and #5253 are merged to `main` but Railway has created no deployment for them, and the live portfolio still shows the pre-#5251 layout. Merging this PR therefore publishes those changes too whenever Railway deploys `main` again, and it cannot be verified live until that deploy pipeline moves.
