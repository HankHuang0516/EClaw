# Smart-Chip Card Preview — E2E Verification (PR #2677)

Card: `card_621e12617cc97d17384556ec` — "[Bug] 聊天 smart chip 卡片預覽 — 留言區永遠顯示「還沒有留言」"
PR:   #2677 (merged) — `fix(chat): smart-chip preview falls back to inline c.comments when /comments fails`

## Test matrix

3 locales × 3 scenarios = 9 screenshots. All PASS.

| Scenario          | Locale | Mock                                  | Expected                          | Result                              |
|-------------------|--------|---------------------------------------|-----------------------------------|-------------------------------------|
| populated         | zh-TW  | pass-through                          | 13 actual comments rendered       | PASS — `commentCount=13, emptyText=""` |
| populated         | en     | pass-through                          | 13 actual comments rendered       | PASS — `commentCount=13, emptyText=""` |
| populated         | ja     | pass-through                          | 13 actual comments rendered       | PASS — `commentCount=13, emptyText=""` |
| fail-fallback     | zh-TW  | `/comments` → 500                     | Falls back to inline `c.comments` | PASS — `commentCount=13, emptyText=""` |
| fail-fallback     | en     | `/comments` → 500                     | Falls back to inline `c.comments` | PASS — `commentCount=13, emptyText=""` |
| fail-fallback     | ja     | `/comments` → 500                     | Falls back to inline `c.comments` | PASS — `commentCount=13, emptyText=""` |
| empty-state       | zh-TW  | both endpoints empty                  | Shows "還沒有留言"                  | PASS — `commentCount=0, emptyText="還沒有留言"` |
| empty-state       | en     | both endpoints empty                  | Shows "No comments yet"           | PASS — `commentCount=0, emptyText="No comments yet"` |
| empty-state       | ja     | both endpoints empty                  | Shows "コメントはまだありません"        | PASS — `commentCount=0, emptyText="コメントはまだありません"` |

The fail-fallback row is the critical proof: even when `/api/mission/card/:id/comments` returns 500, the inline `c.comments` array from `/api/mission/card/:id` is used as fallback, so populated cards never falsely display "No comments yet".

## How to reproduce

```bash
export E2E_DEVICE_ID='<your device id>'
export E2E_DEVICE_SECRET='<your device secret>'
node smartchip-e2e.js
```

Card under test (`card_3ca7b8d8ed5d4e9827ab343c` — Rental subsystem spec) currently has 13 comments server-side. The script uses Playwright route interception to simulate `/comments` failure and the empty-state path.

## Files

| File | What it shows |
|------|---------------|
| `smartchip-{zh-TW,en,ja}-populated.png`    | Normal happy path |
| `smartchip-{zh-TW,en,ja}-fail-fallback.png`| `/comments` 500 → inline fallback renders comments |
| `smartchip-{zh-TW,en,ja}-empty-state.png`  | Truly empty card → localized empty msg |
| `_results.json`                            | Programmatic observed values per scenario |
| `smartchip-e2e.js`                         | The Playwright test script |
