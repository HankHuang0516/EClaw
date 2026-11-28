#!/usr/bin/env node
'use strict';
// Reproducible synthetic milestone runner. Never installs a timer or contacts production.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const r = require('./rehearsal');
const f = require('./synthetic-fixtures');
const checks = Object.fromEntries(r.CHECKS.map(key => [key, true]));
function records() {
    const independent = f.washington(); independent.source.recordKey = 'private_synthetic_wa_002';
    independent.display.title = 'Independent synthetic Washington dog';
    const peer = f.washington(); peer.source.publisherId = f.peerPolicy.publisherId; peer.source.datasetId = f.peerPolicy.datasetId;
    const wildlife = f.taiwan(); wildlife.source.recordKey = 'private_synthetic_wild_001';
    wildlife.animal.kind = 'WILDLIFE'; wildlife.location.sensitivity = 'HABITAT';
    return [f.washington(), f.photoFixture().body, independent, peer, wildlife];
}
const write = (root, filename, data) => fs.writeFileSync(path.join(root, filename), JSON.stringify(data, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
async function phase(root, name) {
    let clock = f.SUBMITTED, sourceRequests = 0;
    const store = new r.RehearsalStore(path.join(root, 'store'), { sourcePolicy: f.policy, sourcePolicies: [f.policy, f.peerPolicy],
        uploads: [f.photoFixture().upload], now: () => clock });
    let outage = false;
    const source = await r.startLoopback((_req, res) => {
        sourceRequests++;
        res.writeHead(outage ? 503 : 200, { 'Content-Type': outage ? 'text/html' : 'application/json' });
        res.end(outage ? '<p>Synthetic outage</p>' : JSON.stringify({ synthetic: true, records: records() }));
    });
    const receiver = await r.startReceiver(store);
    const poll = () => r.scheduledPass({ store, sourceURL: source.url, receiverURL: receiver.url });
    try {
        if (name === 'first') {
            const accepted = await poll();
            assert.deepEqual(accepted.results.map(item => item.status), [202, 202, 202, 202, 202]);
            const receipts = accepted.results.map(item => item.body.receipt);
            assert.equal(new Set(receipts.map(item => item.tipId)).size, 5);
            assert.equal((await r.readJSON(`${receiver.url}/public/tips`)).body.items.length, 0);
            assert.equal((await poll()).skipped, true); assert.equal(sourceRequests, 1);
            const result = { simulation: true, phase: name, processId: process.pid, sourceRequests,
                accepted: receipts.length, persistentReceipts: receipts, pendingPublicCount: 0, repeatedTickThrottled: true };
            write(root, 'milestone-1-pending.private.json', result); return result;
        }
        assert.equal(name, 'restart');
        const first = JSON.parse(fs.readFileSync(path.join(root, 'milestone-1-pending.private.json'), 'utf8'));
        assert.notEqual(first.processId, process.pid);
        for (const receipt of first.persistentReceipts) assert.deepEqual(store.receipt(receipt.tipId).receipt, receipt);
        assert.equal((await poll()).skipped, true); assert.equal(sourceRequests, 0);
        clock = '2026-11-26T12:15:00.000Z';
        const replay = await poll();
        assert.deepEqual(replay.results.map(item => item.body.receipt), first.persistentReceipts);
        assert.ok(replay.results.every(item => item.body.replay));
        const ids = first.persistentReceipts.map(item => item.tipId);
        assert.equal(Object.keys(store.state.receipts).length, 5);
        assert.ok(store.state.receipts[ids[2]].candidates.includes(ids[0]));
        assert.ok(store.state.receipts[ids[3]].candidates.includes(ids[0]));
        const failedReview = store.review(ids[0], 'APPROVE');
        assert.equal(failedReview.error, 'REVIEW_CHECKS_REQUIRED'); assert.equal(store.publicList().items.length, 0);
        for (const id of ids.slice(0, 3)) assert.equal(store.review(id, 'APPROVE', checks).success, true);
        assert.equal(store.review(ids[3], 'DUPLICATE', {}, ids[0]).review.status, 'DUPLICATE');
        assert.equal(store.review(ids[4], 'APPROVE', checks).review.status, 'APPROVED_PRIVATE');
        const approved = (await r.readJSON(`${receiver.url}/public/tips`)).body;
        assert.equal(approved.items.length, 3);
        assert.deepEqual(approved.items[0].observation, f.washington().observation);
        assert.deepEqual(approved.items[0].display, f.washington().display);
        assert.deepEqual(approved.items[1].display, f.taiwan().display);
        assert.equal(approved.items[1].photos[0].caption, f.photoFixture().body.photos[0].caption);
        for (const privateKey of ['recordKey', 'publisherId', 'datasetId', 'evidenceRef', 'attributionRef', 'latitude', 'longitude']) assert.ok(!JSON.stringify(approved).includes(privateKey));
        store.review(ids[1], 'WITHDRAW');
        const rejected = f.taiwan(); rejected.source.recordKey = 'private_synthetic_reject_001';
        const rejectedId = store.accept(JSON.stringify(rejected), 'synthetic_reject_key_001').receipt.tipId;
        assert.equal(store.review(rejectedId, 'REJECT').review.publicVisible, false);
        const unlicensed = f.photoFixture().body; unlicensed.photos[0].rights.license = 'PUBLICLY_VISIBLE';
        const badPhoto = await r.readJSON(`${receiver.url}/synthetic/tips`, { method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'synthetic_bad_photo_key' }, body: JSON.stringify(unlicensed) });
        assert.equal(badPhoto.body.error, 'PHOTO_RIGHTS_REQUIRED');
        const after = store.publicList(); assert.equal(after.items.length, 2);
        assert.ok(after.items.every(item => item.location.countryCode === 'US'));
        outage = true; clock = '2026-11-26T12:30:00.000Z';
        await assert.rejects(poll, /SOURCE_NOT_JSON/);
        assert.equal((await poll()).skipped, true);
        assert.equal(Object.keys(store.state.receipts).length, 6);
        const result = { simulation: true, phase: name, processId: process.pid, distinctProcessRestart: true,
            receiptsReplayedUnchanged: 5, independentCasesPreserved: true, crossSourceDuplicateExplicitlyReviewed: true,
            reviewFailureHidden: true, wildlifeNeverPublic: true, unlicensedPhotoRejected: true,
            localeAndDatePrecisionPreserved: true, publicPrivateKeysAbsent: true,
            approvedPublicCount: 3, withdrawnAndRejectedHidden: true, finalPublicCount: 2,
            sourceOutageNoWrites: true, pollRatePersisted: true, sourceRequests, publicBeforeWithdrawal: approved,
            publicAfterWithdrawal: after };
        write(root, 'milestone-2-restart-review.private.json', result); return result;
    } finally { await receiver.close(); await source.close(); store.close(); }
}
async function main() {
    const args = process.argv.slice(2);
    if (args[0] === '--phase' && args.length === 3 && ['first', 'restart'].includes(args[1])) {
        await phase(path.resolve(args[2]), args[1]); return;
    }
    if (args.length !== 1 || !path.isAbsolute(args[0])) throw new Error('Usage: node tools/stray-map-intake/run-rehearsal.js /absolute/new-evidence-directory');
    const root = args[0]; fs.mkdirSync(root, { mode: 0o700 }); // Existing destinations are never overwritten.
    for (const name of ['first', 'restart']) execFileSync(process.execPath, [__filename, '--phase', name, root], { stdio: 'pipe', timeout: 20000 });
    const result = { success: true, simulation: true, officialApiVerified: false, productionWrites: 0,
        productionDeployment: false, macPatrolChanged: false, milestones: ['milestone-1-pending.private.json', 'milestone-2-restart-review.private.json'] };
    write(root, 'RESULT.private.json', result); console.log(JSON.stringify({ ...result, evidenceDirectory: root }));
}
if (require.main === module) main().catch(error => { console.error(error.stack); if (error.cause) console.error(error.cause.code || error.cause.message); process.exitCode = 1; });
module.exports = { records };
