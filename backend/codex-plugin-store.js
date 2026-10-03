'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class CodexPluginStore {
    constructor(pool) { this.pool = pool; }

    async initDatabase() {
        const sql = fs.readFileSync(path.join(__dirname, 'codex-plugin-schema.sql'), 'utf8');
        for (const statement of sql.split(';').filter(s => s.trim())) await this.pool.query(statement);
    }

    async binding(id) {
        return (await this.pool.query('SELECT * FROM codex_plugin_bindings WHERE id=$1', [id])).rows[0];
    }

    async list(deviceId) {
        return (await this.pool.query('SELECT * FROM codex_plugin_bindings WHERE device_id=$1 ORDER BY created_at', [deviceId])).rows;
    }

    async begin(deviceId, requestId, config) {
        const id = crypto.randomUUID();
        const inserted = await this.pool.query(
            `INSERT INTO codex_plugin_bindings (id,device_id,request_id,config,created_at)
             VALUES ($1,$2,$3,$4,$5) ON CONFLICT (device_id,request_id) DO NOTHING RETURNING *`,
            [id, deviceId, requestId, JSON.stringify(config), Date.now()]);
        if (inserted.rows[0]) return inserted.rows[0];
        return (await this.pool.query('SELECT * FROM codex_plugin_bindings WHERE device_id=$1 AND request_id=$2', [deviceId, requestId])).rows[0];
    }

    async provisionAccount(id, deviceId) {
        // Create the account and attach it in ONE transaction. An uncertain
        // commit can be recovered by reading the binding; no orphan HTTP
        // provisioning result needs to be guessed on retry.
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const current = (await client.query('SELECT * FROM codex_plugin_bindings WHERE id=$1 AND device_id=$2 FOR UPDATE', [id, deviceId])).rows[0];
            if (!current || current.disconnected) throw Object.assign(new Error('Connection unavailable'), { status: 409 });
            if (!current.channel_account_id) {
                const account = (await client.query(
                    `INSERT INTO channel_accounts (device_id,channel_api_key,channel_api_secret,created_at,updated_at)
                     VALUES ($1,$2,$3,$4,$4) RETURNING id`,
                    [deviceId, `eck_${crypto.randomBytes(32).toString('hex')}`, `ecs_${crypto.randomBytes(32).toString('hex')}`, Date.now()])).rows[0];
                if (!account) throw new Error('Channel account unavailable');
                await client.query('UPDATE codex_plugin_bindings SET channel_account_id=$2 WHERE id=$1', [id, account.id]);
            }
            await client.query('COMMIT');
        } catch (error) {
            await client.query('ROLLBACK').catch(() => {});
            throw error;
        } finally { client.release(); }
    }

    async setEntity(id, entityId) {
        await this.pool.query('UPDATE codex_plugin_bindings SET entity_id=$2 WHERE id=$1', [id, entityId]);
    }

    async configure(id, config) {
        await this.pool.query('UPDATE codex_plugin_bindings SET config=$2 WHERE id=$1', [id, JSON.stringify(config)]);
    }

    async enroll(bindingId, tokenHash, threadId, workspace) {
        const result = await this.pool.query(
            `INSERT INTO codex_plugin_enrollments (id,binding_id,token_hash,thread_id,workspace,expires_at)
             VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (binding_id,token_hash) DO NOTHING RETURNING *`,
            [crypto.randomUUID(), bindingId, tokenHash, threadId, workspace, Date.now() + 10 * 60 * 1000]);
        if (result.rows[0]) return result.rows[0];
        return (await this.pool.query('SELECT * FROM codex_plugin_enrollments WHERE binding_id=$1 AND token_hash=$2', [bindingId, tokenHash])).rows[0];
    }

    async enrollment(id, bindingId) {
        return (await this.pool.query('SELECT * FROM codex_plugin_enrollments WHERE id=$1 AND binding_id=$2', [id, bindingId])).rows[0];
    }

    async approve(binding, enrollment) {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const claimed = await client.query(
                `UPDATE codex_plugin_enrollments SET approved=TRUE
                 WHERE id=$1 AND binding_id=$2 AND approved=FALSE AND expires_at>$3 RETURNING *`,
                [enrollment.id, binding.id, Date.now()]);
            if (!claimed.rows.length) throw Object.assign(new Error('Enrollment expired or already approved'), { status: 409 });
            await client.query(
                `UPDATE codex_plugin_bindings SET runtime_token_hash=$2,runtime_state='offline',heartbeat_at=NULL
                 WHERE id=$1 AND disconnected=FALSE`, [binding.id, enrollment.token_hash]);
            await client.query('COMMIT');
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally { client.release(); }
    }

    async heartbeat(id, state) {
        await this.pool.query('UPDATE codex_plugin_bindings SET runtime_state=$2,heartbeat_at=$3 WHERE id=$1', [id, state, Date.now()]);
    }

    async disconnect(id) {
        await this.pool.query("UPDATE codex_plugin_bindings SET disconnected=TRUE,runtime_token_hash=NULL,runtime_state='offline' WHERE id=$1", [id]);
    }

    async enqueue(bindingId, payload) {
        const id = payload.id || crypto.randomUUID();
        await this.pool.query(
            `INSERT INTO codex_plugin_jobs (id,binding_id,payload,created_at) VALUES ($1,$2,$3,$4)
             ON CONFLICT (id) DO NOTHING`, [id, bindingId, JSON.stringify({ ...payload, id }), Date.now()]);
        return id;
    }

    async pending(id) {
        return (await this.pool.query(
            `SELECT payload FROM codex_plugin_jobs WHERE binding_id=$1 AND completed_at IS NULL
             ORDER BY CASE WHEN payload->>'ask_id' IS NOT NULL THEN 0 ELSE 1 END, created_at LIMIT 20`, [id])).rows.map(r => r.payload);
    }

    async job(id, bindingId) {
        return (await this.pool.query('SELECT * FROM codex_plugin_jobs WHERE id=$1 AND binding_id=$2', [id, bindingId])).rows[0];
    }

    async complete(bindingId, ids, reply) {
        for (const id of ids) await this.pool.query(
            'UPDATE codex_plugin_jobs SET completed_at=$3,reply_message=$4 WHERE binding_id=$1 AND id=$2 AND completed_at IS NULL',
            [bindingId, id, Date.now(), reply || null]);
    }
}

module.exports = CodexPluginStore;
