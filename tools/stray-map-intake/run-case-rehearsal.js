#!/usr/bin/env node
'use strict';
// Synthetic only: three independent processes, no installed schedule or production connection.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const r = require('./rehearsal');
const f = require('./synthetic-fixtures');
const c = require('./case-fixtures');
const checks = Object.fromEntries(r.CHECKS.map(key => [key, true]));
const write = (root, name, data) => fs.writeFileSync(path.join(root, name), JSON.stringify(data, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
function fixtures() {
    const lost = c.caseTip('LOST'), found = c.caseTip('FOUND'), sighting = c.caseTip('SIGHTING'), independent = c.caseTip('FOUND');
    independent.source.recordKey = 'private_synthetic_found_002'; independent.display.title = 'Independent synthetic found dog';
    return { lost, found, sighting, independent };
}
async function phase(root, name) {
    let clock = f.SUBMITTED;
    const store = new r.RehearsalStore(path.join(root, 'store'), { sourcePolicy: f.policy, sourcePolicies: [f.policy, f.peerPolicy], now: () => clock });
    const bodies = fixtures();
    const received = name === 'receive' ? null : JSON.parse(fs.readFileSync(path.join(root, 'receive.private.json'), 'utf8'));
    if (name === 'verify') {
        try {
            assert.notEqual(process.pid, received.processId);
            assert.equal(Object.keys(store.state.receipts).length, 4);
            for (const receipt of received.receipts) assert.deepEqual(store.receipt(receipt.tipId).receipt, receipt);
            const lost = received.receipts[0]; assert.equal(store.receipt(lost.tipId).sourceState.caseStatus, 'CLOSED_BY_SOURCE');
            assert.equal(store.publicList().items.length, 3);
            assert.equal(store.publicList().items.filter(item => item.mapMarkerEligible).length, 1);
            assert.equal(store.matchingSuggestions().items.length, 0);
            write(root, 'verify.private.json', { simulation: true, processId: process.pid, originalReceipts: 4,
                closedCaseRemainsClosed: true, noReunionInferred: true, publicLeadCount: 3, directSightingEligible: 1 });
        } finally { store.close(); }
        return;
    }
    let primaryClosed = false, peerMode = 'present';
    const feeds = [], counts = [0, 0];
    const source = async index => {
        const server = await r.startLoopback((_req, res) => {
            counts[index]++;
            if (index === 1 && peerMode === 'outage') { res.writeHead(503, { 'Content-Type': 'text/html' }); res.end('Synthetic temporary failure'); return; }
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ synthetic: true, completeSnapshot: true,
                records: index === 0 ? [bodies.lost, bodies.sighting] : peerMode === 'missing' ? [bodies.found] : [bodies.found, bodies.independent],
                events: index === 0 && primaryClosed ? [c.event(bodies.lost, 'EXPLICIT_CLOSED')] : [] }));
        }); feeds.push(server); return server;
    };
    const primary = await source(0), peer = await source(1), receiver = await r.startReceiver(store);
    const poll = (server, policy, jobId) => r.scheduledPass({ store, sourceURL: server.url, receiverURL: receiver.url, sourceScope: policy, jobId });
    const pollPrimary = () => poll(primary, f.policy, 'synthetic-cases-primary');
    const pollPeer = () => poll(peer, f.peerPolicy, 'synthetic-cases-peer');
    try {
        if (name === 'receive') {
            const passes = [await pollPrimary(), await pollPeer()]; assert.ok(passes.every(pass => pass.success));
            const receipts = passes.flatMap(pass => pass.results.map(result => result.body.receipt));
            assert.equal(new Set(receipts.map(receipt => receipt.tipId)).size, 4);
            assert.equal(store.publicList().items.length, 0);
            const suggestions = store.matchingSuggestions(); assert.equal(suggestions.items.length, 2);
            assert.ok(suggestions.items.every(item => item.manualOnly && item.reunionVerified === false));
            write(root, 'receive.private.json', { simulation: true, processId: process.pid, receipts,
                pendingPublicCount: 0, privateManualSuggestions: suggestions.items.length, sourceRequests: counts });
            return;
        }
        assert.equal(name, 'lifecycle'); assert.notEqual(process.pid, received.processId);
        assert.equal((await pollPrimary()).skipped, true); assert.equal((await pollPeer()).skipped, true);
        assert.deepEqual(counts, [0, 0]);
        clock = '2026-11-26T12:15:00.000Z';
        const repeated = [await pollPrimary(), await pollPeer()];
        assert.deepEqual(repeated.flatMap(pass => pass.results.map(result => result.body.receipt)), received.receipts);
        const ids = received.receipts.map(receipt => receipt.tipId);
        assert.equal(store.review(ids[2], 'DUPLICATE', {}, ids[0]).error, 'DISTINCT_REPORT_TYPES');
        for (const id of ids) assert.equal(store.review(id, 'APPROVE', checks).success, true);
        const publicCases = (await r.readJSON(`${receiver.url}/public/tips`)).body;
        assert.equal(publicCases.items.length, 4); assert.equal(publicCases.items.filter(item => item.mapMarkerEligible).length, 1);
        assert.deepEqual(publicCases.items[0].observation, bodies.lost.observation);
        assert.equal(publicCases.items[0].report.locationMeaning, 'LAST_KNOWN');
        assert.equal(publicCases.items[2].report.locationMeaning, 'FOUND_AT');
        assert.equal(publicCases.items[2].careLocationInferred, false);
        assert.equal(publicCases.items[1].display.locale, 'zh-TW');
        for (const key of ['recordKey', 'publisherId', 'datasetId', 'lostTipId', 'foundTipId', 'latitude', 'longitude']) assert.ok(!JSON.stringify(publicCases).includes(key));
        primaryClosed = true; peerMode = 'missing'; clock = '2026-11-26T12:30:00.000Z';
        await pollPrimary(); await pollPeer();
        assert.equal(store.receipt(ids[0]).sourceState.caseStatus, 'CLOSED_BY_SOURCE');
        assert.equal(store.receipt(ids[2]).sourceState.caseStatus, 'NOT_CONFIRMED_CLOSED');
        assert.equal(store.receipt(ids[3]).sourceState.availability, 'ABSENT');
        assert.equal(store.receipt(ids[3]).sourceState.caseStatus, 'NOT_CONFIRMED_CLOSED');
        const afterCloseAndAbsence = store.publicList(); assert.equal(afterCloseAndAbsence.items.length, 2);
        peerMode = 'outage'; clock = '2026-11-26T12:45:00.000Z'; await assert.rejects(pollPeer, /SOURCE_NOT_JSON/);
        assert.equal(store.receipt(ids[2]).sourceState.availability, 'UNAVAILABLE');
        assert.equal(store.receipt(ids[3]).sourceState.availability, 'UNAVAILABLE');
        assert.equal(store.publicList().items.length, 1);
        peerMode = 'present'; primaryClosed = false; clock = '2026-11-26T13:00:00.000Z';
        await pollPeer(); await pollPrimary();
        assert.equal(store.publicList().items.length, 3); assert.equal(Object.keys(store.state.receipts).length, 4);
        assert.equal(store.receipt(ids[0]).sourceState.caseStatus, 'CLOSED_BY_SOURCE');
        for (const receipt of received.receipts) assert.deepEqual(store.receipt(receipt.tipId).receipt, receipt);
        assert.ok(Object.values(store.state.receipts).every(row => store.receipt(row.receipt.tipId).sourceState.reunionStatus === 'UNVERIFIED'));
        write(root, 'lifecycle.private.json', { simulation: true, processId: process.pid, immutableReplayCount: 4,
            approvedLeadCount: 4, directSightingEligible: 1, privateManualSuggestions: 2, publicBefore: publicCases,
            explicitClosureOnlyOwnCase: true, absenceNotClosure: true, outageNotClosure: true,
            publicAfterCloseAndAbsence: afterCloseAndAbsence, publicDuringOutage: 1, publicAfterRecovery: store.publicList(),
            oldLocationAndCareTimeNotRefreshed: true, sourceClosureNeverAutoReopened: true,
            noReunionInferred: true, independentReceipts: ids, sourceRequests: counts });
    } finally { await receiver.close(); await Promise.all(feeds.map(feed => feed.close())); store.close(); }
}
async function main() {
    const args = process.argv.slice(2);
    if (args[0] === '--phase' && args.length === 3 && ['receive', 'lifecycle', 'verify'].includes(args[1])) return phase(path.resolve(args[2]), args[1]);
    if (args.length !== 1 || !path.isAbsolute(args[0])) throw new Error('Usage: node tools/stray-map-intake/run-case-rehearsal.js /absolute/new-evidence-directory');
    const root = args[0]; fs.mkdirSync(root, { mode: 0o700 });
    for (const name of ['receive', 'lifecycle', 'verify']) execFileSync(process.execPath, [__filename, '--phase', name, root], { stdio: 'pipe', timeout: 30000 });
    const result = { success: true, simulation: true, phases: ['receive', 'lifecycle', 'verify'], productionWrites: 0,
        macPatrolChanged: false, termsChanged: false, reunionConfirmed: false, officialApiVerified: false };
    write(root, 'RESULT.private.json', result); console.log(JSON.stringify({ ...result, evidenceDirectory: root }));
}
if (require.main === module) main().catch(error => { console.error(error.stack); process.exitCode = 1; });
module.exports = { fixtures };
