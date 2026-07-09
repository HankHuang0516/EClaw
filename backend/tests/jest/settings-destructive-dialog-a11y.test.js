/**
 * Regression guard for the settings.html destructive-dialog a11y gap
 * (card_dc05cb99b1c85762c39db7c2, P2 — Phase-2 finding of the destructive-modals
 * daily E2E, parent card_c47ad41cb09714c7f4556c37).
 *
 * BUG: the two DESTRUCTIVE bespoke `.dialog-overlay` dialogs in settings.html —
 *   1. Rotate Device Secret confirm (#rotateSecretConfirmDialog) — irreversible,
 *      invalidates the current device secret and forces re-login elsewhere.
 *   2. Switch Device (#switchDeviceDialog) — signs this browser out of the device.
 * — did NOT match the a11y contract of the shared, already-hardened showConfirm()
 * component: role=null (no role="alertdialog"), aria-modal=null, aria-labelledby
 * missing (title not associated), NO focus-trap and NO focus-restore. On the
 * highest-destructiveness path this is an accessibility regression.
 *
 * FIX (two approaches, per the card):
 *  - 方案A — Rotate secret: the destructive CONFIRM gate now routes through the
 *    shared showConfirm({danger:true}) so it inherits role/aria/focus-trap/restore
 *    for free; the one-time secret-reveal dialog stays bespoke.
 *  - 方案B — Switch device (hosts a form, can't use showConfirm): the dialog now
 *    carries role="alertdialog" + aria-modal + aria-labelledby inline, and a
 *    reusable JS focus-trap (eclawTrapDialogFocus) provides Tab/Shift-Tab trapping,
 *    initial focus inside the dialog, and focus-restore to the opener on close.
 *
 * jest.config.js uses testEnvironment: 'node' (no jsdom in this repo), so this
 * test extracts the REAL shipped functions from settings.html (same technique as
 * settings-device-secret-mask.test.js) and drives them against a small faithful
 * DOM shim, exercising real activeElement / focus() / Tab keydown / contains()
 * behaviour. It FAILS on pristine settings.html and PASSES with the fix.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const SETTINGS_HTML = path.resolve(__dirname, '../../public/portal/settings.html');
const html = fs.readFileSync(SETTINGS_HTML, 'utf8');

// Extract an exact `function <name>(...) { ... }` block. Inline-script functions
// are 8-space indented; their bodies are 12+ spaces, so the first `\n        }`
// (8 spaces) after the declaration is the closing brace.
function extractFunction(name) {
    let start = html.indexOf(`function ${name}(`);
    if (start === -1) throw new Error(`settings.html: function ${name} not found`);
    const asyncPrefix = 'async ';
    if (html.slice(start - asyncPrefix.length, start) === asyncPrefix) start -= asyncPrefix.length;
    const end = html.indexOf('\n        }', start);
    if (end === -1) throw new Error(`settings.html: ${name} terminator not found`);
    return html.slice(start, end + '\n        }'.length);
}

// ─── Minimal faithful DOM shim ────────────────────────────────────────────────
// Enough of the DOM to run the real focus-trap: activeElement + focus(),
// contains(), attribute getters, querySelectorAll for the trap's selector, and a
// document-level capture keydown listener the trap can attach to.
function makeDom() {
    const state = { activeElement: null, listeners: [] };

    function El(tag, attrs = {}) {
        return {
            tagName: tag.toUpperCase(),
            _attrs: { ...attrs },
            _children: [],
            value: '',
            style: {},
            isConnected: true,
            // The trap's isVisible() checks offsetWidth || offsetHeight ||
            // getClientRects().length — model a visible element.
            offsetWidth: 10,
            offsetHeight: 10,
            getClientRects() { return [{}]; },
            hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this._attrs, k); },
            getAttribute(k) { return this.hasAttribute(k) ? this._attrs[k] : null; },
            setAttribute(k, v) { this._attrs[k] = String(v); },
            focus() { state.activeElement = this; },
            contains(node) {
                if (node === this) return true;
                return this._children.some((c) => c === node || (c.contains && c.contains(node)));
            },
            append(...kids) { kids.forEach((k) => this._children.push(k)); return this; },
            _matches(sel) {
                // Only the exact tokens the trap's selector uses.
                if (sel === 'a[href]') return this.tagName === 'A' && this.hasAttribute('href');
                if (sel === 'button:not([disabled])') return this.tagName === 'BUTTON' && !this.hasAttribute('disabled');
                if (sel === 'input:not([disabled])') return this.tagName === 'INPUT' && !this.hasAttribute('disabled');
                if (sel === 'select:not([disabled])') return this.tagName === 'SELECT' && !this.hasAttribute('disabled');
                if (sel === 'textarea:not([disabled])') return this.tagName === 'TEXTAREA' && !this.hasAttribute('disabled');
                if (sel === '[tabindex]:not([tabindex="-1"])') return this.hasAttribute('tabindex') && this.getAttribute('tabindex') !== '-1';
                return false;
            },
            querySelectorAll(selector) {
                const tokens = selector.split(',').map((s) => s.trim());
                const out = [];
                const walk = (node) => {
                    node._children.forEach((c) => {
                        if (tokens.some((t) => c._matches(t))) out.push(c);
                        walk(c);
                    });
                };
                walk(this);
                return out;
            },
        };
    }

    const byId = {};
    const document = {
        get activeElement() { return state.activeElement; },
        getElementById(id) { return byId[id] || null; },
        contains(node) { return !!node && node.isConnected; },
        addEventListener(type, fn, capture) { state.listeners.push({ type, fn, capture }); },
        removeEventListener(type, fn, capture) {
            state.listeners = state.listeners.filter((l) => !(l.type === type && l.fn === fn && l.capture === capture));
        },
        body: null,
    };
    document.body = El('body');
    state.activeElement = document.body;

    function dispatchKeydown(ev) {
        const e = { preventDefault() { e.defaultPrevented = true; }, defaultPrevented: false, ...ev };
        // Trap attaches with capture=true; fire those.
        state.listeners.filter((l) => l.type === 'keydown').forEach((l) => l.fn(e));
        return e;
    }

    return { El, document, byId, state, dispatchKeydown };
}

// Build the switch-device dialog subtree the real handlers reference by id.
function buildSwitchDeviceHarness() {
    const dom = makeDom();
    const { El, document, byId } = dom;

    const opener = El('button', {}); // the "Switch Device" trigger on the page
    opener.isConnected = true;
    document.body.append(opener);
    // The user activates the trigger, so it holds focus when the dialog opens —
    // this is the element focus must be restored to on close (WAI-ARIA APG).
    opener.focus();

    const dialog = El('div', { role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': 'switchDeviceDialogTitle' });
    const title = El('div', { id: 'switchDeviceDialogTitle' });
    const idInput = El('input', { id: 'switchDeviceIdInput', type: 'text' });
    const secretInput = El('input', { id: 'switchDeviceSecretInput', type: 'password' });
    const errBox = El('div', { id: 'switchDeviceError' });
    const cancelBtn = El('button', {});
    const confirmBtn = El('button', { id: 'btnConfirmSwitchDevice' });
    dialog.append(title, idInput, secretInput, errBox, cancelBtn, confirmBtn);

    const overlay = El('div', { id: 'switchDeviceDialog', class: 'dialog-overlay' });
    overlay.append(dialog);
    document.body.append(overlay);

    byId.switchDeviceDialog = overlay;
    byId.switchDeviceIdInput = idInput;
    byId.switchDeviceSecretInput = secretInput;
    byId.switchDeviceError = errBox;
    byId.switchDeviceDialogTitle = title;

    // setTimeout that runs synchronously so we can assert initial focus deterministically.
    const setTimeoutSync = (cb) => { cb(); return 0; };

    const src = [
        extractFunction('eclawTrapDialogFocus'),
        'let _switchDeviceReleaseFocus = null;',
        extractFunction('openSwitchDeviceDialog'),
        extractFunction('closeSwitchDeviceDialog'),
        'return { openSwitchDeviceDialog, closeSwitchDeviceDialog };',
    ].join('\n');

    const factory = new Function('document', 'setTimeout', 'console', src);
    const api = factory(document, setTimeoutSync, { warn() {}, error() {} });

    return {
        ...dom, ...api,
        opener, dialog, title, idInput, secretInput, errBox, cancelBtn, confirmBtn, overlay,
        focusables: [idInput, secretInput, cancelBtn, confirmBtn],
    };
}

describe('settings.html Switch Device dialog — a11y (方案B, card_dc05cb99)', () => {
    test('FAIL-ON-OLD: dialog markup declares role=alertdialog + aria-modal + aria-labelledby', () => {
        // The pristine dialog had none of these; the fix adds them inline on the
        // switch-device dialog (it hosts a form so it can't use showConfirm).
        const dlgOpen = html.indexOf('id="switchDeviceDialog"');
        const dlgTag = html.slice(dlgOpen, dlgOpen + 400);
        expect(dlgTag).toMatch(/role="alertdialog"/);
        expect(dlgTag).toMatch(/aria-modal="true"/);
        expect(dlgTag).toMatch(/aria-labelledby="switchDeviceDialogTitle"/);
        // Title carries the id the dialog points at.
        expect(html).toMatch(/id="switchDeviceDialogTitle"/);
    });

    test('opening moves focus INSIDE the dialog (onto the first input)', () => {
        const h = buildSwitchDeviceHarness();
        expect(h.state.activeElement).toBe(h.opener); // pre-open focus is the trigger
        h.openSwitchDeviceDialog();
        expect(h.dialog.contains(h.state.activeElement)).toBe(true);
        expect(h.state.activeElement).toBe(h.idInput);
    });

    test('Tab from the LAST focusable wraps to the FIRST (trap holds)', () => {
        const h = buildSwitchDeviceHarness();
        h.openSwitchDeviceDialog();
        h.confirmBtn.focus(); // last focusable in DOM order
        const e = h.dispatchKeydown({ key: 'Tab', shiftKey: false });
        expect(e.defaultPrevented).toBe(true);
        expect(h.state.activeElement).toBe(h.idInput); // wrapped to first
    });

    test('Shift+Tab from the FIRST focusable wraps to the LAST (trap holds)', () => {
        const h = buildSwitchDeviceHarness();
        h.openSwitchDeviceDialog();
        h.idInput.focus(); // first focusable
        const e = h.dispatchKeydown({ key: 'Tab', shiftKey: true });
        expect(e.defaultPrevented).toBe(true);
        expect(h.state.activeElement).toBe(h.confirmBtn); // wrapped to last
    });

    test('focus that escaped the dialog is pulled back in on Tab', () => {
        const h = buildSwitchDeviceHarness();
        h.openSwitchDeviceDialog();
        h.opener.focus(); // simulate focus leaking to a background control
        expect(h.dialog.contains(h.state.activeElement)).toBe(false);
        h.dispatchKeydown({ key: 'Tab', shiftKey: false });
        expect(h.dialog.contains(h.state.activeElement)).toBe(true);
    });

    test('closing RESTORES focus to the opener and detaches the key handler', () => {
        const h = buildSwitchDeviceHarness();
        h.openSwitchDeviceDialog();
        expect(h.state.activeElement).toBe(h.idInput);
        const keyListenersOpen = h.state.listeners.filter((l) => l.type === 'keydown').length;
        expect(keyListenersOpen).toBe(1);

        h.closeSwitchDeviceDialog();
        expect(h.state.activeElement).toBe(h.opener); // focus returned to opener
        // Trap released: no lingering keydown listener, and a stray Tab no longer traps.
        expect(h.state.listeners.filter((l) => l.type === 'keydown').length).toBe(0);
        const before = h.state.activeElement;
        h.dispatchKeydown({ key: 'Tab', shiftKey: false });
        expect(h.state.activeElement).toBe(before);
    });
});

// ─── 方案A — Rotate secret routes through the shared showConfirm ───────────────
function buildRotateHarness({ confirmResult }) {
    const showConfirm = jest.fn().mockResolvedValue(confirmResult);
    const performRotateSecret = jest.fn().mockResolvedValue(undefined);
    const maskDeviceId = (id) => (id ? id.slice(0, 8) + '…' : '');
    const i18n = { t: (k) => k }; // returns the key → helper falls back to the literal
    const documentStub = { getElementById: () => ({ style: {}, textContent: '' }) };

    const src = [
        extractFunction('openRotateSecretDialog'),
        'return { openRotateSecretDialog };',
    ].join('\n');
    const factory = new Function(
        'showConfirm', 'performRotateSecret', 'maskDeviceId', 'i18n', 'document',
        '_fullDeviceId', '_fullDeviceSecret', 'console',
        src
    );
    const api = factory(
        showConfirm, performRotateSecret, maskDeviceId, i18n, documentStub,
        'device-abcdef01-2222', 'secret-should-never-be-read-in-test', { warn() {}, error() {} }
    );
    return { ...api, showConfirm, performRotateSecret };
}

describe('settings.html Rotate Device Secret confirm — routes through showConfirm (方案A, card_dc05cb99)', () => {
    test('FAIL-ON-OLD: bespoke #rotateSecretConfirmDialog overlay is gone', () => {
        // The pristine file had a bespoke confirm overlay lacking role/aria/trap.
        // The fix removes it and delegates the CONFIRM gate to showConfirm.
        expect(html).not.toMatch(/id="rotateSecretConfirmDialog"/);
        expect(html).not.toMatch(/id="btnConfirmRotate"/);
    });

    test('FAIL-ON-OLD: openRotateSecretDialog calls showConfirm with danger:true', async () => {
        const h = buildRotateHarness({ confirmResult: true });
        await h.openRotateSecretDialog();
        expect(h.showConfirm).toHaveBeenCalledTimes(1);
        const opts = h.showConfirm.mock.calls[0][0];
        expect(opts.danger).toBe(true);
        expect(typeof opts.title).toBe('string');
        expect(typeof opts.message).toBe('string');
    });

    test('confirm=true triggers the actual rotation', async () => {
        const h = buildRotateHarness({ confirmResult: true });
        await h.openRotateSecretDialog();
        expect(h.performRotateSecret).toHaveBeenCalledTimes(1);
    });

    test('confirm=false (Cancel/Esc) does NOT rotate — the destructive side-effect is gated', async () => {
        const h = buildRotateHarness({ confirmResult: false });
        await h.openRotateSecretDialog();
        expect(h.showConfirm).toHaveBeenCalledTimes(1);
        expect(h.performRotateSecret).not.toHaveBeenCalled();
    });

    test('the reveal dialog (secret shown once) stays bespoke — copy/backup buttons preserved', () => {
        // 方案A only moves the CONFIRM gate; the reveal flow is unchanged.
        expect(html).toMatch(/id="rotateSecretRevealDialog"/);
        expect(html).toMatch(/onclick="downloadRotatedSecretBackup\(\)"/);
        expect(html).toMatch(/onclick="copyRotatedSecret\(\)"/);
    });
});
