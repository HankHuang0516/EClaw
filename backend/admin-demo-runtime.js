'use strict';

const crypto = require('crypto');
const express = require('express');

const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
const MAX_ASSET_BYTES = 8 * 1024 * 1024;
const MIME = {
    html: 'text/html; charset=utf-8',
    mjs: 'text/javascript; charset=utf-8',
    css: 'text/css; charset=utf-8',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    wav: 'audio/wav',
};
const CAPS = { html: 262144, mjs: 262144, css: 131072, png: 4194304, jpg: 4194304, jpeg: 4194304, webp: 4194304, wav: 1048576 };
const PATH = /^(?:[a-z0-9][a-z0-9_-]*\/)*[a-z0-9][a-z0-9_-]*\.(html|mjs|css|png|jpg|jpeg|webp|wav)$/;
const HEX = /^[a-f0-9]{64}$/;
const SCHEMA = [
    'CREATE TABLE IF NOT EXISTS aihank_admin_demo_releases (',
    'id TEXT PRIMARY KEY, descriptor JSONB NOT NULL, archive_bytes BYTEA NOT NULL,',
    'archive_sha256 TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());',
    'CREATE TABLE IF NOT EXISTS aihank_admin_demo_assets (',
    'release_id TEXT NOT NULL REFERENCES aihank_admin_demo_releases(id) ON DELETE CASCADE,',
    'path TEXT NOT NULL, content_type TEXT NOT NULL, sha256 TEXT NOT NULL,',
    'byte_length INTEGER NOT NULL, content_bytes BYTEA NOT NULL, PRIMARY KEY(release_id, path));',
].join('\n');

function sha256(data) { return crypto.createHash('sha256').update(data).digest('hex'); }
function canonical(value) {
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    if (value && typeof value === 'object') {
        return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
    }
    return JSON.stringify(value);
}
function invalid() {
    const error = new Error('Invalid private runtime payload');
    error.code = 'INVALID_PRIVATE_RUNTIME';
    throw error;
}
function keys(value, allowed) {
    if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).some(key => !allowed.includes(key))) invalid();
}
function decode(record, cap) {
    keys(record, ['data', 'sha256', 'bytes', 'path']);
    if (!Number.isSafeInteger(record.bytes) || record.bytes < 1 || record.bytes > cap || !HEX.test(record.sha256 || '')) invalid();
    if (typeof record.data !== 'string' || record.data.length > 4 * Math.ceil(cap / 3)
        || record.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(record.data)) invalid();
    const bytes = Buffer.from(record.data, 'base64');
    if (bytes.length !== record.bytes || bytes.toString('base64') !== record.data || sha256(bytes) !== record.sha256) invalid();
    return bytes;
}
function validPath(path) { return typeof path === 'string' && path.length <= 180 && PATH.test(path); }
function checkType(path, bytes) {
    const ext = path.split('.').pop();
    if (['html', 'mjs', 'css'].includes(ext)) {
        const text = bytes.toString('utf8');
        if (!Buffer.from(text, 'utf8').equals(bytes) || text.includes('\0')
            || /\/Users\/|\/Volumes\/|file:\/\/|BEGIN [A-Z ]*PRIVATE KEY|\bgh[pousr]_[A-Za-z0-9]{20,}|\bya29\./.test(text)) invalid();
    } else if (ext === 'png') {
        if (bytes.length < 8 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) invalid();
    } else if (ext === 'jpg' || ext === 'jpeg') {
        if (bytes.length < 3 || bytes[0] !== 255 || bytes[1] !== 216 || bytes[2] !== 255) invalid();
    } else if (ext === 'webp' || ext === 'wav') {
        if (bytes.length < 12 || bytes.toString('ascii', 0, 4) !== 'RIFF'
            || bytes.toString('ascii', 8, 12) !== (ext === 'wav' ? 'WAVE' : 'WEBP')) invalid();
    }
    return MIME[ext];
}
function validatePayload(payload) {
    keys(payload, ['schemaVersion', 'archive', 'assets', 'entries']);
    if (payload.schemaVersion !== 1 || !Array.isArray(payload.assets) || payload.assets.length < 1 || payload.assets.length > 32
        || !Array.isArray(payload.entries) || payload.entries.length < 1 || payload.entries.length > 8) invalid();
    const archive = decode(payload.archive, 6 * 1024 * 1024);
    if (archive.length < 22 || archive.readUInt32LE(0) !== 0x04034b50) invalid();
    const paths = new Set();
    let total = 0;
    const assets = payload.assets.map(record => {
        if (!validPath(record.path) || paths.has(record.path)) invalid();
        paths.add(record.path);
        const ext = record.path.split('.').pop();
        const bytes = decode(record, CAPS[ext]);
        total += bytes.length;
        if (total > MAX_ASSET_BYTES) invalid();
        return { path: record.path, sha256: record.sha256, bytes: bytes.length, type: checkType(record.path, bytes), data: bytes };
    }).sort((a, b) => a.path.localeCompare(b.path));
    const entryPaths = new Set();
    const entries = payload.entries.map(entry => {
        keys(entry, ['title', 'path']);
        if (typeof entry.title !== 'string' || !entry.title.trim() || entry.title.length > 120
            || !validPath(entry.path) || !entry.path.endsWith('.html') || !paths.has(entry.path) || entryPaths.has(entry.path)) invalid();
        entryPaths.add(entry.path);
        return { title: entry.title, path: entry.path };
    });
    const descriptor = {
        schemaVersion: 1,
        archive: { sha256: payload.archive.sha256, bytes: archive.length },
        assets: assets.map(asset => ({ path: asset.path, sha256: asset.sha256, bytes: asset.bytes, type: asset.type })),
        entries,
    };
    return { id: sha256(canonical(descriptor)), descriptor, archive, assets };
}
function checkedDescriptor(row) {
    const descriptor = typeof row.descriptor === 'string' ? JSON.parse(row.descriptor) : row.descriptor;
    if (!descriptor || sha256(canonical(descriptor)) !== row.id) throw new Error('Private runtime integrity failure');
    return descriptor;
}
function checkedBytes(value, expectedHash, expectedLength) {
    if (!Buffer.isBuffer(value) || value.length !== expectedLength || sha256(value) !== expectedHash) throw new Error('Private runtime integrity failure');
    return value;
}
async function importRelease(pool, payload) {
    const release = validatePayload(payload);
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock($1, $2)', [0x414948, 0x44454d4f]);
        await client.query(SCHEMA);
        const prior = await client.query('SELECT id FROM aihank_admin_demo_releases WHERE id = $1', [release.id]);
        const unchanged = prior.rows.length > 0;
        if (!unchanged) {
            await client.query('INSERT INTO aihank_admin_demo_releases (id, descriptor, archive_bytes, archive_sha256) VALUES ($1, $2::jsonb, $3, $4)',
                [release.id, JSON.stringify(release.descriptor), release.archive, release.descriptor.archive.sha256]);
            for (const asset of release.assets) {
                await client.query('INSERT INTO aihank_admin_demo_assets (release_id, path, content_type, sha256, byte_length, content_bytes) VALUES ($1, $2, $3, $4, $5, $6)',
                    [release.id, asset.path, asset.type, asset.sha256, asset.bytes, asset.data]);
            }
        }
        const stored = await client.query('SELECT id, descriptor, archive_bytes, archive_sha256 FROM aihank_admin_demo_releases WHERE id = $1', [release.id]);
        if (stored.rows.length !== 1 || canonical(checkedDescriptor(stored.rows[0])) !== canonical(release.descriptor)) throw new Error('Private runtime integrity failure');
        checkedBytes(stored.rows[0].archive_bytes, release.descriptor.archive.sha256, release.archive.length);
        const rows = await client.query('SELECT path, sha256, byte_length, content_bytes FROM aihank_admin_demo_assets WHERE release_id = $1', [release.id]);
        if (rows.rows.length !== release.assets.length) throw new Error('Private runtime integrity failure');
        for (const asset of release.assets) {
            const row = rows.rows.find(item => item.path === asset.path);
            if (!row || row.sha256 !== asset.sha256 || row.byte_length !== asset.bytes) throw new Error('Private runtime integrity failure');
            checkedBytes(row.content_bytes, asset.sha256, asset.bytes);
        }
        await client.query('COMMIT');
        return { id: release.id, unchanged, archiveSHA256: release.descriptor.archive.sha256,
            verifiedStoredBytes: true, assets: release.descriptor.assets, entries: release.descriptor.entries };
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
    } finally {
        client.release();
    }
}
function privateHeaders(_req, res, next) {
    res.set({
        'Cache-Control': 'private, no-store, max-age=0',
        'CDN-Cache-Control': 'no-store',
        'Cloudflare-CDN-Cache-Control': 'no-store',
        Pragma: 'no-cache',
        Expires: '0',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Cross-Origin-Resource-Policy': 'same-origin',
        'X-Frame-Options': 'SAMEORIGIN',
        'Content-Security-Policy': "default-src 'none'; base-uri 'none'; object-src 'none'; frame-ancestors 'self'; form-action 'none'; worker-src 'none'",
    });
    res.vary('Cookie');
    res.vary('Authorization');
    res.vary('Origin');
    next();
}
function rangeFor(header, length) {
    if (!header) return null;
    const match = /^bytes=(\d*)-(\d*)$/.exec(header);
    if (!match || (!match[1] && !match[2])) return false;
    let start;
    let end;
    if (!match[1]) {
        const suffix = Number(match[2]);
        if (!Number.isSafeInteger(suffix) || suffix <= 0) return false;
        start = Math.max(0, length - suffix);
        end = length - 1;
    } else {
        start = Number(match[1]);
        end = match[2] ? Number(match[2]) : length - 1;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return false;
        end = Math.min(end, length - 1);
    }
    if (start < 0 || start >= length || end < start) return false;
    return { start, end };
}
function sendBlob(req, res, bytes, type, hash, download) {
    res.set('Content-Type', type);
    res.set('ETag', '"' + hash + '"');
    res.set('Accept-Ranges', 'bytes');
    if (download) res.set('Content-Disposition', 'attachment; filename="private-runtime.zip"');
    if (type.startsWith('text/html')) {
        const inlineHashes = [];
        for (const match of bytes.toString('utf8').matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
            if (!/\bsrc\s*=/i.test(match[1])) inlineHashes.push("'sha256-" + crypto.createHash('sha256').update(match[2]).digest('base64') + "'");
        }
        res.set('Content-Security-Policy', "default-src 'none'; base-uri 'none'; object-src 'none'; frame-ancestors 'self'; form-action 'none'; worker-src 'none'; connect-src 'none'; script-src 'self' "
            + inlineHashes.join(' ') + "; script-src-attr 'none'; style-src 'self' 'unsafe-inline'; img-src 'self'; media-src 'self'; font-src 'self'");
    }
    const range = rangeFor(req.get('range'), bytes.length);
    if (range === false) return res.status(416).set('Content-Range', 'bytes */' + bytes.length).end();
    const body = range ? bytes.subarray(range.start, range.end + 1) : bytes;
    res.set('Content-Length', String(body.length));
    if (range) res.status(206).set('Content-Range', 'bytes ' + range.start + '-' + range.end + '/' + bytes.length);
    if (req.method === 'HEAD') return res.end();
    return res.end(body);
}
function createRouter({ authMiddleware, adminMiddleware, getPool, isReady }) {
    if ([authMiddleware, adminMiddleware, getPool, isReady].some(fn => typeof fn !== 'function')) throw new Error('Private runtime requires existing auth, admin and readiness middleware');
    const router = express.Router();
    router.use(privateHeaders);
    router.use((_req, res, next) => isReady() ? next() : res.status(503).json({ success: false, error: 'Private runtime unavailable' }));
    router.use(authMiddleware, adminMiddleware);
    router.use((req, res, next) => {
        const origin = req.get('origin');
        if (origin && !['https://eclawbot.com', 'https://www.eclawbot.com'].includes(origin)) return res.status(403).json({ success: false, error: 'Same-origin access required' });
        if (!['GET', 'HEAD'].includes(req.method)) return res.status(405).set('Allow', 'GET, HEAD').json({ success: false, error: 'Read-only resource' });
        next();
    });
    function read(handler) {
        return async (req, res) => {
            try {
                const pool = getPool();
                if (!pool) return res.status(503).json({ success: false, error: 'Private runtime unavailable' });
                await handler(req, res, pool);
            } catch (_) {
                if (!res.headersSent) res.status(503).json({ success: false, error: 'Private runtime unavailable' });
            }
        };
    }
    router.get('/', read(async (req, res, pool) => {
        const result = await pool.query('SELECT id, descriptor, created_at FROM aihank_admin_demo_releases ORDER BY created_at DESC, id DESC LIMIT 1');
        if (!result.rows.length) return res.status(404).json({ success: false, error: 'No private runtime published' });
        const row = result.rows[0];
        const descriptor = checkedDescriptor(row);
        res.json({ success: true, releaseId: row.id, archiveSHA256: descriptor.archive.sha256,
            assetCount: descriptor.assets.length, createdAt: row.created_at,
            entries: descriptor.entries.map(entry => ({ title: entry.title, url: req.baseUrl + '/r/' + row.id + '/' + entry.path })),
            downloadUrl: req.baseUrl + '/r/' + row.id + '/download.zip' });
    }));
    router.get('/r/:releaseId/download.zip', read(async (req, res, pool) => {
        if (!HEX.test(req.params.releaseId)) return res.status(404).end();
        const result = await pool.query('SELECT id, descriptor, archive_bytes, archive_sha256 FROM aihank_admin_demo_releases WHERE id = $1', [req.params.releaseId]);
        if (!result.rows.length) return res.status(404).end();
        const row = result.rows[0];
        const descriptor = checkedDescriptor(row);
        const bytes = checkedBytes(row.archive_bytes, descriptor.archive.sha256, descriptor.archive.bytes);
        sendBlob(req, res, bytes, 'application/zip', descriptor.archive.sha256, true);
    }));
    router.get('/r/:releaseId/*', read(async (req, res, pool) => {
        const assetPath = req.params[0];
        if (!HEX.test(req.params.releaseId) || !validPath(assetPath)) return res.status(404).end();
        const result = await pool.query('SELECT content_bytes, content_type, sha256, byte_length FROM aihank_admin_demo_assets WHERE release_id = $1 AND path = $2', [req.params.releaseId, assetPath]);
        if (!result.rows.length) return res.status(404).end();
        const row = result.rows[0];
        const bytes = checkedBytes(row.content_bytes, row.sha256, row.byte_length);
        sendBlob(req, res, bytes, row.content_type, row.sha256, false);
    }));
    router.use((_req, res) => res.status(404).json({ success: false, error: 'Private runtime not found' }));
    return router;
}
module.exports = { MAX_PAYLOAD_BYTES, canonical, sha256, validatePayload, importRelease, privateHeaders, createRouter };
