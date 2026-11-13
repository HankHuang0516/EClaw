/**
 * AiHankApps 管理中樞 — problem reports and the alert schedule's notes (aihankapps-hub-inbox.js, scripts/aihankapps-hub-note.js,
 * the feedback branch of scripts/aihankapps-hub-import.js). Everything here is synthetic.
 */
const inbox = require('../../aihankapps-hub-inbox');
const noteScript = require('../../scripts/aihankapps-hub-note');

const APPS = new Set(['timehut', 'eclawbot', 'alpha']);
const NOW = Date.UTC(2026, 10, 13, 2, 0);

// Records every statement; answers what each test sets up.
function recordingPool(answers = {}) {
    const pool = { direct: [], tx: [], released: 0 };
    const answer = (sql, values) => {
        for (const [needle, rows] of Object.entries(answers)) if (sql.includes(needle)) return { rows: typeof rows === 'function' ? rows(sql, values) : rows };
        return { rows: [] };
    };
    pool.query = async (sql, values) => { pool.direct.push({ sql, values }); return answer(sql, values); };
    pool.connect = async () => ({ query: async (sql, values) => { pool.tx.push({ sql, values }); return answer(sql, values); }, release: () => { pool.released += 1; } });
    return pool;
}

describe('alert notes: what the schedule may write', () => {
    const ok = { ref: 'worker-bad-timehut-mcode.minimax_quota_exhausted@20261113-0830', state: 'auto', note: 'MiniMax 額度用完，15:00 自動重試', by: 'alert-schedule' };
    test('a plain note, a closed one, and a human one with what Hank should do', () => {
        expect(inbox.validateNote(ok, APPS)).toEqual({ ref: ok.ref, state: 'auto', note: ok.note, ask: null, title: null, app: null, by: 'alert-schedule', standalone: false });
        expect(inbox.validateNote({ ref: 'fb-eclaw-41', state: 'done', note: '重複回報' }, APPS).by).toBe('schedule');
        expect(inbox.validateNote({ ref: 'fb-timehut-line-L1', state: 'human', note: '要改伺服器上限', ask: '請決定要不要開 session 修', app: 'timehut' }, APPS))
            .toMatchObject({ state: 'human', ask: '請決定要不要開 session 修', app: 'timehut' });
    });
    test('refused: no ask for a human note, unknown fields, bad refs, unknown apps, secrets and phone numbers', () => {
        const code = input => { try { inbox.validateNote(input, APPS); return 'accepted'; } catch (error) { return error.code; } };
        expect(code({ ...ok, state: 'human' })).toBe('NOTE_ASK_REQUIRED');
        expect(code({ ...ok, extra: 1 })).toBe('NOTE_SHAPE');
        expect(code({ ...ok, ref: 'has space' })).toBe('NOTE_REF');
        expect(code({ ...ok, state: 'maybe' })).toBe('NOTE_STATE');
        expect(code({ ...ok, note: '   ' })).toBe('NOTE_TEXT');
        expect(code({ ...ok, app: 'ghost' })).toBe('NOTE_APP');
        expect(code({ ...ok, note: '金鑰是 ' + 'a'.repeat(48) })).toBe('NOTE_SENSITIVE');
        expect(code({ ...ok, note: '請打 0912-345-678' })).toBe('NOTE_SENSITIVE');
        expect(code({ ...ok, note: 'token sk-ABCDEFGHIJKLMNOP' })).toBe('NOTE_SENSITIVE');
        // a standalone note needs a readable slug and a title
        expect(code({ ref: 'human-line-quota', state: 'human', note: '本月已用 70%', ask: '請決定是否升級方案' })).toBe('NOTE_TITLE_REQUIRED');
        expect(code({ ref: 'human-Line Quota', state: 'human', note: 'x', ask: 'y', title: 't' })).toBe('NOTE_REF');
        expect(code({ ref: 'human-line-quota', state: 'human', note: '本月已用 70%', ask: '請決定是否升級方案', title: 'LINE 推播額度快用完' })).toBe('accepted');
        expect(code({ ref: 'human-line-quota', state: 'done', note: '已升級' })).toBe('accepted');
    });
    test('control characters are flattened and long text is cut, never passed through', () => {
        const n = inbox.validateNote({ ...ok, note: 'a\u0000b\u0007c' + '字'.repeat(2000) }, APPS);
        expect(n.note.startsWith('a b c')).toBe(true);
        expect(n.note).toHaveLength(1000);
    });
    test('saving creates the table once, upserts, and keeps a short history', async () => {
        const pool = recordingPool({ 'RETURNING ref, state, updated_at': [{ ref: ok.ref, state: 'auto', updated_at: new Date(NOW) }] });
        expect(await inbox.setNote(pool, ok, { appIds: APPS })).toEqual({ ref: ok.ref, state: 'auto', updatedAt: NOW });
        await inbox.setNote(pool, { ...ok, state: 'done', note: '已恢復' }, { appIds: APPS });
        const creates = pool.direct.filter(q => /^CREATE/.test(q.sql.trim()));
        expect(creates).toHaveLength(inbox.SCHEMA.length);           // prepared once per pool
        const upserts = pool.direct.filter(q => q.sql.includes('INSERT INTO aihankapps_hub_notes'));
        expect(upserts).toHaveLength(2);
        expect(upserts[0].sql).toMatch(/ON CONFLICT \(ref\) DO UPDATE/);
        expect(upserts[0].sql).toMatch(/OFFSET GREATEST\(jsonb_array_length\(aihankapps_hub_notes.history\) \+ 1 - 20, 0\)/);
        expect(upserts[1].values.slice(0, 8)).toEqual([ok.ref, null, 'done', null, '已恢復', null, false, 'alert-schedule']);
        expect(JSON.parse(upserts[1].values[8])).toMatchObject({ state: 'done', note: '已恢復', by: 'alert-schedule' });
        // nothing outside the hub's own table is written
        expect(pool.direct.map(q => q.sql).join('\n')).not.toMatch(/INSERT INTO (?!aihankapps_hub_notes)|UPDATE (?!SET)|DELETE/);
    });
});

describe('the note script (railway ssh)', () => {
    test('set and list; anything else is refused', async () => {
        const pool = recordingPool({ 'RETURNING ref, state, updated_at': [{ ref: 'fb-eclaw-41', state: 'done', updated_at: new Date(NOW) }],
            'FROM aihankapps_hub_notes': [{ ref: 'fb-eclaw-41', app_id: 'eclawbot', state: 'done', title: null, note: '重複', ask: null, standalone: false, by_who: 'schedule', created_at: new Date(NOW), updated_at: new Date(NOW), history: [] }] });
        expect(await noteScript.run(pool, { action: 'set', ref: 'fb-eclaw-41', state: 'done', note: '重複' }, { appIds: APPS })).toEqual({ saved: { ref: 'fb-eclaw-41', state: 'done', updatedAt: NOW } });
        const listed = await noteScript.run(pool, { action: 'list' }, { appIds: APPS });
        expect(listed.notes[0]).toMatchObject({ ref: 'fb-eclaw-41', app: 'eclawbot', state: 'done', note: '重複' });
        expect(pool.direct.filter(q => q.sql.includes('SELECT ref, app_id')).pop().sql).toMatch(/WHERE state <> 'done' OR updated_at >= NOW\(\) - INTERVAL '7 days'/);
        await noteScript.run(pool, { action: 'list', all: true }, { appIds: APPS });
        expect(pool.direct.filter(q => q.sql.includes('SELECT ref, app_id')).pop().sql).not.toMatch(/WHERE/);
        await expect(noteScript.run(pool, { action: 'delete', ref: 'x' }, { appIds: APPS })).rejects.toMatchObject({ code: 'NOTE_ACTION' });
        await expect(noteScript.run(pool, [], { appIds: APPS })).rejects.toMatchObject({ code: 'NOTE_SHAPE' });
    });
});

describe('imported reports (拾光AI雲端相簿)', () => {
    const envelope = (feedback, more = {}) => ({ schemaVersion: 1, source: 'timehut-line', collectedAt: NOW, feedback, ...more });
    const item = { id: 'L-1', category: 'upload', message: '照片傳不上去', channel: 'line', createdAt: NOW - 3600000 };
    test('each source may only report for its own app; the batch is all or nothing', () => {
        expect(inbox.validateFeedbackEnvelope(envelope([item]), APPS)).toEqual({ source: 'timehut-line', app: 'timehut', collectedAt: NOW,
            items: [{ id: 'L-1', category: 'upload', message: '照片傳不上去', version: null, channel: 'line', reporter: null, hasImage: false, createdAt: NOW - 3600000 }] });
        const code = e => { try { inbox.validateFeedbackEnvelope(e, APPS); return 'accepted'; } catch (error) { return error.code; } };
        expect(code(envelope([item], { source: 'eclaw' }))).toBe('FEEDBACK_SOURCE');
        expect(code(envelope([item], { app: 'alpha' }))).toBe('FEEDBACK_SHAPE');
        expect(code(envelope([item, item]))).toBe('FEEDBACK_ITEM');                       // duplicate id
        expect(code(envelope([{ ...item, message: ' ' }]))).toBe('FEEDBACK_ITEM');
        expect(code(envelope([{ ...item, lineUserId: 'U123' }]))).toBe('FEEDBACK_ITEM');  // nothing beyond the listed fields
        expect(code(envelope([{ ...item, createdAt: NOW + 7200000 }]))).toBe('FEEDBACK_ITEM');
        expect(code(envelope(new Array(201).fill(0).map((_, i) => ({ ...item, id: 'L-' + i }))))).toBe('FEEDBACK_SHAPE');
        expect(code(envelope([item], { collectedAt: Date.now() + 2 * 3600000 }))).toBe('FEEDBACK_TIME');
        expect(code({ ...envelope([item]), feedback: 'x' })).toBe('FEEDBACK_SHAPE');
        expect(code(envelope([item], { source: 'timehut-app' }))).toBe('accepted');
        expect((() => { try { inbox.validateFeedbackEnvelope(envelope([item]), new Set(['eclawbot'])); return 'accepted'; } catch (error) { return error.code; } })()).toBe('FEEDBACK_APP');
    });
    test('importing upserts each report and records the receipt, in one transaction', async () => {
        const pool = recordingPool({ 'RETURNING (xmax = 0) AS inserted': [{ inserted: true }] });
        expect(await inbox.importFeedback(pool, envelope([item, { ...item, id: 'L-2', message: '第二則' }]), { appIds: APPS })).toEqual({ source: 'timehut-line', received: 2, added: 2 });
        const sql = pool.tx.map(q => q.sql.trim().split(/\s+/).slice(0, 3).join(' '));
        expect(sql[0]).toBe('BEGIN');
        expect(sql.at(-1)).toBe('COMMIT');
        expect(pool.tx.filter(q => q.sql.includes('INSERT INTO aihankapps_hub_feedback'))).toHaveLength(2);
        const receipt = pool.tx.find(q => q.sql.includes('INSERT INTO aihankapps_hub_sources'));
        expect(receipt.values[0]).toBe('feedback-timehut-line');
        expect(pool.released).toBe(1);
    });
    test('a failed write rolls the whole batch back', async () => {
        const pool = recordingPool({ 'INSERT INTO aihankapps_hub_feedback': () => { throw new Error('boom'); } });
        await expect(inbox.importFeedback(pool, envelope([item]), { appIds: APPS })).rejects.toThrow('boom');
        expect(pool.tx.map(q => q.sql)).toContain('ROLLBACK');
        expect(pool.released).toBe(1);
    });
});

describe('reading the inbox', () => {
    test('EClaw\'s automatic passive-health reports become one alert per entity and day, not one per report', async () => {
        const msg = n => '[passive-health] Entity #' + n + ' still unhealthy after 3 self-repair attempts.\nChannel provider: custom.\nFailing signals: callback_unhealthy.';
        const pool = recordingPool({ 'to_regclass': [{ t: 'x' }],
            "app_version = 'passive-health'": [{ message: msg(18), created_at: String(NOW - 1000) }, { message: msg(18), created_at: String(NOW - 9000) }, { message: msg(15), created_at: String(NOW - 5000) }, { message: 'no entity here', created_at: String(NOW) }],
            "COALESCE(app_version, '') <> 'passive-health'": [] });
        const client = await pool.connect();
        const read = await inbox.readInbox((sql, values) => client.query(sql, values), { now: NOW, appIds: APPS });
        expect(read.feedback.map(f => [f.ref, f.source, f.count])).toEqual([['fb-eclaw-health-e18@20261113', 'eclaw-health', 2], ['fb-eclaw-health-e15@20261113', 'eclaw-health', 1]]);
        expect(read.feedback[0].text).toBe('被動健康檢查在過去 24 小時回報 2 次：實體 #18 自我修復 3 次後仍不健康（callback_unhealthy；通道 custom）。');
        expect(pool.tx.find(q => q.sql.includes("app_version = 'passive-health'")).values).toEqual([NOW - 86400000]);
    });

    test('maps every source, skips a table that does not exist, and only keeps apps the catalog knows', async () => {
        const rows = {
            'to_regclass': (_sql, values) => [{ t: values[0] === 'public.fraud_app_feedback_reports' ? null : 'x' }],
            'FROM feedback': [{ id: 3, message: '登入失敗', category: 'bug', app_version: '2.0', source: 'ios', created_at: String(NOW - 1000) }],
            "comment <> ''": [{ id: '9', app_id: 'ghost', rating: 1, continuation: 'no', comment: 'x', app_version: '1', platform: 'web', created_at: new Date(NOW - 2000) },
                { id: '10', app_id: 'alpha', rating: 5, continuation: 'yes', comment: '很好用但會閃退', app_version: '1', platform: 'web', created_at: new Date(NOW - 3000) }],
            'FROM aihankapps_hub_feedback': [{ source: 'timehut-app', ext_id: 'a/b', app_id: 'timehut', channel: 'ios-appstore', category: null, message: '閃退', version: '1.0.18', reporter: '小…明', has_image: true, created_at: new Date(NOW - 500) }],
            'FROM aihankapps_hub_notes': [{ ref: 'fb-eclaw-3', app_id: 'eclawbot', state: 'auto', title: null, note: '查看中', ask: null, standalone: false, by_who: 'schedule', created_at: new Date(NOW), updated_at: new Date(NOW) }],
        };
        const pool = recordingPool(rows);
        const client = await pool.connect();
        const read = await inbox.readInbox((sql, values) => client.query(sql, values), { now: NOW, appIds: APPS });
        expect(read.partial).toEqual(['fraud_app_feedback_reports']);
        expect(read.feedback.map(f => [f.ref, f.app, f.source])).toEqual([['fb-timehut-app-a_b', 'timehut', 'timehut-app'], ['fb-eclaw-3', 'eclawbot', 'eclaw'], ['fb-beta-10', 'alpha', 'beta']]);
        expect(read.feedback[0]).toMatchObject({ text: '閃退', version: '1.0.18', channel: 'ios-appstore', reporter: '小…明', hasImage: true, at: NOW - 500 });
        expect(read.feedback[2]).toMatchObject({ rating: 5, continuation: 'yes', text: '很好用但會閃退' });
        expect(read.notes).toEqual([{ ref: 'fb-eclaw-3', app: 'eclawbot', state: 'auto', title: null, note: '查看中', ask: null, standalone: false, by: 'schedule', createdAt: NOW, updatedAt: NOW }]);
        // the 30-day window, and the EClawbot feedback table's own millisecond clock
        const eclaw = pool.tx.find(q => q.sql.includes('FROM feedback'));
        expect(eclaw.values).toEqual([NOW - 30 * 86400000]);
        expect(eclaw.sql).not.toMatch(/device_secret|log_snapshot|device_state|device_id/);
        expect(pool.tx.map(q => q.sql).join('\n')).not.toMatch(/\b(INSERT|UPDATE|DELETE|CREATE)\b/);
    });
});
