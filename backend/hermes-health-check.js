'use strict';

const { execFile: defaultExecFile } = require('child_process');

const DEFAULT_CRON = '23 */6 * * *';
const DEFAULT_REMOTE = 'origin';
const DEFAULT_TIMEOUT_MS = 45_000;
const ALERT_FAILURE_THRESHOLD = 3;
const SLA_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const SLA_TARGET_PCT = 99;
const MAX_ERROR_CHARS = 600;

function parseCsv(value) {
    return String(value || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
}

function positiveInt(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : fallback;
}

function sanitizeForLog(value) {
    return String(value || '')
        .replace(/(https?:\/\/)[^@\s]+@/gi, '$1[redacted]@')
        .replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/g, '[redacted]')
        .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[redacted]')
        .replace(/\bx-access-token:[^@\s]+@/gi, 'x-access-token:[redacted]@')
        // Connection strings (e.g. DATABASE_URL): scheme://user:pass@host -> scheme://[redacted]@host
        .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^@\s/]+:[^@\s/]+@/gi, '$1[redacted]@')
        // key=value style secrets (botSecret/token/secret/password/api_key/database_url)
        .replace(/\b(bot_?secret|device_?secret|secret|token|password|passwd|api[_-]?key|database_?url)\s*[=:]\s*['"]?[^\s'"&]+/gi, '$1=[redacted]');
}

function clip(value, max = MAX_ERROR_CHARS) {
    const s = sanitizeForLog(value).replace(/\s+/g, ' ').trim();
    return s.length > max ? s.slice(0, max - 3) + '...' : s;
}

const HERMES_LOG_LEVELS = new Set(['debug', 'info', 'warn', 'error']);

// Build a single structured log record. Pure (testable) — no I/O, no clock unless
// caller omits `now`. Always returns the canonical field set so Railway log-drain →
// Loki can rely on a stable schema. Secrets are stripped from `event`/`error`.
function formatHermesLog(level, event, fields = {}, now = () => Date.now()) {
    const { duration_ms, error, ...rest } = fields || {};
    const record = {
        timestamp: new Date(now()).toISOString(),
        level: HERMES_LOG_LEVELS.has(level) ? level : 'info',
        service: 'hermes',
        event: clip(event || 'unknown', 120),
        duration_ms: Number.isFinite(duration_ms) ? Math.round(duration_ms) : null,
        error: error == null ? null : clip(error, MAX_ERROR_CHARS),
    };
    // Merge any extra structured metadata, sanitizing string values; never let a
    // caller-supplied field clobber the canonical ones above.
    for (const [k, v] of Object.entries(rest)) {
        if (k in record) continue;
        record[k] = typeof v === 'string' ? clip(v, MAX_ERROR_CHARS) : v;
    }
    return record;
}

// Emit one JSON object per line on stdout (warn/error → stderr) for Railway drain.
function hermesLog(level, event, fields = {}, { now, out = process.stdout, err = process.stderr } = {}) {
    const record = formatHermesLog(level, event, fields, now);
    const line = JSON.stringify(record) + '\n';
    const sink = (record.level === 'warn' || record.level === 'error') ? err : out;
    sink.write(line);
    return record;
}

function loadConfig(env = process.env) {
    const enabled = env.HERMES_HEALTHCHECK_ENABLED !== '0';
    const repoDir = (env.HERMES_HEALTHCHECK_REPO_DIR || '').trim();
    const branch = (env.HERMES_HEALTHCHECK_BRANCH || '').trim();
    const remote = (env.HERMES_HEALTHCHECK_REMOTE || DEFAULT_REMOTE).trim();
    const timeoutMs = positiveInt(env.HERMES_HEALTHCHECK_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
    const commanderDeviceIds = parseCsv(
        env.HERMES_HEALTHCHECK_NOTIFY_DEVICE_IDS
        || env.HERMES_COMMANDER_DEVICE_IDS
        || env.ADMIN_DEVICE_IDS
    );
    const cron = (env.HERMES_HEALTHCHECK_CRON || DEFAULT_CRON).trim();
    const timezone = (env.HERMES_HEALTHCHECK_TIMEZONE || 'UTC').trim();

    let skipReason = null;
    if (!enabled) skipReason = 'disabled';
    else if (!repoDir) skipReason = 'HERMES_HEALTHCHECK_REPO_DIR not set';
    else if (!remote) skipReason = 'HERMES_HEALTHCHECK_REMOTE empty';

    return {
        enabled,
        configured: enabled && !skipReason,
        skipReason,
        repoDir,
        branch,
        remote,
        timeoutMs,
        commanderDeviceIds,
        cron,
        timezone,
    };
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

async function execGit(config, execFileImpl, args) {
    return execFilePromise(
        execFileImpl,
        'git',
        ['-C', config.repoDir, ...args],
        {
            timeout: config.timeoutMs,
            maxBuffer: 256 * 1024,
            env: {
                ...process.env,
                GIT_TERMINAL_PROMPT: '0',
            },
        }
    );
}

async function resolveBranch(config, execFileImpl) {
    if (config.branch) return config.branch;
    const { stdout } = await execGit(config, execFileImpl, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const branch = stdout.trim();
    if (!branch || branch === 'HEAD') {
        throw new Error('detached_head: set HERMES_HEALTHCHECK_BRANCH');
    }
    return branch;
}

async function runGitPushProbe(config, execFileImpl = defaultExecFile) {
    const startedAt = Date.now();
    await execGit(config, execFileImpl, ['rev-parse', '--is-inside-work-tree']);
    const branch = await resolveBranch(config, execFileImpl);
    const pushSpec = `HEAD:${branch}`;
    await execGit(config, execFileImpl, ['push', '--dry-run', '--porcelain', config.remote, pushSpec]);
    return {
        ok: true,
        branch,
        remote: config.remote,
        pushSpec,
        durationMs: Date.now() - startedAt,
    };
}

function recordSample(state, sample, nowMs) {
    state.samples.push(sample);
    const cutoff = nowMs - SLA_WINDOW_MS;
    state.samples = state.samples.filter(s => s.at >= cutoff);
}

function computeSla(samples, nowMs = Date.now()) {
    const cutoff = nowMs - SLA_WINDOW_MS;
    const recent = samples.filter(s => s.at >= cutoff && !s.skipped);
    const successCount = recent.filter(s => s.ok).length;
    const failureCount = recent.filter(s => !s.ok).length;
    const sampleCount = recent.length;
    const uptimePct = sampleCount === 0
        ? null
        : Math.round((successCount / sampleCount) * 10_000) / 100;
    return {
        windowMs: SLA_WINDOW_MS,
        targetPct: SLA_TARGET_PCT,
        sampleCount,
        successCount,
        failureCount,
        uptimePct,
        met: uptimePct == null ? null : uptimePct >= SLA_TARGET_PCT,
    };
}

function initialState() {
    return {
        running: false,
        consecutiveFailures: 0,
        totalRuns: 0,
        lastRunAt: null,
        lastOkAt: null,
        lastFailureAt: null,
        lastSkippedAt: null,
        lastAlertAt: null,
        lastAlertFailureCount: 0,
        lastDurationMs: null,
        lastError: null,
        lastBranch: null,
        lastRemote: null,
        skipReason: null,
        samples: [],
    };
}

function createHermesHealthMonitor({
    env = process.env,
    execFile = defaultExecFile,
    notifyDevice = null,
    audit = () => {},
    // Structured JSON sink (stdout) consumed by Railway log-drain → Loki.
    // Injectable for tests; defaults to the real stdout/stderr emitter.
    jsonLog = (level, event, fields) => hermesLog(level, event, fields, { now }),
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
            remote: config.remote,
            branch: config.branch || state.lastBranch || null,
            timeoutMs: config.timeoutMs,
            notifyDeviceCount: config.commanderDeviceIds.length,
            skipReason: config.skipReason || state.skipReason || null,
            consecutiveFailures: state.consecutiveFailures,
            totalRuns: state.totalRuns,
            lastRunAt: state.lastRunAt,
            lastOkAt: state.lastOkAt,
            lastFailureAt: state.lastFailureAt,
            lastSkippedAt: state.lastSkippedAt,
            lastAlertAt: state.lastAlertAt,
            lastAlertFailureCount: state.lastAlertFailureCount,
            lastDurationMs: state.lastDurationMs,
            lastError: state.lastError,
            sla: computeSla(state.samples, now()),
        };
    }

    async function alertCommanders(config, failure) {
        if (!config.commanderDeviceIds.length || typeof notifyDevice !== 'function') {
            audit('warn', 'hermes_health', '[HermesHealth] alert not delivered: no commander device configured', {
                action: 'hermes_health_check',
                result: 'alert_not_delivered',
                metadata: { consecutiveFailures: state.consecutiveFailures },
            });
            return { sent: 0, skipped: true };
        }

        const body = `Git push dry-run failed ${state.consecutiveFailures} consecutive times. Last error: ${clip(failure.error || 'unknown_error', 220)}`;
        const notification = {
            type: 'system',
            category: 'delivery_alert',
            title: 'Hermes health-check failed',
            body,
            link: '/portal/roadmap.html',
            metadata: {
                kind: 'hermes_health_check',
                consecutiveFailures: state.consecutiveFailures,
                lastRunAt: state.lastRunAt,
                durationMs: state.lastDurationMs,
                remote: config.remote,
                branch: failure.branch || config.branch || null,
            },
        };

        const results = await Promise.allSettled(
            config.commanderDeviceIds.map(deviceId => notifyDevice(deviceId, notification))
        );
        const sent = results.filter(r => r.status === 'fulfilled').length;
        state.lastAlertAt = now();
        state.lastAlertFailureCount = state.consecutiveFailures;
        audit('warn', 'hermes_health', `[HermesHealth] commander alert sent after ${state.consecutiveFailures} failures`, {
            action: 'hermes_health_check',
            result: 'alert_sent',
            metadata: { sent, requested: config.commanderDeviceIds.length },
        });
        return { sent, skipped: false };
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
            recordSample(state, { at: startedAt, skipped: true, ok: null }, startedAt);
            audit('info', 'hermes_health', `[HermesHealth] skipped: ${config.skipReason}`, {
                action: 'hermes_health_check',
                result: 'skipped',
                metadata: { reason, skipReason: config.skipReason },
            });
            jsonLog('info', 'hermes_health_check', {
                result: 'skipped', reason, skip_reason: config.skipReason, duration_ms: 0,
            });
            return { ok: null, skipped: true, reason: config.skipReason };
        }

        state.totalRuns += 1;
        const previousFailures = state.consecutiveFailures;
        try {
            const probe = await runGitPushProbe(config, execFile);
            const endedAt = now();
            state.running = false;
            state.consecutiveFailures = 0;
            state.lastOkAt = endedAt;
            state.lastDurationMs = probe.durationMs;
            state.lastError = null;
            state.lastBranch = probe.branch;
            state.lastRemote = probe.remote;
            recordSample(state, { at: endedAt, ok: true, durationMs: probe.durationMs }, endedAt);
            audit('info', 'hermes_health', `[HermesHealth] git push dry-run OK (${probe.remote} ${probe.pushSpec})`, {
                action: 'hermes_health_check',
                result: 'ok',
                metadata: { reason, durationMs: probe.durationMs, branch: probe.branch, remote: probe.remote },
            });
            jsonLog('info', 'hermes_health_check', {
                result: 'ok', reason, duration_ms: probe.durationMs, branch: probe.branch, remote: probe.remote,
            });
            return { ...probe, skipped: false };
        } catch (err) {
            const endedAt = now();
            const error = clip(
                (err && (err.stderr || err.stdout || err.message)) || 'git_push_probe_failed'
            );
            state.running = false;
            state.consecutiveFailures = previousFailures + 1;
            state.lastFailureAt = endedAt;
            state.lastDurationMs = endedAt - startedAt;
            state.lastError = error;
            recordSample(state, { at: endedAt, ok: false, error }, endedAt);
            audit('warn', 'hermes_health', `[HermesHealth] git push dry-run failed (${state.consecutiveFailures} consecutive): ${error}`, {
                action: 'hermes_health_check',
                result: 'failed',
                metadata: {
                    reason,
                    consecutiveFailures: state.consecutiveFailures,
                    durationMs: state.lastDurationMs,
                },
            });
            jsonLog('error', 'hermes_health_check', {
                result: 'failed', reason, error,
                duration_ms: state.lastDurationMs,
                consecutive_failures: state.consecutiveFailures,
            });

            let alert = null;
            if (state.consecutiveFailures >= ALERT_FAILURE_THRESHOLD
                && previousFailures < ALERT_FAILURE_THRESHOLD) {
                alert = await alertCommanders(config, { error, branch: state.lastBranch });
            }

            return {
                ok: false,
                skipped: false,
                error,
                consecutiveFailures: state.consecutiveFailures,
                alert,
            };
        }
    }

    function startCron({ nodeCron } = {}) {
        const config = loadConfig(env);
        if (!config.enabled) {
            hermesLog('info', 'hermes_health_cron_disabled', { reason: 'HERMES_HEALTHCHECK_ENABLED=0' });
            return () => {};
        }
        if (!config.configured) {
            hermesLog('info', 'hermes_health_cron_not_scheduled', { reason: config.skipReason });
            return () => {};
        }
        if (!nodeCron || typeof nodeCron.schedule !== 'function') {
            throw new Error('nodeCron_required');
        }

        const task = nodeCron.schedule(config.cron, () => {
            runOnce('cron').catch(err => {
                hermesLog('error', 'hermes_health_cron_tick_error', { error: err && err.message });
            });
        }, { timezone: config.timezone });
        audit('info', 'hermes_health', `[HermesHealth] scheduled ${config.cron} ${config.timezone}`, {
            action: 'hermes_health_check',
            result: 'scheduled',
            metadata: { cron: config.cron, timezone: config.timezone },
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
    createHermesHealthMonitor,
    runGitPushProbe,
    loadConfig,
    sanitizeForLog,
    computeSla,
    formatHermesLog,
    hermesLog,
    ALERT_FAILURE_THRESHOLD,
    DEFAULT_CRON,
    DEFAULT_TIMEOUT_MS,
};
