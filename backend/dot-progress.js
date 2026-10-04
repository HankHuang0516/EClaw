/** Portfolio progress. Only the explicit completed projection is public.
 * Private rows never live under public/; all admin operations use existing auth.
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const seed = require('./dot-progress-seed.json');
const schema = fs.readFileSync(path.join(__dirname, 'dot_progress_schema.sql'), 'utf8');
const FIELDS = ['title', 'status', 'summary', 'blockers', 'nextStep', 'publicTitle', 'publicSummary', 'completedAt'];
const STATUSES = ['active', 'blocked', 'paused', 'completed'];
const ID = /^[a-z0-9][a-z0-9-]{0,79}$/;
const REQUEST_ID = /^[a-zA-Z0-9_-]{8,100}$/;

function fault(status, error) { return Object.assign(new Error(error), { status, code: error }); }
function text(value, max, required = false) {
    if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw fault(400, 'invalid_text');
    return value.trim();
}
function normalize(input, prior = null) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw fault(400, 'invalid_project');
    if (Object.keys(input).some(k => ![...FIELDS, 'id', 'version', 'comments'].includes(k))) throw fault(400, 'unknown_field');
    const data = {};
    for (const key of FIELDS) {
        const value = input[key] === undefined ? (prior ? prior[key] : '') : input[key];
        data[key] = text(value, ['summary', 'blockers', 'nextStep'].includes(key) ? 4000 : key === 'publicSummary' ? 400 : 160, key === 'title');
    }
    if (!STATUSES.includes(data.status)) throw fault(400, 'invalid_status');
    if (prior?.status === 'completed' && data.status !== 'completed' && input.publicSummary === undefined) data.publicSummary = '';
    if (data.completedAt && (!/^\d{4}-\d{2}-\d{2}$/.test(data.completedAt) || Number.isNaN(Date.parse(data.completedAt)) || new Date(data.completedAt).toISOString().slice(0, 10) !== data.completedAt)) throw fault(400, 'invalid_date');
    if (data.publicSummary && (!data.publicTitle || !data.completedAt || data.status !== 'completed')) throw fault(400, 'publication_requires_completion');
    return data;
}
function rowProject(row) { return { id: row.id, ...row.data, version: row.version }; }
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
        return rowProject(result.rows[0]);
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
        const result = await pool.query('SELECT id, data, version FROM dot_progress_projects ORDER BY updated_at DESC, id');
        res.json({ success: true, projects: result.rows.map(rowProject) });
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
            return { id: entry.id, ...normalize(entry), version: entry.version, comments: (entry.comments || []).map(commentInput) };
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
            const [projects, comments, history, recent] = await Promise.all([
                pool.query('SELECT COUNT(*) AS count FROM dot_progress_projects'),
                pool.query('SELECT COUNT(*) AS count FROM dot_progress_comments'),
                pool.query('SELECT COUNT(*) AS count FROM dot_progress_history'),
                pool.query('SELECT version, action, created_at AS "createdAt" FROM dot_progress_history ORDER BY id DESC LIMIT 20')
            ]);
            res.json({ success: true, counts: { projects: Number(projects.rows[0].count), comments: Number(comments.rows[0].count), history: Number(history.rows[0].count) }, recentHistory: recent.rows });
        } catch (_err) { res.status(503).json({ success: false, error: 'progress_unavailable' }); }
    });
    return router;
}

module.exports = { createRouter, createDebugRouter, normalize, publicProject, commentInput };
