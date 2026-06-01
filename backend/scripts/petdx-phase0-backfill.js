#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const { Pool } = require('pg');
const {
    avatarUrlFor,
    isCharacterDefaultAvatar,
    pickDefaultCompanion,
} = require('../petdx-phase0-hook');

const PHASE0_SOURCES = new Set(['phase0-auto', 'phase0-backfill']);
const SOURCE = 'phase0-backfill';

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
        'Usage: node backend/scripts/petdx-phase0-backfill.js [--dry-run] [--commit] [--device=<deviceId>] [--json]',
        '',
        'Default mode is --dry-run. --commit writes PETDX_CURRENT/PETDX_AVATAR/PETDX_SOURCE and audit rows.',
        'Required env: DATABASE_URL. Required for decrypt/write: SEAL_KEY (64 hex chars).',
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

function publicIdentityOnly(identity) {
    const parsed = normalizeJson(identity, null);
    if (!parsed || typeof parsed !== 'object' || !parsed.public) return null;
    return { public: parsed.public };
}

async function loadBoundEntities(pool, deviceId = null) {
    const params = [];
    let where = 'WHERE e.is_bound = TRUE';
    if (deviceId) {
        params.push(deviceId);
        where += ` AND d.device_id = $${params.length}`;
    }
    const result = await pool.query(
        `SELECT d.device_id, e.entity_id, e.character, e.avatar, e.rental_status, e.identity
           FROM devices d
           JOIN entities e ON e.device_id = d.device_id
          ${where}
          ORDER BY d.device_id, e.entity_id`,
        params
    );
    return result.rows.map(row => ({
        deviceId: row.device_id,
        entityId: Number(row.entity_id),
        character: row.character || null,
        avatar: row.avatar || null,
        rental_status: row.rental_status || null,
        identity: publicIdentityOnly(row.identity),
    }));
}

async function loadVault(pool, sealKey, deviceId) {
    const result = await pool.query(
        'SELECT encrypted_vars, iv, auth_tag, var_sources, is_locked FROM device_vars WHERE device_id = $1',
        [deviceId]
    );
    if (!result.rows || result.rows.length === 0) {
        return { vars: {}, sources: {}, locked: false };
    }
    const row = result.rows[0];
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

async function appendAudit(pool, entry) {
    await pool.query(
        `INSERT INTO companion_select_log
            (device_id, entity_id, companion_id, selected_at, source, origin)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [entry.deviceId, entry.entityId, entry.companionId, Date.now(), 'api', SOURCE]
    );
}

function petdxKeys(entityId) {
    return {
        currentKey: `PETDX_CURRENT_${entityId}`,
        avatarKey: `PETDX_AVATAR_${entityId}`,
        sourceKey: `PETDX_SOURCE_${entityId}`,
    };
}

function planBackfillForEntity(entity, vars) {
    const keys = petdxKeys(entity.entityId);
    const current = vars[keys.currentKey] || null;
    const source = vars[keys.sourceKey] || null;

    if (entity.rental_status === 'leased_in') {
        return { outcome: 'skipped', reason: 'rental-leased-in', entity, keys };
    }
    if (!isCharacterDefaultAvatar(entity.avatar)) {
        return { outcome: 'skipped', reason: 'user-custom-avatar', entity, keys };
    }
    if (source && !PHASE0_SOURCES.has(source)) {
        return { outcome: 'preserves_existing_source', source, companionId: current, entity, keys };
    }
    if (current && !source) {
        return {
            outcome: 'stamped-existing',
            companionId: current,
            entity,
            keys,
            updates: { [keys.sourceKey]: SOURCE },
            audit: { deviceId: entity.deviceId, entityId: entity.entityId, companionId: current },
        };
    }
    if (current) {
        return { outcome: 'skipped', reason: 'already_assigned', source, companionId: current, entity, keys };
    }

    const companionId = pickDefaultCompanion(entity);
    const avatarUrl = avatarUrlFor(companionId);
    return {
        outcome: 'assigned',
        companionId,
        avatarUrl,
        entity,
        keys,
        updates: {
            [keys.currentKey]: companionId,
            [keys.avatarKey]: avatarUrl,
            [keys.sourceKey]: SOURCE,
        },
        audit: { deviceId: entity.deviceId, entityId: entity.entityId, companionId },
    };
}

function formatDecision(decision, commit) {
    const prefix = commit ? '[COMMIT]' : '[DRY]';
    const e = decision.entity;
    const base = `${prefix} ${decision.outcome} device=${e.deviceId} entity=${e.entityId}`;
    if (decision.outcome === 'assigned') return `${base} companion=${decision.companionId}`;
    if (decision.outcome === 'stamped-existing') return `${base} companion=${decision.companionId}`;
    if (decision.outcome === 'preserves_existing_source') return `${base} source=${decision.source}`;
    return `${base} reason=${decision.reason || 'none'}`;
}

function summarize(decisions) {
    const summary = {
        total: decisions.length,
        assigned: 0,
        stampedExisting: 0,
        preservesExistingSource: 0,
        skipped: 0,
    };
    for (const d of decisions) {
        if (d.outcome === 'assigned') summary.assigned++;
        else if (d.outcome === 'stamped-existing') summary.stampedExisting++;
        else if (d.outcome === 'preserves_existing_source') summary.preservesExistingSource++;
        else if (d.outcome === 'skipped') summary.skipped++;
    }
    return summary;
}

async function runBackfill({ pool, sealKey, commit = false, deviceId = null, logger = console } = {}) {
    if (!pool) throw new Error('pool required');
    const entities = await loadBoundEntities(pool, deviceId);
    const byDevice = new Map();
    for (const entity of entities) {
        if (!byDevice.has(entity.deviceId)) byDevice.set(entity.deviceId, []);
        byDevice.get(entity.deviceId).push(entity);
    }

    const decisions = [];
    for (const [devId, deviceEntities] of byDevice.entries()) {
        const vault = await loadVault(pool, sealKey, devId);
        let dirty = false;
        const audits = [];

        for (const entity of deviceEntities) {
            const decision = planBackfillForEntity(entity, vault.vars);
            decisions.push(decision);
            if (!logger.json) logger.log(formatDecision(decision, commit));
            if (decision.updates) {
                Object.assign(vault.vars, decision.updates);
                for (const key of Object.keys(decision.updates)) {
                    vault.sources[key] = 'petdx-phase0';
                }
                dirty = true;
            }
            if (decision.audit) audits.push(decision.audit);
        }

        if (commit && dirty) {
            await saveVault(pool, sealKey, devId, vault);
            for (const audit of audits) await appendAudit(pool, audit);
        }
    }

    const summary = summarize(decisions);
    if (!logger.json) {
        logger.log(`[petdx-phase0-backfill] done mode=${commit ? 'commit' : 'dry-run'} total=${summary.total} assigned=${summary.assigned} stampedExisting=${summary.stampedExisting} preserves_existing_source=${summary.preservesExistingSource} skipped=${summary.skipped}`);
    }
    return { summary, decisions };
}

async function main(argv = process.argv, env = process.env) {
    const opts = parseArgs(argv);
    if (opts.help) {
        console.log(usage());
        return { summary: null, decisions: [] };
    }
    const connectionString = env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL is required');
    const pool = new Pool({
        connectionString,
        ssl: shouldUseSsl(connectionString),
    });
    try {
        const result = await runBackfill({
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
    SOURCE,
    PHASE0_SOURCES,
    parseArgs,
    encryptVars,
    decryptVars,
    loadBoundEntities,
    loadVault,
    saveVault,
    appendAudit,
    petdxKeys,
    planBackfillForEntity,
    summarize,
    runBackfill,
    main,
    shouldUseSsl,
};

if (require.main === module) {
    main().catch((err) => {
        console.error('[petdx-phase0-backfill] fatal:', err.message);
        process.exit(1);
    });
}
