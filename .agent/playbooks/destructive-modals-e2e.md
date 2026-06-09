# Destructive-Modals Daily E2E Playbook

> Card: `card_bee3cf4cf6f134dc06d9df0a` (close-out from PR #2951 modal-clipped fix)
> Acceptance: destructive modal (delete-note / delete-card / unbind etc.) shows fully inside the viewport on mobile (390x844) and desktop (1280x800) across mission / kanban / settings, no console-error regression introduced by the modal flow itself.

## Why this exists
PR #2951 fixed a single mobile clipping case where the delete-modal's right edge fell outside the 390-wide viewport. That fix lives in the shared `showConfirm()` modal in `backend/public/portal/shared/api.js` — used by **every** destructive flow in the portal. Without a recurring guard, the next CSS regression on `.eclaw-confirm-dialog` ships unnoticed. This playbook is the recurring guard.

## What it does NOT do
- It does **not** click the destructive button. No real notes/cards/bindings are deleted.
- It does **not** rely on test data existing. It triggers the shared `showConfirm()` directly via `evaluate(...)` so the test is deterministic regardless of BROADCAST_TEST_DEVICE state.
- It exercises the **production** modal code path, production CSS, production i18n message strings.

## Run target (per memory `reference_prod_e2e_creds.md`)
- deviceId: `${PROD_E2E_DEVICE_ID}` — the BROADCAST_TEST_DEVICE id. **Do not commit the literal value to this file.** Read from `backend/.env` (`BROADCAST_TEST_DEVICE_ID`) or vault (`PROD_E2E_DEVICE_ID`) at run time.
- deviceSecret: `${PROD_E2E_DEVICE_SECRET}` — the matching deviceSecret. Same rule: read from `backend/.env` (`BROADCAST_TEST_DEVICE_SECRET`) or vault (`PROD_E2E_DEVICE_SECRET`). Never paste the literal into source-controlled docs, PR descriptions, or kanban comments.
- Origin: `https://eclawbot.com`
- URL-param auth path (auth.js line 48): append `?deviceId=...&deviceSecret=...` to portal URLs (values supplied at run time from the env/vault references above; the URL itself is constructed locally and never logged with the literal secret).
- Refer to the canonical memory entry `reference_prod_e2e_creds.md` for the actual values — that memory is local-only and is the single source of truth.

## Pages × viewports under test
| Page | URL (suffix to https://eclawbot.com) | Mobile 390x844 | Desktop 1280x800 |
|---|---|---|---|
| Mission | `/portal/mission.html?...` | ✓ | ✓ |
| Kanban  | `/portal/kanban.html?...`  | ✓ | ✓ |
| Settings | `/portal/settings.html?...` | ✓ | ✓ |

Six (page × viewport) combinations.

## Procedure — for the assigned U## (dispatched via cron)

You are the destructive-modals daily E2E U##. Commander is channel-Claude (#2 LOBSTER). All tool drives go through Playwright MCP from this same Claude Code session (no `claude -p`).

### Step 0 — preflight
Verify model:
```
/model
# must report claude-opus-4-7 (per memory feedback_bridge_unit_opus47_required)
```

### Step 1 — loop pages × viewports

For each of the six combinations:

```text
viewports = [(390, 844, "mobile"), (1280, 800, "desktop")]
pages     = ["mission.html", "kanban.html", "settings.html"]
```

For each combo:

1. Resize Playwright window: `browser_resize({width, height})`
2. Navigate: `browser_navigate("https://eclawbot.com/portal/<page>?deviceId=${PROD_E2E_DEVICE_ID}&deviceSecret=${PROD_E2E_DEVICE_SECRET}")` — construct the URL locally by interpolating the env/vault values from the Run target section. The literal URL with secrets must never appear in screenshots, logs, comments, or this file.
3. Wait for the page to settle (~1.5 s — page-specific scripts often load i18n async).
4. **Snapshot baseline console errors** (count + messages) — call `browser_console_messages({level:"error", all:true})` and remember the count `errorsBefore`.
5. Trigger the modal via `browser_evaluate` — DO NOT navigate the page to do this, just call the shared helper directly:

   ```js
   () => {
     return showConfirm({
       title: 'E2E: destructive modal viewport check',
       message: 'Are you sure you want to delete this?',
       danger: true
     }).then(() => {
       // resolved with false from auto-dismiss below; ignore
     });
   }
   ```

   The earlier version of this snippet read `i18n?.t?.('confirm_delete') || '...fallback...'`. Don't restore that: the generic key `confirm_delete` is not registered in `TRANSLATIONS[*]`, so `i18n.t()` returns the literal string `'confirm_delete'` — a truthy value — and the `||` fallback never fires. Real consumers use namespaced keys (`mc_confirm_delete`, `env_confirm_delete`, `sched_confirm_delete`) which DO resolve. For the E2E probe a hard-coded English literal is the right choice; what matters is exercising the modal at the production viewport, not the message content. Spec source: child of card_06a75d056fd5a98c3b4e95d0.

   `showConfirm` is a global in `api.js` (sibling to `apiCall`). It returns a Promise that resolves when Cancel/OK is clicked or Esc pressed.

6. Assert the modal is in-viewport. Do **not** click any button yet:

   ```js
   () => {
     const overlay = document.querySelector('.eclaw-confirm-overlay');
     const dialog  = overlay?.querySelector('.eclaw-confirm-dialog');
     const cancel  = overlay?.querySelector('.eclaw-confirm-cancel');
     const ok      = overlay?.querySelector('.eclaw-confirm-ok');
     if (!overlay || !dialog || !cancel || !ok) {
       return { ok:false, reason:'modal not rendered' };
     }
     const vw = window.innerWidth, vh = window.innerHeight;
     const inViewport = (r) => r.left >= 0 && r.top >= 0 && r.right <= vw && r.bottom <= vh;
     const dr = dialog.getBoundingClientRect();
     const cr = cancel.getBoundingClientRect();
     const okr = ok.getBoundingClientRect();
     return {
       ok: inViewport(dr) && inViewport(cr) && inViewport(okr),
       dialog: {l:dr.left, t:dr.top, r:dr.right, b:dr.bottom, w:dr.width, h:dr.height},
       cancel: {l:cr.left, t:cr.top, r:cr.right, b:cr.bottom, inViewport: inViewport(cr)},
       ok_button: {l:okr.left, t:okr.top, r:okr.right, b:okr.bottom, inViewport: inViewport(okr), hasDangerClass: ok.classList.contains('btn-danger')},
       viewport: {w:vw, h:vh}
     };
   }
   ```

   PASS = `.ok === true` AND `ok_button.hasDangerClass === true`.

7. Screenshot: `browser_take_screenshot({type:"png", filename:"destructive-modal-<page>-<mobile|desktop>-<WxH>.png"})`.
8. Dismiss the modal (no destructive action): `browser_press_key({key:"Escape"})`.
9. **Snapshot post-modal console errors** count. `errorsAfter - errorsBefore === 0` ⇒ PASS for "console errors == 0 from modal flow".

### Step 2 — report
Once all 6 combos pass, reply to commander (`reply` tool):

```
PASS — destructive-modals E2E
PR <#>, 6/6 viewport×page combos
mission/kanban/settings × {390x844 mobile, 1280x800 desktop}
no console-error delta from modal flow
fileId: <upload via /api/files, attach to card via /file>
```

If ANY combo fails:

```
FAIL — destructive-modals E2E
combo: <page>/<viewport>
reason: <dialog right=420 > vw=390> (or "danger class missing", or "console error delta=2")
screenshot: <local path>
```

Do **not** /move card to done on FAIL — file a child card describing the regression instead.

## Acceptance for closing the daily run
- 6/6 combos PASS
- 6 screenshots uploaded to `/api/files` with `mimeType:"image/png"` (per memory `reference_kanban_file_mimetype_gate.md`)
- Comment on the daily-run card with the 6 fileIds (or zip them into 1 via `tar` + image-only attach if the kanban file gate gets noisy)
- `/move newStatus:done` on the daily-run card

## Important rails
- This drive uses Playwright MCP from a Claude Code session — **NOT** `claude -p` (per memory `feedback_never_dash_p.md` + `feedback_e2e_computer_mcp.md`).
- Screenshots saved to project root in claude-code-eclaw-channel (Playwright MCP filename sandbox); copied/attached after the run.
- **Console errors == 0** means *zero delta from modal flow*, not zero global. Pre-existing 401 on `/api/wallet/balance` from URL-param auth fallback is baseline noise — measure delta.
- Use `browser_resize` BEFORE `browser_navigate` so the page lays out at the target viewport from first paint.
- If the page fails to render `showConfirm` (e.g. `api.js` not loaded yet), wait 2s and retry once before failing the combo.

## Evidence archive
Initial reference run (2026-05-26) lives at `backend/public/portal/assets/e2e-evidence/destructive-modal-{page}-{viewport}-{WxH}.png`. Daily runs append timestamped subdirs or upload-only to `/api/files`.

## Companion regression checks (entity-status panel flows)

Each daily run, also exercise these three entity-status-panel behaviors shipped in PRs #3259–#3263. They are NOT destructive modals but were broken at the same surface; bundling here keeps coverage tight.

| # | Flow | Pass criterion |
|---|------|----------------|
| 1 | Operation-log row Quote button (📌) → click | Reply-bar banner lights with title:excerpt; messageInput.value === '' (no `card_xxx` token paste). Per memory `feedback_e2e_visual_change_is_the_bar`. |
| 2 | Entity "傳送給" row checkbox → click | No entity-status panel opens. Only the checkbox toggles. Source: `entity-utils.js attachAvatarClickHandler` skip on `input[type=checkbox]`. |
| 3 | Operation-log card chip → click | AutolinkChipPreview popover opens with `src://kanban/card/<bare_hex>` (title/status/priority/assigned/留言/created/updated/desc preview + 在看板中開啟 button). |

Run flow: navigate `/portal/chat.html`, open entity-status panel (avatar click → drawer), perform each action above, screenshot. Mobile 390x844 + desktop 1280x800. If any fails → file child card under the parent kanban card for that PR; do not silently skip.
