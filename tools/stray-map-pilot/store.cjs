'use strict';
// TEXT_COARSE_PENDING_V1 persistence only. Pool ownership is verified by the host; no DSN/config/credential lookup.
const { randomUUID, createHash } = require('node:crypto');
const hash = value => createHash('sha256').update(value).digest('hex');
class PilotError extends Error {
    constructor(code, status = 503) { super(code); this.code = code; this.status = status; }
}
function receiptOK(receipt, id) {
    if (!receipt || Object.keys(receipt).sort().join(',') !== 'publicVisible,status,submittedAt,success,tipId'
        || receipt.success !== true || receipt.status !== 'PENDING' || receipt.publicVisible !== false
        || typeof receipt.tipId !== 'string' || !/^tip_[a-f0-9]{32}$/.test(receipt.tipId) || (id && receipt.tipId !== id)
        || typeof receipt.submittedAt !== 'string' || !Number.isFinite(Date.parse(receipt.submittedAt))
        || new Date(receipt.submittedAt).toISOString() !== receipt.submittedAt) throw new PilotError('PILOT_STORE_UNAVAILABLE');
    return receipt;
}
function privateReceipt(row, id) {
    const receipt = receiptOK(row?.receipt, id);
    // Persist the original receipt shape for rollback. The first audit event distinguishes private intake from publication approval.
    return row.first_decision === 'ACCEPT_PRIVATE' ? { ...receipt, status: 'ACCEPTED_PRIVATE' } : receipt;
}
function createStore({ pool }) {
    let initialized;
    const queryable = () => {
        if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') throw new PilotError('PILOT_STORE_UNAVAILABLE');
        const o = pool.options;
        if (!o || !Number.isSafeInteger(o.connectionTimeoutMillis) || o.connectionTimeoutMillis < 1 || o.connectionTimeoutMillis > 3000
            || !Number.isSafeInteger(o.statement_timeout) || o.statement_timeout < 1 || o.statement_timeout > 5000
            || !Number.isSafeInteger(o.query_timeout) || o.query_timeout <= o.statement_timeout || o.query_timeout > 6000) throw new PilotError('BOUNDED_PILOT_POOL_REQUIRED');
        return o;
    };
    async function withClient(assertOpen, work) {
        assertOpen(); const options = queryable(), client = await pool.connect(); let broken = false;
        try {
            await client.query('BEGIN');
            await client.query(`SET LOCAL lock_timeout = '${Math.min(1000, options.statement_timeout)}ms'; SET LOCAL statement_timeout = '${options.statement_timeout}ms'`);
            const result = await work(client); assertOpen(); await client.query('COMMIT'); return result;
        } catch (error) {
            try { await client.query('ROLLBACK'); } catch { broken = true; }
            throw error;
        } finally { client.release(broken ? new Error('PILOT_CONNECTION_DISCARDED') : undefined); }
    }
    async function init(assertOpen) {
        assertOpen(); queryable();
        if (!initialized) initialized = withClient(assertOpen, client => client.query(`CREATE SCHEMA IF NOT EXISTS stray_text_pilot;
            CREATE TABLE IF NOT EXISTS stray_text_pilot.tips(
              id text PRIMARY KEY,publisher text NOT NULL,dataset text NOT NULL,record_key text NOT NULL,
              payload_hash text NOT NULL,payload jsonb NOT NULL,receipt jsonb NOT NULL,
              review text NOT NULL DEFAULT 'PENDING' CHECK(review IN ('PENDING','APPROVED','REJECTED','WITHDRAWN')),
              public_content jsonb,created_at timestamptz NOT NULL,review_events jsonb NOT NULL DEFAULT '[]',
              UNIQUE(publisher,dataset,record_key));
            CREATE TABLE IF NOT EXISTS stray_text_pilot.requests(
              publisher text NOT NULL,dataset text NOT NULL,request_key text NOT NULL,payload_hash text NOT NULL,
              tip_id text NOT NULL REFERENCES stray_text_pilot.tips(id),PRIMARY KEY(publisher,request_key));
            CREATE UNIQUE INDEX IF NOT EXISTS pilot_requests_publisher_key ON stray_text_pilot.requests(publisher,request_key)`))
            .catch(() => { initialized = undefined; throw new PilotError('PILOT_STORE_UNAVAILABLE'); });
        await initialized; assertOpen();
    }
    async function transaction(assertOpen, work) {
        await init(assertOpen); return withClient(assertOpen, work);
    }
    async function accept({ payload, payloadHash, key, source, submittedAt, limits, autoAcceptPrivate = false, assertOpen }) {
        return transaction(assertOpen, async client => {
            await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['TEXT_COARSE_PENDING_V1:queue']);
            const scope = [source.publisherId, source.datasetId];
            const replay = (await client.query(`/* pilot:replay */ SELECT r.dataset,r.payload_hash,t.receipt,t.review_events->0->>'decision' AS first_decision FROM stray_text_pilot.requests r
                JOIN stray_text_pilot.tips t ON t.id=r.tip_id WHERE r.publisher=$1 AND r.request_key=$2`, [source.publisherId, key])).rows[0];
            if (replay) {
                if (replay.dataset !== source.datasetId || replay.payload_hash !== payloadHash) throw new PilotError('IDEMPOTENCY_CONFLICT', 409);
                return { success: true, receipt: privateReceipt(replay), replay: true };
            }
            const prior = (await client.query(`/* pilot:prior */ SELECT id,payload_hash,receipt,review_events->0->>'decision' AS first_decision FROM stray_text_pilot.tips
                WHERE publisher=$1 AND dataset=$2 AND record_key=$3`, [...scope, payload.source.recordKey])).rows[0];
            if (prior && prior.payload_hash !== payloadHash) throw new PilotError('SOURCE_RECORD_CONFLICT', 409);
            const counts = (await client.query(`/* pilot:counts */ SELECT
                (SELECT count(*)::int FROM stray_text_pilot.tips) cases,
                (SELECT count(*)::int FROM stray_text_pilot.tips WHERE review='PENDING') pending,
                (SELECT count(*)::int FROM stray_text_pilot.requests) requests,
                (SELECT count(*)::int FROM stray_text_pilot.tips WHERE publisher=$1 AND dataset=$2
                  AND created_at > $3::timestamptz-interval '1 hour') recent`, [...scope, submittedAt])).rows[0];
            if (!counts || !['cases','pending','requests','recent'].every(k => Number.isSafeInteger(counts[k]) && counts[k] >= 0)) throw new PilotError('PILOT_STORE_UNAVAILABLE');
            if (counts.requests >= limits.maxRequests || (!prior && (counts.cases >= limits.maxCases || counts.pending >= limits.maxPending))) throw new PilotError('PILOT_CAPACITY', 503);
            if (!prior && counts.recent >= limits.perSourceHour) throw new PilotError('SOURCE_RATE_LIMIT', 429);
            const id = prior?.id || `tip_${randomUUID().replaceAll('-', '')}`;
            let row = prior;
            if (!row) {
                const proposed = { success: true, tipId: id, status: 'PENDING', publicVisible: false, submittedAt };
                const events = autoAcceptPrivate ? [{ decision: 'ACCEPT_PRIVATE', at: submittedAt }] : [];
                row = (await client.query(`/* pilot:insert */ INSERT INTO stray_text_pilot.tips
                    (id,publisher,dataset,record_key,payload_hash,payload,receipt,created_at,review,review_events)
                    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
                    RETURNING receipt,review_events->0->>'decision' AS first_decision`,
                [id, ...scope, payload.source.recordKey, payloadHash, payload, proposed, submittedAt,
                    autoAcceptPrivate ? 'APPROVED' : 'PENDING', JSON.stringify(events)])).rows[0];
            }
            const receipt = privateReceipt(row, id);
            await client.query('/* pilot:key */ INSERT INTO stray_text_pilot.requests VALUES($1,$2,$3,$4,$5)', [...scope, key, payloadHash, id]);
            return { success: true, receipt, replay: !!prior };
        });
    }
    async function receipt({ id, source, assertOpen }) {
        await init(assertOpen);
        const row = (await pool.query(`/* pilot:receipt */ SELECT receipt,review,review_events->0->>'decision' AS first_decision FROM stray_text_pilot.tips
            WHERE id=$1 AND publisher=$2 AND dataset=$3`, [id, source.publisherId, source.datasetId])).rows[0];
        if (!row) throw new PilotError('NOT_FOUND', 404);
        const receipt = privateReceipt(row);
        if (!['PENDING','APPROVED','REJECTED','WITHDRAWN'].includes(row.review)) throw new PilotError('PILOT_STORE_UNAVAILABLE');
        assertOpen();
        return { success: true, receipt, review: row.review === 'APPROVED' && receipt.status === 'ACCEPTED_PRIVATE' ? receipt.status : row.review };
    }
    async function review({ id, decision, reviewer, at, validate, assertOpen }) {
        return transaction(assertOpen, async client => {
            const row = (await client.query('/* pilot:review-row */ SELECT * FROM stray_text_pilot.tips WHERE id=$1 FOR UPDATE', [id])).rows[0];
            if (!row) throw new PilotError('NOT_FOUND', 404);
            if (decision === 'WITHDRAW' && row.review === 'WITHDRAWN') return { success: true, tipId: id, status: 'WITHDRAWN' };
            if (decision !== 'WITHDRAW' && row.review !== 'PENDING') throw new PilotError('REVIEW_TERMINAL', 409);
            const display = decision === 'APPROVE' ? validate(row) : row.public_content;
            const status = { APPROVE: 'APPROVED', REJECT: 'REJECTED', WITHDRAW: 'WITHDRAWN' }[decision];
            await client.query(`/* pilot:review-update */ UPDATE stray_text_pilot.tips SET review=$2,public_content=$3,
                review_events=review_events||$4::jsonb WHERE id=$1`, [id, status, display,
                JSON.stringify([{ decision, at, reviewerHash: hash(reviewer.reviewerId) }])]);
            return { success: true, tipId: id, status };
        });
    }
    async function cards({ scopes, limit, assertOpen }) {
        await init(assertOpen);
        const rows = (await pool.query(`/* pilot:cards */ SELECT id,publisher,dataset,payload_hash,payload,public_content FROM stray_text_pilot.tips
            WHERE review='APPROVED' AND public_content IS NOT NULL AND publisher||':'||dataset=ANY($1::text[])
            ORDER BY created_at,id LIMIT $2`, [scopes, limit + 1])).rows;
        assertOpen(); return rows;
    }
    return { init, accept, receipt, review, cards };
}
module.exports = { createStore, PilotError };
