/**
 * The alert schedule's tool (tools/aihankapps-hub/triage.js): which alerts are due for a judgement, how a judgement is
 * written back to the hub, and how 拾光AI雲端相簿's reports are read and imported. Synthetic: no network, no railway.
 */
const path = require('path');
const triage = require(path.resolve(__dirname, '../../../tools/aihankapps-hub/triage'));

const NOW = Date.UTC(2026, 10, 13, 2, 0), HOUR = 3600000;
const alert = (id, more = {}) => ({ id, type: id.split(/[.@]/)[0], severity: 'warn', title: id, detail: 'd', rule: 'r', triage: null, ...more });

// Stands in for `railway ssh`: decodes the request the tool would send and answers like the container script.
function fakeRailway(answers) {
    const calls = [];
    const run = (target, script) => {
        const m = script.match(/spawnSync\(process\.execPath, (\[[^\]]*\])/);
        const args = JSON.parse(m[1]), request = args[1] ? JSON.parse(Buffer.from(args[1], 'base64').toString('utf8')) : undefined;
        calls.push({ target, script: args[0], request });
        const value = answers[args[0]] ? answers[args[0]](request) : { success: false, error: 'NO_FAKE' };
        return { value, exitCode: value.success ? 0 : 1, detail: null };
    };
    return { run, calls };
}

describe('alert schedule tool: what is due', () => {
    test('new alerts, and judgements whose time has come again; closed ones and the listing board never', () => {
        expect(triage.due(alert('worker-bad-x'), NOW)).toBe('new');
        expect(triage.due(alert('attention-shopee'), NOW)).toBeNull();
        expect(triage.due(alert('a', { triage: { state: 'done', at: NOW - 100 * HOUR } }), NOW)).toBeNull();
        expect(triage.due(alert('a', { triage: { state: 'auto', at: NOW - 5 * HOUR } }), NOW)).toBeNull();
        expect(triage.due(alert('a', { triage: { state: 'auto', at: NOW - 7 * HOUR } }), NOW)).toBe('recheck-auto');
        expect(triage.due(alert('a', { triage: { state: 'human', at: NOW - 11 * HOUR } }), NOW)).toBeNull();
        expect(triage.due(alert('a', { triage: { state: 'human', at: NOW - 13 * HOUR } }), NOW)).toBe('recheck-human');
    });
    test('pending lists only what is due, with long report text cut', async () => {
        const answer = { success: true, computedAtTaipei: '2026-11-13 10:00 (Asia/Taipei)', alerts: [
            alert('fb-eclaw-1', { type: 'feedback-eclaw', quote: 'x'.repeat(2000), app: 'eclawbot' }),
            alert('rating-alpha', { triage: { state: 'auto', at: NOW - HOUR } }),
            alert('attention-fb'),
        ] };
        const { run } = fakeRailway({ 'scripts/aihankapps-hub-alerts.js': () => answer });
        const realNow = Date.now;
        Date.now = () => NOW;
        try {
            const result = await triage.main(['pending'], { run });
            expect(result).toMatchObject({ computedAt: '2026-11-13 10:00 (Asia/Taipei)', total: 3, pending: 1 });
            expect(result.alerts[0]).toMatchObject({ id: 'fb-eclaw-1', reason: 'new', app: 'eclawbot' });
            expect(result.alerts[0].quote).toHaveLength(801);
        } finally { Date.now = realNow; }
    });
});

describe('alert schedule tool: writing a judgement', () => {
    const saved = request => ({ success: true, saved: { ref: request.ref, state: request.state, updatedAt: NOW } });
    test('note, raise and resolve each send one request to the hub\'s note script, signed by the schedule', async () => {
        const { run, calls } = fakeRailway({ 'scripts/aihankapps-hub-note.js': saved });
        await triage.main(['note', 'rating-alpha', '--state', 'human', '--note', '兩則一星評論', '--ask', '請決定要不要回覆', '--title', 'Alpha 評分偏低'], { run });
        await triage.main(['raise', 'line-quota', '--title', 'LINE 推播額度快用完', '--ask', '請決定是否升級方案', '--note', '本月已用 70%', '--app', 'timehut'], { run });
        await triage.main(['resolve', 'human-line-quota', '--note', '已升級'], { run });
        expect(calls.map(c => [c.target.service, c.script])).toEqual(new Array(3).fill(['eclaw', 'scripts/aihankapps-hub-note.js']));
        expect(calls.map(c => c.request)).toEqual([
            { action: 'set', ref: 'rating-alpha', state: 'human', note: '兩則一星評論', by: 'alert-schedule', ask: '請決定要不要回覆', title: 'Alpha 評分偏低' },
            { action: 'set', ref: 'human-line-quota', state: 'human', note: '本月已用 70%', by: 'alert-schedule', ask: '請決定是否升級方案', title: 'LINE 推播額度快用完', app: 'timehut' },
            { action: 'set', ref: 'human-line-quota', state: 'done', note: '已升級', by: 'alert-schedule' }]);
    });
    test('refusals come back as codes; an unknown command, job or slug is refused before anything runs', async () => {
        const { run, calls } = fakeRailway({ 'scripts/aihankapps-hub-note.js': () => ({ success: false, error: 'NOTE_ASK_REQUIRED' }) });
        await expect(triage.main(['note', 'x', '--state', 'human', '--note', 'n'], { run })).rejects.toMatchObject({ code: 'NOTE_ASK_REQUIRED' });
        await expect(triage.main(['raise', 'Bad Slug', '--title', 't'], { run })).rejects.toMatchObject({ code: 'SLUG_REQUIRED' });
        await expect(triage.main(['delete', 'x'], { run })).rejects.toMatchObject({ code: 'USAGE' });
        await expect(triage.main(['kick', 'rm-rf'], { run })).rejects.toMatchObject({ code: 'UNKNOWN_JOB' });
        expect(calls).toHaveLength(1);
    });
    test('kick restarts only this Mac\'s own hub jobs', async () => {
        const seen = [];
        const spawn = (cmd, args) => { seen.push([cmd, ...args]); return { status: 0 }; };
        expect(await triage.main(['kick', 'report-watchdog'], { spawn })).toEqual({ kicked: 'tw.aihankapps.report-watchdog' });
        expect(seen[0][0]).toBe('launchctl');
        expect(seen[0][1]).toBe('kickstart');
        expect(seen[0][2]).toMatch(/^gui\/\d+\/tw\.aihankapps\.report-watchdog$/);
        expect(Object.keys(triage.JOBS)).toEqual(['collector', 'collector-hourly', 'report-watchdog']);
    });
});

describe('alert schedule tool: 拾光AI雲端相簿 reports', () => {
    const key = 'k'.repeat(40);
    const json = (status, body) => async () => ({ status, json: async () => body });
    test('reads App and LINE reports with the hub key and imports each list as its own source', async () => {
        const seen = [];
        const fetchImpl = async (url, init) => { seen.push([url, init.headers.Authorization]); return { status: 200, json: async () => ({ schema: 1,
            app: [{ id: 'a1', message: '閃退', version: '1.0.18', channel: 'android-play', reporter: '小…明', hasImage: true, createdAt: NOW - HOUR, userId: 'never-sent' }],
            line: [{ id: 'l1', message: '照片傳不上去', category: 'upload', channel: 'line', createdAt: NOW - 2 * HOUR }, { id: 'l2', message: '   ', createdAt: NOW }] }) }; };
        const { run, calls } = fakeRailway({ 'scripts/aihankapps-hub-import.js': r => ({ success: true, source: r.source, received: r.feedback.length, added: 1 }) });
        const result = await triage.pull({ fetchImpl, key, now: NOW, options: { run } });
        expect(seen).toEqual([[triage.TIMEHUT_FEEDBACK_URL + '?days=30', 'Bearer ' + key]]);
        expect(result).toEqual({ pulled: true, receipts: [{ source: 'timehut-app', received: 1, added: 1 }, { source: 'timehut-line', received: 1, added: 1 }] });
        expect(calls[0].request).toEqual({ schemaVersion: 1, source: 'timehut-app', collectedAt: NOW,
            feedback: [{ id: 'a1', message: '閃退', createdAt: NOW - HOUR, version: '1.0.18', channel: 'android-play', reporter: '小…明', hasImage: true }] });
        expect(calls[1].request.feedback).toEqual([{ id: 'l1', message: '照片傳不上去', createdAt: NOW - 2 * HOUR, category: 'upload', channel: 'line' }]);
    });
    test('no key, an older server, or a bad answer imports nothing', async () => {
        const { run, calls } = fakeRailway({});
        expect(await triage.pull({ key: null, options: { run } })).toMatchObject({ pulled: false });
        expect(await triage.pull({ key, fetchImpl: json(404, {}), options: { run } })).toEqual({ pulled: false, reason: 'server has no feedback endpoint yet' });
        expect(await triage.pull({ key, fetchImpl: json(401, {}), options: { run } })).toEqual({ pulled: false, reason: 'HTTP 401' });
        expect(await triage.pull({ key, fetchImpl: json(200, { schema: 2 }), options: { run } })).toEqual({ pulled: false, reason: 'unexpected answer' });
        expect(calls).toHaveLength(0);
    });
});
