require('./helpers/mock-setup');
// Only the original-archive verifier is replaced by a synthetic archive receipt.
// Token and bundle hashing remain real. Production has no test bypass/config flag.
jest.mock('crypto', () => {
    const actual = jest.requireActual('crypto');
    return { ...actual, createHash: algorithm => {
        const real = actual.createHash(algorithm); const chunks = [];
        const wrapper = { update(value) { chunks.push(Buffer.from(value)); real.update(value); return wrapper; }, digest(encoding) {
            const input = Buffer.concat(chunks);
            if (input.includes(Buffer.from('SYNTHETIC ZIP RECEIPT'))) return '8d945ff62116e8053dc2a9c2a52ffe5aa767a78f36cc843295faa0dd0c69f34b';
            return real.digest(encoding);
        } }; return wrapper;
    } };
});
const express = require('express');
const request = require('supertest');
const { newDb } = require('pg-mem');
const { createRouters, adminWriteOrigin, SOURCE_COMMIT } = require('../../taaze-demo-share');
const base = '/api/taaze-demo-share';
const admin = call => call.set('x-test-role', 'admin');
const file = (path, archivePath = `original/dist/${path}`) => ({ path, archivePath });
function crc32(body) {
    let crc = 0xffffffff;
    for (const byte of body) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
}
function zip(entries, comment = 'SYNTHETIC ZIP RECEIPT') {
    const locals = []; const centrals = []; let offset = 0;
    for (const [name, text, options = {}] of entries) {
        const body = Buffer.from(text); const nameBytes = Buffer.from(name); const method = options.method ?? 8; const extra = options.extra || Buffer.alloc(0);
        const compressed = method === 8 ? require('zlib').deflateRawSync(body) : body; const checksum = crc32(body);
        const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(options.flags || 0, 6); local.writeUInt16LE(method, 8);
        local.writeUInt32LE(checksum, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(body.length, 22); local.writeUInt16LE(nameBytes.length, 26); local.writeUInt16LE(extra.length, 28);
        const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(0x0314, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(options.flags || 0, 8); central.writeUInt16LE(method, 10);
        central.writeUInt32LE(checksum, 16); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(body.length, 24); central.writeUInt16LE(nameBytes.length, 28); central.writeUInt16LE(extra.length, 30); central.writeUInt32LE(((options.mode ?? 0o600) << 16) >>> 0, 38); central.writeUInt32LE(offset, 42);
        locals.push(local, nameBytes, extra, compressed); centrals.push(central, nameBytes, extra); offset += local.length + nameBytes.length + extra.length + compressed.length;
    }
    const central = Buffer.concat(centrals); const end = Buffer.alloc(22); const commentBytes = Buffer.from(comment);
    end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(commentBytes.length, 20);
    return Buffer.concat([...locals, central, end, commentBytes]);
}
const syntheticEntries = () => [['original/dist/index.html', '<!doctype html><title>Synthetic archive marker</title><script src="assets/app.js"></script><script>window.syntheticInline=true;</script>', { method: 0 }], ['original/dist/assets/app.js', 'document.title="Synthetic loaded";'], ['original/dist/data/items.json', '{"items":["Synthetic item"]}'], ['original/dist/images/item.png', 'synthetic-image-bytes'], ['original/.openai/hosting.json', '{"synthetic":"private hosting metadata"}'], ['RECOVERY-RECEIPT.json', 'synthetic private receipt'], ['MANIFEST.sha256', 'synthetic private manifest']];
const fixture = () => ({ sourceCommit: SOURCE_COMMIT, sourceArchiveBase64: zip(syntheticEntries()).toString('base64'), files: ['index.html', 'assets/app.js', 'data/items.json', 'images/item.png'].map(p => file(p)) });
function setup(existing) {
    const db = newDb({ noAstCoverageCheck: true });
    db.public.registerFunction({ name: 'pg_advisory_xact_lock', args: ['integer'], returns: 'integer', implementation: () => 1 });
    const { Pool } = db.adapters.createPg(); const pool = existing === undefined ? new Pool() : existing;
    const auth = {
        authMiddleware(req, res, next) { if (!req.get('x-test-role')) return res.status(401).json({ error: 'unauthenticated' }); req.user = { userId: 'synthetic-admin' }; next(); },
        adminMiddleware(req, res, next) { if (req.get('x-test-role') !== 'admin') return res.status(403).json({ error: 'admin_required' }); next(); }
    };
    const routers = createRouters(() => pool, auth); const app = express();
    app.use('/AiHankApps/taaze-demo', routers.publicRouter); app.use(base, routers.adminRouter);
    app.use('/api/debug/taaze-demo-share', routers.debugRouter);
    app.use((_req, res) => res.status(200).send('STATIC FALLBACK MUST NOT LEAK'));
    return { app, pool, auth };
}
async function importBundle(app) { const r = await admin(request(app).post(`${base}/bundle`)).send(fixture()); expect(r.status).toBe(200); return r.body.bundle; }
async function issue(app, requestId = 'synthetic-share-0001') { const r = await admin(request(app).post(`${base}/shares`)).send({ requestId }); expect(r.status).toBe(200); return r.body.share; }

describe('revocable lasting server-checked demo shares', () => {
    test('large archive parser rejects unauthorized and cross-site requests before parsing', async () => {
        const { auth } = setup(); const app = express(); let parsed = false;
        app.post(`${base}/bundle`, auth.authMiddleware, auth.adminMiddleware, adminWriteOrigin,
            (_req, _res, next) => { parsed = true; next(); }, express.json({ limit: '6mb' }),
            (_req, res) => res.json({ success: true }));
        for (const [role, origin, fetchSite, status] of [[null, null, null, 401], ['member', null, null, 403], ['admin', 'https://evil.invalid', null, 403], ['admin', null, 'cross-site', 403]]) {
            const call = request(app).post(`${base}/bundle`).set('Content-Type', 'application/json');
            if (role) call.set('x-test-role', role); if (origin) call.set('Origin', origin); if (fetchSite) call.set('Sec-Fetch-Site', fetchSite);
            expect((await call.send('{invalid json')).status).toBe(status); expect(parsed).toBe(false);
        }
        expect((await admin(request(app).post(`${base}/bundle`)).send({ padded: 'x'.repeat(150000) })).status).toBe(200);
        expect(parsed).toBe(true);
    });
    test('debug exposes only counts to admins and is hidden in production', async () => {
        const savedNode = process.env.NODE_ENV; const savedRailway = process.env.RAILWAY_ENVIRONMENT;
        try {
            process.env.NODE_ENV = 'test'; delete process.env.RAILWAY_ENVIRONMENT;
            const { app } = setup(); await importBundle(app); await issue(app);
            expect((await request(app).get('/api/debug/taaze-demo-share')).status).toBe(401);
            expect((await request(app).get('/api/debug/taaze-demo-share').set('x-test-role', 'member')).status).toBe(403);
            const result = await admin(request(app).get('/api/debug/taaze-demo-share'));
            expect(result.body).toEqual({ success: true, counts: { assets: 4, shares: 1 } });
            process.env.NODE_ENV = 'production';
            expect((await admin(request(app).get('/api/debug/taaze-demo-share'))).status).toBe(404);
            process.env.RAILWAY_ENVIRONMENT = 'debug';
            expect((await admin(request(app).get('/api/debug/taaze-demo-share'))).body).toEqual(result.body);
        } finally {
            if (savedNode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = savedNode;
            if (savedRailway === undefined) delete process.env.RAILWAY_ENVIRONMENT; else process.env.RAILWAY_ENVIRONMENT = savedRailway;
        }
    });
    test('imports privately, issues without automatic expiry, stores only token hash and discloses URL once', async () => {
        const { app, pool } = setup(); const bundle = await importBundle(app); const share = await issue(app);
        expect(bundle.fileCount).toBe(4); expect(share.expiresAt).toBeNull();
        expect(share.path).toMatch(/^\/AiHankApps\/taaze-demo\/[A-Za-z0-9_-]{43}\/$/);
        const stored = (await pool.query('SELECT * FROM taaze_demo_shares')).rows[0];
        expect(stored.token_hash).toMatch(/^[a-f0-9]{64}$/); expect(JSON.stringify(stored)).not.toContain(share.path.split('/')[3]);
        expect(stored.expires_at).toBeNull();
        await pool.query('UPDATE taaze_demo_shares SET created_at=$1 WHERE id=$2', [new Date('2000-01-01'), share.id]);
        expect((await request(app).get(share.path + 'images/item.png')).status).toBe(200);
        const list = await admin(request(app).get(base)); expect(list.status).toBe(200); expect(JSON.stringify(list.body)).not.toMatch(/token|bodyBase64|Synthetic item/); expect(list.body.shares).toHaveLength(1);
        expect((await admin(request(app).post(`${base}/shares`)).send({ requestId: 'synthetic-share-0001' })).status).toBe(409);
        expect((await pool.query('SELECT * FROM taaze_demo_shares')).rows).toHaveLength(1);
    });
    test('anonymous HTML, data, images, script and HEAD require the same live capability', async () => {
        const { app } = setup(); await importBundle(app); const share = await issue(app);
        for (const asset of ['', 'index.html', 'assets/app.js', 'data/items.json', 'images/item.png']) {
            const r = await request(app).get(share.path + asset); expect(r.status).toBe(200);
            expect(r.headers['cache-control']).toContain('no-store'); expect(r.headers['cdn-cache-control']).toBe('no-store');
            expect(r.headers['referrer-policy']).toBe('no-referrer'); expect(r.headers['x-robots-tag']).toContain('noindex');
            expect(r.headers['content-security-policy']).toContain("form-action 'none'");
            if (!asset || asset === 'index.html') expect(r.headers['content-security-policy']).toMatch(/script-src 'self' 'sha256-[A-Za-z0-9+/]+=*'/);
            expect((await request(app).head(share.path + asset)).status).toBe(200);
            for (const bad of [`/AiHankApps/taaze-demo/${asset}`, `/AiHankApps/taaze-demo/${'x'.repeat(43)}/${asset}`]) {
                const denied = await request(app).get(bad); expect(denied.status).toBe(404); expect(denied.text).toBe('Not found');
                expect((await request(app).head(bad)).status).toBe(404);
            }
        }
    });
    test('expired and revoked links cannot read any resource or fall through static routing', async () => {
        const { app, pool } = setup(); await importBundle(app); const expired = await issue(app); const active = await issue(app, 'synthetic-share-0002');
        await pool.query('UPDATE taaze_demo_shares SET expires_at=$1 WHERE id=$2', [new Date('2000-01-01'), expired.id]);
        const revoke = await admin(request(app).post(`${base}/shares/${active.id}/revoke`)).send({}); expect(revoke.status).toBe(200);
        const retry = await admin(request(app).post(`${base}/shares/${active.id}/revoke`)).send({}); expect(retry.body).toEqual(revoke.body);
        for (const share of [expired, active]) for (const asset of ['', 'index.html', 'assets/app.js', 'data/items.json', 'images/item.png']) {
            const r = await request(app).get(share.path + asset); expect(r.status).toBe(404); expect(r.text).toBe('Not found'); expect(r.headers['cache-control']).toContain('no-store');
            expect((await request(app).head(share.path + asset)).status).toBe(404);
        }
    });
    test('admin operations reject anonymous, members, cross-origin writes and forged metadata', async () => {
        const { app } = setup();
        for (const [method, route, body] of [['get', base, null], ['post', `${base}/bundle`, fixture()], ['post', `${base}/shares`, { requestId: 'synthetic-share-0001' }], ['post', `${base}/shares/${'a'.repeat(36)}/revoke`, {}]]) {
            expect((await request(app)[method](route).send(body)).status).toBe(401);
            expect((await request(app)[method](route).set('x-test-role', 'member').send(body)).status).toBe(403);
            if (method === 'post') expect((await admin(request(app)[method](route)).set('Origin', 'https://evil.invalid').send(body)).status).toBe(403);
        }
        expect((await admin(request(app).post(`${base}/shares`)).send({ requestId: 'synthetic-share-0001' })).status).toBe(409);
        await importBundle(app);
        for (const body of [{ requestId: 'synthetic-share-0001', expiresAt: '2099-01-01' }, { requestId: 'synthetic-share-0001', bundleId: 'another' }, { requestId: 'synthetic-share-0001', token: 'forged' }, {}]) expect((await admin(request(app).post(`${base}/shares`)).send(body)).status).toBe(400);
    });
    test('verifies archive bytes and rejects unrelated bundles, oversized/invalid files and traversal', async () => {
        const { app } = setup();
        const invalid = [ { ...fixture(), sourceCommit: 'unrelated' }, { ...fixture(), sourceArchiveBase64: Buffer.from('wrong archive').toString('base64') }, { ...fixture(), files: [file('../index.html')] }, { ...fixture(), files: [file('/index.html')] }, { ...fixture(), files: [file('index.html'), file('credentials.env')] }, { ...fixture(), files: [file('index.html'), file('index.html')] }, { ...fixture(), files: [file('assets/app.js')] }, { ...fixture(), files: [file('index.html', 'unrelated.html')] }, { ...fixture(), files: [{ path: 'index.html', bodyBase64: 'dW5yZWxhdGVk' }] } ];
        for (const body of invalid) expect((await admin(request(app).post(`${base}/bundle`)).send(body)).status).toBe(400);
        const bundle = await importBundle(app); expect((await admin(request(app).post(`${base}/bundle`)).send(fixture())).body.bundle).toEqual(bundle);
        const changed = syntheticEntries(); changed[1][1] = 'different synthetic bytes';
        expect((await admin(request(app).post(`${base}/bundle`)).send({ ...fixture(), sourceArchiveBase64: zip(changed).toString('base64') })).status).toBe(409);
        const share = await issue(app);
        for (const asset of ['%2e%2e%2fsecret', 'assets%2f..%2findex.html', '%252e%252e%252fsecret', 'missing.json', 'images%5citem.png']) expect((await request(app).get(share.path + asset)).status).toBe(404);
        expect((await request(app).post(share.path).send({})).status).toBe(404);
    });
    test('ZIP auto-selection preserves original bytes and excludes hosting, receipt and manifest even on explicit requests', async () => {
        const { app, pool } = setup(); const input = fixture(); delete input.files;
        const result = await admin(request(app).post(`${base}/bundle`)).send(input); expect(result.status).toBe(200); expect(result.body.bundle.fileCount).toBe(4);
        const stored = await pool.query('SELECT path, body FROM taaze_demo_assets');
        for (const [name, body] of syntheticEntries().filter(([name]) => name.startsWith('original/dist/'))) expect(stored.rows.find(row => row.path === name.slice('original/dist/'.length)).body).toEqual(Buffer.from(body));
        const share = await issue(app);
        for (const name of ['original/.openai/hosting.json', '.openai/hosting.json', 'RECOVERY-RECEIPT.json', 'MANIFEST.sha256', 'README.txt']) expect((await request(app).get(share.path + name)).status).toBe(404);
        for (const forbidden of ['original/.openai/hosting.json', 'RECOVERY-RECEIPT.json', 'MANIFEST.sha256']) {
            const body = fixture(); body.files[1] = file('assets/app.js', forbidden);
            expect((await admin(request(app).post(`${base}/bundle`)).send(body)).status).toBe(400);
        }
        const renamed = fixture(); renamed.files[1].path = 'renamed.js';
        expect((await admin(request(app).post(`${base}/bundle`)).send(renamed)).status).toBe(400);
        const csp = (await request(app).get(share.path)).headers['content-security-policy'];
        expect(csp).toContain("img-src 'self' data:;"); expect(csp).not.toContain('openstreetmap'); expect(csp).not.toContain('unsafe-eval'); expect(csp).not.toContain('https:;');
    });
    test('rejects ZIP CRC damage, symlinks/special files, traversal, duplicates, encryption, descriptors and decompression overflow', async () => {
        const { app } = setup();
        const inputs = [zip([['original/dist/index.html', 'link', { mode: 0o120777 }]]), zip([['original/dist/index.html', 'device', { mode: 0o020600 }]]), zip([['original/dist/../index.html', 'bad']]), zip([['original/dist/index.html', 'one'], ['original/dist/index.html', 'two']]), zip([['original/dist/index.html', 'encrypted', { flags: 1 }]]), zip([['original/dist/index.html', 'descriptor', { flags: 8 }]]), zip([['original/dist/index.html', 'x'.repeat(2 * 1024 * 1024 + 1)]])];
        const damaged = Buffer.from(fixture().sourceArchiveBase64, 'base64'); damaged[30 + damaged.readUInt16LE(26)] ^= 1; inputs.push(damaged);
        for (const archive of inputs) {
            const r = await admin(request(app).post(`${base}/bundle`)).send({ ...fixture(), sourceArchiveBase64: archive.toString('base64') });
            expect(r.status).toBe(400); expect(r.body.error).toBe('invalid_archive');
        }
    });
    test('rejects local/central mismatch, malformed EOCD/central bounds, overlaps, ZIP64 and unsupported methods', async () => {
        const { app } = setup();
        const initial = Buffer.from(fixture().sourceArchiveBase64, 'base64');
        const end = initial.length - 22 - Buffer.byteLength('SYNTHETIC ZIP RECEIPT'); const central = initial.readUInt32LE(end + 16);
        const inputs = [];
        for (const [position, change] of [[6, 1], [8, 7], [10, 1], [14, 1], [18, 1], [22, 1], [30, 1], [end + 4, 1], [end + 8, 1], [end + 12, 1], [end + 16, 1], [central + 6, 45], [central + 10, 99], [central + 42, 1]]) {
            const changed = Buffer.from(initial); changed[position] ^= change; inputs.push(changed);
        }
        const overflow = Buffer.from(initial); overflow.writeUInt32LE(2 * 1024 * 1024 + 1, central + 24); inputs.push(overflow);
        // Invalid raw DEFLATE with matching metadata still cannot produce a resource.
        const deflated = zip([['original/dist/index.html', 'some deflated content']]); deflated[30 + deflated.readUInt16LE(26)] = 255; inputs.push(deflated);
        const bomb = zip([['original/dist/index.html', 'x'.repeat(10000)]]); const bombEnd = bomb.length - 22 - Buffer.byteLength('SYNTHETIC ZIP RECEIPT'); const bombCentral = bomb.readUInt32LE(bombEnd + 16);
        bomb.writeUInt32LE(4, 22); bomb.writeUInt32LE(4, bombCentral + 24); inputs.push(bomb);
        for (const extra of [Buffer.from([1, 0, 0, 0]), Buffer.from([0x75, 0x70, 0, 0]), Buffer.from([0x01, 0x99, 0, 0]), Buffer.from([0x55, 0x54, 9, 0])]) inputs.push(zip([['original/dist/index.html', 'content', { extra }]]));
        for (const archive of inputs) {
            const r = await admin(request(app).post(`${base}/bundle`)).send({ ...fixture(), sourceArchiveBase64: archive.toString('base64') });
            expect(r.status).toBe(400); expect(r.body.error).toBe('invalid_archive');
        }
    });
    test('links, assets and revocation survive a router restart; unavailable database fails closed', async () => {
        const first = setup(); await importBundle(first.app); const share = await issue(first.app);
        const second = setup(first.pool); expect((await request(second.app).get(share.path + 'data/items.json')).body.items).toEqual(['Synthetic item']);
        await admin(request(second.app).post(`${base}/shares/${share.id}/revoke`)).send({});
        expect((await request(setup(first.pool).app).get(share.path)).status).toBe(404);
        const unavailable = setup(null); expect((await admin(request(unavailable.app).get(base))).status).toBe(503);
        expect((await request(unavailable.app).get(share.path)).status).toBe(404);
    });
});

const realPg = process.env.TAAZE_DEMO_TEST_PG === '1' ? test : test.skip;
realPg('PostgreSQL transactions, concurrent duplicate issue and new-pool persistence', async () => {
    const { Pool } = jest.requireActual('pg');
    const config = { host: '127.0.0.1', port: 55414, database: 'postgres', user: 'progress_test', connectionTimeoutMillis: 2000 };
    const schemaName = `taaze_demo_test_${require('crypto').randomBytes(8).toString('hex')}`;
    const control = new Pool(config); let pool; let secondPool;
    try {
        await control.query(`CREATE SCHEMA ${schemaName}`);
        pool = new Pool({ ...config, options: `-c search_path=${schemaName}` });
        const first = setup(pool); await importBundle(first.app);
        const requests = await Promise.all([1, 2].map(() => admin(request(first.app).post(`${base}/shares`)).send({ requestId: 'synthetic-concurrent-share' })));
        expect(requests.map(r => r.status).sort()).toEqual([200, 409]);
        const share = requests.find(r => r.status === 200).body.share;
        expect((await pool.query('SELECT * FROM taaze_demo_shares')).rows).toHaveLength(1);
        const trueClicks = await Promise.all([1, 2].map(i => admin(request(first.app).post(`${base}/shares`)).send({ requestId: `synthetic-different-share-${i}` })));
        expect(trueClicks.map(r => r.status)).toEqual([200, 200]);
        await pool.end(); pool = null;
        secondPool = new Pool({ ...config, options: `-c search_path=${schemaName}` });
        const second = setup(secondPool);
        expect((await request(second.app).get(share.path + 'data/items.json')).body.items).toEqual(['Synthetic item']);
        expect((await admin(request(second.app).get(base))).body.shares).toHaveLength(3);
        await admin(request(second.app).post(`${base}/shares/${share.id}/revoke`)).send({});
        expect((await request(second.app).get(share.path + 'images/item.png')).status).toBe(404);
        // A mid-import database failure rolls back bundle metadata AND preceding assets.
        await secondPool.query('DELETE FROM taaze_demo_shares'); await secondPool.query('DELETE FROM taaze_demo_assets'); await secondPool.query('DELETE FROM taaze_demo_bundles');
        const failing = { connect: async () => {
            const c = await secondPool.connect(); const query = c.query.bind(c); let inserts = 0;
            return { release: () => c.release(), query: (sql, params) => {
                if (sql.startsWith('INSERT INTO taaze_demo_assets') && ++inserts === 2) return Promise.reject(new Error('synthetic database failure'));
                return query(sql, params);
            } };
        } };
        const result = await admin(request(setup(failing).app).post(`${base}/bundle`)).send(fixture()); expect(result.status).toBe(503);
        expect((await secondPool.query('SELECT * FROM taaze_demo_bundles')).rows).toHaveLength(0);
        expect((await secondPool.query('SELECT * FROM taaze_demo_assets')).rows).toHaveLength(0);
    } finally {
        if (pool) await pool.end(); if (secondPool) await secondPool.end();
        await control.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`); await control.end();
    }
});
