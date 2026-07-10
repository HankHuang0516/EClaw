'use strict';

/**
 * Regression test — per-entity task-load census prepended to stale nudges
 * (feat/kanban-nudge-task-census; owner Hank).
 *
 * When the kanban L1 stale nudge fires, the server prepends a compact one-line
 * census of the RECIPIENT entity's OWN open cards, so the agent receiving the
 * nudge is aware of its TOTAL outstanding workload (not just the one nudged
 * card). Backend-enforced — the census is injected server-side, not something
 * the agent has to remember.
 *
 * Mix of source-grep invariants (fail on origin/main which has no census) plus
 * Function-constructor behavioural smokes for buildEntityTaskCensus and the
 * per-bot fireLevelOneNudge loop.
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

describe('buildEntityTaskCensus — source invariants', () => {
    test('helper exists and is async', () => {
        // Fails on origin/main — the helper does not exist there.
        expect(kanbanSrc).toMatch(/async function buildEntityTaskCensus\(deviceId, entityId\)/);
    });

    test('source carries the census format + reconcile instruction', () => {
        expect(kanbanSrc).toContain('未完成');
        expect(kanbanSrc).toContain('待辦');
        expect(kanbanSrc).toContain('進行中');
        expect(kanbanSrc).toContain('審查');
        expect(kanbanSrc).toContain('封鎖');
        expect(kanbanSrc).toContain('最舊停留');
        expect(kanbanSrc).toContain('完成的移 done');
        expect(kanbanSrc).toContain('卡住的升級');
    });

    test('census query targets open statuses only (excludes done/backlog/archived)', () => {
        const body = extractFunctionBody(
            kanbanSrc,
            'async function buildEntityTaskCensus(deviceId, entityId)'
        );
        expect(body).toMatch(/status IN \('todo','in_progress','review','blocked'\)/);
        expect(body).toMatch(/archived = false/);
        expect(body).toMatch(/assigned_bots @> to_jsonb\(\$2::int\)/);
        // Never throws — census failure must not break the nudge.
        expect(body).toMatch(/try \{/);
        expect(body).toMatch(/catch \(err\)/);
    });

    test('census query EXCLUDES automation parent cards (aligns with the board default view)', () => {
        // Regression: 2026-07-10 owner-reported phantom "封鎖9" — 9 recurring
        // automation母卡 an older stale-auto-blocker had parked in 'blocked' were
        // counted by the census while being HIDDEN from the board (GET
        // /api/mission/cards defaults to excluding is_automation cards). The census
        // must apply the SAME is_automation filter so its counts match what the
        // entity actually sees on its board. Fails on the pre-fix query (no
        // is_automation clause); passes once the filter is added.
        const body = extractFunctionBody(
            kanbanSrc,
            'async function buildEntityTaskCensus(deviceId, entityId)'
        );
        expect(body).toMatch(/is_automation = false OR is_automation IS NULL/);
    });
});

describe('buildEntityTaskCensus — behavioural', () => {
    const src = extractFunctionBody(
        kanbanSrc,
        'async function buildEntityTaskCensus(deviceId, entityId)'
    );

    const make = (deps) =>
        // eslint-disable-next-line no-new-func
        new Function(
            'pool', 'serverLog',
            `return async function buildEntityTaskCensus(deviceId, entityId) ${src}`
        )(deps.pool, deps.serverLog);

    function makePool(rows) {
        return { query: async () => ({ rows }) };
    }

    test('groups counts correctly by status', async () => {
        const now = Date.now();
        const rows = [
            { status: 'todo', status_changed_at: new Date(now - 1 * 3600e3).toISOString() },
            { status: 'todo', status_changed_at: new Date(now - 2 * 3600e3).toISOString() },
            { status: 'in_progress', status_changed_at: new Date(now - 3 * 3600e3).toISOString() },
            { status: 'review', status_changed_at: new Date(now - 4 * 3600e3).toISOString() },
            { status: 'blocked', status_changed_at: new Date(now - 5 * 3600e3).toISOString() },
            { status: 'blocked', status_changed_at: new Date(now - 6 * 3600e3).toISOString() },
        ];
        const fn = make({ pool: makePool(rows), serverLog: () => {} });
        const line = await fn('dev1', 4);
        // 待辦2·進行中1·審查1·封鎖2
        expect(line).toContain('【#4 未完成');
        expect(line).toContain('待辦2');
        expect(line).toContain('進行中1');
        expect(line).toContain('審查1');
        expect(line).toContain('封鎖2');
        // oldest is the blocked card at now-6h.
        expect(line).toContain('最舊停留6h');
        expect(line).toContain('完成的移 done');
    });

    test('total 0 → returns empty string (no census line)', async () => {
        const fn = make({ pool: makePool([]), serverLog: () => {} });
        expect(await fn('dev1', 4)).toBe('');
    });

    test('DB error → returns empty string, never throws', async () => {
        const errPool = { query: async () => { throw new Error('boom'); } };
        let logged = false;
        const fn = make({ pool: errPool, serverLog: () => { logged = true; } });
        await expect(fn('dev1', 4)).resolves.toBe('');
        expect(logged).toBe(true);
    });

    test('oldest null (no status_changed_at) → omits 最舊停留 segment but still counts', async () => {
        const rows = [
            { status: 'todo', status_changed_at: null },
            { status: 'review', status_changed_at: null },
        ];
        const fn = make({ pool: makePool(rows), serverLog: () => {} });
        const line = await fn('dev1', 2);
        expect(line).toContain('待辦1');
        expect(line).toContain('審查1');
        expect(line).not.toContain('最舊停留');
    });

    test('rounds oldest-stale hours to 1 decimal', async () => {
        const now = Date.now();
        const rows = [
            { status: 'in_progress', status_changed_at: new Date(now - 5.25 * 3600e3).toISOString() },
        ];
        const fn = make({ pool: makePool(rows), serverLog: () => {} });
        const line = await fn('dev1', 3);
        expect(line).toMatch(/最舊停留5\.[23]h/); // ~5.25 rounds to 5.2/5.3 depending on tick
    });
});

describe('fireLevelOneNudge — per-bot census prepend', () => {
    const src = extractFunctionBody(
        kanbanSrc,
        'async function fireLevelOneNudge(card, recipientIds = null)'
    );

    const make = (deps) =>
        // eslint-disable-next-line no-new-func
        new Function(
            'STATUS_LABELS', 'addSystemComment', 'pool', 'getDeviceLanguage',
            'tKanban', 'statusLabel', 'notifyEntities', 'recordEntityNudge',
            'buildEntityTaskCensus', 'console',
            `return async function fireLevelOneNudge(card, recipientIds = null) ${src}`
        )(
            deps.STATUS_LABELS, deps.addSystemComment, deps.pool, deps.getDeviceLanguage,
            deps.tKanban, deps.statusLabel, deps.notifyEntities, deps.recordEntityNudge,
            deps.buildEntityTaskCensus, deps.console
        );

    function makeDeps(censusFor) {
        const notifies = [];
        const recorded = [];
        return {
            notifies, recorded,
            STATUS_LABELS: { in_progress: 'In Progress' },
            addSystemComment: async () => {},
            pool: { query: async () => ({ rows: [] }) },
            getDeviceLanguage: async () => 'zh',
            tKanban: () => 'NUDGE_BODY',
            statusLabel: () => 'In Progress',
            notifyEntities: (deviceId, recipients, msg, extra) => { notifies.push({ deviceId, recipients, msg, extra }); },
            recordEntityNudge: async (deviceId, bots) => { recorded.push({ deviceId, bots }); },
            buildEntityTaskCensus: async (deviceId, bid) => censusFor(bid),
            console: { log: () => {} },
        };
    }

    function makeCard() {
        return {
            id: 'card_test_x',
            device_id: 'dev1',
            title: 'test card',
            status: 'in_progress',
            description: 'desc',
            status_changed_at: new Date(Date.now() - 4 * 3600e3).toISOString(),
        };
    }

    test('notifyEntities is called once PER bot, message starts with that bot census', async () => {
        const deps = makeDeps((bid) => `CENSUS_FOR_${bid}`);
        const fn = make(deps);
        await fn(makeCard(), [1, 2]);
        expect(deps.notifies.length).toBe(2);
        // Each call targets a single-id array.
        expect(deps.notifies[0].recipients).toEqual([1]);
        expect(deps.notifies[1].recipients).toEqual([2]);
        // Message STARTS WITH the per-bot census line.
        expect(deps.notifies[0].msg.startsWith('CENSUS_FOR_1\n')).toBe(true);
        expect(deps.notifies[1].msg.startsWith('CENSUS_FOR_2\n')).toBe(true);
        // Body still present after the census.
        expect(deps.notifies[0].msg).toContain('NUDGE_BODY');
        // recordEntityNudge still records the FULL list once.
        expect(deps.recorded.length).toBe(1);
        expect(deps.recorded[0].bots).toEqual([1, 2]);
    });

    test('empty census → message has NO leading newline', async () => {
        const deps = makeDeps(() => '');
        const fn = make(deps);
        await fn(makeCard(), [7]);
        expect(deps.notifies.length).toBe(1);
        expect(deps.notifies[0].msg).toBe('NUDGE_BODY');
        expect(deps.notifies[0].msg.startsWith('\n')).toBe(false);
    });

    test('mixed: one bot has census, one does not', async () => {
        const deps = makeDeps((bid) => (bid === 1 ? 'CENSUS_1' : ''));
        const fn = make(deps);
        await fn(makeCard(), [1, 2]);
        expect(deps.notifies[0].msg).toBe('CENSUS_1\nNUDGE_BODY');
        expect(deps.notifies[1].msg).toBe('NUDGE_BODY');
    });
});
