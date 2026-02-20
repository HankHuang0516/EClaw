/**
 * UX/UI Coverage Test
 *
 * Verifies all backend endpoints EXIST and RESPOND (no route 404, no timeout).
 * Coverage must be >= 98% for release approval.
 *
 * Key distinction:
 * - Route 404 (Express default) = endpoint missing = FAIL
 * - Business 404 ({"success":false,...}) = endpoint exists, valid error = PASS
 * - 5xx errors = server bug = FAIL
 * - Timeout = backend hung = FAIL
 */

const API_BASE = 'https://eclaw.up.railway.app';
const TIMEOUT_MS = 5000; // 5 seconds per endpoint

// Generate unique test device ID to ensure proper device registration
const TEST_DEVICE_ID = `ux-coverage-${Date.now()}`;
const TEST_DEVICE_SECRET = `ux-secret-${Date.now()}`;

// All API endpoints used by Android app UX
const ENDPOINTS = [
    // Core health
    { method: 'GET', path: '/', name: 'Root' },
    { method: 'GET', path: '/api/health', name: 'Health Check' },

    // Device registration flow (MainActivity -> EntityManager)
    { method: 'POST', path: '/api/device/register', name: 'Device Register',
      body: () => ({ deviceId: TEST_DEVICE_ID, deviceSecret: TEST_DEVICE_SECRET, entityId: 0, isTestDevice: true }) },

    // Device status (MainActivity Agent Cards)
    { method: 'POST', path: '/api/device/status', name: 'Device Status',
      body: () => ({ deviceId: TEST_DEVICE_ID, deviceSecret: TEST_DEVICE_SECRET, entityId: 0 }) },

    // Bind flow (OpenClaw binding)
    { method: 'POST', path: '/api/bind', name: 'Bind Entity',
      body: () => ({ code: 'INVALID' }) },

    // Entity list (MainActivity)
    { method: 'GET', path: '/api/entities', name: 'Get Entities' },

    // Entity status (Live Wallpaper polling)
    { method: 'GET', path: () => `/api/status?deviceId=${TEST_DEVICE_ID}&entityId=0`, name: 'Get Status' },

    // Transform (Entity state update)
    { method: 'POST', path: '/api/transform', name: 'Transform Entity',
      body: () => ({ deviceId: TEST_DEVICE_ID, deviceSecret: TEST_DEVICE_SECRET, entityId: 0, state: 'IDLE', message: 'test' }) },

    // Entity delete (EntityManager unbind)
    { method: 'DELETE', path: '/api/entity', name: 'Delete Entity',
      body: () => ({ deviceId: TEST_DEVICE_ID, entityId: 1, botSecret: 'wrong' }) },

    // Client speak (MainActivity message send)
    { method: 'POST', path: '/api/client/speak', name: 'Client Speak',
      body: () => ({ deviceId: TEST_DEVICE_ID, entityId: 0, text: 'Hello' }) },

    // Entity-to-entity speak (correct field names: fromEntityId, toEntityId)
    { method: 'POST', path: '/api/entity/speak-to', name: 'Entity Speak To',
      body: () => ({ deviceId: TEST_DEVICE_ID, fromEntityId: 0, toEntityId: 1, botSecret: 'wrong', text: 'Hi' }) },

    // Pending messages (Live Wallpaper message fetch)
    { method: 'GET', path: () => `/api/client/pending?deviceId=${TEST_DEVICE_ID}&entityId=0`,
      name: 'Get Pending' },

    // Debug devices (Debug view)
    { method: 'GET', path: '/api/debug/devices', name: 'Debug Devices' },

    // Debug reset (for testing)
    { method: 'POST', path: '/api/debug/reset', name: 'Debug Reset',
      body: () => ({ confirm: false }) },

    // Bot webhook register
    { method: 'POST', path: '/api/bot/register', name: 'Bot Register',
      body: () => ({ deviceId: TEST_DEVICE_ID, entityId: 0, botSecret: 'wrong', webhook_url: 'http://test.com', token: 'test', session_key: 'test' }) },

    // Bot webhook unregister
    { method: 'DELETE', path: () => `/api/bot/register?deviceId=${TEST_DEVICE_ID}&entityId=0&botSecret=wrong`,
      name: 'Bot Unregister' },
];

// Total endpoints count (for coverage calculation)
const TOTAL_ENDPOINTS = ENDPOINTS.length;

async function testEndpoint(endpoint) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    // Resolve dynamic path/body
    const path = typeof endpoint.path === 'function' ? endpoint.path() : endpoint.path;
    const body = typeof endpoint.body === 'function' ? endpoint.body() : endpoint.body;

    try {
        const url = `${API_BASE}${path}`;
        const options = {
            method: endpoint.method,
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal
        };

        if (body && (endpoint.method === 'POST' || endpoint.method === 'DELETE')) {
            options.body = JSON.stringify(body);
        }

        const res = await fetch(url, options);
        clearTimeout(timeout);

        const status = res.status;
        const isServerError = status >= 500;

        // Parse response to check for proper JSON
        let data = null;
        let isRoute404 = false;
        try {
            const text = await res.text();
            try {
                data = JSON.parse(text);
            } catch (e) {
                // Non-JSON response
                // Check if it's Express default 404 (HTML: "Cannot GET /path")
                if (status === 404 && text.includes('Cannot')) {
                    isRoute404 = true;
                }
            }
        } catch (e) {
            // Empty response body
        }

        // Business 404 (e.g., "Device not found") has JSON with success:false
        // This means endpoint EXISTS but returns error - this is VALID
        const isBusiness404 = status === 404 && data && 'success' in data;

        // Route 404 means endpoint doesn't exist - this is FAIL
        isRoute404 = isRoute404 || (status === 404 && !isBusiness404);

        // PASS if: not route 404, not server error, responded with something
        const passed = !isRoute404 && !isServerError;

        return {
            name: endpoint.name,
            path: path,
            method: endpoint.method,
            status,
            passed,
            isRoute404,
            isBusiness404,
            isServerError,
            hasResponse: data !== null,
            error: null
        };
    } catch (err) {
        clearTimeout(timeout);
        return {
            name: endpoint.name,
            path: path,
            method: endpoint.method,
            status: 0,
            passed: false,
            isRoute404: false,
            isBusiness404: false,
            isServerError: false,
            hasResponse: false,
            error: err.name === 'AbortError' ? 'TIMEOUT' : err.message
        };
    }
}

async function runTests() {
    console.log('='.repeat(60));
    console.log('UX/UI COVERAGE TEST');
    console.log('='.repeat(60));
    console.log(`Target: ${API_BASE}`);
    console.log(`Required Coverage: >= 98%`);
    console.log(`Endpoints to test: ${ENDPOINTS.length}\n`);

    let passed = 0;
    let failed = 0;
    const failures = [];

    for (const endpoint of ENDPOINTS) {
        process.stdout.write(`Testing ${endpoint.method.padEnd(6)} ${endpoint.name.padEnd(20)}... `);

        const result = await testEndpoint(endpoint);

        if (result.passed) {
            const note = result.isBusiness404 ? '(biz 404)' : '';
            console.log(`??${result.status} ${note}`);
            passed++;
        } else {
            const reason = result.error ||
                (result.isRoute404 ? 'ROUTE 404 (endpoint missing!)' :
                (result.isServerError ? `SERVER ERROR ${result.status}` :
                `UNEXPECTED ${result.status}`));
            console.log(`??${reason}`);
            failed++;
            failures.push(result);
        }
    }

    // Log / Telemetry API Verification
    console.log('\n--- Log / Telemetry API Verification ---');
    try {
        const telUrl = `${API_BASE}/api/device-telemetry?deviceId=${TEST_DEVICE_ID}&deviceSecret=${encodeURIComponent(TEST_DEVICE_SECRET)}&type=api_req`;
        const telRes = await fetch(telUrl);
        const telData = await telRes.json();
        if (telData.success && telData.entries && telData.entries.length > 0) {
            const actions = telData.entries.map(e => e.action);
            const hasRegister = actions.some(a => a.includes('/api/device/register'));
            const hasStatus = actions.some(a => a.includes('/api/status'));
            const withDuration = telData.entries.filter(e => e.duration != null && e.duration > 0);
            console.log(`  Telemetry: ${telData.entries.length} entries captured (${withDuration.length} with duration)`);
            console.log(`  POST /api/device/register logged: ${hasRegister}`);
            console.log(`  GET /api/status logged: ${hasStatus}`);
            if (hasRegister) passed++; else failed++;
            if (hasStatus) passed++; else failed++;
            if (withDuration.length > 0) passed++; else failed++;
        } else {
            console.log('  Telemetry: no entries captured');
        }

        const logUrl = `${API_BASE}/api/logs?deviceId=${TEST_DEVICE_ID}&deviceSecret=${encodeURIComponent(TEST_DEVICE_SECRET)}&limit=50`;
        const logRes = await fetch(logUrl);
        const logData = await logRes.json();
        if (logData.success) {
            console.log(`  Server logs: ${logData.count} entries`);
            passed++;
        } else {
            console.log('  Server log API not accessible');
            failed++;
        }
    } catch (err) {
        console.log(`  Telemetry verification error: ${err.message}`);
    }

    // Calculate coverage
    const coverage = ((passed / TOTAL_ENDPOINTS) * 100).toFixed(1);
    const coverageMet = parseFloat(coverage) >= 98.0;

    // Summary
    console.log('\n' + '='.repeat(60));
    console.log('UX COVERAGE SUMMARY');
    console.log('='.repeat(60));
    console.log(`Endpoints Tested: ${ENDPOINTS.length}`);
    console.log(`Passed: ${passed}`);
    console.log(`Failed: ${failed}`);
    console.log(`Coverage: ${coverage}%`);
    console.log('');

    if (failures.length > 0) {
        console.log('FAILURES:');
        failures.forEach(f => {
            console.log(`  - ${f.method} ${f.path}: ${f.error || f.status}`);
        });
        console.log('');
    }

    if (coverageMet && failed === 0) {
        console.log('??UX Coverage Test PASSED');
        console.log('All endpoints respond correctly, no 404 or timeout errors.');
    } else if (!coverageMet) {
        console.log(`??UX Coverage Test FAILED - Coverage ${coverage}% < 98%`);
        console.log('Fix failing endpoints before release.');
    } else {
        console.log('??UX Coverage Test FAILED - Some endpoints failed');
        console.log('Fix failing endpoints before release.');
    }

    return { passed, failed, coverage: parseFloat(coverage), coverageMet };
}

// Run tests
runTests()
    .then(result => {
        if (result.coverageMet && result.failed === 0) {
            console.log('\nAll tests passed');
        }
    })
    .catch(err => {
        console.error('Test error:', err.message);
    });
