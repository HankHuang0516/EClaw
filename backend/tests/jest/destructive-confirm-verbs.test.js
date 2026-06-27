'use strict';

/**
 * destructive-confirm-verbs — regression guard for action-specific verbs on
 * destructive confirm dialogs.
 *
 * Background (P3 UX, card-recommended option b):
 *   showConfirm({danger:true}) in backend/public/portal/shared/api.js renders
 *   the destructive OK button with a GENERIC fallback label
 *   (⚠ + t('dialog_confirm','Confirm')) whenever the caller passes no
 *   `confirmText`. Material Design / Apple HIG require destructive action
 *   buttons to use a SPECIFIC verb (Delete / Remove / Revoke / Block / Reset /
 *   Clear / Archive …) so the user — and screen-reader users (the button's
 *   aria-label is otherwise generic "Confirm destructive action") — know the
 *   consequence before committing. ~30 portal danger call-sites previously fell
 *   back to the generic label.
 *
 * This file is the anti-regression gate (per the team rule「漏掉的缺口都要有
 * testcase或CI」): every `showConfirm({ ... danger: true ... })` call-site in the
 * portal MUST pass a `confirmText`. The api.js generic fallback stays as a
 * last-resort default for non-danger confirms, but danger sites must be
 * explicit. The test exercises the FAILURE path too: a synthetic danger call
 * with no confirmText must be flagged by the same scanner the gate uses.
 *
 * jest.config.js is testEnvironment:'node'; this is a pure static-source +
 * i18n-dictionary scan, no DOM needed.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');                       // backend/
const PORTAL_DIR = path.join(ROOT, 'public', 'portal');
const API_JS = path.join(PORTAL_DIR, 'shared', 'api.js');            // implementation — excluded
const I18N_PATH = path.join(ROOT, 'public', 'shared', 'i18n.js');

// ── recursive walk for .html / .js, skipping the api.js implementation ────────
function walkPortal(dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        if (entry.name === 'node_modules' || entry.name === 'assets') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walkPortal(full));
        else if ((full.endsWith('.html') || full.endsWith('.js')) && full !== API_JS) out.push(full);
    }
    return out;
}

// ── extract every showConfirm( ... ) call argument string ─────────────────────
// Balanced-paren scan that is aware of '…' "…" and `…` string literals so that
// parens inside message strings (e.g. fullwidth （）, or `.replace('{name}', n)`)
// do not throw off the depth counter. Returns the substring from `showConfirm(`
// through its matching `)`.
function extractShowConfirmCalls(src) {
    const calls = [];
    const NEEDLE = 'showConfirm(';
    let idx = 0;
    while ((idx = src.indexOf(NEEDLE, idx)) !== -1) {
        // Guard against matching identifiers like `fooShowConfirm(` — require the
        // char before the needle to be a non-identifier char.
        const before = idx > 0 ? src[idx - 1] : ' ';
        if (/[A-Za-z0-9_$]/.test(before)) { idx += NEEDLE.length; continue; }

        let i = idx + NEEDLE.length;   // first char inside the opening paren
        let depth = 1;
        let str = null;                // current string delimiter, or null
        while (i < src.length && depth > 0) {
            const ch = src[i];
            const prev = src[i - 1];
            if (str) {
                if (ch === str && prev !== '\\') str = null;
            } else if (ch === '"' || ch === "'" || ch === '`') {
                str = ch;
            } else if (ch === '(') {
                depth++;
            } else if (ch === ')') {
                depth--;
            }
            i++;
        }
        calls.push(src.slice(idx, i));
        idx = i;
    }
    return calls;
}

const IS_DANGER_RE = /\bdanger\s*:\s*true\b/;
// Matches both `confirmText: <expr>` and the bare shorthand `confirmText` (used
// when a wrapper threads the prop through, e.g. mission.html bulkOp()).
const HAS_CONFIRMTEXT_RE = /\bconfirmText\b/;

// Returns the list of danger:true showConfirm calls in `src` that are MISSING a
// confirmText. (The gate AND the failure-path test both call this.)
function findDangerCallsMissingConfirmText(src) {
    return extractShowConfirmCalls(src).filter(
        call => IS_DANGER_RE.test(call) && !HAS_CONFIRMTEXT_RE.test(call)
    );
}

// ── load TRANSLATIONS from i18n.js (same VM technique as i18n-check.js) ────────
function loadTranslations() {
    const srcCode = fs.readFileSync(I18N_PATH, 'utf8');
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
    vm.runInContext(srcCode + '\n_result = TRANSLATIONS;', sandbox, { timeout: 8000 });
    return sandbox._result;
}

// ════════════════════════════════════════════════════════════════════════════
// 1) THE GATE — no portal danger confirm may fall back to the generic label
// ════════════════════════════════════════════════════════════════════════════
describe('destructive confirm verbs — every danger showConfirm passes confirmText', () => {
    const files = walkPortal(PORTAL_DIR);

    test('portal scan found showConfirm call-sites (scanner is wired)', () => {
        const total = files.reduce(
            (n, f) => n + extractShowConfirmCalls(fs.readFileSync(f, 'utf8')).filter(c => IS_DANGER_RE.test(c)).length,
            0
        );
        // There are ~30 danger call-sites today; a hard floor proves the scanner
        // actually traverses the portal (catches a regex/path break that would
        // otherwise make the gate vacuously pass).
        expect(total).toBeGreaterThanOrEqual(25);
    });

    test.each(walkPortal(PORTAL_DIR).map(f => [path.relative(ROOT, f), f]))(
        '%s — no danger:true confirm without a specific confirmText',
        (_rel, file) => {
            const missing = findDangerCallsMissingConfirmText(fs.readFileSync(file, 'utf8'));
            // On failure, surface the offending call so the fix is obvious.
            expect(missing).toEqual([]);
        }
    );
});

// ════════════════════════════════════════════════════════════════════════════
// 2) FAILURE-PATH PROOF — the scanner actually catches a bad call
// ════════════════════════════════════════════════════════════════════════════
describe('scanner failure path (proves the gate is not vacuous)', () => {
    test('flags a danger call with NO confirmText', () => {
        const bad = `if (!await showConfirm({ message: 'Delete it?', danger: true, itemName: x })) return;`;
        expect(findDangerCallsMissingConfirmText(bad)).toHaveLength(1);
    });

    test('passes a danger call WITH confirmText (single line)', () => {
        const good = `await showConfirm({ message: 'Delete it?', confirmText: i18n.t('common_delete'), danger: true });`;
        expect(findDangerCallsMissingConfirmText(good)).toEqual([]);
    });

    test('passes a danger call WITH confirmText (multiline)', () => {
        const good = `await showConfirm({
            message: 'Cancel this scheduled message?',
            confirmText: i18n.t('common_delete'),
            danger: true,
            itemName: id
        });`;
        expect(findDangerCallsMissingConfirmText(good)).toEqual([]);
    });

    test('passes the bare-shorthand confirmText (wrapper thread-through)', () => {
        const good = `await showConfirm({ message: confirmMsg, confirmText, danger: true });`;
        expect(findDangerCallsMissingConfirmText(good)).toEqual([]);
    });

    test('ignores NON-danger confirms (generic OK fallback is allowed there)', () => {
        const ok = `await showConfirm({ message: 'Proceed?' });`;
        expect(findDangerCallsMissingConfirmText(ok)).toEqual([]);
    });

    test('string-aware paren counting survives parens inside the message', () => {
        // fullwidth （）, an ASCII .replace('(x)', y), and a nested i18n.t(...)
        const good = `await showConfirm({ message: i18n.t('k').replace('(a)', '(b)'), confirmText: i18n.t('common_delete'), danger: true });`;
        const bad = `await showConfirm({ message: i18n.t('k').replace('(a)', '(b)'), danger: true });`;
        expect(findDangerCallsMissingConfirmText(good)).toEqual([]);
        expect(findDangerCallsMissingConfirmText(bad)).toHaveLength(1);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// 3) i18n PARITY — every verb key the danger sites use resolves in all 3 locales
// ════════════════════════════════════════════════════════════════════════════
describe('verb i18n keys exist in en / zh (ZH-Hant) / zh-CN (ZH-Hans)', () => {
    // The verbs actually referenced by the portal danger call-sites. delete /
    // remove / clear pre-existed in the dictionary; revoke / block / reset /
    // archive are added by this change.
    const VERB_KEYS = [
        'common_delete', 'common_remove', 'common_clear',
        'common_revoke', 'common_block', 'common_reset', 'common_archive',
    ];
    let T;
    beforeAll(() => { T = loadTranslations(); });

    test.each(['en', 'zh', 'zh-CN'])('locale "%s" has every verb key non-empty', (loc) => {
        expect(T[loc]).toBeDefined();
        for (const k of VERB_KEYS) {
            expect(typeof T[loc][k]).toBe('string');
            expect(T[loc][k].trim().length).toBeGreaterThan(0);
        }
    });

    test('newly-added verbs are genuinely Traditional ≠ Simplified', () => {
        // (common_clear is 清除 in both — identical glyphs — so it is excluded.)
        for (const k of ['common_revoke', 'common_block', 'common_reset', 'common_archive']) {
            expect(T.zh[k]).not.toBe(T['zh-CN'][k]);
        }
    });
});
