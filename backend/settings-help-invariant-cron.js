'use strict';

const crypto = require('crypto');
const path = require('path');
const { execFile: defaultExecFile } = require('child_process');
const { newCardId } = require('./entity-id');

const DEFAULT_CRON = '17 * * * *';
const DEFAULT_TIMEZONE = 'Asia/Taipei';
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_CHARS = 12_000;
const FINGERPRINT_PREFIX = 'settings-help-invariant:fingerprint=';
const CARD_TITLE = '[Infra] Settings help invariant violations (en + zh)';

const VALID_PRIORITIES = new Set(['P0', 'P1', 'P2', 'P3']);
const VALID_STATUSES = new Set(['backlog', 'todo', 'in_progress', 'review', 'done', 'blocked']);

function parseCsv(value) {
    return String(value || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
}

function parseEntityIds(value) {
    return String(value || '')
        .split(/[,\s]+/)
        .map(s => Number(s.trim()))
        .filter(n => Number.isInteger(n) && n >= 0);
}

function positiveInt(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : fallback;
}

function intOrNull(value) {
    if (value === undefined || value === null || value === '') return null;
    const n = Number(value);
    return Number.isInteger(n) ? n : null;
}

function firstConfiguredDeviceId(env) {
    return (env.SETTINGS_HELP_INVARIANT_DEVICE_ID || parseCsv(env.ADMIN_DEVICE_IDS)[0] || '').trim();
}

function loadConfig(env = process.env) {
    const enabled = env.SETTINGS_HELP_INVARIANT_CRON_ENABLED !== '0';
    const repoDir = (env.SETTINGS_HELP_INVARIANT_REPO_DIR || path.resolve(__dirname, '..')).trim();
    const cron = (env.SETTINGS_HELP_INVARIANT_CRON || DEFAULT_CRON).trim();
    const timezone = (env.SETTINGS_HELP_INVARIANT_TIMEZONE || DEFAULT_TIMEZONE).trim();
    const timeoutMs = positiveInt(env.SETTINGS_HELP_INVARIANT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
    const deviceId = firstConfiguredDeviceId(env);
    const assignedBots = parseEntityIds(env.SETTINGS_HELP_INVARIANT_ASSIGNED_BOTS || '6');
    const createdBy = intOrNull(env.SETTINGS_HELP_INVARIANT_CREATED_BY) ?? 0;
    const reviewerEntityId = intOrNull(env.SETTINGS_HELP_INVARIANT_REVIEWER_ENTITY_ID);
    const priority = VALID_PRIORITIES.has(env.SETTINGS_HELP_INVARIANT_PRIORITY)
        ? env.SETTINGS_HELP_INVARIANT_PRIORITY
        : 'P1';
    const status = VALID_STATUSES.has(env.SETTINGS_HELP_INVARIANT_STATUS)
        ? env.SETTINGS_HELP_INVARIANT_STATUS
        : 'todo';

    let skipReason = null;
    if (!enabled) skipReason = 'disabled';
    else if (!repoDir) skipReason = 'SETTINGS_HELP_INVARIANT_REPO_DIR empty';
    else if (!cron) skipReason = 'SETTINGS_HELP_INVARIANT_CRON empty';

    let cardSkipReason = null;
    if (!deviceId) cardSkipReason = 'SETTINGS_HELP_INVARIANT_DEVICE_ID or ADMIN_DEVICE_IDS required';
    else if (assignedBots.length === 0) cardSkipReason = 'SETTINGS_HELP_INVARIANT_ASSIGNED_BOTS empty';

    return {
        enabled,
        configured: enabled && !skipReason,
        skipReason,
        repoDir,
        cron,
        timezone,
        timeoutMs,
        deviceId,
        assignedBots,
        createdBy,
        reviewerEntityId,
        priority,
        status,
        cardConfigured: !cardSkipReason,
        cardSkipReason,
    };
}

function sanitizeForCard(value) {
    return String(value || '')
        .replace(/(https?:\/\/)[^@\s]+@/gi, '$1[redacted]@')
        .replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/g, '[redacted]')
        .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[redacted]')
        .replace(/\bx-access-token:[^@\s]+@/gi, 'x-access-token:[redacted]@')
        .replace(/(deviceSecret\s*[:=]\s*)["']?[^"',\s}]+/gi, '$1[redacted]')
        .replace(/(botSecret\s*[:=]\s*)["']?[^"',\s}]+/gi, '$1[redacted]');
}

function clip(value, max = MAX_OUTPUT_CHARS) {
    const s = sanitizeForCard(value).replace(/```/g, "'''").trim();
    return s.length > max ? s.slice(0, max - 3) + '...' : s;
}

function fingerprintOutput(output) {
    const normalized = sanitizeForCard(output)
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean)
        .join('\n');
    return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

function execFilePromise(execFileImpl, file, args, options) {
    return new Promise((resolve, reject) => {
        execFileImpl(file, args, options, (err, stdout = '', stderr = '') => {
            if (err) {
                err.stdout = stdout;
                err.stderr = stderr;
                reject(err);
                return;
            }
            resolve({ stdout, stderr });
        });
    });
}

async function runInvariantCheck(config, execFileImpl = defaultExecFile) {
    const scriptPath = path.join(config.repoDir, 'backend', 'scripts', 'check-settings-help-invariant.js');
    const options = {
        cwd: config.repoDir,
        timeout: config.timeoutMs,
        maxBuffer: 1024 * 1024,
        env: {
            ...process.env,
            FORCE_COLOR: '0',
        },
    };

    try {
        const { stdout, stderr } = await execFilePromise(
            execFileImpl,
            process.execPath,
            [scriptPath, '--all'],
            options
        );
        return {
            ok: true,
            stdout,
            stderr,
            output: [stdout, stderr].filter(Boolean).join('\n').trim(),
        };
    } catch (err) {
        const output = [
            err.stdout || '',
            err.stderr || '',
            err.message || '',
        ].filter(Boolean).join('\n').trim();
        return {
            ok: false,
            exitCode: err.code ?? null,
            signal: err.signal ?? null,
            timedOut: !!err.killed,
            stdout: err.stdout || '',
            stderr: err.stderr || '',
            output,
            error: sanitizeForCard(err.message || 'settings_help_invariant_failed'),
        };
    }
}

function buildViolationDescription({ result, fingerprint, observedAt }) {
    const output = result.output || result.stderr || result.stdout || result.error || 'No output captured.';
    return [
        `${FINGERPRINT_PREFIX}${fingerprint}`,
        '',
        'Settings-help invariant cron detected violations from:',
        '`node backend/scripts/check-settings-help-invariant.js --all`',
        '',
        'Scope: canonical settings-help locales are `en` + `zh`.',
        '',
        'Fix:',
        '1. Add or restore `<field>_label` and `<field>_help` in `backend/public/shared/i18n.js` for `en` and `zh`.',
        '2. Add a nearby `HELP-KEY: <field>_help` annotation at the settings render or binding site.',
        '3. Regenerate `backend/settings-help-keys.json` if settings labels changed.',
        '',
        `Observed: ${observedAt}`,
        '',
        'Output:',
        '```',
        clip(output),
        '```',
    ].join('\n');
}

function resolvePool(pool, getPool) {
    const resolved = typeof getPool === 'function' ? getPool() : pool;
    if (!resolved || typeof resolved.query !== 'function') {
        throw new Error('pool_unavailable');
    }
    return resolved;
}

async function addSystemComment(pool, cardId, deviceId, text) {
    await pool.query(
        `INSERT INTO kanban_comments (card_id, device_id, from_entity_id, text, is_system)
         VALUES ($1, $2, -1, $3, true)`,
        [cardId, deviceId, text]
    );
    await pool.query(
        `UPDATE kanban_cards SET updated_at = NOW() WHERE id = $1 AND device_id = $2`,
        [cardId, deviceId]
    );
}

async function bumpDashboard(pool, deviceId) {
    try {
        await pool.query(
            `UPDATE mission_dashboard SET updated_at = NOW() WHERE device_id = $1`,
            [deviceId]
        );
    } catch (_) {
        // Dashboard bumps are best-effort; card creation is the durable alert.
    }
}

async function openViolationCard({ pool, config, result, nowMs = Date.now() }) {
    if (!config.cardConfigured) {
        return { skipped: true, reason: config.cardSkipReason };
    }

    const observedAt = new Date(nowMs).toISOString();
    const fingerprint = fingerprintOutput(result.output || result.stderr || result.stdout || result.error || 'unknown');
    const marker = `${FINGERPRINT_PREFIX}${fingerprint}`;
    const description = buildViolationDescription({ result, fingerprint, observedAt });
    const existing = await pool.query(
        `SELECT id, status
           FROM kanban_cards
          WHERE device_id = $1
            AND archived = false
            AND status != 'done'
            AND description LIKE $2
          ORDER BY updated_at DESC
          LIMIT 1`,
        [config.deviceId, `%${marker}%`]
    );

    if (existing.rows.length > 0) {
        const cardId = existing.rows[0].id;
        await pool.query(
            `UPDATE kanban_cards
                SET title = $1,
                    description = $2,
                    priority = $3,
                    updated_at = NOW()
              WHERE id = $4 AND device_id = $5`,
            [CARD_TITLE, description, config.priority, cardId, config.deviceId]
        );
        await addSystemComment(
            pool,
            cardId,
            config.deviceId,
            `Settings help invariant cron re-detected the same violation fingerprint ${fingerprint} at ${observedAt}.`
        );
        await bumpDashboard(pool, config.deviceId);
        return { created: false, cardId, fingerprint };
    }

    const cardId = newCardId();
    await pool.query(
        `INSERT INTO kanban_cards (
            id, device_id, title, description, priority, status, assigned_bots, created_by,
            reviewer_entity_id, status_changed_at, requires_screenshot_review, dispatch_mode
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, NOW(), false, 'immediate')`,
        [
            cardId,
            config.deviceId,
            CARD_TITLE,
            description,
            config.priority,
            config.status,
            JSON.stringify(config.assignedBots),
            config.createdBy,
            config.reviewerEntityId,
        ]
    );
    await addSystemComment(
        pool,
        cardId,
        config.deviceId,
        `Settings help invariant cron opened this card for violation fingerprint ${fingerprint}.`
    );
    await bumpDashboard(pool, config.deviceId);
    return { created: true, cardId, fingerprint };
}

function initialState() {
    return {
        running: false,
        totalRuns: 0,
        lastRunAt: null,
        lastOkAt: null,
        lastFailureAt: null,
        lastSkippedAt: null,
        lastCardAt: null,
        lastCardId: null,
        lastError: null,
        skipReason: null,
    };
}

function createSettingsHelpInvariantCron({
    env = process.env,
    execFile = defaultExecFile,
    pool = null,
    getPool = null,
    audit = () => {},
    now = () => Date.now(),
} = {}) {
    const state = initialState();

    function status() {
        const config = loadConfig(env);
        return {
            enabled: config.enabled,
            configured: config.configured,
            running: state.running,
            cron: config.cron,
            timezone: config.timezone,
            timeoutMs: config.timeoutMs,
            cardConfigured: config.cardConfigured,
            cardDeviceId: config.deviceId || null,
            assignedBots: config.assignedBots,
            cardSkipReason: config.cardSkipReason,
            totalRuns: state.totalRuns,
            lastRunAt: state.lastRunAt,
            lastOkAt: state.lastOkAt,
            lastFailureAt: state.lastFailureAt,
            lastSkippedAt: state.lastSkippedAt,
            lastCardAt: state.lastCardAt,
            lastCardId: state.lastCardId,
            lastError: state.lastError,
            skipReason: config.skipReason || state.skipReason || null,
        };
    }

    async function runOnce(reason = 'manual') {
        const config = loadConfig(env);
        const startedAt = now();
        state.running = true;
        state.lastRunAt = startedAt;
        state.skipReason = config.skipReason;

        if (!config.configured) {
            state.running = false;
            state.lastSkippedAt = startedAt;
            audit('info', 'settings_help_invariant', `[SettingsHelpInvariant] skipped: ${config.skipReason}`, {
                action: 'settings_help_invariant',
                result: 'skipped',
                metadata: { reason, skipReason: config.skipReason },
            });
            return { ok: null, skipped: true, reason: config.skipReason };
        }

        state.totalRuns += 1;
        try {
            const result = await runInvariantCheck(config, execFile);
            if (result.ok) {
                const endedAt = now();
                state.running = false;
                state.lastOkAt = endedAt;
                state.lastError = null;
                audit('info', 'settings_help_invariant', '[SettingsHelpInvariant] OK', {
                    action: 'settings_help_invariant',
                    result: 'ok',
                    metadata: { reason },
                });
                return { ...result, skipped: false };
            }

            const endedAt = now();
            state.lastFailureAt = endedAt;
            state.lastError = clip(result.output || result.error || 'settings_help_invariant_failed', 600);
            audit('warn', 'settings_help_invariant', `[SettingsHelpInvariant] violations detected: ${state.lastError}`, {
                action: 'settings_help_invariant',
                result: 'failed',
                metadata: {
                    reason,
                    exitCode: result.exitCode,
                    timedOut: result.timedOut,
                },
            });

            let card = null;
            try {
                if (!config.cardConfigured) {
                    card = { skipped: true, reason: config.cardSkipReason };
                    audit('warn', 'settings_help_invariant', `[SettingsHelpInvariant] card not opened: ${config.cardSkipReason}`, {
                        action: 'settings_help_invariant',
                        result: 'card_skipped',
                        metadata: { reason: config.cardSkipReason },
                    });
                } else {
                    const resolvedPool = resolvePool(pool, getPool);
                    card = await openViolationCard({
                        pool: resolvedPool,
                        config,
                        result,
                        nowMs: endedAt,
                    });
                    state.lastCardAt = endedAt;
                    state.lastCardId = card.cardId || null;
                    audit('warn', 'settings_help_invariant', `[SettingsHelpInvariant] kanban card ${card.created ? 'created' : 'updated'}: ${card.cardId}`, {
                        action: 'settings_help_invariant',
                        result: card.created ? 'card_created' : 'card_updated',
                        resource: card.cardId,
                        metadata: { fingerprint: card.fingerprint },
                    });
                }
            } catch (cardErr) {
                card = { ok: false, error: sanitizeForCard(cardErr.message || 'card_open_failed') };
                audit('error', 'settings_help_invariant', `[SettingsHelpInvariant] card open failed: ${card.error}`, {
                    action: 'settings_help_invariant',
                    result: 'card_failed',
                });
            }

            state.running = false;
            return { ...result, skipped: false, card };
        } catch (err) {
            const endedAt = now();
            state.running = false;
            state.lastFailureAt = endedAt;
            state.lastError = sanitizeForCard(err.message || 'settings_help_invariant_error');
            audit('error', 'settings_help_invariant', `[SettingsHelpInvariant] run error: ${state.lastError}`, {
                action: 'settings_help_invariant',
                result: 'error',
            });
            return { ok: false, skipped: false, error: state.lastError };
        }
    }

    function startCron({ nodeCron } = {}) {
        const config = loadConfig(env);
        if (!config.enabled) {
            console.log('[SettingsHelpInvariant] disabled via SETTINGS_HELP_INVARIANT_CRON_ENABLED=0');
            return () => {};
        }
        if (!config.configured) {
            console.log(`[SettingsHelpInvariant] cron not scheduled: ${config.skipReason}`);
            return () => {};
        }
        if (!nodeCron || typeof nodeCron.schedule !== 'function') {
            throw new Error('nodeCron_required');
        }

        const task = nodeCron.schedule(config.cron, () => {
            runOnce('cron').catch(err => {
                console.error('[SettingsHelpInvariant] cron tick error:', err && err.message);
            });
        }, { timezone: config.timezone });
        audit('info', 'settings_help_invariant', `[SettingsHelpInvariant] scheduled ${config.cron} ${config.timezone}`, {
            action: 'settings_help_invariant',
            result: 'scheduled',
            metadata: {
                cron: config.cron,
                timezone: config.timezone,
                cardConfigured: config.cardConfigured,
                cardSkipReason: config.cardSkipReason,
            },
        });
        return () => {
            if (task && typeof task.stop === 'function') task.stop();
        };
    }

    return {
        runOnce,
        getStatus: status,
        startCron,
        _state: state,
    };
}

module.exports = {
    CARD_TITLE,
    DEFAULT_CRON,
    DEFAULT_TIMEZONE,
    FINGERPRINT_PREFIX,
    buildViolationDescription,
    createSettingsHelpInvariantCron,
    fingerprintOutput,
    loadConfig,
    openViolationCard,
    runInvariantCheck,
    sanitizeForCard,
};
