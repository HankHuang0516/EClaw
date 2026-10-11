'use strict';
const express = require('express');
const crypto = require('crypto');
const { rateLimit } = require('express-rate-limit');
const extractCreds = require('./extract-creds');
const KEY_URL = 'https://www.gstatic.com/admob/reward/verifier-keys.json';
const UNITS = { ios: '6438262242', android: '9855772231' };
let keyFlight;
let keyCache;
let keyDeadline = 0;

async function googleKeys() {
    if (keyCache && Date.now() < keyDeadline) return keyCache;
    if (!keyFlight) keyFlight = (async () => {
        const response = await fetch(KEY_URL, { signal: AbortSignal.timeout(15000) });
        if (!response.ok) throw new Error('key_fetch_failed');
        const body = await response.json();
        if (!Array.isArray(body.keys) || body.keys.length > 100) throw new Error('key_response_invalid');
        const keys = new Map(body.keys.map((key) => {
            if (!key || typeof key.pem !== 'string' || key.pem.length > 8000) throw new Error('key_invalid');
            const publicKey = crypto.createPublicKey(key.pem);
            if (publicKey.asymmetricKeyType !== 'ec') throw new Error('key_invalid');
            return [String(key.keyId), publicKey];
        }));
        if (!keys.size) throw new Error('key_response_invalid');
        keyCache = keys;
        keyDeadline = Date.now() + 60 * 60 * 1000;
        return keys;
    })().finally(() => { keyFlight = null; });
    return keyFlight;
}
async function verifyQuery(raw, loadKeys = googleKeys) {
    if (typeof raw !== 'string' || raw.length > 16000) throw new Error('invalid_callback');
    const position = raw.indexOf('&signature=');
    if (position <= 0) throw new Error('invalid_signature');
    const params = new URLSearchParams(raw);
    for (const key of params.keys()) {
        if (params.getAll(key).length !== 1) throw new Error('duplicate_parameter');
    }
    const signature = params.get('signature');
    const keyId = params.get('key_id');
    if (!signature || !/^[A-Za-z0-9_-]+={0,2}$/.test(signature) ||
        !keyId || !/^\d{1,20}$/.test(keyId) ||
        !/^signature=[^&]+&key_id=\d{1,20}$/.test(raw.slice(position + 1))) {
        throw new Error('invalid_signature');
    }
    const keys = await loadKeys();
    const key = keys.get(keyId);
    if (!key || !crypto.verify('sha256', Buffer.from(raw.slice(0, position)),
        key, Buffer.from(signature, 'base64url'))) throw new Error('invalid_signature');
    return params;
}
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' &&
    Buffer.byteLength(a) === Buffer.byteLength(b) &&
    crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

module.exports = function createAdsRouter({ getDevices, getPool, isReady = () => true, loadKeys = googleKeys }) {
    const router = express.Router();
    const initializations = new WeakMap();
    async function poolReady() {
        const pool = getPool();
        if (!pool) throw new Error('database_unavailable');
        if (!initializations.has(pool)) {
            const initializing = pool.query(
                'CREATE TABLE IF NOT EXISTS dream_buddy_ad_sessions (' +
                'session_id TEXT PRIMARY KEY, device_id TEXT NOT NULL, platform TEXT NOT NULL,' +
                'created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), expires_at TIMESTAMPTZ NOT NULL,' +
                'redeemed BOOLEAN NOT NULL DEFAULT FALSE);' +
                'CREATE TABLE IF NOT EXISTS dream_buddy_ad_transactions (' +
                'transaction_id TEXT PRIMARY KEY, session_id TEXT NOT NULL UNIQUE ' +
                'REFERENCES dream_buddy_ad_sessions(session_id), quota_date DATE NOT NULL,' +
                'credited_at TIMESTAMPTZ NOT NULL DEFAULT NOW());'
            ).catch((error) => { initializations.delete(pool); throw error; });
            initializations.set(pool, initializing);
        }
        await initializations.get(pool);
        return pool;
    }
    function authenticate(req, res, next) {
        if (!isReady()) return res.status(503).json({ success: false, error: 'service_initializing' });
        const credentials = extractCreds(req);
        const device = typeof credentials.deviceId === 'string' ? getDevices()[credentials.deviceId] : null;
        if (!device || !equal(device.deviceSecret, credentials.deviceSecret)) {
            return res.status(403).json({ success: false, error: 'invalid_device' });
        }
        req.adDeviceId = credentials.deviceId;
        next();
    }
    async function quota(pool, deviceId) {
        const day = new Date().toISOString().slice(0, 10);
        const result = await pool.query(
            'SELECT messages_used, bonus_from_ads FROM app_bot_quota ' +
            'WHERE app_id=$1 AND device_id=$2 AND quota_date=$3',
            ['dream-buddy', deviceId, day]
        );
        const row = result.rows[0] || { messages_used: 0, bonus_from_ads: 0 };
        return { day, remaining: Math.max(0, 8 + row.bonus_from_ads - row.messages_used) };
    }
    // Mounted after the existing /api/debug namespace guard; authenticate the
    // owner as well, and never expose challenge tokens or signed callback data.
    const diagnostics = express.Router();
    diagnostics.use((req, res, next) => {
        if (process.env.NODE_ENV === 'production' || process.env.RAILWAY_ENVIRONMENT) {
            return res.status(404).json({ success: false, error: 'not_found' });
        }
        next();
    }, authenticate);
    diagnostics.get('/', async (req, res) => {
        try {
            const pool = await poolReady();
            const sessions = await pool.query(
                'SELECT platform,created_at,expires_at,redeemed FROM dream_buddy_ad_sessions ' +
                'WHERE device_id=$1 ORDER BY created_at DESC LIMIT 20', [req.adDeviceId]
            );
            const transactions = await pool.query(
                'SELECT t.quota_date,t.credited_at FROM dream_buddy_ad_transactions t ' +
                'JOIN dream_buddy_ad_sessions s ON s.session_id=t.session_id ' +
                'WHERE s.device_id=$1 ORDER BY t.credited_at DESC LIMIT 20', [req.adDeviceId]
            );
            res.json({ success: true, quota: await quota(pool, req.adDeviceId),
                sessions: sessions.rows, transactions: transactions.rows });
        } catch { res.status(503).json({ success: false, error: 'database_unavailable' }); }
    });
    router.diagnostics = diagnostics;
    router.get('/quota', authenticate, async (req, res) => {
        try { res.json({ success: true, ...await quota(await poolReady(), req.adDeviceId) }); }
        catch { res.status(503).json({ success: false, error: 'database_unavailable' }); }
    });
    const limit = rateLimit({ windowMs: 60000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false });
    router.post('/sessions', authenticate, limit, async (req, res) => {
        const platform = req.body && req.body.platform;
        if (!Object.hasOwn(UNITS, platform)) return res.status(400).json({ success: false, error: 'invalid_platform' });
        try {
            const pool = await poolReady();
            const sessionId = crypto.randomBytes(24).toString('base64url');
            const expires = new Date(Date.now() + 2 * 60 * 60 * 1000);
            await pool.query(
                'INSERT INTO dream_buddy_ad_sessions (session_id,device_id,platform,expires_at) VALUES($1,$2,$3,$4)',
                [sessionId, req.adDeviceId, platform, expires.toISOString()]
            );
            res.json({ success: true, sessionId, expiresAt: expires.toISOString(), rewardAmount: 6 });
        } catch { res.status(503).json({ success: false, error: 'database_unavailable' }); }
    });
    router.get('/sessions/:id', authenticate, async (req, res) => {
        if (!/^[A-Za-z0-9_-]{32}$/.test(req.params.id)) return res.status(404).json({ success: false, error: 'not_found' });
        try {
            const pool = await poolReady();
            const result = await pool.query(
                'SELECT redeemed,expires_at FROM dream_buddy_ad_sessions WHERE session_id=$1 AND device_id=$2',
                [req.params.id, req.adDeviceId]
            );
            const row = result.rows[0];
            if (!row) return res.status(404).json({ success: false, error: 'not_found' });
            const status = row.redeemed ? 'rewarded' : new Date(row.expires_at).getTime() < Date.now() ? 'expired' : 'pending';
            res.json({ success: true, status });
        } catch { res.status(503).json({ success: false, error: 'database_unavailable' }); }
    });
    router.get('/ssv', async (req, res) => {
        let params;
        try { params = await verifyQuery(req.originalUrl.split('?')[1], loadKeys); }
        catch { return res.status(400).json({ success: false, error: 'invalid_callback' }); }
        const unit = params.get('ad_unit');
        const transaction = params.get('transaction_id');
        const session = params.get('custom_data');
        const timestamp = Number(params.get('timestamp'));
        if (!Object.values(UNITS).includes(unit) || params.get('reward_amount') !== '6' ||
            params.get('reward_item') !== 'messages' || !transaction || transaction.length > 128 ||
            !Number.isSafeInteger(timestamp) || Math.abs(Date.now() - timestamp) > 7 * 24 * 60 * 60 * 1000) {
            return res.status(400).json({ success: false, error: 'invalid_reward' });
        }
        // The AdMob URL testing tool may omit an app-issued challenge. Genuine,
        // signed callbacks without a challenge are acknowledged but never credited.
        if (!session || !/^[A-Za-z0-9_-]{32}$/.test(session)) {
            return res.json({ success: true, credited: false });
        }
        let client;
        try {
            const pool = await poolReady();
            client = await pool.connect();
            await client.query('BEGIN');
            const result = await client.query(
                'SELECT * FROM dream_buddy_ad_sessions WHERE session_id=$1 FOR UPDATE', [session]
            );
            const row = result.rows[0];
            if (!row || row.redeemed) {
                await client.query('ROLLBACK');
                return res.json({ success: true, credited: false });
            }
            if (UNITS[row.platform] !== unit || timestamp < new Date(row.created_at).getTime() - 60000 ||
                timestamp > new Date(row.expires_at).getTime() + 60000) {
                await client.query('ROLLBACK');
                return res.status(400).json({ success: false, error: 'invalid_session' });
            }
            const day = new Date().toISOString().slice(0, 10);
            const inserted = await client.query(
                'INSERT INTO dream_buddy_ad_transactions(transaction_id,session_id,quota_date) ' +
                'VALUES($1,$2,$3) ON CONFLICT(transaction_id) DO NOTHING RETURNING transaction_id',
                [transaction, session, day]
            );
            if (!inserted.rows.length) {
                await client.query('ROLLBACK');
                return res.json({ success: true, credited: false });
            }
            await client.query(
                'INSERT INTO app_bot_quota(app_id,device_id,quota_date,bonus_from_ads) VALUES($1,$2,$3,6) ' +
                'ON CONFLICT(app_id,device_id,quota_date) DO UPDATE SET ' +
                'bonus_from_ads=app_bot_quota.bonus_from_ads+6,updated_at=NOW()',
                ['dream-buddy', row.device_id, day]
            );
            await client.query('UPDATE dream_buddy_ad_sessions SET redeemed=TRUE WHERE session_id=$1', [session]);
            await client.query('COMMIT');
            res.json({ success: true, credited: true });
        } catch {
            if (client) await client.query('ROLLBACK').catch(() => {});
            res.status(503).json({ success: false, error: 'database_unavailable' });
        } finally { if (client) client.release(); }
    });
    return router;
};
module.exports.verifyQuery = verifyQuery;
