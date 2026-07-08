/**
 * showConfirm / showPrompt — focus restore on close + LIFO Esc for stacked dialogs.
 *
 * Card: card_8903c41d8848c182f3aabcab (P2 a11y, Phase 2 finding of the
 * destructive-modals daily E2E card_b7c1fca2b9107cd8fd3088a8).
 *
 * Two defects, both in backend/public/portal/shared/api.js:
 *   1. FOCUS RESTORE (WAI-ARIA APG dialog pattern violation): closing a dialog
 *      (Esc or Cancel) dropped document.activeElement to <body> instead of
 *      returning it to the invoking element.
 *   2. STACKED ESC: each dialog attaches its own document-level capture
 *      keydown handler, so ONE Esc fired every handler and closed the whole
 *      stack. Expected: LIFO — one Esc closes only the top-most dialog.
 *
 * jest.config.js uses testEnvironment:'node' with no jsdom dep, so (matching
 * outbox-ui.test.js / admin-removebot-confirm.test.js) we hand-roll a minimal
 * DOM stub and EXECUTE the real api.js via a new Function('window','document')
 * harness — bare `window`/`document` references inside api.js resolve to the
 * stubs. The stub covers exactly the surface showConfirm/showPrompt touch:
 * createElement, body/head appendChild, innerHTML (flat parse of tags that
 * carry a class attr), querySelector('.cls'), element/document add/remove
 * EventListener, focus()/activeElement (reset to body when the focused element
 * leaves the DOM, like real browsers), remove(), isConnected, click().
 * Extend the stub before reaching for a real jsdom dep.
 *
 * FAIL-ON-OLD (verified against the pre-fix api.js):
 *   - "restores focus to the trigger" tests: activeElement stayed on <body>.
 *   - "one Esc closes ONLY the top-most dialog": one Esc left 0 overlays.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const apiJsSrc = fs.readFileSync(
    path.join(__dirname, '..', '..', 'public', 'portal', 'shared', 'api.js'),
    'utf8'
);

// ── Minimal DOM stub ──────────────────────────────────────────────────────
function makeDom() {
    const doc = {};
    let activeElement = null;

    class StubElement {
        constructor(tag) {
            this.tagName = String(tag || 'div').toUpperCase();
            this.children = [];
            this.parentNode = null;
            this.className = '';
            this.id = '';
            this.disabled = false;
            this.value = '';
            // Real CSSStyleDeclaration reads '' for unset properties — the
            // scroll-lock save/restore round-trips these, so match that.
            this.style = { overflow: '', position: '', top: '', width: '' };
            this._attrs = {};
            this._text = '';
            this._innerHTML = null;
            this._listeners = {};
        }
        get textContent() { return this._text; }
        set textContent(v) { this._text = String(v == null ? '' : v); this._innerHTML = null; }
        get innerHTML() {
            // _escHtml() sets textContent then reads innerHTML → serialize escaped.
            if (this._innerHTML !== null) return this._innerHTML;
            return this._text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        }
        set innerHTML(html) {
            this._innerHTML = String(html);
            this.children = [];
            // Flat parse: one child per tag carrying attributes — enough for the
            // querySelector('.cls') lookups showConfirm/showPrompt perform.
            const tagRe = /<(button|input|div|p|label|span)\b([^>]*?)\/?>/g;
            let m;
            while ((m = tagRe.exec(this._innerHTML))) {
                const el = new StubElement(m[1]);
                const attrs = m[2];
                const cls = /class="([^"]*)"/.exec(attrs);
                if (cls) el.className = cls[1];
                const val = /value="([^"]*)"/.exec(attrs);
                if (val) el.value = val[1];
                if (/\sdisabled\b/.test(attrs)) el.disabled = true;
                el.parentNode = this;
                this.children.push(el);
            }
        }
        appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
        remove() {
            if (this.parentNode) {
                const i = this.parentNode.children.indexOf(this);
                if (i !== -1) this.parentNode.children.splice(i, 1);
                this.parentNode = null;
            }
            // Real browsers move focus to <body> when the focused element leaves the DOM.
            if (activeElement && !activeElement.isConnected) activeElement = doc.body;
        }
        get isConnected() {
            let n = this;
            while (n.parentNode) n = n.parentNode;
            return n === doc.body || n === doc.head;
        }
        querySelector(sel) {
            const cls = String(sel).replace(/^\./, '');
            const walk = (el) => {
                for (const c of el.children) {
                    if ((c.className || '').split(/\s+/).indexOf(cls) !== -1) return c;
                    const hit = walk(c);
                    if (hit) return hit;
                }
                return null;
            };
            return walk(this);
        }
        addEventListener(type, cb) {
            if (!this._listeners[type]) this._listeners[type] = [];
            this._listeners[type].push(cb);
        }
        removeEventListener(type, cb) {
            const a = this._listeners[type] || [];
            const i = a.indexOf(cb);
            if (i !== -1) a.splice(i, 1);
        }
        focus() { if (this.isConnected) activeElement = this; }
        select() {}
        click() {
            const evt = { type: 'click', target: this, preventDefault() {}, stopPropagation() {} };
            for (const cb of (this._listeners.click || []).slice()) cb(evt);
        }
        setAttribute(k, v) { this._attrs[k] = String(v); if (k === 'id') this.id = String(v); }
        getAttribute(k) {
            return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null;
        }
    }

    const docListeners = { keydown: [] };
    doc.body = new StubElement('body');
    doc.head = new StubElement('head');
    doc.createElement = (t) => new StubElement(t);
    doc.getElementById = (id) => {
        const walk = (el) => {
            for (const c of el.children) {
                if (c.id === id) return c;
                const hit = walk(c);
                if (hit) return hit;
            }
            return null;
        };
        return walk(doc.head) || walk(doc.body);
    };
    doc.addEventListener = (type, cb) => {
        if (!docListeners[type]) docListeners[type] = [];
        docListeners[type].push(cb);
    };
    doc.removeEventListener = (type, cb) => {
        const a = docListeners[type] || [];
        const i = a.indexOf(cb);
        if (i !== -1) a.splice(i, 1);
    };
    doc.contains = (el) => !!(el && el.isConnected);
    Object.defineProperty(doc, 'activeElement', { get: () => activeElement || doc.body });

    // DOM-spec-faithful document keydown dispatch: iterate a snapshot but skip
    // handlers that were removed while the event is being dispatched.
    const dispatchKeydown = (key) => {
        const evt = { type: 'keydown', key, shiftKey: false, preventDefault() {}, stopPropagation() {} };
        for (const cb of docListeners.keydown.slice()) {
            if (docListeners.keydown.indexOf(cb) !== -1) cb(evt);
        }
    };

    const win = {
        location: { origin: 'https://eclawbot.test', hostname: 'eclawbot.test' },
        scrollY: 0,
        pageYOffset: 0,
        scrollTo() {},
        alert() {},
        confirm() { return true; },
        prompt() { return null; },
    };

    return { doc, win, dispatchKeydown, StubElement };
}

// ── Harness: execute the REAL api.js against the stub ─────────────────────
function makeHarness() {
    const dom = makeDom();
    const factory = new Function(
        'window', 'document',
        `${apiJsSrc}\n;return { showConfirm: showConfirm, showPrompt: showPrompt };`
    );
    const api = factory(dom.win, dom.doc);
    const overlays = () => dom.doc.body.children.filter(
        (c) => (c.className || '').indexOf('eclaw-confirm-overlay') !== -1
    );
    const addTrigger = () => {
        const trigger = dom.doc.createElement('button');
        trigger.className = 'test-trigger';
        dom.doc.body.appendChild(trigger);
        trigger.focus();
        return trigger;
    };
    return { ...dom, ...api, overlays, addTrigger };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('showConfirm — focus restore to invoking element (card_8903c41d)', () => {
    it('Esc-close restores focus to the trigger (FAIL-ON-OLD: activeElement dropped to <body>)', async () => {
        const h = makeHarness();
        const trigger = h.addTrigger();
        expect(h.doc.activeElement).toBe(trigger);

        const p = h.showConfirm({ message: 'delete?', danger: true, itemName: 'thing' });
        // Regression guard (card_31cbbcd8 / card_d2506588): danger initial focus is Cancel.
        expect(h.doc.activeElement.className).toContain('eclaw-confirm-cancel');

        h.dispatchKeydown('Escape');
        await expect(p).resolves.toBe(false);
        expect(h.overlays()).toHaveLength(0);
        expect(h.doc.activeElement).toBe(trigger); // FAIL-ON-OLD: was doc.body
    });

    it('Cancel-click close also restores focus to the trigger', async () => {
        const h = makeHarness();
        const trigger = h.addTrigger();
        const p = h.showConfirm({ message: 'delete?', danger: true, itemName: 'thing' });
        h.overlays()[0].querySelector('.eclaw-confirm-cancel').click();
        await expect(p).resolves.toBe(false);
        expect(h.doc.activeElement).toBe(trigger);
    });

    it('Confirm-click close restores focus to the trigger too', async () => {
        const h = makeHarness();
        const trigger = h.addTrigger();
        const p = h.showConfirm({ message: 'go?', danger: false });
        h.overlays()[0].querySelector('.eclaw-confirm-ok').click();
        await expect(p).resolves.toBe(true);
        expect(h.doc.activeElement).toBe(trigger);
    });

    it('trigger removed from the DOM while the dialog is open → fallback (no throw, focus to <body>)', async () => {
        const h = makeHarness();
        const trigger = h.addTrigger();
        const p = h.showConfirm({ message: 'delete?', danger: true, itemName: 'thing' });
        trigger.remove();
        h.dispatchKeydown('Escape');
        await expect(p).resolves.toBe(false);
        expect(h.doc.activeElement).toBe(h.doc.body);
    });
});

describe('showConfirm — stacked dialogs close LIFO on Esc (card_8903c41d)', () => {
    it('one Esc closes ONLY the top-most dialog; the next Esc closes the next (FAIL-ON-OLD: one Esc closed both)', async () => {
        const h = makeHarness();
        h.addTrigger();
        let p1Done = false;
        const p1 = h.showConfirm({ message: 'first', danger: true, itemName: 'a' });
        p1.then(() => { p1Done = true; });
        const p2 = h.showConfirm({ message: 'second', danger: true, itemName: 'b' });
        expect(h.overlays()).toHaveLength(2);

        h.dispatchKeydown('Escape');
        await expect(p2).resolves.toBe(false);
        await flush();
        expect(h.overlays()).toHaveLength(1); // FAIL-ON-OLD: 0 — both closed
        expect(p1Done).toBe(false);           // bottom dialog still open

        h.dispatchKeydown('Escape');
        await expect(p1).resolves.toBe(false);
        expect(h.overlays()).toHaveLength(0);
    });

    it('closing the top dialog restores focus into the dialog below, then the original trigger', async () => {
        const h = makeHarness();
        const trigger = h.addTrigger();
        const p1 = h.showConfirm({ message: 'first', danger: true, itemName: 'a' });
        const bottomCancel = h.overlays()[0].querySelector('.eclaw-confirm-cancel');
        expect(h.doc.activeElement).toBe(bottomCancel);

        const p2 = h.showConfirm({ message: 'second', danger: true, itemName: 'b' });
        h.dispatchKeydown('Escape');
        await expect(p2).resolves.toBe(false);
        expect(h.doc.activeElement).toBe(bottomCancel); // LIFO focus chain

        h.dispatchKeydown('Escape');
        await expect(p1).resolves.toBe(false);
        expect(h.doc.activeElement).toBe(trigger);
    });

    it('Enter cannot leak to a lower stacked dialog (top gate covers all keys)', async () => {
        const h = makeHarness();
        h.addTrigger();
        let p1Done = false;
        // Bottom dialog is NON-danger: pre-fix, a document-level Enter resolved it true.
        const p1 = h.showConfirm({ message: 'first' });
        p1.then(() => { p1Done = true; });
        const p2 = h.showConfirm({ message: 'second', danger: true, itemName: 'b' });

        h.dispatchKeydown('Enter'); // top is danger + focus on Cancel → resolves false
        await expect(p2).resolves.toBe(false);
        await flush();
        expect(p1Done).toBe(false); // FAIL-ON-OLD: bottom dialog confirmed by the same Enter
        expect(h.overlays()).toHaveLength(1);

        h.dispatchKeydown('Escape');
        await expect(p1).resolves.toBe(false);
    });

    it('scroll-lock ref-count returns to 0 after the whole stack closes (body styles restored)', async () => {
        const h = makeHarness();
        h.addTrigger();
        h.doc.body.style.overflow = '';
        const p1 = h.showConfirm({ message: 'first', danger: true, itemName: 'a' });
        const p2 = h.showConfirm({ message: 'second', danger: true, itemName: 'b' });
        expect(h.doc.body.style.position).toBe('fixed');

        h.dispatchKeydown('Escape');
        await expect(p2).resolves.toBe(false);
        expect(h.doc.body.style.position).toBe('fixed'); // still locked — one dialog open

        h.dispatchKeydown('Escape');
        await expect(p1).resolves.toBe(false);
        expect(h.doc.body.style.position).toBe(''); // count back to 0 → restored
        expect(h.doc.body.style.overflow).toBe('');
    });
});

describe('showConfirm — Enter/Esc semantics unchanged for a single dialog (card_d2506588 regression guard)', () => {
    it('non-danger: Enter confirms (resolves true)', async () => {
        const h = makeHarness();
        h.addTrigger();
        const p = h.showConfirm({ message: 'go?' });
        h.dispatchKeydown('Enter');
        await expect(p).resolves.toBe(true);
    });

    it('danger: stray Enter with focus on Cancel still cancels (resolves false)', async () => {
        const h = makeHarness();
        h.addTrigger();
        const p = h.showConfirm({ message: 'delete?', danger: true, itemName: 'x' });
        expect(h.doc.activeElement.className).toContain('eclaw-confirm-cancel');
        h.dispatchKeydown('Enter');
        await expect(p).resolves.toBe(false);
    });
});

describe('showPrompt — same fixes apply (shared dialog stack + focus restore)', () => {
    it('Esc-close restores focus to the trigger (FAIL-ON-OLD: dropped to <body>)', async () => {
        const h = makeHarness();
        const trigger = h.addTrigger();
        const p = h.showPrompt({ message: 'name?' });
        expect(h.doc.activeElement.className).toContain('eclaw-prompt-input');
        h.dispatchKeydown('Escape');
        await expect(p).resolves.toBe(null);
        expect(h.doc.activeElement).toBe(trigger);
    });

    it('showPrompt stacked on showConfirm: one Esc closes only the prompt', async () => {
        const h = makeHarness();
        h.addTrigger();
        let p1Done = false;
        const p1 = h.showConfirm({ message: 'confirm', danger: true, itemName: 'a' });
        p1.then(() => { p1Done = true; });
        const p2 = h.showPrompt({ message: 'name?' });
        expect(h.overlays()).toHaveLength(2);

        h.dispatchKeydown('Escape');
        await expect(p2).resolves.toBe(null);
        await flush();
        expect(h.overlays()).toHaveLength(1); // FAIL-ON-OLD: 0
        expect(p1Done).toBe(false);

        h.dispatchKeydown('Escape');
        await expect(p1).resolves.toBe(false);
        expect(h.overlays()).toHaveLength(0);
    });
});
