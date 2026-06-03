# Portal `?` icon — bidirectional references spec

| | |
|---|---|
| Card | `card_a20b69d79f4aba684e7d04ec` |
| Linked prev | `card_aa15ed2618c9246d11a0f6b1` (research card that surfaced the need) |
| Status | Spec + Impl / P1 |
| Date | 2026-06-03 |
| Author | #2 (LOBSTER) |

## 1. Motivation

The EClaw chat bridge already auto-expands references when a user mentions a card id, PR number, or spec doc — the `[REFERENCES — CONTEXT]` block in inbound payloads is a working example. That expansion only happens at chat-send time and is one-way: the chat sees the referenced thing, but the referenced thing does not know it was cited.

Hank's 2026-06-03 chat request:

> card_aa15ed26 直接全做 + 整理 SPEC + ? icon 雙向參照

surfaces three asks. The first two are handled by `card_7579f20522a8276240736c7d`. This card is the third: make the reference graph visible inside portal UI, and make it **bidirectional** so an artifact's `?` panel shows both *what it cites* and *who cites it*.

Concrete pain it removes:
- When I open a spec doc in portal `/docs`, I can't see which cards / PRs implement it.
- When I look at a card, I can't see which spec doc grounds it without digging through the description body.
- When a PR is opened, the linked card and spec are buried in PR body markdown that nobody reads twice.

## 1.1 Non-goals (v1)

- A full knowledge-graph UI (think Obsidian). v1 surfaces in-place popovers only.
- Cross-device refs. v1 is scoped to a single EClaw device's kanban + repos + portal.
- Editing references through the UI. v1 reads only; refs are derived from text content.
- Refs to arbitrary URLs. v1 supports four kinds: **card**, **spec**, **pr**, **doc** (research docs under `docs/research/`).

## 2. Surfaces — where `?` appears

| Surface | Where | Trigger | Position |
|---|---|---|---|
| Kanban card | `portal/kanban.html`, kanban card list / detail | always-visible `?` next to card title | next to `…` menu |
| Spec doc | `portal/docs.html` rendering `docs/specs/*.md` | always-visible `?` in doc header | next to title `h1` |
| Research doc | `portal/docs.html` rendering `docs/research/*.md` | same as spec doc | same |
| PR card | `portal/prs.html` (new, optional v1.5) | `?` next to PR row | inline |
| Chat quote bubble | `portal/chat.html` reference cards | `?` already implicit via expand; v1 reuses same data | inline |

`?` is a 16-px round button with the glyph `ⓘ` (info circle) — `?` is the user-facing nickname but the glyph is `ⓘ` because it scans better in non-CJK locales. The CSS class is `eclaw-refs-icon`. Aria-label: `"Show related cards, specs, and PRs"`.

## 3. Backend contract

### 3.1 `GET /api/refs?from=<id>` — get refs for an artifact

```
GET /api/refs?from=card_aa15ed2618c9246d11a0f6b1&deviceId=<uuid>&botSecret=<hex>&entityId=2
```

Response:
```json
{
  "success": true,
  "from": {"kind": "card", "id": "card_aa15ed26...", "label": "Eclaw 遠端控制 vs minitap-ai/mobile-use"},
  "refs": [
    {"kind": "spec",   "id": "docs/specs/mobile-use-integration.md", "label": "mobile-use integration", "direction": "out"},
    {"kind": "spec",   "id": "docs/specs/portal-bidirectional-refs.md", "label": "portal ? icon refs", "direction": "out"},
    {"kind": "doc",    "id": "docs/research/2026-06-03-mobile-use-comparison.md", "label": "mobile-use comparison report", "direction": "out"},
    {"kind": "pr",     "id": "3123", "label": "docs(research): EClaw vs minitap-ai/mobile-use", "direction": "in"},
    {"kind": "card",   "id": "card_7579f20...", "label": "mobile-use integration full spec", "direction": "out"},
    {"kind": "card",   "id": "card_a20b69d7...", "label": "portal ? icon bidirectional refs", "direction": "out"}
  ]
}
```

`direction`:
- `out` — the `from` artifact mentions the ref (looking at the from, it points outward).
- `in` — the ref mentions `from` (looking at the from, the ref points inward — back-link).

### 3.2 Source-of-truth scan

The refs index is built from these sources, scanned every 5 min by a background job:

| ref kind | scan source |
|---|---|
| card | `kanban_cards.description` + `kanban_cards.title` + `kanban_cards.linked_prev_card_id` + `kanban_cards.linked_next_card_id` + `kanban_card_dependencies` (card_id ↔ depends_on_card_id) + `kanban_card_links` (source_card_id ↔ target_card_id) + `kanban_comments.text` |
| spec | files under `docs/specs/**/*.md` (git working tree at HEAD on main) |
| doc | files under `docs/research/**/*.md` |
| pr | `gh pr list --state all --limit 200 --json number,title,body,url,state,updatedAt` — scan `body` for cited refs |

Pattern matching:
- `card_[a-f0-9]{24}` for card ids
- `docs/specs/[\w-]+\.md` and `docs/research/[\w-]+\.md` for doc paths
- `#\d{3,5}` for PR numbers (validated against the gh listing)

**Back-link sources (AC5)**: incoming refs to a card are derived from ALL of the above, not just PR bodies. A spec doc mentioning `card_X`, a research doc mentioning `card_X`, OR another card's description/comments mentioning `card_X` all surface as `direction: "in"` in `card_X`'s `?` popover. PR-body back-refs are required but not exclusive.

Cache: in-memory map keyed by **`<deviceId>|<kind>|<id>`** (NOT just `from` id — multi-device isolation), TTL 5 min, written to disk at `backend/.cache/refs.json` for warm start. Cache stores only normalized refs (post-resolution: id, label, kind, direction — no raw scan rows). `backend/.cache/` MUST be in `.gitignore`; warm-start file is regenerated on cold start so its absence is non-fatal.

### 3.3 `GET /api/refs/graph` (v1.5, optional)

Returns the full edge list for a graph view. Out of scope for v1; spec'd here so the API shape is stable from the start.

```json
{
  "success": true,
  "nodes": [{"kind":"card","id":"...","label":"..."}, ...],
  "edges": [{"from":"card_X","to":"docs/specs/Y.md"}, ...]
}
```

## 4. Frontend contract — `?` popover

### 4.1 Component shell

```html
<button class="eclaw-refs-icon" data-refs-from="card_aa15ed26..." aria-label="Show related cards, specs, and PRs">ⓘ</button>
```

A single shared script (`backend/public/shared/refs-popover.js`) wires the click handler. On click:

1. POST not needed; GET `/api/refs?from=<id>` with cached creds.
2. Render a popover anchored under the `?` button.
3. Popover content: two columns — **Outgoing** (this cites ↓) and **Incoming** (← cites this). Each row is a clickable link.

`refs-popover.js` reuses `shared/help-popover.js`'s show/hide/focus-trap/ESC plumbing. A minimal options hook is added to `help-popover.js` to accept per-popover `maxWidth` (default 280, refs needs ~360) and a `variant: 'tooltip' | 'sheet'` flag — `sheet` engages the mobile bottom-sheet layout. No new focus-trap or ARIA code is added; the existing one is parameterized.

### 4.2 Mock — ASCII

```
┌─────────────────────────────────────────────────────────────┐
│  ⓘ References for card_aa15ed26...                  [ × ]   │
├─────────────────────────────────────────────────────────────┤
│  This card cites (out):                                      │
│   📄 docs/specs/mobile-use-integration.md                    │
│   📄 docs/specs/portal-bidirectional-refs.md                 │
│   📄 docs/research/2026-06-03-mobile-use-comparison.md       │
│   📋 card_7579f205... mobile-use integration full spec       │
│   📋 card_a20b69d7... portal ? icon bidirectional refs       │
│                                                              │
│  Cited by (in):                                              │
│   🔀 PR #3123 docs(research): EClaw vs minitap-ai/mobile-use │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

CSS rules live in `backend/public/shared/refs-popover.css`. Mobile (≤720 px) uses bottom-sheet variant matching `shared/hover-click-toolbar.css` mobile pattern. Reduced motion respected.

### 4.3 i18n

```jsonc
{
  "refs.popover_title": "References",
  "refs.section_out": "This cites",
  "refs.section_in": "Cited by",
  "refs.empty": "No related items yet.",
  "refs.error": "Couldn't load related items."
}
```

EN dictionary update + delegation to #3/#4 for non-EN per `feedback_i18n_delegate`.

## 5. Schema

```ts
type RefKind = "card" | "spec" | "doc" | "pr";
type RefDirection = "in" | "out";

interface Ref {
  kind: RefKind;
  id: string;          // card_xxx | docs/specs/foo.md | docs/research/bar.md | PR number as string
  label: string;       // human-readable; truncated to 80 chars
  direction: RefDirection;
}

interface RefsResponse {
  success: true;
  from: { kind: RefKind; id: string; label: string };
  refs: Ref[];
}
```

## 6. Phasing

| Phase | Scope | Card status |
|---|---|---|
| **Phase 1 (this spec PR)** | Spec doc only. No code. | spec PR opened against this card |
| **Phase 2 (impl backend + scan)** | `/api/refs` endpoint + 5-min scan job + cache | impl card spawned with linkedPrev to this card |
| **Phase 3 (impl frontend)** | `shared/refs-popover.{js,css}` + i18n keys + wire `?` into kanban/docs/PR portal pages | impl card spawned |
| **Phase 4 (back-link scan)** | Inbound direction works (PR body mentions card_X → card's `?` panel shows back-link) | included in Phase 2 |
| **Phase 5 (graph view)** | `/api/refs/graph` + dedicated `/portal/refs/graph.html` | OPTIONAL, deferred to v1.5 if Phase 1-4 are usable |

## 7. Acceptance criteria

- **AC1** — Spec PR merged after Hank + #1/#6 review per `feedback_spec_first`.
- **AC2** — `GET /api/refs?from=<id>` returns valid `RefsResponse` for any of the 4 ref kinds.
- **AC3** — Background scan runs every 5 min and refreshes the cache without blocking requests.
- **AC4** — Clicking `?` on any of the 3 v1 surfaces (kanban / spec doc / research doc) opens the popover with at least one out-direction ref.
- **AC5** — Back-link auto-populates from ALL source kinds, not PR-only: (a) open PR mentioning `card_X` in its body → card_X's `?` shows the PR as incoming; (b) a spec or research doc mentioning `card_X` → card_X's `?` shows the doc as incoming; (c) another card's description/comments mentioning `card_X` → card_X's `?` shows the citing card as incoming. All cases without manual editing.
- **AC6** — Mobile bottom-sheet variant at 390 × 844 viewport.
- **AC7** — Playwright prod E2E covering all 3 v1 surfaces + screenshots attached to the impl card per `feedback_personal_screenshot_review`.

## 8. Rollback

- Spec PR revert removes the doc only.
- Phase 2 impl behind env flag `ECLAW_REFS_INDEX_ENABLED`; flag off → endpoint returns `{success:true, refs:[]}` — `?` icon renders an empty popover but doesn't break the UI.
- Phase 3 impl: removing `<script src="shared/refs-popover.js">` from portal pages removes all `?` icons; no other DOM impact.

## 9. References

- Research card that surfaced the ask: `card_aa15ed2618c9246d11a0f6b1`
- Existing chat-side reference expansion pattern: bridge's `[REFERENCES — CONTEXT]` block (see `claude-code-eclaw-channel/bridge.ts`)
- Memory: `feedback_spec_first`, `feedback_link_card_full_e2e_required`, `feedback_i18n_delegate`, `feedback_personal_screenshot_review`

## 10. Amendments

### 2026-06-03 — #6 yrt82n review (pre-impl)

Original spec merged in PR #3124 with reviews:[]. U94 requested retroactive sign-off on `card_a20b69d79f4aba684e7d04ec`. #6 returned 5 amendments REQUIRED before Impl PR; folded into §3.2, §4.1, AC5:

1. **Cache key**: must include `<deviceId>|<kind>|<id>` (not just `from` id) for multi-device isolation. Cache stores normalized refs only. `backend/.cache/` added to `.gitignore`. → §3.2 Cache line.
2. **Card sources**: replace non-existent `kanban.cards.scope` with the real structured tables — `linked_prev_card_id` + `linked_next_card_id` columns, plus `kanban_card_dependencies` (card_id/depends_on_card_id) and `kanban_card_links` (source_card_id/target_card_id). → §3.2 table.
3. **gh pr list flags**: plain `gh pr list` does not return `body`; AC5 needs it. Use `--json number,title,body,url,state,updatedAt`. → §3.2 table.
4. **Frontend hook**: refs-popover wraps `help-popover.js`; add minimal options hook on the base (`maxWidth`, `variant: 'tooltip' | 'sheet'`) instead of forking. → §4.1.
5. **AC5 back-refs not PR-only**: in v1, back-links include card description/comments and doc citations, not just PR-body matches. → §3.2 "Back-link sources" paragraph + AC5 enumeration.
