'use strict';
// NEW ISOLATED SYNTHETIC BRIDGE. No timer, patrol change, production DSN, acceptance or publication implementation.
// Runner interface:
//   const bridge = new PgSchedulerBridge({ pool, sourcePolicies, now, syntheticDatabase: true });
//   await bridge.init();
//   await withPgScheduledPass({ bridge, sourceURL, receiverURL, sourceScope, jobId, nativeReceiverVerified: true });
// sourceURL must originate from rehearsal.startLoopback(). receiverURL is the runner's own verified native loopback child.
// Native POST is fixed to /external-rebuild/v1/tips; the existing /v1 auth namespace is never used or bypassed.
// The caller verifies the injected pool is its disposable synthetic PG; this module never reads a DSN or environment.
const { createHash } = require('node:crypto');
const { scheduledPass } = require('../stray-map-intake/rehearsal');
const INTERVAL_MS = 900000;
const identifier = value => typeof value === 'string' && /^synthetic-[a-z0-9-]{1,53}$/.test(value);
const canonicalNow = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

class PgSchedulerBridge {
    constructor({ pool, sourcePolicies, now, syntheticDatabase } = {}) {
        if (syntheticDatabase !== true || !pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') throw new Error('VERIFIED_SYNTHETIC_POOL_REQUIRED');
        if (typeof now !== 'function' || !Array.isArray(sourcePolicies) || !sourcePolicies.length
            || sourcePolicies.some(p => !p || p.verified !== true || !identifier(p.publisherId) || !identifier(p.datasetId)
                || typeof p.origin !== 'string' || !/^https:\/\/[a-z0-9.-]+\.example\.invalid$/.test(p.origin))) throw new Error('SYNTHETIC_SCHEDULER_CONTEXT_REQUIRED');
        this.pool = pool; this.now = now; this.policies = JSON.parse(JSON.stringify(sourcePolicies)); this.initialized = false;
    }
    async init() {
        await this.pool.query(`CREATE SCHEMA IF NOT EXISTS rebuild_external;
            CREATE TABLE IF NOT EXISTS rebuild_external.poll_slots(
              publisher text NOT NULL, dataset text NOT NULL, slot_start timestamptz NOT NULL,
              next_poll_at timestamptz NOT NULL, job_id text NOT NULL,
              PRIMARY KEY(publisher,dataset,slot_start),
              CHECK(next_poll_at = slot_start + interval '15 minutes'))`);
        this.initialized = true;
    }
    policy(scope) {
        const found = this.policies.find(p => p.publisherId === scope?.publisherId && p.datasetId === scope?.datasetId);
        if (!found) throw new Error('UNREGISTERED_SYNTHETIC_SOURCE');
        return found;
    }
    async reservePoll(scope, jobId, minimumIntervalMs = INTERVAL_MS) {
        if (!this.initialized) throw new Error('SCHEDULER_INIT_REQUIRED');
        const policy = this.policy(scope), now = this.now();
        if (!canonicalNow(now)) throw new Error('INVALID_SCHEDULER_CLOCK');
        if (typeof jobId !== 'string' || !/^[a-z0-9-]{3,64}$/.test(jobId) || minimumIntervalMs !== INTERVAL_MS) throw new Error('INVALID_SYNTHETIC_SCHEDULE');
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const key = createHash('sha256').update(JSON.stringify(['stray-map-poll-v1', policy.publisherId, policy.datasetId])).digest('hex');
            await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [key]);
            const previous = (await client.query(`SELECT slot_start,next_poll_at FROM rebuild_external.poll_slots
                WHERE publisher=$1 AND dataset=$2 ORDER BY next_poll_at DESC LIMIT 1`, [policy.publisherId, policy.datasetId])).rows[0];
            if (previous) {
                const until = new Date(previous.next_poll_at).getTime();
                if (!Number.isFinite(until)) throw new Error('INVALID_PERSISTED_POLL_SLOT');
                if (Date.parse(now) < until) { await client.query('COMMIT'); return false; }
            }
            await client.query(`INSERT INTO rebuild_external.poll_slots(publisher,dataset,slot_start,next_poll_at,job_id)
                VALUES($1,$2,$3::timestamptz,$3::timestamptz + interval '15 minutes',$4)`, [policy.publisherId, policy.datasetId, now, jobId]);
            await client.query('COMMIT'); return true;
        } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
        finally { client.release(); }
    }
}

async function withPgScheduledPass({ bridge, sourceURL, receiverURL, sourceScope, jobId = 'synthetic-pg-patrol', nativeReceiverVerified } = {}) {
    if (!(bridge instanceof PgSchedulerBridge)) throw new Error('PG_SCHEDULER_BRIDGE_REQUIRED');
    const policy = bridge.policy(sourceScope);
    if (nativeReceiverVerified !== true) throw new Error('VERIFIED_SYNTHETIC_NATIVE_RECEIVER_REQUIRED');
    const target = new URL(receiverURL);
    if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || !target.port || target.username || target.password
        || target.search || target.hash || target.pathname !== '/') throw new Error('SYNTHETIC_NATIVE_LOOPBACK_ONLY');
    const store = { policies: bridge.policies, supportsSourceEvents: false,
        reservePoll: (id, interval) => bridge.reservePoll(policy, id, interval),
        // This bridge only persists scheduling slots. Do not pretend to implement source-close/outage publication state.
        sourceAvailability: async () => ({ success: true, applied: false, reason: 'SOURCE_LIFECYCLE_NOT_IMPLEMENTED_BY_SCHEDULER' }) };
    const result = await scheduledPass({ store, sourceURL, receiverURL: target.origin, sourceScope: policy, jobId,
        minimumIntervalMs: INTERVAL_MS, receiverPath: '/external-rebuild/v1/tips',
        receiverRegistration: { origin: target.origin, synthetic: true, purpose: 'STRAY_MAP_ISOLATED_NATIVE' } });
    return { ...result, simulation: true, scheduler: 'EXISTING_REHEARSAL_SCHEDULED_PASS', pollState: 'PG_APPEND_ONLY_SLOTS', sourceLifecycleImplemented: false };
}
module.exports = { PgSchedulerBridge, withPgScheduledPass, INTERVAL_MS };
