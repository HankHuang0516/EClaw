require('./helpers/mock-setup');
const { Pool } = require('pg');
const dedup = require('../../../tools/stray-map-rebuild/sql-dedup.cjs');
const { validateTip } = require('../../../tools/stray-map-intake/contract');
const f = require('../../../tools/stray-map-intake/synthetic-fixtures');
const fixtures = require('../../../tools/stray-map-intake/case-fixtures');
const clone = x => JSON.parse(JSON.stringify(x));
const checks = { sameCaseConfirmed: true, sourceVerified: true, privacyReviewed: true };
function database() { return { tips: new Map(), cases: new Map(), links: [], decisions: new Map() }; }
function setup(db = database()) {
    const pool = new Pool(), client = { query: jest.fn(), release: jest.fn() };
    const query = async (sql, p = []) => {
        if (db.fail && sql.includes(db.fail)) throw Error('SYNTHETIC_STORE_FAILURE');
        let rows = [];
        if (sql.includes('dedup:tip')) rows = db.tips.has(p[0]) ? [db.tips.get(p[0])] : [];
        else if (sql.includes('dedup:case */')) rows = db.cases.has(p[0]) ? [db.cases.get(p[0])] : [];
        else if (sql.includes('dedup:counts')) rows = [db.counts || { cases: db.cases.size, links: db.links.length }];
        else if (sql.includes('dedup:insert-case')) {
            const names = ['id','payload_hash','source_scope_hash','fingerprint','report_type','kind','country','region','safe','observed_min','observed_max','accepted_at'];
            db.cases.set(p[0], { ...Object.fromEntries(names.map((n, i) => [n, p[i]])), truncated: false });
        } else if (sql.includes('dedup:candidates')) {
            rows = db.candidates || [...db.cases.values()].filter(c => c.id !== p[0] && c.source_scope_hash !== p[1] && c.safe
                && c.kind === p[2] && c.country === p[3] && c.region === p[4]
                && ((c.fingerprint !== null && c.fingerprint === p[5]) || (c.report_type === 'LOST' && p[6] === 'FOUND') || (c.report_type === 'FOUND' && p[6] === 'LOST'))
                && ['PENDING','APPROVED'].includes(db.tips.get(c.id)?.review) && !db.decisions.has(c.id))
                .map(c => ({ ...c, link_count: db.links.filter(l => l.left_id === c.id || l.right_id === c.id).length }))
                .sort((a, b) => a.id.localeCompare(b.id)).slice(0, 101);
        } else if (sql.includes('dedup:insert-link')) db.links.push({ left_id: p[0], right_id: p[1], kind: p[2] });
        else if (sql.includes('dedup:truncated')) db.cases.get(p[0]).truncated = p[1];
        else if (sql.includes('dedup:list')) rows = db.links.filter(l => [l.left_id,l.right_id].includes(p[0])
            && [l.left_id,l.right_id].every(id => ['PENDING','APPROVED'].includes(db.tips.get(id)?.review) && db.tips.get(id)?.map_policy !== 'NEVER' && !db.decisions.has(id))).slice(0, 100);
        else if (sql.includes('dedup:state')) rows = db.cases.has(p[0]) ? [db.cases.get(p[0])] : [];
        else if (sql.includes('dedup:decision-cases')) rows = p[0].filter(id => db.cases.has(id)).map(id => ({ ...db.cases.get(id),
            review: db.tips.get(id).review, source_case_status: db.tips.get(id).source_case_status,
            source_availability: db.tips.get(id).source_availability, source_blocked: db.tips.get(id).source_blocked }));
        else if (sql.includes('dedup:decision */')) rows = db.decisions.has(p[0]) ? [db.decisions.get(p[0])] : [];
        else if (sql.includes('dedup:confirm-link')) rows = db.links.filter(l => l.left_id === p[0] && l.right_id === p[1] && l.kind === 'SUSPECTED_DUPLICATE');
        else if (sql.includes('dedup:insert-decision')) {
            const row = { id: p[0], target_id: p[1], decided_at: Object.hasOwn(db, 'decisionTime') ? db.decisionTime : new Date(f.SUBMITTED) }; db.decisions.set(p[0], row); rows = [row];
        } else if (sql.includes('SELECT EXISTS')) rows = [{ excluded: db.decisions.has(p[0]) }];
        return { rows };
    };
    pool.query.mockImplementation(query); client.query.mockImplementation(query); pool.connect.mockResolvedValue(client);
    return { pool, client, db };
}
async function ready(db) { const s = setup(db); await dedup.init(s.pool, { syntheticDatabase: true }); return s; }
function context(s, id, { type = 'SIGHTING', peer = false, change = () => {} } = {}) {
    const payload = fixtures.caseTip(type), policy = peer ? f.peerPolicy : f.policy;
    Object.assign(payload.source, { publisherId: policy.publisherId, datasetId: policy.datasetId, recordKey: `private_synthetic_record_${id}` });
    change(payload);
    const valid = validateTip(JSON.stringify(payload), { sourcePolicy: policy, submittedAt: f.SUBMITTED }); expect(valid.success).toBe(true);
    const data = { id: `tip_synthetic_${id}`, publisher: policy.publisherId, dataset: policy.datasetId, recordKey: payload.source.recordKey,
        payloadHash: valid.payloadHash, candidateFingerprint: valid.candidateFingerprint, payload: valid.canonicalPayload, now: f.SUBMITTED };
    s.db.tips.set(data.id, { id: data.id, publisher: data.publisher, dataset: data.dataset, record_key: data.recordKey,
        payload_hash: data.payloadHash, payload: clone(data.payload), review: 'PENDING', map_policy: valid.review.mapPolicy,
        receipt: { success: true, tipId: data.id, status: 'PENDING', publicVisible: false },
        source_case_status: 'NOT_CONFIRMED_CLOSED', source_availability: 'PRESENT', source_blocked: false });
    return data;
}
async function pair(s, options = {}) {
    const a = context(s, 'aaaa0001', options), b = context(s, 'bbbb0002', { ...options, peer: true });
    await dedup.noteAccepted(s.client, a); const result = await dedup.noteAccepted(s.client, b); return { a, b, result };
}

describe('persistent private cross-source recommendations', () => {
    test('requires attested synthetic pool and creates separate cases/links/decisions only', async () => {
        const s = setup(); await expect(dedup.init(s.pool, { syntheticDatabase: false })).rejects.toThrow('VERIFIED_SYNTHETIC_POOL_REQUIRED');
        expect(s.pool.query).not.toHaveBeenCalled(); await dedup.init(s.pool);
        const sql = s.pool.query.mock.calls[0][0];
        for (const table of ['dedup_cases','candidate_links','duplicate_decisions']) expect(sql).toContain(`rebuild_external.${table}`);
        expect(sql).not.toMatch(/CREATE TABLE[^;]*\b(?:animals|devices)\b/i);
    });
    test('separate receipts, payloads and review remain unchanged; reverse links survive a fresh registered pool', async () => {
        const s = await ready(), { a, b, result } = await pair(s), before = clone([...s.db.tips]);
        expect(result.candidates).toEqual([{ candidateId: a.id, kind: 'SUSPECTED_DUPLICATE', manualOnly: true, reunionVerified: false }]);
        const fresh = await ready(s.db); expect((await dedup.listRecommendations(fresh.pool, a.id)).candidates[0].candidateId).toBe(b.id);
        expect([...s.db.decisions]).toEqual([]); expect(clone([...s.db.tips])).toEqual(before);
        expect(JSON.stringify(result)).not.toMatch(/private_synthetic_record|publisher|dataset|source_scope_hash|fingerprint|description/);
        const calls = s.client.query.mock.calls;
        const locks = calls.filter(([sql]) => sql.includes('pg_advisory_xact_lock')); expect(locks).toHaveLength(4);
        expect(calls[0][0]).toContain('pg_advisory_xact_lock');
        expect(calls.map(([sql]) => sql).join(' ')).not.toMatch(/\b(?:BEGIN|COMMIT|ROLLBACK)\b/);
    });
    test('same registered source receives no cross-source link despite equal fingerprints', async () => {
        const s = await ready(); const a = context(s, 'aaaa0001'), b = context(s, 'bbbb0002');
        await dedup.noteAccepted(s.client, a); expect((await dedup.noteAccepted(s.client, b)).candidates).toEqual([]);
    });
    test('persisted metadata stores hashed scope and case IDs rather than raw source identity keys', async () => {
        const s = await ready(), a = context(s, 'aaaa0001'); await dedup.noteAccepted(s.client, a);
        const params = s.client.query.mock.calls.find(([sql]) => sql.includes('dedup:insert-case'))[1];
        for (const raw of [a.publisher, a.dataset, a.recordKey]) expect(JSON.stringify(params)).not.toContain(raw);
    });
    test('legacy v2 fingerprints remain unchanged without inventing a report type', async () => {
        const s = await ready(), { result } = await pair(s, { change: p => { p.schemaVersion = 2; delete p.report; p.animal.condition = 'ROAMING'; } });
        expect(result.candidates[0].kind).toBe('SUSPECTED_DUPLICATE');
        expect([...s.db.cases.values()].every(c => c.report_type === 'UNSPECIFIED_LEGACY')).toBe(true);
    });
    test('validated instant local day preserves year zero and source time precision', async () => {
        const s = await ready(), { a, result } = await pair(s, { change: p => { p.observation = f.instant('0000-01-01T00:00:00Z', 'UTC'); } });
        expect(result.candidates).toHaveLength(1); expect(s.db.tips.get(a.id).payload.observation).toEqual(a.payload.observation);
    });
    test.each([
        ['2026-11-26T00:30:00+08:00', 'Asia/Taipei'],
        ['2026-11-24T23:30:00-08:00', 'America/Los_Angeles'],
    ])('validated %s local fingerprint is not its UTC date', async (value, zone) => {
        const s = await ready(), { a, result } = await pair(s, { change: p => { p.observation = f.instant(value, zone); } });
        expect(new Date(value).toISOString().slice(0, 10)).not.toBe(value.slice(0, 10));
        expect(result.candidates).toHaveLength(1); expect(s.db.cases.get(a.id).fingerprint).toBe(a.candidateFingerprint);
        expect(a.payload.observation).toEqual({ precision: 'INSTANT', value, timeZone: zone });
    });
    test('recomputes fingerprint and payload hash rather than trusting caller admission fields', async () => {
        const s = await ready(), a = context(s, 'aaaa0001');
        await expect(dedup.noteAccepted(s.client, { ...a, candidateFingerprint: '0'.repeat(64) })).rejects.toThrow('CANDIDATE_FINGERPRINT_MISMATCH');
        await expect(dedup.noteAccepted(s.client, { ...a, payloadHash: '0'.repeat(64) })).rejects.toThrow('INVALID_ACCEPTED_DEDUP_CONTEXT');
        expect(s.client.query).not.toHaveBeenCalled();
    });
    test.each(['publisher','dataset','recordKey','now'])('rejects mismatched/invalid context %s without SQL', async field => {
        const s = await ready(), a = context(s, 'aaaa0001');
        await expect(dedup.noteAccepted(s.client, { ...a, [field]: 'invalid' })).rejects.toThrow('INVALID_ACCEPTED_DEDUP_CONTEXT');
        expect(s.client.query).not.toHaveBeenCalled();
    });
    test('missing/mutated persisted tip fails closed; no links or decisions', async () => {
        const s = await ready(), a = context(s, 'aaaa0001'); s.db.tips.get(a.id).payload.display.title = 'changed synthetic payload';
        await expect(dedup.noteAccepted(s.client, a)).rejects.toThrow('ACCEPTED_TIP_NOT_PERSISTED');
        expect(s.db.links).toHaveLength(0); expect(s.db.cases.size).toBe(0);
    });
    test('same case invocation replays private recommendations without another metadata/link insertion', async () => {
        const s = await ready(), { b, result } = await pair(s);
        expect(await dedup.noteAccepted(s.client, b)).toEqual(result); expect(s.db.cases.size).toBe(2); expect(s.db.links).toHaveLength(1);
        s.db.cases.get(b.id).payload_hash = '0'.repeat(64); await expect(dedup.noteAccepted(s.client, b)).rejects.toThrow('DEDUP_CASE_CONFLICT');
    });
    test.each(['NEST','HABITAT','PROTECTED_SPECIES','UNKNOWN'])('sensitive %s never receives candidate links', async sensitivity => {
        const s = await ready(), { result } = await pair(s, { change: p => { p.location.sensitivity = sensitivity; } });
        expect(result.candidates).toEqual([]); expect(s.db.links).toHaveLength(0);
    });
    test.each(['wildlife','unknown-region'])('%s has no duplicate or matching links', async mode => {
        const s = await ready(), { result } = await pair(s, { change: p => { if (mode === 'wildlife') p.animal.kind = 'WILDLIFE'; else p.location.regionCode = null; } });
        expect(result.candidates).toEqual([]); expect(s.db.links).toHaveLength(0);
    });
    test('LOST/FOUND create private manual matching suggestions without merging or declaring reunion', async () => {
        const s = await ready(), a = context(s, 'aaaa0001', { type: 'LOST' }), b = context(s, 'bbbb0002', { type: 'FOUND', peer: true });
        await dedup.noteAccepted(s.client, a); const result = await dedup.noteAccepted(s.client, b);
        expect(result.candidates).toEqual([{ candidateId: a.id, kind: 'LOST_FOUND_SUGGESTION', manualOnly: true, reunionVerified: false }]);
        expect(await dedup.confirmDuplicate(s.pool, { id: b.id, targetId: a.id, checks })).toMatchObject({ success: false, status: 409 });
        expect(s.db.decisions.size).toBe(0); expect(s.db.tips.size).toBe(2);
    });
    test('definitely reversed LOST/FOUND observations yield no suggestion', async () => {
        const s = await ready(), a = context(s, 'aaaa0001', { type: 'LOST', change: p => { p.observation = f.date('2026-11-26'); p.source.publishedAt = f.date('2026-11-26'); } });
        const b = context(s, 'bbbb0002', { type: 'FOUND', peer: true });
        await dedup.noteAccepted(s.client, a); expect((await dedup.noteAccepted(s.client, b)).candidates).toEqual([]);
    });
    test('unknown time stays uncertain and can form matching suggestions, never duplicate fingerprint', async () => {
        const s = await ready(), a = context(s, 'aaaa0001', { type: 'LOST', change: p => { p.observation = f.unknown(); } });
        const b = context(s, 'bbbb0002', { type: 'FOUND', peer: true });
        expect(a.candidateFingerprint).toBeNull(); await dedup.noteAccepted(s.client, a);
        expect((await dedup.noteAccepted(s.client, b)).candidates[0].kind).toBe('LOST_FOUND_SUGGESTION');
    });
    test.each(['REJECTED','WITHDRAWN','APPROVED_PRIVATE'])('private list filters later status %s', async review => {
        const s = await ready(), { a, b } = await pair(s); s.db.tips.get(a.id).review = review;
        expect((await dedup.listRecommendations(s.pool, b.id)).candidates).toEqual([]);
    });
    test.each(['global','per-tip','scan'])('capacity %s truncates private recommendations without dropping new case', async mode => {
        const s = await ready(), { a } = await pair(s);
        const n = context(s, 'cccc0003', { peer: true });
        const existing = { ...s.db.cases.get(a.id), link_count: mode === 'per-tip' ? 100 : 0 };
        if (mode === 'global') s.db.counts = { cases: 2, links: 2000 };
        s.db.candidates = mode === 'scan' ? Array.from({ length: 101 }, (_, i) => ({ ...existing, id: `tip_synthetic_target${String(i).padStart(4, '0')}` })) : [existing];
        if (mode === 'scan') for (const item of s.db.candidates) s.db.tips.set(item.id, { review: 'PENDING', map_policy: 'REVIEW_REQUIRED' });
        const before = s.db.links.length, result = await dedup.noteAccepted(s.client, n);
        expect(result.truncated).toBe(true); expect(s.db.cases.has(n.id)).toBe(true); expect(s.db.links.length - before).toBe(mode === 'scan' ? 100 : 0);
    });
    test('case registry capacity/error throws for outer acceptance rollback', async () => {
        const s = await ready(), a = context(s, 'aaaa0001'); s.db.counts = { cases: 2000, links: 0 };
        await expect(dedup.noteAccepted(s.client, a)).rejects.toThrow('DEDUP_CASE_CAPACITY'); expect(s.db.cases.size).toBe(0);
        s.db.counts = { cases: -1, links: 0 }; await expect(dedup.noteAccepted(s.client, a)).rejects.toThrow('INVALID_DEDUP_COUNTS');
    });
    test('remaining global budget is respected while returning explicit truncation', async () => {
        const s = await ready(), { a } = await pair(s), n = context(s, 'cccc0003', { peer: true });
        s.db.counts = { cases: 2, links: 1999 }; s.db.candidates = Array.from({ length: 3 }, (_, i) => ({ ...s.db.cases.get(a.id), id: `tip_synthetic_target000${i}`, link_count: 0 }));
        for (const c of s.db.candidates) s.db.tips.set(c.id, { review: 'PENDING', map_policy: 'REVIEW_REQUIRED' });
        const before = s.db.links.length; expect((await dedup.noteAccepted(s.client, n)).truncated).toBe(true); expect(s.db.links.length - before).toBe(1);
    });
});

describe('manual confirmed decisions and fail-closed projection exclusion', () => {
    test('visibleSQL excludes only confirmed subject and safely preserves the outer alias', () => {
        const sql = dedup.visibleSQL(); expect(sql).toContain('NOT EXISTS'); expect(sql).toContain('duplicate_decisions'); expect(sql).toContain('.id=t.id');
        expect(sql).not.toContain('candidate_links'); expect(sql).not.toContain('target_id=');
        expect(dedup.visibleSQL('external_tip')).toContain('.id=external_tip.id');
        expect(dedup.visibleSQL('_rebuild_dup_hidden')).toContain('_rebuild_dup_hidden_2.id=_rebuild_dup_hidden.id');
    });
    test.each(['t.id', 't; SELECT 1', 't WHERE true --', 't/*', '', 'x'.repeat(64), null])('visibleSQL rejects unsafe alias %#', alias => {
        expect(() => dedup.visibleSQL(alias)).toThrow('INVALID_DEDUP_SQL_ALIAS');
    });
    test('confirmation persists separately, excludes subject only, and replays unchanged across a fresh pool', async () => {
        const s = await ready(), { a, b } = await pair(s), tips = clone([...s.db.tips]);
        const result = await dedup.confirmDuplicate(s.pool, { id: b.id, targetId: a.id, checks });
        expect(result).toMatchObject({ success: true, replay: false, projectionExcluded: true, decision: { id: b.id, targetId: a.id, reunionVerified: false } });
        expect(await dedup.isConfirmedDuplicate(s.pool, b.id)).toBe(true); expect(await dedup.isConfirmedDuplicate(s.pool, a.id)).toBe(false);
        const fresh = await ready(s.db), replay = await dedup.confirmDuplicate(fresh.pool, { id: b.id, targetId: a.id, checks });
        expect(replay.decision).toEqual(result.decision); expect(replay.replay).toBe(true); expect(clone([...s.db.tips])).toEqual(tips);
        expect((await dedup.listRecommendations(fresh.pool, a.id)).candidates).toEqual([]);
        expect(s.client.query.mock.calls.map(([sql]) => sql)).toContain('BEGIN'); expect(s.client.release).toHaveBeenCalled();
    });
    test.each([null, {}, { ...checks, sameCaseConfirmed: false }, Object.create(checks)])('requires own explicit manual checks %#', async check => {
        const s = await ready(); expect(await dedup.confirmDuplicate(s.pool, { id: 'tip_synthetic_aaaa0001', targetId: 'tip_synthetic_bbbb0002', checks: check })).toMatchObject({ status: 403 });
        expect(s.pool.connect).not.toHaveBeenCalled();
    });
    test.each(['different-kind','different-country','different-region','different-report','different-time','no-link','withdrawn','target-duplicate'])('cannot confirm invalid %s', async mode => {
        const s = await ready(), { a, b } = await pair(s);
        if (mode === 'different-kind') s.db.cases.get(a.id).kind = 'CAT';
        if (mode === 'different-country') s.db.cases.get(a.id).country = 'US';
        if (mode === 'different-region') s.db.cases.get(a.id).region = 'TW-KHH';
        if (mode === 'different-report') s.db.cases.get(a.id).report_type = 'LOST';
        if (mode === 'different-time') s.db.cases.get(a.id).fingerprint = '0'.repeat(64);
        if (mode === 'no-link') s.db.links = [];
        if (mode === 'withdrawn') s.db.tips.get(a.id).review = 'WITHDRAWN';
        if (mode === 'target-duplicate') s.db.decisions.set(a.id, { id: a.id, target_id: 'tip_synthetic_another01', decided_at: f.SUBMITTED });
        expect(await dedup.confirmDuplicate(s.pool, { id: b.id, targetId: a.id, checks })).toMatchObject({ success: false, status: 409 });
        expect(s.db.decisions.has(b.id)).toBe(false); expect(s.client.query.mock.calls.at(-1)[0]).toBe('ROLLBACK');
    });
    test('confirmed subject cannot switch target or create a reverse duplicate cycle', async () => {
        const s = await ready(), { a, b } = await pair(s); await dedup.confirmDuplicate(s.pool, { id: b.id, targetId: a.id, checks });
        expect(await dedup.confirmDuplicate(s.pool, { id: b.id, targetId: 'tip_synthetic_cccc0003', checks })).toMatchObject({ error: 'DUPLICATE_DECISION_CONFLICT' });
        expect(await dedup.confirmDuplicate(s.pool, { id: a.id, targetId: b.id, checks })).toMatchObject({ success: false, status: 409 });
    });
    test.each([
        { source_case_status: 'CLOSED_BY_SOURCE' }, { source_availability: 'UNAVAILABLE' },
        { source_availability: 'ABSENT' }, { source_availability: 'UNVERIFIED' }, { source_blocked: true },
        { source_case_status: null },
    ])('closed/unavailable/unknown source cannot be newly confirmed %#', async state => {
        const s = await ready(), { a, b } = await pair(s); Object.assign(s.db.tips.get(a.id), state);
        expect(await dedup.confirmDuplicate(s.pool, { id: b.id, targetId: a.id, checks })).toMatchObject({ success: false, error: 'SOURCE_NOT_CURRENT_FOR_DUPLICATE', status: 409 });
        expect(s.db.decisions.has(b.id)).toBe(false); expect(s.client.query.mock.calls.at(-1)[0]).toBe('ROLLBACK');
    });
    test.each([null, 0, '', 'invalid-time', new Date(NaN)])('invalid persisted decision timestamp fails explicitly before commit %#', async value => {
        const s = await ready(), { a, b } = await pair(s); s.db.decisionTime = value; s.client.query.mockClear();
        await expect(dedup.confirmDuplicate(s.pool, { id: b.id, targetId: a.id, checks })).rejects.toThrow('INVALID_DUPLICATE_DECISION_STATE');
        expect(s.client.query.mock.calls.at(-1)[0]).toBe('ROLLBACK'); expect(s.client.query.mock.calls.some(([sql]) => sql === 'COMMIT')).toBe(false);
    });
    test('invalid replay decision timestamp fails closed too', async () => {
        const s = await ready(), { a, b } = await pair(s); s.db.decisions.set(b.id, { id: b.id, target_id: a.id, decided_at: 'invalid' });
        await expect(dedup.confirmDuplicate(s.pool, { id: b.id, targetId: a.id, checks })).rejects.toThrow('INVALID_DUPLICATE_DECISION_STATE');
        expect(s.client.query.mock.calls.at(-1)[0]).toBe('ROLLBACK');
    });
    test('unknown pool/invalid ids never become permissive public results', async () => {
        const s = setup(); await expect(dedup.isConfirmedDuplicate(s.pool, 'tip_synthetic_aaaa0001')).rejects.toThrow('REGISTERED_SYNTHETIC_POOL_REQUIRED');
        await dedup.init(s.pool, { syntheticDatabase: true });
        await expect(dedup.isConfirmedDuplicate(s.pool, 'bad')).rejects.toThrow('INVALID_TIP_ID');
        expect(await dedup.listRecommendations(s.pool, 'bad')).toMatchObject({ success: false });
        expect(await dedup.confirmDuplicate(s.pool, { id: 'bad', targetId: 'bad', checks })).toMatchObject({ success: false });
    });
    test('store failures throw for private recommendations, outer acceptance, decisions and public exclusion', async () => {
        const s = await ready(), { a, b } = await pair(s);
        s.db.fail = 'dedup:list'; await expect(dedup.listRecommendations(s.pool, a.id)).rejects.toThrow('SYNTHETIC_STORE_FAILURE');
        s.db.fail = 'dedup:tip'; await expect(dedup.noteAccepted(s.client, b)).rejects.toThrow('SYNTHETIC_STORE_FAILURE');
        s.db.fail = 'dedup:insert-decision'; await expect(dedup.confirmDuplicate(s.pool, { id: b.id, targetId: a.id, checks })).rejects.toThrow('SYNTHETIC_STORE_FAILURE');
        expect(s.client.query.mock.calls.at(-1)[0]).toBe('ROLLBACK');
        s.db.fail = 'SELECT EXISTS'; await expect(dedup.isConfirmedDuplicate(s.pool, a.id)).rejects.toThrow('SYNTHETIC_STORE_FAILURE');
        s.db.fail = null; s.pool.query.mockResolvedValue({ rows: [] }); await expect(dedup.isConfirmedDuplicate(s.pool, a.id)).rejects.toThrow('INVALID_DUPLICATE_EXCLUSION_STATE');
    });
});
