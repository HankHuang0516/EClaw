# Org chart viewport-safe follow-up — real production data

PR: #2676
Branch: `fix/orgchart-viewport-safe`
Date: 2026-05-13

## Blocker addressed

#2674 fit logic correctly centered/scaled embedded org chart, but it hard-floored scale at `0.5`. On the real `BROADCAST_TEST_DEVICE` org chart, the seven-sibling row containing `TestPluginB` still clipped at 360/412px.

This follow-up keeps #2674's fit-scale strategy as the single source of truth and removes the `0.5` hard floor. Scale is now calculated from the actual rendered content width plus an 8px safety gutter:

```js
scale = Math.min(1, available / (contentWidth + 8))
```

No inline-flex / horizontal-scroll second strategy remains in this branch, so CSS/JS do not double-write layout behavior.

## Real data E2E source

Local static dashboard served from this branch with `/api/entities` and `/api/device/org-chart` proxied to the production BROADCAST_TEST_DEVICE data:

```text
https://eclawbot.com/portal/dashboard.html?embed=1&view=orgchart&deviceId=2a0ad04d-9107-4250-b8be-ecd565983fb2&deviceSecret=***
```

## Measurements

| Viewport | fitScale | body.scrollWidth | clipped |
|---|---:|---:|---:|
| 360x740 | 0.416 | 360 | 0/8 |
| 412x892 | 0.480 | 412 | 0/8 |
| 768x1024 | 0.751 | 768 | 0/8 |
| 1280x800 | 1.000 | 1280 | 0/8 |

## Screenshots

- `after-prod-360.png`
- `after-prod-412.png`
- `after-prod-768.png`
- `after-prod-1280.png`

## Notes for reviewer

- This branch is rebased/reset to latest `origin/main` after #2674/#2677/#2678.
- Primary strategy: #2674 viewport fit-scale + dynamic scale lower than 0.5 when real data requires it.
- The earlier inline-flex / max-content / wrapping approach is intentionally not kept to avoid fighting #2674's transform-based connector math.
