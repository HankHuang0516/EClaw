/**
 * AiHankApps 管理中樞 — problem reports as alerts, and what the alert schedule decided about each alert.
 *
 * Hank, 2026-11-13: "拾光相簿的APP的問題回饋以及其他APP的問題回饋都需要連結上管理中樞的警示 … 確保排程可以自主處理判斷
 * 所有的警示問題 如果需要人為介入就讓排程發一個警示把詳情打上去 讓我看到需要我怎麼幫忙 我全程只盯管理中樞".
 *
 * 1. Problem reports (read for the hub's data answer, inside its read-only transaction):
 *    - EClawbot:   feedback (the app's own /api/feedback). Its automatic "[passive-health]" reports (an entity still unhealthy
 *                  after self-repair, a dozen a day from one reporter) are folded into one alert per entity and day.
 *    - 詐騙帝國:    fraud_app_feedback_reports (/api/fraud-app-feedback)
 *    - every app:  app_portfolio_beta_feedback rows that carry a comment or a low rating (the portfolio's 內測回饋)
 *    - 拾光AI雲端相簿 (App 內回報、LINE 問題回饋): its server keeps them; the operator's collector reads them with the
 *      hub's key and imports them here (aihankapps_hub_feedback), like every other back-end number.
 *    Only reports from the last FEEDBACK_DAYS days are shown. The data answer is admin-only and private/no-store.
 *
 * 2. Alert notes (aihankapps_hub_notes): one row per notification ID, written by the alert schedule on the operator's
 *    Mac through the existing deployment channel (scripts/aihankapps-hub-note.js over `railway ssh`). No HTTP write API.
 *      auto  — the schedule is handling it, or it clears by itself; the note says how and when.
 *      human — only Hank can clear it; `ask` says exactly what he needs to do. The hub shows it as a severe alert.
 *      done  — the schedule closed it (a report that needed nothing, a duplicate, a fixed problem…).
 *    A note may also stand alone (a problem the schedule found that no rule shows): ref "human-<slug>".
 *
 * Everything written lives in the hub's own two tables here; no existing table is written.
 */

'use strict';

const DAY_MS = 86400000;
const FEEDBACK_DAYS = 30;
const PER_SOURCE = 60;                 // newest reports per source in the data answer
const TEXT_MAX = 1200;                 // characters of a report kept in the data answer
const NOTE_STATES = ['auto', 'human', 'done'];
const REF = /^[A-Za-z0-9._@:-]{1,200}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{1,60}$/;
const ECLAW_APP = 'eclawbot', FRAUD_APP = 'com.hankhuang.fraudempire', TIMEHUT_APP = 'timehut';
// Imported report sources and the one app each may report for.
const IMPORT_SOURCES = { 'timehut-app': TIMEHUT_APP, 'timehut-line': TIMEHUT_APP };
const MAX_IMPORT_ITEMS = 200, MAX_HISTORY = 20;

const SCHEMA = [
    `CREATE TABLE IF NOT EXISTS aihankapps_hub_feedback (
        source TEXT NOT NULL, ext_id TEXT NOT NULL, app_id TEXT NOT NULL, channel TEXT, category TEXT, message TEXT NOT NULL,
        version TEXT, reporter TEXT, has_image BOOLEAN NOT NULL DEFAULT FALSE, created_at TIMESTAMPTZ NOT NULL,
        imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (source, ext_id))`,
    'CREATE INDEX IF NOT EXISTS idx_aihankapps_hub_feedback_created ON aihankapps_hub_feedback (created_at DESC)',
    `CREATE TABLE IF NOT EXISTS aihankapps_hub_notes (
        ref TEXT PRIMARY KEY, app_id TEXT, state TEXT NOT NULL CHECK (state IN ('auto', 'human', 'done')), title TEXT,
        note TEXT NOT NULL, ask TEXT, standalone BOOLEAN NOT NULL DEFAULT FALSE, by_who TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), history JSONB NOT NULL DEFAULT '[]'::jsonb)`,
];
const preparations = new WeakMap();
function prepare(pool) {
    if (!pool) return Promise.reject(new Error('POOL_UNAVAILABLE'));
    if (!preparations.has(pool)) {
        const promise = (async () => { for (const sql of SCHEMA) await pool.query(sql); })().catch(error => { preparations.delete(pool); throw error; });
        preparations.set(pool, promise);
    }
    return preparations.get(pool);
}

function fail(code) { const error = new Error(code); error.code = code; throw error; }
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const clean = (value, max) => (typeof value === 'string' ? value.replace(CONTROL, ' ').trim().slice(0, max) : '');
const ms = value => { const t = value instanceof Date ? value.getTime() : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : typeof value === 'number' ? value : Date.parse(value); return Number.isFinite(t) ? t : null; };
const safeRef = value => String(value).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);

// EClaw's passive health check files "[passive-health] Entity #18 still unhealthy after 3 self-repair attempts.
// Channel provider: custom. Failing signals: callback_unhealthy." as feedback, many times a day. One alert per entity and
// Taipei day (the newest report's day), saying how often it was reported in the last 24 hours.
const PASSIVE = 'passive-health';
function passiveHealth(rows) {
    const byEntity = new Map();
    for (const r of rows) {
        const text = String(r.message || ''), entity = (text.match(/Entity #(\d{1,6})/) || [])[1];
        if (!entity) continue;
        const at = ms(r.created_at), e = byEntity.get(entity) || { entity, count: 0, at: 0, signals: new Set(), provider: null };
        e.count += 1;
        if (at > e.at) { e.at = at; e.provider = clean((text.match(/Channel provider: ([^\n.]{1,40})/) || [])[1], 40) || null; }
        for (const s of clean((text.match(/Failing signals: ([^\n]{1,200})/) || [])[1], 200).replace(/\.$/, '').split(/,\s*/)) if (s) e.signals.add(s);
        byEntity.set(entity, e);
    }
    return [...byEntity.values()].map(e => {
        const day = new Date(e.at + 8 * 3600000).toISOString().slice(0, 10).replace(/-/g, '');
        return { ref: 'fb-eclaw-health-e' + e.entity + '@' + day, source: 'eclaw-health', app: ECLAW_APP, category: 'health',
            text: '被動健康檢查在過去 24 小時回報 ' + e.count + ' 次：實體 #' + e.entity + ' 自我修復 3 次後仍不健康（' + ([...e.signals].join('、') || '沒有寫原因') + (e.provider ? '；通道 ' + e.provider : '') + '）。',
            version: null, channel: e.provider, reporter: null, rating: null, hasImage: false, at: e.at, entity: Number(e.entity), count: e.count };
    });
}

// Notes and reports must not carry secrets or phone numbers: they are shown on a page and kept in a table.
const SENSITIVE = [/[A-Za-z0-9_\-+/]{40,}={0,2}/, /\b09\d{2}[- ]?\d{3}[- ]?\d{3}\b/, /\b(?:sk|pk|rk|ghp|gho|xox[abp])[-_][A-Za-z0-9]{12,}/i, /BEGIN [A-Z ]*PRIVATE KEY/];
const sensitive = text => SENSITIVE.some(re => re.test(text));

// ---- reading (inside the hub answer's read-only transaction) ---------------------------------------------------------
async function exists(query, table) {
    return !!(await query('SELECT to_regclass($1) AS t', ['public.' + table])).rows[0].t;
}

// → { feedback: [{ ref, source, app, category, text, version, channel, reporter, rating, hasImage, at }], notes: [...], partial: [...] }
async function readInbox(query, { now = Date.now(), appIds = null } = {}) {
    const since = now - FEEDBACK_DAYS * DAY_MS, feedback = [], partial = [];
    const known = appIds instanceof Set ? appIds : null;
    const push = item => { if (!known || known.has(item.app)) feedback.push(item); };

    if (await exists(query, 'feedback')) {
        const rows = (await query(`SELECT id, message, category, app_version, source, created_at::text AS created_at FROM feedback
            WHERE created_at >= $1 AND COALESCE(app_version, '') <> '${PASSIVE}' ORDER BY created_at DESC LIMIT ${PER_SOURCE}`, [since])).rows;
        for (const r of rows) push({ ref: 'fb-eclaw-' + safeRef(r.id), source: 'eclaw', app: ECLAW_APP, category: clean(r.category, 32) || null,
            text: clean(r.message, TEXT_MAX), version: clean(r.app_version, 64) || null, channel: clean(r.source, 32) || null, reporter: null, rating: null, hasImage: false, at: ms(r.created_at) });
        const health = (await query(`SELECT message, created_at::text AS created_at FROM feedback
            WHERE created_at >= $1 AND app_version = '${PASSIVE}' ORDER BY created_at DESC LIMIT 500`, [now - DAY_MS])).rows;
        for (const item of passiveHealth(health)) push(item);
    } else partial.push('feedback');

    if (await exists(query, 'fraud_app_feedback_reports')) {
        const rows = (await query(`SELECT id::text AS id, category, description, app_version, screen, created_at FROM fraud_app_feedback_reports
            WHERE created_at >= $1 ORDER BY created_at DESC LIMIT ${PER_SOURCE}`, [new Date(since)])).rows;
        for (const r of rows) push({ ref: 'fb-fraud-' + safeRef(r.id), source: 'fraud', app: FRAUD_APP, category: clean(r.category, 32) || null,
            text: clean(r.description, TEXT_MAX), version: clean(r.app_version, 64) || null, channel: clean(r.screen, 64) || null, reporter: null, rating: null, hasImage: false, at: ms(r.created_at) });
    } else partial.push('fraud_app_feedback_reports');

    if (await exists(query, 'app_portfolio_beta_feedback')) {
        // A five-star "keep going" with nothing written is a vote, not a problem report.
        const rows = (await query(`SELECT id::text AS id, app_id, rating, continuation, comment, app_version, platform, created_at FROM app_portfolio_beta_feedback
            WHERE created_at >= $1 AND (comment <> '' OR rating <= 3) ORDER BY created_at DESC LIMIT ${PER_SOURCE}`, [new Date(since)])).rows;
        for (const r of rows) push({ ref: 'fb-beta-' + safeRef(r.id), source: 'beta', app: String(r.app_id), category: 'beta',
            text: clean(r.comment, TEXT_MAX), version: clean(r.app_version, 32) || null, channel: clean(r.platform, 32) || null, reporter: null,
            rating: Number.isInteger(r.rating) ? r.rating : null, continuation: clean(r.continuation, 8) || null, hasImage: false, at: ms(r.created_at) });
    } else partial.push('app_portfolio_beta_feedback');

    const rows = (await query(`SELECT source, ext_id, app_id, channel, category, message, version, reporter, has_image, created_at FROM aihankapps_hub_feedback
        WHERE created_at >= $1 ORDER BY created_at DESC LIMIT ${PER_SOURCE * 2}`, [new Date(since)])).rows;
    for (const r of rows) push({ ref: 'fb-' + r.source + '-' + safeRef(r.ext_id), source: r.source, app: r.app_id, category: r.category || null,
        text: clean(r.message, TEXT_MAX), version: r.version || null, channel: r.channel || null, reporter: r.reporter || null, rating: null, hasImage: r.has_image === true, at: ms(r.created_at) });

    feedback.sort((a, b) => (b.at || 0) - (a.at || 0));
    // Open notes, and closed ones recent enough to still matter (a closed report is hidden only while it is shown).
    const notes = (await query(`SELECT ref, app_id, state, title, note, ask, standalone, by_who, created_at, updated_at FROM aihankapps_hub_notes
        WHERE state <> 'done' OR updated_at >= $1 ORDER BY updated_at DESC LIMIT 500`, [new Date(since)])).rows
        .map(r => ({ ref: r.ref, app: r.app_id || null, state: r.state, title: r.title || null, note: r.note, ask: r.ask || null, standalone: r.standalone === true,
            by: r.by_who, createdAt: ms(r.created_at), updatedAt: ms(r.updated_at) }));
    return { feedback, notes, partial, days: FEEDBACK_DAYS };
}

// ---- writing (operator scripts only) ---------------------------------------------------------------------------------
// { ref, state, note, ask?, title?, app?, by } → stored. A "human" note must say what Hank should do (ask).
function validateNote(input, appIds) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('NOTE_SHAPE');
    if (Object.keys(input).some(k => !['ref', 'state', 'note', 'ask', 'title', 'app', 'by', 'standalone'].includes(k))) fail('NOTE_SHAPE');
    if (typeof input.ref !== 'string' || !REF.test(input.ref)) fail('NOTE_REF');
    if (!NOTE_STATES.includes(input.state)) fail('NOTE_STATE');
    const note = clean(input.note, 1000), ask = clean(input.ask, 1000), title = clean(input.title, 120), by = clean(input.by, 40) || 'schedule';
    if (!note) fail('NOTE_TEXT');
    if (input.state === 'human' && !ask) fail('NOTE_ASK_REQUIRED');
    if ([note, ask, title].some(sensitive)) fail('NOTE_SENSITIVE');
    const standalone = input.standalone === true || input.ref.startsWith('human-');
    if (standalone && !SLUG.test(input.ref.slice('human-'.length))) fail('NOTE_REF');
    if (standalone && input.state !== 'done' && !title) fail('NOTE_TITLE_REQUIRED');
    let app = null;
    if (input.app !== undefined && input.app !== null) {
        if (typeof input.app !== 'string' || (appIds && !appIds.has(input.app))) fail('NOTE_APP');
        app = input.app;
    }
    return { ref: input.ref, state: input.state, note, ask: ask || null, title: title || null, app, by, standalone };
}

async function setNote(pool, input, { appIds } = {}) {
    const n = validateNote(input, appIds instanceof Set ? appIds : null);
    await prepare(pool);
    const entry = { at: new Date().toISOString(), state: n.state, note: n.note, by: n.by };
    const row = (await pool.query(`INSERT INTO aihankapps_hub_notes (ref, app_id, state, title, note, ask, standalone, by_who, history)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, jsonb_build_array($9::jsonb))
        ON CONFLICT (ref) DO UPDATE SET app_id = COALESCE(EXCLUDED.app_id, aihankapps_hub_notes.app_id), state = EXCLUDED.state,
            title = COALESCE(EXCLUDED.title, aihankapps_hub_notes.title), note = EXCLUDED.note, ask = EXCLUDED.ask,
            standalone = aihankapps_hub_notes.standalone OR EXCLUDED.standalone, by_who = EXCLUDED.by_who, updated_at = NOW(),
            history = (SELECT COALESCE(jsonb_agg(h), '[]'::jsonb) FROM (SELECT h FROM jsonb_array_elements(aihankapps_hub_notes.history || jsonb_build_array($9::jsonb)) AS h
                OFFSET GREATEST(jsonb_array_length(aihankapps_hub_notes.history) + 1 - ${MAX_HISTORY}, 0)) AS kept)
        RETURNING ref, state, updated_at`, [n.ref, n.app, n.state, n.title, n.note, n.ask, n.standalone, n.by, JSON.stringify(entry)])).rows[0];
    return { ref: row.ref, state: row.state, updatedAt: ms(row.updated_at) };
}

async function listNotes(pool, { all = false } = {}) {
    await prepare(pool);
    const rows = (await pool.query(`SELECT ref, app_id, state, title, note, ask, standalone, by_who, created_at, updated_at, history FROM aihankapps_hub_notes
        ${all ? '' : "WHERE state <> 'done' OR updated_at >= NOW() - INTERVAL '7 days'"} ORDER BY updated_at DESC LIMIT 500`)).rows;
    return rows.map(r => ({ ref: r.ref, app: r.app_id, state: r.state, title: r.title, note: r.note, ask: r.ask, standalone: r.standalone, by: r.by_who,
        createdAt: ms(r.created_at), updatedAt: ms(r.updated_at), history: r.history }));
}

// { schemaVersion: 1, source: 'timehut-app' | 'timehut-line', collectedAt, feedback: [{ id, category?, message, version?,
//   channel?, reporter?, hasImage?, createdAt }] } → upserted reports. Anything unexpected is refused whole.
function validateFeedbackEnvelope(envelope, appIds) {
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) fail('FEEDBACK_SHAPE');
    if (Object.keys(envelope).some(k => !['schemaVersion', 'source', 'collectedAt', 'feedback'].includes(k))) fail('FEEDBACK_SHAPE');
    if (envelope.schemaVersion !== 1 || !Object.prototype.hasOwnProperty.call(IMPORT_SOURCES, envelope.source)) fail('FEEDBACK_SOURCE');
    const app = IMPORT_SOURCES[envelope.source];
    if (appIds && !appIds.has(app)) fail('FEEDBACK_APP');
    const at = envelope.collectedAt;
    if (!Number.isSafeInteger(at) || at < Date.UTC(2026, 0, 1) || at > Date.now() + 3600000) fail('FEEDBACK_TIME');
    if (!Array.isArray(envelope.feedback) || envelope.feedback.length > MAX_IMPORT_ITEMS) fail('FEEDBACK_SHAPE');
    const ids = new Set();
    const items = envelope.feedback.map(item => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) fail('FEEDBACK_ITEM');
        if (Object.keys(item).some(k => !['id', 'category', 'message', 'version', 'channel', 'reporter', 'hasImage', 'createdAt'].includes(k))) fail('FEEDBACK_ITEM');
        if (typeof item.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(item.id) || ids.has(item.id)) fail('FEEDBACK_ITEM');
        ids.add(item.id);
        const message = clean(item.message, 4000);
        if (!message) fail('FEEDBACK_ITEM');
        if (!Number.isSafeInteger(item.createdAt) || item.createdAt < Date.UTC(2025, 0, 1) || item.createdAt > at + 3600000) fail('FEEDBACK_ITEM');
        if (item.hasImage !== undefined && typeof item.hasImage !== 'boolean') fail('FEEDBACK_ITEM');
        return { id: item.id, category: clean(item.category, 40) || null, message, version: clean(item.version, 80) || null, channel: clean(item.channel, 40) || null,
            reporter: clean(item.reporter, 60) || null, hasImage: item.hasImage === true, createdAt: item.createdAt };
    });
    return { source: envelope.source, app, collectedAt: at, items };
}

async function importFeedback(pool, envelope, { appIds } = {}) {
    const clean = validateFeedbackEnvelope(envelope, appIds instanceof Set ? appIds : null);
    await prepare(pool);
    let added = 0;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        for (const item of clean.items) {
            const r = await client.query(`INSERT INTO aihankapps_hub_feedback (source, ext_id, app_id, channel, category, message, version, reporter, has_image, created_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                ON CONFLICT (source, ext_id) DO UPDATE SET channel = EXCLUDED.channel, category = EXCLUDED.category, message = EXCLUDED.message,
                    version = EXCLUDED.version, reporter = EXCLUDED.reporter, has_image = EXCLUDED.has_image
                RETURNING (xmax = 0) AS inserted`,
            [clean.source, item.id, clean.app, item.channel, item.category, item.message, item.version, item.reporter, item.hasImage, new Date(item.createdAt)]);
            if (r.rows[0] && r.rows[0].inserted) added += 1;
        }
        await client.query(`INSERT INTO aihankapps_hub_sources (id, collected_at, detail) VALUES ($1, $2, $3::jsonb)
            ON CONFLICT (id) DO UPDATE SET collected_at = EXCLUDED.collected_at, imported_at = NOW(), detail = EXCLUDED.detail`,
        ['feedback-' + clean.source, new Date(clean.collectedAt), JSON.stringify({ values: clean.items.length, facts: 0, notes: [] })]);
        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
    } finally {
        client.release();
    }
    return { source: clean.source, received: clean.items.length, added };
}

module.exports = { SCHEMA, FEEDBACK_DAYS, NOTE_STATES, IMPORT_SOURCES, prepare, readInbox, validateNote, setNote, listNotes, validateFeedbackEnvelope, importFeedback, sensitive };
