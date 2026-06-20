# web-interactive-dev — v1 Spec

> Tracker card: `card_ba085c28d403e57a51e8c931`
> Standalone repo (post-merge target): `github.com/HankHuang0516/web-interactive-dev` (created by U96).
> This file lives in the EClaw repo only for the Spec PR review window. U96 copies it verbatim into the standalone repo.

## 0. Platform & Dependency Gate (HARD)

- **v1 = WEB ONLY**. The artifact runs in a modern browser (Chromium ≥ 120, Safari ≥ 17, Firefox ≥ 121). No native iOS/Android wrappers in v1.
- **Build target: static site / SPA** (no server runtime). Output is a folder of `.html` + `.js` + `.css` that can be served by any static host (Pages, Cloudflare Pages, file://, `python -m http.server`). Rationale: the entire diff→prompt pipeline runs client-side; a server adds an attack surface and a deploy dependency without enabling any v1 user need.
- **No EClaw dependency, period.** v1 must not:
  - Import any EClaw npm package, fetch any `eclawbot.com` URL, or read any EClaw-shaped config (`device-vars`, `botSecret`, `entityId`, `publicCode`, channel keys).
  - Embed an EClaw bridge, channel adapter, kanban call, or bot dispatch.
  - Assume a logged-in EClaw identity. v1 is **single local user**: state is `localStorage` + in-memory only.
- **CI gate (must ship with the standalone repo)**: a grep-based test that fails if `eclaw`, `botSecret`, `device-vars`, or `publicCode` appears anywhere under `src/` or `public/`. Wired by U96.

## 1. Problem statement

A developer wants to point at an element on a rendered page (their own HTML, or HTML they pasted in), edit it visually (text / style / attribute), and walk away with a **prompt string** that any LLM Agent (Claude, GPT, etc.) can ingest to reproduce the same edit in source code. v1 does not generate code; it generates *the request for code* in a deterministic, agent-friendly shape.

## 2. UI scope — point-and-edit + side panel

### 2.1 Layout

```
┌───────────────────────────────────────────────┬──────────────────────┐
│                                               │  Edits (3)           │
│            <preview iframe>                   │  ─────────────────── │
│                                               │  ▸ h1 → "新標題"     │
│      [pointer crosshair when armed]           │  ▸ .cta → color:red  │
│                                               │  ▸ a#buy → href=…    │
│                                               │  ─────────────────── │
│                                               │  [ Export Prompt ⧉ ] │
└───────────────────────────────────────────────┴──────────────────────┘
[Source ▸] [Edits ▸] [Prompt ▸]   ← bottom tab strip
```

- **Preview pane (left)**: an `<iframe sandbox="allow-same-origin">` rendering the user's HTML. Pointer overlay highlights the hovered element with a 2px outline + tag chip.
- **Edits pane (right)**: stacked list of pending edits; each row shows target locator + a one-line summary of the change. Click expands inline editors. Drag to reorder, swipe-left to discard.
- **Bottom tab strip**: toggles between three modal views — `Source` (paste/load HTML), `Edits` (the right pane, on mobile), `Prompt` (the rendered output preview before copy).

### 2.2 Interaction states

| State        | Pointer | Click action                                            | Exit |
|--------------|---------|---------------------------------------------------------|------|
| `idle`       | default | no-op                                                   | —    |
| `armed`      | crosshair | element selected → opens edit panel; state → `editing` | Esc → `idle` |
| `editing`    | default | clicks land in panel inputs                             | Save → record edit + back to `idle`; Cancel → drop |
| `prompt-view`| default | read-only render of the prompt string                   | Back → `idle` |

Keyboard: `P` arms / disarms pointing. `⌘/Ctrl+Enter` in any input commits the edit. `⌘/Ctrl+Shift+P` exports the prompt to clipboard.

### 2.3 Editable surfaces (v1)

For a picked element, the side panel exposes exactly three tabs:

1. **Text** — `textContent` (single-line or multiline depending on tagName).
2. **Style** — a curated allowlist: `color`, `background-color`, `font-size`, `font-weight`, `padding`, `margin`, `border-radius`, `display`, `text-align`. Free-form CSS goes through a "Custom CSS" textarea that we treat as opaque string.
3. **Attribute** — `href`, `src`, `alt`, `title`, `class`, `id`, plus a free-form "Add attribute" row (key/value).

Anything outside the allowlist must still be representable via the *Custom CSS* + *Add attribute* escape hatches — the contract never silently drops user intent.

### 2.4 Target locator

A picked element is identified by a locator object (shared with the diff format, §3):

```
{
  "selector":   "main > section.hero > h1",     // css selector relative to <body>
  "selectorKind": "css",                         // "css" | "data-id" | "xpath" (v1 emits "css")
  "fallbackText": "Welcome to MyApp",            // first 80 chars of original textContent, for human readability
  "rect":       { "x": 120, "y": 84, "w": 540, "h": 36 },  // page coords at pick time, for visual reference
  "confidence": 0.85                             // 0..1; bumped to 0.95 if [id] or [data-*] was usable
}
```

`selector` generation follows the same priority order point-edit-demo uses today (data-attr > id > stable class chain > nth-of-type), so the contract is consistent with prior internal practice without depending on it.

## 3. Diff format — JSON (decision + rationale)

**v1 emits a JSON diff envelope, NOT unified diff.** The schema is in `api-contract.json`; the worked example is here.

### 3.1 Why JSON, not unified diff

| Need (v1)                                  | Unified diff      | JSON envelope     |
|--------------------------------------------|-------------------|-------------------|
| Express "change attribute X on element Y"  | hard (line-based) | trivial (typed)   |
| Express style edits that are not in source | impossible        | first-class       |
| Carry locator + confidence + rect          | requires comments | structured field  |
| Filter / merge programmatically            | regex-and-pray    | `Array.filter`    |
| Convert JSON → unified diff downstream     | n/a               | one transform     |
| Convert unified diff → structured JSON     | lossy             | n/a               |

Unified diff assumes the user's edit *is* a textual line change. Most of our v1 edits aren't — they're DOM mutations against a rendered preview where the source may be HTML, JSX, MDX, Vue SFC, or pasted snippet. JSON is the lossless superset; a downstream consumer can synthesise unified diff from it. The reverse is not true.

### 3.2 Shape (informative — schema is normative)

```json
{
  "version": "web-interactive-dev/v1",
  "session": {
    "id": "wid_8b3e5f2a",                                  
    "createdAt": "2026-06-03T13:00:00Z",
    "source": {
      "kind": "html-paste",                                  
      "uriHint": "user-supplied-2026-06-03.html",           
      "byteLength": 18243
    }
  },
  "edits": [
    {
      "id": "edit_01",
      "kind": "text",                                        
      "target": {
        "selector": "main > section.hero > h1",
        "selectorKind": "css",
        "fallbackText": "Welcome to MyApp",
        "rect": {"x":120,"y":84,"w":540,"h":36},
        "confidence": 0.85
      },
      "before": { "textContent": "Welcome to MyApp" },
      "after":  { "textContent": "歡迎光臨 MyApp" },
      "intent": "rewrite hero headline in zh-TW"
    },
    {
      "id": "edit_02",
      "kind": "style",
      "target": { "selector": "button.cta", "selectorKind": "css",
                  "fallbackText": "Buy now", "confidence": 0.92,
                  "rect":{"x":140,"y":420,"w":160,"h":44} },
      "before": { "style": { "background-color": "#1a73e8" } },
      "after":  { "style": { "background-color": "#d63b3b" } }
    },
    {
      "id": "edit_03",
      "kind": "attribute",
      "target": { "selector": "a#buy", "selectorKind": "css",
                  "fallbackText": "Buy →", "confidence": 0.98,
                  "rect":{"x":160,"y":478,"w":120,"h":24} },
      "before": { "attributes": { "href": "/checkout?v=1" } },
      "after":  { "attributes": { "href": "/checkout?v=2&utm=hero" } }
    }
  ]
}
```

### 3.3 Edit `kind` enum (v1)

- `text` — `textContent` mutation only
- `style` — one or more allowlisted CSS properties OR `customCss` opaque string
- `attribute` — one or more `key→value` attribute mutations (incl. add / remove via `null`)
- `replace` — full `outerHTML` replacement (escape hatch when the three above can't express the intent)
- `remove` — element removed (before/after asymmetric: `after` is `null`)

v1 deliberately omits `insert`. Inserting new DOM requires a parent + index contract we don't want to lock in yet; it lands in v2.

## 4. Prompt template (Agent output)

The exporter renders the JSON envelope into a single prompt string. Template is deterministic — same JSON → same string, byte-for-byte (stable key ordering, no timestamps in the body).

### 4.1 Concrete example (continuing §3.2)

````
You are editing a web page based on a designer's point-and-edit session.

# Source
- kind: html-paste
- uriHint: user-supplied-2026-06-03.html
- byteLength: 18243

# Edits requested (3)

## edit_01 — text
- target: main > section.hero > h1   (confidence 0.85)
- visible text was: "Welcome to MyApp"
- before.textContent: "Welcome to MyApp"
- after.textContent:  "歡迎光臨 MyApp"
- intent: rewrite hero headline in zh-TW

## edit_02 — style
- target: button.cta   (confidence 0.92)
- visible text was: "Buy now"
- before.style: { "background-color": "#1a73e8" }
- after.style:  { "background-color": "#d63b3b" }

## edit_03 — attribute
- target: a#buy   (confidence 0.98)
- visible text was: "Buy →"
- before.attributes: { "href": "/checkout?v=1" }
- after.attributes:  { "href": "/checkout?v=2&utm=hero" }

# Instructions to the agent
1. Apply each edit to the canonical source for this page. If the source is HTML, find the element by selector; if the source is a component (JSX / Vue / MDX), locate the equivalent node by the fallbackText + selector hint.
2. Preserve indentation, surrounding markup, and comments. Touch only what an edit demands.
3. If an edit cannot be applied unambiguously (selector ambiguous, fallbackText not found), STOP and report which edits are blocked and why — do not guess.
4. Return the modified source as a unified diff against the file you were given.

# Raw envelope (verbatim, for tools that prefer JSON)
```json
{...the JSON from §3.2...}
```
````

### 4.2 Template invariants

- **Stable ordering**: edits appear in the order they were committed; keys within objects are emitted in schema order, not insertion order.
- **Lossless raw block**: the full JSON envelope is always appended so an Agent that ignores the prose still sees everything.
- **No EClaw vocabulary**: prompt body never mentions `entity`, `bot`, `device-vars`, `publicCode`, or any EClaw term.
- **Locale of the prose**: English. The *user's edits* may be any language; the *instructions to the agent* are English so behavior is portable across LLMs.

## 5. Public API surface

The repo ships a single small library plus the host page. Anyone consuming it programmatically goes through one entry:

```ts
// public surface — exported from src/index.ts
export interface InteractiveDevSession {
  pickElement(opts?: { armOnly?: boolean }): Promise<TargetLocator>;
  recordEdit(edit: PendingEdit): EditId;
  removeEdit(id: EditId): void;
  exportDiff(): DiffEnvelope;          // returns the JSON object in §3.2 shape
  exportPrompt(): string;              // returns the rendered string in §4.1 shape
  reset(): void;
}

export function createSession(source: SourceInput): InteractiveDevSession;
```

Wire form:

- `SourceInput = { kind:'html-paste', html:string, uriHint?:string } | { kind:'html-url', url:string }` (URL form is fetched same-origin only in v1).
- `PendingEdit` is the union of the five edit `kind`s in §3.3.
- `DiffEnvelope` matches `api-contract.json` exactly.

The JSON Schema in `api-contract.json` is the **normative** contract; the TS types above are illustrative. A schema validator (`ajv`) runs on every `exportDiff()` call; a failure throws synchronously and never produces a prompt.

## 6. Out of scope (v1) — explicit

- EClaw kanban / device-vars / entity routing / bridge-auth / publisher.
- Multi-user, login, sync, cloud persistence.
- Mobile native, PWA install, offline service worker.
- Inserting new DOM (`kind:'insert'`) — see §3.3.
- Source-AST-aware edits (parsing JSX/Vue to mutate code, not DOM).
- Round-tripping a *unified diff* INTO the envelope. Outbound only.

## 7. Acceptance criteria for this spec

- **AC-spec-1**: `spec.md`, `api-contract.json`, `e2e-scenarios.md` all present under `docs/web-interactive-dev/`.
- **AC-spec-2**: `api-contract.json` is a valid JSON Schema (`$schema: draft-07`) and validates the §3.2 example.
- **AC-spec-3**: `spec.md` contains a Platform Gate (§0) that names every banned EClaw concept.
- **AC-spec-4**: Three deliverables make zero reference to `eclawbot.com`, `botSecret`, `device-vars`, `publicCode`, `entityId`, `bridge-auth`. (Excluding this PR's metadata and the in-repo review process.)
- **AC-spec-5**: §3 picks **JSON** with a rationale table; §4 ships one fully-rendered concrete prompt example.
- **AC-spec-6**: §5 fits on one screen — single `createSession()` entry, six methods, two shapes.
- **AC-spec-7**: Reviewer #6 (yrt82n) gives an explicit ✅ in PR comments before merge.

## 8. Open questions deferred to v2

- AST-aware source resolution (mapping a DOM target back to a JSX node).
- `insert` edits + parent/index contract.
- Multi-page sessions (navigation while picking).
- A pluggable prompt template (today: one canonical template; future: user-supplied).
- A unified-diff *output* mode for consumers that want it pre-converted.
