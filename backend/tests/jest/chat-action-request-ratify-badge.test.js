/**
 * chat-action-request-ratify-badge — tests for the 計畫E ratify-loop per-item
 * badge on the "需要你" action-request inbox (card_e9d01b6e, frontend).
 *
 * Three layers:
 *   1. i18n parity — the 7 new keys exist (non-empty) in ALL three locales the
 *      app ships Chinese in: en, zh (Traditional / ZH-Hant canonical), zh-CN
 *      (Simplified / ZH-Hans), with genuine Traditional≠Simplified text.
 *   2. static-source guards — the render gates on the device pref, the badge is
 *      built XSS-safe (textContent / DOM nodes, NO innerHTML), the CSS classes
 *      exist, and the function/keys are wired (mirrors dashboard-page-ui.test.js
 *      style for code that is awkward to fully execute).
 *   3. behavioral — buildRatifyBadge() is extracted out of chat.html (it has no
 *      module export, same brace-count technique as
 *      chat-action-request-inbox-behavior.test.js) and executed against a tiny
 *      DOM shim: default_agree → amber badge + live countdown to (armedAt+grace);
 *      hold → calm 核可 badge; a missing / unarmed / pref-OFF ratify → NO badge;
 *      an already-elapsed default_agree → terminal "sending" state.
 *
 * jest.config.js is testEnvironment:'node' (no jsdom) — same as the sibling
 * behavior test, so we hand-roll the minimal DOM the badge builder touches.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const CHAT_HTML_PATH = path.join(ROOT, 'public', 'portal', 'chat.html');
const I18N_PATH = path.join(ROOT, 'public', 'shared', 'i18n.js');
const chatHtml = fs.readFileSync(CHAT_HTML_PATH, 'utf8');

const NEW_I18N_KEYS = [
    'action_request_ratify_default_agree_badge',
    'action_request_ratify_default_agree_hint',
    'action_request_ratify_countdown_prefix',
    'action_request_ratify_sending',
    'action_request_ratify_hold_badge',
    'action_request_ratify_hold_hint',
    'action_request_recommended_badge_title',
];

// ── Load TRANSLATIONS out of i18n.js (same VM technique as i18n-fallback-chain) ─
function loadTranslations() {
    const src = fs.readFileSync(I18N_PATH, 'utf8');
    const noop = () => {};
    const sandbox = {
        _result: null,
        localStorage: { getItem: () => null, setItem: noop },
        navigator: { language: 'en' },
        document: { querySelectorAll: () => [], documentElement: { lang: 'en' }, addEventListener: noop, getElementById: () => null },
        window: { location: { search: '' } },
        setTimeout: noop,
        console: { log: noop, warn: noop, error: noop },
    };
    vm.createContext(sandbox);
    vm.runInContext(src + '\n_result = TRANSLATIONS;', sandbox, { timeout: 8000 });
    return sandbox._result;
}

// ── brace-count a top-level function body out of chat.html (no module export) ──
function extractFunction(name) {
    const re = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\([^)]*\\)\\s*\\{`, 'g');
    const m = re.exec(chatHtml);
    if (!m) throw new Error(`function ${name} not found in chat.html`);
    let depth = 1;
    let i = m.index + m[0].length;
    while (i < chatHtml.length && depth > 0) {
        const ch = chatHtml[i];
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
        i++;
    }
    return chatHtml.slice(m.index, i);
}

// ── minimal DOM shim (only what buildRatifyBadge touches) ─────────────────────
function makeEl(tag) {
    const el = { tagName: String(tag || 'div').toUpperCase(), _class: '', _text: '', attrs: {}, children: [], parent: null };
    Object.defineProperty(el, 'className', { get() { return el._class; }, set(v) { el._class = String(v); } });
    Object.defineProperty(el, 'textContent', {
        get() { return el._text; },
        set(v) { el._text = String(v); el.children.length = 0; },
    });
    el.classList = {
        add(c) { const s = new Set(el._class.split(/\s+/).filter(Boolean)); s.add(c); el._class = Array.from(s).join(' '); },
        remove(c) { const s = new Set(el._class.split(/\s+/).filter(Boolean)); s.delete(c); el._class = Array.from(s).join(' '); },
        contains(c) { return el._class.split(/\s+/).filter(Boolean).indexOf(c) !== -1; },
    };
    el.setAttribute = (k, v) => { el.attrs[k] = String(v); };
    el.getAttribute = (k) => (Object.prototype.hasOwnProperty.call(el.attrs, k) ? el.attrs[k] : null);
    el.removeAttribute = (k) => { delete el.attrs[k]; };
    el.appendChild = (c) => { c.parent = el; el.children.push(c); return c; };
    el.querySelector = (sel) => {
        const want = sel.replace(/^\./, '');
        const stack = el.children.slice();
        while (stack.length) { const n = stack.shift(); if (n.classList && n.classList.contains(want)) return n; stack.push(...n.children); }
        return null;
    };
    return el;
}
function findByClass(root, cls) {
    const stack = root.children.slice();
    while (stack.length) { const n = stack.shift(); if (n.classList && n.classList.contains(cls)) return n; stack.unshift(...n.children); }
    return null;
}

function makeBadgeBuilder() {
    const documentShim = { createElement: (t) => makeEl(t) };
    // actionRequestT stub: return a token so we can prove the i18n key is wired.
    const tStub = (key /*, fallback, vars */) => '[' + key + ']';
    const body = `
        const RATIFY_DEFAULT_GRACE_MINUTES = 1440;
        ${extractFunction('_schedFmtCountdown')}
        ${extractFunction('buildRatifyBadge')}
        return { buildRatifyBadge };
    `;
    /* eslint-disable no-new-func */
    const factory = new Function('document', 'actionRequestT', body);
    return factory(documentShim, tStub).buildRatifyBadge;
}

const GRACE_MIN = 1440;
const GRACE_MS = GRACE_MIN * 60 * 1000;

// ════════════════════════════════════════════════════════════════════════════
// 1) i18n parity — all 7 keys in en + zh + zh-CN, genuine 繁/简 distinction
// ════════════════════════════════════════════════════════════════════════════
describe('i18n — ratify badge keys exist in all 3 locales (en / zh-Hant / zh-Hans)', () => {
    let T;
    beforeAll(() => { T = loadTranslations(); });

    test.each(['en', 'zh', 'zh-CN'])('locale "%s" has every new key with a non-empty string', (loc) => {
        expect(T[loc]).toBeDefined();
        for (const k of NEW_I18N_KEYS) {
            expect(typeof T[loc][k]).toBe('string');
            expect(T[loc][k].trim().length).toBeGreaterThan(0);
        }
    });

    test('zh (Traditional) and zh-CN (Simplified) are genuinely different copy', () => {
        // 追認/认 + 倒數/倒计时 differ between Traditional and Simplified.
        expect(T['zh']['action_request_ratify_default_agree_badge'])
            .not.toBe(T['zh-CN']['action_request_ratify_default_agree_badge']);
        expect(T['zh']['action_request_ratify_default_agree_hint'])
            .not.toBe(T['zh-CN']['action_request_ratify_default_agree_hint']);
        // English is distinct from both Chinese variants.
        expect(T['en']['action_request_ratify_default_agree_badge'])
            .not.toBe(T['zh']['action_request_ratify_default_agree_badge']);
    });

    test('the spec copy lands verbatim: default_agree = 靜默視同同意, hold = 需你核可 (zh)', () => {
        expect(T['zh']['action_request_ratify_default_agree_badge']).toContain('靜默視同同意');
        expect(T['zh']['action_request_ratify_hold_badge']).toBe('需你核可');
        expect(T['zh-CN']['action_request_ratify_default_agree_badge']).toContain('静默视同同意');
    });
});

// ════════════════════════════════════════════════════════════════════════════
// 2) static-source guards (pref gate, XSS-safety, CSS classes, wiring)
// ════════════════════════════════════════════════════════════════════════════
describe('chat.html — ratify badge source guards', () => {
    test('buildRatifyBadge + the countdown ticker functions are defined', () => {
        expect(chatHtml).toMatch(/function buildRatifyBadge\(ratify, opts\)/);
        expect(chatHtml).toMatch(/function _ratifyEnsureCountdownTicker\(\)/);
        expect(chatHtml).toMatch(/function _ratifyTickCountdowns\(\)/);
    });

    test('render gates the badge on the device pref (action_request_ratify_enabled)', () => {
        expect(chatHtml).toContain('actionRequestRatifyEnabled = prefs.action_request_ratify_enabled === true;');
        // The pref mirror feeds the render gate `ratifyOn`.
        expect(chatHtml).toMatch(/const ratifyOn = .*actionRequestRatifyEnabled === true;/);
        expect(chatHtml).toContain('if (ratifyOn && dc && dc.ratify) {');
        // buildRatifyBadge itself fails closed when not enabled.
        expect(chatHtml).toContain('if (o.enabled !== true) return null;');
    });

    test('badge is built XSS-safe — textContent/DOM only, no innerHTML in the badge code', () => {
        const fn = extractFunction('buildRatifyBadge');
        expect(fn).toContain('document.createElement');
        expect(fn).toContain('.textContent');
        expect(fn).not.toContain('innerHTML');
        expect(fn).not.toContain('insertAdjacentHTML');
        const tick = extractFunction('_ratifyTickCountdowns');
        expect(tick).not.toContain('innerHTML');
    });

    test('the CSS classes for default_agree / hold / sending / countdown exist', () => {
        expect(chatHtml).toContain('.action-request-ratify.is-default-agree');
        expect(chatHtml).toContain('.action-request-ratify.is-hold');
        expect(chatHtml).toContain('.action-request-ratify.is-sending');
        expect(chatHtml).toContain('.action-request-ratify-countdown');
    });

    test('recommended pill carries a record-only clarifier (distinct from auto-send)', () => {
        expect(chatHtml).toContain("t('action_request_recommended_badge_title'");
    });

    test('the countdown ticker self-clears (no interval leak)', () => {
        const ensure = extractFunction('_ratifyEnsureCountdownTicker');
        expect(ensure).toContain("document.querySelector('[data-ratify-deadline]')");
        const tick = extractFunction('_ratifyTickCountdowns');
        expect(tick).toContain('clearInterval(_ratifyCountdownTicker)');
    });
});

// ════════════════════════════════════════════════════════════════════════════
// 3) behavioral — buildRatifyBadge() executed against the DOM shim
// ════════════════════════════════════════════════════════════════════════════
describe('buildRatifyBadge() — runtime behavior', () => {
    let build;
    beforeAll(() => { build = makeBadgeBuilder(); });

    test('default_agree (armed) → amber badge + live countdown to armedAt+grace', () => {
        const armedAt = 1_700_000_000_000;
        const now = armedAt + 1000; // 1s after arming → ~grace remaining
        const badge = build({ mode: 'default_agree', armedAt, planE: true }, { enabled: true, graceMinutes: GRACE_MIN, now });

        expect(badge).not.toBeNull();
        expect(badge.classList.contains('action-request-ratify')).toBe(true);
        expect(badge.classList.contains('is-default-agree')).toBe(true);
        expect(badge.classList.contains('is-sending')).toBe(false);
        expect(badge.getAttribute('role')).toBe('status');

        // title uses the default_agree i18n key
        const title = findByClass(badge, 'action-request-ratify-title');
        expect(title._text).toBe('[action_request_ratify_default_agree_badge]');

        // countdown carries the deadline anchored to armedAt + grace
        const cd = findByClass(badge, 'action-request-ratify-countdown');
        expect(cd).not.toBeNull();
        expect(cd.getAttribute('data-ratify-deadline')).toBe(String(armedAt + GRACE_MS));
        expect(cd.getAttribute('aria-hidden')).toBe('true');
        const clock = findByClass(badge, 'ar-ratify-cd-clock');
        expect(clock._text).toMatch(/^\d{1,2}:\d{2}:\d{2}$/); // HH:MM:SS remaining

        // the unmistakable "doing nothing sends it" hint
        const hint = findByClass(badge, 'action-request-ratify-hint');
        expect(hint._text).toBe('[action_request_ratify_default_agree_hint]');
    });

    test('default_agree past its deadline → terminal "sending" state, no live ticker node', () => {
        const armedAt = 1_700_000_000_000;
        const now = armedAt + GRACE_MS + 5000; // already elapsed
        const badge = build({ mode: 'default_agree', armedAt }, { enabled: true, graceMinutes: GRACE_MIN, now });

        expect(badge).not.toBeNull();
        expect(badge.classList.contains('is-sending')).toBe(true);
        const cd = findByClass(badge, 'action-request-ratify-countdown');
        // elapsed → deadline attribute removed so the ticker skips it (no leak)
        expect(cd.getAttribute('data-ratify-deadline')).toBeNull();
        const clock = findByClass(badge, 'ar-ratify-cd-clock');
        expect(clock._text).toBe('[action_request_ratify_sending]');
    });

    test('hold → calm 核可 badge, no countdown', () => {
        const badge = build({ mode: 'hold', armedAt: null }, { enabled: true, graceMinutes: GRACE_MIN, now: Date.now() });
        expect(badge).not.toBeNull();
        expect(badge.classList.contains('is-hold')).toBe(true);
        expect(badge.classList.contains('is-default-agree')).toBe(false);
        const title = findByClass(badge, 'action-request-ratify-title');
        expect(title._text).toBe('[action_request_ratify_hold_badge]');
        // hold never shows a countdown
        expect(findByClass(badge, 'action-request-ratify-countdown')).toBeNull();
        const hint = findByClass(badge, 'action-request-ratify-hint');
        expect(hint._text).toBe('[action_request_ratify_hold_hint]');
    });

    test('pref OFF (enabled !== true) → NO badge', () => {
        const armedAt = 1_700_000_000_000;
        const ratify = { mode: 'default_agree', armedAt };
        expect(build(ratify, { enabled: false, graceMinutes: GRACE_MIN, now: armedAt + 1000 })).toBeNull();
        expect(build(ratify, { graceMinutes: GRACE_MIN, now: armedAt + 1000 })).toBeNull(); // enabled omitted
    });

    test('missing / partial / unarmed ratify → NO badge', () => {
        const now = Date.now();
        expect(build(null, { enabled: true, graceMinutes: GRACE_MIN, now })).toBeNull();
        expect(build(undefined, { enabled: true, graceMinutes: GRACE_MIN, now })).toBeNull();
        expect(build([], { enabled: true, graceMinutes: GRACE_MIN, now })).toBeNull(); // array, not plain obj
        expect(build({}, { enabled: true, graceMinutes: GRACE_MIN, now })).toBeNull(); // no mode
        expect(build({ mode: 'bogus' }, { enabled: true, graceMinutes: GRACE_MIN, now })).toBeNull();
        // default_agree WITHOUT a server-stamped armedAt → not armed yet → no badge
        expect(build({ mode: 'default_agree' }, { enabled: true, graceMinutes: GRACE_MIN, now })).toBeNull();
        expect(build({ mode: 'default_agree', armedAt: null }, { enabled: true, graceMinutes: GRACE_MIN, now })).toBeNull();
        expect(build({ mode: 'default_agree', armedAt: 0 }, { enabled: true, graceMinutes: GRACE_MIN, now })).toBeNull();
    });
});
