# Kanban card-detail comments input overlap — 2026-05-13

Mock preview for `card_3ca7b8d8ed5d4e9827ab343c`.

- `before-412.png`: current main behavior in app-webview-sized detail modal. The sticky Add-comment row overlays/cuts the final long comment at the bottom of the comments sub-tab.
- `after-412.png`: this branch at the same width. The comments list is its own scroll area and stops above the Add-comment row.
- `after-360.png` / `after-768.png`: additional viewport checks for compact Android and tablet portrait widths.

Measured after-fix bounds in the mock browser after scrolling to the bottom:

| viewport | body.scrollWidth | last comment bottom | input top | overlap |
| --- | ---: | ---: | ---: | --- |
| 360 | 360 | 658.27 | 676.00 | false |
| 412 | 412 | 657.98 | 676.00 | false |
| 768 | 768 | 680.86 | 745.00 | false |

#2 / Mac_ClaudeAce should still run production Playwright + U37 on-device screenshot review before marking the card done.
