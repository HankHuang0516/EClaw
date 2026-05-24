'use strict';

/**
 * Regression test — stale-escalation must gate on kanban_card_dependencies.
 *
 * Background: nudge cron (processDeviceStaleCards) and dependency-chain
 * tracker (kanban_card_dependencies) were independent until card_fb2424
 * landed. Symptom: H2 got nudged → auto-bumped → auto-blocked while H1 was
 * still in_progress, because nudge logic never consulted the dep table.
 *
 * Fix shape pinned here: load a Set of cardIds whose `blocks`-type
 * dependencies point at a blocker still NOT IN ('done','archived'), then
 * filter `eligible` BEFORE the L1/L2/L3 branch so all three escalation
 * levels suppress uniformly.
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

    test('calls loadCardsBlockedByPending with the eligible cardIds', () => {
        expect(body).toMatch(
            /loadCardsBlockedByPending\(deviceId,\s*eligible\.map\(c\s*=>\s*c\.id\)\)/
        );
    });

    test('filters eligible against the blockedByPending set', () => {
        expect(body).toMatch(/eligible\.filter\(c\s*=>\s*!blockedByPending\.has\(c\.id\)\)/);
    });

    test('dependency gate runs BEFORE the L1/L2/L3 split (suppresses all three levels)', () => {
        const gateIdx = body.indexOf('blockedByPending');
        const splitIdx = body.indexOf('level1Pending');
        expect(gateIdx).toBeGreaterThan(-1);
        expect(splitIdx).toBeGreaterThan(-1);
        expect(gateIdx).toBeLessThan(splitIdx);
    });
});

describe('loadCardsBlockedByPending — helper shape', () => {
    const body = extractFunctionBody(
        kanbanSrc,
        'async function loadCardsBlockedByPending(deviceId, cardIds)'
    );

    test('queries kanban_card_dependencies joined to kanban_cards', () => {
        expect(body).toMatch(/FROM kanban_card_dependencies d/);
        expect(body).toMatch(/JOIN kanban_cards dep/);
        expect(body).toMatch(/ON dep\.id = d\.depends_on_card_id/);
    });

    test("scopes to dependency_type = 'blocks' (not subtask/related)", () => {
        expect(body).toMatch(/d\.dependency_type = 'blocks'/);
    });

    test("filters out done and archived blockers (anything else = still pending)", () => {
        expect(body).toMatch(/dep\.status NOT IN \('done', 'archived'\)/);
    });

    test('parameterised on (deviceId, cardIds) — uses ANY for the cardIds array', () => {
        expect(body).toMatch(/device_id = \$1/);
        expect(body).toMatch(/card_id = ANY\(\$2::varchar\[\]\)/);
    });

    test('returns a Set (constant-time .has() in the caller filter)', () => {
        expect(body).toMatch(/const blocked = new Set\(\)/);
        expect(body).toMatch(/blocked\.add\(row\.card_id\)/);
        expect(body).toMatch(/return blocked/);
    });

    test('fails open if the dependencies table is missing (logs once, does not crash cron)', () => {
        // Older schemas may not have kanban_card_dependencies; the cron must keep running.
        expect(body).toMatch(/loadCardsBlockedByPending\._warned/);
        expect(body).toMatch(/gating disabled/);
    });
});

describe('loadCardsBlockedByPending — behavioural smoke (mock pg pool)', () => {
    // Pull the helper out by evaluating its source in a tiny harness — same
    // technique used elsewhere when we want to exercise an inner function
    // without standing up the full module.
    const helperSrc = extractFunctionBody(
        kanbanSrc,
        'async function loadCardsBlockedByPending(deviceId, cardIds)'
    );
    // Wrap the body into a callable: inject a fake `pool` via closure.
    const make = (poolImpl) => {
        // eslint-disable-next-line no-new-func
        return new Function(
            'pool',
            `return async function loadCardsBlockedByPending(deviceId, cardIds) ${helperSrc}`
        )(poolImpl);
    };

    test('returns empty Set when cardIds is empty (no DB call)', async () => {
        let queryCount = 0;
        const fn = make({ query: async () => { queryCount++; return { rows: [] }; } });
        const result = await fn('dev1', []);
        expect(result).toBeInstanceOf(Set);
        expect(result.size).toBe(0);
        expect(queryCount).toBe(0);
    });

    test('returns Set of blocked cardIds from query rows', async () => {
        const fn = make({
            query: async (sql, params) => {
                expect(sql).toMatch(/FROM kanban_card_dependencies d/);
                expect(params).toEqual(['dev1', ['cardA', 'cardB', 'cardC']]);
                return { rows: [{ card_id: 'cardA' }, { card_id: 'cardC' }] };
            },
        });
        const result = await fn('dev1', ['cardA', 'cardB', 'cardC']);
        expect(result.has('cardA')).toBe(true);
        expect(result.has('cardB')).toBe(false);
        expect(result.has('cardC')).toBe(true);
    });

    test('fails open (returns empty Set) when query throws — does not bubble up to cron', async () => {
        const fn = make({
            query: async () => { throw new Error('relation "kanban_card_dependencies" does not exist'); },
        });
        const result = await fn('dev1', ['cardA']);
        expect(result).toBeInstanceOf(Set);
        expect(result.size).toBe(0);
    });
});
