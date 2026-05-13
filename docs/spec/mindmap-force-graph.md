# Mindmap × react-force-graph integration spec

**Status:** Draft for Mac_ClaudeAce review
**Owner:** Mac_F / entity #1 (spec only)
**Reviewer / implementer:** Mac_ClaudeAce / entity #2
**Implementation rule:** mind-map implementation remains #2 self-only unless Hank explicitly changes the 2026-04-25 rule. This document proposes architecture, API shape, and follow-up cards only.

## 0. Summary

Replace or supersede the current Mission mind-map renderer with a `react-force-graph` powered graph view that projects Kanban tasks and Mission notes into the library-native:

```json
{ "nodes": [], "links": [] }
```

shape.

The first implementation target should be **2D Canvas** via `react-force-graph-2d`, not 3D/VR/AR. The current portal is WebView-heavy and the requirement is 1000 nodes / 2000 edges at 30fps; 2D Canvas is the best fit for mobile WebView performance, text rendering, and click-to-navigate UX.

The integration should be additive at first:

1. Add `GET /api/mindmap/graph` as the canonical graph projection endpoint.
2. Add a new `backend/public/portal/mindmap.html` React island page, or wire it into `mission.html` behind a feature flag.
3. Keep existing `/api/mission/mindmap`, `mission.html` embed, `mindmap.js`, and `mindmap-mirror.js` stable until the new page passes E2E.
4. After approval, decide whether `mission.html` links to the new page, embeds it, or replaces the old Cytoscape-style mission mind-map block.

## 1. Current-state inventory

Relevant existing code:

- `backend/mindmap.js`
  - Existing `/api/mindmap/*` CRUD for durable mindmap nodes, edges, anchors, comments, and traverse.
  - Uses `mindmap_nodes`, `mindmap_edges`, `mindmap_node_anchors`, `mindmap_node_comments`.
- `backend/mindmap-mirror.js`
  - Mirrors Mission notes into durable mindmap nodes.
  - Supports note anchors to `kanban_card` and `chat_message`.
- `backend/kanban.js`
  - Existing `GET /api/mission/mindmap` feed for `mission.html`.
  - Emits a bespoke `{ nodes, edges }` shape for `backend/public/portal/shared/mission-mindmap.js`.
  - Currently limits active cards to 80 and adds subsystem hub nodes.
- `backend/kanban_schema.sql`
  - `kanban_cards.parent_card_id` exists.
  - `kanban_card_dependencies` exists for card dependency edges, with `dependency_type` defaulting to `blocks`.
  - `chat_anchor_coord` exists but is a coordinate/provenance field, not a durable force-graph layout store.
- `backend/mission_schema.sql`
  - `mission_notes` exists as device-scoped notes.
- `backend/public/portal/mission.html`
  - Currently embeds `shared/mission-mindmap.js` and fetches `/api/mission/mindmap`.
- `backend/public/portal/mindmap.html`
  - Currently absent. Old i18n comments say a standalone mindmap page was removed on 2026-04-28.

## 2. Goals / non-goals

### Goals

- Provide a graph endpoint designed for `react-force-graph`.
- Map Kanban cards and Mission notes into one navigable graph.
- Support parent, blocks, references, owner, and explicit note/card relationships.
- Support WebView-safe interactions: hover/tap preview, click navigation, drag-rearrange, and per-entity local layout persistence.
- Preserve device isolation and auth behavior.
- Hit at least 30fps in Chrome WebView with 1000 nodes / 2000 edges.
- Keep implementation separable from schema/API follow-up cards.

### Non-goals for the first spec-approved implementation

- Do not implement the graph in this PR.
- Do not replace every existing mindmap endpoint immediately.
- Do not add 3D/VR/AR modes.
- Do not invent AI clustering in the first pass.
- Do not require card tags / related-card schema before a useful MVP. Missing edge types should degrade gracefully.

## 3. Library contract

`react-force-graph` accepts:

```jsx
<ForceGraph2D graphData={{ nodes, links }} />
```

Core accessors default to:

- node id: `node.id`
- link source: `link.source`
- link target: `link.target`

Therefore `/api/mindmap/graph` should directly return:

```ts
type ForceGraphPayload = {
  success: true;
  graph: {
    nodes: MindmapNode[];
    links: MindmapLink[];
  };
  stats: GraphStats;
  meta: GraphMeta;
};
```

`react-force-graph-2d` features relevant to this project:

- Canvas rendering for 2D graph performance.
- `nodeCanvasObject` for custom node drawing.
- `nodeLabel` / custom hover for previews.
- `onNodeClick`, `onNodeHover`, `onNodeDragEnd`.
- Link color/width/dash accessors for edge types.
- `d3Force` tuning for charge/collision/link distance.
- `warmupTicks`, `cooldownTicks`, `cooldownTime` to bound layout CPU.
- `node.fx` / `node.fy` for pinned saved positions.

## 4. Data model mapping

### 4.1 Node id convention

Use stable prefixed ids so node ids are unique across entity types and safe for links:

| Source | Node id | Example |
|---|---|---|
| Kanban card | `task:<cardId>` | `task:card_abc123` |
| Mission note | `note:<noteId>` | `note:note_def456` |
| Entity owner | `owner:<entityId>` | `owner:2` |
| Status hub, optional | `status:<status>` | `status:in_progress` |
| Tag hub, future | `tag:<slug>` | `tag:frontend` |
| Existing durable mindmap node, optional | `mindmap:<uuid>` | `mindmap:6f...` |

Do **not** use raw ids (`card_...`, `note_...`) as graph ids because `note_` and future sources can collide with other object namespaces and because edge origins become ambiguous in telemetry.

### 4.2 Kanban card → task node

Source table: `kanban_cards`.

Required fields:

```ts
type TaskNode = {
  id: `task:${string}`;
  sourceId: string;              // raw card id
  label: string;                 // short title, <= 80 chars for draw path
  fullTitle: string;
  type: 'task';
  status: 'backlog' | 'todo' | 'in_progress' | 'review' | 'done' | 'blocked';
  priority: 'P0' | 'P1' | 'P2' | 'P3';
  ownerEntityId: number | null;  // primary owner, see mapping below
  assignedEntityIds: number[];
  reviewerEntityId: number | null;
  parentCardId: string | null;
  blockedByCardIds: string[];
  references: GraphReference[];
  summary: string;               // description excerpt, <= 240 chars
  commentCount: number;
  noteCount: number;
  updatedAt: string | null;
  url: string;                   // portal deep link
  colorKey: string;              // for nodeColor/nodeAutoColorBy
  val: number;                   // node size weight
  x?: number; y?: number; fx?: number; fy?: number;
};
```

Owner mapping:

- `ownerEntityId` should default to the first `assigned_bots` element when present.
- If empty, fall back to `created_by` when it is a valid entity id.
- `assignedEntityIds` should preserve the full `assigned_bots` array for owner edges and filtering.
- `reviewer_entity_id` becomes a separate reviewer metadata field and optional future edge.

Task size (`val`) recommendation:

```text
P0 = 8
P1 = 6
P2 = 4
P3 = 3
is_automation parent = +1
blocked status = +1
```

### 4.3 Mission note → note node

Source table: `mission_notes` plus existing note anchor data when available from `mindmap-mirror` / note JSON.

Required fields:

```ts
type NoteNode = {
  id: `note:${string}`;
  sourceId: string;              // raw note id
  label: string;                 // title, <= 80 chars
  fullTitle: string;
  type: 'note';
  category: string;
  ownerEntityId: number | null;  // parsed from created_by if numeric, else null
  summary: string;               // content excerpt, <= 240 chars
  anchors: GraphReference[];     // kanban_card/chat_message/url/etc.
  updatedAt: string | null;
  url: string;                   // note detail / mission deep link
  colorKey: string;
  val: number;
  x?: number; y?: number; fx?: number; fy?: number;
};
```

Note owner mapping:

- Existing `mission_notes.created_by` is string. Treat numeric strings as entity ids.
- Non-numeric values (`user`, `system`) should map to `ownerEntityId = null` and optionally link to `owner:user` / `owner:system` hubs only if UI wants them.

### 4.4 Owner entity → owner node

Owner nodes are optional but useful for force clustering and filters.

```ts
type OwnerNode = {
  id: `owner:${number | 'user' | 'system'}`;
  sourceId: string;
  label: string;                 // entity display name if available
  type: 'owner';
  ownerEntityId: number | null;
  avatar?: string;
  colorKey: 'owner';
  val: number;
};
```

Owner nodes should be emitted only for owners that have at least one visible task/note in the response unless `includeOwners=all` is passed.

## 5. Edge model mapping

Use `links`, not `edges`, to match react-force-graph defaults.

```ts
type MindmapLink = {
  id: string;
  source: string;                // node id
  target: string;                // node id
  type: 'parent' | 'blocks' | 'references' | 'owner' | 'note_on_card' | 'related' | 'tag';
  label: string;
  weight: number;
  directional: boolean;
  colorKey: string;
  evidence?: string;             // source table / column for debugging
};
```

### 5.1 Parent edges

Source: `kanban_cards.parent_card_id`.

```text
source = task:<parent_card_id>
target = task:<child_card_id>
type   = parent
```

Only emit when both nodes are included in the response. If parent is filtered out, either omit or include a lightweight collapsed parent stub when `includeStubs=true`.

### 5.2 Blocks edges

Source: `kanban_card_dependencies` where `dependency_type = 'blocks'`.

Current schema fields:

- `card_id`
- `depends_on_card_id`
- `dependency_type`

Recommended semantics:

```text
source = task:<depends_on_card_id>  // blocker / prerequisite
target = task:<card_id>             // blocked card
type   = blocks
```

This reads visually as “A blocks B” and supports arrows from blocker to blocked.

### 5.3 References edges

Sources, in priority order:

1. Future explicit card relation table (`kanban_card_links` or equivalent).
2. Existing note anchors (`mindmap_node_anchors.anchor_type = 'kanban_card'`).
3. Lightweight text parsing fallback from card descriptions/comments for `card_<id>` tokens, capped and marked `evidence='text-token-fallback'`.

Recommended semantics:

```text
source = current node
target = referenced node
type   = references
```

Do not over-weight fallback text-token edges; they are noisy.

### 5.4 Owner edges

Source: `kanban_cards.assigned_bots`, `created_by`, `reviewer_entity_id`, `mission_notes.created_by`.

Recommended semantics:

```text
source = owner:<entityId>
target = task:<cardId> | note:<noteId>
type   = owner
```

For multi-assignee cards, emit one owner edge per assigned entity with low weight. The primary owner may receive slightly higher weight.

### 5.5 Note ↔ card edges

Source: explicit note anchor from `mindmap-mirror` or future note/card link field.

```text
source = note:<noteId>
target = task:<cardId>
type   = note_on_card
```

This is distinct from generic `references` because note-on-card is a stronger relation and should be drawn thicker or closer.

### 5.6 Related edges, future

Source: proposed `kanban_card_links` table.

Allowed values:

- `related`
- `references`
- `duplicates`
- `causes`
- `supports`
- `contradicts`

First implementation can reserve the enum but only emit `related` / `references` until UI exists.

## 6. `/api/mindmap/graph` endpoint

### 6.1 Route

```http
GET /api/mindmap/graph?deviceId=...&deviceSecret=...
GET /api/mindmap/graph?deviceId=...&botSecret=...&entityId=...
```

Mount in existing `backend/mindmap.js` router to keep mindmap auth/ownership together. The endpoint may internally query Kanban/Mission tables.

### 6.2 Auth / scope

Use the existing dual-auth model from `backend/mindmap.js`:

- `deviceSecret` gives owner/device-wide graph.
- `botSecret + entityId` gives entity-scoped graph; default filter should include:
  - cards assigned to that entity,
  - cards created by that entity,
  - notes created by that entity,
  - immediate neighbors needed to make edges understandable.

Recommended query flags:

| Param | Default | Notes |
|---|---:|---|
| `scope` | `device` for deviceSecret, `entity` for botSecret | `device`, `entity`, `owner`, `all` if admin later exists |
| `entityId` | caller entity | Required for botSecret auth |
| `includeArchived` | `false` | Done/archived can explode node count |
| `includeDone` | `false` | Toggle for completed work history |
| `includeNotes` | `true` | Allow task-only mode |
| `includeOwners` | `active` | `none`, `active`, `all` |
| `includeTextFallbackRefs` | `false` | Avoid noisy auto edges by default |
| `limitNodes` | `1000` | Hard cap |
| `limitEdges` | `2000` | Hard cap |
| `since` | absent | Optional incremental mode later |

### 6.3 Response shape

```json
{
  "success": true,
  "graph": {
    "nodes": [
      {
        "id": "task:card_abc",
        "sourceId": "card_abc",
        "label": "[P1] Fix rental refund",
        "fullTitle": "[P1] Fix rental refund",
        "type": "task",
        "status": "in_progress",
        "priority": "P1",
        "ownerEntityId": 1,
        "assignedEntityIds": [1],
        "reviewerEntityId": 2,
        "parentCardId": null,
        "blockedByCardIds": [],
        "summary": "Implement second-level refunds...",
        "commentCount": 4,
        "noteCount": 1,
        "updatedAt": "2026-05-13T01:45:00.000Z",
        "url": "/portal/kanban.html?card=card_abc",
        "colorKey": "status:in_progress",
        "val": 6
      }
    ],
    "links": [
      {
        "id": "blocks:card_a:card_b",
        "source": "task:card_a",
        "target": "task:card_b",
        "type": "blocks",
        "label": "blocks",
        "weight": 2,
        "directional": true,
        "colorKey": "edge:blocks",
        "evidence": "kanban_card_dependencies"
      }
    ]
  },
  "stats": {
    "nodeCount": 423,
    "linkCount": 812,
    "truncated": false,
    "truncatedNodes": 0,
    "truncatedLinks": 0,
    "sourceCounts": { "task": 310, "note": 92, "owner": 21 },
    "edgeCounts": { "parent": 77, "blocks": 33, "owner": 300, "note_on_card": 41 }
  },
  "meta": {
    "generatedAt": "2026-05-13T01:45:00.000Z",
    "deviceId": "...",
    "scope": "device",
    "schemaVersion": 1,
    "layoutStorageKey": "mindmap:force-layout:v1:<deviceId>:entity:<entityId|owner>"
  }
}
```

### 6.4 Query implementation outline

One endpoint should avoid N+1 query loops.

Suggested SQL batches:

1. Cards:
   - `kanban_cards` scoped by `device_id`, `archived`, `status`, `assigned_bots` / `created_by` when entity-scoped.
   - Include `parent_card_id`, `assigned_bots`, `reviewer_entity_id`, `priority`, `status`, `updated_at`.
2. Card aggregate counts:
   - comments count grouped by card id.
   - notes count grouped by card id for `kanban_notes` if retained.
3. Dependencies:
   - `kanban_card_dependencies` for included cards.
4. Mission notes:
   - `mission_notes` scoped by device/entity filters.
5. Mindmap anchors:
   - `mindmap_node_anchors` where `anchor_type IN ('kanban_card', 'note')` and `anchor_ref` intersects included raw ids.
6. Entity owner display:
   - in-memory `devices[deviceId].entities` can enrich owner node names/avatars.

### 6.5 Error behavior

- Missing auth → same as existing mindmap routes.
- DB unavailable → `503`.
- Query cap exceeded → still return truncated graph with `stats.truncated=true`.
- Unknown link endpoint after filtering → omit link and increment `truncatedLinks` or `droppedLinks`.

## 7. Frontend integration point

### 7.1 Preferred page strategy

Create a new page:

```text
backend/public/portal/mindmap.html
```

Reasoning:

- Existing standalone mindmap page is absent.
- `mission.html` already has a legacy embedded graph and broader dashboard concerns.
- A new page lets #2 tune React, canvas sizing, WebView memory, and routing without destabilizing Mission/Kanban.
- Once stable, `mission.html` can link to or embed the new page.

### 7.2 React island delivery choices

Because the backend is CommonJS/static portal today, choose one of these implementation patterns:

| Option | Pros | Cons | Recommendation |
|---|---|---|---|
| CDN UMD React + react-force-graph-2d | Fast prototype, no build pipeline | External runtime dependency, CSP/cache concerns | OK for prototype only |
| Prebundled static asset checked in | No runtime CDN, predictable WebView | Needs local build step by #2 | Recommended production path |
| Add full portal bundler | Long-term clean React path | Larger repo/process change | Defer unless more React pages are planned |

Production recommendation: #2 builds a static bundle for `mindmap.html` and checks in generated assets under `backend/public/portal/assets/mindmap-force/` or equivalent, with source under a clearly named folder if the repo accepts frontend source.

### 7.3 Page behavior

Required behaviors:

- Fetch `/api/mindmap/graph` after portal auth resolves.
- Render graph with `ForceGraph2D`.
- Node color:
  - task by status or priority,
  - note by category,
  - owner as neutral/avatar color.
- Link style:
  - parent: solid,
  - blocks: red/orange directional arrow or particle,
  - references: dashed,
  - owner: faint grey,
  - note_on_card: blue/purple stronger line.
- Hover preview:
  - desktop: hover tooltip/sidebar card.
  - mobile/WebView: tap-select opens bottom preview panel.
- Click navigation:
  - task → `/portal/kanban.html?card=<cardId>`
  - note → `/portal/mission.html?note=<noteId>` or the current note detail route once defined.
  - owner → filter graph to that owner.
- Drag rearrange:
  - `onNodeDragEnd` stores local layout `{ id, x, y, fx, fy }`.
  - Dragged nodes become pinned (`fx`, `fy`) until user clicks “release layout”.
- Layout reset:
  - clear localStorage key and refetch/reheat graph.

### 7.4 Layout persistence

First pass: localStorage only, per device/entity.

Storage key:

```text
mindmap:force-layout:v1:<deviceId>:<scope>:<entityId|owner>
```

Value:

```json
{
  "updatedAt": "2026-05-13T01:45:00.000Z",
  "nodes": {
    "task:card_abc": { "x": 12.3, "y": -45.6, "fx": 12.3, "fy": -45.6 }
  }
}
```

Constraints:

- Max persisted nodes: 1000.
- Drop layout entries for nodes no longer in graph.
- Do not sync layout server-side in MVP; server persistence is a follow-up card if users expect cross-device continuity.

## 8. Performance budget

### 8.1 Target

- 1000 nodes / 2000 edges.
- At least 30fps in Chrome WebView.
- Initial interactive render under 3 seconds on mid-range Android emulator.
- No unbounded animation when hidden/backgrounded.

### 8.2 Backend limits

- Default `limitNodes=1000`, `limitEdges=2000`.
- Stable sort before truncation:
  1. not archived / not done,
  2. P0 → P3,
  3. recently updated,
  4. linked nodes with higher degree.
- Include `stats.truncated` so UI can show “Showing top 1000 nodes”.
- Use grouped aggregate queries; avoid per-card comment/note count queries.

### 8.3 Frontend rendering rules

- Use `ForceGraph2D` only for MVP.
- Disable expensive text drawing below zoom threshold.
- Draw labels only for:
  - hovered/selected node,
  - high-priority nodes,
  - owner hubs,
  - current search result.
- Use simple Canvas shapes in `nodeCanvasObject`; avoid HTML nodes for large graphs.
- Set bounded physics:
  - `warmupTicks`: ~80-120,
  - `cooldownTicks`: ~80-150,
  - stop/reduce animation after stabilization.
- Use `d3Force('collide')` only if profiling shows acceptable cost.
- Pause or throttle graph when tab/page hidden.
- Debounce hover preview updates.

### 8.4 E2E performance checks

Minimum benchmark script should assert:

- 1000/2000 synthetic graph renders without crash.
- 30fps median over 10 seconds after warmup on Chrome desktop.
- Android WebView/emulator smoke: graph remains interactive, no canvas overflow, no WebView kill.

## 9. Interaction requirements

### 9.1 Hover / tap preview

Preview content:

- label/full title,
- type,
- status/priority/category,
- owner/assigned entity,
- edge counts,
- summary excerpt,
- quick actions.

Desktop:

- hover shows floating preview after 150ms.
- click pins selected preview sidebar.

Mobile/WebView:

- tap node selects it and opens bottom sheet/inline panel.
- second tap on selected task navigates, or explicit “Open card” button navigates. Avoid accidental navigation during pan/zoom.

### 9.2 Click → navigate

Task:

```text
/portal/kanban.html?card=<rawCardId>
```

Note:

```text
/portal/mission.html?note=<rawNoteId>
```

If note deep-link support does not exist, implement preview-only and list “note deep-link” as a follow-up.

### 9.3 Drag rearrange

- Dragging changes local layout only.
- `onNodeDragEnd` pins node by setting `fx/fy` in localStorage.
- Provide “Save layout” only if #2 wants explicit control; otherwise auto-save drag end is acceptable.
- Provide “Reset layout” to clear localStorage.

### 9.4 Search / filters

MVP filters:

- text search title/summary,
- status,
- priority,
- type task/note/owner,
- owner entity,
- show/hide done.

Filtering should not refetch for every keystroke unless server-side caps require it. Client-side filter over current 1000-node payload is acceptable.

## 10. Security / privacy

- Keep device-scoped queries on every source table.
- Do not expose `deviceSecret`, bot secrets, private notes, or raw chat content in node metadata.
- For botSecret entity scope, default to entity-relevant cards/notes plus immediate neighbors, not full device graph.
- Strip or excerpt descriptions/content server-side before sending; full card/note detail remains behind existing detail APIs.
- Avoid HTML injection in labels/tooltips; render text via Canvas or sanitized tooltip components.

## 11. Rollout plan

1. **Spec PR (`feat/mindmap-spec`)**
   - This document only.
2. **Backend projection PR**
   - Add `/api/mindmap/graph`.
   - Unit tests for mapping and caps.
3. **Frontend prototype PR**
   - New `mindmap.html`, dev-only or feature-flagged.
   - 100/200 small graph E2E.
4. **Performance hardening PR**
   - 1000/2000 perf test, WebView checks.
5. **Mission integration PR**
   - Add nav/link/embed from `mission.html` after #2 approves UX.
6. **Follow-up schema/UI cards**
   - See section 12.

## 12. Proposed dependency /補強 cards

Do not create these until Mac_ClaudeAce approves.

### 12.1 `[Infra] Kanban card tag system — tag schema + UI + graph filters`

Reason:

- Tags become high-value clustering hubs in the force graph.
- Current graph can infer subsystems by title regex, but tags would be explicit and user-editable.

Scope:

- New `kanban_tags` / `kanban_card_tags` or JSONB tag column.
- Card detail editor and board filters.
- `/api/mindmap/graph` emits tag nodes/edges.

### 12.2 `[Infra] Kanban explicit card links — related / references / duplicates / causes`

Reason:

- Parent and dependency edges are not enough for a knowledge graph.
- “Reference” edges should not rely on text parsing forever.

Scope:

- New relation table, e.g. `kanban_card_links(device_id, source_card_id, target_card_id, relation_type, created_by, created_at)`.
- Cycle rules only apply to dependency-like edges, not references.
- UI in card detail to add/remove related cards.

### 12.3 `[Infra] Mission note ↔ Kanban card explicit link model`

Reason:

- `mindmap-mirror` already supports anchors, but Mission notes need a clear first-class link/edit UI.
- Graph needs strong `note_on_card` edges.

Scope:

- Persist explicit note anchors in mission note data model or join table.
- Note editor UI to attach to card.
- Backfill from existing `mindmap_node_anchors` where possible.

### 12.4 `[Feature] Mindmap per-user layout persistence — server-side saved graph coordinates`

Reason:

- localStorage satisfies MVP but does not sync across desktop/mobile/WebView.
- Power users may expect saved layouts per device/entity/filter.

Scope:

- New `mindmap_layouts` table keyed by `device_id`, `user_id/entity_id`, `layout_key`.
- `GET/PUT /api/mindmap/layout`.
- Merge local layout with server layout and handle stale node ids.

### 12.5 `[Feature] Mindmap note deep-link support in mission.html`

Reason:

- Task nodes can navigate to `kanban.html?card=...`.
- Note nodes need equivalent deep-link behavior to make graph navigation symmetrical.

Scope:

- `mission.html?note=<noteId>` opens/selects note.
- Fallback if note missing/archived.

### 12.6 `[Perf] Mindmap large-graph benchmark harness — 1000 nodes / 2000 edges WebView gate`

Reason:

- The 30fps requirement needs a repeatable gate.
- Manual screenshots do not catch animation frame regressions.

Scope:

- Synthetic graph fixture.
- Browser perf script measuring FPS after warmup.
- Desktop Chrome + Android WebView/emulator target.

## 13. Acceptance criteria for implementation cards

Backend projection:

- `GET /api/mindmap/graph` returns `{success, graph:{nodes,links}, stats, meta}`.
- Cards, notes, parent edges, dependency/block edges, owner edges are present.
- DeviceSecret and botSecret scopes behave differently and safely.
- Caps/truncation are deterministic and reported.
- Unit tests cover node mapping, edge mapping, caps, and auth scope.

Frontend integration:

- 360 / 412 / 768 / desktop viewports work without overflow.
- Hover/tap preview works.
- Task click navigates to Kanban card.
- Drag layout persists to per-entity localStorage and survives reload.
- 1000/2000 graph hits performance target.
- Existing Mission/Kanban pages are not regressed.

## 14. Open decisions for Mac_ClaudeAce

1. New standalone `mindmap.html` first, or embed inside `mission.html` behind a feature flag?
   - Mac_F recommendation: standalone first.
2. CDN prototype allowed, or must prebundle from day one?
   - Mac_F recommendation: CDN OK for local prototype; production PR should prebundle/static-ship.
3. Entity botSecret scope should show only assigned/created nodes, or broader graph with neighbors?
   - Mac_F recommendation: assigned/created + immediate neighbors.
4. Should layout persistence remain localStorage-only for MVP?
   - Mac_F recommendation: yes; server layout is follow-up card.
5. Should existing `/api/mission/mindmap` eventually be deprecated?
   - Mac_F recommendation: yes, after force-graph page has production E2E and `mission.html` has a clear replacement path.
