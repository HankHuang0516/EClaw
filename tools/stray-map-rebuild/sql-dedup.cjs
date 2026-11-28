'use strict';
// ISOLATED SYNTHETIC PG ONLY. No route, native row/device, automatic merge, approval or reunion.
// await init(pool) AFTER pending tips/source-state schema initialization. Calling init attests the pool is disposable/synthetic.
// The runner verifies pool ownership; no DSN/environment or credential lookup is performed here.
// await noteAccepted(client, { id,publisher,dataset,recordKey,payloadHash,candidateFingerprint,payload,now })
// INSIDE the existing READ COMMITTED acceptance transaction, new cases only, before COMMIT.
// client must come from that verified pool. This function never opens/commits/rolls back its caller's transaction.
// listRecommendations is PRIVATE. confirmDuplicate requires operator-owned checks, never source/body flags.
// Main must AND visibleSQL('t') into EVERY public projection/photo query, or call isConfirmedDuplicate.
// All PG failures throw: callers must roll back acceptance or fail the public read closed.
const { createHash } = require('node:crypto');
const { temporal, temporalBounds, reportSemantics } = require('../stray-map-intake/contract');
const LIMITS = Object.freeze({ perTip: 100, links: 2000, cases: 2000 });
const registered = new WeakSet();
const ID = /^tip_[A-Za-z0-9_-]{8,64}$/;
const SHA = /^[a-f0-9]{64}$/;
const SOURCE = /^synthetic-[a-z0-9-]{1,53}$/;
const MANUAL_CHECKS = ['sameCaseConfirmed', 'sourceVerified', 'privacyReviewed'];
const fail = (error, status = 400) => ({ success: false, error, status });
const stable = value => Array.isArray(value) ? `[${value.map(stable).join(',')}]` : value && typeof value === 'object'
    ? `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}` : JSON.stringify(value);
const hash = value => createHash('sha256').update(stable(value)).digest('hex');
const validID = id => typeof id === 'string' && ID.test(id);
function requirePool(pool) { if (!pool || !registered.has(pool)) throw new Error('REGISTERED_SYNTHETIC_POOL_REQUIRED'); }
function iso(value) {
    const d = new Date(value);
    return typeof value === 'string' && Number.isFinite(+d) && d.toISOString() === value;
}
async function lock(client, value) {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [hash(['stray-dedup-v1', value])]);
}
async function init(pool, { syntheticDatabase = true } = {}) {
    if (syntheticDatabase !== true || !pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') throw new Error('VERIFIED_SYNTHETIC_POOL_REQUIRED');
    await pool.query(`CREATE SCHEMA IF NOT EXISTS rebuild_external;
        CREATE TABLE IF NOT EXISTS rebuild_external.dedup_cases(
          id text PRIMARY KEY REFERENCES rebuild_external.tips(id), payload_hash text NOT NULL,
          source_scope_hash text NOT NULL, fingerprint text, report_type text NOT NULL, kind text NOT NULL,
          country text NOT NULL, region text, safe boolean NOT NULL, observed_min bigint, observed_max bigint,
          accepted_at timestamptz NOT NULL, truncated boolean NOT NULL DEFAULT false);
        CREATE INDEX IF NOT EXISTS dedup_cases_fingerprint ON rebuild_external.dedup_cases(fingerprint);
        CREATE TABLE IF NOT EXISTS rebuild_external.candidate_links(
          left_id text NOT NULL REFERENCES rebuild_external.dedup_cases(id), right_id text NOT NULL REFERENCES rebuild_external.dedup_cases(id),
          kind text NOT NULL CHECK(kind IN ('SUSPECTED_DUPLICATE','LOST_FOUND_SUGGESTION')), created_at timestamptz NOT NULL,
          PRIMARY KEY(left_id,right_id,kind), CHECK(left_id<right_id));
        CREATE TABLE IF NOT EXISTS rebuild_external.duplicate_decisions(
          id text PRIMARY KEY REFERENCES rebuild_external.dedup_cases(id), target_id text NOT NULL REFERENCES rebuild_external.dedup_cases(id),
          decided_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP, CHECK(id<>target_id))`);
    registered.add(pool);
    return { success: true, simulation: true };
}
function metadata(data) {
    const { id, publisher, dataset, recordKey, payloadHash, candidateFingerprint, payload: p, now } = data || {};
    if (!validID(id) || typeof publisher !== 'string' || !SOURCE.test(publisher) || typeof dataset !== 'string' || !SOURCE.test(dataset)
        || typeof recordKey !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(recordKey)
        || typeof payloadHash !== 'string' || !SHA.test(payloadHash) || !iso(now)
        || !p || ![2, 3].includes(p.schemaVersion) || p.thirdParty !== true || p.selfWitness !== false
        || p.source?.publisherId !== publisher || p.source?.datasetId !== dataset || p.source?.recordKey !== recordKey
        || Buffer.byteLength(JSON.stringify(p)) > 16384 || hash(p) !== payloadHash) throw new Error('INVALID_ACCEPTED_DEDUP_CONTEXT');
    const observed = temporal(p.observation), report = reportSemantics(p);
    if (!observed || !['LOST', 'FOUND', 'SIGHTING', 'UNSPECIFIED_LEGACY'].includes(report?.type)
        || !['DOG', 'CAT', 'OTHER_STRAY', 'WILDLIFE'].includes(p.animal?.kind)
        || typeof p.location?.countryCode !== 'string' || !/^[A-Z]{2}$/.test(p.location.countryCode)) throw new Error('INVALID_ACCEPTED_DEDUP_CONTEXT');
    const safe = p.animal.kind !== 'WILDLIFE' && p.location.sensitivity === 'NONE' && typeof p.location.regionCode === 'string'
        && /^[A-Z]{2}-[A-Z0-9]{1,3}$/.test(p.location.regionCode) && p.location.regionCode.startsWith(`${p.location.countryCode}-`);
    // temporal() has already verified INSTANT local fields against its IANA zone. Preserve that local day, including year 0000.
    const day = observed.precision === 'DATE' ? observed.value : observed.precision === 'INSTANT' ? observed.value.slice(0, 10) : null;
    const fingerprint = !safe || day === null ? null : p.schemaVersion === 2
        ? hash(['stray-case-v2', p.animal.kind, p.location.countryCode, p.location.regionCode, day])
        : hash(['stray-case-v3', p.animal.kind, report.type, p.location.countryCode, p.location.regionCode, day]);
    if (candidateFingerprint !== fingerprint) throw new Error('CANDIDATE_FINGERPRINT_MISMATCH');
    const range = temporalBounds(observed);
    return { id, payload_hash: payloadHash, source_scope_hash: hash([publisher, dataset]), fingerprint, report_type: report.type,
        kind: p.animal.kind, country: p.location.countryCode, region: p.location.regionCode, safe,
        observed_min: range?.[0] ?? null, observed_max: range?.[1] ?? null, accepted_at: now };
}
function linkKind(a, b) {
    if (!a.safe || !b.safe || a.source_scope_hash === b.source_scope_hash || a.kind !== b.kind || a.country !== b.country || a.region !== b.region) return null;
    if (a.fingerprint !== null && a.fingerprint === b.fingerprint && a.report_type === b.report_type) return 'SUSPECTED_DUPLICATE';
    if (!((a.report_type === 'LOST' && b.report_type === 'FOUND') || (b.report_type === 'LOST' && a.report_type === 'FOUND'))) return null;
    const lost = a.report_type === 'LOST' ? a : b, found = a.report_type === 'FOUND' ? a : b;
    return lost.observed_min !== null && found.observed_max !== null && Number(lost.observed_min) > Number(found.observed_max) ? null : 'LOST_FOUND_SUGGESTION';
}
async function recommendations(client, id) {
    const rows = (await client.query(`/* dedup:list */ SELECT l.left_id,l.right_id,l.kind FROM rebuild_external.candidate_links l
        JOIN rebuild_external.tips a ON a.id=l.left_id JOIN rebuild_external.tips b ON b.id=l.right_id
        WHERE (l.left_id=$1 OR l.right_id=$1) AND a.review IN ('PENDING','APPROVED') AND b.review IN ('PENDING','APPROVED')
          AND a.map_policy!='NEVER' AND b.map_policy!='NEVER'
          AND NOT EXISTS(SELECT 1 FROM rebuild_external.duplicate_decisions d WHERE d.id IN (l.left_id,l.right_id))
        ORDER BY l.left_id,l.right_id,l.kind LIMIT 100`, [id])).rows;
    const state = (await client.query('/* dedup:state */ SELECT truncated FROM rebuild_external.dedup_cases WHERE id=$1', [id])).rows[0];
    if (!state || typeof state.truncated !== 'boolean') throw new Error('INVALID_DEDUP_RECOMMENDATION_STATE');
    return { success: true, id, manualOnly: true, publicVisible: false, truncated: state?.truncated === true, limits: LIMITS,
        candidates: rows.map(row => ({ candidateId: row.left_id === id ? row.right_id : row.left_id, kind: row.kind,
            manualOnly: true, reunionVerified: false })) };
}
async function noteAccepted(client, data) {
    if (!client || typeof client.query !== 'function') throw new Error('ACCEPTANCE_TRANSACTION_CLIENT_REQUIRED');
    const meta = metadata(data);
    // Global capacity serialization also covers simultaneous LOST/FOUND (which deliberately have distinct fingerprints).
    await lock(client, 'capacity');
    await lock(client, meta.fingerprint || ['matching-region', meta.kind, meta.country, meta.region]);
    const stored = (await client.query('/* dedup:tip */ SELECT id,publisher,dataset,record_key,payload_hash,payload FROM rebuild_external.tips WHERE id=$1', [meta.id])).rows[0];
    if (!stored || stored.publisher !== data.publisher || stored.dataset !== data.dataset || stored.record_key !== data.recordKey
        || stored.payload_hash !== meta.payload_hash || hash(stored.payload) !== meta.payload_hash) throw new Error('ACCEPTED_TIP_NOT_PERSISTED');
    const prior = (await client.query('/* dedup:case */ SELECT payload_hash FROM rebuild_external.dedup_cases WHERE id=$1', [meta.id])).rows[0];
    if (prior) { if (prior.payload_hash !== meta.payload_hash) throw new Error('DEDUP_CASE_CONFLICT'); return recommendations(client, meta.id); }
    const counts = (await client.query(`/* dedup:counts */ SELECT
        (SELECT count(*)::int FROM rebuild_external.dedup_cases) cases,
        (SELECT count(*)::int FROM rebuild_external.candidate_links) links`)).rows[0];
    if (!counts || !Number.isSafeInteger(counts.cases) || !Number.isSafeInteger(counts.links) || counts.cases < 0 || counts.links < 0) throw new Error('INVALID_DEDUP_COUNTS');
    if (counts.cases >= LIMITS.cases) throw new Error('DEDUP_CASE_CAPACITY');
    await client.query(`/* dedup:insert-case */ INSERT INTO rebuild_external.dedup_cases
        (id,payload_hash,source_scope_hash,fingerprint,report_type,kind,country,region,safe,observed_min,observed_max,accepted_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, Object.values(meta));
    let used = 0, truncated = false;
    if (meta.safe) {
        const candidates = (await client.query(`/* dedup:candidates */ SELECT c.*,
            (SELECT count(*)::int FROM rebuild_external.candidate_links l WHERE l.left_id=c.id OR l.right_id=c.id) link_count
            FROM rebuild_external.dedup_cases c JOIN rebuild_external.tips t ON t.id=c.id
            WHERE c.id!=$1 AND c.source_scope_hash!=$2 AND c.safe AND c.kind=$3 AND c.country=$4 AND c.region=$5
              AND (c.fingerprint=$6 OR (c.report_type='LOST' AND $7='FOUND') OR (c.report_type='FOUND' AND $7='LOST'))
              AND t.review IN ('PENDING','APPROVED') AND t.map_policy!='NEVER'
              AND NOT EXISTS(SELECT 1 FROM rebuild_external.duplicate_decisions d WHERE d.id=c.id)
            ORDER BY c.id LIMIT 101`, [meta.id, meta.source_scope_hash, meta.kind, meta.country, meta.region, meta.fingerprint, meta.report_type])).rows;
        truncated = candidates.length > LIMITS.perTip;
        for (const candidate of candidates.slice(0, LIMITS.perTip)) {
            const kind = linkKind(meta, candidate); if (!kind) continue;
            if (!Number.isSafeInteger(candidate.link_count) || candidate.link_count < 0) throw new Error('INVALID_DEDUP_COUNTS');
            if (counts.links + used >= LIMITS.links || candidate.link_count >= LIMITS.perTip) { truncated = true; continue; }
            const [left, right] = [meta.id, candidate.id].sort();
            await client.query(`/* dedup:insert-link */ INSERT INTO rebuild_external.candidate_links(left_id,right_id,kind,created_at)
                VALUES($1,$2,$3,$4)`, [left, right, kind, data.now]); used++;
        }
    }
    await client.query('/* dedup:truncated */ UPDATE rebuild_external.dedup_cases SET truncated=$2 WHERE id=$1', [meta.id, truncated]);
    return recommendations(client, meta.id);
}
async function listRecommendations(pool, id) {
    requirePool(pool); if (!validID(id)) return fail('INVALID_TIP_ID');
    return recommendations(pool, id);
}
function decisionDTO(row) {
    if (!row || !validID(row.id) || !validID(row.target_id)
        || !(row.decided_at instanceof Date || typeof row.decided_at === 'string')) throw new Error('INVALID_DUPLICATE_DECISION_STATE');
    const ms = row.decided_at instanceof Date ? Date.prototype.getTime.call(row.decided_at) : Date.parse(row.decided_at);
    if (!Number.isFinite(ms)) throw new Error('INVALID_DUPLICATE_DECISION_STATE');
    return { id: row.id, targetId: row.target_id, decidedAt: new Date(ms).toISOString(), manualOnly: true, reunionVerified: false };
}
async function confirmDuplicate(pool, { id, targetId, checks } = {}) {
    requirePool(pool);
    if (!validID(id) || !validID(targetId) || id === targetId) return fail('INVALID_DUPLICATE_TARGET');
    if (!checks || Object.getPrototypeOf(checks) !== Object.prototype
        || !MANUAL_CHECKS.every(key => Object.hasOwn(checks, key) && checks[key] === true)) return fail('MANUAL_DUPLICATE_CHECKS_REQUIRED', 403);
    const client = await pool.connect();
    try {
        await client.query('BEGIN'); await lock(client, 'capacity');
        const prior = (await client.query('/* dedup:decision */ SELECT id,target_id,decided_at FROM rebuild_external.duplicate_decisions WHERE id=$1', [id])).rows[0];
        if (prior) {
            if (prior.target_id !== targetId) { await client.query('COMMIT'); return fail('DUPLICATE_DECISION_CONFLICT', 409); }
            const decision = decisionDTO(prior); await client.query('COMMIT');
            return { success: true, replay: true, projectionExcluded: true, decision };
        }
        const rows = (await client.query(`/* dedup:decision-cases */ SELECT c.*,t.review,t.source_case_status,t.source_availability,
            EXISTS(SELECT 1 FROM rebuild_external.source_gates sg
              WHERE sg.publisher=t.publisher AND sg.dataset=t.dataset AND sg.blocked=true) source_blocked
            FROM rebuild_external.dedup_cases c
            JOIN rebuild_external.tips t ON t.id=c.id WHERE c.id=ANY($1::text[]) ORDER BY c.id FOR UPDATE OF t`, [[id, targetId]])).rows;
        const a = rows.find(row => row.id === id), b = rows.find(row => row.id === targetId);
        if (!a || !b || !['PENDING','APPROVED'].includes(a.review) || !['PENDING','APPROVED'].includes(b.review)
            || linkKind(a, b) !== 'SUSPECTED_DUPLICATE') { await client.query('ROLLBACK'); return fail('NOT_SAME_DUPLICATE_CANDIDATE', 409); }
        if (![a, b].every(row => row.source_case_status === 'NOT_CONFIRMED_CLOSED' && row.source_availability === 'PRESENT' && row.source_blocked === false)) {
            await client.query('ROLLBACK'); return fail('SOURCE_NOT_CURRENT_FOR_DUPLICATE', 409);
        }
        const existingTarget = (await client.query('/* dedup:decision */ SELECT id,target_id,decided_at FROM rebuild_external.duplicate_decisions WHERE id=$1', [targetId])).rows[0];
        const [left, right] = [id, targetId].sort();
        const link = (await client.query(`/* dedup:confirm-link */ SELECT 1 FROM rebuild_external.candidate_links
            WHERE left_id=$1 AND right_id=$2 AND kind='SUSPECTED_DUPLICATE'`, [left, right])).rows[0];
        if (existingTarget || !link) { await client.query('ROLLBACK'); return fail('INVALID_DUPLICATE_TARGET', 409); }
        const row = (await client.query(`/* dedup:insert-decision */ INSERT INTO rebuild_external.duplicate_decisions(id,target_id)
            VALUES($1,$2) RETURNING id,target_id,decided_at`, [id, targetId])).rows[0];
        if (!row) throw new Error('DUPLICATE_DECISION_NOT_PERSISTED');
        const decision = decisionDTO(row); await client.query('COMMIT');
        return { success: true, replay: false, projectionExcluded: true, decision };
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; } finally { client.release(); }
}
async function isConfirmedDuplicate(pool, id) {
    requirePool(pool); if (!validID(id)) throw new Error('INVALID_TIP_ID');
    const row = (await pool.query('SELECT EXISTS(SELECT 1 FROM rebuild_external.duplicate_decisions WHERE id=$1) excluded', [id])).rows[0];
    if (!row || typeof row.excluded !== 'boolean') throw new Error('INVALID_DUPLICATE_EXCLUSION_STATE');
    return row.excluded;
}
function visibleSQL(alias = 't') {
    if (typeof alias !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(alias)) throw new Error('INVALID_DEDUP_SQL_ALIAS');
    const inner = alias.toLowerCase() === '_rebuild_dup_hidden' ? '_rebuild_dup_hidden_2' : '_rebuild_dup_hidden';
    return `NOT EXISTS (SELECT 1 FROM rebuild_external.duplicate_decisions ${inner} WHERE ${inner}.id=${alias}.id)`;
}
module.exports = { init, noteAccepted, listRecommendations, confirmDuplicate, isConfirmedDuplicate, visibleSQL, LIMITS };
