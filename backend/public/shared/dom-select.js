/**
 * dom-select.js — hover focus ring + click-commit selection primitive
 * Spec: docs/specs/a-hover-click-dom-interaction.md §2
 *
 * State machine: idle → hover-preview → selected. Esc / outside-click dismiss.
 * Container vs leaf: defaults to smallest selectable element; Alt+Click (or
 * Option-Tap on touch) walks one ancestor level up per repeated activation.
 *
 * Dependencies (loaded by host page):
 *   - shared/i18n.js (window.i18n.t) — labels for aria-live announcements
 *   - shared/hover-click-toolbar.css — focus-ring styles
 */
(function (root) {
  'use strict';

  let _seq = 0;
  const PREVIEW_RING_CLASS = 'eclaw-dom-select__ring-preview';
  const SELECTED_RING_CLASS = 'eclaw-dom-select__ring-selected';

  /**
   * @param {Object} opts
   * @param {HTMLElement|Document} opts.scope - root inside which elements are selectable.
   * @param {(el:Element)=>boolean} [opts.predicate] - additional gate; default returns true.
   * @param {(el:Element)=>void} [opts.onPreview]
   * @param {(el:Element)=>void} [opts.onSelect]
   * @param {()=>void} [opts.onDismiss]
   * @returns {{destroy:Function, getSelected:()=>Element|null, dismiss:Function}}
   */
  function createDomSelect(opts) {
    if (!opts || !opts.scope) throw new Error('dom-select: scope is required');
    const id = ++_seq;
    const scope = opts.scope;
    const userPredicate = typeof opts.predicate === 'function' ? opts.predicate : null;
    const onPreview = typeof opts.onPreview === 'function' ? opts.onPreview : null;
    const onSelect = typeof opts.onSelect === 'function' ? opts.onSelect : null;
    const onDismiss = typeof opts.onDismiss === 'function' ? opts.onDismiss : null;

    let previewEl = null;
    let selectedEl = null;
    let lastAncestorClickPath = [];

    // Live region for screen-reader announcements
    const live = document.createElement('div');
    live.setAttribute('aria-live', 'polite');
    live.setAttribute('aria-atomic', 'true');
    live.style.position = 'absolute';
    live.style.left = '-9999px';
    live.style.width = '1px';
    live.style.height = '1px';
    live.style.overflow = 'hidden';
    live.id = `eclaw-dom-select-live-${id}`;
    document.body.appendChild(live);

    function t(key, fallback) {
      try {
        const v = root.i18n && typeof root.i18n.t === 'function' ? root.i18n.t(key) : null;
        return v && v !== key ? v : fallback;
      } catch (e) {
        return fallback;
      }
    }

    function describeElement(el) {
      if (!el || el.nodeType !== 1) return '';
      const tag = el.tagName.toLowerCase();
      const cls = el.className && typeof el.className === 'string'
        ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.')
        : '';
      const idStr = el.id ? '#' + el.id : '';
      return `${tag}${idStr}${cls}`;
    }

    function isSelectable(el) {
      if (!el || el.nodeType !== 1) return false;
      // Inside scope
      const root = scope === document ? document.documentElement : scope;
      if (!root.contains(el)) return false;
      // Visible
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') return false;
      if (el.offsetWidth === 0 || el.offsetHeight === 0) return false;
      // Not inside the toolbar itself. The ring classes apply directly to
      // the selected/previewed element itself, so we must NOT use them as
      // "skip" markers — that would block re-selecting the same element
      // after dismiss.
      if (el.closest('.eclaw-hover-click-toolbar')) return false;
      // User predicate
      if (userPredicate && !userPredicate(el)) return false;
      return true;
    }

    function clearPreview() {
      if (previewEl) {
        previewEl.classList.remove(PREVIEW_RING_CLASS);
        previewEl = null;
      }
    }

    function clearSelection() {
      if (selectedEl) {
        selectedEl.classList.remove(SELECTED_RING_CLASS);
        selectedEl = null;
      }
      lastAncestorClickPath = [];
      if (onDismiss) onDismiss();
    }

    function setPreview(el) {
      if (el === previewEl) return;
      clearPreview();
      if (el && el !== selectedEl) {
        previewEl = el;
        el.classList.add(PREVIEW_RING_CLASS);
        if (onPreview) onPreview(el);
      }
    }

    function setSelection(el) {
      clearPreview();
      if (selectedEl && selectedEl !== el) {
        selectedEl.classList.remove(SELECTED_RING_CLASS);
      }
      selectedEl = el;
      el.classList.add(SELECTED_RING_CLASS);
      live.textContent = t('hover_click.aria_selected', 'Selected') + ': ' + describeElement(el);
      if (onSelect) onSelect(el);
    }

    function onPointerOver(e) {
      const t = e.target;
      if (!isSelectable(t)) {
        clearPreview();
        return;
      }
      setPreview(t);
    }

    function onPointerOut(e) {
      // Only clear preview if pointer moved out of the scope entirely
      if (!e.relatedTarget || !isSelectable(e.relatedTarget)) {
        clearPreview();
      }
    }

    function onClick(e) {
      const target = e.target;
      // Ignore clicks inside the toolbar — toolbar handles its own events.
      if (target.closest && target.closest('.eclaw-hover-click-toolbar')) return;

      // Outside scope → dismiss
      if (!isSelectable(target)) {
        if (selectedEl) {
          e.preventDefault();
          clearSelection();
        }
        return;
      }

      e.preventDefault();
      e.stopPropagation();

      // Alt+Click (Option+Tap) → walk one ancestor up if currently selected
      if (e.altKey && selectedEl && target === selectedEl) {
        const parent = selectedEl.parentElement;
        if (parent && isSelectable(parent)) {
          lastAncestorClickPath.push(selectedEl);
          setSelection(parent);
          return;
        }
      }

      setSelection(target);
    }

    function onKeyDown(e) {
      if (e.key === 'Escape' && selectedEl) {
        e.preventDefault();
        clearSelection();
      }
    }

    // Long-press for touch (mobile): treat as hover-preview commit
    let touchTimer = null;
    let touchTarget = null;
    function onTouchStart(e) {
      const target = e.target;
      if (!isSelectable(target)) return;
      touchTarget = target;
      setPreview(target);
      touchTimer = setTimeout(() => {
        if (touchTarget === target) {
          setSelection(target);
          live.textContent = t('hover_click.aria_long_press_selected', 'Long press selected') + ': ' + describeElement(target);
        }
      }, 500);
    }
    function onTouchEnd() {
      if (touchTimer) { clearTimeout(touchTimer); touchTimer = null; }
      touchTarget = null;
    }

    // Attach
    const target = scope === document ? document : scope;
    target.addEventListener('pointerover', onPointerOver, true);
    target.addEventListener('pointerout', onPointerOut, true);
    target.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKeyDown, true);
    target.addEventListener('touchstart', onTouchStart, { passive: true });
    target.addEventListener('touchend', onTouchEnd, { passive: true });
    target.addEventListener('touchcancel', onTouchEnd, { passive: true });

    return {
      destroy() {
        target.removeEventListener('pointerover', onPointerOver, true);
        target.removeEventListener('pointerout', onPointerOut, true);
        target.removeEventListener('click', onClick, true);
        document.removeEventListener('keydown', onKeyDown, true);
        target.removeEventListener('touchstart', onTouchStart);
        target.removeEventListener('touchend', onTouchEnd);
        target.removeEventListener('touchcancel', onTouchEnd);
        clearPreview();
        clearSelection();
        live.remove();
      },
      getSelected() { return selectedEl; },
      dismiss() { clearSelection(); },
      describeElement,
    };
  }

  root.EClawDomSelect = { createDomSelect };
})(typeof window !== 'undefined' ? window : this);
