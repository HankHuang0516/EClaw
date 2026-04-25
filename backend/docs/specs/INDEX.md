# Backend Subsystem Specs — Index

Per Hank 2026-04-25 1on1 Q2: 用 grep 理解 code 架構容易撞名 — 規範書當錨點。
心智圖第一層的每個節點需要對應的 spec doc。

**Legend:** ✅ has dedicated spec · △ partial / scattered design+impl notes · ❌ no spec yet

| # | Subsystem | Source files | Spec status | Location |
|---|-----------|--------------|-------------|----------|
| 1 | rental | `backend/rental.js`, `backend/rental_schema.sql`, `backend/rental-proxy.js` | ✅ | [`backend/docs/specs/rental.md`](rental.md) (this audit's sample) |
| 2 | rental — rebind cascade Phase 1-4 | `backend/rental.js` (pause/terminate helpers), `backend/index.js` (8 callsites) | ✅ | [`backend/docs/specs/rental-rebind-cascade.md`](rental-rebind-cascade.md) (Phase 4 follow-through) |
| 3 | wallet | `backend/wallet.js`, `backend/wallet_schema.sql` | ❌ | constants live in code (`LEDGER_TYPES`, `applyLedgerEntry`) — needs extraction |
| 4 | kanban (mission v2) | `backend/kanban.js`, `backend/mission.js` | △ | repo-root [`docs/mission-v2-kanban-spec.md`](../../../docs/mission-v2-kanban-spec.md) — written before screenshot-review gate / cron 子卡; needs supplement |
| 5 | vault — device_vars + encryptVars | `backend/index.js` (encryptVars / decryptVars), `backend/mission.js` (decryptVarsLocal) | ✅ | [`backend/docs/specs/vault.md`](vault.md) (encryption boundary, dual-auth, no-rental-leak rule, audit trail) |
| 6 | official-bind / public-code | `backend/index.js` (officialBindingsCache, public_code_index), `backend/auth.js` | ❌ | borrow flow + free vs personal binding only documented in code paths |
| 7 | channel-bridge (fakechat / web_chat) | `backend/index.js` (`/api/client/speak`, `/api/transform`, `/api/chat/history`), `bridge.ts` | ❌ | `bridge.ts` has inline comments; AVAILABLE TOOLS dashboard format only encoded in mission notify code |
| 8 | mission-dashboard / notes / chat-history | `backend/mission.js`, `backend/index.js` (`/api/mission/dashboard`, `/api/chat/history`) | ❌ | endpoint shapes only in code |
| 9 | publisher (X/Mastodon retired/Discord) | `backend/publisher*.js`, `backend/x-tweet*.js`, `backend/discord*.js` | △ | scattered; news-publishing-api 2026-03-15 doc covers only one path |
| 10 | arena (browser interview / E2E test) | `backend/arena.js`, `backend/interview-arena.js` | ❌ | arena page_loaded protocol only in [memory](../../../docs/specs/) reference, not yet a backend spec |
| 11 | gatekeeper (intent classifier) | `backend/gatekeeper.js`, `backend/gatekeeper-router.js` | △ | repo-root [`docs/issues/gatekeeper-*.md`](../../../docs/issues/) bug post-mortems exist; no positive spec |
| 12 | bot identity layer (device + entity slot) | `backend/index.js` (entity rebind, createDefaultEntity), `backend/auth.js` | △ | repo-root [`docs/bot-identity-layer.md`](../../../docs/bot-identity-layer.md) exists — coverage TBD |

## Gap list (priority order)

**P0 / blocks mind-map first layer:**
1. **wallet.md** — ledger type matrix + balance/held invariants + idempotency contract. Cited by every rental + topup card; absence makes "why does endRental return refund_mli + forfeit_mli but NOT credit owner directly" impossible to grep without reading source.
2. ~~**vault.md**~~ — ✅ shipped (see row #5). Encryption boundary, dual-auth model, no-`allowed_vars` rule now anchored in the repo.
3. **channel-bridge.md** — fakechat ↔ web_chat ↔ AVAILABLE TOOLS dashboard contract. Drives every bot's runtime behavior; absence is why Hermes shipped broken i18n on 2026-04-25 (he didn't have a doc to cite).

**P1 / fills mind-map second layer:**
4. **official-bind.md** — borrow vs personal vs free; unbind cascade (now Phase 1-4 documented separately); public-code allocator constraints.
5. **kanban-supplement.md** — screenshot-review gate, cron 子卡 lifecycle, archived/restore, status enum (`backlog, todo, in_progress, review, done, blocked`).
6. **mission-dashboard.md** — endpoint shapes, AVAILABLE TOOLS format, dashboard refresh cadence.

**P2 / nice to have:**
7. publisher.md (post-Mastodon-retirement, post-wp.com-retirement)
8. arena.md (page_loaded → navigateUrl protocol)
9. gatekeeper.md (positive spec, not just bug post-mortems)

## Out of scope for this audit

This card delivers: **(a) this INDEX**, **(b) the gap list above**, and **(c) one sample spec — `rental.md`**. It does NOT fill in the gaps. Each P0/P1/P2 doc above should become its own card (or be batched into themed cards) when prioritized.

## Convention going forward

- Every new subsystem must ship a `backend/docs/specs/<subsystem>.md` alongside the implementation PR.
- Specs cite **constants by name + value** (e.g. `INTERVIEW_PASS_SCORE = 60`) so a grep against the doc finds the rule, and a grep against the code finds the implementation — both lead to the same line.
- Specs document **invariants and boundaries**, not API shape (that lives in `/api/help` + JSDoc on the route handlers).
- When a constant changes, the spec changes in the same PR (CI does not enforce this yet — file a follow-up if drift becomes a problem).
