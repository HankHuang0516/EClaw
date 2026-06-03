/**
 * hover-click-toolbar.js — IDE-style floating toolbar primitive
 * Spec: docs/specs/a-hover-click-dom-interaction.md §3
 *
 * Anchors to the selected DOM element. Desktop = popover under the bbox,
 * mobile = bottom sheet (per filter-summary primitive convention).
 *
 * Action chips (canonical order): Move / Resize / Style / Duplicate /
 * Delete / Inspect / Info. First chip auto-focuses (per #6 review Q1).
 *
 * Dependencies (loaded by host page):
 *   - shared/i18n.js (window.i18n.t)
 *   - shared/hover-click-toolbar.css
 *   - shared/dom-select.js  (for the selection event source)
 *   - shared/diff-format.js (for the produced diff payload)
 */
(function (root) {
  'use strict';

  let _seq = 0;
  const MOBILE_BP = 720;

  // v1.1 layout (Hank feedback 2026-06-03): Undo/Redo + Quote chips
  // added. `divider:true` entries render a vertical separator. Order
  // groups by purpose: history → transform → structural → inspect → send.
  const CHIP_DEFS = [
    { id: 'undo',      icon: '↶', i18n: 'hover_click.chip_undo',      fallback: 'Undo' },
    { id: 'redo',      icon: '↷', i18n: 'hover_click.chip_redo',      fallback: 'Redo' },
    { divider: true },
    { id: 'move',      icon: '⇕', i18n: 'hover_click.chip_move',      fallback: 'Move' },
    { id: 'resize',    icon: '↔', i18n: 'hover_click.chip_resize',    fallback: 'Resize' },
    { id: 'style',     icon: '\u{1F3A8}', i18n: 'hover_click.chip_style',  fallback: 'Style' },
    { divider: true },
    { id: 'duplicate', icon: '⧉', i18n: 'hover_click.chip_duplicate', fallback: 'Duplicate' },
    { id: 'delete',    icon: '\u{1F5D1}', i18n: 'hover_click.chip_delete', fallback: 'Delete' },
    { divider: true },
    { id: 'inspect',   icon: '\u{1F50D}', i18n: 'hover_click.chip_inspect', fallback: 'Inspect' },
    { id: 'info',      icon: 'ⓘ', i18n: 'hover_click.chip_info',      fallback: 'Info' },
    { divider: true },
    { id: 'quote',     icon: '\u{1F4E4}', i18n: 'hover_click.chip_quote', fallback: 'Quote' },
  ];

  function t(key, fallback) {
    try {
      const v = root.i18n && typeof root.i18n.t === 'function' ? root.i18n.t(key) : null;
      return v && v !== key ? v : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function isMobile() { return window.matchMedia(`(max-width: ${MOBILE_BP}px)`).matches; }

  /**
   * @param {Object} opts
   * @param {(mutation:Object)=>void} opts.onMutation - called for each DOM mutation the toolbar produces.
   * @param {()=>void} [opts.onClose]
   * @returns {{open:Function, close:Function, isOpen:()=>boolean, destroy:Function, getMutations:()=>Array}}
   */
  function createHoverClickToolbar(opts) {
    const id = ++_seq;
    const onMutation = (opts && typeof opts.onMutation === 'function') ? opts.onMutation : null;
    const onClose = (opts && typeof opts.onClose === 'function') ? opts.onClose : null;
    const mutations = [];
    let currentTarget = null;
    let openFlag = false;

    const shell = document.createElement('div');
    shell.className = 'eclaw-hover-click-toolbar';
    shell.id = `eclaw-hover-click-toolbar-${id}`;
    shell.setAttribute('role', 'toolbar');
    shell.setAttribute('aria-label', t('hover_click.toolbar_label', 'Element actions'));
    shell.hidden = true;

    const row = document.createElement('div');
    row.className = 'eclaw-hover-click-toolbar__row';

    // v1.1: target-label readout at the front so the docked toolbar
    // tells the user what they're acting on (was implicit before).
    const labelEl = document.createElement('span');
    labelEl.className = 'eclaw-hover-click-toolbar__target-label';
    row.appendChild(labelEl);

    const chipEls = {};
    let firstChipFocused = false;
    CHIP_DEFS.forEach((def, idx) => {
      if (def.divider) {
        const div = document.createElement('span');
        div.className = 'eclaw-hover-click-toolbar__divider';
        div.setAttribute('aria-hidden', 'true');
        row.appendChild(div);
        return;
      }
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'eclaw-hover-click-toolbar__chip';
      b.setAttribute('data-chip', def.id);
      b.setAttribute('tabindex', firstChipFocused ? '-1' : '0');
      firstChipFocused = true;
      const labelTxt = t(def.i18n, def.fallback);
      b.innerHTML = `<span class="eclaw-hover-click-toolbar__chip-icon" aria-hidden="true">${def.icon}</span><span class="eclaw-hover-click-toolbar__chip-label">${labelTxt}</span>`;
      b.addEventListener('click', () => activateChip(def.id));
      chipEls[def.id] = b;
      row.appendChild(b);
    });

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'eclaw-hover-click-toolbar__close';
    closeBtn.setAttribute('aria-label', t('hover_click.chip_close_aria', 'Close toolbar'));
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', () => close());
    row.appendChild(closeBtn);

    shell.appendChild(row);
    document.body.appendChild(shell);

    // Outside click closes (but not clicks inside the toolbar or on the
    // currently-selected element).
    function onOutsideClick(e) {
      if (!openFlag) return;
      if (shell.contains(e.target)) return;
      if (currentTarget && currentTarget.contains(e.target)) return;
      close();
    }

    // Esc closes; v1.1 also wires Undo/Redo/Delete/Duplicate shortcuts.
    function onKeyDown(e) {
      if (!openFlag) return;
      const meta = e.ctrlKey || e.metaKey;
      // Don't trap shortcuts when the user is typing into an input/textarea.
      const ae = document.activeElement;
      const inEditable = ae && (
        ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable
      );
      if (!inEditable) {
        if (meta && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
          e.preventDefault(); doUndo(); return;
        }
        if ((meta && e.shiftKey && (e.key === 'z' || e.key === 'Z')) ||
            (meta && (e.key === 'y' || e.key === 'Y'))) {
          e.preventDefault(); doRedo(); return;
        }
        if (e.key === 'Delete' || e.key === 'Backspace') {
          if (currentTarget && !shell.contains(document.activeElement)) {
            e.preventDefault(); confirmDelete(); return;
          }
        }
        if (meta && (e.key === 'd' || e.key === 'D') && currentTarget) {
          e.preventDefault(); doDuplicate(); return;
        }
      }
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      else if (e.key === 'Tab') {
        // Tab cycles within the toolbar; default browser behaviour handles
        // the in-toolbar focus, we just need to wrap.
        const focusables = Array.from(shell.querySelectorAll('button:not([disabled])'));
        if (!focusables.length) return;
        const first = focusables[0], last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault(); last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault(); first.focus();
        }
      }
    }

    document.addEventListener('click', onOutsideClick, true);
    document.addEventListener('keydown', onKeyDown, true);

    function describeShort(el) {
      if (!el) return '';
      const tag = el.tagName.toLowerCase();
      const id = el.id ? '#' + el.id : '';
      const cls = el.className && typeof el.className === 'string'
        ? '.' + el.className.trim().split(/\s+/)[0]
        : '';
      return `${tag}${id}${cls}`;
    }

    function anchorTo(el) {
      currentTarget = el;
      // v1.1: docked at top-right of viewport via CSS — no inline
      // top/left needed on desktop. Mobile bottom-sheet still wired
      // through data-visible attribute.
      if (isMobile()) {
        shell.setAttribute('data-visible', 'true');
      }
      labelEl.textContent = describeShort(el);
    }

    function open(el) {
      if (!el) return;
      shell.hidden = false;
      anchorTo(el);
      openFlag = true;
      // First chip focused per #6 review Q1.
      requestAnimationFrame(() => chipEls.move.focus());
    }

    function close() {
      if (!openFlag) return;
      openFlag = false;
      shell.hidden = true;
      shell.removeAttribute('data-visible');
      currentTarget = null;
      if (onClose) onClose();
    }

    // v1.1: history stack for Undo/Redo + smarter-diff outerHTML
    // snapshots. Each entry carries:
    //   { mutation: {type, property, from, to, target},
    //     undo: () => void,   // inverse of apply, used by Ctrl+Z
    //     redo: () => void,   // re-apply after undo, used by Ctrl+Shift+Z
    //     beforeHTML, afterHTML }  // for diff-format spec §6 outerHTML diff
    const history = [];
    let historyCursor = 0; // points one past the last applied entry
    function recordMutation(mut, undoFn, redoFn) {
      // Drop redo tail if we recorded a new mutation after some undos.
      if (historyCursor < history.length) history.length = historyCursor;
      const beforeHTML = mut._beforeHTML || null;
      // Capture afterHTML after any DOM change has been applied.
      const afterHTML = mut.target && mut.target.outerHTML
        ? mut.target.outerHTML.slice(0, 4096)
        : null;
      const entry = {
        mutation: mut, undo: undoFn || null, redo: redoFn || null,
        beforeHTML, afterHTML,
      };
      history.push(entry);
      historyCursor = history.length;
      mutations.push(mut);
      if (onMutation) onMutation(mut);
    }
    function snapshotBefore(el) {
      return el && el.outerHTML ? el.outerHTML.slice(0, 4096) : null;
    }
    function doUndo() {
      if (historyCursor === 0) return;
      const entry = history[historyCursor - 1];
      if (entry.undo) entry.undo();
      historyCursor -= 1;
    }
    function doRedo() {
      if (historyCursor >= history.length) return;
      const entry = history[historyCursor];
      if (entry.redo) entry.redo();
      historyCursor += 1;
    }

    let dragging = null;

    function activateChip(chipId) {
      // Undo/Redo + Quote work without currentTarget; the others need it.
      if (chipId === 'undo') { doUndo(); return; }
      if (chipId === 'redo') { doRedo(); return; }
      if (chipId === 'quote') { doQuote(); return; }
      if (!currentTarget) return;
      switch (chipId) {
        case 'move':   startMove(); break;
        case 'resize': startResize(); break;
        case 'style':  showStyleSubpanel(); break;
        case 'duplicate': doDuplicate(); break;
        case 'delete': confirmDelete(); break;
        case 'inspect': showInspect(); break;
        case 'info': showInfo(); break;
      }
    }

    function doQuote() {
      // Spec §7: bundle the live mutation log into a diff Quote payload
      // and emit it as a CustomEvent on the document. The host page (e.g.
      // interactive-dev.html or the chat composer) listens for
      // `hover-click:quote` and routes it to the chat thread.
      const diff = root.EClawDiffFormat
        ? root.EClawDiffFormat.produce(mutations.slice(), {
            kind: 'portal', url: root.location && root.location.pathname,
          })
        : { semantic: { changes: [] }, unified: '', summary: '0 changes' };
      const payload = {
        target: currentTarget ? {
          selector: describeShort(currentTarget),
          outerHTML: currentTarget.outerHTML.slice(0, 4096),
        } : null,
        diff: {
          semantic: diff.semantic,
          unified: diff.unified,
          summary: diff.summary,
        },
        history: history.map((h) => ({
          type: h.mutation && h.mutation.type,
          property: h.mutation && h.mutation.property,
          beforeHTML: h.beforeHTML,
          afterHTML: h.afterHTML,
        })),
        ts: Date.now(),
      };
      document.dispatchEvent(new CustomEvent('hover-click:quote', { detail: payload }));
    }

    function startMove() {
      if (!currentTarget) return;
      const cs = getComputedStyle(currentTarget);
      const startX0 = parseFloat(cs.left) || 0;
      const startY0 = parseFloat(cs.top) || 0;
      const wasPos = cs.position;
      if (wasPos === 'static') currentTarget.style.position = 'relative';
      dragging = { target: currentTarget, startMouseX: null, startMouseY: null, startLeft: startX0, startTop: startY0 };
      currentTarget.style.cursor = 'move';
      const moveHandler = (e) => {
        if (dragging.startMouseX === null) {
          dragging.startMouseX = e.clientX;
          dragging.startMouseY = e.clientY;
          return;
        }
        const dx = e.clientX - dragging.startMouseX;
        const dy = e.clientY - dragging.startMouseY;
        currentTarget.style.left = `${dragging.startLeft + dx}px`;
        currentTarget.style.top = `${dragging.startTop + dy}px`;
      };
      const upHandler = () => {
        document.removeEventListener('pointermove', moveHandler, true);
        document.removeEventListener('pointerup', upHandler, true);
        const r = currentTarget.getBoundingClientRect();
        recordMutation({
          type: 'geometry',
          target: currentTarget,
          from: { x: startX0, y: startY0, w: r.width, h: r.height },
          to:   { x: parseFloat(currentTarget.style.left) || 0, y: parseFloat(currentTarget.style.top) || 0, w: r.width, h: r.height },
        });
        currentTarget.style.cursor = '';
        dragging = null;
      };
      document.addEventListener('pointermove', moveHandler, true);
      document.addEventListener('pointerup', upHandler, true);
    }

    function startResize() {
      if (!currentTarget) return;
      const r = currentTarget.getBoundingClientRect();
      const startW = r.width, startH = r.height;
      let startX = null, startY = null;
      const moveHandler = (e) => {
        if (startX === null) { startX = e.clientX; startY = e.clientY; return; }
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        let newW = startW + dx;
        let newH = startH + dy;
        if (e.shiftKey) {
          const ratio = startW / startH;
          newH = newW / ratio;
        }
        currentTarget.style.width = `${Math.max(20, newW)}px`;
        currentTarget.style.height = `${Math.max(20, newH)}px`;
      };
      const upHandler = () => {
        document.removeEventListener('pointermove', moveHandler, true);
        document.removeEventListener('pointerup', upHandler, true);
        const r2 = currentTarget.getBoundingClientRect();
        recordMutation({
          type: 'geometry',
          target: currentTarget,
          from: { w: startW, h: startH },
          to: { w: r2.width, h: r2.height },
        });
      };
      document.addEventListener('pointermove', moveHandler, true);
      document.addEventListener('pointerup', upHandler, true);
    }

    function showStyleSubpanel() {
      if (!currentTarget) return;
      const color = prompt(t('hover_click.style_prompt_color', 'Set color (CSS value, e.g. rebeccapurple, #f00):'), '');
      if (color === null) return;
      const target = currentTarget;
      const before = target.style.color || null;
      const beforeHTML = snapshotBefore(target);
      target.style.color = color;
      recordMutation(
        { type: 'style', target, property: 'color', from: before, to: color, _beforeHTML: beforeHTML },
        () => { target.style.color = before || ''; },
        () => { target.style.color = color; },
      );
    }

    function doDuplicate() {
      if (!currentTarget) return;
      const target = currentTarget;
      const beforeHTML = snapshotBefore(target);
      const clone = target.cloneNode(true);
      target.parentElement.insertBefore(clone, target.nextSibling);
      recordMutation(
        { type: 'duplicate', target, newNode: clone, _beforeHTML: beforeHTML },
        () => { clone.remove(); },
        () => { target.parentElement.insertBefore(clone, target.nextSibling); },
      );
    }

    function confirmDelete() {
      if (!currentTarget) return;
      const target = currentTarget;
      const parent = target.parentElement;
      const before = target.nextSibling;
      // Per #6 review Q5: inline 3s ghost-then-commit
      const ghost = document.createElement('span');
      ghost.className = 'eclaw-hover-click-toolbar__ghost-delete';
      ghost.textContent = t('hover_click.delete_ghost_label', 'Deleted — undo?') + ' ';
      const undoBtn = document.createElement('button');
      undoBtn.type = 'button';
      undoBtn.className = 'eclaw-hover-click-toolbar__ghost-undo';
      undoBtn.textContent = t('hover_click.delete_ghost_undo', 'Undo');
      ghost.appendChild(undoBtn);
      target.replaceWith(ghost);
      let undone = false;
      undoBtn.addEventListener('click', () => {
        undone = true;
        ghost.replaceWith(target);
        close();
      });
      setTimeout(() => {
        if (undone) return;
        ghost.remove();
        recordMutation(
          { type: 'remove', target, parent, beforeSibling: before, _beforeHTML: snapshotBefore(target) },
          () => { parent.insertBefore(target, before); },
          () => { target.remove(); },
        );
        close();
      }, 3000);
    }

    function showInspect() {
      if (!currentTarget) return;
      const cs = getComputedStyle(currentTarget);
      const lines = ['Inspect:', `selector: ${currentTarget.tagName.toLowerCase()}${currentTarget.id ? '#' + currentTarget.id : ''}`,
        `color: ${cs.color}`, `background: ${cs.backgroundColor}`, `font-size: ${cs.fontSize}`,
        `display: ${cs.display}`, `position: ${cs.position}`];
      alert(lines.join('\n'));
    }

    function showInfo() {
      if (!currentTarget) return;
      const r = currentTarget.getBoundingClientRect();
      alert(`${currentTarget.tagName.toLowerCase()}\n` +
        `${currentTarget.className || '(no class)'}\n` +
        `${Math.round(r.width)}x${Math.round(r.height)} @ ${Math.round(r.left)},${Math.round(r.top)}`);
    }

    function destroy() {
      document.removeEventListener('click', onOutsideClick, true);
      document.removeEventListener('keydown', onKeyDown, true);
      shell.remove();
    }

    return {
      open, close,
      isOpen: () => openFlag,
      getMutations: () => mutations.slice(),
      destroy,
    };
  }

  root.EClawHoverClickToolbar = { createHoverClickToolbar };
})(typeof window !== 'undefined' ? window : this);
