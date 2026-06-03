# Spec: A · hover-click DOM interaction — IDE toolbar + import + diff→Quote→Agent loop

**Status:** Draft — awaiting #1 + #6 sign-off on §2 / §4 / §6
**Cards:** `card_6df1925b065a175b58f5ea38` (Spec/P1) → `card_3ea95119635be91b5ad0a18f` (Impl/P1) → `card_af967715a0ab1724da98dcc2` (Test/P2)
**Driver:** Hank web_chat 2026-06-03 14:43 TW —「交互開法走 A · 悬停点击 (DOM) 的路線繼續」
**Author:** #2 (LOBSTER)

---

## 1. Problem statement

EClaw users today have no in-app way to point at a piece of UI ("this button is wrong colour", "move this card 12px left", "make this form field wider") and turn that pointing-act into a concrete change request that an Agent can implement. The two existing paths both lose information:

- **Screenshot + verbal description** → Agent has to re-discover which DOM element / source file the user meant. Round trips on every ambiguity.
- **File a card with text only** → user types coordinates and CSS values by hand; high friction, low precision, no preview.

The platform needs an interaction model where the user's pointing act IS the request — selection, style edit, and structural change all captured as a machine-readable diff that lands directly in chat for the Agent to implement.

### 1.1 Why "A · hover-click (DOM)" specifically

The team triaged four candidate interaction models for in-app element editing (`A · 悬停点击 DOM` / `B · 框選矩形 / C · 語音指 / D · 拖移指示器`). Hank picked **A** on 2026-06-03 — hover gives instant feedback ("this is what I'm about to grab"), click commits, and operating on the DOM means the diff comes out as source-level, not pixel-level, change. Source-level diff is the precondition for the chat-Quote → Agent loop in §7.

### 1.2 Adjacent precedents in the codebase

- `PR #3088` (safe-default-focus on destructive confirm dialogs) — toolbar dismiss flow and focus management reuses this primitive (§3).
- `PR #3105` spec (chat-page-filter-bar-collapse, merged 2026-06-03) — summary-chip + popover panel pattern; mobile sheet vs desktop popover defined there is reused for the floating toolbar in §3.
- `chatAnchorMessageId` / `chatAnchorCoord` on the card schema — already wired; the diff Quote payload (§7) anchors onto this existing field.

---

## 2. Hover-click interaction model

### 2.1 States

```
  idle ──hover──> hover-preview ──click──> selected (toolbar visible)
   ▲                  │                      │
   │                  └───leave───┐          │
   └──Esc / click-outside─────────┴──Esc / click-outside──┘
```

- **idle** — no selection, no preview ring. Normal page interaction.
- **hover-preview** — pointer is over an importable element; a 2px outlined focus ring renders around the element's bounding box, plus a chip in the top-right corner showing the element's tag + class (e.g. `button.btn-primary`).
- **selected** — click commits the preview. Ring becomes solid; toolbar (§3) anchors to the element. While selected, hover on a DIFFERENT element shows preview ring on that one without losing the primary selection.

### 2.2 Dismiss

- `Esc` — clears selection, dismisses toolbar, returns focus to the underlying page element (per PR #3088 safe-default pattern).
- Click outside the toolbar AND outside the selected element — same as Esc.
- Click another selectable element — atomic re-select (no dismiss-and-reselect flicker).

### 2.3 Keyboard navigation

- `Tab` from a selected element cycles to sibling selectable elements (DOM order).
- `Shift+Tab` cycles backward.
- `Enter` while a chip is focused triggers that chip's action.
- `aria-live="polite"` announces every selection commit + chip activation for screen readers.

### 2.4 Touch / mobile

- Long-press (≥500ms) replaces hover-preview (no hover state on touch). Releases into selected.
- `aria-live` announce on long-press hit, mirroring desktop hover-preview.

### 2.5 Selectable element predicate

An element is selectable iff:
- It is inside the importable scene (§4); AND
- It is visible (`offsetWidth > 0 && offsetHeight > 0 && getComputedStyle.visibility !== "hidden"`); AND
- It is not in the toolbar's own DOM subtree (avoid selecting the chip you're about to click).

Container elements (`div`, `section`, `main`) are selectable — needed for "move this whole card" cases. Picking the smallest matching element is the default; `Alt+Click` (or `Option+Tap` long-press on touch) walks up the ancestor chain by one level per repeated click.

---

## 3. IDE-style toolbar

### 3.1 Layout

```
  Desktop (1280×800)                Mobile (390×844)
  ┌────────────────────────────┐    ╔══════════════════════════╗
  │ ⇕ ↔ 🎨 ⧉ 🗑 🔍 ⓘ  [✕] │   │   ╠══════════════════════════╣
  └────────────────────────────┘    │   │ ⇕  Move                 │
   anchored under element             │   │ ↔  Resize               │
   max-width 480px                    │   │ 🎨 Style                │
                                      │   │ ⧉  Duplicate            │
                                      │   │ 🗑  Delete              │
                                      │   │ 🔍 Inspect              │
                                      │   │ ⓘ  Element info         │
                                      │   │ ──────────              │
                                      │   │           [Close]       │
                                      │   ╚══════════════════════════╝
                                       bottom sheet, slides up
                                       covers ~50% viewport
```

- Same primitive shape as PR #3105's filter-summary panel: dropdown popover on desktop, bottom-sheet on mobile.
- Action chips, in canonical order:
  - **⇕ Move** — drag-to-position. While active, pointer becomes move cursor; drop commits a position delta.
  - **↔ Resize** — show 8 resize handles on the element. Drag any to resize; aspect ratio held with `Shift`.
  - **🎨 Style** — opens a sub-panel with colour / font / spacing / border controls (re-uses existing `.filter-chip` styling primitives).
  - **⧉ Duplicate** — clones the element as a sibling immediately after; cloned element auto-selects so the user can drag it.
  - **🗑 Delete** — removes the element. Confirmed via inline ghost ("Undo" chip appears for 3s before commit becomes irreversible).
  - **🔍 Inspect** — opens a side panel with the element's resolved CSS + source location (file:line).
  - **ⓘ Element info** — non-interactive readout: tag, class, computed dimensions, parent chain.

### 3.2 Focus management

- On open, the FIRST chip (`Move`) receives focus by default — NOT the close button. This is deliberate: opening the toolbar means the user wants to act, not dismiss.
- Close button is `Tab`-reachable at the end of the chip strip.
- This deviates from PR #3088's destructive-confirm pattern (which focuses the safe-dismiss option). Rationale: the toolbar is NOT destructive; the actions are reversible via Undo.
- **Exception:** the `Delete` chip's confirm modal DOES use PR #3088's pattern — Cancel focused by default.

### 3.3 Anchoring

- Desktop: popover anchored directly below the selected element's bounding box, horizontally centred. If insufficient space below, flips above.
- Mobile: bottom-sheet always docks at the bottom, slides up from the bottom edge.
- z-index layer: same as `.dialog-overlay` used by `showConfirm` (per PR #3088 / #3105 conventions).
- Reduced-motion: no slide animation when `prefers-reduced-motion: reduce`.

---

## 4. Content import — v1 support matrix

The "源頭即真實" principle: every supported import surface MUST expose a serializable tree of elements that can be both (a) hover-clicked by the user, and (b) modified via a source-level diff. Pixel-only surfaces are not supported.

| Surface                               | Tree source                         | Diff emit format          | v1?   |
| ---                                   | ---                                 | ---                       | ---   |
| Web URL (CORS-allowed origin)         | iframe DOM                          | unified diff (HTML/CSS)   | ✅ v1 |
| Web URL (cross-origin)                | proxy iframe via our origin         | unified diff (HTML/CSS)   | ✅ v1 |
| EClaw portal page (`portal/*.html`)   | direct DOM (already same origin)    | unified diff (HTML/CSS)   | ✅ v1 |
| EClaw native APP shell                | embedded portal WebView             | unified diff (HTML/CSS)   | ✅ v1 |
| iOS / Android Accessibility tree      | AX tree → virtual DOM adapter       | semantic patch JSON only  | ⏳ v2 |
| Third-party native binary (no source) | —                                   | —                         | ❌ out of scope |
| Raster screenshot / image             | —                                   | —                         | ❌ out of scope |

### 4.1 v1 import dispatcher

`backend/public/shared/content-import.js` exposes:

```js
async function importContent(spec) {
  // spec is one of:
  //   { kind: "url", url: "https://..." }
  //   { kind: "portal", path: "/portal/chat.html" }
  // returns { rootEl, sourceMap, dispose }
}
```

- `rootEl` — the live DOM root the user can hover-click on.
- `sourceMap` — bidirectional map: DOM node ↔ source location (file path + line range, or DOM-path for synthetic content).
- `dispose` — tear down iframe, listeners, etc.

The Accessibility-tree adapter is stubbed in v1 with `kind: "ax"` returning a `not-supported-v1` error; the stub exists only so v2 doesn't require an API refactor.

### 4.2 Cross-origin handling

CORS-blocked URLs are proxied through our own origin via a thin server fetch (`/api/import/proxy?url=...`) that strips `X-Frame-Options` / `frame-ancestors` headers and rewrites relative URLs. **Out of scope:** auth-required pages, single-page apps that rely on `postMessage` to a specific origin, paywalled content.

The proxy is read-only (GET only); user-supplied URLs are validated against an allowlist of public hosts. Internal IPs, file://, localhost are blocked at the server.

### 4.3 The "一勞永逸" promise

The v1 surfaces above cover:
- Every web page (URL).
- Every EClaw-owned UI (portal + WebView).
- iOS / Android via the AX-tree path in v2.

What is NOT covered, by design:
- Third-party native APPs we don't own and that don't expose source. There is no honest universal answer here without source access; pretending otherwise would ship a feature that fails silently on the most interesting cases. The spec is explicit so future maintainers don't carry an open promise.

---

## 5. Editable object semantics

### 5.1 Structure-edit mode (DOM-backed)

Default for everything in the §4 v1 matrix. The imported tree IS the editable scene graph; toolbar mutations call DOM APIs directly:

- Move → `transform: translate(...)` for cheap reposition, committed into `style` on selection-release.
- Resize → `width` / `height` style changes (or `transform: scale` for `Shift`-held aspect-lock).
- Style → standard CSS properties on the element's `style` attribute (highest specificity, predictable diff).
- Duplicate → `node.cloneNode(true)` inserted as `nextSibling`.
- Delete → `node.remove()`, with Undo via stashed reference.

All mutations write to a sidecar mutation log (`MutationObserver`-backed) which is the source for the diff format (§6).

### 5.2 Canvas-collage mode (out of v1 default)

Stub-only for v1: imported non-tree assets (PDFs, raster images) get a `fabric.js` canvas layer with draggable / styleable objects. Output is canvas-state JSON, not a source diff. The Agent receives JSON describing the collage; **no automatic source-code change is produced**.

v1 ships the dispatcher hook but no UI affordance to switch to canvas-collage mode. v2 surfaces a mode toggle when an import is non-tree.

---

## 6. Diff format

Every selection-release produces TWO artifacts that travel together:

### 6.1 Unified diff (Agent-consumable)

Standard `diff -u` format, file path is the source location from `sourceMap` (§4.1). Example for a `style.color` change:

```diff
--- a/portal/chat.html
+++ b/portal/chat.html
@@ -42,7 +42,7 @@
   <button id="filterToggle"
-          class="btn btn-primary"
+          class="btn btn-primary"
           style="color: rebeccapurple;"
           data-i18n="filter.toggle">
```

- Multi-element mutations produce one diff per affected source file, concatenated.
- Synthetic content with no source file gets a virtual path (`<synthetic:user-edit-${timestamp}>`).
- Whitespace + reformatting kept to a minimum so the human-readable patch is the same shape the Agent will write.

### 6.2 Semantic patch JSON (UI display)

Compact JSON shape:

```json
{
  "patchId": "p_2026060306500001",
  "createdAt": 1780469000000,
  "sourceContext": {
    "kind": "url",
    "url": "https://eclawbot.com/portal/chat.html",
    "viewport": { "w": 1280, "h": 800 }
  },
  "changes": [
    {
      "selector": "button#filterToggle",
      "property": "style.color",
      "from": null,
      "to": "rebeccapurple"
    },
    {
      "selector": "div.kb-card[data-id='123']",
      "property": "geometry",
      "from": { "x": 12, "y": 48 },
      "to": { "x": 200, "y": 48 }
    }
  ]
}
```

- The Quote preview renders this as `N elements changed: button#filterToggle (color), div.kb-card (position)`.
- Click expands to show a thumbnail + the unified diff body.
- Both forms travel together; the unified diff is canonical for re-applying, the JSON is canonical for UI display.

### 6.3 Storage on chat

The Quote payload is attached to a chat message via the existing `chatAnchorMessageId` / `chatAnchorCoord` schema on the card. The diff itself is stored in R2 (per `reference_card_evidence_pipeline`), referenced by `fileId` on the message attachments array.

---

## 7. Quote → Agent loop

```
   user selects element
        │
        ▼
   toolbar mutation
        │
        ▼
   selection-release
        │
        ▼
   diff produced (unified + JSON)
        │
        ▼
   chat Quote preview chip
        │
        ▼   (user reviews, hits "Send to Agent")
        ▼
   /api/transform with senderHint targeting the implementer entity
        │
        ▼
   receiving Agent reads diff + sourceContext + acceptance
        │
        ▼
   implementation PR opens, anchored back to originating card
```

### 7.1 Quote preview shape

In the chat composer, the Quote chip shows:
- Source URL / portal page name.
- "N elements changed" summary.
- Tiny thumbnail (before / after, side-by-side) if viewport screenshot can be captured client-side.
- Inline "Edit diff" — round-trip back into the toolbar to refine before sending.

### 7.2 Routing to the implementer

The user picks WHICH entity should pick up the implementation (default: the entity currently bound to that page's repo). Routing reuses `/api/transform` `speakTo` per the EClaw routing policy.

### 7.3 Audit trail

Every diff Quote creates a comment on the originating card with `Quoted to chat: <messageId>`. The receiving Agent's implementation PR cites the diff Quote messageId in its PR body, completing the audit loop.

---

## 8. Acceptance

### 8.1 UX

- [ ] Hover any DOM element shows preview ring within 50ms; no jank on hover-storm (rapid pointer movement).
- [ ] Click commits selection; toolbar appears within 100ms; first chip auto-focuses.
- [ ] Esc / outside click dismisses; focus restored to the underlying element.
- [ ] Mobile long-press triggers selection with `aria-live` announcement; bottom-sheet slides up.
- [ ] All 7 chips behave per §3.1 spec on web + mobile viewports.
- [ ] Diff Quote chip renders in chat composer; click-to-expand shows unified diff.

### 8.2 Visual

- [ ] Desktop 1280×800 + Mobile 390×844 screenshots in implementation PR (per `requiresScreenshotReview` gate on the impl card).
- [ ] Dark-mode contrast verified for ring + toolbar + chips.
- [ ] Reduced-motion respected (no slide-up on bottom-sheet, instant render).

### 8.3 i18n

All locales (zh-TW, zh, en, ja, ko, es, pt, fr, de, it, vi, th, id) get real translations — NO English passthrough. Keys (in `backend/public/shared/i18n.js`):

- `hover_click.toolbar_label` — "Element actions" / "元素操作"
- `hover_click.chip_move`, `chip_resize`, `chip_style`, `chip_duplicate`, `chip_delete`, `chip_inspect`, `chip_info`
- `hover_click.chip_close_aria`
- `hover_click.element_info_template` — "{{tag}}.{{className}}" with locale-appropriate punctuation
- `hover_click.delete_confirm_title`, `delete_confirm_body`, `delete_confirm_cancel`, `delete_confirm_proceed`
- `hover_click.import_dialog_title`
- `hover_click.import_dialog_url_label` — "Web page URL"
- `hover_click.import_unsupported_ax_v1` — "Native APP element selection arriving in v2."
- `hover_click.diff_quote_chip_template` — "{{n}} elements changed: {{summary}}"
- `hover_click.send_to_agent_button`

### 8.4 Tests

Covered in detail in the linked-next test card (`card_af967715a0ab1724da98dcc2`). Acceptance here:

- [ ] Playwright E2E green for web + mobile viewports.
- [ ] jest invariant tests for diff format (unified + JSON shape).
- [ ] Visual regression baselines committed.
- [ ] No regression on existing browser MCP automation against `portal/*`.

---

## 9. Non-goals (v1)

- **Real-time collaborative editing** — single-user only in v1. v2 may add OT / CRDT.
- **Beyond browser-native Undo / Redo** — Ctrl-Z is intentionally NOT instrumented. Mutation log can be replayed but no in-app undo stack v1.
- **Cross-frame selection** — selecting elements in nested iframes within the imported iframe (rare in practice; punt).
- **Animation editing** — toolbar doesn't expose keyframe / timeline controls.
- **Component-aware editing** — if the source uses React / Vue / SvelteKit components, diff is still HTML-level (we don't try to round-trip back to JSX). The Agent on the receiving end may translate; we don't pre-process.
- **Auth-required imports** — pages behind login can't be imported in v1.

---

## 10. Open questions for #1 / #6 review

1. **Toolbar focus default (§3.2):** first chip vs close button — I lean first chip, breaks PR #3088 precedent but matches Figma / VS Code muscle memory. Reviewer call.
2. **Container vs leaf selection (§2.5):** default to smallest containing element with `Alt+Click` to walk up — vs default to a smarter heuristic (e.g. nearest `data-component-id`). Smarter heuristic is harder to spec but better UX.
3. **CORS proxy allowlist (§4.2):** open public-host allowlist vs allow-by-default-deny-on-allowlist-miss. Open-allowlist is safer but more friction; revisit after first prod usage data.
4. **Synthetic-content source file path (§6.1):** `<synthetic:user-edit-${timestamp}>` placeholder vs forcing the user to attach a real target file. Placeholder is friendlier; reviewer call on whether the Agent can handle synthetic paths gracefully.
5. **Delete inline Undo timer (§3.1):** 3s ghost-then-commit vs immediate commit with toast-Undo. The ghost approach is slower but harder to misclick.
6. **Mobile chip order (§3.1):** vertical list vs horizontal scroll. Vertical is friendlier for thumb reach; horizontal saves vertical space. Lean vertical.
7. **Accessibility-tree v2 timing:** ship hover-click v1 first then layer AX in v2 (current plan), vs spec both surfaces in v1 and ship them together. Lean v1-first; AX is hard.

---

## 11. Rollback

The entire feature is gated behind `ECLAW_HOVER_CLICK_DOM_ENABLED` env flag (default false in v1). Reverting the integration commit removes the entry-point button from `portal/` and disposes the toolbar / dom-select primitives. Imported content sources are not modified by the feature (the diff is the OUTPUT, not a side effect on the source). No DB migration, no backend schema changes.

---

## 12. References

- Spec card `card_6df1925b065a175b58f5ea38` (Spec/P1), Impl card `card_3ea95119635be91b5ad0a18f` (Impl/P1), Test card `card_af967715a0ab1724da98dcc2` (Test/P2).
- PR #3088 (`fix(portal): safe-default-focus on destructive confirm dialogs`) — focus management primitive for the Delete confirm subflow.
- PR #3105 (`docs(specs): chat-page-filter-bar-collapse` — merged 2026-06-03) — mobile sheet vs desktop popover pattern reused for the floating toolbar.
- Card schema `chatAnchorMessageId` / `chatAnchorCoord` — diff Quote payload anchor.
- Project memory `feedback_i18n_translate_not_passthrough` — locale handling expectations.
- Project memory `feedback_rendering_cards_screenshot_review` — `requiresScreenshotReview=true` on impl card.
- Project memory `feedback_spec_first` — this PR cites spec section in its body.
- Project memory `feedback_link_card_full_e2e_required` — linked-card E2E gate covered in the linked test card.
