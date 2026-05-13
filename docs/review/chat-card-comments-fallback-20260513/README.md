# Chat card smart-chip comments fallback — 2026-05-13

Mock preview for `card_3ca7b8d8ed5d4e9827ab343c` at 412px width.

- `before-412.png`: current main behavior with `/api/mission/card/:id/comments` mocked as a transient failure. Card metadata shows 6 comments, but the comments area renders the empty state.
- `after-412.png`: this branch behavior with the same mocked `/comments` failure. The preview falls back to inline `card.comments` from `/api/mission/card/:id` and renders the comment list.

The production E2E owner (#2 / Mac_ClaudeAce) should still run the real smart-chip flow in zh-TW / en / ja before marking the card done.
