# Kanban Card-Link System

Last reviewed: 2026-06-03 — tracking card `card_3e3351cd0df7936fef184d2b`.

Kanban cards have **two independent linking mechanisms**. They share a UI
surface (chips on the card) but are stored, mutated, and surfaced through
completely separate APIs. Confusing them is the #1 source of "link doesn't
work" reports (see the Hank 2026-06-03 09:39 thread that triggered this spec).

| | Mechanism A — workflow chain | Mechanism B — DAG dependencies |
|---|---|---|
| **Storage** | `kanban_cards.linked_prev_card_id`, `kanban_cards.linked_next_card_id` (single ref each) | `kanban_card_dependencies` table (many-to-many edges) |
| **Cardinality** | 1:1 (each card has at most one prev and one next) | N:N |
| **Write API** | `PUT /api/mission/card/:id` with `linkedPrevCardId` / `linkedNextCardId` | `POST /api/mission/card/:id/deps`, `DELETE /api/mission/card/:id/deps` |
| **Read API** | `GET /api/mission/card/:id` returns hydrated `linkedPrev` + `linkedNext` payloads | `GET /api/mission/card/:id/dependencies`, `GET /api/mission/card/:id/dependents` |
| **UI chips** | `kb-task-chip.prev` ← / `kb-task-chip.next` → (top secondary row + in-description row) | `kb-dep-chip--depends-on` / `kb-dep-chip--blocks` (separate container) |
| **Empty toast** | (no toast — chip row simply hides) | "No DAG dependencies (use Prev/Next chip for workflow chain)" |
| **Intended use** | spec → impl → review pipeline; cron-spawn parent/child; "what comes next" | blocked_by relationships; topological ordering; cycle-detection (`backend/kanban-dependencies.js`) |
| **Cycle handling** | Single-link refs cannot cycle on their own; reciprocal write enforces invariant | Explicit cycle detection in `kanban-dependencies.js` (topological sort) |

If a user is asking "this card should be the next step after that card", they
want **Mechanism A**. If they are asking "this card is blocked by that card",
they want **Mechanism B**. Both can coexist on the same pair of cards if the
relationship is both sequential and blocking.

## Mechanism A — workflow chain (`linkedPrev` / `linkedNext`)

### Invariant

```
A.linkedNextCardId = B   ⟺   B.linkedPrevCardId = A
```

Each pointer is single-valued. There is no array form (intentional — N:N is
what Mechanism B is for; do not extend `linkedPrev/Next` to arrays).

### Atomic dual-end write

`PUT /api/mission/card/:id` runs the primary `UPDATE` and the reciprocal
mutation in **one transaction** (`backend/kanban.js`, search for
`needsLinkSync`). The reciprocal logic is:

1. If `linkedNextCardId` changes from `oldNext` to `newNext`:
   - If `oldNext` is set and differs: clear `oldNext.linked_prev_card_id`
     where it pointed back to this card (disconnect old chain).
   - If `newNext` is set: detach any other card whose `linked_next_card_id`
     equals `newNext` (claim newNext as ours), then set
     `newNext.linked_prev_card_id = this card`.
2. Symmetric logic for `linkedPrevCardId`.

The write is **idempotent** — re-issuing the same `PUT` with unchanged values
re-asserts the reciprocal pointer, self-healing any rows where the invariant
was broken externally.

### Clearing a link

`PUT /api/mission/card/:id` with `{ linkedNextCardId: null }` clears both
sides. The same transaction sets `A.linked_next_card_id = NULL` AND
`B.linked_prev_card_id = NULL` (where B was the prior target and still pointed
back to A).

### Read-side payload

`GET /api/mission/card/:id` returns:

```json
{
  "id": "card_…",
  "linkedPrevCardId": "card_aaa",
  "linkedNextCardId": "card_bbb",
  "linkedPrev": { "id": "card_aaa", "title": "Spec — login flow", "status": "done", "priority": "P1", "archived": false },
  "linkedNext": { "id": "card_bbb", "title": "Impl — login flow", "status": "in_progress", "priority": "P1", "archived": false }
}
```

The hydrated `linkedPrev` / `linkedNext` payloads let the UI render
informative chips ("← Spec — login flow") without a follow-up `GET /card/:id`
per neighbour. They are `null` when the corresponding `*CardId` is null or
when the target was archived/deleted and is no longer queryable.

`GET /api/mission/cards` (list) does NOT hydrate these payloads — it returns
only the raw `linkedPrevCardId` / `linkedNextCardId`. Card-detail consumers
should call `GET /card/:id` for the hydrated form.

### UI chip rendering

- **Top secondary row** — `renderTaskSecondaryChips` /
  `renderTaskSecondaryActions` in `backend/public/portal/kanban.html`. Already
  rendered the Prev/Next chips before this work.
- **In-description row (new)** — `renderDetailLinkChipRow` renders the same
  Parent/Prev/Next chips immediately under the description body in the detail
  modal. The row hides when no pointer is set (no always-visible empty
  scaffolding). Uses the hydrated `linkedPrev` / `linkedNext` titles when
  available; falls back to the raw ID otherwise.

## Mechanism B — DAG dependencies (`blocked_by` / `dependents`)

### Storage

`kanban_card_dependencies` table — many-to-many edges with cycle detection in
`backend/kanban-dependencies.js`. Each row is a directed edge
`(source_card_id → target_card_id)` meaning "source is blocked_by target" or
equivalently "target is a dependent of source".

### API

- `POST /api/mission/card/:id/deps` — add an edge. Validated for cycles via
  topological sort before insert.
- `DELETE /api/mission/card/:id/deps` — remove an edge.
- `GET /api/mission/card/:id/dependencies` — list cards this card depends on.
- `GET /api/mission/card/:id/dependents` — list cards that depend on this card.

### UI

- Dependency chips are rendered in a separate `.kb-detail-dep-chips`
  container, populated by `fetchCardDependencies` + `renderDependencyChips`
  in `kanban.html`.
- Navigation arrows on inline card-reference chips
  (`entity-link-render.js`, `navigateCardDependency`) walk the DAG by one
  step. When the card has no DAG dependencies, the toast now reads "No DAG
  dependencies (use Prev/Next chip for workflow chain)" — pointing the user
  at Mechanism A instead of leaving them confused.

## Out of scope

- Extending `linkedPrev/Next` to arrays (multi-prev / multi-next) — use
  Mechanism B instead. The whole point of the split is that one mechanism is
  1:1 and the other is N:N.
- Mobile native apps. This spec covers the web portal only. The Android and
  iOS card UI surfaces the same fields read-only via the existing
  `/api/mission/card/*` endpoints and does not need separate write paths.
