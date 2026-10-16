'use strict';

const crypto = require('crypto');
const express = require('express');
const { rateLimit } = require('express-rate-limit');

const CATEGORIES = Object.freeze(['operation', 'rules', 'dialogue', 'art', 'balance', 'other']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const schemaPromises = new WeakMap();
const approvedMedia = new Set(require('./public/AiHankApps/projects/fraud-empire/release.json').assets
    .filter(asset => /\.(?:webp|png|jpe?g|svg)$/.test(asset.path)).map(asset => asset.path));

function plain(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        && Object.getPrototypeOf(value) === Object.prototype;
}

function keys(value, allowed) {
    return plain(value) && Object.keys(value).every(key => allowed.includes(key));
}

function text(value, max, nullable = false) {
    return nullable && value === null || typeof value === 'string' && value.length <= max;
}

function number(value, min, max) {
    return value === null || Number.isFinite(value) && value >= min && value <= max;
}

function validate(body) {
    if (!keys(body, ['id', 'category', 'description', 'snapshot']) || !UUID.test(body.id)
        || !CATEGORIES.includes(body.category) || typeof body.description !== 'string'
        || !body.description.trim() || body.description.length > 2000) return false;
    const s = body.snapshot;
    if (!keys(s, ['schemaVersion', 'capturedAt', 'version', 'contentHash', 'screen', 'game', 'parameters', 'recentActions'])
        || s.schemaVersion !== 1 || typeof s.capturedAt !== 'string'
        || !Number.isFinite(Date.parse(s.capturedAt)) || !text(s.version, 160)
        || !/^v\d/.test(s.version) || !/^[a-f0-9]{64}$/.test(s.contentHash)) return false;
    const view = s.screen;
    if (!keys(view, ['module', 'id', 'sceneId', 'stepId', 'visibleText', 'choices', 'assetIds'])
        || !['T02', 'camp', 'prototype', 'legacy', 'archive', 'uninitialized'].includes(view.module)
        || !text(view.id, 128, true) || !text(view.sceneId, 128, true)
        || !text(view.stepId, 128, true) || !text(view.visibleText, 6000)
        || !Array.isArray(view.choices) || view.choices.length > 20
        || !view.choices.every(c => keys(c, ['id', 'label', 'disabled']) && text(c.id, 128)
            && text(c.label, 160) && typeof c.disabled === 'boolean')
        || !Array.isArray(view.assetIds) || view.assetIds.length > 12
        || !view.assetIds.every(id => typeof id === 'string' && approvedMedia.has(id))) return false;
    const game = s.game;
    if (!keys(game, ['day', 'time', 'rank', 'scope', 'uninitialized'])
        || !number(game.day, 1, 100000) || !number(game.rank, 1, 5)
        || !(game.time === null || typeof game.time === 'string' && /^\d{2}:\d{2}$/.test(game.time))
        || !['not-initialized', 'prototype-local', 'configured-demo-context'].includes(game.scope)
        || !Array.isArray(game.uninitialized) || game.uninitialized.length > 12
        || !game.uninitialized.every(k => ['day', 'time', 'rank', 'mood', 'stamina', 'wisdom', 'score', 'xp', 'money'].includes(k))) return false;
    const selectionKeys = ['selectedJob', 'selectedPiece', 'selectedTicket'];
    if (!keys(s.parameters, ['timeline', 'logicalStep', 'resultCount', 'awardedReward', 'appliedMinutes',
        'selectedJob', 'selectedPiece', 'selectedTicket', 'selectedPieceRotation'])
        || !Object.entries(s.parameters).every(([key, value]) => selectionKeys.includes(key)
            ? text(value, 128, true) : number(value, 0, 1000000000))
        || !Array.isArray(s.recentActions) || s.recentActions.length > 12
        || !s.recentActions.every(a => keys(a, ['action', 'target']) && text(a.action, 80) && text(a.target, 128))) return false;
    return Buffer.byteLength(JSON.stringify(body), 'utf8') <= 32768;
}

async function ensureSchema(pool) {
    if (!pool || typeof pool.query !== 'function') throw new Error('storage_unavailable');
    if (!schemaPromises.has(pool)) {
        const work = pool.query(`CREATE TABLE IF NOT EXISTS fraud_empire_demo_reports (
            id UUID PRIMARY KEY,
            payload_hash CHAR(64) NOT NULL,
            category VARCHAR(32) NOT NULL,
            description TEXT NOT NULL,
            snapshot JSONB NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`).catch(error => {
            schemaPromises.delete(pool);
            throw error;
        });
        schemaPromises.set(pool, work);
    }
    await schemaPromises.get(pool);
}

async function saveReport(pool, body) {
    if (!validate(body)) {
        const error = new Error('invalid_report');
        error.status = 400;
        throw error;
    }
    await ensureSchema(pool);
    // Hash only the explicitly submitted report, never headers, logs or devices.
    const normalized = { category: body.category, description: body.description.trim(), snapshot: body.snapshot };
    const hash = crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
    const inserted = await pool.query(`INSERT INTO fraud_empire_demo_reports
        (id, payload_hash, category, description, snapshot) VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (id) DO NOTHING RETURNING id, created_at`,
    [body.id, hash, normalized.category, normalized.description, JSON.stringify(normalized.snapshot)]);
    if (inserted.rows.length) return { ...inserted.rows[0], duplicate: false };
    const existing = await pool.query(
        'SELECT id, payload_hash, created_at FROM fraud_empire_demo_reports WHERE id = $1', [body.id]);
    if (!existing.rows.length) throw new Error('storage_confirmation_missing');
    if (existing.rows[0].payload_hash !== hash) {
        const error = new Error('report_id_conflict');
        error.status = 409;
        throw error;
    }
    return { id: existing.rows[0].id, created_at: existing.rows[0].created_at, duplicate: true };
}

function noStore(_req, res, next) {
    res.set('Cache-Control', 'no-store');
    next();
}

function createRouters(getPool, authMiddleware, adminMiddleware) {
    if ([getPool, authMiddleware, adminMiddleware].some(fn => typeof fn !== 'function')) {
        throw new TypeError('Existing storage and administrator middleware are required');
    }
    const intake = express.Router();
    const admin = express.Router();
    intake.use(noStore);
    intake.post('/', rateLimit({ windowMs: 10 * 60 * 1000, max: 8, standardHeaders: true, legacyHeaders: false,
        skip: () => process.env.NODE_ENV === 'test' && process.env.ENABLE_RATE_LIMIT_IN_TEST !== '1',
        message: { success: false, saved: false, error: 'rate_limited' } }), async (req, res) => {
        try {
            const result = await saveReport(getPool(), req.body);
            res.status(result.duplicate ? 200 : 201).json({ success: true, saved: true,
                id: result.id, createdAt: result.created_at, duplicate: result.duplicate });
        } catch (error) {
            const status = [400, 409].includes(error.status) ? error.status : 503;
            res.status(status).json({ success: false, saved: false,
                error: status === 400 ? 'invalid_report' : status === 409 ? 'report_id_conflict' : 'storage_unavailable' });
        }
    });
    // No public GET. Authentication and existing is_admin verification run first.
    admin.use(noStore, authMiddleware, adminMiddleware);
    admin.get('/', async (req, res) => {
        try {
            const pool = getPool();
            await ensureSchema(pool);
            const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));
            const result = await pool.query(`SELECT id, category, description, snapshot, created_at
                FROM fraud_empire_demo_reports ORDER BY created_at DESC LIMIT $1`, [limit]);
            res.json({ success: true, reports: result.rows });
        } catch {
            res.status(503).json({ success: false, error: 'storage_unavailable' });
        }
    });
    admin.get('/:id', async (req, res) => {
        if (!UUID.test(req.params.id)) return res.status(400).json({ success: false, error: 'invalid_id' });
        try {
            const pool = getPool();
            await ensureSchema(pool);
            const result = await pool.query(`SELECT id, category, description, snapshot, created_at
                FROM fraud_empire_demo_reports WHERE id = $1`, [req.params.id]);
            if (!result.rows.length) return res.status(404).json({ success: false, error: 'not_found' });
            res.json({ success: true, report: result.rows[0] });
        } catch {
            res.status(503).json({ success: false, error: 'storage_unavailable' });
        }
    });
    const debug = express.Router();
    debug.use(noStore, (_req, res, next) => {
        if (process.env.NODE_ENV === 'production' && process.env.RAILWAY_ENVIRONMENT !== 'debug') {
            return res.status(404).json({ success: false, error: 'not_found' });
        }
        next();
    }, admin);
    return { intake, admin, debug };
}

module.exports = { CATEGORIES, validate, ensureSchema, saveReport, createRouters };
