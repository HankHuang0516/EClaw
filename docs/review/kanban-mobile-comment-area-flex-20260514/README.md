# Kanban mobile comment area flex regression — 2026-05-14

Card: `card_4a9ad492bbdaa0d9aa9fd48c`
Branch: `fix/kanban-mobile-comment-area-flex`
Page under test: `backend/public/portal/kanban.html` only.

## Root cause reproduced

The mobile/WebView detail modal makes active panels flex items. The previous mobile rule used `.kb-modal-panel { flex: 1; }`, which expands to `flex: 1 1 0%`. When the sibling `.kb-move-bar` wraps assigned chips, reviewer controls, and status buttons into a tall footer, the comments panel can shrink toward zero. On the 360×740 stress case the comments list was only **22px** tall in the before harness, matching the user red-box report where comments were a tiny strip.

PR #2678 only addressed the comment input overlap; it did not reserve a usable comments panel height under wrapped move-bar pressure.

## Fix validated

Runtime CSS change:

- `backend/public/portal/kanban.html`
  - `.kb-move-bar { flex-shrink: 0; }`
  - mobile/WebView `.kb-modal` becomes a full `100dvh` flex column with modal scrolling if content exceeds viewport.
  - mobile/WebView `.kb-modal-panel` uses `flex: 1 1 auto; min-height: 0`.
  - mobile/WebView `#panel-comments.active` reserves `min-height: clamp(240px, 35dvh, 380px)`.
  - `.kb-comments-list` remains the inner scroll area with `-webkit-overflow-scrolling: touch` and `touch-action: pan-y`; no scroll-chain blocking was added, so the modal can still scroll to actions when the inner list reaches an edge.
  - `.kb-comment-input` is `flex-shrink: 0`, keeping the composer reachable.

## Screenshot matrix

Generated with `node docs/review/kanban-mobile-comment-area-flex-20260514/capture-matrix.js` against the static harness in this folder. The harness mirrors the pinned Kanban modal selectors and stress content: long title, long description, wrapped assigned chips/reviewer/status buttons, 14 comments, and one long single comment.

Required viewports:

| Viewport | Before | After | Key after metric |
| --- | --- | --- | --- |
| 360×740 | `before-360x740-comments.png` | `after-360x740-comments.png` | listH 176px; scroll probe up/down PASS |
| 412×892 | `before-412x892-comments.png` | `after-412x892-comments.png` | listH 233px; scroll probe up/down PASS |
| 768×1024 | `before-768x1024-comments.png` | `after-768x1024-comments.png` | listH 593px; scroll probe up/down PASS |
| 1280×800 | `before-1280x800-comments.png` | `after-1280x800-comments.png` | desktop unchanged/healthy; scroll probe up/down PASS |

Additional user screenshot scenario:

| Viewport | Before | After | Key after metric |
| --- | --- | --- | --- |
| 456×1023 portrait | `before-456x1023-comments.png` | `after-456x1023-comments.png` | listH 424px; scroll probe up/down PASS |

State/tab checks:

- Comments, many comments + long single comment: `after-412x892-comments.png`
- Input focused: `after-412x892-comments-input-focused.png`
- Notes tab reachable: `after-412x892-notes.png`
- Files tab reachable: `after-412x892-files.png`
- Screenshots tab reachable: `after-412x892-screenshots.png`

Contact sheet: `kanban-comments-flex-matrix.png`.

Raw numeric evidence: `matrix-results.json`.

## Local validation commands

```bash
git diff --check -- backend/public/portal/kanban.html docs/review/kanban-mobile-comment-area-flex-20260514
node --check docs/review/kanban-mobile-comment-area-flex-20260514/capture-matrix.js
node docs/review/kanban-mobile-comment-area-flex-20260514/capture-matrix.js
```

Notes:

- The screenshot harness uses a local static HTTP server (`python3 -m http.server 8765 --bind 127.0.0.1`) because Chromium CDP cannot capture `file://` consistently in this environment.
- This validation does not touch chat card preview embed modal.
- No new i18n keys are expected.
