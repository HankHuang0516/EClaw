/**
 * Help Popover — reusable ? icon component
 *
 * Usage:
 *   <span class="help-icon" data-help-content="Tooltip text" tabindex="0" role="button" aria-label="Help"></span>
 *   <span class="help-icon" data-help-content-key="kanban_nudge_batch_help" tabindex="0"></span>
 *
 * Or inline:
 *   HelpPopover.show(contentHTMLElement, anchorElement)
 *
 * Accessibility:
 *   - Icon is focusable (tabindex="0") and ENTER/Space triggers popover
 *   - Popover has role="tooltip" and aria-describedby wiring
 *   - ESC closes and returns focus to trigger
 *   - Click-outside dismisses
 *   - Focus trapped inside popover while open
 *
 * @param {Object} opts
 *   content — string or HTMLElement; tooltip HTML content
 *   anchor   — HTMLElement; the icon element the popover anchors to
 *   placement — 'top'|'bottom'|'left'|'right' (auto-detected via collision)
 *   maxWidth — number; popover max-width in px (default 280)
 */

(function () {
    'use strict';

    const POPOVER_CLASS = 'help-popover';
    const ICON_CLASS = 'help-icon';
    const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

    let activePopover = null;
    let activeAnchor  = null;
    let focusTrapStack = [];
    let activeDescribedBy = null;
    let popoverSeq = 0;

    // ── Icon SVG ──────────────────────────────────────────────────────────────
    const HELP_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;

    // ── Helpers ───────────────────────────────────────────────────────────────
    function getViewportRect() {
        return { w: window.innerWidth, h: window.innerHeight };
    }

    function getAnchorRect(anchor) {
        return anchor.getBoundingClientRect();
    }

    function computePlacement(anchorRect, popoverRect, preferred) {
        const { w, h } = getViewportRect();
        const space = {
            top:    anchorRect.top,
            bottom: h - anchorRect.bottom,
            left:   anchorRect.left,
            right:  w - anchorRect.right
        };
        const size = {
            top:    popoverRect.height,
            bottom: popoverRect.height,
            left:   popoverRect.width,
            right:  popoverRect.width
        };
        // If preferred fits, use it
        if (space[preferred] >= size[preferred] + 8) return preferred;
        // Try opposite
        const alt = preferred === 'top' ? 'bottom' : preferred === 'bottom' ? 'top' :
            preferred === 'left' ? 'right' : 'left';
        if (space[alt] >= size[alt] + 8) return alt;
        // Pick the side with most space
        return Object.keys(space).reduce((a, b) => space[a] > space[b] ? a : b);
    }

    function positionPopover(popover, anchor, placement) {
        const anchorRect = getAnchorRect(anchor);
        const popRect = popover.getBoundingClientRect();
        const { w, h }   = getViewportRect();
        const GAP = 8;

        let top, left;

        if (placement === 'bottom') {
            top = anchorRect.bottom + GAP;
            left = anchorRect.left + (anchorRect.width - popRect.width) / 2;
        } else if (placement === 'top') {
            top  = anchorRect.top - popRect.height - GAP;
            left = anchorRect.left + (anchorRect.width - popRect.width) / 2;
        } else if (placement === 'right') {
            top  = anchorRect.top + (anchorRect.height - popRect.height) / 2;
            left = anchorRect.right + GAP;
        } else if (placement === 'left') {
            top  = anchorRect.top + (anchorRect.height - popRect.height) / 2;
            left = anchorRect.left - popRect.width - GAP;
        }

        // Clamp to viewport
        left = Math.max(8, Math.min(left, w - popRect.width - 8));
        top  = Math.max(8, Math.min(top,  h - popRect.height - 8));

        popover.style.top  = top + 'px';
        popover.style.left = left + 'px';
    }

    // ── Focus trap ─────────────────────────────────────────────────────────────
    function getFocusableNodes(container) {
        return Array.from(container.querySelectorAll(FOCUSABLE));
    }

    function trapFocus(popover) {
        const nodes = getFocusableNodes(popover);
        if (nodes.length === 0) return;
        const first = nodes[0];
        const last  = nodes[nodes.length - 1];

        function onKeyDown(e) {
            if (e.key === 'Tab') {
                if (e.shiftKey) {
                    if (document.activeElement === first) {
                        e.preventDefault();
                        last.focus();
                    }
                } else {
                    if (document.activeElement === last) {
                        e.preventDefault();
                        first.focus();
                    }
                }
            }
        }
        popover.addEventListener('keydown', onKeyDown);
        focusTrapStack.push({ popover, onKeyDown });
        first.focus();
    }

    function releaseTrap(popover) {
        const idx = focusTrapStack.findIndex(s => s.popover === popover);
        if (idx !== -1) {
            const { onKeyDown } = focusTrapStack.splice(idx, 1)[0];
            popover.removeEventListener('keydown', onKeyDown);
        }
    }

    // ── Build popover DOM ──────────────────────────────────────────────────────
    function buildPopover(content) {
        const el = document.createElement('div');
        el.className = POPOVER_CLASS;
        el.setAttribute('role', 'tooltip');
        el.setAttribute('tabindex', '-1');
        el.id = `${POPOVER_CLASS}-${++popoverSeq}`;

        const inner = document.createElement('div');
        inner.className = POPOVER_CLASS + '-inner';

        if (typeof content === 'string') {
            inner.innerHTML = content;
        } else if (content instanceof HTMLElement) {
            inner.appendChild(content);
        }

        const closeBtn = document.createElement('button');
        closeBtn.className = POPOVER_CLASS + '-close';
        closeBtn.setAttribute('aria-label', 'Close help');
        closeBtn.textContent = '✕';
        closeBtn.type = 'button';
        closeBtn.addEventListener('click', () => hidePopover());

        el.appendChild(closeBtn);
        el.appendChild(inner);
        return el;
    }

    // ── Show / Hide ────────────────────────────────────────────────────────────
    function showPopover(content, anchor, placement = 'top') {
        hidePopover(); // close any existing

        const popover = buildPopover(content);
        document.body.appendChild(popover);
        anchor.setAttribute('aria-describedby', popover.id);
        activeDescribedBy = { anchor, id: popover.id };

        // Get computed size after append
        const popRect = popover.getBoundingClientRect();
        const finalPlacement = computePlacement(getAnchorRect(anchor), popRect, placement);
        positionPopover(popover, anchor, finalPlacement);

        // Add open class for CSS transition
        requestAnimationFrame(() => popover.classList.add(POPOVER_CLASS + '-visible'));

        activePopover = popover;
        activeAnchor  = anchor;

        trapFocus(popover);

        // Click-outside listener
        document.addEventListener('click', onDocClick, true);
        document.addEventListener('keydown', onDocKeyDown);
    }

    function hidePopover() {
        if (!activePopover) return;
        const popover = activePopover;
        const anchor = activeAnchor;

        releaseTrap(popover);
        popover.classList.remove(POPOVER_CLASS + '-visible');

        setTimeout(() => {
            if (popover.parentNode) popover.parentNode.removeChild(popover);
        }, 200); // CSS transition duration

        activePopover = null;
        activeAnchor  = null;
        if (activeDescribedBy?.anchor && activeDescribedBy.id === popover.id) {
            activeDescribedBy.anchor.removeAttribute('aria-describedby');
            activeDescribedBy = null;
        }

        document.removeEventListener('click', onDocClick, true);
        document.removeEventListener('keydown', onDocKeyDown);

        // Restore focus to anchor
        if (anchor) {
            const toFocus = anchor.closest('[tabindex]') || anchor;
            toFocus.focus();
        }
    }

    // ── Event handlers ─────────────────────────────────────────────────────────
    function onDocClick(e) {
        if (!activePopover) return;
        if (activePopover.contains(e.target)) return;
        if (activeAnchor && activeAnchor.contains(e.target)) return;
        hidePopover();
    }

    function onDocKeyDown(e) {
        if (e.key === 'Escape') {
            e.stopPropagation();
            hidePopover();
        }
    }

    function onIconClick(e) {
        e.stopPropagation();
        const icon = e.currentTarget;
        const content = getIconContent(icon);
        if (!content) return;
        if (activeAnchor === icon && activePopover) {
            hidePopover();
        } else {
            showPopover(content, icon, 'top');
        }
    }

    function onIconKeyDown(e) {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onIconClick(e);
        }
    }

    // ── Public API ─────────────────────────────────────────────────────────────
    function getIconContent(icon) {
        const key = icon.dataset.helpContentKey;
        if (key && window.i18n?.t) {
            const translated = window.i18n.t(key);
            if (translated && translated !== key) return translated;
        }
        return icon.dataset.helpContent || icon.dataset.help || '';
    }

    function prepareIcon(icon) {
        if (!icon.innerHTML.trim()) icon.innerHTML = HELP_ICON_SVG;
        if (!icon.hasAttribute('tabindex')) icon.setAttribute('tabindex', '0');
        if (!icon.hasAttribute('role')) icon.setAttribute('role', 'button');
        if (!icon.hasAttribute('aria-label')) icon.setAttribute('aria-label', 'Help');
    }

    /**
     * Attach help-icon behaviour to all elements with class ICON_CLASS.
     * Call once on DOMContentLoaded after all HTML with data-help-content is in DOM.
     */
    function init() {
        document.querySelectorAll('.' + ICON_CLASS).forEach(prepareIcon);
        document.addEventListener('click', (e) => {
            const icon = e.target.closest('.' + ICON_CLASS);
            if (icon) {
                prepareIcon(icon);
                onIconClick({ currentTarget: icon, stopPropagation: () => e.stopPropagation() });
            }
        });
        document.addEventListener('keydown', (e) => {
            const icon = e.target.closest('.' + ICON_CLASS);
            if (icon) {
                prepareIcon(icon);
                onIconKeyDown({
                    key: e.key,
                    currentTarget: icon,
                    preventDefault: () => e.preventDefault(),
                    stopPropagation: () => e.stopPropagation()
                });
            }
        });
    }

    /** Show popover programmatically */
    function show(content, anchor, placement) {
        showPopover(content, anchor, placement);
    }

    /** Hide active popover */
    function hide() {
        hidePopover();
    }

    /** Returns true if a popover is currently open */
    function isOpen() {
        return !!activePopover;
    }

    // Auto-init when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    window.HelpPopover = { show, hide, isOpen, init };
})();
