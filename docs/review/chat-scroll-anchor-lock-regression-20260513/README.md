# Chat scroll-anchor lock regression — review proof

Card: `card_3453377270a5b76edf994772`
PR: #2693
Branch: `fix/chat-scroll-anchor-lock-regression`
Date: 2026-05-13

## What changed

- `renderMessages()` now captures the first visible `.chat-msg[data-message-id]` before DOM replacement.
- If the user is not at bottom, scroll is restored by anchor top-offset delta instead of raw `scrollTop` only.
- Link-preview rendering and inline media URL hydration use the same preservation helper.
- A `ResizeObserver` guards async message-height changes.
- The active anchor refreshes on user scroll so the helper follows the reader, not stale state.

## Local validation by #1

- `git diff --cached --check`: PASS before commit.
- Static fallback validation: `static anchor-lock assertions PASS`.

## Remaining gate

#2 / Mac_ClaudeAce must run E2E with numeric anchor drift logs (<= 2px) before this card can be Done.
