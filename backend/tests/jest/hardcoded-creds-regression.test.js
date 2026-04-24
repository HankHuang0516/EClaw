/**
 * Regression test for issue #2022:
 *
 * Test + setup scripts previously inlined GATEWAY_TOKEN, SETUP_PASSWORD,
 * BROADCAST_TEST_DEVICE_ID, and BROADCAST_TEST_DEVICE_SECRET as literals.
 * The tokens are the real production gateway credentials for the Railway
 * template bot and the broadcast test device — committing them to the repo
 * leaks valid long-lived secrets to anyone with read access to git history.
 *
 * This test statically scans the affected files and fails if the known
 * leaked literals reappear, OR if the `process.env.<NAME>` read for each
 * required secret disappears. It also verifies the scripts exit non-zero
 * (refuse to proceed) when a required env var is missing.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..', '..');

// Literal values that previously shipped in the repo. Any reappearance =
// regression. Kept here (not in .env) so the grep remains self-contained.
const LEAKED_LITERALS = [
    '1a712b828ffc1b3d3a94978b7e9805be1591b175f3ee11637840e4437e49d232', // GATEWAY_TOKEN
    'asasas123',                                                          // SETUP_PASSWORD
    '2a0ad04d-9107-4250-b8be-ecd565983fb2',                               // BROADCAST_TEST_DEVICE_ID
    '77c91d51-7677-4c1f-aece-fe26fd651d6d-cfff4f91-6883-4450-b17d-1ae1cf4085b4', // BROADCAST_TEST_DEVICE_SECRET
];

const FILES_UNDER_TEST = [
    'tests/test-ws-auth.js',
    'scripts/setup_broadcast_webhook.js',
    'scripts/setup_test_bot.js',
];

describe('Issue #2022 — no hardcoded credentials in test/setup scripts', () => {
    test.each(FILES_UNDER_TEST)('%s contains none of the previously leaked literals', (rel) => {
        const body = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
        for (const lit of LEAKED_LITERALS) {
            expect(body).not.toContain(lit);
        }
    });

    test.each(FILES_UNDER_TEST)('%s reads GATEWAY_TOKEN and SETUP_PASSWORD from process.env', (rel) => {
        const body = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
        expect(body).toMatch(/process\.env\.GATEWAY_TOKEN|process\.env\[['"]GATEWAY_TOKEN['"]\]|requireEnv\(['"]GATEWAY_TOKEN['"]\)/);
        expect(body).toMatch(/process\.env\.SETUP_PASSWORD|process\.env\[['"]SETUP_PASSWORD['"]\]|requireEnv\(['"]SETUP_PASSWORD['"]\)/);
    });

    test('setup_broadcast_webhook.js reads BROADCAST_TEST_DEVICE_ID/SECRET from process.env', () => {
        const body = fs.readFileSync(
            path.join(REPO_ROOT, 'scripts/setup_broadcast_webhook.js'), 'utf8');
        expect(body).toMatch(/BROADCAST_TEST_DEVICE_ID/);
        expect(body).toMatch(/BROADCAST_TEST_DEVICE_SECRET/);
        // Must be read through env, not inlined.
        expect(body).toMatch(/requireEnv\(['"]BROADCAST_TEST_DEVICE_ID['"]\)|process\.env\.BROADCAST_TEST_DEVICE_ID/);
        expect(body).toMatch(/requireEnv\(['"]BROADCAST_TEST_DEVICE_SECRET['"]\)|process\.env\.BROADCAST_TEST_DEVICE_SECRET/);
    });
});

describe('Issue #2022 — scripts refuse to run without required env vars', () => {
    // Each script should exit non-zero with a clear error, not silently proceed
    // with undefined credentials or fall back to the removed hardcoded ones.
    const scripts = [
        'tests/test-ws-auth.js',
        'scripts/setup_broadcast_webhook.js',
        'scripts/setup_test_bot.js',
    ];

    test.each(scripts)('%s exits non-zero when GATEWAY_TOKEN/SETUP_PASSWORD missing', (rel) => {
        const cleanEnv = { ...process.env };
        delete cleanEnv.GATEWAY_TOKEN;
        delete cleanEnv.SETUP_PASSWORD;
        delete cleanEnv.BROADCAST_TEST_DEVICE_ID;
        delete cleanEnv.BROADCAST_TEST_DEVICE_SECRET;
        // Point dotenv at a path that doesn't exist so it can't rehydrate env.
        cleanEnv.DOTENV_CONFIG_PATH = '/tmp/nonexistent-' + Date.now() + '.env';

        const result = spawnSync('node', [path.join(REPO_ROOT, rel)], {
            env: cleanEnv,
            cwd: REPO_ROOT,
            timeout: 10000,
            encoding: 'utf8',
        });

        expect(result.status).not.toBe(0);
        const combined = (result.stdout || '') + (result.stderr || '');
        expect(combined).toMatch(/Missing env var/i);
    }, 15000);
});
