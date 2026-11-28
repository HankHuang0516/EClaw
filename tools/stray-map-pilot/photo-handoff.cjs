'use strict';

const { timingSafeEqual } = require('node:crypto');
const { sha } = require('./photo-contract.cjs');
const { PilotError } = require('./store.cjs');

const HANDOFF_ID = /^[a-f0-9]{32}$/;
const SECRET = /^[a-f0-9]{64}$/;
const HANDOFF_MS = 240000;

function proofMatches(row, proof) {
    return typeof proof === 'string' && SECRET.test(proof)
        && timingSafeEqual(Buffer.from(sha(proof), 'hex'), Buffer.from(row.secret_hash, 'hex'));
}

function contentMatches(row, proof, bytes) {
    return Buffer.isBuffer(bytes) && sha(Buffer.concat([Buffer.from(proof, 'hex'), bytes])) === row.content_hash;
}

function matchesWorker(row, worker) {
    return row.run_id === worker.runId && row.secret_hash === worker.secretHash && row.content_hash === worker.contentHash;
}

function createHandoffs(pool, ready) {
    async function open(worker, at) {
        await ready();
        const client = await pool.connect();
        let broken;
        try {
            await client.query('BEGIN');
            await client.query("SET LOCAL lock_timeout='1000ms'; SET LOCAL statement_timeout='3000ms'");
            await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['stray-dot-photo-handoffs']);
            await client.query('DELETE FROM stray_dot_photo_v1.handoffs WHERE expires_at <= $1', [at]);
            const prior = (await client.query(`SELECT run_id, secret_hash, content_hash, expires_at FROM stray_dot_photo_v1.handoffs
                WHERE id=$1`, [worker.id])).rows[0];
            if (prior) {
                if (!matchesWorker(prior, worker)) throw new PilotError('PHOTO_HANDOFF_CONFLICT', 409);
                await client.query('COMMIT');
                return prior.expires_at;
            }
            const count = (await client.query('SELECT count(*)::int n FROM stray_dot_photo_v1.handoffs')).rows[0].n;
            if (count >= 3) throw new PilotError('PHOTO_HANDOFF_BUSY', 429);
            const expires = new Date(Date.parse(at) + HANDOFF_MS).toISOString();
            await client.query(`INSERT INTO stray_dot_photo_v1.handoffs(id,run_id,secret_hash,content_hash,expires_at)
                VALUES($1,$2,$3,$4,$5)`, [worker.id, worker.runId, worker.secretHash, worker.contentHash, expires]);
            await client.query('COMMIT');
            return expires;
        } catch (error) {
            try { await client.query('ROLLBACK'); } catch (_) { broken = error; }
            throw error;
        } finally { client.release(broken); }
    }

    async function find(id, at, withPayload = false) {
        await ready();
        return (await pool.query(`SELECT id,run_id,secret_hash,content_hash,expires_at,result,
            candidate IS NOT NULL AS staged${withPayload ? ', candidate, image' : ''}
            FROM stray_dot_photo_v1.handoffs WHERE id=$1 AND expires_at>$2`, [id, at])).rows[0];
    }

    async function stage(row, at, candidate, image) {
        const updated = await pool.query(`UPDATE stray_dot_photo_v1.handoffs SET candidate=$3,image=$4
            WHERE id=$1 AND expires_at>$2 AND candidate IS NULL AND result IS NULL RETURNING id`,
        [row.id, at, candidate, image]);
        return updated.rowCount > 0;
    }

    async function finish(row, result) {
        const updated = await pool.query(`UPDATE stray_dot_photo_v1.handoffs SET result=COALESCE(result,$2),candidate=NULL,image=NULL
            WHERE id=$1 AND run_id=$3 RETURNING result`, [row.id, result, row.run_id]);
        return updated.rows[0]?.result || result;
    }

    async function purge(at) {
        await ready();
        await pool.query('DELETE FROM stray_dot_photo_v1.handoffs WHERE expires_at <= $1', [at]);
    }

    return { open, find, stage, finish, purge };
}

module.exports = { HANDOFF_ID, SECRET, proofMatches, contentMatches, matchesWorker, createHandoffs };
