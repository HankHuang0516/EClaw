# Mission note ↔ Kanban card explicit links

## Context

`docs/spec/mindmap-force-graph.md` §12.3 requires strong `note_on_card` edges. Before this change, note/card relationships were inferred from `mindmap_node_anchors` or from a single `note.anchor`, which made graph output fragile and hard to edit from Mission notes.

Mission notes remain stored in `mission_dashboard.notes` JSONB for backward compatibility. The explicit relationship is persisted separately in `mission_note_card_links`.

## Model

`mission_note_card_links` columns:

- `device_id`
- `note_id`
- `card_id`
- `created_by`
- `created_at`
- unique `(device_id, note_id, card_id)`

All writes validate:

1. the request is authenticated for the device;
2. the note exists in `mission_dashboard.notes` for that device;
3. every linked Kanban card exists in `kanban_cards` for that same device.

The table intentionally does not FK to Mission notes because notes are currently JSONB entries, not rows.

## API surface

- `POST /api/mission/note/add` accepts `linkedCardIds`.
- `POST /api/mission/note/update` accepts `linkedCardIds`; `[]` clears all card links.
- Dashboard bulk save persists `note.linkedCardIds` into the join table.
- `GET /api/mission/note/:noteId/cards` lists linked cards.
- `PUT /api/mission/note/:noteId/cards` replaces links.
- `POST /api/mission/note/:noteId/card` adds one link.
- `DELETE /api/mission/note/:noteId/card/:cardId` removes one link.

## Graph behavior

`/api/mindmap/graph` now emits `note_on_card` edges from `mission_note_card_links` with evidence `mission_note_card_links`. Legacy `mindmap_node_anchors` cross-correlation still runs afterward as a bridge, with duplicate note/card pairs de-duped.

## Backfill strategy

Backfill from existing anchors is explicitly deferred for this PR. Runtime graph output already bridges old anchor-derived relationships, so no relationship is lost. A future migration can scan notes with `anchor.type === "kanban_card"` and insert `(device_id, note_id, anchor.refId)` after device-scoped card validation.
