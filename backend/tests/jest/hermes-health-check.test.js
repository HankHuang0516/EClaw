'use strict';

const {
    ALERT_FAILURE_THRESHOLD,
    createHermesHealthMonitor,
    loadConfig,
    runGitPushProbe,
    sanitizeForLog,
} = require('../../hermes-health-check');

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

describe('Hermes H2 health-check monitor', () => {
    test('requires explicit repo configuration before scheduling git probes', async () => {
        const execFile = jest.fn();
        const audit = jest.fn();
        const monitor = createHermesHealthMonitor({
            env: {},
            execFile,
            audit,
        });

        expect(loadConfig({}).configured).toBe(false);
        const result = await monitor.runOnce('manual');

        expect(result).toEqual({
            ok: null,
            skipped: true,
            reason: 'HERMES_HEALTHCHECK_REPO_DIR not set',
        });
        expect(execFile).not.toHaveBeenCalled();
        expect(monitor.getStatus().skipReason).toBe('HERMES_HEALTHCHECK_REPO_DIR not set');
    });

    test('runs a git push dry-run against the configured remote and branch', async () => {
        const execFile = execResponder(({ args }) => {
            if (args.includes('push')) return { stdout: 'dry-run ok\n' };
            return { stdout: 'true\n' };
        });

        const result = await runGitPushProbe({
            repoDir: '/repo/hermes',
            branch: 'main',
            remote: 'origin',
            timeoutMs: 1000,
        }, execFile);

        expect(result).toEqual(expect.objectContaining({
            ok: true,
            branch: 'main',
            remote: 'origin',
            pushSpec: 'HEAD:main',
        }));
        expect(execFile).toHaveBeenCalledWith(
            'git',
            ['-C', '/repo/hermes', 'push', '--dry-run', '--porcelain', 'origin', 'HEAD:main'],
            expect.objectContaining({
                timeout: 1000,
                env: expect.objectContaining({ GIT_TERMINAL_PROMPT: '0' }),
            }),
            expect.any(Function)
        );
    });

    test('derives current branch when HERMES_HEALTHCHECK_BRANCH is omitted', async () => {
        const execFile = execResponder(({ args }) => {
            if (args.includes('--abbrev-ref')) return { stdout: 'feature/hermes-health\n' };
            if (args.includes('push')) return { stdout: 'dry-run ok\n' };
            return { stdout: 'true\n' };
        });

        const result = await runGitPushProbe({
            repoDir: '/repo/hermes',
            branch: '',
            remote: 'origin',
            timeoutMs: 1000,
        }, execFile);

        expect(result.branch).toBe('feature/hermes-health');
        expect(execFile).toHaveBeenCalledWith(
            'git',
            ['-C', '/repo/hermes', 'push', '--dry-run', '--porcelain', 'origin', 'HEAD:feature/hermes-health'],
            expect.any(Object),
            expect.any(Function)
        );
    });

    test('alerts commander devices on the third consecutive failure only', async () => {
        const notifyDevice = jest.fn().mockResolvedValue(undefined);
        const audit = jest.fn();
        const execFile = execResponder(({ args }) => {
            if (args.includes('push')) {
                return failingGit('fatal: Authentication failed for https://ghp_secretsecretsecretsecret@github.com/acme/repo.git');
            }
            return { stdout: 'true\n' };
        });
        const monitor = createHermesHealthMonitor({
            env: {
                HERMES_HEALTHCHECK_REPO_DIR: '/repo/hermes',
                HERMES_HEALTHCHECK_BRANCH: 'main',
                HERMES_HEALTHCHECK_NOTIFY_DEVICE_IDS: 'device-a,device-b',
            },
            execFile,
            notifyDevice,
            audit,
        });

        await monitor.runOnce('test');
        await monitor.runOnce('test');
        expect(notifyDevice).not.toHaveBeenCalled();

        const third = await monitor.runOnce('test');
        expect(third.ok).toBe(false);
        expect(third.consecutiveFailures).toBe(ALERT_FAILURE_THRESHOLD);
        expect(notifyDevice).toHaveBeenCalledTimes(2);

        await monitor.runOnce('test');
        expect(notifyDevice).toHaveBeenCalledTimes(2);

        const notifyPayload = JSON.stringify(notifyDevice.mock.calls);
        expect(notifyPayload).toContain('Hermes health-check failed');
        expect(notifyPayload).not.toContain('ghp_secretsecretsecretsecret');
        expect(monitor.getStatus().lastAlertFailureCount).toBe(ALERT_FAILURE_THRESHOLD);
    });

    test('success resets consecutive failures and records SLA samples', async () => {
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
        });

        await monitor.runOnce('test');
        expect(monitor.getStatus().consecutiveFailures).toBe(1);

        fail = false;
        await monitor.runOnce('test');
        const status = monitor.getStatus();

        expect(status.consecutiveFailures).toBe(0);
        expect(status.lastError).toBe(null);
        expect(status.sla.sampleCount).toBe(2);
        expect(status.sla.successCount).toBe(1);
        expect(status.sla.failureCount).toBe(1);
    });

    test('sanitizes credentials from git remote errors', () => {
        expect(sanitizeForLog('https://x-access-token:abc123@github.com/acme/repo.git ghp_abcdefghijklmnopqrstuvwxyz'))
            .not.toContain('abc123');
    });
});
