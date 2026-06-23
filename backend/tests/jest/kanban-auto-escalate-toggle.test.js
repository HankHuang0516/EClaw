'use strict';

/**
 * card_a0c2bc798affdf0a6310f5bb (Hank-direct P0) — API-controllable auto-P0
 * escalation toggle, defaulting to SKIP escalation on automation (cron) cards.
 *
 * Root cause being fixed: cron-spawned child cards ("[Auto] … (date)") are
 * is_auto_generated=true. They have no owner actively working them, so the
 * clock-triggered L2/L3 ladder in processDeviceStaleCards fired
 * "🚨 P0 stalled 主管請介入" supervisor pings (+ priority bumps + auto-block)
 * every interval — a confirmed push-flood.
 *
 * Two device-preference keys gate the ladder:
 *   kanban_auto_escalate_enabled         (master, default true)
 *   kanban_auto_escalate_skip_automation (default true — automation cards never
 *                                         auto-escalate even if master is on)
 *
 * Pinned here:
 *   1. DEFAULTS / coercion contract in device-preferences.js.
 *   2. Source-grep invariants on processDeviceStaleCards (gate present, L1 push
 *      stays OUTSIDE the gate so skipped cards aren't forgotten).
 *   3. Behavioural smoke: reconstruct processDeviceStaleCards in isolation with
 *      stubbed deps and assert the escalation calls fire / don't fire per prefs.
 */

const fs = require('fs');
const path = require('path');

const devicePrefs = require('../../device-preferences');

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

// ════════════════════════════════════════════════════════════════
// 1. device-preferences contract
// ════════════════════════════════════════════════════════════════
describe('device-preferences: auto-escalate toggles', () => {
    test('both keys ship in DEFAULTS, default true', () => {
        expect(devicePrefs.DEFAULTS).toHaveProperty('kanban_auto_escalate_enabled', true);
        expect(devicePrefs.DEFAULTS).toHaveProperty('kanban_auto_escalate_skip_automation', true);
    });

    test('updatePrefs accepts the keys (they are in DEFAULTS → settable via API)', () => {
        // The PUT endpoint filters incoming prefs to Object.keys(DEFAULTS); being
        // in DEFAULTS is what makes a key API-settable. Guard against accidental
        // removal of either key from the settable surface.
        expect(Object.keys(devicePrefs.DEFAULTS)).toEqual(
            expect.arrayContaining([
                'kanban_auto_escalate_enabled',
                'kanban_auto_escalate_skip_automation',
            ])
        );
    });

    test('boolean coercion handles real boolean and string forms', () => {
        // getPrefs returns { ...DEFAULTS, ...stored }; updatePrefs persists the
        // coerced value. We exercise coercion through updatePrefs by wiring a
        // capture pool, since coerceValue itself is module-private.
        const captured = [];
        const fakePool = {
            query: async (sql, params) => {
                captured.push({ sql, params });
                return { rows: [] };
            },
        };
        return (async () => {
            await devicePrefs.initTable(fakePool);
            await devicePrefs.updatePrefs('dev-x', {
                kanban_auto_escalate_enabled: 'false',
                kanban_auto_escalate_skip_automation: true,
            });
            // The INSERT carries a JSON blob of coerced prefs as params[1].
            const insert = captured.find(c => /INSERT INTO device_preferences/.test(c.sql));
            expect(insert).toBeTruthy();
            const persisted = JSON.parse(insert.params[1]);
            // 'false' string must coerce to boolean false (NOT truthy !!('false')).
            expect(persisted.kanban_auto_escalate_enabled).toBe(false);
            expect(persisted.kanban_auto_escalate_skip_automation).toBe(true);
        })();
    });
});

// ════════════════════════════════════════════════════════════════
// 2. Source-grep invariants on processDeviceStaleCards
// ════════════════════════════════════════════════════════════════
describe('processDeviceStaleCards — escalation gate invariants', () => {
    const body = extractFunctionBody(kanbanSrc, 'async function processDeviceStaleCards(deviceId, cards)');

    test('derives autoEscalateEnabled + skipAutomationEscalation from prefs (default true)', () => {
        expect(body).toMatch(/autoEscalateEnabled\s*=\s*basePrefs\.kanban_auto_escalate_enabled\s*!==\s*false/);
        expect(body).toMatch(/skipAutomationEscalation\s*=\s*basePrefs\.kanban_auto_escalate_skip_automation\s*!==\s*false/);
    });

    test('treats both is_automation and is_auto_generated as automation cards', () => {
        // The cron child cards that flood are is_auto_generated=true (NOT
        // is_automation) — both flags MUST be checked or the default skip misses them.
        expect(body).toMatch(/is_automation\s*===\s*true/);
        expect(body).toMatch(/is_auto_generated\s*===\s*true/);
    });

    test('escalationAllowed gate combines master switch + automation skip', () => {
        expect(body).toMatch(
            /escalationAllowed\s*=\s*autoEscalateEnabled\s*&&\s*!\(\s*skipAutomationEscalation\s*&&\s*isAutomationCard\(card\)\s*\)/
        );
    });

    test('both L2/L3 escalation calls are inside the escalationAllowed gate', () => {
        const gateIdx = body.indexOf('if (escalationAllowed) {');
        expect(gateIdx).toBeGreaterThan(-1);
        const blockIdx = body.indexOf('fireBlockEscalation');
        const l2Idx = body.indexOf('fireLevelTwoEscalation');
        expect(blockIdx).toBeGreaterThan(gateIdx);
        expect(l2Idx).toBeGreaterThan(gateIdx);
    });

    test('L1 push stays OUTSIDE the gate (skipped cards are not forgotten)', () => {
        // The `if (sinceLast > intervalMs) level1Pending.push(card)` line must come
        // AFTER the closing of the escalationAllowed block, so cards that skip
        // escalation still fall through to standard L1 nudges.
        const l1Idx = body.indexOf('level1Pending.push(card)');
        const gateIdx = body.indexOf('if (escalationAllowed) {');
        expect(l1Idx).toBeGreaterThan(gateIdx);
        // The escalation block closes before the L1 push (the L1 push is not nested
        // inside the gate): there is a `}` between the last escalation `continue`
        // and the L1 push.
        const l2BranchIdx = body.indexOf('fireLevelTwoEscalation');
        const between = body.slice(l2BranchIdx, l1Idx);
        expect(between).toMatch(/}\s*}\s*\/\/ Level 1 candidate/);
    });
});

// ════════════════════════════════════════════════════════════════
// 3. Behavioural smoke — reconstruct processDeviceStaleCards with stubs
// ════════════════════════════════════════════════════════════════
describe('processDeviceStaleCards — behavioural escalation gate', () => {
    const fnBody = extractFunctionBody(kanbanSrc, 'async function processDeviceStaleCards(deviceId, cards)');

    // Build a fresh harness per scenario so call logs don't leak between tests.
    function makeHarness(basePrefs) {
        const calls = { block: [], l2: [], l1: [] };

        const deps = {
            devicePrefs: {
                getPrefs: async () => basePrefs,
                // No per-entity overrides in these scenarios — return base verbatim.
                mergeEntityOverride: (base) => ({ ...base }),
            },
            KanbanStatus: {
                NUDGE_DEFAULT_STATUSES: ['todo', 'in_progress', 'review'],
            },
            DEFAULT_ESCALATE_MS: 6 * 3600 * 1000,
            DEFAULT_BLOCK_MS: 12 * 3600 * 1000,
            loadDependencyGating: async () => ({ blocked: new Set(), unblockedSince: new Map() }),
            loadEntityNudgeLog: async () => new Map(),
            sortCardsByNudgeMode: (cards) => cards,
            cardHasFreshRecipient: () => true,
            buildEscalationRecipients: (card) => card.assigned_bots || [],
            fireBlockEscalation: async (card) => { calls.block.push(card.id); },
            fireLevelTwoEscalation: async (card) => { calls.l2.push(card.id); return true; },
            fireLevelOneNudge: async (card) => { calls.l1.push(card.id); },
            console: { log: () => {}, error: () => {} },
        };

        // eslint-disable-next-line no-new-func
        const fn = new Function(
            'devicePrefs', 'KanbanStatus', 'DEFAULT_ESCALATE_MS', 'DEFAULT_BLOCK_MS',
            'loadDependencyGating', 'loadEntityNudgeLog', 'sortCardsByNudgeMode',
            'cardHasFreshRecipient', 'buildEscalationRecipients',
            'fireBlockEscalation', 'fireLevelTwoEscalation', 'fireLevelOneNudge', 'console',
            `return async function processDeviceStaleCards(deviceId, cards) ${fnBody}`
        )(
            deps.devicePrefs, deps.KanbanStatus, deps.DEFAULT_ESCALATE_MS, deps.DEFAULT_BLOCK_MS,
            deps.loadDependencyGating, deps.loadEntityNudgeLog, deps.sortCardsByNudgeMode,
            deps.cardHasFreshRecipient, deps.buildEscalationRecipients,
            deps.fireBlockEscalation, deps.fireLevelTwoEscalation, deps.fireLevelOneNudge, deps.console
        );

        return { fn, calls };
    }

    // 13h past status_changed_at → past blockAfterMs (12h) → would hit L3 if allowed.
    const STALE_13H = new Date(Date.now() - 13 * 3600 * 1000).toISOString();

    function card(overrides) {
        return {
            id: 'card_x',
            device_id: 'dev1',
            title: 'test',
            priority: 'P2',
            status: 'in_progress',
            status_changed_at: STALE_13H,
            last_stale_nudge_at: null,
            assigned_bots: [1],
            is_automation: false,
            is_auto_generated: false,
            config: {},
            ...overrides,
        };
    }

    const DEFAULT_PREFS = {
        kanban_nudge_batch_size: 1,
        kanban_nudge_priority_mode: 'priority_first',
        kanban_nudge_interval_minutes: 180,
        kanban_nudge_per_entity_throttle: true,
        kanban_nudge_stop_mode: false,
        kanban_nudge_statuses: ['todo', 'in_progress', 'review'],
        kanban_nudge_per_entity_overrides: {},
        kanban_auto_escalate_enabled: true,
        kanban_auto_escalate_skip_automation: true,
    };

    test('DEFAULT prefs: is_auto_generated cron child does NOT escalate (no L3/L2), still L1-nudged', async () => {
        const { fn, calls } = makeHarness({ ...DEFAULT_PREFS });
        await fn('dev1', [card({ id: 'cron_child', is_auto_generated: true })]);
        expect(calls.block).toEqual([]);   // no auto-block / P0-stalled ping
        expect(calls.l2).toEqual([]);      // no priority bump
        expect(calls.l1).toEqual(['cron_child']); // not forgotten — L1 still fires
    });

    test('DEFAULT prefs: is_automation cron母卡 also skips escalation', async () => {
        const { fn, calls } = makeHarness({ ...DEFAULT_PREFS });
        await fn('dev1', [card({ id: 'cron_mom', is_automation: true })]);
        expect(calls.block).toEqual([]);
        expect(calls.l2).toEqual([]);
        expect(calls.l1).toEqual(['cron_mom']);
    });

    test('DEFAULT prefs: a NON-automation stale card DOES escalate (L3 fires)', async () => {
        const { fn, calls } = makeHarness({ ...DEFAULT_PREFS });
        await fn('dev1', [card({ id: 'human_card' })]);
        expect(calls.block).toEqual(['human_card']); // L3 auto-block path fires
        expect(calls.l1).toEqual([]);                // L3 continued past L1
    });

    test('master switch off: even a NON-automation card does NOT escalate (L1 only)', async () => {
        const { fn, calls } = makeHarness({
            ...DEFAULT_PREFS,
            kanban_auto_escalate_enabled: false,
        });
        await fn('dev1', [card({ id: 'human_card' })]);
        expect(calls.block).toEqual([]);
        expect(calls.l2).toEqual([]);
        expect(calls.l1).toEqual(['human_card']);
    });

    test('skip-automation off (master on): automation card escalates again', async () => {
        const { fn, calls } = makeHarness({
            ...DEFAULT_PREFS,
            kanban_auto_escalate_skip_automation: false,
        });
        await fn('dev1', [card({ id: 'cron_child', is_auto_generated: true })]);
        expect(calls.block).toEqual(['cron_child']);
    });
});
