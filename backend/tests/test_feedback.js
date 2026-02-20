/**
 * Feedback + Log Snapshot Integration Test
 *
 * Tests the enhanced feedback flow:
 *   1. Register device + bind entity → generate some API activity
 *   2. POST /api/feedback/mark → set mark timestamp
 *   3. Generate more API activity (to appear in log snapshot)
 *   4. POST /api/feedback → submit with auto log capture
 *   5. Verify feedback response contains triage info + log counts
 *   6. GET /api/feedback → list feedback
 *   7. GET /api/feedback/:id → get full record with log_snapshot
 *   8. GET /api/feedback/:id/ai-prompt → verify AI prompt generation
 *   9. PATCH /api/feedback/:id → update status
 */

const API_BASE = process.env.API_BASE || 'https://eclaw.up.railway.app';

const TEST_DEVICE_ID = `test-feedback-${Date.now()}`;
const TEST_DEVICE_SECRET = `secret-${Date.now()}`;

let passed = 0;
let failed = 0;
let feedbackId = null;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function api(method, path, body = null, retries = 2) {
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const options = { method, headers: { 'Content-Type': 'application/json' } };
            if (body) options.body = JSON.stringify(body);
            const res = await fetch(`${API_BASE}${path}`, options);
            const text = await res.text();
            await sleep(150);
            try {
                return { status: res.status, data: JSON.parse(text) };
            } catch {
                return { status: res.status, data: text };
            }
        } catch (e) {
            if (attempt < retries) {
                await sleep(1000 * (attempt + 1));
                continue;
            }
            return { status: 0, data: { error: e.message } };
        }
    }
}

function assert(label, condition, detail) {
    if (condition) {
        console.log(`  OK ${label}`);
        passed++;
    } else {
        console.log(`  FAIL ${label}${detail ? ': ' + JSON.stringify(detail) : ''}`);
        failed++;
    }
}

// ==============================
// Setup: Create device + API activity
// ==============================

async function setup() {
    console.log('--- Setup: Create device with bound entity ---\n');

    const reg = await api('POST', '/api/device/register', {
        deviceId: TEST_DEVICE_ID,
        deviceSecret: TEST_DEVICE_SECRET,
        entityId: 0,
        appVersion: 'test-feedback',
        isTestDevice: true
    });
    assert('Register device', reg.data.success, reg.data);

    const bind = await api('POST', '/api/bind', { code: reg.data.bindingCode });
    assert('Bind entity 0', bind.data.success, bind.data);

    // Generate some API activity
    await api('POST', '/api/client/speak', {
        deviceId: TEST_DEVICE_ID, entityId: 0, text: 'Pre-feedback message', source: 'test'
    });
    await api('GET', `/api/status?deviceId=${TEST_DEVICE_ID}&entityId=0`);

    console.log('  API activity generated\n');
}

// ==============================
// Test: Mark timestamp
// ==============================

async function testMark() {
    console.log('--- Test: Mark bug moment ---\n');

    const { status, data } = await api('POST', '/api/feedback/mark', {
        deviceId: TEST_DEVICE_ID
    });
    assert('Mark returns 200', status === 200, { status });
    assert('Mark returns success', data.success === true, data);
    assert('Mark returns timestamp', typeof data.markTs === 'number', { markTs: data.markTs });

    // Generate more activity AFTER the mark
    await sleep(500);
    await api('POST', '/api/client/speak', {
        deviceId: TEST_DEVICE_ID, entityId: 0, text: 'Post-mark message 1', source: 'test'
    });
    await api('POST', '/api/client/speak', {
        deviceId: TEST_DEVICE_ID, entityId: 0, text: 'Post-mark message 2', source: 'test'
    });
    // Intentionally trigger a 404 error for triage to detect
    await api('POST', '/api/entity/speak-to', {
        deviceId: TEST_DEVICE_ID, fromEntityId: 0, toEntityId: 99, botSecret: 'wrong', text: 'bad'
    });

    console.log('  Post-mark API activity generated\n');
}

// ==============================
// Test: Submit feedback
// ==============================

async function testSubmitFeedback() {
    console.log('--- Test: Submit feedback with auto log capture ---\n');

    const { status, data } = await api('POST', '/api/feedback', {
        deviceId: TEST_DEVICE_ID,
        deviceSecret: TEST_DEVICE_SECRET,
        message: 'Test bug: entity message not delivered after binding',
        category: 'bug',
        appVersion: 'test-feedback-1.0'
    });

    assert('Feedback returns 200', status === 200, { status });
    assert('Feedback returns success', data.success === true, data);
    assert('Feedback returns feedbackId', typeof data.feedbackId === 'number', { feedbackId: data.feedbackId });
    assert('Feedback returns severity', typeof data.severity === 'string', { severity: data.severity });
    assert('Feedback returns tags array', Array.isArray(data.tags), { tags: data.tags });

    // Log capture verification
    assert('Logs captured: telemetry > 0', data.logsCaptured?.telemetry > 0, data.logsCaptured);
    assert('Logs captured: windowMs > 0', data.logsCaptured?.windowMs > 0, data.logsCaptured);

    feedbackId = data.feedbackId;
    console.log(`  Feedback #${feedbackId}: severity=${data.severity} tags=[${data.tags}]\n`);
}

// ==============================
// Test: List feedback
// ==============================

async function testListFeedback() {
    console.log('--- Test: List feedback ---\n');

    const { status, data } = await api('GET',
        `/api/feedback?deviceId=${TEST_DEVICE_ID}&deviceSecret=${TEST_DEVICE_SECRET}`
    );
    assert('List returns 200', status === 200, { status });
    assert('List returns success', data.success === true, data);
    assert('List contains feedback', data.count > 0, { count: data.count });

    const found = data.feedback?.find(f => f.id === feedbackId);
    assert('Our feedback found in list', !!found, { feedbackId });
    if (found) {
        assert('Feedback has severity', !!found.severity, { severity: found.severity });
        assert('Feedback has status=open', found.status === 'open', { status: found.status });
    }
}

// ==============================
// Test: Get single feedback (full record)
// ==============================

async function testGetFeedback() {
    console.log('--- Test: Get single feedback with log snapshot ---\n');

    if (!feedbackId) { console.log('  SKIP: no feedbackId'); return; }

    const { status, data } = await api('GET',
        `/api/feedback/${feedbackId}?deviceId=${TEST_DEVICE_ID}&deviceSecret=${TEST_DEVICE_SECRET}`
    );
    assert('Get returns 200', status === 200, { status });
    assert('Get returns success', data.success === true, data);

    const fb = data.feedback;
    assert('Feedback has log_snapshot', fb.log_snapshot != null, { hasSnapshot: !!fb.log_snapshot });
    assert('Feedback has device_state', fb.device_state != null, { hasState: !!fb.device_state });
    assert('Feedback has ai_diagnosis', typeof fb.ai_diagnosis === 'string', { diagnosis: fb.ai_diagnosis?.substring(0, 80) });

    if (fb.log_snapshot) {
        const snap = typeof fb.log_snapshot === 'string' ? JSON.parse(fb.log_snapshot) : fb.log_snapshot;
        assert('Snapshot has telemetry entries', Array.isArray(snap.telemetry) && snap.telemetry.length > 0, { count: snap.telemetry?.length });
        assert('Snapshot has capturedAt', typeof snap.capturedAt === 'number', { capturedAt: snap.capturedAt });
    }

    if (fb.device_state) {
        const state = typeof fb.device_state === 'string' ? JSON.parse(fb.device_state) : fb.device_state;
        assert('Device state has entities', Array.isArray(state.entities) && state.entities.length > 0, { count: state.entities?.length });
    }
}

// ==============================
// Test: AI prompt generation
// ==============================

async function testAiPrompt() {
    console.log('--- Test: AI prompt generation ---\n');

    if (!feedbackId) { console.log('  SKIP: no feedbackId'); return; }

    const { status, data } = await api('GET',
        `/api/feedback/${feedbackId}/ai-prompt?deviceId=${TEST_DEVICE_ID}&deviceSecret=${TEST_DEVICE_SECRET}`
    );
    assert('AI prompt returns 200', status === 200, { status });
    assert('AI prompt returns success', data.success === true, data);
    assert('Prompt is a string', typeof data.prompt === 'string', { length: data.prompt?.length });
    assert('Prompt contains bug description', data.prompt?.includes('entity message not delivered'), { preview: data.prompt?.substring(0, 100) });
    assert('Prompt contains API calls section', data.prompt?.includes('Recent API Calls'), { found: data.prompt?.includes('Recent API Calls') });
    assert('Prompt contains Device State section', data.prompt?.includes('Device State'), { found: data.prompt?.includes('Device State') });
    assert('Prompt contains Instructions for AI', data.prompt?.includes('Instructions for AI'), { found: data.prompt?.includes('Instructions for AI') });

    console.log(`  Prompt length: ${data.prompt?.length || 0} chars\n`);
}

// ==============================
// Test: Update feedback status
// ==============================

async function testUpdateFeedback() {
    console.log('--- Test: Update feedback status ---\n');

    if (!feedbackId) { console.log('  SKIP: no feedbackId'); return; }

    const { status, data } = await api('PATCH', `/api/feedback/${feedbackId}`, {
        deviceId: TEST_DEVICE_ID,
        deviceSecret: TEST_DEVICE_SECRET,
        status: 'diagnosed',
        resolution: 'Auto-test: verified feedback flow works correctly'
    });
    assert('Update returns 200', status === 200, { status });
    assert('Update success', data.success === true, data);

    // Verify the update
    const verify = await api('GET',
        `/api/feedback/${feedbackId}?deviceId=${TEST_DEVICE_ID}&deviceSecret=${TEST_DEVICE_SECRET}`
    );
    assert('Status updated to diagnosed', verify.data.feedback?.status === 'diagnosed', { status: verify.data.feedback?.status });
    assert('Resolution saved', verify.data.feedback?.resolution?.includes('Auto-test'), { resolution: verify.data.feedback?.resolution });
}

// ==============================
// Test: Error cases
// ==============================

async function testErrorCases() {
    console.log('--- Test: Error handling ---\n');

    // Empty message
    const { status: s1 } = await api('POST', '/api/feedback', {
        deviceId: TEST_DEVICE_ID, message: ''
    });
    assert('Empty message returns 400', s1 === 400, { status: s1 });

    // Missing credentials for list
    const { status: s2 } = await api('GET', '/api/feedback');
    assert('List without creds returns 400', s2 === 400, { status: s2 });

    // Invalid credentials
    const { status: s3 } = await api('GET',
        `/api/feedback?deviceId=${TEST_DEVICE_ID}&deviceSecret=wrong`
    );
    assert('Wrong secret returns 401', s3 === 401, { status: s3 });

    // Non-existent feedback
    const { status: s4 } = await api('GET',
        `/api/feedback/999999?deviceId=${TEST_DEVICE_ID}&deviceSecret=${TEST_DEVICE_SECRET}`
    );
    assert('Non-existent feedback returns 404', s4 === 404, { status: s4 });

    // Mark without deviceId
    const { status: s5 } = await api('POST', '/api/feedback/mark', {});
    assert('Mark without deviceId returns 400', s5 === 400, { status: s5 });
}

// ==============================
// Test: Log / Telemetry API Verification
// ==============================

async function testLogApiVerification() {
    console.log('--- Log / Telemetry API Verification ---\n');

    const telRes = await api('GET',
        `/api/device-telemetry?deviceId=${TEST_DEVICE_ID}&deviceSecret=${TEST_DEVICE_SECRET}&type=api_req`
    );
    if (telRes.status === 200 && telRes.data.entries) {
        const actions = telRes.data.entries.map(e => e.action);
        assert('Telemetry captured API calls', telRes.data.entries.length > 0, { count: telRes.data.entries.length });
        assert('Telemetry logged POST /api/device/register', actions.some(a => a.includes('/api/device/register')));
        assert('Telemetry logged POST /api/client/speak', actions.some(a => a.includes('/api/client/speak')));
        assert('Telemetry logged POST /api/feedback', actions.some(a => a.includes('/api/feedback')));
        const withDuration = telRes.data.entries.filter(e => e.duration != null && e.duration > 0);
        assert('Telemetry entries include duration', withDuration.length > 0, { count: withDuration.length });
    }

    const logRes = await api('GET',
        `/api/logs?deviceId=${TEST_DEVICE_ID}&deviceSecret=${TEST_DEVICE_SECRET}&limit=50`
    );
    assert('Server log API accessible', logRes.status === 200 && logRes.data.success, { status: logRes.status });
}

// ==============================
// Main
// ==============================

async function main() {
    console.log('='.repeat(60));
    console.log('FEEDBACK + LOG SNAPSHOT INTEGRATION TEST');
    console.log('='.repeat(60));
    console.log(`API Base: ${API_BASE}`);
    console.log(`Test Device: ${TEST_DEVICE_ID}\n`);

    try {
        await setup();
        await testMark();
        await testSubmitFeedback();
        await testListFeedback();
        await testGetFeedback();
        await testAiPrompt();
        await testUpdateFeedback();
        await testErrorCases();
        await testLogApiVerification();
    } catch (e) {
        console.error('\nFATAL:', e.message);
        console.error(e.stack);
    }

    console.log(`\n${'='.repeat(60)}`);
    console.log(`FEEDBACK TEST SUMMARY: ${passed} passed, ${failed} failed`);
    console.log('='.repeat(60));

    if (failed > 0) {
        console.log(`\n${failed} assertion(s) FAILED`);
        process.exit(1);
    } else {
        console.log('\nAll feedback integration tests passed');
        process.exit(0);
    }
}

main().catch(e => {
    console.error('FATAL:', e);
    process.exit(1);
});
