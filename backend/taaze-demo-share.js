/** One explicitly authorized Sites v5 demo; never a general file host. */
const express = require('express');
const fs = require('fs');
const path = require('path');
const { createHash, randomBytes, randomUUID } = require('crypto');
const schema = fs.readFileSync(path.join(__dirname, 'taaze_demo_share_schema.sql'), 'utf8');
const DEMO_ID = 'taaze-three-item-v5';
const SOURCE_SHA256 = 'eb5bd290c3fcbf087e077631560e4ba946988160ff546ff929152e74995d1cd9';
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
function tarFiles(archive) {
    const entries = new Map(); let offset = 0; let count = 0;
    const number = bytes => {
        const value = bytes.toString('ascii').replace(/\0.*$/, '').trim();
        if (!/^[0-7]+$/.test(value)) throw fault(400, 'invalid_archive');
        return parseInt(value, 8);
    };
    const string = bytes => bytes.toString('utf8').replace(/\0.*$/, '');
    while (offset + 512 <= archive.length) {
        const header = archive.subarray(offset, offset + 512);
        if (header.every(byte => byte === 0)) {
            if (archive.length - offset < 1024 || !archive.subarray(offset).every(byte => byte === 0)) throw fault(400, 'invalid_archive');
            return entries;
        }
        if (++count > 128) throw fault(400, 'invalid_archive');
        const checksum = header.reduce((sum, byte, i) => sum + (i >= 148 && i < 156 ? 32 : byte), 0);
        if (number(header.subarray(148, 156)) !== checksum) throw fault(400, 'invalid_archive');
        const prefix = string(header.subarray(345, 500));
        let name = (prefix ? `${prefix}/` : '') + string(header.subarray(0, 100));
        name = name.replace(/^\.\//, '');
        const size = number(header.subarray(124, 136));
        const kind = header[156]; const start = offset + 512;
        if (!Number.isSafeInteger(size) || size > MAX_BYTES || start + size > archive.length) throw fault(400, 'invalid_archive');
        offset = start + Math.ceil(size / 512) * 512;
        if (kind === 53) { // directory
            if (size || !safePath(name.replace(/\/$/, ''))) throw fault(400, 'invalid_archive');
            continue;
        }
        // No symlinks/hardlinks, device files, GNU/PAX overrides or sparse entries.
        if (kind !== 0 && kind !== 48) throw fault(400, 'invalid_archive');
        if (!safePath(name) || entries.has(name)) throw fault(400, 'invalid_archive');
        entries.set(name, archive.subarray(start, start + size));
    }
    throw fault(400, 'invalid_archive');
}
function bundleInput(input) {
    strict(input, ['sourceArchiveBase64', 'sourceCommit', 'files']);
    // Verify the actual original archive bytes, not an untrusted manifest assertion.
    const archive = decode(input.sourceArchiveBase64);
    if (input.sourceCommit !== SOURCE_COMMIT || hash(archive) !== SOURCE_SHA256) throw fault(400, 'source_mismatch');
    const sourceFiles = tarFiles(archive);
    if (!Array.isArray(input.files) || !input.files.length || input.files.length > 64) throw fault(400, 'invalid_files');
    let bytes = 0;
    const seen = new Set();
    const files = input.files.map(file => {
        strict(file, ['path', 'archivePath']);
        if (!safePath(file.path) || !TYPES[path.extname(file.path)] || seen.has(file.path)) throw fault(400, 'invalid_path');
        seen.add(file.path);
        if (!safePath(file.archivePath) || !sourceFiles.has(file.archivePath)) throw fault(400, 'invalid_source_path');
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
    res.set({ 'Cache-Control': 'private, no-store', 'CDN-Cache-Control': 'no-store', 'Surrogate-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow, noarchive', 'X-Content-Type-Options': 'nosniff' });
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
            const result = await c.query("INSERT INTO taaze_demo_shares(id,bundle_id,token_hash,created_by,request_id,expires_at) VALUES ($1,$2,$3,$4,$5,NOW() + INTERVAL '7 days') RETURNING created_at AS \"createdAt\", expires_at AS \"expiresAt\"", [id, DEMO_ID, hash(token), req.user.userId, req.body.requestId]);
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
            const result = await pool.query('SELECT a.content_type, a.body FROM taaze_demo_assets a JOIN taaze_demo_shares s ON s.bundle_id=a.bundle_id WHERE s.token_hash=$1 AND s.bundle_id=$2 AND s.revoked_at IS NULL AND s.expires_at>NOW() AND a.path=$3 LIMIT 1', [hash(token), DEMO_ID, asset]);
            if (!result.rows.length) return deny();
            const row = result.rows[0];
            res.set('Content-Security-Policy', contentPolicy(row.content_type, row.body));
            res.type(row.content_type).send(row.body);
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
