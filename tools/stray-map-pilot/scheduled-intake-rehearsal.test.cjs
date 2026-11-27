'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { SOURCE } = require('./dot-identity.cjs');
const { scheduledIntakeTick, INTERVAL_MS } = require('./scheduled-intake-rehearsal.cjs');

const start = Date.parse('2026-11-27T00:00:00.000Z');
const time = slot => start + INTERVAL_MS * slot;
const record = (key, evidence = 'ACTIVE', fields = {}) => ({
    evidence, row: { impound_no: key, data_source: 'Regional Animal Services of King County', record_type: 'FOUND',
        animal_type: 'Dog', date: '2026-11-25T00:00:00.000', date_type: 'Date Found', state: 'WA', ...fields },
});

async function harness(t) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'stray-map-scheduled-test-'));
    const ledgerPath = path.join(directory, 'ledger.json');
    await fs.writeFile(ledgerPath, JSON.stringify({ lastCheckedAt: null, records: {} }), { mode: 0o600 });
    const loadLedger = async () => JSON.parse(await fs.readFile(ledgerPath, 'utf8'));
    const saveLedger = async value => {
        const temp = ledgerPath + '.next';
        await fs.writeFile(temp, JSON.stringify(value), { mode: 0o600 });
        await fs.rename(temp, ledgerPath);
    };
    let current = start, lastSlot = -Infinity, enabled = true, feed, outage = false, drop = false, rejection = null;
    const receipts = new Map(), observed = { gets: 0, attempts: [], anonymous: true };
    const server = http.createServer(async (request, response) => {
        if (request.url === '/feed' && request.method === 'GET') {
            observed.gets++;
            observed.anonymous &&= !request.headers.authorization && !request.headers.cookie && !request.headers['x-device-id'];
            return outage ? response.writeHead(503).end() : response.end(JSON.stringify(feed));
        }
        if (request.url === '/external-intake/v1/cards') return response.writeHead(503).end();
        assert.equal(request.method, 'POST');
        assert.equal(request.url, '/external-intake/v1/tips');
        const payload = JSON.parse(await Array.fromAsync(request).then(chunks => Buffer.concat(chunks).toString()));
        const key = request.headers['idempotency-key'];
        assert.equal(key, payload.source.recordKey);
        observed.attempts.push({ key, payload });
        if (rejection) return response.writeHead(rejection.status).end(JSON.stringify(rejection.body));
        const replay = receipts.has(key);
        if (!replay) {
            const tipId = 'tip_' + createHash('sha256').update(key).digest('hex').slice(0, 32);
            receipts.set(key, { tipId, status: 'PENDING', publicVisible: false });
        }
        if (drop) {
            drop = false;
            return response.destroy();
        }
        return response.writeHead(202).end(JSON.stringify({ success: true, replay, receipt: receipts.get(key) }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(async () => {
        await new Promise(resolve => server.close(resolve));
        await fs.rm(directory, { recursive: true, force: true });
    });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const params = {
        isolated: true, now: () => current, enabled: () => enabled, loadLedger, saveLedger,
        reserve(at, interval) {
            assert.equal(interval, 15 * 60 * 1000);
            if (at - lastSlot < interval) return false;
            lastSlot = at;
            return true;
        },
        async readSource() {
            const response = await fetch(origin + '/feed');
            if (!response.ok) throw Error('synthetic outage');
            return response.json();
        },
        async send(payload, key) {
            const response = await fetch(origin + '/external-intake/v1/tips', { method: 'POST',
                headers: { 'content-type': 'application/json', 'idempotency-key': key },
                body: JSON.stringify(payload) });
            return { status: response.status, body: await response.json() };
        },
    };
    function tick(slot, records, { sourceDown = false, lostAck = false, receiverRejection = null, ...overrides } = {}) {
        current = time(slot);
        outage = sourceDown;
        drop = lostAck;
        rejection = receiverRejection;
        feed = { synthetic: true, publisherId: SOURCE.publisherId, datasetId: SOURCE.datasetId, sourceMayBeReused: true,
            complete: true, checkedAt: new Date(current).toISOString(), records, ...overrides };
        return scheduledIntakeTick({ ...params });
    }
    return { tick, disable: () => { enabled = false; }, params, receipts, observed, loadLedger,
        cards: () => fetch(origin + '/external-intake/v1/cards') };
}

test('baseline and already receipted cases never submit on later 15-minute ticks', async t => {
    const h = await harness(t);
    const existing = record('synthetic-existing');
    const fresh = record('synthetic-new', 'ACTIVE', { private_memo: 'invalid-example-private' });
    assert.equal((await h.tick(0, [existing])).reason, 'BASELINE_RECORDED');
    assert.equal((await h.tick(0.9, [existing, fresh])).reason, 'NOT_DUE');
    const sent = await h.tick(1, [existing, fresh]);
    assert.match(sent.receipt, /^masked-[a-f0-9]{12}$/);
    assert.equal(sent.replay, false);
    assert.equal(sent.publicVisible, false);
    assert.equal((await h.tick(2, [fresh, existing])).reason, 'NO_ELIGIBLE_NEW_CASE');
    assert.equal(h.observed.gets, 3);
    assert.equal(h.observed.anonymous, true);
    assert.equal(h.observed.attempts.length, 1);
    const { payload } = h.observed.attempts[0];
    assert.equal(payload.display.locale, 'en-US');
    assert.equal(payload.location.regionCode, 'US-WA');
    assert.deepEqual(payload.photos, []);
    assert.doesNotMatch(JSON.stringify(payload), /synthetic-new|invalid-example-private/);
    assert.equal((await h.cards()).status, 503);
    const state = await h.loadLedger();
    h.disable();
    assert.equal((await h.tick(3, [record('synthetic-later')])).reason, 'DISABLED');
    assert.deepEqual(await h.loadLedger(), state);
    assert.equal(h.observed.gets, 3);
    t.diagnostic(`anonymous_gets=3 writes=1 pending=1 disabled_preserved=true receipt=${sent.receipt}`);
});

test('outage, incomplete reads, revoked permission, and uncertain source data withhold submission', async t => {
    const h = await harness(t);
    const delayed = record('synthetic-later');
    const unknownDate = record('synthetic-date', 'ACTIVE', { date_type: 'Received on' });
    const unknownStatus = record('synthetic-unknown', 'UNKNOWN');
    const closed = record('synthetic-closed', 'EXPLICIT_CLOSED');
    assert.equal((await h.tick(0, [delayed], { complete: false })).reason, 'SOURCE_CHECK_INCOMPLETE');
    assert.equal((await h.tick(1, [], { sourceDown: true })).reason, 'SOURCE_UNAVAILABLE');
    assert.equal((await h.tick(2, [delayed], { sourceMayBeReused: false })).reason, 'SOURCE_PERMISSION_UNVERIFIED');
    assert.equal((await h.tick(3, [delayed], { checkedAt: new Date(time(1)).toISOString() })).reason, 'SOURCE_CHECK_INCOMPLETE');
    assert.equal((await h.loadLedger()).lastCheckedAt, null);
    assert.equal((await h.tick(4, [])).reason, 'BASELINE_RECORDED');
    assert.equal((await h.tick(5, [unknownStatus, unknownDate, closed])).held, 2);
    assert.equal((await h.tick(6, [record('synthetic-closed'), delayed], { sourceMayBeReused: false })).submitted, false);
    assert.equal((await h.tick(7, [record('synthetic-closed'), delayed])).submitted, true);
    assert.equal(h.observed.attempts.length, 1);
    await assert.rejects(scheduledIntakeTick({ ...h.params, isolated: false }), /ISOLATED_INTAKE_ONLY/);
});

test('retry requires a current eligible case and keeps the original idempotency key', async t => {
    const h = await harness(t);
    const fresh = record('synthetic-lost-ack');
    await h.tick(0, []);
    assert.equal((await h.tick(1, [fresh], { lostAck: true })).reason, 'ACKNOWLEDGEMENT_UNAVAILABLE');
    assert.equal(h.receipts.size, 1);
    assert.equal((await h.tick(2, [])).reason, 'NO_ELIGIBLE_NEW_CASE');
    assert.equal((await h.tick(3, [record('synthetic-lost-ack', 'ACTIVE', { animal_type: 'Cat' })])).held, 1);
    const replay = await h.tick(4, [fresh]);
    assert.equal(replay.replay, true);
    assert.deepEqual(h.observed.attempts[0], h.observed.attempts[1]);
    assert.equal(h.receipts.size, 1);
    const queued = record('synthetic-limited');
    const hourly = await h.tick(5, [fresh, queued], { receiverRejection: { status: 429, body: {} } });
    assert.equal(hourly.reason, 'SOURCE_RATE_LIMIT');
    const capacity = await h.tick(6, [fresh, queued], { receiverRejection: { status: 503, body: { error: 'PILOT_CAPACITY' } } });
    assert.equal(capacity.reason, 'PENDING_CAPACITY');
    assert.equal(h.observed.attempts.length, 4);
    assert.equal(h.receipts.size, 1);
    t.diagnostic(`lost_ack_replay=true identical_request=true cases=1 receipt=${replay.receipt}`);
});

test('disabling while the public API read is outstanding prevents the write', async t => {
    const h = await harness(t);
    assert.equal((await h.tick(0, [])).reason, 'BASELINE_RECORDED');
    const before = await h.loadLedger();
    const stopped = await scheduledIntakeTick({ ...h.params, now: () => time(1), readSource: async () => {
        h.disable();
        return { synthetic: true, sourceMayBeReused: true, records: [record('synthetic-no-send')] };
    } });
    assert.equal(stopped.reason, 'DISABLED');
    assert.equal(h.observed.attempts.length, 0);
    assert.deepEqual(await h.loadLedger(), before);
});
