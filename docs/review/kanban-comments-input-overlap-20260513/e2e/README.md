# Kanban task-tab comment-overlap — Playwright web E2E

Verifies PR #2678 fix for card_89ecc65333aff605bbf23354: last comment in the
task tab card-detail comments panel must not be occluded by the
`Add a comment / Send` input bar, and text-selection highlight must not bleed
across the bar boundary.

## How

`kanban-comments-overlap-e2e.js` — Playwright web driver. URL-param auths against
prod (`?deviceId=...&deviceSecret=...&lang=zh-TW`), then calls
`window.openDetail('card_3ca7b8d8ed5d4e9827ab343c')` to open the populated
test card (13 visible comments after render). Measures DOM rects:

- `.kb-comments-list` (rect after `scrollTop = scrollHeight`)
- `.kb-comment-input` (rect + computed `z-index`, `background-color`, `position`)
- last `.kb-comment` (rect)

PASS condition: `lastCommentRect.bottom <= inputBarRect.top + 1px` AND
input bar has `z-index >= 1` with non-transparent background.

Run:

    E2E_DEVICE_ID=... E2E_DEVICE_SECRET=... node kanban-comments-overlap-e2e.js

## Results — all PASS (2026-05-13 12:30 TW, prod v1.0.83 with PR #2678)

| viewport | comments | last comment bottom | input bar top | clearance | input z-idx | bg |
|----------|----------|---------------------|---------------|-----------|-------------|--------|
| 360×720  | 13       | 441.3               | 459.0         | 17.7 px   | 3           | rgb(26,26,46) — opaque |
| 412×800  | 13       | 479.5               | 497.0         | 17.5 px   | 3           | rgb(26,26,46) — opaque |
| 768×1024 | 13       | 831.5               | 849.0         | 17.5 px   | 3           | rgb(26,26,46) — opaque |

Selection-highlight test (range-select last comment bubble) also PASS across
all three viewports — input bar's `z-index:3` + opaque background means the
highlight is painted under the bar, never crossing the boundary.

## CSS confirmed live

- `.kb-comments-list { flex:1; min-height:0; padding-bottom:18px; scroll-padding-bottom:16px; }`
- `.kb-comment-input { flex:0 0 auto; position:relative; z-index:3; background:var(--card); border-top:1px solid var(--card-border); }`
- `body.app-webview #panel-comments.active { overflow:hidden; }` + matching `@media` mobile rule

## Artifacts

- `kanban-overlap-{360,412,768}.png` — list scrolled to bottom, no overlap
- `kanban-overlap-{360,412,768}-selected.png` — last comment text-selection, highlight clipped under input bar
- `_results.json` — raw measurements (`getBoundingClientRect` + `getComputedStyle`)

## Notes

The 360 viewport list area is only ~22 px tall because the modal description
panel + tab buttons + assigned-bot block consume most of the modal height.
The bug fix is still valid (no overlap), but the small comment-list area on
360 is a separate UX concern (the list scrolls but only shows a sliver of the
last comment without scrolling up). Filing a follow-up is optional — outside
the scope of this overlap bug.
