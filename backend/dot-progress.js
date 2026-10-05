/** Portfolio progress. Only the explicit completed projection is public.
 * Private rows never live under public/; all admin operations use existing auth.
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
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
            const [projects, comments, history, recent, decisions, decisionComments, decisionEvents, recentDecisionEvents, reviews, reviewComments, pushRequests, recentPushes] = await Promise.all([
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
                pool.query('SELECT push_count AS "pushCount", pushed_at AS "pushedAt" FROM dot_progress_push_requests ORDER BY id DESC LIMIT 20')
            ]);
            res.json({ success: true, counts: { projects: Number(projects.rows[0].count), comments: Number(comments.rows[0].count), history: Number(history.rows[0].count) }, recentHistory: recent.rows,
                decisionCounts: { decisions: Number(decisions.rows[0].count), comments: Number(decisionComments.rows[0].count), events: Number(decisionEvents.rows[0].count) }, recentDecisionEvents: recentDecisionEvents.rows.slice().reverse(), reviewCounts: { entries: Number(reviews.rows[0].count), comments: Number(reviewComments.rows[0].count) }, pushCounts: { requests: Number(pushRequests.rows[0].count) }, recentPushes: recentPushes.rows.slice().reverse() });
        } catch (_err) { res.status(503).json({ success: false, error: 'progress_unavailable' }); }
    });
    return router;
}

module.exports = { createRouter, createDebugRouter, normalize, publicProject, commentInput };
