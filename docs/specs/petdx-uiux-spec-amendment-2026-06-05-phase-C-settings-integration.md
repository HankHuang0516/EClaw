# Petdx UIUX Spec Amendment — Phase C: Settings page integration

**Date:** 2026-06-05
**Author:** #2 (LOBSTER / commander)
**Status:** Draft → sign-off → impl
**Parent card:** card_101194c7ce179b76beea2e69 (Phase 4 close-out)
**Phase C card:** card_9cda7238f49d5efbd73e532f
**Trigger:** Hank 2026-06-05 10:20 TW「把夥伴系統頁面UIUX同步到Web設定頁面中」

## Background

Today's parent-card investigation surfaced the petdx pipeline as a first-class
EClaw subsystem (Phase 1 emoji fallback → Phase 2 R2 self-host → Phase 2.5
orphan recovery → Phase 4 verification). The dedicated companion browse +
switch UI lives at `/portal/petdx-browser.html`, but `/portal/settings.html`
— the single user-facing settings hub — has no entry point to it. Users today
can only reach the companion browser via direct URL, which is undiscoverable.

Hank's directive is to **sync the petdx UIUX into the settings page**. Two
plausible readings of that:

- **Reading A (minimal, picked):** Add a deep-link card entry in
  `settings.html` matching the existing wallet / rentals / invite / files
  card pattern. Tap → land on `petdx-browser.html`.
- **Reading B (heavy):** Embed the full petdx-browser UI (search, filter,
  grid, modal preview) inline inside settings.html as an expanded section.

Reading A is selected for Phase C-1 (this spec) because:

1. It satisfies the discoverability problem Hank named without adding
   3,000+ lines of UI code to a 3,497-line page that already pushes
   memory/maintenance limits.
2. The existing card pattern (wallet, rentals, invite, files) is the
   established settings-page taxonomy — a companion card slots in cleanly.
3. `petdx-browser.html` is already production-grade and fully wired to the
   companion API; duplicating it inline is YAGNI.
4. If Reading B is later desired, it can ship as Phase C-2 as a follow-up
   without invalidating C-1.

## §C-1 Scope

### Files touched

| File | Change |
|------|--------|
| `backend/public/portal/settings.html` | Add 1 companion card, ~10 lines, slotted next to wallet/rentals/invite/files cluster |
| `backend/public/shared/i18n.js` | Add 3 keys × 4 locales = 12 entries |

### HTML insertion (settings.html)

Insert immediately after the Files card (line ~1347) and before the Feedback
card (line ~1349). Pattern identical to the existing simple-link cards:

```html
<!-- Companion Card -->
<div class="card" style="cursor:pointer;" onclick="window.location.href='petdx-browser.html'">
    <div class="card-title">
        <span>🐾 <span data-i18n="nav_companion">Companion</span></span>
    </div>
    <p class="section-desc" data-i18n="settings_companion_desc">Browse and pick a Petdx companion for each of your entities</p>
</div>
```

Rationale for placement: companion belongs alongside other identity/personalization
deep-links (wallet/rentals/invite/files), not in the channel-keys or
notification clusters above.

### i18n keys (shared/i18n.js)

Three new keys × 4 locales (en, zh, zh-TW, ja) — per Hank's platform-rule
compliance gate, EClaw is a global agent-collab platform, so all four locales
must land in the same PR. No "ship en first, fill later" carveouts.

| Key | en | zh (Simplified) | zh-TW (Traditional) | ja |
|-----|----|-----------------|---------------------|----|
| `nav_companion` | Companion | 伙伴 | 夥伴 | コンパニオン |
| `settings_companion_title` | Companion | 伙伴 | 夥伴 | コンパニオン |
| `settings_companion_desc` | Browse and pick a Petdx companion for each of your entities | 浏览并为你的每个实体挑选 Petdx 伙伴 | 瀏覽並為你的每個實體挑選 Petdx 夥伴 | エンティティごとに Petdx コンパニオンを選択 |

Note: `settings_companion_title` is included for forward-compat — if Reading B
(inline section) is later picked up, the title is already keyed.

## §C-2 Acceptance

1. PR diff is exactly 2 files (settings.html, shared/i18n.js) — no scope creep.
2. PR body cites this spec.
3. Prod desktop 1280×800 screenshot of settings.html showing the new companion
   card visible alongside wallet/rentals/invite/files.
4. Prod mobile 390×844 screenshot of the same.
5. Switching the locale to each of en / zh / zh-TW / ja shows the correct
   translated string on both card title and description.
6. Tapping the card lands on `/portal/petdx-browser.html` (works on both
   desktop and mobile; mobile shows the browser's responsive layout).

## §C-3 Out of scope (deferred to potential Phase C-2)

- Inline embed of full petdx-browser UI inside settings.html.
- New companion-selection state synced bidirectionally between settings.html
  and dashboard.html avatar render.
- Settings-page search across all companion descriptors.
- Companion favorite/rating UI inside settings.

These remain deferrable because (a) `petdx-browser.html` already handles all
of them in its own surface, and (b) the parent investigation card closed
without any of them being load-bearing on user complaints.

## §C-4 Test plan

| Path | Verifier |
|------|----------|
| settings.html renders new card at expected position | manual prod screenshot, desktop+mobile |
| Card click navigates to /portal/petdx-browser.html | manual click, both viewports |
| i18n switch renders correct strings in each locale | manual switch through 4 locales |
| No existing settings.html section is visually displaced | before/after settings.html screenshot compare |
| No regression in petdx-browser.html (unchanged file) | spot-check unchanged URL hash + manual smoke |

## §C-5 Rollback

This is a HTML/i18n-only change. Rollback = revert the merge commit; no
data-shape or API change to unwind, no migration to undo.

## Sign-off chain

- [ ] #1 (Mac_F / Planner) — scope sanity check
- [ ] #2 (LOBSTER / me, owner) — self-review
- [ ] Hank — narrative gate (final OK)

## References

- Parent card: card_101194c7ce179b76beea2e69
- Phase 2 R2 pipeline spec: docs/specs/petdx-uiux-spec-amendment-2026-06-05-phase2-r2-pipeline.md
- Existing companion browser: backend/public/portal/petdx-browser.html
- Settings page: backend/public/portal/settings.html
- Petdx renderer (shared): backend/public/shared/petdx-renderer.js
- Avatar petdx loader (shared, already wired in settings.html): backend/public/shared/avatar-petdx.js
