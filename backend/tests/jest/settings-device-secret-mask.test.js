/**
 * Regression guard for the settings.html Device Secret display (card_c7917c15).
 *
 * BUG: the Account card rendered the Device Secret as PARTIAL PLAINTEXT in the
 * DOM (first 8 + last 4 chars, `maskSecret` = s.substring(0,8) + '…' +
 * s.slice(-4)) with no way to hide it — a standing shoulder-surf /
 * screenshot / screen-share leak surface (E2E evidence shots needed manual
 * DOM-redaction before archiving).
 *
 * FIX: display is FULLY masked by default (fixed-width dots — leaks neither
 * content nor length), with a 👁 click-to-reveal button that auto re-masks
 * after ~10s and whenever the window blurs / tab hides. The copy buttons keep
 * copying the real value from the in-memory variable.
 *
 * This test extracts the REAL functions from settings.html (like
 * mission-note-link-active-entity.test.js) and drives them against stubbed
 * DOM/clipboard/timers, so it fails on the old partial-plaintext rendering
 * and passes on the masked-by-default one.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const SETTINGS_HTML = path.resolve(__dirname, '../../public/portal/settings.html');
const html = fs.readFileSync(SETTINGS_HTML, 'utf8');

// A fake secret for the harness — never a real credential.
const FAKE_SECRET = 'aaaabbbbccccddddeeeeffff11112222';

// Extract an exact `function <name>(...) { ... }` block from settings.html so
// the test exercises the shipped source, not a copy. Functions in the inline
// script are 8-space indented; every body line is indented 12+ spaces, so the
// first `\n        }` after the declaration is the terminator.
function extractFunction(name) {
    let start = html.indexOf(`function ${name}(`);
    if (start === -1) throw new Error(`settings.html: function ${name} not found`);
    // Include a leading `async ` if present.
    const asyncPrefix = 'async ';
    if (html.slice(start - asyncPrefix.length, start) === asyncPrefix) start -= asyncPrefix.length;
    const end = html.indexOf('\n        }', start);
    if (end === -1) throw new Error(`settings.html: ${name} terminator not found`);
    return html.slice(start, end + '\n        }'.length);
}

function extractConst(name) {
    const m = html.match(new RegExp(`const ${name} = [^\\n]+;`));
    if (!m) throw new Error(`settings.html: const ${name} not found`);
    return m[0];
}

// Instantiate the real functions with their free identifiers shadowed by stubs.
function buildHarness({ fullSecret = FAKE_SECRET } = {}) {
    const secretEl = { textContent: '--', dataset: {} };
    const btn = {
        textContent: '👁',
        attrs: {},
        setAttribute(k, v) { this.attrs[k] = v; },
    };
    const documentStub = {
        getElementById: (id) => {
            if (id === 'accountDeviceSecret') return secretEl;
            if (id === 'btnRevealDeviceSecret') return btn;
            return null;
        },
    };
    const timers = [];
    const setTimeoutStub = jest.fn((cb, ms) => { timers.push({ cb, ms }); return timers.length; });
    const clearTimeoutStub = jest.fn();
    const writeText = jest.fn().mockResolvedValue(undefined);
    const showCopyToast = jest.fn();

    const src = [
        'let _secretRemaskTimer = null;',
        extractConst('DEVICE_SECRET_MASK'),
        extractConst('DEVICE_SECRET_REVEAL_MS'),
        extractFunction('maskSecret'),
        extractFunction('setDeviceSecretVisible'),
        extractFunction('toggleDeviceSecretReveal'),
        extractFunction('remaskDeviceSecretOnBlur'),
        extractFunction('copyDeviceSecret'),
        'return { maskSecret, setDeviceSecretVisible, toggleDeviceSecretReveal, remaskDeviceSecretOnBlur, copyDeviceSecret, DEVICE_SECRET_REVEAL_MS };',
    ].join('\n');

    const factory = new Function(
        '_fullDeviceSecret', 'document', 'setTimeout', 'clearTimeout',
        'navigator', 'showCopyToast', 'console',
        src
    );
    const api = factory(
        fullSecret,
        documentStub,
        setTimeoutStub,
        clearTimeoutStub,
        { clipboard: { writeText } },
        showCopyToast,
        { error: jest.fn() }
    );
    return { ...api, secretEl, btn, timers, setTimeoutStub, clearTimeoutStub, writeText, showCopyToast };
}

describe('settings.html Device Secret is fully masked by default (card_c7917c15)', () => {
    test('FAIL-ON-OLD: masked display leaks no plaintext fragment of the secret', () => {
        const { maskSecret } = buildHarness();
        const masked = maskSecret(FAKE_SECRET);
        // Old code returned first-8 + dots + last-4 here.
        expect(masked).not.toContain(FAKE_SECRET.substring(0, 8));
        expect(masked).not.toContain(FAKE_SECRET.slice(-4));
        expect(masked).not.toContain(FAKE_SECRET);
        // Fixed-width dots: independent of the secret's content AND length.
        expect(masked).toBe(maskSecret('x'.repeat(64)));
        expect(masked).toMatch(/^[•]+$/);
    });

    test('FAIL-ON-OLD: the Account row has a click-to-reveal button', () => {
        expect(html).toContain('id="btnRevealDeviceSecret"');
        expect(html).toContain('onclick="toggleDeviceSecretReveal()"');
    });

    test('FAIL-ON-OLD: no DOM sink assigns maskSecret() partial output directly', () => {
        // Old code had two of these (initial load + after rotate); both must go
        // through setDeviceSecretVisible(false) now.
        expect(html).not.toMatch(/getElementById\('accountDeviceSecret'\)\.textContent = maskSecret\(/);
    });

    test('default state renders the mask, not the secret', () => {
        const { setDeviceSecretVisible, secretEl, btn } = buildHarness();
        setDeviceSecretVisible(false);
        expect(secretEl.textContent).not.toContain(FAKE_SECRET.substring(0, 8));
        expect(secretEl.textContent).toMatch(/^[•]+$/);
        expect(secretEl.dataset.revealed).toBe('false');
        expect(btn.attrs['aria-pressed']).toBe('false');
    });

    test('click-to-reveal shows the secret and schedules an ~10s auto re-mask', () => {
        const h = buildHarness();
        h.setDeviceSecretVisible(false);
        h.toggleDeviceSecretReveal();
        expect(h.secretEl.textContent).toBe(FAKE_SECRET);
        expect(h.secretEl.dataset.revealed).toBe('true');
        expect(h.btn.attrs['aria-pressed']).toBe('true');
        // An auto re-mask timer is armed for ~10 seconds.
        expect(h.timers.length).toBe(1);
        expect(h.timers[0].ms).toBe(h.DEVICE_SECRET_REVEAL_MS);
        expect(h.timers[0].ms).toBeGreaterThanOrEqual(5000);
        expect(h.timers[0].ms).toBeLessThanOrEqual(15000);
        // Firing the timer re-masks.
        h.timers[0].cb();
        expect(h.secretEl.textContent).toMatch(/^[•]+$/);
        expect(h.secretEl.dataset.revealed).toBe('false');
    });

    test('second click re-masks immediately and cancels the pending timer', () => {
        const h = buildHarness();
        h.setDeviceSecretVisible(false);
        h.toggleDeviceSecretReveal(); // reveal
        h.toggleDeviceSecretReveal(); // hide
        expect(h.secretEl.textContent).toMatch(/^[•]+$/);
        expect(h.secretEl.dataset.revealed).toBe('false');
        expect(h.clearTimeoutStub).toHaveBeenCalled();
    });

    test('window blur re-masks a revealed secret (and is a no-op when masked)', () => {
        const h = buildHarness();
        h.setDeviceSecretVisible(false);
        h.remaskDeviceSecretOnBlur(); // masked → no-op
        expect(h.secretEl.textContent).toMatch(/^[•]+$/);
        h.toggleDeviceSecretReveal();
        expect(h.secretEl.textContent).toBe(FAKE_SECRET);
        h.remaskDeviceSecretOnBlur(); // revealed → re-mask
        expect(h.secretEl.textContent).toMatch(/^[•]+$/);
        // The handler is actually registered on blur + tab-hide.
        expect(html).toContain("window.addEventListener('blur', remaskDeviceSecretOnBlur)");
        expect(html).toMatch(/visibilitychange.*remaskDeviceSecretOnBlur/);
    });

    test('copy button still copies the REAL secret while the display is masked', async () => {
        const h = buildHarness();
        h.setDeviceSecretVisible(false);
        await h.copyDeviceSecret();
        expect(h.writeText).toHaveBeenCalledWith(FAKE_SECRET);
        expect(h.showCopyToast).toHaveBeenCalled();
        // Copying must not reveal the DOM value.
        expect(h.secretEl.textContent).toMatch(/^[•]+$/);
    });

    test('empty secret renders -- and reveal is inert', () => {
        const h = buildHarness({ fullSecret: '' });
        h.setDeviceSecretVisible(false);
        expect(h.secretEl.textContent).toBe('--');
        h.toggleDeviceSecretReveal();
        expect(h.secretEl.textContent).toBe('--');
        expect(h.secretEl.dataset.revealed).toBe('false');
    });
});
