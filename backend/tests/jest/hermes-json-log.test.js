'use strict';

const {
    createHermesHealthMonitor,
    formatHermesLog,
    hermesLog,
} = require('../../hermes-health-check');

const REQUIRED_FIELDS = ['timestamp', 'level', 'service', 'event', 'duration_ms', 'error'];

function execResponder(handler) {
    return jest.fn((file, args, options, cb) => {
        try {
            const result = handler({ file, args, options });
            if (result instanceof Error) {
                cb(result, result.stdout || '', result.stderr || result.message);
                return;
            }
            cb(null, result?.stdout || '', result?.stderr || '');
        } catch (err) {
            cb(err, err.stdout || '', err.stderr || err.message);
        }
    });
}

function failingGit(message) {
    const err = new Error(message);
    err.code = 128;
    err.stderr = message;
    return err;
}

describe('Hermes structured JSON logging (H2 t6)', () => {
    const FIXED_NOW = () => Date.parse('2026-06-17T00:00:00.000Z');

    test('formatHermesLog emits the canonical field set as a JSON-serializable object', () => {
        const record = formatHermesLog('info', 'probe_ok', { duration_ms: 1234.7 }, FIXED_NOW);

        // valid JSON round-trip
        const parsed = JSON.parse(JSON.stringify(record));
        for (const field of REQUIRED_FIELDS) {
            expect(parsed).toHaveProperty(field);
        }
        expect(parsed.timestamp).toBe('2026-06-17T00:00:00.000Z');
        expect(parsed.level).toBe('info');
        expect(parsed.service).toBe('hermes');
        expect(parsed.event).toBe('probe_ok');
        expect(parsed.duration_ms).toBe(1235); // rounded
        expect(parsed.error).toBeNull();
    });

    test('unknown levels fall back to info; non-finite duration becomes null', () => {
        const a = formatHermesLog('LOUD', 'x', {}, FIXED_NOW);
        expect(a.level).toBe('info');
        expect(a.duration_ms).toBeNull();
        const b = formatHermesLog('warn', 'y', { duration_ms: NaN }, FIXED_NOW);
        expect(b.level).toBe('warn');
        expect(b.duration_ms).toBeNull();
    });

    test('extra metadata is merged but cannot clobber canonical fields', () => {
        const record = formatHermesLog('info', 'evt', {
            reason: 'cron',
            service: 'attacker',     // must not override
            timestamp: 'fake',       // must not override
            consecutive_failures: 2,
        }, FIXED_NOW);
        expect(record.service).toBe('hermes');
        expect(record.timestamp).toBe('2026-06-17T00:00:00.000Z');
        expect(record.reason).toBe('cron');
        expect(record.consecutive_failures).toBe(2);
    });

    test('secrets are redacted from event and error fields', () => {
        const record = formatHermesLog('error', 'push_failed', {
            error: 'fatal: auth failed for https://x-access-token:ghp_abcdefghijklmnopqrstuvwxyz@github.com/acme/repo.git '
                + 'botSecret=c4f39efb2c46346e00da5c394efc3e97 token=supersecretvalue '
                + 'DATABASE_URL=postgres://user:p4ssw0rd@db.internal:5432/eclaw',
        }, FIXED_NOW);
        const serialized = JSON.stringify(record);
        expect(serialized).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz');
        expect(serialized).not.toContain('c4f39efb2c46346e00da5c394efc3e97');
        expect(serialized).not.toContain('supersecretvalue');
        expect(serialized).not.toContain('p4ssw0rd');
        expect(serialized).toContain('[redacted]');
    });

    test('hermesLog writes exactly one valid JSON line; warn/error go to stderr', () => {
        const out = { writes: [], write(s) { this.writes.push(s); } };
        const err = { writes: [], write(s) { this.writes.push(s); } };

        hermesLog('info', 'info_event', { duration_ms: 10 }, { now: FIXED_NOW, out, err });
        hermesLog('error', 'err_event', { error: 'boom' }, { now: FIXED_NOW, out, err });

        expect(out.writes).toHaveLength(1);
        expect(err.writes).toHaveLength(1);

        // each write is a single newline-terminated line (no plain-text leakage)
        for (const line of [...out.writes, ...err.writes]) {
            expect(line.endsWith('\n')).toBe(true);
            expect(line.trimEnd().split('\n')).toHaveLength(1);
            const parsed = JSON.parse(line); // throws if not valid JSON => plain text leak
            for (const field of REQUIRED_FIELDS) {
                expect(parsed).toHaveProperty(field);
            }
        }
    });

    test('every monitor lifecycle emission is structured JSON with required fields', async () => {
        const lines = [];
        const sink = { write(s) { lines.push(s); } };
        let fail = true;
        const execFile = execResponder(({ args }) => {
            if (args.includes('push') && fail) return failingGit('network unavailable');
            return { stdout: args.includes('--abbrev-ref') ? 'main\n' : 'true\n' };
        });
        const monitor = createHermesHealthMonitor({
            env: {
                HERMES_HEALTHCHECK_REPO_DIR: '/repo/hermes',
                HERMES_HEALTHCHECK_BRANCH: 'main',
            },
            execFile,
            // route the default jsonLog stdout into our capture sink
            jsonLog: (level, event, fields) =>
                hermesLog(level, event, fields, { now: FIXED_NOW, out: sink, err: sink }),
        });

        await monitor.runOnce('test'); // failure path
        fail = false;
        await monitor.runOnce('test'); // ok path

        // skipped path on an unconfigured monitor
        const skipMonitor = createHermesHealthMonitor({
            env: {},
            execFile: jest.fn(),
            jsonLog: (level, event, fields) =>
                hermesLog(level, event, fields, { now: FIXED_NOW, out: sink, err: sink }),
        });
        await skipMonitor.runOnce('test');

        expect(lines.length).toBe(3);
        const records = lines.map((l) => {
            expect(l.endsWith('\n')).toBe(true);
            return JSON.parse(l); // asserts no plain-text leakage
        });
        for (const r of records) {
            for (const field of REQUIRED_FIELDS) expect(r).toHaveProperty(field);
            expect(r.event).toBe('hermes_health_check');
            expect(r.service).toBe('hermes');
        }
        expect(records.map(r => r.result).sort()).toEqual(['failed', 'ok', 'skipped']);
        const failed = records.find(r => r.result === 'failed');
        expect(failed.level).toBe('error');
        expect(failed).toHaveProperty('consecutive_failures', 1);
    });
});
