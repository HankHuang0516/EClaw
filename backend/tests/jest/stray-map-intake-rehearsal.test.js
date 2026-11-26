require('./helpers/mock-setup');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const r = require('../../../tools/stray-map-intake/rehearsal');
const f = require('../../../tools/stray-map-intake/synthetic-fixtures');
const checks = Object.fromEntries(r.CHECKS.map(key => [key, true]));
let directory, store, clock, servers;
const accept = (body = f.taiwan(), key = 'synthetic_key_001') => store.accept(JSON.stringify(body), key);
const server = async handler => { const s = await r.startLoopback(handler); servers.push(s); return s; };
const feed = records => server((req, res) => {
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ synthetic: true, records }));
});
beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stray-intake-rehearsal-'));
    clock = f.SUBMITTED; servers = [];
    store = new r.RehearsalStore(directory, { sourcePolicy: f.policy, sourcePolicies: [f.policy, f.peerPolicy],
        uploads: [f.photoFixture().upload], now: () => clock });
});
afterEach(async () => { await Promise.all(servers.map(s => s.close())); store.close(); fs.rmSync(directory, { recursive: true, force: true }); });

test('scheduled HTTP receive persists pending receipts, throttles polls and replays after reopen', async () => {
    const source = await feed([f.washington(), f.photoFixture().body]);
    let receiver = await r.startReceiver(store); servers.push(receiver);
    const pass = () => r.scheduledPass({ store, sourceURL: source.url, receiverURL: receiver.url });
    const first = await pass(); expect(first.results.map(x => x.status)).toEqual([202, 202]);
    const receipts = first.results.map(x => x.body.receipt);
    expect((await r.readJSON(`${receiver.url}/public/tips`)).body.items).toEqual([]);
    expect((await pass()).skipped).toBe(true);
    await receiver.close(); servers.splice(servers.indexOf(receiver), 1);
    store.close(); store = new r.RehearsalStore(directory, { sourcePolicy: f.policy, sourcePolicies: [f.policy, f.peerPolicy], uploads: [f.photoFixture().upload], now: () => clock });
    receiver = await r.startReceiver(store); servers.push(receiver);
    expect((await pass()).skipped).toBe(true);
    clock = '2026-11-26T12:15:00.000Z';
    const second = await pass(); expect(second.results.map(x => x.body.receipt)).toEqual(receipts);
    expect(second.results.every(x => x.body.replay)).toBe(true);
    expect(Object.keys(store.state.receipts)).toHaveLength(2);
});
test('same dataset key with new request key reuses receipt; changed data conflicts', () => {
    const first = accept(); expect(accept(f.taiwan(), 'synthetic_key_002').receipt).toEqual(first.receipt);
    const changed = f.taiwan(); changed.display.title = '不同內容';
    expect(accept(changed, 'synthetic_key_003').error).toBe('SOURCE_RECORD_CONFLICT');
    expect(accept(changed).error).toBe('IDEMPOTENCY_CONFLICT');
});
test('coarse candidates remain independent; cross-source duplicate requires an explicit review', () => {
    const a = f.washington(), b = f.clone(a), peer = f.clone(a);
    b.source.recordKey = 'private_synthetic_wa_002'; b.display.title = 'A different synthetic dog';
    peer.source.publisherId = f.peerPolicy.publisherId; peer.source.datasetId = f.peerPolicy.datasetId;
    const first = accept(a), second = accept(b, 'synthetic_key_002'), third = accept(peer);
    expect(new Set([first.receipt.tipId, second.receipt.tipId, third.receipt.tipId]).size).toBe(3);
    expect(store.state.receipts[second.receipt.tipId].candidates).toContain(first.receipt.tipId);
    expect(store.state.receipts[third.receipt.tipId].candidates).toContain(first.receipt.tipId);
    expect(store.review(third.receipt.tipId, 'DUPLICATE', {}, first.receipt.tipId).review.publicVisible).toBe(false);
    for (const item of [first, second]) expect(store.review(item.receipt.tipId, 'APPROVE', checks).success).toBe(true);
    expect(store.publicList().items).toHaveLength(2);
});
test('anonymous approved projection preserves local text/date and excludes private stable keys', async () => {
    const wa = accept(f.washington()), tw = accept(f.photoFixture().body, 'synthetic_key_002');
    expect(store.review(wa.receipt.tipId, 'APPROVE').error).toBe('REVIEW_CHECKS_REQUIRED');
    expect(store.publicList().items).toEqual([]);
    for (const item of [wa, tw]) store.review(item.receipt.tipId, 'APPROVE', checks);
    const receiver = await r.startReceiver(store); servers.push(receiver);
    const data = (await r.readJSON(`${receiver.url}/public/tips`)).body;
    expect(data.items[0].observation).toEqual(f.washington().observation);
    expect(data.items[0].display).toEqual(f.washington().display);
    expect(data.items[1].display.locale).toBe('zh-TW'); expect(data.items[1].photos[0].caption).toBe(f.photoFixture().body.photos[0].caption);
    for (const secret of ['recordKey', 'datasetId', 'publisherId', 'evidenceRef', 'attributionRef', 'sourceUrl', 'latitude', 'longitude']) expect(JSON.stringify(data)).not.toContain(secret);
    store.review(tw.receipt.tipId, 'WITHDRAW'); expect(store.publicList().items).toHaveLength(1);
    expect(accept(f.photoFixture().body, 'synthetic_key_002').receipt).toEqual(tw.receipt);
});
test.each(['WILDLIFE', 'NEST', 'HABITAT', 'PROTECTED_SPECIES', 'UNKNOWN'])('even approved sensitive case %s stays private', kind => {
    const body = f.taiwan(); if (kind === 'WILDLIFE') body.animal.kind = kind; else body.location.sensitivity = kind;
    const received = accept(body); expect(received.success).toBe(true);
    expect(store.review(received.receipt.tipId, 'APPROVE', checks).review.status).toBe('APPROVED_PRIVATE');
    expect(store.publicList().items).toEqual([]);
});
test('rejected and withdrawn leads cannot later be approved', () => {
    const id = accept().receipt.tipId; store.review(id, 'REJECT');
    expect(store.review(id, 'APPROVE', checks).status).toBe(409); expect(store.publicList().items).toEqual([]);
    store.review(id, 'WITHDRAW'); expect(store.receipt(id).review.status).toBe('WITHDRAWN');
});
test('rights revoked between acceptance and approval fail closed', () => {
    const id = accept(f.photoFixture().body).receipt.tipId;
    store.uploads[0].reuseConsentVerified = false;
    expect(store.review(id, 'APPROVE', checks).error).toBe('REVIEW_EVIDENCE_INVALID');
    expect(store.receipt(id).review.status).toBe('PENDING'); expect(store.publicList().items).toEqual([]);
});
test('HTTP rejects unlicensed photos, oversized JSON, non-JSON and review mutations', async () => {
    const receiver = await r.startReceiver(store); servers.push(receiver);
    const b = f.photoFixture().body; b.photos[0].rights.license = 'PUBLICLY_VISIBLE';
    const post = (body, contentType = 'application/json') => r.readJSON(`${receiver.url}/synthetic/tips`, { method: 'POST', headers: { 'Content-Type': contentType, 'Idempotency-Key': 'synthetic_key_001' }, body });
    expect((await post(JSON.stringify(b))).body.error).toBe('PHOTO_RIGHTS_REQUIRED');
    expect((await post(' '.repeat(16385))).status).toBe(413);
    expect((await post(JSON.stringify(f.taiwan()), 'text/html')).status).toBe(415);
    expect((await r.readJSON(`${receiver.url}/reviews`, { method: 'POST', body: '{}' })).status).toBe(404);
    expect(Object.keys(store.state.receipts)).toHaveLength(0);
});
test('parallel replay requests reserve a single receipt', async () => {
    const receiver = await r.startReceiver(store); servers.push(receiver);
    const results = await Promise.all(Array.from({ length: 20 }, () => r.readJSON(`${receiver.url}/synthetic/tips`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'synthetic_key_001' }, body: JSON.stringify(f.taiwan()) })));
    expect(new Set(results.map(x => x.body.receipt.tipId)).size).toBe(1);
    expect(Object.keys(store.state.receipts)).toHaveLength(1);
});
test('source quota persists and replays do not consume it', () => {
    const first = accept();
    for (let n = 1; n < 10; n++) { const b = f.taiwan(); b.source.recordKey += n; expect(accept(b, `synthetic_key_${String(n).padStart(3, '0')}x`).status).toBe(202); }
    const extra = f.taiwan(); extra.source.recordKey += '_extra'; expect(accept(extra, 'synthetic_key_extra').status).toBe(429);
    expect(accept().receipt).toEqual(first.receipt);
});
test('HTML/outage/source redirects never produce a tip and next poll stays bounded', async () => {
    const source = await server((req, res) => { res.writeHead(503, { 'Content-Type': 'text/html' }); res.end('<p>unavailable</p>'); });
    const receiver = await r.startReceiver(store); servers.push(receiver);
    await expect(r.scheduledPass({ store, sourceURL: source.url, receiverURL: receiver.url })).rejects.toThrow('SOURCE_NOT_JSON');
    expect((await r.scheduledPass({ store, sourceURL: source.url, receiverURL: receiver.url })).skipped).toBe(true);
    expect(Object.keys(store.state.receipts)).toHaveLength(0);
    await expect(r.readJSON('https://api-production-8bc1.up.railway.app')).rejects.toThrow('SYNTHETIC_LOOPBACK_ONLY');
});
test('single writer and process restart retain committed receipt on disk', () => {
    expect(() => new r.RehearsalStore(directory, { sourcePolicy: f.policy })).toThrow();
    const first = accept().receipt; store.close();
    const modulePath = path.resolve(__dirname, '../../../tools/stray-map-intake/rehearsal.js');
    const fixturePath = path.resolve(__dirname, '../../../tools/stray-map-intake/synthetic-fixtures.js');
    const code = `const r=require(process.argv[1]),f=require(process.argv[2]);const s=new r.RehearsalStore(process.argv[3],{sourcePolicy:f.policy,now:()=>f.SUBMITTED});try{process.stdout.write(JSON.stringify(s.accept(JSON.stringify(f.taiwan()),'synthetic_key_001').receipt))}finally{s.close()}`;
    const second = JSON.parse(execFileSync(process.execPath, ['-e', code, modulePath, fixturePath, directory], { encoding: 'utf8' }));
    expect(second).toEqual(first);
    expect(fs.statSync(path.join(directory, 'synthetic-intake-state.json')).mode & 0o777).toBe(0o600);
});

test('a closed writer cannot replay or mutate after ownership is released', () => {
    accept(); store.close(); expect(accept().status).toBe(503);
    expect(store.review(Object.keys(store.state.receipts)[0], 'APPROVE', checks).status).toBe(503);
});

test('lost HTTP response after durable commit retries once with the same receipt', async () => {
    const source = await feed([f.taiwan()]); let posts = 0;
    const receiver = await server(async (req, res) => {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const result = store.accept(Buffer.concat(chunks), req.headers['idempotency-key']); posts++;
        if (posts === 1) { res.destroy(); return; }
        res.writeHead(result.status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result));
    });
    const pass = await r.scheduledPass({ store, sourceURL: source.url, receiverURL: receiver.url });
    expect(posts).toBe(2); expect(pass.results[0].body.replay).toBe(true);
    expect(Object.keys(store.state.receipts)).toEqual([pass.results[0].body.receipt.tipId]);
});

test('receipt body interruption after response headers retries the committed request', async () => {
    const source = await feed([f.taiwan()]); let posts = 0;
    const receiver = await server(async (req, res) => {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const result = store.accept(Buffer.concat(chunks), req.headers['idempotency-key']); posts++;
        res.writeHead(202, { 'Content-Type': 'application/json' });
        if (posts === 1) { res.flushHeaders(); res.write('{"success":'); setTimeout(() => res.destroy(), 20); return; }
        res.end(JSON.stringify(result));
    });
    const pass = await r.scheduledPass({ store, sourceURL: source.url, receiverURL: receiver.url });
    expect(posts).toBe(2); expect(pass.results[0].body.replay).toBe(true);
    expect(Object.keys(store.state.receipts)).toHaveLength(1);
});

test('an unregistered local tunnel cannot become a synthetic source', async () => {
    await expect(r.readJSON('http://127.0.0.1:12345/private')).rejects.toThrow('SYNTHETIC_LOOPBACK_ONLY');
});
