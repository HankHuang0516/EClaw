'use strict';

/**
 * Regression test — supervisor-visibility on stale-card escalation
 * (card_3ce0080a).
 *
 * Root cause it pins: buildEscalationRecipients used to return
 * [reviewer_entity_id, ...assigned_bots]. When a card has NO reviewer set
 * (reviewer_entity_id === null — the common case for a directly-assigned
 * subordinate card), escalations reached ONLY the assignees. So when a
 * subordinate (e.g. #6) got stuck/blocked, the stale-nudge worker just
 * re-nudged the STUCK bot forever and no commander ever intervened — burning
 * the assignee's tokens. (This is the exact card_83bbe7ed incident: reviewer
 * was null, assigned=[6], so every L2/L3/P0 escalation notified only #6.)
 *
 * Fix: resolveEscalationSupervisor() adds a supervisor to L2/L3/P0 escalation
 * recipients — the org-chart superior of the assignee if a hierarchy is
 * configured, else a bound commander-class entity (#2 then #1) that isn't
 * itself an assignee.
 *
 * Style mirrors kanban-stall-severity-gate.test.js: extractFunctionBody +
 * new Function behavioural smoke, plus source-grep invariants.
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

// ---- Rebuild the two functions in isolation ------------------------------

const resolveSrc = extractFunctionBody(
    kanbanSrc,
    'async function resolveEscalationSupervisor(card, bots)'
);
const buildSrc = extractFunctionBody(
    kanbanSrc,
    'async function buildEscalationRecipients(card)'
);

const makeResolve = (deps) =>
    // eslint-disable-next-line no-new-func
    new Function(
        'orgChart', 'devices', 'serverLog', 'ESCALATION_SUPERVISOR_ENTITY_IDS',
        `return async function resolveEscalationSupervisor(card, bots) ${resolveSrc}`
    )(deps.orgChart, deps.devices, deps.serverLog, [2, 1]);

const makeBuild = (resolveStub) =>
    // eslint-disable-next-line no-new-func
    new Function(
        'resolveEscalationSupervisor',
        `return async function buildEscalationRecipients(card) ${buildSrc}`
    )(resolveStub);

function boundDevice(boundIds) {
    const entities = {};
    for (const id of boundIds) entities[id] = { isBound: true };
    return { entities };
}

describe('resolveEscalationSupervisor — behavioural', () => {
    test('card_83bbe7ed incident: no org chart, assigned=[6], #2 bound → returns #2 (commander fallback)', async () => {
        const resolve = makeResolve({
            orgChart: { getOrgChart: async () => ({ hierarchy: {} }), getSuperior: () => null },
            devices: { dev1: boundDevice([1, 2, 6]) },
            serverLog: () => {},
        });
        const sup = await resolve({ device_id: 'dev1' }, [6]);
        expect(sup).toBe(2);
    });

    test('org-chart superior wins when a hierarchy is configured (#6 → #3 bound)', async () => {
        const resolve = makeResolve({
            orgChart: {
                getOrgChart: async () => ({ hierarchy: { USER: [3], 3: [6] } }),
                getSuperior: (h, id) => (id === 6 ? 3 : 'USER'),
            },
            devices: { dev1: boundDevice([1, 2, 3, 6]) },
            serverLog: () => {},
        });
        const sup = await resolve({ device_id: 'dev1' }, [6]);
        expect(sup).toBe(3);
    });

    test('never returns an assignee: org-chart superior that is itself assigned → falls back to commander', async () => {
        const resolve = makeResolve({
            orgChart: {
                getOrgChart: async () => ({ hierarchy: { USER: [6], 6: [7] } }),
                getSuperior: () => 6, // superior is also in bots
            },
            devices: { dev1: boundDevice([1, 2, 6, 7]) },
            serverLog: () => {},
        });
        const sup = await resolve({ device_id: 'dev1' }, [6, 7]);
        expect(sup).toBe(2); // #6 excluded (assignee), commander fallback #2
    });

    test('commander is the assignee: #2 working its own card → does not self-escalate, tries #1', async () => {
        const resolve = makeResolve({
            orgChart: { getOrgChart: async () => ({ hierarchy: {} }), getSuperior: () => null },
            devices: { dev1: boundDevice([1, 2]) },
            serverLog: () => {},
        });
        const sup = await resolve({ device_id: 'dev1' }, [2]);
        expect(sup).toBe(1); // #2 is the assignee → deputy #1
    });

    test('no bound commander → returns null (no phantom recipient)', async () => {
        const resolve = makeResolve({
            orgChart: { getOrgChart: async () => ({ hierarchy: {} }), getSuperior: () => null },
            devices: { dev1: boundDevice([6]) }, // neither #1 nor #2 bound
            serverLog: () => {},
        });
        const sup = await resolve({ device_id: 'dev1' }, [6]);
        expect(sup).toBeNull();
    });

    test('org-chart lookup throws → non-fatal, falls back to commander', async () => {
        const resolve = makeResolve({
            orgChart: { getOrgChart: async () => { throw new Error('db down'); }, getSuperior: () => null },
            devices: { dev1: boundDevice([2, 6]) },
            serverLog: () => {},
        });
        const sup = await resolve({ device_id: 'dev1' }, [6]);
        expect(sup).toBe(2);
    });
});

describe('buildEscalationRecipients — supervisor is included', () => {
    test('reviewer=null, assigned=[6], supervisor #2 → recipients include #2 (the fix)', async () => {
        const build = makeBuild(async () => 2);
        const out = await build({ reviewer_entity_id: null, assigned_bots: [6], config: {} });
        expect(out).toContain(2);      // commander now in the loop
        expect(out).toContain(6);      // assignee still notified
        expect(out.indexOf(2)).toBeLessThan(out.indexOf(6)); // supervisor ordered before assignees
    });

    test('explicit reviewer preserved and deduped against supervisor', async () => {
        const build = makeBuild(async () => 2);
        const out = await build({ reviewer_entity_id: 2, assigned_bots: [6], config: {} });
        expect(out.filter((x) => x === 2).length).toBe(1); // no dup
        expect(out).toEqual([2, 6]);
    });

    test('no supervisor resolved (null) → legacy behavior, assignees only', async () => {
        const build = makeBuild(async () => null);
        const out = await build({ reviewer_entity_id: null, assigned_bots: [6], config: {} });
        expect(out).toEqual([6]);
    });
});

describe('source invariants', () => {
    test('buildEscalationRecipients is async and threads supervisorId into the recipient list', () => {
        expect(kanbanSrc).toMatch(/async function buildEscalationRecipients\(card\)/);
        expect(buildSrc).toMatch(/resolveEscalationSupervisor\(card, bots\)/);
        expect(buildSrc).toMatch(/\[notifyEntityId, supervisorId, \.\.\.bots\]/);
    });

    test('all call sites await buildEscalationRecipients (no sync leftovers)', () => {
        const syncCalls = kanbanSrc
            .split('\n')
            .filter((l) => /buildEscalationRecipients\(card\)/.test(l))
            .filter((l) => !/await buildEscalationRecipients\(card\)/.test(l))
            .filter((l) => !/async function buildEscalationRecipients/.test(l));
        expect(syncCalls).toEqual([]);
    });

    test('commander fallback uses the #2-before-#1 ordering constant', () => {
        expect(kanbanSrc).toMatch(/ESCALATION_SUPERVISOR_ENTITY_IDS\s*=\s*\[2,\s*1\]/);
    });

    test('supervisor is never an assignee (guard present)', () => {
        expect(resolveSrc).toMatch(/assignees\.has/);
    });
});
