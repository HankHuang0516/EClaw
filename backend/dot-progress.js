/** Portfolio progress. Only the explicit completed projection is public.
 * Private rows never live under public/; all admin operations use existing auth.
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { safeUpdatedAtToISO } = require('./safe-date');
const seed = require('./dot-progress-seed.json');
const schema = fs.readFileSync(path.join(__dirname, 'dot_progress_schema.sql'), 'utf8');
const FIELDS = ['title', 'status', 'summary', 'blockers', 'nextStep', 'completedWork', 'publicTitle', 'publicSummary', 'completedAt'];
const STATUSES = ['active', 'blocked', 'paused', 'completed', 'cancelled', 'archived'];
const ID = /^[a-z0-9][a-z0-9-]{0,79}$/;
const REQUEST_ID = /^[a-zA-Z0-9_-]{8,100}$/;

function fault(status, error) { return Object.assign(new Error(error), { status, code: error }); }
function text(value, max, required = false) {
    if (typeof value !== 'string' || value.includes('\0') || value.length > max || (required && !value.trim())) throw fault(400, 'invalid_text');
    return value.trim();
}
function normalize(input, prior = null) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw fault(400, 'invalid_project');
    if (Object.keys(input).some(k => ![...FIELDS, 'id', 'version', 'comments'].includes(k))) throw fault(400, 'unknown_field');
    const data = {};
    for (const key of FIELDS) {
        const value = input[key] === undefined ? (prior?.[key] ?? '') : input[key];
        data[key] = text(value, ['summary', 'blockers', 'nextStep', 'completedWork'].includes(key) ? 4000 : key === 'publicSummary' ? 400 : 160, key === 'title');
    }
    if (!STATUSES.includes(data.status)) throw fault(400, 'invalid_status');
    if (data.status !== 'completed') data.publicSummary = '';
    if (data.completedAt && (!/^\d{4}-\d{2}-\d{2}$/.test(data.completedAt) || Number.isNaN(Date.parse(data.completedAt)) || new Date(data.completedAt).toISOString().slice(0, 10) !== data.completedAt)) throw fault(400, 'invalid_date');
    if (data.publicSummary && (!data.publicTitle || !data.completedAt || data.status !== 'completed')) throw fault(400, 'publication_requires_completion');
    return data;
}
function rowProject(row) {
    return { id: row.id, ...row.data, completedWork: row.data.completedWork ?? '', version: row.version,
        pushCount: row.push_count ?? 0, lastPushedAt: row.last_pushed_at ?? null };
}
function publicProject(row) {
    const d = row.data;
    if (d.status !== 'completed' || !d.publicTitle || !d.publicSummary || !d.completedAt) return null;
    return { title: d.publicTitle, publicSummary: d.publicSummary, completedAt: d.completedAt };
}
function commentInput(input) {
    const body = text(input && input.body, 4000, true);
    if (typeof input.requestId !== 'string' || !REQUEST_ID.test(input.requestId)) throw fault(400, 'invalid_request_id');
    return { body, requestId: input.requestId };
}
function strictBody(input, allowed) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw fault(400, 'invalid_body');
    if (Object.keys(input).some(key => !allowed.includes(key))) throw fault(400, 'unknown_field');
    return input;
}
function positiveVersion(value) {
    if (!Number.isSafeInteger(value) || value < 1) throw fault(400, 'invalid_version');
    return value;
}
function requestId(value) {
    if (typeof value !== 'string' || !REQUEST_ID.test(value)) throw fault(400, 'invalid_request_id');
    return value;
}
const REVIEW_FIELDS = ['kind', 'title', 'body', 'occurredAt', 'source', 'scope'];
function reviewInput(input) {
    strictBody(input, [...REVIEW_FIELDS, 'requestId']);
    if (!['permission', 'decision', 'change'].includes(input.kind)) throw fault(400, 'invalid_kind');
    const occurredAt = text(input.occurredAt, 40, true);
    if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(occurredAt)
        || Number.isNaN(Date.parse(occurredAt)) || new Date(`${occurredAt.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) !== occurredAt.slice(0, 10)) throw fault(400, 'invalid_date');
    return { kind: input.kind, title: text(input.title, 160, true), body: text(input.body, 4000, true), occurredAt, source: text(input.source, 500, true), scope: text(input.scope, 500, true) };
}
const TIMELINE_FIELDS = ['startedAt', 'endedAt', 'projectId', 'projectLabel', 'workType', 'actions', 'result', 'blockers', 'nextStep', 'evidence', 'goal'];
const TIMELINE_TYPES = ['implementation', 'validation', 'routine', 'waiting', 'blocked'];
function publicTimelineEvidence(value) {
    if (typeof value !== 'string' || value.length > 500 || value !== value.trim() || !/^https:\/\/github\.com\/HankHuang0516\/EClaw\/(?:pull\/[1-9]\d*|actions\/runs\/[1-9]\d*|commit\/[a-fA-F0-9]{7,40})$/.test(value)) throw fault(400, 'unsafe_evidence');
    return value.replace(/(\/commit\/)([a-fA-F0-9]+)$/, (_all, prefix, hash) => prefix + hash.toLowerCase());
}
function timelineText(value, max, required = false) {
    const clean = text(value, max, required);
    if (/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(clean)
        || /\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|AIza[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{12,})\b/.test(clean)
        || /\b(?:api[_-]?key|botSecret|deviceSecret|access[_-]?token|refresh[_-]?token|password|secret|authorization)["']?\s*[:=]\s*\S+/i.test(clean)
        || /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/.test(clean)
        || /-----BEGIN [^-]*PRIVATE KEY-----/.test(clean)
        || /(?:\/(?:Users|home|private|tmp|var|etc|workspace|Volumes|mnt|opt|srv)(?:\/|\b)|~\/|[A-Za-z]:\\|file:\/\/|sediment:\/\/|library-file:|project-file:|skill:\/\/|codex:\/\/|data:|blob:)/i.test(clean)) throw fault(400, 'unsafe_timeline_text');
    // Links belong in the allowlisted evidence field. The same allowlist also
    // prevents capability links or signed/private URLs from entering free text.
    for (const link of clean.match(/https?:\/\/[^\s<>"']+/gi) || []) publicTimelineEvidence(link);
    return clean;
}
function timelineDate(value) {
    if (typeof value !== 'string' || !/^[1-9]\d{3}-\d{2}-\d{2}$/.test(value)
        || Number.isNaN(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) throw fault(400, 'invalid_date');
    return value;
}
function timelineTime(value) {
    // This interval journal has millisecond precision. Reject finer input rather
    // than silently rounding away an end-before-start or seven-day violation.
    if (typeof value !== 'string' || value.length > 40 || !/^[1-9]\d{3}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value) || Number.isNaN(Date.parse(value))) throw fault(400, 'invalid_time');
    timelineDate(value.slice(0, 10));
    const normalized = new Date(value).toISOString();
    if (!/^[1-9]\d{3}-/.test(normalized)) throw fault(400, 'invalid_time');
    return normalized;
}
function timelineInput(input, partial = false) {
    strictBody(input, [...TIMELINE_FIELDS, 'requestId', ...(partial ? ['version'] : [])]);
    const result = {};
    for (const key of TIMELINE_FIELDS) {
        // An omitted optional goal must not alter legacy canonical receipts.
        if ((partial || key === 'goal') && input[key] === undefined) continue;
        const value = input[key];
        if (['startedAt', 'endedAt'].includes(key)) result[key] = key === 'startedAt' && value === null ? null : timelineTime(value);
        else if (key === 'projectId') {
            if (value !== undefined && value !== null && (typeof value !== 'string' || !ID.test(value))) throw fault(400, 'invalid_id');
            result[key] = value ?? null;
        } else if (key === 'workType') {
            if (!TIMELINE_TYPES.includes(value)) throw fault(400, 'invalid_work_type');
            result[key] = value;
        } else if (key === 'evidence') {
            if (value !== undefined && (!Array.isArray(value) || value.length > 10)) throw fault(400, 'invalid_evidence');
            result[key] = (value || []).map(item => {
                strictBody(item, ['label', 'url']);
                return { label: timelineText(item.label, 160, true), url: publicTimelineEvidence(item.url) };
            });
        } else result[key] = timelineText(value === undefined && ['blockers', 'nextStep'].includes(key) ? '' : value, key === 'projectLabel' ? 160 : 4000, ['projectLabel', 'actions', 'result', 'goal'].includes(key));
    }
    if (partial && !Object.keys(result).length) throw fault(400, 'content_required');
    return result;
}
function timelineSpan(data) {
    if (data.startedAt === null) return; // Known milestone; no start or duration is inferred.
    const duration = Date.parse(data.endedAt) - Date.parse(data.startedAt);
    if (duration < 0 || duration > 604800000) throw fault(400, 'invalid_time_span');
}
function normalizeTimelineInput(input) {
    const data = timelineInput(input);
    timelineSpan(data);
    return { ...data, requestId: requestId(input.requestId) };
}
function timelineOffset(value) {
    if (value === undefined) return 0;
    if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,7})$/.test(value)) throw fault(400, 'invalid_offset');
    return Number(value);
}
function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
    return JSON.stringify(value);
}
function scheduleInput(input, date) {
    strictBody(input, ['requestId', 'version', 'rows', 'rowOrder']);
    const token = requestId(input.requestId);
    if (!Number.isSafeInteger(input.version) || input.version < 0) throw fault(400, 'invalid_version');
    if (!Array.isArray(input.rows) || input.rows.length > 50) throw fault(400, 'invalid_schedule_rows');
    const rowIds = new Set(); const actualIds = new Set();
    const lower = Date.parse(`${date}T00:00:00+08:00`); const upper = lower + 86400000;
    const rows = input.rows.map(row => {
        strictBody(row, ['id', 'projectId', 'projectLabel', 'goal', 'plannedStart', 'plannedEnd', 'status', 'actualIds', 'archived']);
        if (row.archived !== undefined && typeof row.archived !== 'boolean') throw fault(400, 'invalid_archived');
        if (typeof row.id !== 'string' || !ID.test(row.id) || rowIds.has(row.id)) throw fault(400, 'invalid_schedule_id');
        rowIds.add(row.id);
        if (row.projectId !== null && (typeof row.projectId !== 'string' || !ID.test(row.projectId))) throw fault(400, 'invalid_id');
        if (!['planned', 'active', 'waiting', 'done'].includes(row.status)) throw fault(400, 'invalid_schedule_status');
        let plannedStart = null; let plannedEnd = null;
        if (row.plannedStart !== null || row.plannedEnd !== null) {
            plannedStart = timelineTime(row.plannedStart); plannedEnd = timelineTime(row.plannedEnd);
            timelineSpan({ startedAt: plannedStart, endedAt: plannedEnd });
            const start = Date.parse(plannedStart); const end = Date.parse(plannedEnd);
            if (!(start < upper && (end > lower || (start === end && start >= lower)))) throw fault(400, 'schedule_date_mismatch');
        }
        if (!Array.isArray(row.actualIds)) throw fault(400, 'invalid_actual_ids');
        for (const id of row.actualIds) {
            if (typeof id !== 'string' || !ID.test(id) || actualIds.has(id) || actualIds.size >= 500) throw fault(400, 'invalid_actual_ids');
            actualIds.add(id);
        }
        return { id: row.id, projectId: row.projectId, projectLabel: timelineText(row.projectLabel, 160, true), goal: timelineText(row.goal, 4000, true), plannedStart, plannedEnd, status: row.status, actualIds: [...row.actualIds], ...(row.archived === true ? { archived: true } : {}) };
    });
    if (input.rowOrder !== undefined && (!Array.isArray(input.rowOrder) || input.rowOrder.length > 550 || input.rowOrder.some(id => typeof id !== 'string' || !ID.test(id)) || new Set(input.rowOrder).size !== input.rowOrder.length)) throw fault(400, 'invalid_row_order');
    return { requestId: token, version: input.version, rows, ...(input.rowOrder === undefined ? {} : { rowOrder: [...input.rowOrder] }) };
}

function createRouter(getPool, auth) {
    if (!auth || !auth.authMiddleware || !auth.adminMiddleware) throw new Error('Progress requires existing auth middleware');
    const router = express.Router();
    let readyPool;
    let ready;
    const withError = fn => async (req, res) => {
        try { await fn(req, res); } catch (err) {
            // No SQL errors, input contents, cookies or identity values in output/logs.
            res.status(err.status || 503).json({ success: false, error: err.code || 'progress_unavailable' });
        }
    };
    async function transaction(pool, fn) {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const result = await fn(client);
            await client.query('COMMIT');
            return result;
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            throw err;
        } finally { client.release(); }
    }
    async function database() {
        const pool = getPool();
        if (!pool || typeof pool.connect !== 'function') throw fault(503, 'progress_unavailable');
        if (!ready || readyPool !== pool) {
            readyPool = pool;
            ready = transaction(pool, async client => {
                // Serializes first initialization across Railway workers/restarts.
                await client.query('SELECT pg_advisory_xact_lock(72140414)');
                await client.query(schema);
                for (const entry of seed) {
                    const data = normalize(entry);
                    const inserted = await client.query('INSERT INTO dot_progress_projects(id, data) VALUES ($1, $2::jsonb) ON CONFLICT (id) DO NOTHING RETURNING id', [entry.id, JSON.stringify(data)]);
                    if (inserted.rows.length) await appendHistory(client, entry.id, 1, 'seed', { before: null, after: data });
                }
            }).catch(err => { ready = null; throw err; });
        }
        await ready;
        return pool;
    }
    async function appendHistory(client, id, version, action, changes) {
        await client.query('INSERT INTO dot_progress_history(project_id, version, action, changes) VALUES ($1, $2, $3, $4::jsonb)', [id, version, action, JSON.stringify(changes)]);
    }
    async function findProject(client, id, lock = false) {
        if (!ID.test(id)) throw fault(400, 'invalid_id');
        const result = await client.query(`SELECT id, data, version FROM dot_progress_projects WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id]);
        return result.rows[0] || null;
    }
    async function updateProject(client, id, input, action) {
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw fault(400, 'invalid_project');
        const prior = await findProject(client, id, true);
        if (!prior) throw fault(404, 'project_not_found');
        if (!Number.isSafeInteger(input.version) || input.version !== prior.version) throw fault(409, 'version_conflict');
        const data = normalize(input, prior.data);
        const result = await client.query('UPDATE dot_progress_projects SET data = $2::jsonb, version = version + 1, updated_at = NOW() WHERE id = $1 AND version = $3 RETURNING id, data, version', [id, JSON.stringify(data), input.version]);
        if (!result.rows.length) throw fault(409, 'version_conflict');
        await appendHistory(client, id, result.rows[0].version, action, { before: prior.data, after: data });
        const stats = await pushStats(client, id);
        return rowProject({ ...result.rows[0], push_count: stats.pushCount, last_pushed_at: stats.lastPushedAt });
    }
    async function pushStats(client, projectId) {
        const result = await client.query('SELECT push_count, last_pushed_at FROM dot_progress_push_state WHERE project_id=$1', [projectId]);
        return { pushCount: result.rows[0]?.push_count ?? 0, lastPushedAt: result.rows[0]?.last_pushed_at ?? null };
    }
    async function addComment(client, projectId, authorId, input) {
        const { body, requestId } = commentInput(input);
        if (!await findProject(client, projectId)) throw fault(404, 'project_not_found');
        const result = await client.query('INSERT INTO dot_progress_comments(project_id, author_id, request_id, body) VALUES ($1,$2,$3,$4) ON CONFLICT (project_id, author_id, request_id) DO NOTHING RETURNING id, body, created_at AS "createdAt"', [projectId, String(authorId), requestId, body]);
        if (result.rows[0]) {
            if (result.rows[0].body !== body) throw fault(409, 'request_id_conflict');
            return result.rows[0];
        }
        const prior = await client.query('SELECT id, body, created_at AS "createdAt" FROM dot_progress_comments WHERE project_id=$1 AND author_id=$2 AND request_id=$3', [projectId, String(authorId), requestId]);
        if (!prior.rows[0] || prior.rows[0].body !== body) throw fault(409, 'request_id_conflict');
        return prior.rows[0];
    }

    // Decisions are isolated from generic project data/imports. Adoption identity,
    // timestamps and audit events are exclusively derived by the server.
    async function findDecision(client, projectId, decisionId, lock = false) {
        if (!ID.test(projectId) || !ID.test(decisionId)) throw fault(400, 'invalid_id');
        const result = await client.query(`SELECT * FROM dot_progress_decisions WHERE project_id=$1 AND id=$2${lock ? ' FOR UPDATE' : ''}`, [projectId, decisionId]);
        if (!result.rows[0]) throw fault(404, 'decision_not_found');
        return result.rows[0];
    }
    async function decisionProject(client, id) {
        const project = await findProject(client, id, true);
        if (!project) throw fault(404, 'project_not_found');
        return project;
    }
    function requireActiveProject(project) {
        if (['cancelled', 'archived'].includes(project.data.status)) throw fault(409, 'project_inactive');
    }
    function adoption(row) {
        return row.adopted ? { actorId: row.adoption_actor_id, at: row.adoption_at, recommendationVersion: row.adoption_recommendation_version } : null;
    }
    async function hasClarification(client, row) {
        const result = await client.query('SELECT COUNT(*) AS count FROM dot_progress_decision_comments WHERE decision_id=$1 AND recommendation_version=$2', [row.id, row.recommendation_version]);
        return Number(result.rows[0].count) > 0;
    }
    async function decisionView(client, row) {
        const [comments, events, clarification] = await Promise.all([
            client.query('SELECT id, body, actor_id AS "actorId", created_at AS "createdAt", recommendation_version AS "recommendationVersion" FROM dot_progress_decision_comments WHERE decision_id=$1 ORDER BY id DESC LIMIT 1000', [row.id]),
            client.query('SELECT id, actor_id AS "actorId", action, version, recommendation_version AS "recommendationVersion", data, created_at AS "createdAt" FROM dot_progress_decision_events WHERE decision_id=$1 ORDER BY id DESC LIMIT 100', [row.id]),
            hasClarification(client, row)
        ]);
        return {
            id: row.id, projectId: row.project_id, question: row.question, recommendation: row.recommendation,
            version: row.version, recommendationVersion: row.recommendation_version,
            state: clarification ? 'clarification' : row.adopted ? 'adopted' : 'pending',
            adopted: !clarification && row.adopted, adoption: clarification ? null : adoption(row),
            comments: comments.rows.slice().reverse(), events: events.rows.slice().reverse()
        };
    }
    async function decisionEvent(client, row, actorId, action, data) {
        await client.query('INSERT INTO dot_progress_decision_events(decision_id, actor_id, action, version, recommendation_version, data) VALUES ($1,$2,$3,$4,$5,$6::jsonb)', [row.id, String(actorId), action, row.version, row.recommendation_version, JSON.stringify(data)]);
    }
    function checkDecisionVersion(row, input, recommendation = false) {
        positiveVersion(input.version);
        if (recommendation) positiveVersion(input.recommendationVersion);
        if (input.version !== row.version || (recommendation && input.recommendationVersion !== row.recommendation_version)) throw fault(409, 'version_conflict');
    }
    function reviewRecord(row) {
        return { id: row.id, kind: row.kind, title: row.title, body: row.body, occurredAt: row.occurred_at, source: row.source, scope: row.scope, actorId: row.actor_id, createdAt: row.created_at };
    }
    async function reviewView(client, row) {
        const comments = await client.query('SELECT id, body, actor_id AS "actorId", created_at AS "createdAt" FROM dot_progress_review_comments WHERE review_id=$1 ORDER BY id DESC LIMIT 1000', [row.id]);
        return { ...reviewRecord(row), comments: comments.rows.slice().reverse() };
    }
    function timelineRecord(row) {
        return { id: row.id, ...row.data, version: row.version, actorId: row.actor_id,
            createdAt: new Date(row.created_at).toISOString(), updatedAt: safeUpdatedAtToISO(row) };
    }
    async function timelineProject(client, data) {
        if (data.projectId !== null && !await findProject(client, data.projectId)) throw fault(404, 'project_not_found');
    }
    async function timelineReceipt(client, actorId, token, payload) {
        // Small administrator journal: this feature lock serializes receipt
        // checks and mutations, including concurrent creation with one click ID.
        await client.query('SELECT pg_advisory_xact_lock(72140417)');
        const result = await client.query('SELECT request_payload, response_entry FROM dot_progress_timeline_requests WHERE actor_id=$1 AND request_id=$2', [String(actorId), token]);
        if (!result.rows[0]) return null;
        if (canonical(result.rows[0].request_payload) !== canonical(payload)) throw fault(409, 'request_id_conflict');
        return result.rows[0].response_entry;
    }
    async function saveTimelineRevision(client, actorId, token, payload, before, after) {
        await client.query('INSERT INTO dot_progress_timeline_revisions(timeline_id, version, actor_id, changes) VALUES ($1,$2,$3,$4::jsonb)', [after.id, after.version, String(actorId), JSON.stringify({ before, after })]);
        await client.query('INSERT INTO dot_progress_timeline_requests(actor_id, request_id, request_payload, response_entry) VALUES ($1,$2,$3::jsonb,$4::jsonb)', [String(actorId), token, JSON.stringify(payload), JSON.stringify(after)]);
    }
    function scheduleRecord(date, row) {
        return row ? { date, version: row.version, rows: row.rows, rowOrder: row.row_order || [], updatedAt: safeUpdatedAtToISO(row) } : { date, version: 0, rows: [], rowOrder: [], updatedAt: null };
    }
    async function scheduleReferences(client, rows, rowOrder = []) {
        const rowIds = new Set(rows.map(row => row.id));
        for (const [table, ids, code] of [
            ['dot_progress_projects', [...new Set(rows.map(row => row.projectId).filter(Boolean))], 'project_not_found'],
            ['dot_progress_timeline', [...new Set([...rows.flatMap(row => row.actualIds), ...rowOrder.filter(id => !rowIds.has(id))])], 'timeline_not_found']
        ]) {
            if (!ids.length) continue;
            const found = await client.query(`SELECT id FROM ${table} WHERE id IN (${ids.map((_, i) => `$${i + 1}`).join(',')})`, ids);
            if (found.rows.length !== ids.length) throw fault(404, code);
        }
    }

    router.use((_req, res, next) => {
        // Prevent authenticated data from being retained by browser/CDN caches.
        res.set('Cache-Control', 'no-store');
        res.set('Vary', 'Cookie, Authorization');
        next();
    });
    router.use(express.json({ limit: '256kb' }));
    router.get('/public', withError(async (_req, res) => {
        const pool = await database();
        const result = await pool.query("SELECT data FROM dot_progress_projects WHERE data->>'status' = 'completed' ORDER BY data->>'completedAt' DESC, id");
        res.json({ success: true, projects: result.rows.map(publicProject).filter(Boolean) });
    }));
    router.get('/session', auth.authMiddleware, withError(async (req, res) => {
        const pool = getPool();
        if (!pool) throw fault(503, 'progress_unavailable');
        const result = req.user.userId ? await pool.query('SELECT is_admin FROM user_accounts WHERE id = $1', [req.user.userId]) : { rows: [] };
        res.json({ success: true, authenticated: true, isAdmin: result.rows[0]?.is_admin === true });
    }));
    // Every route below, including imports and reads, requires the existing role check.
    router.use(auth.authMiddleware, auth.adminMiddleware);
    router.use((req, res, next) => {
        if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.get('origin')) {
            try {
                if (new URL(req.get('origin')).host !== req.get('host')) return res.status(403).json({ success: false, error: 'cross_origin_write' });
            } catch (_err) { return res.status(403).json({ success: false, error: 'cross_origin_write' }); }
        }
        next();
    });
    router.get('/projects', withError(async (_req, res) => {
        const pool = await database();
        const result = await pool.query('SELECT p.id, p.data, p.version, COALESCE(s.push_count,0) AS push_count, s.last_pushed_at FROM dot_progress_projects p LEFT JOIN dot_progress_push_state s ON s.project_id=p.id ORDER BY p.updated_at DESC, p.id');
        res.json({ success: true, projects: result.rows.map(rowProject) });
    }));
    // A push is an admin signal only. It never edits status/version, adopts a
    // decision, publishes text, executes work or contacts an entity/service.
    router.post('/projects/:id/push', withError(async (req, res) => {
        const input = strictBody(req.body, ['requestId']);
        const token = requestId(input.requestId);
        const pool = await database();
        const stats = await transaction(pool, async client => {
            if (!await findProject(client, req.params.id, true)) throw fault(404, 'project_not_found');
            // Shared project lock serializes signals, edits and cancellation.
            // Ledger + counter update commit together, so retries cannot count
            // twice and a failed receipt write cannot leave an extra increment.
            const prior = await client.query('SELECT id FROM dot_progress_push_requests WHERE project_id=$1 AND actor_id=$2 AND request_id=$3', [req.params.id, String(req.user.userId), token]);
            if (prior.rows[0]) return pushStats(client, req.params.id);
            await client.query('INSERT INTO dot_progress_push_state(project_id) VALUES ($1) ON CONFLICT (project_id) DO NOTHING', [req.params.id]);
            const result = await client.query('UPDATE dot_progress_push_state SET push_count=push_count+1, last_pushed_at=clock_timestamp() WHERE project_id=$1 RETURNING push_count, last_pushed_at', [req.params.id]);
            const row = result.rows[0];
            if (!row) throw fault(503, 'progress_unavailable');
            await client.query('INSERT INTO dot_progress_push_requests(project_id, actor_id, request_id, push_count, pushed_at) VALUES ($1,$2,$3,$4,$5)', [req.params.id, String(req.user.userId), token, row.push_count, row.last_pushed_at]);
            return { pushCount: row.push_count, lastPushedAt: row.last_pushed_at };
        });
        res.json({ success: true, ...stats });
    }));
    router.patch('/projects/:id', withError(async (req, res) => {
        const pool = await database();
        const project = await transaction(pool, client => updateProject(client, req.params.id, req.body, 'update'));
        res.json({ success: true, project });
    }));
    router.get('/projects/:id/comments', withError(async (req, res) => {
        const pool = await database();
        if (!await findProject(pool, req.params.id)) throw fault(404, 'project_not_found');
        const result = await pool.query('SELECT id, body, created_at AS "createdAt" FROM dot_progress_comments WHERE project_id=$1 ORDER BY id LIMIT 1000', [req.params.id]);
        res.json({ success: true, comments: result.rows });
    }));
    router.post('/projects/:id/comments', withError(async (req, res) => {
        const pool = await database();
        const comment = await transaction(pool, client => addComment(client, req.params.id, req.user.userId, req.body));
        res.json({ success: true, comment });
    }));
    router.get('/projects/:id/history', withError(async (req, res) => {
        const pool = await database();
        if (!await findProject(pool, req.params.id)) throw fault(404, 'project_not_found');
        const result = await pool.query('SELECT version, action, changes, created_at AS "createdAt" FROM dot_progress_history WHERE project_id=$1 ORDER BY id DESC LIMIT 1000', [req.params.id]);
        res.json({ success: true, history: result.rows });
    }));
    router.get('/projects/:id/decisions', withError(async (req, res) => {
        const pool = await database();
        const decisions = await transaction(pool, async client => {
            await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
            if (!await findProject(client, req.params.id)) throw fault(404, 'project_not_found');
            const result = await client.query('SELECT * FROM dot_progress_decisions WHERE project_id=$1 ORDER BY created_at DESC, id LIMIT 100', [req.params.id]);
            return Promise.all(result.rows.map(row => decisionView(client, row)));
        });
        res.set('Cache-Control', 'no-store');
        res.json({ success: true, decisions });
    }));

    router.post('/projects/:id/decisions', withError(async (req, res) => {
        const input = strictBody(req.body, ['question', 'recommendation', 'requestId']);
        const payload = { question: text(input.question, 1000, true), recommendation: text(input.recommendation, 4000, true) };
        const token = requestId(input.requestId);
        const pool = await database();
        const decision = await transaction(pool, async client => {
            const project = await decisionProject(client, req.params.id);
            const existing = await client.query('SELECT * FROM dot_progress_decisions WHERE project_id=$1 AND creator_id=$2 AND request_id=$3 FOR UPDATE', [req.params.id, String(req.user.userId), token]);
            if (existing.rows[0]) {
                const prior = existing.rows[0];
                if (prior.creation_payload.question !== payload.question || prior.creation_payload.recommendation !== payload.recommendation) throw fault(409, 'request_id_conflict');
                return decisionView(client, prior);
            }
            requireActiveProject(project);
            const result = await client.query('INSERT INTO dot_progress_decisions(id, project_id, question, recommendation, creator_id, request_id, creation_payload) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) RETURNING *', [randomUUID(), req.params.id, payload.question, payload.recommendation, String(req.user.userId), token, JSON.stringify(payload)]);
            await decisionEvent(client, result.rows[0], req.user.userId, 'created', payload);
            return decisionView(client, result.rows[0]);
        });
        res.json({ success: true, decision });
    }));
    router.patch('/projects/:id/decisions/:decisionId', withError(async (req, res) => {
        const input = strictBody(req.body, ['version', 'question', 'recommendation']);
        positiveVersion(input.version);
        if (input.question === undefined && input.recommendation === undefined) throw fault(400, 'content_required');
        const pool = await database();
        const decision = await transaction(pool, async client => {
            requireActiveProject(await decisionProject(client, req.params.id));
            const prior = await findDecision(client, req.params.id, req.params.decisionId, true);
            checkDecisionVersion(prior, input);
            const question = input.question === undefined ? prior.question : text(input.question, 1000, true);
            const recommendation = input.recommendation === undefined ? prior.recommendation : text(input.recommendation, 4000, true);
            if (question === prior.question && recommendation === prior.recommendation) return decisionView(client, prior);
            const result = await client.query('UPDATE dot_progress_decisions SET question=$2, recommendation=$3, version=version+1, recommendation_version=recommendation_version+1, adopted=FALSE, adoption_actor_id=NULL, adoption_at=NULL, adoption_recommendation_version=NULL, updated_at=NOW() WHERE id=$1 RETURNING *', [prior.id, question, recommendation]);
            await decisionEvent(client, result.rows[0], req.user.userId, 'revised', { before: { question: prior.question, recommendation: prior.recommendation, adoption: adoption(prior) }, after: { question, recommendation } });
            return decisionView(client, result.rows[0]);
        });
        res.json({ success: true, decision });
    }));
    router.post('/projects/:id/decisions/:decisionId/adoption', withError(async (req, res) => {
        const input = strictBody(req.body, ['version', 'recommendationVersion', 'adopted']);
        positiveVersion(input.version); positiveVersion(input.recommendationVersion);
        if (typeof input.adopted !== 'boolean') throw fault(400, 'invalid_adopted');
        const pool = await database();
        const decision = await transaction(pool, async client => {
            const project = await decisionProject(client, req.params.id);
            if (input.adopted) requireActiveProject(project);
            const prior = await findDecision(client, req.params.id, req.params.decisionId, true);
            checkDecisionVersion(prior, input, true);
            if (input.adopted && await hasClarification(client, prior)) throw fault(409, 'clarification_required');
            const result = await client.query('UPDATE dot_progress_decisions SET version=version+1, adopted=$2, adoption_actor_id=$3, adoption_at=CASE WHEN $2 THEN NOW() ELSE NULL END, adoption_recommendation_version=$4, updated_at=NOW() WHERE id=$1 RETURNING *', [prior.id, input.adopted, input.adopted ? String(req.user.userId) : null, input.adopted ? prior.recommendation_version : null]);
            await decisionEvent(client, result.rows[0], req.user.userId, input.adopted ? 'adopted' : 'withdrawn', { before: adoption(prior), after: adoption(result.rows[0]) });
            return decisionView(client, result.rows[0]);
        });
        res.json({ success: true, decision });
    }));
    router.post('/projects/:id/decisions/:decisionId/comments', withError(async (req, res) => {
        const input = strictBody(req.body, ['version', 'recommendationVersion', 'body', 'requestId']);
        const normalized = commentInput(input);
        positiveVersion(input.version); positiveVersion(input.recommendationVersion);
        const pool = await database();
        const result = await transaction(pool, async client => {
            await decisionProject(client, req.params.id);
            const prior = await findDecision(client, req.params.id, req.params.decisionId, true);
            // Retry detection precedes stale-version checks: a response lost after
            // commit may be retried safely even after later edits or adoption.
            const existing = await client.query('SELECT id, body, actor_id AS "actorId", created_at AS "createdAt", recommendation_version AS "recommendationVersion" FROM dot_progress_decision_comments WHERE decision_id=$1 AND actor_id=$2 AND request_id=$3', [prior.id, String(req.user.userId), normalized.requestId]);
            if (existing.rows[0]) {
                if (existing.rows[0].body !== normalized.body) throw fault(409, 'request_id_conflict');
                return { decision: await decisionView(client, prior), comment: existing.rows[0] };
            }
            checkDecisionVersion(prior, input, true);
            const comment = await client.query('INSERT INTO dot_progress_decision_comments(decision_id, actor_id, request_id, body, recommendation_version) VALUES ($1,$2,$3,$4,$5) RETURNING id, body, actor_id AS "actorId", created_at AS "createdAt", recommendation_version AS "recommendationVersion"', [prior.id, String(req.user.userId), normalized.requestId, normalized.body, prior.recommendation_version]);
            const changed = await client.query('UPDATE dot_progress_decisions SET version=version+1, adopted=FALSE, adoption_actor_id=NULL, adoption_at=NULL, adoption_recommendation_version=NULL, updated_at=NOW() WHERE id=$1 RETURNING *', [prior.id]);
            await decisionEvent(client, changed.rows[0], req.user.userId, 'clarification_comment', { commentId: comment.rows[0].id, previousAdoption: adoption(prior) });
            return { decision: await decisionView(client, changed.rows[0]), comment: comment.rows[0] };
        });
        res.json({ success: true, ...result });
    }));
    // Historical review is explicitly supplied by an administrator. No hidden
    // instructions/memory are inspected, no original record is ever overwritten.
    router.get('/review', withError(async (_req, res) => {
        const pool = await database();
        const entries = await transaction(pool, async client => {
            await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
            const result = await client.query('SELECT * FROM dot_progress_review ORDER BY created_at DESC, id DESC LIMIT 250');
            return Promise.all(result.rows.map(row => reviewView(client, row)));
        });
        res.json({ success: true, entries });
    }));
    router.post('/review', withError(async (req, res) => {
        const payload = reviewInput(req.body);
        const token = requestId(req.body.requestId);
        const pool = await database();
        const entry = await transaction(pool, async client => {
            const result = await client.query('INSERT INTO dot_progress_review(id, kind, title, body, occurred_at, source, scope, actor_id, request_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (actor_id, request_id) DO NOTHING RETURNING *', [randomUUID(), payload.kind, payload.title, payload.body, payload.occurredAt, payload.source, payload.scope, String(req.user.userId), token]);
            const existing = result.rows[0] || (await client.query('SELECT * FROM dot_progress_review WHERE actor_id=$1 AND request_id=$2', [String(req.user.userId), token])).rows[0];
            if (!existing || REVIEW_FIELDS.some(field => reviewRecord(existing)[field] !== payload[field])) throw fault(409, 'request_id_conflict');
            return reviewView(client, existing);
        });
        res.json({ success: true, entry });
    }));
    router.post('/review/:reviewId/comments', withError(async (req, res) => {
        strictBody(req.body, ['body', 'requestId']);
        const payload = commentInput(req.body);
        if (!ID.test(req.params.reviewId)) throw fault(400, 'invalid_id');
        const pool = await database();
        const result = await transaction(pool, async client => {
            const review = await client.query('SELECT * FROM dot_progress_review WHERE id=$1 FOR UPDATE', [req.params.reviewId]);
            if (!review.rows[0]) throw fault(404, 'review_not_found');
            const inserted = await client.query('INSERT INTO dot_progress_review_comments(review_id, body, actor_id, request_id) VALUES ($1,$2,$3,$4) ON CONFLICT (review_id, actor_id, request_id) DO NOTHING RETURNING id, body, actor_id AS "actorId", created_at AS "createdAt"', [req.params.reviewId, payload.body, String(req.user.userId), payload.requestId]);
            const comment = inserted.rows[0] || (await client.query('SELECT id, body, actor_id AS "actorId", created_at AS "createdAt" FROM dot_progress_review_comments WHERE review_id=$1 AND actor_id=$2 AND request_id=$3', [req.params.reviewId, String(req.user.userId), payload.requestId])).rows[0];
            if (!comment || comment.body !== payload.body) throw fault(409, 'request_id_conflict');
            return { entry: await reviewView(client, review.rows[0]), comment };
        });
        res.json({ success: true, ...result });
    }));
    router.get('/schedule', withError(async (req, res) => {
        const query = strictBody(req.query, ['date']); const date = timelineDate(query.date);
        const pool = await database();
        const result = await pool.query('SELECT * FROM dot_progress_schedule WHERE date=$1', [date]);
        res.json({ success: true, schedule: scheduleRecord(date, result.rows[0]) });
    }));
    router.put('/schedule/:date', withError(async (req, res) => {
        const date = timelineDate(req.params.date); const input = scheduleInput(req.body, date);
        const payload = { date, version: input.version, rows: input.rows, ...(input.rowOrder === undefined ? {} : { rowOrder: input.rowOrder }) };
        const pool = await database(); const actor = String(req.user.userId);
        const schedule = await transaction(pool, async client => {
            // Also serializes the absent version-zero row and request-ID races.
            await client.query('SELECT pg_advisory_xact_lock(72140418)');
            const receipt = (await client.query('SELECT request_payload,response_schedule FROM dot_progress_schedule_requests WHERE actor_id=$1 AND request_id=$2', [actor, input.requestId])).rows[0];
            if (receipt) {
                if (canonical(receipt.request_payload) !== canonical(payload)) throw fault(409, 'request_id_conflict');
                return receipt.response_schedule;
            }
            const prior = (await client.query('SELECT * FROM dot_progress_schedule WHERE date=$1 FOR UPDATE', [date])).rows[0];
            const before = scheduleRecord(date, prior);
            if (input.version !== before.version) throw fault(409, 'version_conflict');
            const priorRows = new Map(before.rows.map(row => [row.id, row]));
            for (const row of input.rows) {
                const old = priorRows.get(row.id);
                if (!old && row.archived === true) throw fault(400, 'invalid_archive_transition');
                if (old && (old.archived === true) !== (row.archived === true)) {
                    const { archived: _oldFlag, ...oldData } = old;
                    const { archived: _newFlag, ...newData } = row;
                    if (canonical(oldData) !== canonical(newData)) throw fault(400, 'invalid_archive_transition');
                }
            }
            await scheduleReferences(client, input.rows, input.rowOrder);
            const rowOrder = input.rowOrder ?? before.rowOrder;
            const result = prior
                ? await client.query('UPDATE dot_progress_schedule SET rows=$2::jsonb,row_order=$3::jsonb,version=version+1,updated_at=clock_timestamp() WHERE date=$1 RETURNING *', [date, JSON.stringify(input.rows), JSON.stringify(rowOrder)])
                : await client.query('INSERT INTO dot_progress_schedule(date,rows,row_order) VALUES ($1,$2::jsonb,$3::jsonb) RETURNING *', [date, JSON.stringify(input.rows), JSON.stringify(rowOrder)]);
            const after = scheduleRecord(date, result.rows[0]);
            await client.query('INSERT INTO dot_progress_schedule_revisions(date,version,actor_id,changes) VALUES ($1,$2,$3,$4::jsonb)', [date, after.version, actor, JSON.stringify({ before, after })]);
            await client.query('INSERT INTO dot_progress_schedule_requests(actor_id,request_id,request_payload,response_schedule) VALUES ($1,$2,$3::jsonb,$4::jsonb)', [actor, input.requestId, JSON.stringify(payload), JSON.stringify(after)]);
            return after;
        });
        res.json({ success: true, schedule });
    }));
    router.get('/schedule/:date/history', withError(async (req, res) => {
        const date = timelineDate(req.params.date); const query = strictBody(req.query, ['offset']); const offset = timelineOffset(query.offset);
        const pool = await database();
        const page = await transaction(pool, async client => {
            await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
            const total = Number((await client.query('SELECT COUNT(*) AS total FROM dot_progress_schedule_revisions WHERE date=$1', [date])).rows[0].total);
            const history = (await client.query('SELECT version,actor_id AS "actorId",created_at AS "createdAt",changes FROM dot_progress_schedule_revisions WHERE date=$1 ORDER BY version DESC LIMIT 100 OFFSET $2', [date, offset])).rows;
            return { history, total, limit: 100, offset, nextOffset: offset + history.length < total ? offset + history.length : null };
        });
        res.json({ success: true, ...page });
    }));
    router.get('/timeline', withError(async (req, res) => {
        const query = strictBody(req.query, ['date', 'project', 'offset']);
        const offset = timelineOffset(query.offset);
        const terms = [];
        const params = [];
        if (query.date !== undefined) {
            const date = timelineDate(query.date);
            const start = new Date(`${date}T00:00:00+08:00`).toISOString();
            const end = new Date(Date.parse(start) + 86400000).toISOString();
            params.push(start, end);
            terms.push('((started_at IS NULL AND ended_at >= $1 AND ended_at < $2) OR (started_at < $2 AND (ended_at > $1 OR (started_at=ended_at AND started_at >= $1))))');
        }
        if (query.project !== undefined) {
            params.push(timelineText(query.project, 160, true));
            terms.push(`project_label=$${params.length}`);
        }
        const where = terms.length ? ` WHERE ${terms.join(' AND ')}` : '';
        const pool = await database();
        const page = await transaction(pool, async client => {
            await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
            const count = await client.query(`SELECT COUNT(*) AS total FROM dot_progress_timeline${where}`, params);
            const rows = await client.query(`SELECT * FROM dot_progress_timeline${where} ORDER BY COALESCE(started_at, ended_at), id LIMIT 500 OFFSET $${params.length + 1}`, [...params, offset]);
            const total = Number(count.rows[0].total);
            return { entries: rows.rows.map(timelineRecord), total, limit: 500, offset, nextOffset: offset + rows.rows.length < total ? offset + rows.rows.length : null };
        });
        res.json({ success: true, ...page });
    }));
    router.post('/timeline', withError(async (req, res) => {
        const { requestId: token, ...data } = normalizeTimelineInput(req.body);
        const payload = { operation: 'create', data };
        const pool = await database();
        const entry = await transaction(pool, async client => {
            const prior = await timelineReceipt(client, req.user.userId, token, payload);
            if (prior) return prior;
            await timelineProject(client, data);
            const result = await client.query('INSERT INTO dot_progress_timeline(id,project_id,project_label,started_at,ended_at,data,actor_id) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7) RETURNING *', [randomUUID(), data.projectId, data.projectLabel, data.startedAt, data.endedAt, JSON.stringify(data), String(req.user.userId)]);
            const created = timelineRecord(result.rows[0]);
            await saveTimelineRevision(client, req.user.userId, token, payload, null, created);
            return created;
        });
        res.json({ success: true, entry });
    }));
    router.patch('/timeline/:id', withError(async (req, res) => {
        if (!ID.test(req.params.id)) throw fault(400, 'invalid_id');
        const patch = timelineInput(req.body, true);
        const version = positiveVersion(req.body.version);
        const token = requestId(req.body.requestId);
        const payload = { operation: 'update', id: req.params.id, version, data: patch };
        const pool = await database();
        const entry = await transaction(pool, async client => {
            const receipt = await timelineReceipt(client, req.user.userId, token, payload);
            if (receipt) return receipt;
            const result = await client.query('SELECT * FROM dot_progress_timeline WHERE id=$1 FOR UPDATE', [req.params.id]);
            if (!result.rows[0]) throw fault(404, 'timeline_not_found');
            const prior = result.rows[0];
            if (prior.version !== version) throw fault(409, 'version_conflict');
            const data = { ...prior.data, ...patch };
            timelineSpan(data);
            await timelineProject(client, data);
            const updated = await client.query('UPDATE dot_progress_timeline SET project_id=$2,project_label=$3,started_at=$4,ended_at=$5,data=$6::jsonb,version=version+1,actor_id=$7,updated_at=clock_timestamp() WHERE id=$1 RETURNING *', [prior.id, data.projectId, data.projectLabel, data.startedAt, data.endedAt, JSON.stringify(data), String(req.user.userId)]);
            const after = timelineRecord(updated.rows[0]);
            await saveTimelineRevision(client, req.user.userId, token, payload, timelineRecord(prior), after);
            return after;
        });
        res.json({ success: true, entry });
    }));
    router.get('/timeline/:id/history', withError(async (req, res) => {
        if (!ID.test(req.params.id)) throw fault(400, 'invalid_id');
        const query = strictBody(req.query, ['offset']);
        const offset = timelineOffset(query.offset);
        const pool = await database();
        const page = await transaction(pool, async client => {
            await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
            if (!(await client.query('SELECT id FROM dot_progress_timeline WHERE id=$1', [req.params.id])).rows[0]) throw fault(404, 'timeline_not_found');
            const count = await client.query('SELECT COUNT(*) AS total FROM dot_progress_timeline_revisions WHERE timeline_id=$1', [req.params.id]);
            const rows = await client.query('SELECT version,actor_id AS "actorId",created_at AS "createdAt",changes FROM dot_progress_timeline_revisions WHERE timeline_id=$1 ORDER BY version DESC LIMIT 100 OFFSET $2', [req.params.id, offset]);
            const total = Number(count.rows[0].total);
            return { history: rows.rows, total, limit: 100, offset, nextOffset: offset + rows.rows.length < total ? offset + rows.rows.length : null };
        });
        res.json({ success: true, ...page });
    }));
    router.post('/import', withError(async (req, res) => {
        if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) throw fault(400, 'invalid_import');
        const { mode = 'preview', data } = req.body;
        if (!['preview', 'apply'].includes(mode) || !data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.projects) || data.projects.length < 1 || data.projects.length > 100) throw fault(400, 'invalid_import');
        const seen = new Set();
        const entries = data.projects.map(entry => {
            if (!entry || typeof entry.id !== 'string' || !ID.test(entry.id) || seen.has(entry.id)) throw fault(400, 'invalid_import_id');
            seen.add(entry.id);
            if (entry.version !== undefined && (!Number.isSafeInteger(entry.version) || entry.version < 0)) throw fault(400, 'invalid_version');
            if (entry.comments !== undefined && (!Array.isArray(entry.comments) || entry.comments.length > 100)) throw fault(400, 'invalid_import_comments');
            return { id: entry.id, ...normalize(entry), completedWork: entry.completedWork === undefined ? undefined : text(entry.completedWork, 4000), version: entry.version, comments: (entry.comments || []).map(commentInput) };
        });
        if (mode === 'preview') return res.json({ success: true, mode, count: entries.length, projects: entries });
        const pool = await database();
        await transaction(pool, async client => {
            // Serialize concurrent imports; each existing row still requires its version.
            await client.query('SELECT pg_advisory_xact_lock(72140415)');
            for (const entry of entries.sort((a, b) => a.id.localeCompare(b.id))) {
                const prior = await findProject(client, entry.id, true);
                if (prior) await updateProject(client, entry.id, entry, 'import');
                else {
                    if (entry.version !== undefined && entry.version !== 0) throw fault(409, 'version_conflict');
                    const normalized = normalize(entry);
                    await client.query('INSERT INTO dot_progress_projects(id, data) VALUES ($1, $2::jsonb)', [entry.id, JSON.stringify(normalized)]);
                    await appendHistory(client, entry.id, 1, 'import', { before: null, after: normalized });
                }
                for (const comment of entry.comments) await addComment(client, entry.id, req.user.userId, comment);
            }
        });
        res.json({ success: true, mode, count: entries.length });
    }));
    router.use((err, _req, res, next) => {
        if (err.type === 'entity.parse.failed') return res.status(400).json({ success: false, error: 'invalid_json' });
        if (err.type === 'entity.too.large') return res.status(413).json({ success: false, error: 'request_too_large' });
        next(err);
    });
    return router;
}

// Diagnostic metadata only. Existing /api/debug gate remains authoritative.
// Independent guard also prevents accidental reuse on a production mount.
function createDebugRouter(getPool, auth) {
    const router = express.Router();
    router.use((_req, res, next) => {
        res.set('Cache-Control', 'no-store');
        if (process.env.NODE_ENV === 'production' || process.env.RAILWAY_ENVIRONMENT) return res.status(404).json({ success: false, error: 'not_found' });
        next();
    });
    router.use(auth.authMiddleware, auth.adminMiddleware);
    router.get('/', async (_req, res) => {
        try {
            const pool = getPool();
            if (!pool) throw new Error('unavailable');
            const [projects, comments, history, recent, decisions, decisionComments, decisionEvents, recentDecisionEvents, reviews, reviewComments, pushRequests, recentPushes, timelineEntries, timelineRevisions, timelineRequests, scheduleBoards, scheduleRevisions, scheduleRequests, recentSchedules] = await Promise.all([
                pool.query('SELECT COUNT(*) AS count FROM dot_progress_projects'),
                pool.query('SELECT COUNT(*) AS count FROM dot_progress_comments'),
                pool.query('SELECT COUNT(*) AS count FROM dot_progress_history'),
                pool.query('SELECT version, action, created_at AS "createdAt" FROM dot_progress_history ORDER BY id DESC LIMIT 20'),
                pool.query('SELECT COUNT(*) AS count FROM dot_progress_decisions'),
                pool.query('SELECT COUNT(*) AS count FROM dot_progress_decision_comments'),
                pool.query('SELECT COUNT(*) AS count FROM dot_progress_decision_events'),
                pool.query('SELECT version, recommendation_version AS "recommendationVersion", action, created_at AS "createdAt" FROM dot_progress_decision_events ORDER BY id DESC LIMIT 20'),
                pool.query('SELECT COUNT(*) AS count FROM dot_progress_review'),
                pool.query('SELECT COUNT(*) AS count FROM dot_progress_review_comments'),
                pool.query('SELECT COUNT(*) AS count FROM dot_progress_push_requests'),
                pool.query('SELECT push_count AS "pushCount", pushed_at AS "pushedAt" FROM dot_progress_push_requests ORDER BY id DESC LIMIT 20'),
                pool.query('SELECT COUNT(*) AS count FROM dot_progress_timeline'),
                pool.query('SELECT COUNT(*) AS count FROM dot_progress_timeline_revisions'),
                pool.query('SELECT COUNT(*) AS count FROM dot_progress_timeline_requests'),
                pool.query('SELECT COUNT(*) AS count FROM dot_progress_schedule'),
                pool.query('SELECT COUNT(*) AS count FROM dot_progress_schedule_revisions'),
                pool.query('SELECT COUNT(*) AS count FROM dot_progress_schedule_requests'),
                pool.query('SELECT version,updated_at AS "updatedAt" FROM dot_progress_schedule ORDER BY updated_at DESC LIMIT 20')
            ]);
            res.json({ success: true, counts: { projects: Number(projects.rows[0].count), comments: Number(comments.rows[0].count), history: Number(history.rows[0].count) }, recentHistory: recent.rows,
                decisionCounts: { decisions: Number(decisions.rows[0].count), comments: Number(decisionComments.rows[0].count), events: Number(decisionEvents.rows[0].count) }, recentDecisionEvents: recentDecisionEvents.rows.slice().reverse(), reviewCounts: { entries: Number(reviews.rows[0].count), comments: Number(reviewComments.rows[0].count) }, pushCounts: { requests: Number(pushRequests.rows[0].count) }, recentPushes: recentPushes.rows.slice().reverse(), timelineCounts: { entries: Number(timelineEntries.rows[0].count), revisions: Number(timelineRevisions.rows[0].count), requests: Number(timelineRequests.rows[0].count) },
                scheduleCounts: { boards: Number(scheduleBoards.rows[0].count), revisions: Number(scheduleRevisions.rows[0].count), requests: Number(scheduleRequests.rows[0].count) }, recentSchedules: recentSchedules.rows });
        } catch (_err) { res.status(503).json({ success: false, error: 'progress_unavailable' }); }
    });
    return router;
}

module.exports = { createRouter, createDebugRouter, normalize, publicProject, commentInput, normalizeTimelineInput };
