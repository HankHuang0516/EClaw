/**
 * filter-summary.js — summary-chip + collapsible panel primitive
 * Spec: docs/specs/chat-page-filter-bar-collapse.md
 *
 * Lets a page show a single 36/32-px chip "Filters (n)" by default, and expand
 * an anchored popover panel on tap/click. Chat is the first adopter; kanban /
 * mission may adopt later by passing their own panelContent + countActive.
 *
 * Dependencies (loaded by the host page):
 *   - shared/i18n.js (window.i18n.t)
 *   - shared/filter-summary.css
 */
(function (root) {
  'use strict';

  const ZWS = '​';
  let _seq = 0;

  /**
   * @param {Object} opts
   * @param {HTMLElement} opts.anchorEl - container where the summary chip mounts.
   * @param {(panelEl:HTMLElement)=>void} opts.panelContent - callback invoked once with the empty panel body; populate it with your existing chip groups.
   * @param {()=>number} opts.countActive - returns the number of non-default selections; used for the count badge + active class.
   * @param {string} opts.i18nKey - base key, e.g. "chat_filter". Looks up `${key}_summary_label`, `${key}_summary_count`, `${key}_summary_close`.
   * @param {()=>void} [opts.onOpen]
   * @param {()=>void} [opts.onClose]
   * @returns {{open:Function, close:Function, refresh:Function, destroy:Function, panelEl:HTMLElement, summaryEl:HTMLElement, isOpen:()=>boolean}}
   */
  function createFilterSummary(opts) {
    if (!opts || !opts.anchorEl) throw new Error('filter-summary: anchorEl is required');
    if (typeof opts.panelContent !== 'function') throw new Error('filter-summary: panelContent must be a function');
    if (typeof opts.countActive !== 'function') throw new Error('filter-summary: countActive must be a function');

    const id = ++_seq;
    const i18nKey = opts.i18nKey || 'filter';
    const t = (suffix, fallback) => {
      try {
        const k = `${i18nKey}_summary_${suffix}`;
        const v = root.i18n && typeof root.i18n.t === 'function' ? root.i18n.t(k) : null;
        return v && v !== k ? v : fallback;
      } catch (e) {
        return fallback;
      }
    };

    const labelText = t('label', 'Filters');
    const countTemplate = t('count', 'Filters ({n})');
    const closeAriaText = t('close', 'Close filter panel');

    // Build summary chip
    const summary = document.createElement('button');
    summary.type = 'button';
    summary.className = 'eclaw-filter-summary';
    summary.id = `eclaw-filter-summary-${id}`;
    summary.setAttribute('aria-haspopup', 'dialog');
    summary.setAttribute('aria-expanded', 'false');
    summary.innerHTML = `
      <span class="eclaw-filter-summary__icon" aria-hidden="true">⛃</span>
      <span class="eclaw-filter-summary__label"></span>
      <span class="eclaw-filter-summary__count" aria-hidden="true"></span>
    `;

    // Build panel + overlay (mobile only; desktop uses pure popover)
    const overlay = document.createElement('div');
    overlay.className = 'eclaw-filter-summary__overlay';
    overlay.hidden = true;

    const panel = document.createElement('div');
    panel.className = 'eclaw-filter-summary__panel';
    panel.id = `eclaw-filter-summary-panel-${id}`;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'false');
    panel.setAttribute('aria-labelledby', `eclaw-filter-summary-title-${id}`);
    panel.hidden = true;

    const panelHeader = document.createElement('div');
    panelHeader.className = 'eclaw-filter-summary__panel-header';
    panelHeader.innerHTML = `
      <h2 class="eclaw-filter-summary__panel-title" id="eclaw-filter-summary-title-${id}"></h2>
      <button type="button" class="eclaw-filter-summary__close" aria-label=""></button>
    `;
    const panelBody = document.createElement('div');
    panelBody.className = 'eclaw-filter-summary__panel-body';
    panel.appendChild(panelHeader);
    panel.appendChild(panelBody);

    // Mount: summary into anchorEl. overlay/panel into anchorEl as well (panel positioned relative to it).
    opts.anchorEl.appendChild(summary);
    opts.anchorEl.appendChild(overlay);
    opts.anchorEl.appendChild(panel);

    // Populate panel body once (host provides chip groups)
    opts.panelContent(panelBody);

    const labelEl = summary.querySelector('.eclaw-filter-summary__label');
    const countEl = summary.querySelector('.eclaw-filter-summary__count');
    const titleEl = panelHeader.querySelector('.eclaw-filter-summary__panel-title');
    const closeBtn = panelHeader.querySelector('.eclaw-filter-summary__close');
    titleEl.textContent = labelText;
    closeBtn.setAttribute('aria-label', closeAriaText);

    function setCountUI(n) {
      labelEl.textContent = labelText;
      if (n > 0) {
        countEl.hidden = false;
        // countTemplate looks like "Filters ({n})"; we only render the parenthesized part.
        const tail = countTemplate.replace(/.*?(\(.*\)).*/, '$1').replace('{n}', String(n));
        countEl.textContent = tail && tail !== countTemplate ? tail : `(${n})`;
        summary.classList.add('is-active');
      } else {
        countEl.hidden = true;
        countEl.textContent = '';
        summary.classList.remove('is-active');
      }
    }

    function refresh() {
      const n = Number(opts.countActive()) || 0;
      setCountUI(n);
    }

    let opened = false;
    let lastFocus = null;

    const isMobile = () => window.innerWidth <= 600;

    function open() {
      if (opened) return;
      opened = true;
      lastFocus = document.activeElement;
      panel.hidden = false;
      overlay.hidden = !isMobile();
      summary.setAttribute('aria-expanded', 'true');
      panel.classList.toggle('is-mobile', isMobile());
      // Default focus on the close button (per spec PR #3088 safe-default-focus)
      setTimeout(() => { try { closeBtn.focus({ preventScroll: true }); } catch (e) {} }, 0);
      document.addEventListener('keydown', onKey, true);
      document.addEventListener('mousedown', onOutsideMouse, true);
      document.addEventListener('touchstart', onOutsideMouse, { capture: true, passive: true });
      if (typeof opts.onOpen === 'function') opts.onOpen();
    }

    function close() {
      if (!opened) return;
      opened = false;
      panel.hidden = true;
      overlay.hidden = true;
      summary.setAttribute('aria-expanded', 'false');
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('mousedown', onOutsideMouse, true);
      document.removeEventListener('touchstart', onOutsideMouse, { capture: true });
      try { if (lastFocus && lastFocus.focus) lastFocus.focus({ preventScroll: true }); } catch (e) {}
      lastFocus = null;
      refresh();
      if (typeof opts.onClose === 'function') opts.onClose();
    }

    function onKey(ev) {
      if (ev.key === 'Escape') {
        ev.stopPropagation();
        close();
      }
    }
    function onOutsideMouse(ev) {
      if (panel.contains(ev.target)) return;
      if (summary.contains(ev.target)) return;
      close();
    }

    summary.addEventListener('click', (ev) => {
      ev.preventDefault();
      if (opened) close(); else open();
    });
    closeBtn.addEventListener('click', (ev) => { ev.preventDefault(); close(); });

    // Initial render
    refresh();

    return {
      open, close, refresh,
      destroy() {
        close();
        summary.remove();
        overlay.remove();
        panel.remove();
      },
      isOpen() { return opened; },
      panelEl: panelBody,
      summaryEl: summary,
    };
  }

  root.createFilterSummary = createFilterSummary;
})(typeof window !== 'undefined' ? window : globalThis);
