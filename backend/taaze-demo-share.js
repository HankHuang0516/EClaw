/** One explicitly authorized Sites v5 demo; never a general file host. */
const express = require('express');
const fs = require('fs');
const path = require('path');
const { createHash, randomBytes, randomUUID } = require('crypto');
const { adaptDemoMap } = require('./taaze-demo-map-adapter');
const schema = fs.readFileSync(path.join(__dirname, 'taaze_demo_share_schema.sql'), 'utf8');
const DEMO_ID = 'taaze-three-item-v5';
const SOURCE_SHA256 = '8d945ff62116e8053dc2a9c2a52ffe5aa767a78f36cc843295faa0dd0c69f34b';
const SOURCE_COMMIT = '5ca4b96da5c81448d8ab81f07686df1b4563bbb0';
const MAX_BYTES = 2 * 1024 * 1024;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };
const hash = value => createHash('sha256').update(value).digest('hex');
const fault = (status, code) => Object.assign(new Error(code), { status, code });
function strict(input, fields) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !fields.includes(k))) throw fault(400, 'invalid_body');
}
function safePath(value) {
    return typeof value === 'string' && value.length <= 240 && /^[a-zA-Z0-9_./-]+$/.test(value) && !value.startsWith('/') && value.split('/').every(p => p && p !== '.' && p !== '..');
}
function decode(value) {
    if (typeof value !== 'string' || value.length > Math.ceil(MAX_BYTES / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw fault(400, 'invalid_base64');
    const body = Buffer.from(value, 'base64');
    if (!body.length || body.length > MAX_BYTES || body.toString('base64') !== value) throw fault(400, 'invalid_base64');
    return body;
}
const { inflateRawSync } = require('zlib');
const DIST_PREFIX = 'original/dist/';
const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
    let crc = index;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    return crc >>> 0;
});
function crc32(body) {
    let crc = 0xffffffff;
    for (const byte of body) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 255];
    return (crc ^ 0xffffffff) >>> 0;
}
function zipFiles(archive) {
    try {
        let end = archive.length - 22;
        const minimum = Math.max(0, archive.length - 65557);
        while (end >= minimum && archive.readUInt32LE(end) !== 0x06054b50) end--;
        if (end < minimum || end + 22 + archive.readUInt16LE(end + 20) !== archive.length) throw new Error('end');
        const count = archive.readUInt16LE(end + 10);
        const centralSize = archive.readUInt32LE(end + 12); const centralOffset = archive.readUInt32LE(end + 16);
        if (archive.readUInt16LE(end + 4) || archive.readUInt16LE(end + 6) || archive.readUInt16LE(end + 8) !== count || !count || count > 128 || centralOffset + centralSize !== end) throw new Error('central');
        const entries = new Map(); const ranges = []; let cursor = centralOffset; let total = 0;
        function extraFields(extra) {
            let offset = 0;
            while (offset < extra.length) {
                if (offset + 4 > extra.length) throw new Error('extra');
                const id = extra.readUInt16LE(offset); const length = extra.readUInt16LE(offset + 2);
                if ([0x0001, 0x7075, 0x9901].includes(id) || offset + 4 + length > extra.length) throw new Error('extra');
                offset += 4 + length;
            }
        }
        for (let i = 0; i < count; i++) {
            if (cursor + 46 > end || archive.readUInt32LE(cursor) !== 0x02014b50) throw new Error('entry');
            const madeBy = archive.readUInt16LE(cursor + 4); const version = archive.readUInt16LE(cursor + 6);
            const flags = archive.readUInt16LE(cursor + 8); const method = archive.readUInt16LE(cursor + 10);
            const checksum = archive.readUInt32LE(cursor + 16); const compressedSize = archive.readUInt32LE(cursor + 20); const size = archive.readUInt32LE(cursor + 24);
            const nameLength = archive.readUInt16LE(cursor + 28); const extraLength = archive.readUInt16LE(cursor + 30); const commentLength = archive.readUInt16LE(cursor + 32);
            const attributes = archive.readUInt32LE(cursor + 38); const local = archive.readUInt32LE(cursor + 42);
            const next = cursor + 46 + nameLength + extraLength + commentLength;
            if (next > end || version > 20 || (flags & ~0x0800) || ![0, 8].includes(method) || archive.readUInt16LE(cursor + 34)) throw new Error('entry');
            const unixType = (attributes >>> 16) & 0xf000;
            if ((attributes & 0x10) || ((madeBy >>> 8) === 3 && unixType && unixType !== 0x8000)) throw new Error('file-type');
            const nameBytes = archive.subarray(cursor + 46, cursor + 46 + nameLength); const name = nameBytes.toString('utf8');
            if (!safePath(name) || !nameBytes.equals(Buffer.from(name)) || entries.has(name)) throw new Error('path');
            extraFields(archive.subarray(cursor + 46 + nameLength, cursor + 46 + nameLength + extraLength));
            total += size;
            if (size > MAX_BYTES || compressedSize > MAX_BYTES || total > MAX_BYTES || local + 30 > centralOffset || archive.readUInt32LE(local) !== 0x04034b50) throw new Error('bounds');
            const localNameLength = archive.readUInt16LE(local + 26); const localExtraLength = archive.readUInt16LE(local + 28);
            const dataStart = local + 30 + localNameLength + localExtraLength; const dataEnd = dataStart + compressedSize;
            if (dataEnd > centralOffset || archive.readUInt16LE(local + 4) !== version || archive.readUInt16LE(local + 6) !== flags || archive.readUInt16LE(local + 8) !== method || archive.readUInt32LE(local + 10) !== archive.readUInt32LE(cursor + 12) || archive.readUInt32LE(local + 14) !== checksum || archive.readUInt32LE(local + 18) !== compressedSize || archive.readUInt32LE(local + 22) !== size || !nameBytes.equals(archive.subarray(local + 30, local + 30 + localNameLength))) throw new Error('local');
            extraFields(archive.subarray(local + 30 + localNameLength, dataStart));
            const compressed = archive.subarray(dataStart, dataEnd);
            let body;
            if (method === 0) body = compressed;
            else {
                const inflated = inflateRawSync(compressed, { maxOutputLength: Math.max(size, 1), info: true });
                if (inflated.engine.bytesWritten !== compressed.length) throw new Error('deflate-tail');
                body = inflated.buffer;
            }
            if (body.length !== size || crc32(body) !== checksum) throw new Error('content');
            entries.set(name, body); ranges.push([local, dataEnd]); cursor = next;
        }
        if (cursor !== end) throw new Error('central-tail');
        ranges.sort((a, b) => a[0] - b[0]); let expected = 0;
        for (const [start, stop] of ranges) { if (start !== expected) throw new Error('overlap-or-gap'); expected = stop; }
        if (expected !== centralOffset) throw new Error('local-tail');
        return entries;
    } catch (_err) { throw fault(400, 'invalid_archive'); }
}
function bundleInput(input) {
    strict(input, ['sourceArchiveBase64', 'sourceCommit', 'files']);
    // Verify the actual original archive bytes, not an untrusted manifest assertion.
    const archive = decode(input.sourceArchiveBase64);
    if (input.sourceCommit !== SOURCE_COMMIT || hash(archive) !== SOURCE_SHA256) throw fault(400, 'source_mismatch');
    const sourceFiles = zipFiles(archive);
    const allowed = [...sourceFiles.keys()].filter(name => name.startsWith(DIST_PREFIX));
    const mapping = input.files === undefined ? allowed.map(archivePath => ({ archivePath, path: archivePath.slice(DIST_PREFIX.length) })) : input.files;
    if (!Array.isArray(mapping) || !mapping.length || mapping.length > 64 || mapping.length !== allowed.length) throw fault(400, 'invalid_files');
    let bytes = 0;
    const seen = new Set();
    const files = mapping.map(file => {
        strict(file, ['path', 'archivePath']);
        if (!safePath(file.path) || !TYPES[path.extname(file.path)] || seen.has(file.path)) throw fault(400, 'invalid_path');
        seen.add(file.path);
        if (!safePath(file.archivePath) || !file.archivePath.startsWith(DIST_PREFIX) || file.path !== file.archivePath.slice(DIST_PREFIX.length) || !sourceFiles.has(file.archivePath)) throw fault(400, 'invalid_source_path');
        const body = sourceFiles.get(file.archivePath); bytes += body.length;
        if (bytes > MAX_BYTES) throw fault(400, 'bundle_too_large');
        return { path: file.path, body, contentType: TYPES[path.extname(file.path)] };
    }).sort((a, b) => a.path.localeCompare(b.path));
    if (!seen.has('index.html')) throw fault(400, 'missing_index');
    // A deterministic digest covers paths AND bytes. Importing never changes live content.
    const digest = hash(JSON.stringify(files.map(f => [f.path, hash(f.body)])));
    return { files, digest };
}
function privateHeaders(_req, res, next) {
    res.set({ 'Cache-Control': 'private, no-store, no-transform', 'CDN-Cache-Control': 'no-store', 'Surrogate-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow, noarchive', 'X-Content-Type-Options': 'nosniff' });
    next();
}
function adminWriteOrigin(req, res, next) {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        if (req.get('sec-fetch-site') === 'cross-site') return res.status(403).json({ success: false, error: 'cross_origin_write' });
        if (req.get('origin')) {
            try { if (new URL(req.get('origin')).host !== req.get('host')) throw new Error('origin'); }
            catch (_err) { return res.status(403).json({ success: false, error: 'cross_origin_write' }); }
        }
    }
    next();
}
function contentPolicy(contentType, body) {
    const scripts = [];
    if (contentType.startsWith('text/html')) {
        for (const match of body.toString('utf8').matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
            if (!/(?:^|\s)src\s*=/i.test(match[1])) scripts.push(`'sha256-${createHash('sha256').update(match[2].replace(/\r\n?/g, '\n')).digest('base64')}'`);
        }
    }
    return `default-src 'none'; script-src 'self' ${scripts.join(' ')}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src https://eclawbot.com/AiHankApps/taaze-demo/; form-action 'none'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'`;
}
function createRouters(getPool, auth) {
    if (!auth?.authMiddleware || !auth?.adminMiddleware) throw new Error('Demo shares require existing admin auth');
    let readyPool; let ready;
    async function transaction(pool, fn) {
        const client = await pool.connect();
        try { await client.query('BEGIN'); const value = await fn(client); await client.query('COMMIT'); return value; }
        catch (err) { await client.query('ROLLBACK').catch(() => {}); throw err; }
        finally { client.release(); }
    }
    async function database() {
        const pool = getPool();
        if (!pool?.connect) throw fault(503, 'demo_unavailable');
        if (!ready || readyPool !== pool) {
            readyPool = pool;
            ready = transaction(pool, async c => { await c.query('SELECT pg_advisory_xact_lock(72140517)'); await c.query(schema); }).catch(e => { ready = null; throw e; });
        }
        await ready; return pool;
    }
    const adminRouter = express.Router(); const publicRouter = express.Router(); const debugRouter = express.Router();
    const withError = fn => async (req, res) => {
        try { await fn(req, res); }
        catch (e) { res.status(e.status || 503).json({ success: false, error: e.code || 'demo_unavailable' }); }
    };
    adminRouter.use(privateHeaders, auth.authMiddleware, auth.adminMiddleware);
    adminRouter.use(adminWriteOrigin);
    adminRouter.use(express.json({ limit: '6mb' }));
    adminRouter.get('/', withError(async (_req, res) => {
        const pool = await database();
        const bundle = await pool.query('SELECT id, source_sha256 AS "sourceSha256", bundle_sha256 AS "bundleSha256", imported_at AS "importedAt" FROM taaze_demo_bundles WHERE id=$1', [DEMO_ID]);
        const shares = await pool.query('SELECT id, created_at AS "createdAt", expires_at AS "expiresAt", revoked_at AS "revokedAt" FROM taaze_demo_shares WHERE bundle_id=$1 ORDER BY created_at DESC LIMIT 100', [DEMO_ID]);
        res.json({ success: true, bundle: bundle.rows[0] || null, shares: shares.rows });
    }));
    adminRouter.post('/bundle', withError(async (req, res) => {
        const { files, digest } = bundleInput(req.body); const pool = await database();
        await transaction(pool, async c => {
            await c.query('SELECT pg_advisory_xact_lock(72140518)');
            const existing = await c.query('SELECT bundle_sha256 FROM taaze_demo_bundles WHERE id=$1', [DEMO_ID]);
            if (existing.rows.length) {
                if (existing.rows[0].bundle_sha256 !== digest) throw fault(409, 'bundle_already_imported');
                return;
            }
            await c.query('INSERT INTO taaze_demo_bundles(id, source_sha256, bundle_sha256, imported_by) VALUES ($1,$2,$3,$4)', [DEMO_ID, SOURCE_SHA256, digest, req.user.userId]);
            for (const f of files) await c.query('INSERT INTO taaze_demo_assets(bundle_id,path,content_type,body) VALUES ($1,$2,$3,$4)', [DEMO_ID, f.path, f.contentType, f.body]);
        });
        res.json({ success: true, bundle: { id: DEMO_ID, sourceSha256: SOURCE_SHA256, bundleSha256: digest, fileCount: files.length } });
    }));
    adminRouter.post('/shares', withError(async (req, res) => {
        strict(req.body, ['requestId']);
        if (typeof req.body.requestId !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(req.body.requestId)) throw fault(400, 'invalid_request_id');
        const pool = await database(); const token = randomBytes(32).toString('base64url'); const id = randomUUID();
        const share = await transaction(pool, async c => {
            await c.query('SELECT pg_advisory_xact_lock(72140518)');
            if (!(await c.query('SELECT id FROM taaze_demo_bundles WHERE id=$1', [DEMO_ID])).rows.length) throw fault(409, 'bundle_required');
            if ((await c.query('SELECT id FROM taaze_demo_shares WHERE created_by=$1 AND request_id=$2', [req.user.userId, req.body.requestId])).rows.length) throw fault(409, 'share_already_issued');
            const result = await c.query('INSERT INTO taaze_demo_shares(id,bundle_id,token_hash,created_by,request_id,expires_at) VALUES ($1,$2,$3,$4,$5,NULL) RETURNING created_at AS "createdAt", expires_at AS "expiresAt"', [id, DEMO_ID, hash(token), req.user.userId, req.body.requestId]);
            return result.rows[0];
        });
        // The token is shown once; neither list nor database stores the capability.
        res.json({ success: true, share: { id, ...share, path: `/AiHankApps/taaze-demo/${token}/` } });
    }));
    adminRouter.post('/shares/:id/revoke', withError(async (req, res) => {
        strict(req.body, []);
        if (!/^[a-f0-9-]{36}$/.test(req.params.id)) throw fault(404, 'share_not_found');
        const pool = await database();
        const result = await pool.query('UPDATE taaze_demo_shares SET revoked_at=COALESCE(revoked_at,NOW()), revoked_by=COALESCE(revoked_by,$1) WHERE id=$2 AND bundle_id=$3 RETURNING id, revoked_at AS "revokedAt"', [req.user.userId, req.params.id, DEMO_ID]);
        if (!result.rows.length) throw fault(404, 'share_not_found');
        res.json({ success: true, share: result.rows[0] });
    }));
    publicRouter.use(privateHeaders);
    // Terminal handler: missing/invalid capabilities cannot reach express.static.
    publicRouter.use(async (req, res) => {
        const deny = () => res.status(404).type('text/plain').send('Not found');
        try {
            if (!['GET', 'HEAD'].includes(req.method)) return deny();
            const parts = req.path.slice(1).split('/'); const token = parts.shift();
            if (!/^[A-Za-z0-9_-]{43}$/.test(token || '')) return deny();
            const asset = decodeURIComponent(parts.join('/') || 'index.html');
            if (!safePath(asset)) return deny();
            const pool = await database();
            const result = await pool.query('SELECT a.content_type, a.body FROM taaze_demo_assets a JOIN taaze_demo_shares s ON s.bundle_id=a.bundle_id WHERE s.token_hash=$1 AND s.bundle_id=$2 AND s.revoked_at IS NULL AND (s.expires_at IS NULL OR s.expires_at>NOW()) AND a.path=$3 LIMIT 1', [hash(token), DEMO_ID, asset]);
            if (!result.rows.length) return deny();
            const row = result.rows[0];
            const body = asset === 'map.js' ? adaptDemoMap(row.body) : row.body;
            res.set('Content-Security-Policy', contentPolicy(row.content_type, row.body));
            res.type(row.content_type).send(body);
        } catch (_err) { return deny(); }
    });
    debugRouter.use(privateHeaders, (_req, res, next) => {
        if (process.env.NODE_ENV === 'production' && process.env.RAILWAY_ENVIRONMENT !== 'debug') return res.sendStatus(404);
        next();
    }, auth.authMiddleware, auth.adminMiddleware);
    debugRouter.get('/', withError(async (_req, res) => {
        const pool = await database();
        const [assets, shares] = await Promise.all([
            pool.query('SELECT COUNT(*) AS count FROM taaze_demo_assets'),
            pool.query('SELECT COUNT(*) AS count FROM taaze_demo_shares')
        ]);
        res.json({ success: true, counts: { assets: Number(assets.rows[0].count), shares: Number(shares.rows[0].count) } });
    }));
    return { adminRouter, publicRouter, debugRouter };
}
module.exports = { createRouters, adminWriteOrigin, DEMO_ID, SOURCE_SHA256, SOURCE_COMMIT };
