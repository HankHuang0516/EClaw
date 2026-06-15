#!/usr/bin/env node
'use strict';

const { Pool } = require('pg');
const {
    isCharacterDefaultAvatar,
    pickDefaultCompanion,
} = require('../petdx-phase0-hook');

const PHASE0_SOURCES = new Set(['phase0-auto', 'phase0-backfill']);
const SOURCE = 'phase0-backfill';
const TOMBSTONE_ORIGIN = 'unbind-cleared';

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
        'Default mode is --dry-run. --commit appends companion_select_log rows (origin=phase0-backfill).',
        'companion_select_log is the source of truth; no device-vars vault is read or written.',
        'Required env: DATABASE_URL.',
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

// Source of truth read: the latest companion_select_log row per entity. A
// tombstone (origin='unbind-cleared') means the selection was cleared, so it
// resolves to "no current selection" (null) and the entity is eligible for a
// fresh backfill assignment.
async function loadLatestSelections(pool, deviceId) {
    const result = await pool.query(
        `SELECT DISTINCT ON (entity_id) entity_id, companion_id, origin
           FROM companion_select_log
          WHERE device_id = $1 AND entity_id IS NOT NULL
          ORDER BY entity_id, selected_at DESC, id DESC`,
        [deviceId]
    );
    const map = new Map();
    for (const row of result.rows) {
        const entityId = Number(row.entity_id);
        if (!Number.isFinite(entityId)) continue;
        if (row.origin === TOMBSTONE_ORIGIN) {
            map.set(entityId, null);
            continue;
        }
        map.set(entityId, { companionId: row.companion_id || null, source: row.origin || null });
    }
    return map;
}

async function appendAudit(pool, entry) {
    await pool.query(
        `INSERT INTO companion_select_log
            (device_id, entity_id, companion_id, selected_at, source, origin)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [entry.deviceId, entry.entityId, entry.companionId, Date.now(), 'api', SOURCE]
    );
}

// `latest` is the entity's current companion_select_log selection
// ({ companionId, source } | null), as returned by loadLatestSelections.
function planBackfillForEntity(entity, latest) {
    const current = latest ? (latest.companionId || null) : null;
    const source = latest ? (latest.source || null) : null;

    if (entity.rental_status === 'leased_in') {
        return { outcome: 'skipped', reason: 'rental-leased-in', entity };
    }
    if (!isCharacterDefaultAvatar(entity.avatar)) {
        return { outcome: 'skipped', reason: 'user-custom-avatar', entity };
    }
    if (source && !PHASE0_SOURCES.has(source)) {
        return { outcome: 'preserves_existing_source', source, companionId: current, entity };
    }
    if (current && !source) {
        return {
            outcome: 'stamped-existing',
            companionId: current,
            entity,
            audit: { deviceId: entity.deviceId, entityId: entity.entityId, companionId: current },
        };
    }
    if (current) {
        return { outcome: 'skipped', reason: 'already_assigned', source, companionId: current, entity };
    }

    const companionId = pickDefaultCompanion(entity);
    return {
        outcome: 'assigned',
        companionId,
        entity,
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

async function runBackfill({ pool, commit = false, deviceId = null, logger = console } = {}) {
    if (!pool) throw new Error('pool required');
    const entities = await loadBoundEntities(pool, deviceId);
    const byDevice = new Map();
    for (const entity of entities) {
        if (!byDevice.has(entity.deviceId)) byDevice.set(entity.deviceId, []);
        byDevice.get(entity.deviceId).push(entity);
    }

    const decisions = [];
    for (const [devId, deviceEntities] of byDevice.entries()) {
        const latestByEntity = await loadLatestSelections(pool, devId);
        const audits = [];

        for (const entity of deviceEntities) {
            const decision = planBackfillForEntity(entity, latestByEntity.get(entity.entityId) || null);
            decisions.push(decision);
            if (!logger.json) logger.log(formatDecision(decision, commit));
            if (decision.audit) audits.push(decision.audit);
        }

        if (commit && audits.length) {
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
    TOMBSTONE_ORIGIN,
    parseArgs,
    loadBoundEntities,
    loadLatestSelections,
    appendAudit,
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
