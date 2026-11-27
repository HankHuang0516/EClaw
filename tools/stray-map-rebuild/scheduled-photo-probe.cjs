'use strict';

// Runs in the existing Linux QA image with a disposable PostGIS container on an internal network.
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { mkdtemp, rm } = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { PendingService, digest, checks } = require('./pending-service.cjs');
const { selfMadeProof } = require('./photo-rights.cjs');
const { prepare } = require('../stray-map-pilot/dot-submit.cjs');
const { scheduledIntakeTick, INTERVAL_MS } = require('../stray-map-pilot/scheduled-intake-rehearsal.cjs');

const DSN = 'postgresql://postgres:fixture-local-only@fixture.railway.internal:5432/stray_photo_schedule_fixture';
const scope = {
    verified: true, publisherId: 'synthetic-photo-patrol', datasetId: 'synthetic-photo-cases',
    origin: 'https://photo-schedule.example.invalid', pathPrefix: '/cases/', allowedRegions: ['US-WA'],
};
const make = (id, evidence = 'ACTIVE') => ({
    evidence, row: { impound_no: id, data_source: 'Regional Animal Services of King County', state: 'WA',
        record_type: 'FOUND', animal_type: 'Dog', date_type: 'Date Found', date: '2026-11-25T00:00:00.000' },
});
const nowZero = Date.parse('2026-11-27T00:00:00.000Z');
const masked = receipt => 'masked-' + digest(receipt.tipId).slice(0, 12);

async function main() {
    assert.equal(process.env.DATABASE_URL, DSN);
    assert.equal(process.platform, 'linux');
    assert.equal(process.arch, 'x64');
    const deps = createRequire('/app/package.json');
    const { Pool } = deps('pg'), sharp = deps('sharp');
    const { LocalStorageProvider } = await import('/app/apps/api/dist/storage/local.js');
    const directory = await mkdtemp('/tmp/stray-scheduled-photo-');
    const pool = new Pool({ connectionString: DSN, max: 4, connectionTimeoutMillis: 2000, query_timeout: 4500, statement_timeout: 3000 });
    let current = nowZero, slotStart = -Infinity, feed = [], sourceReads = 0, postCount = 0, remoteImageReads = 0, server;
    let evidenceAge = 0;
    const authority = new Map(), admissions = new Map(), log = [];
    const mark = name => log.push(name);
    const iso = () => new Date(current).toISOString();
    const records = [make('qa-case-a'), make('qa-case-b'), make('qa-missing'), make('qa-rights-unknown'), make('qa-other-photo'), make('qa-status', 'UNKNOWN')];
    const candidates = records.map(record => prepare(record.row, scope));
    try {
        const originals = await Promise.all([31, 51].map(red => sharp({ create: {
            channels: 3, width: 128, height: 96, background: { r: red, g: 73, b: 52 },
        } }).withExif({ IFD0: { Artist: 'SELF_MADE_SCHEDULE_QA' }, IFD3: {
            GPSLatitudeRef: 'N', GPSLatitude: '0/1 0/1 0/1', GPSLongitudeRef: 'E', GPSLongitude: '0/1 0/1 0/1',
        } }).png().toBuffer()));
        const hashes = originals.map(digest);
        assert.notEqual(hashes[0], hashes[1]);
        const service = new PendingService({ pool, sourcePolicies: [scope], now: iso, knownSyntheticPixelHashes: hashes,
            requirePersistentPhotoRights: true, enablePersistentDedup: true, verifyScheduledCase: async source => {
                const status = authority.get(source.recordKey);
                return status ? { ...source, status, sourceMayBeReused: true, checkedAt: new Date(current - evidenceAge).toISOString() } : null;
            } });
        await service.init();
        const storage = new LocalStorageProvider(path.join(directory, 'private'), 'http://127.0.0.1/unserved');
        for (const [index, original] of originals.entries()) {
            const { payload, key } = candidates[index], context = payload.source, originalHash = hashes[index];
            assert.ok((await sharp(original).metadata()).exif);
            const registered = await service.photoRights.register({ context, originalHash, proof: selfMadeProof(context, originalHash) });
            assert.ok(registered.success);
            const grant = { context, originalHash, grantId: registered.grantId, synthetic: true, license: 'EXPLICIT_PERMISSION' };
            const stored = await service.addSyntheticPhoto(original, 'image/png', grant, storage, sharp);
            assert.ok(stored.success);
            const mismatchedMime = await service.addSyntheticPhoto(original, 'image/jpeg', grant, storage, sharp);
            assert.equal(mismatchedMime.status, 415);
            const metadata = await sharp((await pool.query('SELECT bytes FROM rebuild_external.photos WHERE id=$1', [stored.uploadId])).rows[0].bytes).metadata();
            assert.equal(metadata.format, 'jpeg');
            assert.ok(!metadata.exif && !metadata.xmp && !metadata.icc && !metadata.orientation);
            const ref = { uploadId: stored.uploadId, rights: stored.rights, caption: 'Self-made synthetic pixels for isolated QA' };
            admissions.set(key, { ref, grantId: registered.grantId });
            authority.set(key, 'ACTIVE');
        }
        mark('two grants and exact original bytes verified; metadata stripped and MIME mismatch denied');
        const unknownRights = candidates[3].payload.source;
        const badGrant = await service.photoRights.register({ context: unknownRights, originalHash: hashes[0],
            proof: { ...selfMadeProof(unknownRights, hashes[0]), mayRepublish: false } });
        assert.equal(badGrant.status, 403);
        for (const item of candidates.slice(2, 5)) authority.set(item.key, 'ACTIVE');
        const photoA = admissions.get(candidates[0].key).ref;
        admissions.set(candidates[3].key, { ref: { ...photoA, rights: { ...photoA.rights, evidenceRef: 'ev_unverified_proof_001' } } });
        admissions.set(candidates[4].key, { ref: photoA });
        server = http.createServer(async (request, reply) => {
            const send = (status, body) => reply.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
            try {
                if (request.method === 'GET' && request.url === '/fixture/feed') {
                    assert.equal(request.headers.authorization, undefined);
                    sourceReads++;
                    return send(200, { synthetic: true, ...scope, sourceMayBeReused: true, complete: true, checkedAt: iso(), records: feed });
                }
                if (request.method === 'GET' && request.url === '/fixture/unknown-photo.png') { remoteImageReads++; return send(404, {}); }
                if (request.method === 'POST' && request.url === '/fixture/scheduled/tips') {
                    postCount++;
                    const chunks = [];
                    for await (const chunk of request) chunks.push(chunk);
                    const accepted = await service.accept(Buffer.concat(chunks), request.headers['idempotency-key']);
                    return send(accepted.status, accepted);
                }
                if (request.method === 'GET' && request.url.startsWith('/fixture/scheduled/receipts/')) {
                    const receipt = await service.getReceipt(request.url.split('/').at(-1));
                    return send(receipt.success ? 200 : receipt.status, receipt);
                }
                if (request.method === 'GET' && request.url.startsWith('/fixture/public/tips/')) {
                    const got = await service.publicTip(request.url.split('/').at(-1));
                    return send(got.success ? 200 : got.status, got);
                }
                if (request.method === 'GET' && request.url.startsWith('/fixture/public/photos/')) {
                    const bytes = await service.publicPhoto(request.url.split('/').at(-1));
                    return send(bytes ? 200 : 404, { visible: !!bytes });
                }
                return send(404, {});
            } catch (_) { return send(500, { error: 'ISOLATED_RECEIVER_FAILURE' }); }
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const origin = 'http://127.0.0.1:' + server.address().port;
        const request = async (url, options) => {
            const response = await fetch(origin + '/fixture/' + url, { ...options, signal: AbortSignal.timeout(7000), redirect: 'error' });
            return { status: response.status, body: await response.json() };
        };
        const send = (payload, key) => request('scheduled/tips', { method: 'POST', headers: {
            'content-type': 'application/json', 'idempotency-key': key,
        }, body: JSON.stringify(payload) });
        const second = candidates[1], photoB = admissions.get(second.key).ref;
        assert.equal((await send(candidates[0].payload, candidates[0].key)).body.error, 'SCHEDULED_ORIGINAL_PHOTO_REQUIRED');
        assert.equal((await send({ ...second.payload, photos: [photoA] }, second.key)).body.error, 'PHOTO_NOT_VERIFIED');
        const unverified = { ...photoB, rights: { ...photoB.rights, evidenceRef: 'ev_unverified_proof_001' } };
        assert.equal((await send({ ...second.payload, photos: [unverified] }, second.key)).body.error, 'PHOTO_NOT_VERIFIED');
        assert.equal((await send({ ...second.payload, photos: [{ url: origin + '/fixture/unknown-photo.png' }] }, second.key)).body.error, 'INVALID_PHOTO');
        authority.set(second.key, 'UNKNOWN');
        const secondWithPhoto = { ...second.payload, photos: [photoB] };
        assert.equal((await send(secondWithPhoto, second.key)).body.error, 'SCHEDULED_CASE_NOT_CONFIRMED_ACTIVE');
        authority.set(second.key, 'ACTIVE');
        evidenceAge = INTERVAL_MS;
        assert.equal((await send(secondWithPhoto, second.key)).body.error, 'SCHEDULED_CASE_NOT_CONFIRMED_ACTIVE');
        evidenceAge = 0;
        const sensitive = { ...secondWithPhoto, location: { ...second.payload.location, sensitivity: 'HABITAT' } };
        assert.equal((await send(sensitive, second.key)).body.error, 'SCHEDULED_CASE_NOT_SAFE');
        assert.equal(remoteImageReads, 0);
        mark('missing, wrong-case, unlicensed, remote URL, uncertain and sensitive candidates rejected by the receiver');
        const blockedPosts = postCount;
        let ledger = { lastCheckedAt: null, records: {} };
        const tick = async (offset, nextFeed) => {
            current = nowZero + offset * INTERVAL_MS;
            feed = nextFeed;
            return scheduledIntakeTick({ isolated: true, scope, enabled: () => true, now: () => current,
                reserve(at, interval) { if (at - slotStart < interval) return false; slotStart = at; return true; },
                readSource: async () => (await request('feed')).body,
                loadLedger: async () => structuredClone(ledger),
                saveLedger: async entry => { ledger = structuredClone(entry); }, send,
                loadPhotoAdmission: async source => ({ photos: admissions.has(source.recordKey) ? [admissions.get(source.recordKey).ref] : [],
                    verifiedUploads: await service.uploads() }),
            });
        };
        assert.equal((await tick(0, [])).reason, 'BASELINE_RECORDED');
        assert.equal((await tick(0.9, records)).reason, 'NOT_DUE');
        assert.equal((await tick(1, records.slice(2))).held, 4);
        assert.equal(postCount, blockedPosts);
        const first = await tick(2, records);
        assert.equal(first.status, 'PENDING');
        assert.equal((await tick(3, records)).reason, 'SOURCE_RATE_LIMIT');
        const other = await tick(6, records);
        assert.equal(other.status, 'PENDING');
        assert.notEqual(first.receipt, other.receipt);
        mark('15-minute gate, no text-only POST, separate same-date receipts and existing rate limit');
        for (const candidate of candidates.slice(0, 2)) {
            const entry = ledger.records[candidate.key], admitted = admissions.get(candidate.key);
            const replay = await send({ ...candidate.payload, photos: [admitted.ref] }, candidate.key);
            assert.equal(replay.status, 202);
            assert.equal(replay.body.replay, true);
            assert.deepEqual(replay.body.receipt, entry.receipt);
            assert.equal(entry.receipt.publicVisible, false);
            const read = await request('scheduled/receipts/' + entry.receipt.tipId);
            assert.deepEqual(read.body.receipt, entry.receipt);
            assert.equal((await request('public/tips/' + entry.receipt.tipId)).status, 404);
            assert.equal((await request('public/photos/' + admitted.ref.uploadId)).status, 404);
            assert.equal((await service.decide(entry.receipt.tipId, 'APPROVE', Object.fromEntries(checks.map(key => [key, true])))).status, 403);
        }
        mark('durable same-case replays and readback; both receipt and photo remain outside public readers');
        await service.photoRights.revoke(admissions.get(second.key).grantId);
        assert.equal((await send(secondWithPhoto, second.key)).body.error, 'PHOTO_NOT_VERIFIED');
        const secondReceipt = ledger.records[second.key].receipt;
        assert.deepEqual((await request('scheduled/receipts/' + secondReceipt.tipId)).body.receipt, secondReceipt);
        const provenance = await pool.query("SELECT proof->>'creator' creator, rights->>'attributionRef' credit FROM rebuild_external.photo_rights_grants");
        assert.equal(provenance.rowCount, 2);
        assert.ok(provenance.rows.every(row => row.creator === 'REPO_SYNTHETIC_GENERATOR' && /^credit_[a-f0-9]{32}$/.test(row.credit)));
        mark('revocation blocks admission while preserving the receipt and private attribution evidence');
        const counted = (await pool.query(`SELECT (SELECT count(*)::int FROM rebuild_external.tips WHERE review='PENDING') cases,
            (SELECT count(*)::int FROM rebuild_external.requests) requests`)).rows[0];
        assert.deepEqual(counted, { cases: 2, requests: 2 });
        const receipts = candidates.slice(0, 2).map(candidate => masked(ledger.records[candidate.key].receipt));
        console.log(JSON.stringify({ synthetic: true, checks: log, sourceReads, remoteImageReads, ...counted,
            receipts, privateOnly: true, realAnimalIdentificationVerified: false, realAuthorPermissionVerified: false }));
    } finally {
        if (server) await new Promise(resolve => server.close(resolve));
        await pool.end();
        await rm(directory, { recursive: true, force: true });
    }
}
main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
});
