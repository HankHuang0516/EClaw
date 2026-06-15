#!/usr/bin/env node
'use strict';

/**
 * Petdx PR-C — one-time device-vars vault cleanup.
 *
 * PR-A + PR-B moved AvatarPetdx companion selection entirely onto
 * companion_select_log (the source of truth). The per-entity
 * PETDX_CURRENT_<id> / PETDX_AVATAR_<id> / PETDX_SOURCE_<id> vault keys are no
 * longer read or written by any code path. This script removes the residual
 * keys that older binds left behind.
 *
 * Safety:
 *   - Default mode is --dry-run; nothing is written without --commit.
 *   - Scope to a single device with --device=<id> for the pilot soak.
 *   - Only keys matching ^PETDX_(CURRENT|AVATAR|SOURCE)_<digits>$ are touched;
 *     every other vault entry (including unrelated PETDX_* names) is preserved.
 *   - Each removal is recorded in device_vars_audit (action='delete_one',
 *     source='petdx-phase0-prc-cleanup'); values are never logged.
 *
 * Rollout (per the chained kanban card):
 *   1. node petdx-vault-cleanup.js --device=<hank> --commit   (pilot)
 *   2. 24h soak — confirm dashboards/avatars still resolve from the log SoT
 *   3. node petdx-vault-cleanup.js --commit                   (fleet-wide)
 *
 * Required env: DATABASE_URL, SEAL_KEY (64 hex chars).
 */

const crypto = require('crypto');
const { Pool } = require('pg');

const CLEANUP_SOURCE = 'petdx-phase0-prc-cleanup';
const PETDX_VAULT_KEY_RE = /^PETDX_(CURRENT|AVATAR|SOURCE)_\d+$/;

function parseArgs(argv = process.argv) {
    const opts = {
        commit: false,
        deviceId: process.env.DEVICE_ID || null,
        json: false,
    };
    for (const arg of argv.slice(2)) {
        if (arg === '--commit' || arg === '--apply') opts.commit = true;
        else if (arg === '--dry-run') opts.commit = false;
        else if (arg === '--json') opts.json = true;
        else if (arg.startsWith('--device=')) opts.deviceId = arg.slice('--device='.length);
        else if (arg === '--help' || arg === '-h') opts.help = true;
        else throw new Error(`Unknown argument: ${arg}`);
    }
    return opts;
}

function usage() {
    return [
        'Usage: node backend/scripts/petdx-vault-cleanup.js [--dry-run] [--commit] [--device=<deviceId>] [--json]',
        '',
        'Removes residual PETDX_CURRENT/AVATAR/SOURCE_<entityId> vault keys (PR-C).',
        'Default mode is --dry-run. --commit re-encrypts each device vault without the keys.',
        'Required env: DATABASE_URL, SEAL_KEY (64 hex chars).',
    ].join('\n');
}

function isProductionRuntime() {
    return process.env.NODE_ENV === 'production' || Boolean(process.env.RAILWAY_ENVIRONMENT);
}

function shouldUseSsl(connectionString) {
    const sslMode = (process.env.PGSSLMODE || '').toLowerCase();
    if (sslMode === 'disable') return false;
    if (sslMode === 'require' || sslMode === 'verify-ca' || sslMode === 'verify-full') {
        return { rejectUnauthorized: sslMode !== 'require' };
    }
    try {
        const host = new URL(connectionString).hostname;
        if (host === 'localhost' || host === '127.0.0.1' || host.endsWith('.railway.internal')) {
            return false;
        }
    } catch (_) {
        // Fall through to production default.
    }
    return isProductionRuntime() ? { rejectUnauthorized: false } : false;
}

function assertSealKey(sealKey) {
    if (!sealKey || !/^[0-9a-fA-F]{64}$/.test(sealKey)) {
        throw new Error('SEAL_KEY must be exactly 64 hex characters');
    }
}

function encryptVars(varsObj, sealKey) {
    assertSealKey(sealKey);
    const key = Buffer.from(sealKey, 'hex');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    let encrypted = cipher.update(JSON.stringify(varsObj), 'utf8', 'base64');
    encrypted += cipher.final('base64');
    const authTag = cipher.getAuthTag();
    return {
        encrypted,
        iv: iv.toString('hex'),
        authTag: authTag.toString('hex'),
    };
}

function decryptVars(encrypted, ivHex, authTagHex, sealKey) {
    assertSealKey(sealKey);
    const key = Buffer.from(sealKey, 'hex');
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encrypted, 'base64', 'utf8');
    decrypted += decipher.final('utf8');
    return JSON.parse(decrypted);
}

function normalizeJson(value, fallback) {
    if (!value) return fallback;
    if (typeof value === 'string') {
        try { return JSON.parse(value); } catch (_) { return fallback; }
    }
    return value;
}

// Pure: the residual PETDX_* keys present on a decrypted vars object.
function planCleanup(vars) {
    if (!vars || typeof vars !== 'object') return [];
    return Object.keys(vars).filter(k => PETDX_VAULT_KEY_RE.test(k));
}

async function loadDeviceIds(pool, deviceId = null) {
    if (deviceId) return [deviceId];
    const res = await pool.query('SELECT device_id FROM device_vars ORDER BY device_id');
    return res.rows.map(r => r.device_id);
}

async function loadVault(pool, sealKey, deviceId) {
    const res = await pool.query(
        'SELECT encrypted_vars, iv, auth_tag, var_sources, is_locked FROM device_vars WHERE device_id = $1',
        [deviceId]
    );
    if (!res.rows || res.rows.length === 0) return null;
    const row = res.rows[0];
    return {
        vars: decryptVars(row.encrypted_vars, row.iv, row.auth_tag, sealKey) || {},
        sources: normalizeJson(row.var_sources, {}) || {},
        locked: !!row.is_locked,
    };
}

async function saveVault(pool, sealKey, deviceId, vault) {
    const { encrypted, iv, authTag } = encryptVars(vault.vars, sealKey);
    await pool.query(
        `INSERT INTO device_vars (device_id, encrypted_vars, iv, auth_tag, var_keys, var_sources, is_locked, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (device_id)
         DO UPDATE SET encrypted_vars = $2,
                       iv = $3,
                       auth_tag = $4,
                       var_keys = $5,
                       var_sources = $6,
                       is_locked = $7,
                       updated_at = $8`,
        [
            deviceId,
            encrypted,
            iv,
            authTag,
            Object.keys(vault.vars),
            JSON.stringify(vault.sources || {}),
            !!vault.locked,
            Date.now(),
        ]
    );
}

async function appendAudit(pool, { deviceId, keyName, beforeCount, afterCount }) {
    await pool.query(
        `INSERT INTO device_vars_audit
            (device_id, action, key_name, source, before_count, after_count)
         VALUES ($1, 'delete_one', $2, $3, $4, $5)`,
        [deviceId, keyName, CLEANUP_SOURCE, beforeCount, afterCount]
    );
}

async function cleanupDevice(pool, sealKey, deviceId, commit) {
    const vault = await loadVault(pool, sealKey, deviceId);
    if (!vault) return { deviceId, removed: [], status: 'no-vault' };

    const removed = planCleanup(vault.vars);
    if (removed.length === 0) return { deviceId, removed: [], status: 'clean' };

    if (!commit) return { deviceId, removed, status: 'dry-run' };

    const beforeCount = Object.keys(vault.vars).length;
    for (const k of removed) {
        delete vault.vars[k];
        delete vault.sources[k];
    }
    const afterCount = Object.keys(vault.vars).length;
    await saveVault(pool, sealKey, deviceId, vault);
    for (const k of removed) {
        await appendAudit(pool, { deviceId, keyName: k, beforeCount, afterCount });
    }
    return { deviceId, removed, status: 'cleaned' };
}

function summarize(results) {
    const summary = { devicesScanned: results.length, devicesModified: 0, keysRemoved: 0 };
    for (const r of results) {
        if (r.removed.length > 0) {
            summary.keysRemoved += r.removed.length;
            if (r.status === 'cleaned' || r.status === 'dry-run') summary.devicesModified++;
        }
    }
    return summary;
}

async function runCleanup({ pool, sealKey, commit = false, deviceId = null, logger = console } = {}) {
    if (!pool) throw new Error('pool required');
    assertSealKey(sealKey);
    const deviceIds = await loadDeviceIds(pool, deviceId);
    const results = [];
    for (const id of deviceIds) {
        let result;
        try {
            result = await cleanupDevice(pool, sealKey, id, commit);
        } catch (err) {
            result = { deviceId: id, removed: [], status: 'error', error: err.message };
        }
        results.push(result);
        if (!logger.json) {
            const prefix = commit ? '[COMMIT]' : '[DRY]';
            logger.log(`${prefix} ${result.status} device=${id} keys=${result.removed.length}${result.error ? ` error=${result.error}` : ''}`);
        }
    }

    const summary = summarize(results);
    if (!logger.json) {
        logger.log(`[petdx-vault-cleanup] done mode=${commit ? 'commit' : 'dry-run'} scanned=${summary.devicesScanned} modified=${summary.devicesModified} keysRemoved=${summary.keysRemoved}`);
    }
    return { summary, results };
}

async function main(argv = process.argv, env = process.env) {
    const opts = parseArgs(argv);
    if (opts.help) {
        console.log(usage());
        return { summary: null, results: [] };
    }
    const connectionString = env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL is required');
    const pool = new Pool({
        connectionString,
        ssl: shouldUseSsl(connectionString),
    });
    try {
        const result = await runCleanup({
            pool,
            sealKey: env.SEAL_KEY,
            commit: opts.commit,
            deviceId: opts.deviceId,
            logger: opts.json ? { json: true, log() {} } : console,
        });
        if (opts.json) console.log(JSON.stringify(result.summary));
        return result;
    } finally {
        await pool.end();
    }
}

module.exports = {
    CLEANUP_SOURCE,
    PETDX_VAULT_KEY_RE,
    parseArgs,
    encryptVars,
    decryptVars,
    planCleanup,
    loadDeviceIds,
    loadVault,
    saveVault,
    appendAudit,
    cleanupDevice,
    summarize,
    runCleanup,
    main,
    shouldUseSsl,
};

if (require.main === module) {
    main().catch((err) => {
        console.error('[petdx-vault-cleanup] fatal:', err.message);
        process.exit(1);
    });
}
