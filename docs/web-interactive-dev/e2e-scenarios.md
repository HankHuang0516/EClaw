# web-interactive-dev — v1 E2E Scenarios

> Five happy-path scenarios. **All scenarios are browser-only.** No network calls, no auth, no EClaw integration. Each scenario is testable against the static-site build via Playwright or Cypress; manual repro steps are listed for review.

Pre-state common to every scenario:
- Build target is hosted on `http://localhost:5173/` (or `file://`).
- The user opens the page. No prior session in `localStorage`.
- A test fixture HTML is pasted into the **Source** tab. The fixture is committed under `tests/fixtures/landing.html` and is plain semantic HTML (one `<header>`, one `<main>` with a hero `<section>`, one `<a id="buy">` button, two `<article class="card">` blocks).

---

## Scenario 1 — Edit hero headline text (single edit)

**User intent**: Translate the H1 from English to zh-TW.

**Steps**:
1. Press `P` to arm pointing. Pointer becomes a crosshair.
2. Hover over the H1; the 2-px outline + tag chip (`<h1>`) appears.
3. Click the H1. The right panel opens on the **Text** tab pre-filled with `"Welcome to MyApp"`.
4. Change the value to `"歡迎光臨 MyApp"`. Press `⌘/Ctrl+Enter`.
5. The edits list shows one row: `▸ h1 → "歡迎光臨 MyApp"`.
6. Click **Export Prompt**. The Prompt view renders.
7. Click the **⧉ Copy** icon.

**Expected**:
- The clipboard contains a string whose `## edit_01 — text` block contains exactly:
  - `before.textContent: "Welcome to MyApp"`
  - `after.textContent:  "歡迎光臨 MyApp"`
- The raw JSON block at the bottom of the prompt validates against `docs/api-contract.json`.
- The preview pane still shows the ORIGINAL text (`"Welcome to MyApp"`). v1 does not mutate the preview — only the diff envelope.

---

## Scenario 2 — Change a button background color (style edit, allowlisted property)

**User intent**: Recolor the primary CTA from blue to red.

**Steps**:
1. Press `P`, click `button.cta`.
2. Switch to the **Style** tab. The current `background-color` shows as `#1a73e8` (computed from the inline / linked stylesheet).
3. Edit it to `#d63b3b`. Press Save.
4. The edits list now has one row: `▸ .cta → background-color #d63b3b`.
5. Click **Export Prompt**.

**Expected**:
- The diff envelope's `edits[0]` has `kind:"style"`, `before.style["background-color"]:"#1a73e8"`, `after.style["background-color"]:"#d63b3b"`.
- The `customCss` field is absent (we only used the allowlisted property).
- Prompt body shows the before/after style blocks formatted as JSON, not as raw CSS.

---

## Scenario 3 — Change an anchor `href` (attribute edit)

**User intent**: Add a UTM parameter to the buy link.

**Steps**:
1. Press `P`, click `a#buy`.
2. Switch to **Attribute** tab. Existing attributes are listed; `href = /checkout?v=1`.
3. Edit `href` to `/checkout?v=2&utm=hero`. Save.

**Expected**:
- One row in the edits list: `▸ a#buy → href=/checkout?v=2&utm=hero`.
- The diff envelope's edit has `kind:"attribute"`, `before.attributes.href:"/checkout?v=1"`, `after.attributes.href:"/checkout?v=2&utm=hero"`.
- `confidence` on the target is ≥ 0.95 (because `#buy` is an id).

---

## Scenario 4 — Multi-edit batch + reorder + export (three edits in one session)

**User intent**: Combine Scenarios 1, 2, 3 into a single prompt and export them as one batch, with edits reordered.

**Steps**:
1. Perform Scenario 1, 2, 3 in that order, but DO NOT export between them.
2. The edits list shows three rows in chronological order.
3. Drag edit #3 (the `href` change) above edit #1. New order: `href`, `text`, `style`.
4. Click **Export Prompt**.

**Expected**:
- The exported `DiffEnvelope` has `edits: [attribute, text, style]` — in the dragged order, NOT chronological.
- The prompt body's `## edit_01`, `## edit_02`, `## edit_03` headings reflect that same order.
- The session ID (`session.id`) is identical for all three edits in the envelope.
- The diff envelope still passes the JSON Schema after reorder.

---

## Scenario 5 — Discard an edit before export

**User intent**: User makes three edits, decides the style change was wrong, drops it, then exports the remaining two.

**Steps**:
1. Perform Scenario 1, 2, 3 in order.
2. Hover over the **style** row in the edits list. Click the trash-can icon (or swipe-left on mobile).
3. A confirm chip appears (`Remove this edit? · Undo`). Click outside or wait 4s — chip dismisses and the row is gone.
4. The edits list now has two rows: text + attribute (chronological).
5. Click **Export Prompt**.

**Expected**:
- The exported envelope has `edits.length === 2`. No `edit_02` style entry present.
- Edit IDs are not renumbered — the surviving entries keep their original IDs (`edit_01`, `edit_03`).
- The Prompt header line `# Edits requested (N)` reads `(2)`, not `(3)`.

---

## Notes for the test harness (informative — not part of acceptance)

- All five scenarios assert on **the exported envelope** (`session.exportDiff()`) and **the exported prompt string** (`session.exportPrompt()`), not on the preview DOM. The preview iframe is sandboxed and read-only by design in v1.
- `session.id` is generated at `createSession()` time; it must remain stable across edits within one tab session and must change when the user clicks **Reset**.
- A grep-based smoke test runs against the built bundle and asserts that none of `eclaw`, `botSecret`, `device-vars`, `publicCode`, `entityId`, `bridge-auth` appears in any output `.js` / `.css` / `.html` — wired by U96 as part of the standalone repo's CI.
