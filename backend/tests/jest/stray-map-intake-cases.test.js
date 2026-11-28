require('./helpers/mock-setup');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const c = require('../../../tools/stray-map-intake/contract');
const r = require('../../../tools/stray-map-intake/rehearsal');
const semantics = require('../../../tools/stray-map-intake/case-semantics');
const f = require('../../../tools/stray-map-intake/synthetic-fixtures');
const cases = require('../../../tools/stray-map-intake/case-fixtures');
const legacy = require('../../../tools/stray-map-intake/compat-v2-fixtures.json');
const checks = Object.fromEntries(r.CHECKS.map(key => [key, true]));
const evaluate = body => c.validateTip(JSON.stringify(body), { submittedAt: f.SUBMITTED,
    sourcePolicy: body.source.publisherId === f.policy.publisherId ? f.policy : f.peerPolicy });
let dir, store, clock, servers;
const accept = body => store.accept(JSON.stringify(body), `request_${body.source.recordKey}`);
const approve = body => { const result = accept(body); expect(result.success).toBe(true); store.review(result.receipt.tipId, 'APPROVE', checks); return result.receipt; };
beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stray-case-rehearsal-')); clock = f.SUBMITTED; servers = [];
    store = new r.RehearsalStore(dir, { sourcePolicy: f.policy, sourcePolicies: [f.policy, f.peerPolicy], now: () => clock });
});
afterEach(async () => { await Promise.all(servers.map(server => server.close())); store.close(); fs.rmSync(dir, { recursive: true, force: true }); });

describe('report type is separate from species, health and custody', () => {
    test.each(c.REPORT_TYPES)('accepts explicit %s semantics', type => {
        const body = cases.caseTip(type), result = evaluate(body);
        expect(result.success).toBe(true); expect(result.canonicalPayload.report).toEqual(body.report);
        expect(result.canonicalPayload.animal.kind).toBe('DOG'); expect(result.review.publicVisible).toBe(false);
    });
    test.each(['LOST', 'FOUND', 'SIGHTING', 'ROAMING'])('rejects report/activity %s as v3 animal health', condition => {
        const body = cases.caseTip('LOST'); body.animal.condition = condition; expect(evaluate(body).error).toBe('INVALID_ANIMAL');
    });
    test.each(c.HEALTH_CONDITIONS)('retains explicit health %s independently', condition => {
        const body = cases.caseTip('FOUND'); body.animal.condition = condition; expect(evaluate(body).success).toBe(true);
    });
    test.each(c.REPORT_TYPES)('rejects a mismatched location meaning for %s', type => {
        const body = cases.caseTip(type); body.report.locationMeaning = 'CURRENT_CARE_LOCATION'; expect(evaluate(body).error).toBe('INVALID_REPORT');
    });
    test.each(['LOST', 'SIGHTING'])('does not infer current care for %s', type => {
        const body = cases.caseTip(type); body.report.custody = { status: 'IN_CARE', asOf: f.date('2026-11-25') };
        expect(evaluate(body).error).toBe('INVALID_REPORT');
    });
    test.each(['UNKNOWN', 'IN_CARE', 'NOT_IN_CARE'])('found custody state %s is distinct from found location', status => {
        const body = cases.caseTip('FOUND'); body.report.custody = { status, asOf: status === 'UNKNOWN' ? f.unknown() : f.date('2026-11-26') };
        expect(evaluate(body).success).toBe(true); approve(body);
        const projected = store.publicList().items[0]; expect(projected.report.custody).toEqual(body.report.custody);
        expect(projected.report.locationMeaning).toBe('FOUND_AT'); expect(projected.careLocationInferred).toBe(false);
    });
    test.each([f.unknown(), f.date('2026-11-24'), f.date('2027-01-01')])('known care requires a consistent actual time %j', asOf => {
        const body = cases.caseTip('FOUND'); body.report.custody.asOf = asOf; expect(evaluate(body).error).toBe('INVALID_REPORT');
    });
    test('unknown care cannot claim a known asOf; private care address is not accepted', () => {
        const body = cases.caseTip('LOST'); body.report.custody.asOf = f.date('2026-11-24'); expect(evaluate(body).error).toBe('INVALID_REPORT');
        body.report.custody = { status: 'UNKNOWN', asOf: f.unknown(), address: 'synthetic-private' }; expect(evaluate(body).error).toBe('INVALID_REPORT');
    });
    test('only direct sighting is map-eligible; lost is historical and found is not current care location', () => {
        for (const type of c.REPORT_TYPES) approve(cases.caseTip(type));
        const items = store.publicList().items;
        expect(items.map(item => [item.report.type, item.report.locationMeaning, item.mapMarkerEligible])).toEqual([
            ['LOST', 'LAST_KNOWN', false], ['FOUND', 'FOUND_AT', false], ['SIGHTING', 'OBSERVED_AT', true],
        ]);
        expect(items.every(item => item.selfWitness === false && item.thirdParty)).toBe(true);
        expect(items[0].display.locale).toBe('en-US'); expect(items[2].display.locale).toBe('zh-TW');
    });
});
describe('v2 compatibility without inventing sighting semantics', () => {
    test.each(legacy.cases)('preserves old canonical payload/hash/candidate bucket', baseline => {
        const result = evaluate(baseline.body);
        expect(result.success).toBe(true); expect(result.payloadHash).toBe(baseline.payloadHash);
        expect(result.candidateFingerprint).toBe(baseline.candidateFingerprint);
        expect(result.canonicalPayload).toEqual(baseline.body);
    });
    test('v2 remains accepted but extra report is rejected instead of silently upgrading', () => {
        const body = f.taiwan(); body.report = cases.caseTip('SIGHTING').report; expect(evaluate(body).error).toBe('INVALID_TIP');
        approve(f.taiwan()); const item = store.publicList().items[0];
        expect(item.report.type).toBe('UNSPECIFIED_LEGACY'); expect(item.mapMarkerEligible).toBe(false);
    });
    test('old disk snapshot without source state/event fields reopens with identical receipt', () => {
        const body = f.taiwan(), first = approve(body); const file = store.file; store.close();
        const state = JSON.parse(fs.readFileSync(file, 'utf8')); delete state.sourceEvents;
        for (const row of Object.values(state.receipts)) delete row.sourceState;
        fs.writeFileSync(file, JSON.stringify(state));
        store = new r.RehearsalStore(dir, { sourcePolicy: f.policy, sourcePolicies: [f.policy, f.peerPolicy], now: () => clock });
        expect(accept(body).receipt).toEqual(first); expect(store.receipt(first.tipId).sourceState.caseStatus).toBe('NOT_CONFIRMED_CLOSED');
    });
});
describe('manual private pairing is neither duplication nor reunion', () => {
    test('similar lost/found keep independent receipts, health and review states', () => {
        const lost = approve(cases.caseTip('LOST')), found = approve(cases.caseTip('FOUND'));
        const before = JSON.stringify(store.state.receipts); const result = store.matchingSuggestions();
        expect(result.items).toEqual([{ lostTipId: lost.tipId, foundTipId: found.tipId, manualOnly: true, confidence: 'UNSCORED',
            reunionVerified: false, reasons: ['SAME_KIND', 'SAME_COARSE_REGION', 'TIME_NOT_CONTRADICTED'] }]);
        expect(JSON.stringify(store.state.receipts)).toBe(before); expect(lost.tipId).not.toBe(found.tipId);
        expect(store.publicList()).not.toHaveProperty('matchingSuggestions');
        for (const privateValue of ['recordKey', 'datasetId', 'publisherId', 'confidence', 'lostTipId', 'foundTipId']) expect(JSON.stringify(store.publicList())).not.toContain(privateValue);
    });
    test('LOST and FOUND cannot be marked duplicate of each other', () => {
        const lost = accept(cases.caseTip('LOST')).receipt, found = accept(cases.caseTip('FOUND')).receipt;
        expect(store.review(found.tipId, 'DUPLICATE', {}, lost.tipId).error).toBe('DISTINCT_REPORT_TYPES');
        expect(store.receipt(found.tipId).review.status).toBe('PENDING');
        expect(store.state.receipts[found.tipId].candidates).not.toContain(lost.tipId);
    });
    test.each(['kind', 'region', 'country', 'time', 'sighting', 'sensitive'])('does not suggest conflicting/unrelated %s', mismatch => {
        const a = cases.caseTip('LOST'), b = cases.caseTip('FOUND');
        if (mismatch === 'kind') b.animal.kind = 'CAT';
        if (mismatch === 'region') { b.location = { ...b.location, countryCode: 'TW', regionCode: 'TW-TPE' }; }
        if (mismatch === 'country') { a.location.regionCode = null; }
        if (mismatch === 'time') { a.observation = f.date('2026-11-26'); a.source.publishedAt = f.date('2026-11-26'); }
        if (mismatch === 'sighting') Object.assign(b, cases.caseTip('SIGHTING'));
        if (mismatch === 'sensitive') a.location.sensitivity = 'HABITAT';
        accept(a); accept(b); expect(store.matchingSuggestions().items).toEqual([]);
    });
});
describe('explicit source closure, missing data and outage are distinct durable facts', () => {
    test.each(['ABSENT', 'TEMPORARY_FAILURE'])('%s hides without declaring closure or reunion', type => {
        const body = cases.caseTip('FOUND'), receipt = approve(body), e = cases.event(body, type);
        const result = store.sourceEvent(e, { completeSnapshot: true }); expect(result.success).toBe(true);
        const state = store.receipt(receipt.tipId).sourceState;
        expect(state.caseStatus).toBe('NOT_CONFIRMED_CLOSED'); expect(state.availability).toBe(type === 'ABSENT' ? 'ABSENT' : 'UNAVAILABLE');
        expect(state.reunionStatus).toBe('UNVERIFIED'); expect(store.publicList().items).toHaveLength(0);
        expect(store.sourceEvent(cases.event(body, 'PRESENT')).success).toBe(true);
        expect(store.publicList().items).toHaveLength(1); expect(accept(body).receipt).toEqual(receipt);
    });
    test('partial data cannot establish absence', () => {
        const body = cases.caseTip('FOUND'), receipt = approve(body);
        expect(store.sourceEvent(cases.event(body, 'ABSENT')).error).toBe('INCOMPLETE_SNAPSHOT');
        store.sourceAvailability(f.peerPolicy, { seenKeys: [], acceptedKeys: [], completeSnapshot: false, jobId: 'partial' });
        expect(store.receipt(receipt.tipId).sourceState.availability).toBe('PRESENT'); expect(store.publicList().items).toHaveLength(1);
    });
    test('explicit closure changes only its source case and never automatically reopens or reunites', () => {
        const a = cases.caseTip('LOST'), b = cases.caseTip('FOUND'), lost = approve(a), found = approve(b);
        const e = cases.event(a, 'EXPLICIT_CLOSED'); const first = store.sourceEvent(e); expect(first.success).toBe(true);
        expect(store.sourceEvent(f.clone(e)).eventReceipt).toEqual(first.eventReceipt);
        const changed = f.clone(e); changed.type = 'PRESENT'; expect(store.sourceEvent(changed).status).toBe(409);
        store.sourceEvent(cases.event(a, 'PRESENT'));
        expect(store.receipt(lost.tipId).sourceState.caseStatus).toBe('CLOSED_BY_SOURCE');
        expect(store.receipt(found.tipId).sourceState.caseStatus).toBe('NOT_CONFIRMED_CLOSED');
        expect(store.publicList().items.map(item => item.id)).toEqual([found.tipId]); expect(store.matchingSuggestions().items).toEqual([]);
        expect(accept(a).receipt).toEqual(lost); expect(store.receipt(lost.tipId).review.status).toBe('APPROVED');
        expect(store.receipt(lost.tipId).effectivePublicVisible).toBe(false);
        expect(store.receipt(found.tipId).effectivePublicVisible).toBe(true);
    });
    test('source-event receipts persist across reopen; untrusted/future/stale events fail', () => {
        const body = cases.caseTip('FOUND'); approve(body); const event = cases.event(body, 'EXPLICIT_CLOSED');
        event.sourceChangedAt = f.date('2026-11-26'); const first = store.sourceEvent(event); store.close();
        store = new r.RehearsalStore(dir, { sourcePolicy: f.policy, sourcePolicies: [f.policy, f.peerPolicy], now: () => clock });
        expect(store.sourceEvent(event).eventReceipt).toEqual(first.eventReceipt);
        const stale = cases.event(body, 'PRESENT', '002'); stale.sourceChangedAt = f.date('2026-11-25'); expect(store.sourceEvent(stale).error).toBe('STALE_SOURCE_EVENT');
        const future = cases.event(body, 'PRESENT', '003'); future.sourceChangedAt = f.date('2027-01-01'); expect(store.sourceEvent(future).error).toBe('INVALID_SOURCE_EVENT');
        const forged = cases.event(body, 'PRESENT', '004'); forged.publisherId = 'synthetic-forged'; expect(store.sourceEvent(forged).error).toBe('INVALID_SOURCE_EVENT');
    });
    test('scoped schedule distinguishes complete missing records from a temporary API failure', async () => {
        const body = cases.caseTip('FOUND'); const receipt = approve(body); let mode = 'partial';
        const source = await r.startLoopback((_req, res) => {
            if (mode === 'outage') { res.writeHead(503, { 'Content-Type': 'text/html' }); res.end('synthetic outage'); return; }
            res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ synthetic: true, completeSnapshot: mode !== 'partial', records: mode === 'present' ? [body] : [] }));
        }); servers.push(source); const receiver = await r.startReceiver(store); servers.push(receiver);
        const poll = () => r.scheduledPass({ store, sourceURL: source.url, receiverURL: receiver.url, sourceScope: f.peerPolicy, jobId: 'synthetic-case-peer' });
        await poll(); expect(store.publicList().items).toHaveLength(1);
        mode = 'missing'; clock = '2026-11-26T12:15:00.000Z'; await poll(); expect(store.receipt(receipt.tipId).sourceState.availability).toBe('ABSENT');
        mode = 'outage'; clock = '2026-11-26T12:30:00.000Z'; await expect(poll()).rejects.toThrow('SOURCE_NOT_JSON');
        expect(store.receipt(receipt.tipId).sourceState.availability).toBe('UNAVAILABLE'); expect(store.receipt(receipt.tipId).sourceState.caseStatus).toBe('NOT_CONFIRMED_CLOSED');
        mode = 'present'; clock = '2026-11-26T12:45:00.000Z'; await poll(); expect(store.publicList().items).toHaveLength(1);
        expect(Object.keys(store.state.receipts)).toHaveLength(1); expect(accept(body).receipt).toEqual(receipt);
    });
});

test('matching budgets are explicit rather than claiming exhaustive pairing', () => {
    const row = body => ({ payload: body, receipt: { submittedAt: f.SUBMITTED }, mapPolicy: 'REVIEW_REQUIRED', review: { status: 'PENDING' } });
    const receipts = { lost: row(cases.caseTip('LOST')) };
    for (let n = 0; n < 101; n++) receipts[`found_${n}`] = row(cases.caseTip('FOUND'));
    let result = semantics.matchingSuggestions(receipts); expect(result.items).toHaveLength(100); expect(result.truncated).toBe(true);
    const unrelated = {};
    for (let n = 0; n < 41; n++) unrelated[`lost_${n}`] = row(cases.caseTip('LOST'));
    for (let n = 0; n < 50; n++) { const body = cases.caseTip('FOUND'); body.animal.kind = 'CAT'; unrelated[`found_${n}`] = row(body); }
    result = semantics.matchingSuggestions(unrelated); expect(result.items).toEqual([]); expect(result.truncated).toBe(true);
});
test.each(['REUNITED', 'ADOPTED', 'DECEASED'])('source event cannot infer outcome %s', type => {
    const body = cases.caseTip('FOUND'); const receipt = approve(body);
    expect(store.sourceEvent(cases.event(body, type)).error).toBe('INVALID_SOURCE_EVENT');
    expect(store.receipt(receipt.tipId).sourceState.caseStatus).toBe('NOT_CONFIRMED_CLOSED');
});
test('replaying old absence does not undo a later source recovery', () => {
    const body = cases.caseTip('FOUND'); approve(body); const event = cases.event(body, 'ABSENT');
    const first = store.sourceEvent(event, { completeSnapshot: true }); store.sourceEvent(cases.event(body, 'PRESENT'));
    expect(store.sourceEvent(event).eventReceipt).toEqual(first.eventReceipt);
    expect(store.publicList().items).toHaveLength(1);
});
test('unrecognized event fields, non-string keys and unknown records fail without creating receipts', () => {
    const body = cases.caseTip('FOUND'); approve(body);
    const invalid = cases.event(body, 'EXPLICIT_CLOSED'); invalid.reunionVerified = true;
    expect(store.sourceEvent(invalid).error).toBe('INVALID_SOURCE_EVENT');
    invalid.eventKey = 12345678901234567; delete invalid.reunionVerified; expect(store.sourceEvent(invalid).error).toBe('INVALID_SOURCE_EVENT');
    const unknown = cases.event(body, 'PRESENT'); unknown.recordKey = 'private_missing_case_001'; expect(store.sourceEvent(unknown).status).toBe(404);
    expect(Object.keys(store.state.receipts)).toHaveLength(1);
});
test('seen but rejected source updates become unavailable, never absent or a new accepted case', async () => {
    const body = cases.caseTip('FOUND'), receipt = approve(body), invalid = f.clone(body);
    invalid.report.custody.asOf = f.unknown();
    const source = await r.startLoopback((_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ synthetic: true, completeSnapshot: true, records: [invalid] })); });
    servers.push(source); const receiver = await r.startReceiver(store); servers.push(receiver);
    const pass = await r.scheduledPass({ store, sourceURL: source.url, receiverURL: receiver.url, sourceScope: f.peerPolicy, jobId: 'synthetic-invalid-update' });
    expect(pass.success).toBe(false); expect(pass.results[0].status).toBe(400);
    expect(store.receipt(receipt.tipId).sourceState.availability).toBe('UNAVAILABLE');
    expect(Object.keys(store.state.receipts)).toHaveLength(1);
});

describe('OpenAPI v2/v3 agreement', () => {
    const Ajv = require('ajv');
    const spec = require('../../../docs/stray-map-external-intake.openapi.json');
    const definitions = JSON.parse(JSON.stringify(spec.components.schemas).replace(/#\/components\/schemas\//g, '#/definitions/'));
    const validate = new Ajv({ allErrors: true }).compile({ definitions, $ref: '#/definitions/Tip' });
    test.each(c.REPORT_TYPES)('accepts the documented v3 %s shape', type => {
        const body = cases.caseTip(type); expect(validate(body)).toBe(true); expect(evaluate(body).success).toBe(true);
    });
    test('legacy remains valid; new report field cannot silently upgrade v2', () => {
        expect(validate(f.taiwan())).toBe(true);
        const body = f.taiwan(); body.report = cases.caseTip('SIGHTING').report; expect(validate(body)).toBe(false);
    });
    test('v3 type/health/location/custody constraints are structural too', () => {
        const body = cases.caseTip('LOST'); body.animal.condition = 'ROAMING'; expect(validate(body)).toBe(false);
        body.animal.condition = 'HEALTHY'; body.report.locationMeaning = 'OBSERVED_AT'; expect(validate(body)).toBe(false);
        body.report.locationMeaning = 'LAST_KNOWN'; body.report.custody.status = 'IN_CARE'; expect(validate(body)).toBe(false);
    });
});

test('exhausted source-event capacity blocks publication across restart while retaining original receipts', async () => {
    const body = cases.caseTip('FOUND'), receipt = approve(body);
    const next = f.clone(store.state);
    next.sourceEvents = Object.fromEntries(Array.from({ length: r.SOURCE_EVENT_LIMIT }, (_unused, n) => [`synthetic_stored_event_${n}`, { payloadHash: 'a'.repeat(64), receipt: { synthetic: true } }]));
    store.commit(next);
    expect(store.sourceEvent(cases.event(body, 'TEMPORARY_FAILURE')).error).toBe('REHEARSAL_STORE_FULL');
    expect(store.publicList()).toEqual({ success: false, error: 'REHEARSAL_PUBLICATION_BLOCKED', status: 503 });
    expect(store.receipt(receipt.tipId).effectivePublicVisible).toBe(false);
    expect(store.receipt(receipt.tipId).publicationBlockedReason).toBe('SOURCE_EVENT_CAPACITY');
    expect(accept(body).receipt).toEqual(receipt);
    store.close(); store = new r.RehearsalStore(dir, { sourcePolicy: f.policy, sourcePolicies: [f.policy, f.peerPolicy], now: () => clock });
    expect(store.publicList().status).toBe(503); expect(store.receipt(receipt.tipId).sourceState.caseStatus).toBe('NOT_CONFIRMED_CLOSED');
    const receiver = await r.startReceiver(store); servers.push(receiver);
    const response = await r.readJSON(`${receiver.url}/public/tips`); expect(response.status).toBe(503); expect(response.body).not.toHaveProperty('items');
    expect(accept(body).receipt).toEqual(receipt);
});

test('unknown source closure time never inherits an earlier known source-update timestamp', () => {
    const body = cases.caseTip('FOUND'); const receipt = approve(body);
    const present = cases.event(body, 'PRESENT'); present.sourceChangedAt = f.date('2026-11-26');
    store.sourceEvent(present); store.sourceEvent(cases.event(body, 'EXPLICIT_CLOSED'));
    const state = store.receipt(receipt.tipId).sourceState;
    expect(state.sourceChangedAt).toEqual(present.sourceChangedAt); // Latest known source update, not closure time.
    expect(state.closureEvidence.sourceChangedAt).toEqual(f.unknown());
    expect(state.closureEvidence.receivedAt).toBe(clock); expect(state.closureEvidence.reunionVerified).toBe(false);
});
