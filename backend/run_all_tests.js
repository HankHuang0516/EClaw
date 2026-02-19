/**
 * Regression Test Runner
 * Runs all backend tests before release
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');

// Test directory
const TEST_DIR = path.join(__dirname, 'tests');

// API Base URL
const API_BASE = process.env.API_BASE_URL || 'http://localhost:3000';

// Load .env for credential-based tests
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    for (const line of envContent.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx > 0) {
            const key = trimmed.slice(0, eqIdx);
            const val = trimmed.slice(eqIdx + 1);
            if (!process.env[key]) process.env[key] = val;
        }
    }
}

// Test files to run (in order of importance)
// Note: Tests must be v5 compatible (deviceId + entityId based)
const TEST_FILES = [
    // ── Core API tests (no credentials needed) ──
    'test_ux_coverage.js',          // REQUIRED: UX coverage must be >= 98%
    'test_ux_improvements.js',      // Critical: API structure, isBound
    'test_device_isolation.js',     // Critical: Multi-device isolation
    'test_messaging.js',            // Core: Message delivery
    'test_webhook.js',              // Feature: Webhook push
    'test_entity_delete.js',        // Feature: Entity deletion (40 entities stress test)
    'test_widget_ux.js',            // Widget: Chat dialog flow, broadcast
    'test_chat_monitoring.js',      // Chat: Multi-entity speak-to, broadcast, dedup, rate limit
    'test_usage_limit.js',          // Usage: 15-message limit, premium bypass
    'test_mission_publish.js',      // Mission: TODO/RULE CRUD, incremental notify, delta publish
    'test_entity_name_preservation.js', // Entity name persistence across rebind
    'test_entity_echo_bug.js',      // Echo deduplication regression

    // ── Credential-based tests (require .env with test device credentials) ──
    'test-broadcast.js',            // Broadcast delivery + delivered_to append (needs BROADCAST_TEST_DEVICE_ID)
    'test-bot-api-response.js',     // Bot API response rate >= 90% (needs TEST_DEVICE_ID + live bot)
];

// Manual UI tests (run on device, not automated):
// - test_entity_isolation.js     - Manual device UI testing
// - test_entity_communication.js - Manual device UI testing
// - test_name_feature.js         - Manual device UI testing

const TEST_TIMEOUT = 300000; // 300 seconds per test (bot-api-response polls each test up to 120s)

/**
 * Clean up test environment before/after tests
 * Calls /api/debug/reset with deviceSecret
 */
async function cleanupTestEnvironment() {
    return new Promise((resolve) => {
        const debugSecret = process.env.DEBUG_RESET_SECRET || 'test_debug_secret';

        const postData = JSON.stringify({ deviceSecret: debugSecret });

        const options = {
            hostname: new URL(API_BASE).hostname,
            port: new URL(API_BASE).port || 3000,
            path: '/api/debug/reset',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
            }
        };

        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                if (res.statusCode === 200) {
                    console.log('🧹 Test environment cleaned up');
                    resolve(true);
                } else {
                    console.log(`⚠️  Cleanup returned status ${res.statusCode}: ${data}`);
                    resolve(false);
                }
            });
        });

        req.on('error', (err) => {
            console.log(`⚠️  Cleanup failed (server may not be running): ${err.message}`);
            resolve(false);
        });

        req.write(postData);
        req.end();
    });
}

async function runTest(testFile) {
    return new Promise((resolve) => {
        const testPath = path.join(TEST_DIR, testFile);

        if (!fs.existsSync(testPath)) {
            console.log(`SKIP: ${testFile} (file not found)`);
            resolve({ file: testFile, passed: true, skipped: true });
            return;
        }

        console.log(`\n${'='.repeat(60)}`);
        console.log(`Running: ${testFile}`);
        console.log('='.repeat(60));

        const child = spawn('node', [testPath], {
            cwd: TEST_DIR,
            env: { ...process.env },
            stdio: 'pipe'
        });

        let output = '';
        let resolved = false;

        // Timeout handler
        const timeout = setTimeout(() => {
            if (!resolved) {
                resolved = true;
                child.kill();
                console.log(`\n⏱️ TIMEOUT: ${testFile} (${TEST_TIMEOUT / 1000}s)`);
                resolve({ file: testFile, passed: false, timeout: true });
            }
        }, TEST_TIMEOUT);

        child.stdout.on('data', (data) => {
            const str = data.toString();
            output += str;
            process.stdout.write(str);
        });

        child.stderr.on('data', (data) => {
            const str = data.toString();
            output += str;
            process.stderr.write(str);
        });

        child.on('close', (code) => {
            if (resolved) return;
            resolved = true;
            clearTimeout(timeout);

            // Check for various pass patterns
            const passed =
                output.includes('All tests passed') ||
                output.includes('all tests passed') ||
                output.includes('All isolation tests passed') ||
                output.includes('deletion tests passed') ||
                output.includes('webhook registration tests passed') ||
                (output.includes('RESULTS:') && output.includes(', 0 failed')) ||
                (output.includes('Results:') && output.includes('0 failed')) ||
                (output.includes('Result:') && output.includes('passed') && !output.includes('0/')) ||
                (output.match(/\d+\/\d+ tests passed/) && output.includes('✅')) ||
                output.includes('RESULT: ALL PASS') ||       // test-broadcast.js
                output.includes('RESULT: PASS')              // test-bot-api-response.js
            resolve({ file: testFile, passed, code, output });
        });

        child.on('error', (err) => {
            if (resolved) return;
            resolved = true;
            clearTimeout(timeout);
            console.error(`Error running ${testFile}:`, err.message);
            resolve({ file: testFile, passed: false, error: err.message });
        });
    });
}

async function main() {
    console.log('='.repeat(60));
    console.log('REGRESSION TEST RUNNER');
    console.log('='.repeat(60));
    console.log(`Date: ${new Date().toISOString()}`);
    console.log(`Tests to run: ${TEST_FILES.length}`);

    const results = [];

    // Pre-test cleanup
    console.log('\n🧹 Pre-test cleanup...');
    await cleanupTestEnvironment();

    for (const testFile of TEST_FILES) {
        const result = await runTest(testFile);
        results.push(result);
    }

    // Post-test cleanup
    console.log('\n🧹 Post-test cleanup...');
    await cleanupTestEnvironment();

    // Summary
    console.log('\n' + '='.repeat(60));
    console.log('REGRESSION TEST SUMMARY');
    console.log('='.repeat(60));

    let passCount = 0;
    let failCount = 0;
    let skipCount = 0;

    for (const r of results) {
        if (r.skipped) {
            console.log(`⏭️  SKIP: ${r.file}`);
            skipCount++;
        } else if (r.timeout) {
            console.log(`⏱️  TIMEOUT: ${r.file}`);
            failCount++;
        } else if (r.passed) {
            console.log(`✅ PASS: ${r.file}`);
            passCount++;
        } else {
            console.log(`❌ FAIL: ${r.file}`);
            failCount++;
        }
    }

    console.log('\n' + '-'.repeat(60));
    console.log(`Total: ${passCount} passed, ${failCount} failed, ${skipCount} skipped`);
    console.log('-'.repeat(60));

    if (failCount > 0) {
        console.log('\n❌ RELEASE BLOCKED: Some tests failed!');
        console.log('Fix the failing tests before releasing.');
        process.exit(1);
    } else {
        console.log('\n✅ ALL TESTS PASSED - Ready for release!');
        process.exit(0);
    }
}

main().catch(console.error);
