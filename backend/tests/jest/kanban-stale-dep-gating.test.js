'use strict';

/**
 * Regression test — stale-escalation must gate on kanban_card_dependencies.
 *
 * Background: nudge cron (processDeviceStaleCards) and dependency-chain
 * tracker (kanban_card_dependencies) were independent until card_fb2424
 * landed. Symptom: H2 got nudged → auto-bumped → auto-blocked while H1 was
 * still in_progress, because nudge logic never consulted the dep table.
 *
 * Fix shape pinned here:
 *   1. Load { blocked: Set, unblockedSince: Map<cardId, ms> } in one query.
 *   2. Filter `eligible` against `blocked` BEFORE the L1/L2/L3 branch so all
 *      three escalation levels suppress uniformly.
 *   3. For cards whose blockers are NOW resolved, reset the effective stale
 *      clock to max(card.status_changed_at, latest blocker resolution time)
 *      so a previously-blocked card re-enters the L1 → L2 → L3 cadence from
 *      the moment it became actionable, not from creation time (#1 review:
 *      a card that waited >12h must not skip straight to L3 the moment its
 *      blocker finishes).
 *
 * Style mirrors kanban-stale-skip-recurring.test.js — source-grep against
 * static invariants; behavioural integration is covered by the prod-DB
 * post-deploy verification on card_fb2424's test plan.
 */

const fs = require('fs');
const path = require('path');

const kanbanSrc = fs.readFileSync(
    path.join(__dirname, '..', '..', 'kanban.js'),
    'utf8'
);

function extractFunctionBody(src, signature) {
    const start = src.indexOf(signature);
    if (start === -1) throw new Error(`function not found: ${signature}`);
    const open = src.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < src.length; i++) {
        const ch = src[i];
        if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0) return src.slice(open, i + 1);
        }
    }
    throw new Error(`unterminated function: ${signature}`);
}

describe('processDeviceStaleCards — dependency-aware gating', () => {
    const body = extractFunctionBody(
        kanbanSrc,
        'async function processDeviceStaleCards(deviceId, cards)'
    );

    test('calls loadDependencyGating with the eligible cardIds', () => {
        expect(body).toMatch(
            /loadDependencyGating\(deviceId,\s*eligible\.map\(c\s*=>\s*c\.id\)\)/
        );
    });

    test('filters eligible against depGating.blocked', () => {
        expect(body).toMatch(/eligible\.filter\(c\s*=>\s*!depGating\.blocked\.has\(c\.id\)\)/);
    });

    test('dependency gate runs BEFORE the L1/L2/L3 split (suppresses all three levels)', () => {
        const gateIdx = body.indexOf('depGating');
        const splitIdx = body.indexOf('level1Pending');
        expect(gateIdx).toBeGreaterThan(-1);
        expect(splitIdx).toBeGreaterThan(-1);
        expect(gateIdx).toBeLessThan(splitIdx);
    });

    test('elapsedMs uses effectiveStaleSinceMs (not raw status_changed_at)', () => {
        // The original bug #1 caught: after blocker resolves, elapsedMs was still
        // Date.now() - card.status_changed_at, so a >12h-old card would skip L1+L2
        // and jump straight to L3 on the very next cron tick.
        expect(body).toMatch(/elapsedMs = Date\.now\(\) - effectiveStaleSinceMs\(card\)/);
    });

    test('effectiveStaleSinceMs picks the MAX of card.status_changed_at and unblockedSince', () => {
        const fn = body.match(/function effectiveStaleSinceMs\(card\)\s*\{[\s\S]*?\n        \}/);
        expect(fn).not.toBeNull();
        expect(fn[0]).toMatch(/depGating\.unblockedSince\.get\(card\.id\)/);
        // The compare must be strict > (later resolution wins). Using <= would let
        // a same-timestamp blocker accidentally reset to itself; not catastrophic
        // but pin the spec'd direction.
        expect(fn[0]).toMatch(/unblockedAtMs\s*>\s*cardChangedMs/);
    });
});

describe('loadDependencyGating — helper shape', () => {
    const body = extractFunctionBody(
        kanbanSrc,
        'async function loadDependencyGating(deviceId, cardIds)'
    );

    test('queries kanban_card_dependencies joined to kanban_cards', () => {
        expect(body).toMatch(/FROM kanban_card_dependencies d/);
        expect(body).toMatch(/JOIN kanban_cards dep/);
        expect(body).toMatch(/ON dep\.id = d\.depends_on_card_id/);
    });

    test("scopes to dependency_type = 'blocks' (not subtask/related)", () => {
        expect(body).toMatch(/d\.dependency_type = 'blocks'/);
    });

    test('aggregates per card_id (BOOL_OR pending + MAX resolution time in one round-trip)', () => {
        // Avoid N+1 — one query for all eligible cards.
        expect(body).toMatch(/GROUP BY d\.card_id/);
        expect(body).toMatch(/BOOL_OR\(dep\.status NOT IN \('done', 'archived'\)\)/);
        expect(body).toMatch(/MAX\(dep\.status_changed_at\) FILTER \(WHERE dep\.status IN \('done', 'archived'\)\)/);
    });

    test('parameterised on (deviceId, cardIds) — uses ANY for the cardIds array', () => {
        expect(body).toMatch(/device_id = \$1/);
        expect(body).toMatch(/card_id = ANY\(\$2::varchar\[\]\)/);
    });

    test('returns { blocked: Set, unblockedSince: Map } shape', () => {
        expect(body).toMatch(/blocked: new Set\(\)/);
        expect(body).toMatch(/unblockedSince: new Map\(\)/);
        expect(body).toMatch(/result\.blocked\.add\(row\.card_id\)/);
        expect(body).toMatch(/result\.unblockedSince\.set\(row\.card_id/);
        expect(body).toMatch(/return result/);
    });

    test('fails open if the dependencies table is missing (logs once, does not crash cron)', () => {
        expect(body).toMatch(/loadDependencyGating\._warned/);
        expect(body).toMatch(/gating disabled/);
    });
});

describe('loadDependencyGating — behavioural smoke (mock pg pool)', () => {
    const helperSrc = extractFunctionBody(
        kanbanSrc,
        'async function loadDependencyGating(deviceId, cardIds)'
    );
    const make = (poolImpl) => {
        // eslint-disable-next-line no-new-func
        return new Function(
            'pool',
            `return async function loadDependencyGating(deviceId, cardIds) ${helperSrc}`
        )(poolImpl);
    };

    test('returns empty result when cardIds is empty (no DB call)', async () => {
        let queryCount = 0;
        const fn = make({ query: async () => { queryCount++; return { rows: [] }; } });
        const result = await fn('dev1', []);
        expect(result.blocked).toBeInstanceOf(Set);
        expect(result.unblockedSince).toBeInstanceOf(Map);
        expect(result.blocked.size).toBe(0);
        expect(result.unblockedSince.size).toBe(0);
        expect(queryCount).toBe(0);
    });

    test('splits rows: pending → blocked set; all-resolved → unblockedSince map', async () => {
        const resolvedAt = '2026-05-24T06:30:00.000Z';
        const resolvedAtMs = new Date(resolvedAt).getTime();
        const fn = make({
            query: async (sql, params) => {
                expect(sql).toMatch(/FROM kanban_card_dependencies d/);
                expect(params).toEqual(['dev1', ['cardA', 'cardB', 'cardC']]);
                return {
                    rows: [
                        { card_id: 'cardA', has_pending: true,  latest_resolved_at: null },
                        { card_id: 'cardB', has_pending: false, latest_resolved_at: resolvedAt },
                        { card_id: 'cardC', has_pending: true,  latest_resolved_at: resolvedAt }, // mix: one resolved + one pending => still blocked
                    ],
                };
            },
        });
        const result = await fn('dev1', ['cardA', 'cardB', 'cardC']);
        expect(result.blocked.has('cardA')).toBe(true);
        expect(result.blocked.has('cardB')).toBe(false);
        expect(result.blocked.has('cardC')).toBe(true);
        expect(result.unblockedSince.get('cardB')).toBe(resolvedAtMs);
        expect(result.unblockedSince.has('cardA')).toBe(false);
        expect(result.unblockedSince.has('cardC')).toBe(false); // still blocked → no clock reset
    });

    test('fails open (empty result) when query throws — does not bubble up to cron', async () => {
        const fn = make({
            query: async () => { throw new Error('relation "kanban_card_dependencies" does not exist'); },
        });
        const result = await fn('dev1', ['cardA']);
        expect(result.blocked.size).toBe(0);
        expect(result.unblockedSince.size).toBe(0);
    });
});

describe('effective stale clock — prevents skip-to-L3 after blocker resolves', () => {
    // #1 review on PR #2904: scenario where a card waits behind a blocker for
    // 14 hours, blocker finishes, dependent card was created 14h ago. Without
    // the clock reset, elapsedMs > blockAfterMs (12h) → fireBlockEscalation
    // on the very next cron tick, skipping spec's L1 → L2 → L3 cadence.
    //
    // Reconstruct effectiveStaleSinceMs from source and exercise its math.
    const procBody = extractFunctionBody(
        kanbanSrc,
        'async function processDeviceStaleCards(deviceId, cards)'
    );
    const fnSrc = procBody.match(/function effectiveStaleSinceMs\(card\)\s*\{[\s\S]*?\n        \}/);
    expect(fnSrc).not.toBeNull();
    // Close over a synthetic depGating.
    const factory = (depGating) =>
        // eslint-disable-next-line no-new-func
        new Function('depGating', `return ${fnSrc[0]}`)(depGating);

    test('card-only (no resolved blocker) → uses card.status_changed_at', () => {
        const fn = factory({ unblockedSince: new Map() });
        const card = { id: 'cX', status_changed_at: '2026-05-24T00:00:00.000Z' };
        const expected = new Date(card.status_changed_at).getTime();
        expect(fn(card)).toBe(expected);
    });

    test('blocker resolved AFTER card.status_changed_at → uses blocker resolution time', () => {
        // Card created 14h ago; blocker resolved 30min ago. effective clock = 30min ago.
        const cardChangedAt = '2026-05-24T00:00:00.000Z';
        const blockerResolvedAt = '2026-05-24T13:30:00.000Z';
        const fn = factory({ unblockedSince: new Map([['cX', new Date(blockerResolvedAt).getTime()]]) });
        const card = { id: 'cX', status_changed_at: cardChangedAt };
        expect(fn(card)).toBe(new Date(blockerResolvedAt).getTime());
    });

    test('blocker resolved BEFORE card.status_changed_at → keeps card clock (ancient blocker irrelevant)', () => {
        const cardChangedAt = '2026-05-24T12:00:00.000Z';
        const blockerResolvedAt = '2026-05-23T10:00:00.000Z'; // resolved before card existed
        const fn = factory({ unblockedSince: new Map([['cX', new Date(blockerResolvedAt).getTime()]]) });
        const card = { id: 'cX', status_changed_at: cardChangedAt };
        expect(fn(card)).toBe(new Date(cardChangedAt).getTime());
    });

    test('post-resolve scenario: 14h-old card, blocker resolved 30min ago → elapsedMs < 1h (only L1 eligible)', () => {
        // The exact scenario #1 caught. After this fix, the 14h-old card's
        // effective elapsedMs is ~30min — well below L1 threshold (3h), so it
        // does NOT fire ANY escalation on this tick. It will progress through
        // L1 → L2 → L3 normally on subsequent ticks.
        const fakeNow = new Date('2026-05-24T14:00:00.000Z').getTime();
        const cardChangedAt = '2026-05-24T00:00:00.000Z'; // 14h ago
        const blockerResolvedAt = '2026-05-24T13:30:00.000Z'; // 30min ago
        const fn = factory({ unblockedSince: new Map([['cX', new Date(blockerResolvedAt).getTime()]]) });
        const card = { id: 'cX', status_changed_at: cardChangedAt };

        const effectiveElapsedMs = fakeNow - fn(card);
        const ONE_HOUR = 60 * 60 * 1000;
        const THREE_HOURS = 3 * ONE_HOUR;
        const SIX_HOURS = 6 * ONE_HOUR;
        const TWELVE_HOURS = 12 * ONE_HOUR;

        expect(effectiveElapsedMs).toBeLessThan(ONE_HOUR);
        expect(effectiveElapsedMs).toBeLessThan(THREE_HOURS); // below L1
        expect(effectiveElapsedMs).toBeLessThan(SIX_HOURS);   // below L2
        expect(effectiveElapsedMs).toBeLessThan(TWELVE_HOURS); // below L3 — the bug

        // For contrast: the RAW elapsed (before fix) was past L3.
        const rawElapsedMs = fakeNow - new Date(cardChangedAt).getTime();
        expect(rawElapsedMs).toBeGreaterThan(TWELVE_HOURS);
    });
});
