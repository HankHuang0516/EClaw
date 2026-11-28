'use strict';

// External acceptance driver. Its source fixture and identity binding stay outside the candidate.
const fs = require('node:fs');
const http = require('node:http');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { examples, prepare, patrolTick, REGION_LOCALES, id } = require('./pilot-patrol.cjs');
const { PgSchedulerBridge, INTERVAL_MS } = require('/tools/stray-map-rebuild/pg-scheduler.cjs');
const { Pool } = createRequire('/candidate/apps/api/package.json')('pg');

const DSN = 'postgresql://postgres@localhost:5432/stray_map_linux_pilot_test';
const SETTINGS = { profile: 'TEXT_COARSE_PENDING_V1', intake: false, review: false, publicRead: false };
const policy = { verified: true, publisherId: 'synthetic-patrol', datasetId: 'synthetic-patrol-feed',
    origin: 'https://patrol.example.invalid', pathPrefix: '/events/', allowedRegions: Object.keys(REGION_LOCALES) };
const clockStart = '2026-11-27T00:00:00.000Z';
const prefix = '/external-intake/v1';
const gateFile = '/test-runtime/gates.json';
const allowedPeer = '127.0.0.2';
const timeAt = offset => new Date(Date.parse(clockStart) + offset).toISOString();
const makePool = () => new Pool({ connectionString: DSN, max: 2, connectionTimeoutMillis: 1000,
    statement_timeout: 3000, lock_timeout: 1000, query_timeout: 4000, ssl: false });
const gates = () => JSON.parse(fs.readFileSync(gateFile));
const setIntake = intake => fs.writeFileSync(gateFile, JSON.stringify({ ...SETTINGS, intake }));
const eligible = records => records.filter(record => !prepare(record, policy).reasons);
const held = records => records.filter(record => prepare(record, policy).reasons);

async function activate(app, originalPool) {
    assert.equal(originalPool.options.connectionString, DSN);
    const pool = makePool();
    app.addHook('onClose', async () => pool.end());
    const { install } = require('/candidate/apps/api/integrations/stray-map-pilot/pilot.cjs');
    await install(app, { pool, configuration: gates, now: () => clockStart,
        bindings: {
            sourcePolicies: [policy],
            // The kernel's peer address is checked inside this private, network-disabled test namespace.
            verifySource: async request => request.raw.socket.remoteAddress === allowedPeer
                ? { publisherId: policy.publisherId, datasetId: policy.datasetId } : null,
            verifyReviewer: async () => null,
        },
    });
}

function jsonRequest(port, path, { peer, payload, key } = {}) {
    const body = payload === undefined ? null : JSON.stringify(payload);
    return new Promise((resolve, reject) => {
        const request = http.request({ hostname: '127.0.0.1', port, path, agent: false, localAddress: peer,
            method: body === null ? 'GET' : 'POST', headers: body === null ? {} : {
                'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...(key ? { 'Idempotency-Key': key } : {}),
            }, signal: AbortSignal.timeout(4000) }, response => {
            const chunks = [];
            let size = 0;
            response.on('data', chunk => {
                size += chunk.length;
                if (size > 65536) response.destroy(Error('TEST_RESPONSE_LIMIT'));
                else chunks.push(chunk);
            });
            response.once('error', reject);
            response.once('aborted', () => reject(Error('TEST_RESPONSE_ABORTED')));
            response.once('end', () => {
                try { resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks)) }); }
                catch { reject(Error('TEST_RESPONSE_NOT_JSON')); }
            });
        });
        request.once('error', reject);
        request.end(body);
    });
}

async function ready() {
    const deadline = Date.now() + 85000;
    let lastFailure;
    while (Date.now() < deadline) {
        try { if ((await jsonRequest(3163, '/health')).status === 200) return; }
        catch (error) { lastFailure = error; }
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw Error(`CANDIDATE_START_TIMEOUT: ${lastFailure?.code || lastFailure?.message || 'health status was not 200'}`);
}

async function startFeed(records, reads) {
    const server = http.createServer((request, response) => {
        const hasAuth = ['authorization', 'cookie', 'x-device-id', 'x-local-qa-principal', 'x-admin-token']
            .some(name => Object.hasOwn(request.headers, name));
        reads.push({ method: request.method, authentication: hasAuth });
        if (request.method !== 'GET' || request.url !== '/events' || hasAuth) {
            response.writeHead(403).end();
            return;
        }
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ synthetic: true, records }));
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(3164, '127.0.0.1', resolve); });
    return server;
}

async function state(pool) {
    const tips = (await pool.query('SELECT record_key,receipt,review,payload FROM stray_text_pilot.tips ORDER BY record_key')).rows;
    const holds = (await pool.query('SELECT label,reasons FROM rebuild_external.patrol_manual ORDER BY label')).rows;
    const slots = (await pool.query('SELECT slot_start FROM rebuild_external.poll_slots ORDER BY slot_start')).rows;
    const { requests, devices, animals, sightings } = (await pool.query(`SELECT
        (SELECT count(*)::int FROM stray_text_pilot.requests) requests,
        (SELECT count(*)::int FROM devices) devices,(SELECT count(*)::int FROM animals) animals,
        (SELECT count(*)::int FROM sightings) sightings`)).rows[0];
    return { tips, holds, slots: slots.map(row => row.slot_start.toISOString()), requests, native: { devices, animals, sightings } };
}

async function patrol(pool) {
    await ready();
    const custom = JSON.parse(fs.readFileSync('/test-runtime/cases.private.json'));
    const records = [...examples, ...custom];
    const reads = [], attempts = [], checks = [];
    const feed = await startFeed(records, reads);
    const check = (name, fn) => { fn(); checks.push(name); };
    const receiver = (route, options) => jsonRequest(3163, prefix + route, options);
    const report = prepare(examples[0], policy);
    try {
        setIntake(true);
        const unauthenticated = await receiver('/tips', { payload: report.payload, key: report.key });
        check('Unverified peer is refused by the candidate verifier', () => assert.equal(unauthenticated.status, 403));
        const noSchema = (await pool.query("SELECT to_regnamespace('stray_text_pilot') IS NULL AS absent")).rows[0].absent;
        assert.equal(noSchema, true);
        await pool.query(`CREATE SCHEMA IF NOT EXISTS rebuild_external;
            CREATE TABLE rebuild_external.patrol_manual (case_key text PRIMARY KEY,label text NOT NULL,reasons jsonb NOT NULL)`);
        let offset = 0, dropped = false, beforeRetry;
        const bridge = new PgSchedulerBridge({ pool, sourcePolicies: [policy], now: () => timeAt(offset), syntheticDatabase: true });
        await bridge.init();
        async function tick(at) {
            offset = at;
            return patrolTick({ scope: policy, enabled: () => gates().intake,
                reserve: () => bridge.reservePoll(policy, 'synthetic-pending-patrol', INTERVAL_MS),
                readSource: async () => {
                    const source = await jsonRequest(3164, '/events');
                    assert.equal(source.status, 200);
                    return source.body;
                },
                hold: entry => pool.query(`INSERT INTO rebuild_external.patrol_manual VALUES ($1,$2,$3)
                    ON CONFLICT(case_key) DO UPDATE SET reasons=EXCLUDED.reasons`, [entry.key, entry.label, JSON.stringify(entry.reasons)]),
                send: async (payload, key) => {
                    const result = await receiver('/tips', { peer: allowedPeer, payload, key });
                    attempts.push({ key, status: result.status, replay: result.body.replay });
                    if (!dropped && result.status === 202) {
                        dropped = true;
                        assert.equal(result.body.replay, false);
                        beforeRetry = result.body.receipt;
                        throw Object.assign(Error('Injected lost acknowledgement after real HTTP acceptance'), { code: 'ACKNOWLEDGEMENT_UNAVAILABLE' });
                    }
                    return result;
                },
            });
        }
        const first = await tick(0), early = await tick(INTERVAL_MS - 1), second = await tick(INTERVAL_MS);
        const firstSent = first.cases.filter(item => item.receipt), secondSent = second.cases.filter(item => item.receipt);
        check('Anonymous GET only, no repeat poll until 15 minutes', () => {
            assert.equal(early.skipped, 'NOT_DUE');
            assert.deepEqual(reads, Array.from({ length: 2 }, () => ({ method: 'GET', authentication: false })));
        });
        check('A dropped acknowledgement retries the real route with the same committed receipt', () => {
            assert.equal(firstSent[0].retries, 1);
            assert.equal(firstSent[0].replay, true);
            assert.deepEqual(firstSent[0].receipt, beforeRetry);
            assert.equal(attempts[0].key, attempts[1].key);
        });
        const db = await state(pool);
        check('Replay across polls creates one pending row and one request entry per stable case', () => {
            assert.equal(db.tips.length, eligible(records).length);
            assert.equal(db.requests, db.tips.length);
            assert.equal(attempts.length, db.tips.length * 2 + 1);
            assert.deepEqual(db.slots, [timeAt(0), timeAt(INTERVAL_MS)]);
            assert.ok(secondSent.every((item, index) => item.replay && JSON.stringify(item.receipt) === JSON.stringify(firstSent[index].receipt)));
        });
        check('Local text, precision and private manual holds are preserved', () => {
            assert.ok(firstSent.some(item => item.locale === 'zh-TW' && item.title === '犬隻目擊線索' && item.precision === 'INSTANT'));
            assert.ok(firstSent.some(item => item.locale === 'en-US' && item.title === 'Cat: missing lead' && item.precision === 'DATE'));
            assert.equal(db.holds.length, held(records).length);
            for (const record of held(records)) {
                const outcome = prepare(record, policy);
                assert.deepEqual(db.holds.find(row => row.label === record.case)?.reasons, outcome.reasons);
                assert.ok(!db.tips.some(tip => tip.record_key === outcome.key));
            }
            for (const record of eligible(records)) {
                const outcome = prepare(record, policy);
                const row = db.tips.find(tip => tip.record_key === outcome.key);
                assert.deepEqual(row?.payload.display, outcome.payload.display);
                assert.deepEqual(row?.payload.location, outcome.payload.location);
                assert.deepEqual(row?.payload.photos, []);
            }
        });
        const receiptPath = `/receipts/${firstSent[0].receipt.tipId}`;
        const receiptRead = await receiver(receiptPath, { peer: allowedPeer });
        const cards = await receiver('/cards');
        check('Authorized receipt read works, review and public reads stay closed', () => {
            assert.equal(receiptRead.status, 200);
            assert.deepEqual(receiptRead.body.receipt, firstSent[0].receipt);
            assert.equal(receiptRead.body.review, 'PENDING');
            assert.equal(cards.status, 503);
            assert.equal(gates().review, false);
            assert.equal(gates().publicRead, false);
            assert.ok(db.tips.every(row => row.review === 'PENDING' && row.receipt.publicVisible === false));
            assert.deepEqual(db.native, { devices: 0, animals: 0, sightings: 0 });
        });
        setIntake(false);
        const stopped = await tick(2 * INTERVAL_MS);
        const disabledReceipt = await receiver(receiptPath, { peer: allowedPeer });
        const disabledWrite = await receiver('/tips', { peer: allowedPeer, payload: report.payload, key: report.key });
        check('Disabling intake stops polling and writing without changing persisted receipts', () => {
            assert.equal(stopped.skipped, 'DISABLED');
            assert.equal(reads.length, 2);
            assert.equal(disabledReceipt.status, 503);
            assert.equal(disabledWrite.status, 503);
        });
        assert.deepEqual(await state(pool), db);
        fs.writeFileSync('/test-runtime/expected.private.json', JSON.stringify(db), { mode: 0o600 });
        return { success: true, checks, schedule: { intervalSeconds: INTERVAL_MS / 1000, clock: 'TEST_CLOCK',
            polls: db.slots, earlyPoll: early.skipped, stopped: stopped.skipped, anonymousGets: reads.length, modelCalls: 0 },
            native: db.native, posts: attempts.length, cases: db.tips.length, requests: db.requests, cardsHttp: cards.status,
            unauthorizedHttp: unauthenticated.status, disabledWriteHttp: disabledWrite.status,
            holds: db.holds.map(row => ({ case: row.label, reasons: row.reasons })),
            receipts: firstSent.map((item, index) => ({ case: item.label, locale: item.locale, region: item.region, precision: item.precision,
                receipt: { tipId: `masked-${id(item.receipt.tipId).slice(0, 12)}`, status: item.receipt.status,
                    publicVisible: item.receipt.publicVisible, submittedAt: item.receipt.submittedAt },
                http: item.http, retrySameReceipt: secondSent[index].replay, retriesAfterLostAck: item.retries })),
        };
    } finally {
        setIntake(false);
        await new Promise(resolve => feed.close(resolve));
    }
}

async function main(phase) {
    assert.equal(process.env.DATABASE_URL, DSN);
    assert.equal(process.platform, 'linux');
    assert.equal(process.arch, 'x64');
    const pool = makePool();
    try {
        if (phase === 'patrol') console.log(JSON.stringify(await patrol(pool)));
        else {
            assert.equal(phase, 'persist');
            assert.deepEqual(gates(), SETTINGS);
            const old = JSON.parse(fs.readFileSync('/test-runtime/expected.private.json'));
            assert.deepEqual(await state(pool), old);
            console.log(JSON.stringify({ success: true, receiptsPreserved: old.tips.length, manualHoldsPreserved: old.holds.length,
                independentProcess: true, intake: false, review: false, publicRead: false }));
        }
    } finally { await pool.end(); }
}

if (require.main === module) main(process.argv[2]).catch(error => { console.error(error.stack); process.exitCode = 1; });
module.exports = { activate };
