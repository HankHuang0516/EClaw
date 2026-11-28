require('./helpers/mock-setup');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Pool } = require('pg');
const { PendingService, checks, digest } = require('../../../tools/stray-map-rebuild/pending-service.cjs');
const f = require('../../../tools/stray-map-intake/synthetic-fixtures');
const c = require('../../../tools/stray-map-intake/case-fixtures');
const { validateTip } = require('../../../tools/stray-map-intake/contract');
const { cleanEnv } = require('../../../tools/stray-map-rebuild/integration.cjs');
const guard = path.resolve(__dirname, '../../../tools/stray-map-rebuild/loopback-guard.cjs');
function setup(options = {}) {
    const pool = new Pool();
    const client = { query: jest.fn().mockResolvedValue({ rows: [] }), release: jest.fn() };
    pool.connect.mockResolvedValue(client);
    const service = new PendingService({ pool, sourcePolicies: [f.policy, f.peerPolicy], now: () => f.SUBMITTED, ...options });
    return { pool, client, service };
}
const raw = tip => Buffer.from(JSON.stringify(tip));
function storedRow(tip, uploads = []) {
    const valid = validateTip(raw(tip), { submittedAt: f.SUBMITTED, sourcePolicy: f.policy, verifiedUploads: uploads });
    expect(valid.success).toBe(true);
    return { review: 'PENDING', map_policy: valid.review.mapPolicy, payload: valid.canonicalPayload,
        payload_hash: valid.payloadHash, publisher: f.policy.publisherId, dataset: f.policy.datasetId };
}
describe('synthetic-only pending adapter with shared mocked pg shape', () => {
    test.each([[], [{ ...f.policy, verified: false }], [{ ...f.policy, publisherId: 'real-publisher' }],
        [{ ...f.policy, origin: 'https://public.example.com' }]].map(sourcePolicies => ({ sourcePolicies })))('rejects non-synthetic policy $sourcePolicies', ({ sourcePolicies }) => {
        expect(() => setup({ sourcePolicies })).toThrow('SYNTHETIC_POLICIES_ONLY');
    });
    test.each([null, [], 'short', 'x'.repeat(129)])('rejects retry key %j before database use', async key => {
        const { service, pool } = setup();
        expect(await service.accept(raw(c.caseTip('SIGHTING')), key)).toMatchObject({ success: false, error: 'INVALID_IDEMPOTENCY_KEY' });
        expect(pool.query).not.toHaveBeenCalled(); expect(pool.connect).not.toHaveBeenCalled();
    });
    test('oversized JSON cannot reach upload lookup or transaction', async () => {
        const { service, pool } = setup();
        expect(await service.accept(Buffer.alloc(16385), 'synthetic_request_001')).toMatchObject({ status: 413 });
        expect(pool.query).not.toHaveBeenCalled();
    });
    test('self-declared hash and synthetic flag cannot authorize unregistered pixels', async () => {
        const { service, pool } = setup(), bytes = Buffer.from('89504e470d0a1a0a', 'hex'), storage = { putImage: jest.fn() };
        const grant = { synthetic: true, license: 'EXPLICIT_PERMISSION', context: c.caseTip('SIGHTING').source, originalHash: digest(bytes) };
        expect(await service.addSyntheticPhoto(bytes, 'image/png', grant, storage)).toMatchObject({ status: 403 });
        expect(storage.putImage).not.toHaveBeenCalled(); expect(pool.query).not.toHaveBeenCalled();
    });
    test('wrong MIME fails before any storage write', async () => {
        const bytes = Buffer.from('89504e470d0a1a0a', 'hex'), { service } = setup({ knownSyntheticPixelHashes: [digest(bytes)] });
        const storage = { putImage: jest.fn() }, grant = { synthetic: true, license: 'EXPLICIT_PERMISSION', context: c.caseTip('SIGHTING').source, originalHash: digest(bytes) };
        expect(await service.addSyntheticPhoto(bytes, 'image/jpeg', grant, storage)).toMatchObject({ status: 415 });
        expect(storage.putImage).not.toHaveBeenCalled();
    });
    test('failed insert rolls back and never returns an uncommitted receipt', async () => {
        const { service, client } = setup();
        client.query.mockImplementation(async sql => {
            if (sql.includes('count(*)')) return { rows: [{ n: 0 }] };
            if (sql.startsWith('INSERT INTO rebuild_external.tips')) throw Error('synthetic outage');
            return { rows: [] };
        });
        await expect(service.accept(raw(c.caseTip('SIGHTING')), 'synthetic_request_001')).rejects.toThrow('synthetic outage');
        expect(client.query).toHaveBeenCalledWith('ROLLBACK');
        expect(client.query).not.toHaveBeenCalledWith('COMMIT'); expect(client.release).toHaveBeenCalled();
    });
    test('first acknowledgement uses database receipt representation only after commit', async () => {
        const { service, client } = setup(); let stored;
        client.query.mockImplementation(async (sql, args) => {
            if (sql.includes('count(*)')) return { rows: [{ n: 0 }] };
            if (sql.startsWith('INSERT INTO rebuild_external.tips')) {
                stored = Object.fromEntries(Object.entries(args[6]).reverse()); return { rows: [{ receipt: stored }] };
            }
            return { rows: [] };
        });
        const accepted = await service.accept(raw(c.caseTip('SIGHTING')), 'synthetic_request_001');
        expect(accepted.receipt).toBe(stored); expect(accepted.status).toBe(202);
        expect(client.query.mock.calls.at(-1)).toEqual(['COMMIT']);
        expect(client.query.mock.calls.some(([sql]) => /INSERT INTO (animals|devices)/.test(sql))).toBe(false);
    });
    test('missing review checks cannot update the pending row', async () => {
        const { service, client } = setup();
        client.query.mockImplementation(async sql => ({ rows: sql.includes('FOR UPDATE') ? [{ review: 'PENDING', map_policy: 'COARSE_ONLY' }] : [] }));
        expect(await service.decide('tip_synthetic001', 'APPROVE', {})).toMatchObject({ status: 403 });
        expect(client.query).toHaveBeenCalledWith('ROLLBACK');
        expect(client.query.mock.calls.some(([sql]) => sql.startsWith('UPDATE'))).toBe(false);
    });
    test('sensitive location remains private even with all review checks', async () => {
        const { service, client } = setup();
        const tip=c.caseTip('SIGHTING');tip.animal.kind='WILDLIFE';tip.location.sensitivity='HABITAT';const row=storedRow(tip);
        client.query.mockImplementation(async sql => ({ rows: sql.includes('FOR UPDATE') ? [row] : [] }));
        expect(await service.decide('tip_synthetic001', 'APPROVE', Object.fromEntries(checks.map(k => [k, true])))).toMatchObject({ status: 'APPROVED_PRIVATE', publicVisible: false });
        expect(client.query).toHaveBeenCalledWith('UPDATE rebuild_external.tips SET review=$2 WHERE id=$1', ['tip_synthetic001', 'APPROVED_PRIVATE']);
    });
    test('revoked source permission cannot be approved after receipt acceptance', async () => {
        const policy={...f.policy}, { service, client }=setup({sourcePolicies:[policy]}), row=storedRow(c.caseTip('SIGHTING'));
        policy.verified=false;
        client.query.mockImplementation(async sql=>({rows:sql.includes('FOR UPDATE')?[row]:[]}));
        expect(await service.decide('tip_synthetic001','APPROVE',Object.fromEntries(checks.map(k=>[k,true])))).toMatchObject({status:403,error:'REVIEW_EVIDENCE_INVALID'});
        expect(client.query).toHaveBeenCalledWith('ROLLBACK');
        expect(client.query.mock.calls.some(([sql])=>sql.startsWith('UPDATE'))).toBe(false);
    });
    test('removed photo proof cannot be approved even when all manual checks are true', async () => {
        const fixture=f.photoFixture(), row=storedRow(fixture.body,[fixture.upload]), {service,client}=setup();
        client.query.mockImplementation(async sql=>({rows:sql.includes('FOR UPDATE')?[row]:[]}));
        expect(await service.decide('tip_synthetic001','APPROVE',Object.fromEntries(checks.map(k=>[k,true])))).toMatchObject({status:403,error:'REVIEW_EVIDENCE_INVALID'});
        expect(client.query).toHaveBeenCalledWith('ROLLBACK');
        expect(client.query.mock.calls.some(([sql])=>sql.startsWith('UPDATE'))).toBe(false);
    });
    test('runtime environment does not inherit real HOME, temp paths or credentials',()=>{
        const env=cleanEnv({HOME:'/synthetic/private-empty-home',TMPDIR:'/synthetic/private-tmp'});
        expect(env.HOME).toBe('/synthetic/private-empty-home');expect(env.TMPDIR).toBe('/synthetic/private-tmp');
        expect(cleanEnv({}).HOME).toBeUndefined();expect(cleanEnv({}).TMPDIR).toBeUndefined();
        expect(env.JWT_SECRET).toBeUndefined();expect(env.NODE_OPTIONS).toBeUndefined();expect(env.DATABASE_URL).toBeUndefined();
    });
    test.each(['REJECTED', 'WITHDRAWN'])('%s cannot become public on approval replay', async review => {
        const { service, client } = setup();
        client.query.mockImplementation(async sql => ({ rows: sql.includes('FOR UPDATE') ? [{ review, map_policy: 'COARSE_ONLY' }] : [] }));
        expect(await service.decide('tip_synthetic001', 'APPROVE', Object.fromEntries(checks.map(k => [k, true])))).toMatchObject({ status: 409 });
        expect(client.query.mock.calls.some(([sql]) => sql.startsWith('UPDATE'))).toBe(false);
    });
    test('tip and photo SQL enforce approval and safe location policy', async () => {
        const { service, pool } = setup();
        expect(await service.publicTip('tip_synthetic001')).toMatchObject({ status: 404 });
        expect(await service.publicPhoto('up_synthetic001')).toBeNull();
        for (const [sql] of pool.query.mock.calls) { expect(sql).toContain("review='APPROVED'"); expect(sql).toContain("map_policy!='NEVER'"); }
    });
});
function child(source) {
    return execFileSync(process.execPath, ['--require', guard, '-e', source], { encoding: 'utf8', timeout: 5000,
        env: { PATH: process.env.PATH, STRAY_REBUILD_SYNTHETIC: '1', STRAY_REBUILD_PORTS: '5432' } }).trim();
}
describe('real source-process preload', () => {
    test('remote TCP, wrong loopback port and unix socket fail before connection', () => {
        expect(child(`const net=require('node:net');for(const opts of [{host:'public.example.invalid',port:443},{host:'127.0.0.1',port:5433},{path:'/tmp/forbidden.sock'}]){try{net.connect(opts);throw Error('NOT_BLOCKED')}catch(e){if(e.message!=='ISOLATED_EGRESS_BLOCKED')throw e}}console.log('blocked')`)).toBe('blocked');
    });
    test('dotenv file access fails before any file is opened', () => {
        expect(child(`try{require('node:fs').readFileSync('/nonexistent/.env.production');throw Error('NOT_BLOCKED')}catch(e){if(e.message!=='ISOLATED_ENV_FILE_BLOCKED')throw e}console.log('blocked')`)).toBe('blocked');
    });
    test('encoded file URLs are normalized before dotenv checks',()=>{
        expect(child(`try{require('node:fs').readFileSync(new URL('file:///nonexistent/%2Eenv'));throw Error('NOT_BLOCKED')}catch(e){if(e.message!=='ISOLATED_ENV_FILE_BLOCKED')throw e}console.log('blocked')`)).toBe('blocked');
    });
    test('promise and ESM named reads cannot bypass dotenv guard',()=>{
        expect(child(`(async()=>{for(const fs of [require('node:fs/promises'),await import('node:fs/promises')]){try{await fs.readFile(new URL('file:///nonexistent/%2Eenv'));throw Error('NOT_BLOCKED')}catch(e){if(e.message!=='ISOLATED_ENV_FILE_BLOCKED')throw e}}console.log('blocked')})().catch(e=>{console.error(e);process.exitCode=1})`)).toBe('blocked');
    });
    test('callback reads cannot bypass dotenv guard',()=>{
        expect(child(`require('node:fs').readFile(new URL('file:///nonexistent/%2Eenv'),e=>{if(e?.message!=='ISOLATED_ENV_FILE_BLOCKED')throw Error('NOT_BLOCKED');console.log('blocked')})`)).toBe('blocked');
    });
    test('custom DNS lookup cannot turn localhost into a remote destination',()=>{
        expect(child(`try{require('node:net').connect({host:'localhost',port:5432,lookup:()=>{throw Error('LOOKUP_EXECUTED')}});throw Error('NOT_BLOCKED')}catch(e){if(e.message!=='ISOLATED_EGRESS_BLOCKED')throw e}console.log('blocked')`)).toBe('blocked');
    });
    test('remote fetch fails before DNS', () => {
        expect(child(`try{fetch('https://public.example.invalid/image.jpg');throw Error('NOT_BLOCKED')}catch(e){if(e.message!=='ISOLATED_FETCH_BLOCKED')throw e}console.log('blocked')`)).toBe('blocked');
    });
    test('wildcard source listener is forced to loopback', () => {
        expect(child(`const s=require('node:net').createServer();s.listen({port:0,host:'0.0.0.0'},()=>{console.log(s.address().address);s.close()})`)).toBe('127.0.0.1');
    });
});
