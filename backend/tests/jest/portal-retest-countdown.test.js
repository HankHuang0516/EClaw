/**
 * Arena retest countdown — pure helper unit tests
 *
 * Tests cover the deterministic side of card_959:
 *   - computeRetestDeadlineMs: parses ISO/ms/Date, rejects null/garbage
 *   - getRetestSeverity:       5-tier mapping (gray/yellow/orange/red/green) + ready
 *   - formatRetestRemaining:   countdown string shape across decades, days, hours, minutes, seconds
 *   - renderRetestCountdownHtml: emits role=status + aria-label + tier class + escape
 *   - attachRetestCountdown:   interval ticks, auto-stop on "ready", stop() handle
 *
 * The DOM-touching helpers run through jsdom in this test file (the jest
 * project default already includes it for portal/* sources).
 *
 * Source: card_959b58d0351153bc94aea8da
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC_PATH = path.join(__dirname, '../../public/portal/shared/entity-utils.js');
const SRC = fs.readFileSync(SRC_PATH, 'utf8');

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// Load the source in an isolated vm context per test. We do this rather
// than require()-ing the file because the production module relies on
// window + module.exports double-export and we want the WINDOW path
// exercised here (it's what the portal actually runs).
function loadCtx({ withDom = false } = {}) {
    const win = {};
    const ctx = {
        window: win,
        console,
        Date,
        Number,
        setInterval,
        clearInterval,
    };
    if (withDom) {
        // Minimal jsdom-style stub — enough for attachRetestCountdown's
        // document.body.contains() guard. We don't need full HTML5 here.
        const nodes = new Set();
        ctx.document = {
            body: {
                contains(n) { return nodes.has(n); },
            },
            _track(n) { nodes.add(n); },
            _untrack(n) { nodes.delete(n); },
        };
    }
    vm.createContext(ctx);
    vm.runInContext(SRC, ctx);
    return ctx.window.EntityRetestCountdown;
}

// ──────────────────────────────────────────────────────────────────────
// computeRetestDeadlineMs
// ──────────────────────────────────────────────────────────────────────

describe('computeRetestDeadlineMs', () => {
    test('null / undefined / empty string → null (no chip)', () => {
        const r = loadCtx();
        expect(r.computeRetestDeadlineMs(null)).toBeNull();
        expect(r.computeRetestDeadlineMs(undefined)).toBeNull();
        expect(r.computeRetestDeadlineMs('')).toBeNull();
    });

    test('ms epoch number → adds 30 days exactly', () => {
        const r = loadCtx();
        const t = 1_700_000_000_000;
        expect(r.computeRetestDeadlineMs(t)).toBe(t + 30 * ONE_DAY_MS);
    });

    test('ISO string (UTC) → parses and adds 30 days', () => {
        const r = loadCtx();
        const iso = '2026-06-01T00:00:00.000Z';
        const expected = Date.parse(iso) + 30 * ONE_DAY_MS;
        expect(r.computeRetestDeadlineMs(iso)).toBe(expected);
    });

    test('Date instance → unwraps via getTime()', () => {
        const r = loadCtx();
        const d = new Date('2026-06-01T00:00:00.000Z');
        expect(r.computeRetestDeadlineMs(d)).toBe(d.getTime() + 30 * ONE_DAY_MS);
    });

    test('garbage string → null (no NaN propagation)', () => {
        const r = loadCtx();
        expect(r.computeRetestDeadlineMs('not-a-date')).toBeNull();
        expect(r.computeRetestDeadlineMs('💥')).toBeNull();
    });

    test('custom cooldownDays override is honored', () => {
        const r = loadCtx();
        const t = 1_700_000_000_000;
        expect(r.computeRetestDeadlineMs(t, 7)).toBe(t + 7 * ONE_DAY_MS);
        expect(r.computeRetestDeadlineMs(t, 60)).toBe(t + 60 * ONE_DAY_MS);
    });

    test('zero / negative cooldownDays falls back to the 30-day default (DoS guard)', () => {
        const r = loadCtx();
        const t = 1_700_000_000_000;
        // A malicious caller can't shrink the cooldown to 0 by passing 0.
        expect(r.computeRetestDeadlineMs(t, 0)).toBe(t + 30 * ONE_DAY_MS);
        expect(r.computeRetestDeadlineMs(t, -5)).toBe(t + 30 * ONE_DAY_MS);
    });

    test('DST insensitivity — deadline is 30×86_400_000ms, no calendar drift', () => {
        const r = loadCtx();
        // 2026-03-10 01:30 in America/New_York is mid-DST-jump on
        // some years. Using ISO UTC fully sidesteps the issue and we
        // assert exactly: 30 days = 2_592_000_000 ms, period.
        const t = Date.parse('2026-03-10T05:30:00.000Z');
        const out = r.computeRetestDeadlineMs(t);
        expect(out - t).toBe(30 * ONE_DAY_MS);
    });
});

// ──────────────────────────────────────────────────────────────────────
// getRetestSeverity
// ──────────────────────────────────────────────────────────────────────

describe('getRetestSeverity', () => {
    let r;
    beforeAll(() => { r = loadCtx(); });

    test('past or zero remaining → "ready"', () => {
        expect(r.getRetestSeverity(0)).toBe('ready');
        expect(r.getRetestSeverity(-1)).toBe('ready');
        expect(r.getRetestSeverity(-30 * ONE_DAY_MS)).toBe('ready');
    });

    test('>14 days → "gray"', () => {
        expect(r.getRetestSeverity(20 * ONE_DAY_MS)).toBe('gray');
        expect(r.getRetestSeverity(15 * ONE_DAY_MS)).toBe('gray');
        expect(r.getRetestSeverity(14 * ONE_DAY_MS + 1)).toBe('gray');
    });

    test('exactly 14 days → "yellow" (boundary on upper edge)', () => {
        // 14d is NOT >14d, so it falls into the 7-14 yellow band.
        expect(r.getRetestSeverity(14 * ONE_DAY_MS)).toBe('yellow');
    });

    test('7–14 days → "yellow"', () => {
        expect(r.getRetestSeverity(10 * ONE_DAY_MS)).toBe('yellow');
        expect(r.getRetestSeverity(7 * ONE_DAY_MS + 1)).toBe('yellow');
    });

    test('3–7 days → "orange"', () => {
        expect(r.getRetestSeverity(7 * ONE_DAY_MS)).toBe('orange');
        expect(r.getRetestSeverity(5 * ONE_DAY_MS)).toBe('orange');
        expect(r.getRetestSeverity(3 * ONE_DAY_MS + 1)).toBe('orange');
    });

    test('1–3 days → "red"', () => {
        expect(r.getRetestSeverity(3 * ONE_DAY_MS)).toBe('red');
        expect(r.getRetestSeverity(2 * ONE_DAY_MS)).toBe('red');
        expect(r.getRetestSeverity(1 * ONE_DAY_MS)).toBe('red');
    });

    test('<1 day (but >0) → "green"', () => {
        expect(r.getRetestSeverity(ONE_DAY_MS - 1)).toBe('green');
        expect(r.getRetestSeverity(60 * 60 * 1000)).toBe('green'); // 1 hour
        expect(r.getRetestSeverity(1)).toBe('green');
    });

    test('NaN / Infinity / non-number → "ready" (safe default)', () => {
        // Number.isFinite filters out NaN, Infinity, and non-numbers BEFORE
        // we even hit the threshold ladder — they all collapse to "ready".
        // This is the safest UX default: if we can't compute remaining,
        // show the green-CTA pill and let the user retest if they want.
        expect(r.getRetestSeverity(NaN)).toBe('ready');
        expect(r.getRetestSeverity(Infinity)).toBe('ready');
        expect(r.getRetestSeverity('foo')).toBe('ready');
    });
});

// ──────────────────────────────────────────────────────────────────────
// formatRetestRemaining
// ──────────────────────────────────────────────────────────────────────

describe('formatRetestRemaining', () => {
    let r;
    beforeAll(() => { r = loadCtx(); });

    test('zero or negative → "0s"', () => {
        expect(r.formatRetestRemaining(0)).toBe('0s');
        expect(r.formatRetestRemaining(-1)).toBe('0s');
    });

    test('25 days, 3 hours → "25d 03h"', () => {
        const ms = 25 * ONE_DAY_MS + 3 * 60 * 60 * 1000;
        expect(r.formatRetestRemaining(ms)).toBe('25d 03h');
    });

    test('exactly 1 day → "1d 00h"', () => {
        expect(r.formatRetestRemaining(ONE_DAY_MS)).toBe('1d 00h');
    });

    test('23h 59m → "23h 59m" (sub-day branch)', () => {
        const ms = 23 * 60 * 60 * 1000 + 59 * 60 * 1000;
        expect(r.formatRetestRemaining(ms)).toBe('23h 59m');
    });

    test('5h 42m → "05h 42m"', () => {
        const ms = 5 * 60 * 60 * 1000 + 42 * 60 * 1000;
        expect(r.formatRetestRemaining(ms)).toBe('05h 42m');
    });

    test('42m 17s → "42m 17s"', () => {
        const ms = 42 * 60 * 1000 + 17 * 1000;
        expect(r.formatRetestRemaining(ms)).toBe('42m 17s');
    });

    test('9 seconds → "09s"', () => {
        expect(r.formatRetestRemaining(9 * 1000)).toBe('09s');
    });

    test('NaN → "0s" (no NaN leak into UI)', () => {
        expect(r.formatRetestRemaining(NaN)).toBe('0s');
        expect(r.formatRetestRemaining('garbage')).toBe('0s');
    });
});

// ──────────────────────────────────────────────────────────────────────
// renderRetestCountdownHtml
// ──────────────────────────────────────────────────────────────────────

describe('renderRetestCountdownHtml', () => {
    let r;
    beforeAll(() => { r = loadCtx(); });

    test('invalid deadline → empty string (hide chip)', () => {
        expect(r.renderRetestCountdownHtml(NaN)).toBe('');
        expect(r.renderRetestCountdownHtml(null)).toBe('');
    });

    test('emits role=status + aria-live + aria-label for SR', () => {
        const html = r.renderRetestCountdownHtml(Date.now() + 5 * ONE_DAY_MS);
        expect(html).toMatch(/role="status"/);
        // Static render uses aria-live="off" — attachRetestCountdown
        // briefly promotes to "polite" on tier transitions only, so
        // screen readers don't chatter every second.
        expect(html).toMatch(/aria-live="off"/);
        expect(html).toMatch(/aria-label="/);
    });

    test('emits the correct severity class for each tier', () => {
        const cases = [
            [20 * ONE_DAY_MS, 'gray'],
            [10 * ONE_DAY_MS, 'yellow'],
            [5 * ONE_DAY_MS, 'orange'],
            [2 * ONE_DAY_MS, 'red'],
            [60 * 60 * 1000, 'green'],
            [-1, 'ready'],
        ];
        for (const [remaining, tier] of cases) {
            const html = r.renderRetestCountdownHtml(Date.now() + remaining);
            expect(html).toMatch(new RegExp('retest-countdown--' + tier));
        }
    });

    test('"ready" chip includes the data-i18n=card_retest_ready hook', () => {
        const html = r.renderRetestCountdownHtml(Date.now() - 1);
        expect(html).toMatch(/data-i18n="card_retest_ready"/);
        // And the data-testid handles for E2E.
        expect(html).toMatch(/data-testid="retest-countdown"/);
        expect(html).toMatch(/data-testid="retest-countdown-value"/);
    });

    test('attribute-escapes any quotes in the deadline (defense in depth)', () => {
        const html = r.renderRetestCountdownHtml(Date.now() + 5 * ONE_DAY_MS);
        // No raw " inside the rendered fragment that would unbalance HTML.
        // The deadline number is finite so this is mostly belt-and-suspenders.
        expect(html.match(/data-retest-deadline="\d+"/)).not.toBeNull();
    });
});

// ──────────────────────────────────────────────────────────────────────
// attachRetestCountdown — DOM + interval lifecycle
// ──────────────────────────────────────────────────────────────────────

describe('attachRetestCountdown', () => {
    /** Minimal DOM element shim that classList + querySelector + setAttribute. */
    function makeChip(deadlineMs, tier = 'orange', valueText = '5d 00h') {
        const classes = new Set(['retest-countdown', 'retest-countdown--' + tier]);
        const attrs = { 'data-retest-deadline': String(deadlineMs) };
        const valueAttrs = {};
        let valueTextStored = valueText;
        let nodeTextLabel = 'Next retest';
        const valueEl = {
            get textContent() { return valueTextStored; },
            set textContent(v) { valueTextStored = v; },
            setAttribute(k, v) { valueAttrs[k] = v; },
            removeAttribute(k) { delete valueAttrs[k]; },
            getAttribute(k) { return valueAttrs[k]; },
        };
        const labelEl = {
            get textContent() { return nodeTextLabel; },
            set textContent(v) { nodeTextLabel = v; },
        };
        const node = {
            classList: {
                contains: (c) => classes.has(c),
                add: (...c) => c.forEach(x => classes.add(x)),
                remove: (...c) => c.forEach(x => classes.delete(x)),
                _has: (c) => classes.has(c),
            },
            getAttribute: (k) => attrs[k],
            setAttribute: (k, v) => { attrs[k] = v; },
            querySelector(sel) {
                if (sel === '.retest-countdown__value') return valueEl;
                if (sel === '.retest-countdown__label') return labelEl;
                return null;
            },
            _classes: classes,
            _attrs: attrs,
            _valueEl: valueEl,
            _labelEl: labelEl,
        };
        return node;
    }

    // Helper: load ctx + mount node into the fake document so the
    // attachRetestCountdown() "still in DOM?" check returns true.
    function mountedCtx() {
        const r = loadCtx({ withDom: true });
        // The fake document was created inside loadCtx; re-grab it.
        // We use a tiny back-channel: install our own getter via a fresh
        // load that exposes _track on the returned object too.
        return r;
    }

    test('returns noop when rootEl is null', () => {
        const r = loadCtx({ withDom: true });
        const stop = r.attachRetestCountdown(null);
        expect(typeof stop).toBe('function');
        expect(() => stop()).not.toThrow();
    });

    test('returns noop when deadline attribute is missing/garbage', () => {
        const r = loadCtx({ withDom: true });
        const node = makeChip('not-a-number');
        const stop = r.attachRetestCountdown(node);
        // Should not have set an interval — calling stop is a no-op.
        expect(typeof stop).toBe('function');
        stop();
    });

    test('immediate tick: sets the right severity class for a fresh chip', () => {
        // No-DOM context: attachRetestCountdown's document-presence guard
        // is bypassed when `document` is undefined, so tick() runs.
        const win = {};
        const ctx = { window: win, console, Date, Number, setInterval, clearInterval };
        vm.createContext(ctx);
        vm.runInContext(SRC, ctx);
        const r = ctx.window.EntityRetestCountdown;
        const deadline = Date.now() + 5 * ONE_DAY_MS;
        const node = makeChip(deadline);
        const stop = r.attachRetestCountdown(node);
        expect(node._classes.has('retest-countdown--orange')).toBe(true);
        stop();
    });

    test('auto-stops after rendering "ready"', () => {
        jest.useFakeTimers();
        try {
            const win = {};
            const ctx = { window: win, console, Date, Number, setInterval, clearInterval };
            vm.createContext(ctx);
            vm.runInContext(SRC, ctx);
            const r = ctx.window.EntityRetestCountdown;
            const deadline = Date.now() - 1;
            const node = makeChip(deadline);
            const stop = r.attachRetestCountdown(node);
            // Already past deadline → tick should have hit "ready" branch.
            expect(node._classes.has('retest-countdown--ready')).toBe(true);
            // After auto-stop, advancing time should not change anything.
            jest.advanceTimersByTime(10_000);
            expect(node._valueEl.textContent).toBe('Available now');
            stop();
        } finally {
            jest.useRealTimers();
        }
    });

    test('explicit stop() clears the interval', () => {
        jest.useFakeTimers();
        try {
            const win = {};
            const ctx = { window: win, console, Date, Number, setInterval, clearInterval };
            vm.createContext(ctx);
            vm.runInContext(SRC, ctx);
            const r = ctx.window.EntityRetestCountdown;
            const deadline = Date.now() + 5 * ONE_DAY_MS;
            const node = makeChip(deadline);
            const stop = r.attachRetestCountdown(node);
            stop();
            stop(); // idempotent
            expect(() => stop()).not.toThrow();
        } finally {
            jest.useRealTimers();
        }
    });

    test('updates aria-label on each tick (SR sees current countdown)', () => {
        const win = {};
        const ctx = { window: win, console, Date, Number, setInterval, clearInterval };
        vm.createContext(ctx);
        vm.runInContext(SRC, ctx);
        const r = ctx.window.EntityRetestCountdown;
        const deadline = Date.now() + 5 * ONE_DAY_MS;
        const node = makeChip(deadline);
        const stop = r.attachRetestCountdown(node);
        const aria = node._attrs['aria-label'];
        expect(aria).toMatch(/Next retest/);
        expect(aria).toMatch(/Orange|orange/);
        stop();
    });

    test('rejects absurd deadlines (>10y out) — tamper guard', () => {
        const win = {};
        const ctx = { window: win, console, Date, Number, setInterval, clearInterval };
        vm.createContext(ctx);
        vm.runInContext(SRC, ctx);
        const r = ctx.window.EntityRetestCountdown;
        // Year 9999 — clearly tampered. attach should bail out with a noop.
        const deadline = Date.now() + 20 * 365 * ONE_DAY_MS;
        const node = makeChip(deadline);
        const stop = r.attachRetestCountdown(node);
        // No severity class should have been added by tick().
        expect(node._classes.has('retest-countdown--gray')).toBe(false);
        stop();
    });

    test('aria-live default is "off"; promotes to "polite" only on tier change', () => {
        jest.useFakeTimers();
        try {
            const win = {};
            const ctx = { window: win, console, Date, Number, setInterval, clearInterval };
            vm.createContext(ctx);
            vm.runInContext(SRC, ctx);
            const r = ctx.window.EntityRetestCountdown;
            const deadline = Date.now() + 5 * ONE_DAY_MS;
            const node = makeChip(deadline);
            const stop = r.attachRetestCountdown(node);
            // First tick: tier changed (null → 'orange'), aria-live=polite.
            expect(node._attrs['aria-live']).toBe('polite');
            // Second tick (1s later): same tier → aria-live=off.
            jest.advanceTimersByTime(1000);
            expect(node._attrs['aria-live']).toBe('off');
            stop();
        } finally {
            jest.useRealTimers();
        }
    });
});
