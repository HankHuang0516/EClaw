'use strict';
const crypto = require('crypto');
const express = require('express');
const { rateLimit } = require('express-rate-limit');
const MAX_BYTES = 12 * 1024;
const CATEGORIES = Object.freeze(['operation', 'rules', 'dialogue', 'art', 'balance', 'other']);
const FIELDS = ['schemaVersion', 'id', 'category', 'description', 'version', 'screen'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const SCHEMA = [
    'CREATE TABLE IF NOT EXISTS fraud_app_feedback_reports (',
    'id UUID PRIMARY KEY, schema_version SMALLINT NOT NULL CHECK (schema_version = 1),',
    'payload_hash CHAR(64) NOT NULL,',
    "category VARCHAR(16) NOT NULL CHECK (category IN ('operation','rules','dialogue','art','balance','other')),",
    'description TEXT NOT NULL, app_version VARCHAR(128) NOT NULL, screen VARCHAR(128) NOT NULL,',
    'created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());',
    'CREATE INDEX IF NOT EXISTS idx_fraud_app_feedback_created ON fraud_app_feedback_reports (created_at DESC, id DESC);',
].join('\n');
function failure(status, code) { return Object.assign(new Error(code), { status, code }); }
function validate(body) {
    if (!body || Object.getPrototypeOf(body) !== Object.prototype || Object.keys(body).length !== FIELDS.length
        || Object.keys(body).some(key => !FIELDS.includes(key)) || body.schemaVersion !== 1
        || typeof body.id !== 'string' || !UUID.test(body.id) || !CATEGORIES.includes(body.category)) return false;
    if (typeof body.description !== 'string' || !body.description.trim() || [...body.description].length > 2000
        || Buffer.byteLength(body.description, 'utf8') > 8000 || Buffer.from(body.description, 'utf8').toString('utf8') !== body.description || CONTROL.test(body.description)) return false;
    for (const key of ['version', 'screen']) {
        const value = body[key];
        if (typeof value !== 'string' || !value.trim() || [...value].length > 128
            || Buffer.byteLength(value, 'utf8') > 512 || Buffer.from(value, 'utf8').toString('utf8') !== value || /[\u0000-\u001f\u007f]/.test(value)) return false;
    }
    return Buffer.byteLength(JSON.stringify(body), 'utf8') <= MAX_BYTES;
}
function payloadHash(body) {
    // Fixed field order: JSON key order in a retry is not a content change.
    const value = { schemaVersion: 1, category: body.category, description: body.description,
        version: body.version, screen: body.screen };
    return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
async function migrateSchema(pool) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query(SCHEMA);
        await client.query('COMMIT');
        return { schemaVersion: 1, table: 'fraud_app_feedback_reports' };
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
    } finally { client.release(); }
}
function receipt(body, row, duplicate) {
    if (!row || !row.created_at) throw failure(503, 'storage_unconfirmed');
    const time = new Date(row.created_at);
    if (!Number.isFinite(time.getTime())) throw failure(503, 'storage_unconfirmed');
    return { success: true, saved: true, id: body.id, createdAt: time.toISOString(), duplicate };
}
async function saveReport(pool, body) {
    if (!validate(body)) throw failure(400, 'invalid_report');
    if (!pool || typeof pool.query !== 'function') throw failure(503, 'storage_unavailable');
    const hash = payloadHash(body);
    const inserted = await pool.query(
        'INSERT INTO fraud_app_feedback_reports (id, schema_version, payload_hash, category, description, app_version, screen) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (id) DO NOTHING RETURNING id, created_at',
        [body.id, 1, hash, body.category, body.description, body.version, body.screen]);
    if (inserted.rows.length === 1) return receipt(body, inserted.rows[0], false);
    const prior = await pool.query('SELECT id, payload_hash, created_at FROM fraud_app_feedback_reports WHERE id = $1', [body.id]);
    if (prior.rows.length !== 1) throw failure(503, 'storage_unconfirmed');
    if (prior.rows[0].payload_hash !== hash) throw failure(409, 'report_id_conflict');
    return receipt(body, prior.rows[0], true);
}
function noStore(_req, res, next) {
    res.set({ 'Cache-Control': 'private, no-store, max-age=0', 'CDN-Cache-Control': 'no-store',
        'Cloudflare-CDN-Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    next();
}
function createRouters({ getPool, authMiddleware, adminMiddleware, isReady }) {
    if ([getPool, authMiddleware, adminMiddleware, isReady].some(fn => typeof fn !== 'function')) {
        throw new TypeError('Existing storage, readiness and admin middleware required');
    }
    const intake = express.Router();
    const admin = express.Router();
    const ready = (_req, res, next) => isReady() ? next()
        : res.status(503).json({ success: false, saved: false, error: 'storage_unavailable' });
    intake.use(noStore);
    // Ordinary submissions need no account/JWT/embedded key. Fixed-app writes only.
    intake.use((req, res, next) => {
        if (req.method !== 'POST' || req.path !== '/') return res.status(404).json({ success: false, saved: false, error: 'not_found' });
        const origin = req.get('origin');
        if (origin && !['https://eclawbot.com', 'https://www.eclawbot.com'].includes(origin)) {
            return res.status(403).json({ success: false, saved: false, error: 'origin_not_allowed' });
        }
        next();
    });
    intake.use(rateLimit({ windowMs: 10 * 60 * 1000, max: 8, standardHeaders: true, legacyHeaders: false,
        message: { success: false, saved: false, error: 'rate_limited' } }));
    intake.use(ready, express.json({ limit: MAX_BYTES, strict: true }));
    intake.post('/', async (req, res) => {
        try {
            const result = await saveReport(getPool(), req.body);
            res.status(result.duplicate ? 200 : 201).json(result);
        } catch (error) {
            const status = [400, 409].includes(error.status) ? error.status : 503;
            res.status(status).json({ success: false, saved: false,
                error: status === 400 ? 'invalid_report' : status === 409 ? 'report_id_conflict' : 'storage_unavailable' });
        }
    });
    intake.use((error, _req, res, _next) => {
        if (res.headersSent) return;
        const invalid = error.type === 'entity.too.large' || error.type === 'entity.parse.failed' || error.status === 400 || error.status === 415;
        res.status(invalid ? 400 : 503).json({ success: false, saved: false, error: invalid ? 'invalid_report' : 'storage_unavailable' });
    });
    admin.use(noStore);
    admin.use((_req, res, next) => { res.vary('Cookie'); res.vary('Authorization'); next(); });
    admin.use(authMiddleware, adminMiddleware, ready);
    function read(handler) {
        return async (req, res) => {
            try {
                const pool = getPool();
                if (!pool) return res.status(503).json({ success: false, error: 'storage_unavailable' });
                await handler(req, res, pool);
            } catch (_) {
                if (!res.headersSent) res.status(503).json({ success: false, error: 'storage_unavailable' });
            }
        };
    }
    admin.get('/', read(async (req, res, pool) => {
        const value = req.query.limit;
        if (value !== undefined && (typeof value !== 'string' || !/^[1-9]\d{0,2}$/.test(value) || Number(value) > 100)) {
            return res.status(400).json({ success: false, error: 'invalid_limit' });
        }
        const result = await pool.query('SELECT id, schema_version AS "schemaVersion", category, description, app_version AS version, screen, created_at AS "createdAt" FROM fraud_app_feedback_reports ORDER BY created_at DESC, id DESC LIMIT $1', [value === undefined ? 25 : Number(value)]);
        res.json({ success: true, reports: result.rows });
    }));
    admin.get('/:id', read(async (req, res, pool) => {
        if (!UUID.test(req.params.id)) return res.status(400).json({ success: false, error: 'invalid_id' });
        const result = await pool.query('SELECT id, schema_version AS "schemaVersion", category, description, app_version AS version, screen, created_at AS "createdAt" FROM fraud_app_feedback_reports WHERE id = $1', [req.params.id]);
        if (!result.rows.length) return res.status(404).json({ success: false, error: 'not_found' });
        res.json({ success: true, report: result.rows[0] });
    }));
    admin.use((_req, res) => res.status(404).json({ success: false, error: 'not_found' }));
    return { intake, admin };
}
module.exports = { MAX_BYTES, CATEGORIES, validate, payloadHash, migrateSchema, saveReport, noStore, createRouters };
