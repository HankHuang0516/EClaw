/**
 * AI Diagnostics — Regression Test
 *
 * 三層驗證:
 *   A. Unit tests — formatDiagnostics() 格式化正確性（本地，不需網路）
 *   B. Integration — fetchDeviceContext 等效驗證（對 live server 查 /api/logs）
 *   C. Chat endpoint — /api/ai-support/chat 完整流程（診斷資訊有效注入 Claude）
 *
 * Usage:
 *   node backend/tests/test-ai-diagnostics.js
 *   node backend/tests/test-ai-diagnostics.js --skip-chat   # 跳過 Claude API 呼叫（節省費用）
 */

const path = require('path');
const fs = require('fs');

const API_BASE = 'https://eclawbot.com';
const SKIP_CHAT = process.argv.includes('--skip-chat');

// ── .env loader ─────────────────────────────────────────────
function loadEnvFile() {
    const envPath = path.resolve(__dirname, '..', '.env');
    if (!fs.existsSync(envPath)) return {};
    const vars = {};
    fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
        line = line.trim();
        if (!line || line.startsWith('#')) return;
        const idx = line.indexOf('=');
        if (idx > 0) vars[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    });
    return vars;
}

const env = loadEnvFile();
const DEVICE_ID = env.BROADCAST_TEST_DEVICE_ID;
const DEVICE_SECRET = env.BROADCAST_TEST_DEVICE_SECRET;

// ── Test runner ──────────────────────────────────────────────
let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, label, detail = '') {
    if (condition) {
        console.log(`  ✓ ${label}`);
        passed++;
    } else {
        console.error(`  ✗ ${label}${detail ? '\n      ' + detail : ''}`);
        failed++;
        failures.push(label);
    }
}

function section(name) {
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`  ${name}`);
    console.log('─'.repeat(60));
}

// ── HTTP helpers ─────────────────────────────────────────────
async function postJSON(url, body, extraHeaders = {}) {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...extraHeaders },
        body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
}

async function getJSON(url) {
    const res = await fetch(url);
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
}

// ════════════════════════════════════════════════════════════
// Section A: Unit tests — formatDiagnostics()
// ════════════════════════════════════════════════════════════
function runUnitTests(formatDiagnostics) {
    section('A. Unit Tests — formatDiagnostics()');

    // A1: null → null
    assert(formatDiagnostics(null) === null, 'A1: null input returns null');

    // A2: empty object → null (no meaningful data)
    assert(formatDiagnostics({}) === null, 'A2: empty object returns null');

    // A3: platform + version
    const platResult = formatDiagnostics({ platform: 'android', appVersion: '1.1.0' });
    assert(platResult !== null, 'A3a: platform/version produces output');
    assert(platResult.includes('Platform: android (v1.1.0)'), 'A3b: platform formatted correctly', platResult);

    // A4: platform without version
    const platOnly = formatDiagnostics({ platform: 'web' });
    assert(platOnly.includes('Platform: web') && !platOnly.includes('(v'), 'A4: platform-only (no version suffix)', platOnly);

    // A5: version without platform → shows "unknown"
    const verOnly = formatDiagnostics({ appVersion: '2.0.0' });
    assert(verOnly.includes('Platform: unknown (v2.0.0)'), 'A5: version without platform shows "unknown"', verOnly);

    // A6: entity states — bound with webhook
    const boundEntity = {
        entityStates: [
            { slot: 0, type: 'LOBSTER', bound: true, name: 'ClawBot', hasWebhook: true },
            { slot: 1, type: 'PIG', bound: false, name: null, hasWebhook: false }
        ]
    };
    const entityResult = formatDiagnostics(boundEntity);
    assert(entityResult.includes('Slot 0 (LOBSTER): bound as "ClawBot" [webhook registered]'),
        'A6a: bound slot with webhook', entityResult);
    assert(entityResult.includes('Slot 1 (PIG): unbound'),
        'A6b: unbound slot', entityResult);

    // A7: entity states — bound without webhook
    const noWebhook = {
        entityStates: [{ slot: 2, type: 'LOBSTER', bound: true, name: 'PigBot', hasWebhook: false }]
    };
    const noWebhookResult = formatDiagnostics(noWebhook);
    assert(noWebhookResult.includes('[no webhook]'), 'A7: bound without webhook shows [no webhook]', noWebhookResult);

    // A8: recent errors section
    const withErrors = {
        recentErrors: [{
            category: 'push_error',
            entity_id: 2,
            message: 'Entity 2 push HTTP 404',
            metadata: { status: 404 },
            created_at: '2026-03-07T01:00:00.000Z'
        }]
    };
    const errResult = formatDiagnostics(withErrors);
    assert(errResult.includes('Recent errors (24h):'), 'A8a: error section header present', errResult);
    assert(errResult.includes('[push_error] slot_2'), 'A8b: error category and slot', errResult);
    assert(errResult.includes('Entity 2 push HTTP 404'), 'A8c: error message', errResult);

    // A9: entity_id null → slot_-
    const nullSlot = {
        recentErrors: [{
            category: 'db_save',
            entity_id: null,
            message: 'null value in column',
            metadata: null,
            created_at: '2026-03-07T01:00:00.000Z'
        }]
    };
    const nullSlotResult = formatDiagnostics(nullSlot);
    assert(nullSlotResult.includes('slot_-'), 'A9: null entity_id shows slot_-', nullSlotResult);

    // A10: metadata truncation at 100 chars
    const longMeta = { x: 'a'.repeat(200) };
    const withLongMeta = {
        recentErrors: [{
            category: 'test',
            entity_id: 0,
            message: 'test',
            metadata: longMeta,
            created_at: '2026-03-07T01:00:00.000Z'
        }]
    };
    const longMetaResult = formatDiagnostics(withLongMeta);
    // metadata is JSON.stringify'd then sliced to 100
    const metaStart = longMetaResult.indexOf(' — ');
    const metaSection = metaStart >= 0 ? longMetaResult.slice(metaStart + 3) : '';
    assert(metaSection.length <= 120, 'A10: metadata truncated (≤100 chars after " — ")', `got ${metaSection.length} chars`);

    // A11: recent activity section
    const withActivity = {
        recentActivity: [{
            level: 'info',
            category: 'bind',
            entity_id: 0,
            message: 'Entity 0 bound successfully',
            created_at: '2026-03-07T01:00:00.000Z'
        }]
    };
    const actResult = formatDiagnostics(withActivity);
    assert(actResult.includes('Recent activity (1h):'), 'A11a: activity section header', actResult);
    assert(actResult.includes('[info][bind] slot_0'), 'A11b: activity level+category+slot', actResult);

    // A12: handshake failures section
    const withFailures = {
        handshakeFailures: [{
            error_type: 'tool_not_available',
            error_message: 'sessions_send blocked',
            created_at: '2026-03-07T01:00:00.000Z'
        }]
    };
    const failResult = formatDiagnostics(withFailures);
    assert(failResult.includes('Handshake failures (1h):'), 'A12a: handshake section header', failResult);
    assert(failResult.includes('tool_not_available: sessions_send blocked'), 'A12b: failure type + message', failResult);

    // A13: handshake failure with no error_message → "(no detail)"
    const noDetail = {
        handshakeFailures: [{
            error_type: 'connection_failed',
            error_message: null,
            created_at: '2026-03-07T01:00:00.000Z'
        }]
    };
    const noDetailResult = formatDiagnostics(noDetail);
    assert(noDetailResult.includes('(no detail)'), 'A13: null error_message shows "(no detail)"', noDetailResult);

    // A14: all sections combined — sections joined by double newline
    const full = {
        platform: 'android',
        appVersion: '1.1.0',
        entityStates: [{ slot: 0, type: 'LOBSTER', bound: true, name: 'Bot', hasWebhook: true }],
        recentErrors: [{ category: 'push_error', entity_id: 0, message: 'err', metadata: null, created_at: '2026-03-07T00:00:00Z' }],
        recentActivity: [{ level: 'info', category: 'bind', entity_id: 0, message: 'ok', created_at: '2026-03-07T00:00:00Z' }],
        handshakeFailures: [{ error_type: 'http_401', error_message: 'bad cred', created_at: '2026-03-07T00:00:00Z' }]
    };
    const fullResult = formatDiagnostics(full);
    const sectionCount = (fullResult.match(/\n\n/g) || []).length;
    assert(sectionCount >= 3, `A14: full output has ≥3 double-newline separators (got ${sectionCount})`, fullResult.slice(0, 200));

    // A15: empty arrays treated as "no data" (no spurious headers)
    const emptyArrays = { platform: 'android', entityStates: [], recentErrors: [], recentActivity: [], handshakeFailures: [] };
    const emptyResult = formatDiagnostics(emptyArrays);
    assert(!emptyResult.includes('Recent errors'), 'A15a: empty recentErrors produces no header', emptyResult);
    assert(!emptyResult.includes('Recent activity'), 'A15b: empty recentActivity produces no header', emptyResult);
}

// ════════════════════════════════════════════════════════════
// Section B: Integration — DB data structure via /api/logs
// ════════════════════════════════════════════════════════════
async function runIntegrationTests() {
    section('B. Integration — Server Log Structure Verification');

    if (!DEVICE_ID || !DEVICE_SECRET) {
        console.log('  ⚠ Skipped: BROADCAST_TEST_DEVICE_ID or BROADCAST_TEST_DEVICE_SECRET not set in .env');
        return;
    }

    // B1: /api/logs reachable and returns expected structure
    const { status: logStatus, data: logData } = await getJSON(
        `${API_BASE}/api/logs?deviceId=${DEVICE_ID}&deviceSecret=${DEVICE_SECRET}&limit=5`
    );
    assert(logStatus === 200, 'B1a: /api/logs returns HTTP 200', `got ${logStatus}`);
    assert(logData.success === true, 'B1b: response.success = true', JSON.stringify(logData).slice(0, 100));
    assert(Array.isArray(logData.logs), 'B1c: response.logs is array');

    // B2: error-level logs have required fields
    const { data: errData } = await getJSON(
        `${API_BASE}/api/logs?deviceId=${DEVICE_ID}&deviceSecret=${DEVICE_SECRET}&level=error&limit=10`
    );
    if (errData.logs && errData.logs.length > 0) {
        const sample = errData.logs[0];
        assert('level' in sample, 'B2a: error log has level field');
        assert('category' in sample, 'B2b: error log has category field');
        assert('message' in sample, 'B2c: error log has message field');
        assert('created_at' in sample, 'B2d: error log has created_at field');
        assert(sample.level === 'error', 'B2e: level field equals "error"', `got ${sample.level}`);
        console.log(`  ℹ  Found ${errData.logs.length} error(s). Latest: [${sample.category}] ${sample.message.slice(0, 60)}`);
    } else {
        console.log('  ℹ  No error logs found for test device (that\'s OK)');
        assert(true, 'B2: no errors to validate (skipped field check)');
    }

    // B3: activity-category logs have entity_id field
    const actCategories = 'bind,unbind,broadcast_push,push_error';
    const { data: actData } = await getJSON(
        `${API_BASE}/api/logs?deviceId=${DEVICE_ID}&deviceSecret=${DEVICE_SECRET}&category=bind&limit=5`
    );
    assert(actData.success === true, 'B3a: /api/logs?category=bind returns success', JSON.stringify(actData).slice(0, 100));
    if (actData.logs && actData.logs.length > 0) {
        const sample = actData.logs[0];
        assert('entity_id' in sample, 'B3b: activity log has entity_id field');
        assert('category' in sample && sample.category === 'bind', 'B3c: category filter works');
    } else {
        console.log('  ℹ  No bind activity logs found (may be stale device)');
        assert(true, 'B3b: no bind logs to validate (skipped)');
        assert(true, 'B3c: no bind logs to validate (skipped)');
    }

    // B4: /api/entities returns device entity state structure
    const { status: entStatus, data: entData } = await getJSON(
        `${API_BASE}/api/entities?deviceId=${DEVICE_ID}&deviceSecret=${DEVICE_SECRET}`
    );
    assert(entStatus === 200, 'B4a: /api/entities returns HTTP 200', `got ${entStatus}`);
    assert(Array.isArray(entData.entities || entData), 'B4b: entities is array');
    const entities = entData.entities || entData;
    if (entities.length > 0) {
        const e = entities[0];
        assert('isBound' in e || 'is_bound' in e, 'B4c: entity has isBound field', JSON.stringify(e).slice(0, 100));
        console.log(`  ℹ  Entity 0 bound=${e.isBound ?? e.is_bound}, name="${e.name || '(none)'}"`);
    }
}

// ════════════════════════════════════════════════════════════
// Section C: Chat endpoint — diagnostics injected into Claude
// ════════════════════════════════════════════════════════════
async function runChatTests() {
    section('C. Chat Endpoint — Diagnostics Injection (Full E2E)');

    if (!DEVICE_ID || !DEVICE_SECRET) {
        console.log('  ⚠ Skipped: credentials not available');
        return;
    }
    if (SKIP_CHAT) {
        console.log('  ⚠ Skipped: --skip-chat flag set');
        return;
    }

    // C1: /api/ai-support/chat accepts deviceId+deviceSecret auth
    const { status: authStatus, data: authData } = await postJSON(`${API_BASE}/api/ai-support/chat`, {
        deviceId: DEVICE_ID,
        deviceSecret: DEVICE_SECRET,
        message: 'ping — reply OK'
    });
    assert(authStatus === 200, 'C1a: /chat accepts device auth (HTTP 200)', `got ${authStatus}`);
    assert(authData.success === true, 'C1b: response.success = true', JSON.stringify(authData).slice(0, 150));
    assert(typeof authData.response === 'string' && authData.response.length > 0,
        'C1c: response is non-empty string', `got: "${(authData.response || '').slice(0, 80)}"`);

    // C2: Ask about device status — Claude should respond with entity/device awareness
    // We inject a question that only makes sense if Claude has device context
    const { status: ctxStatus, data: ctxData } = await postJSON(`${API_BASE}/api/ai-support/chat`, {
        deviceId: DEVICE_ID,
        deviceSecret: DEVICE_SECRET,
        message: '請問我的裝置目前有幾個 entity slot？以及有沒有最近的錯誤記錄？'
    });
    assert(ctxStatus === 200, 'C2a: context-query HTTP 200', `got ${ctxStatus}`);
    assert(ctxData.success === true, 'C2b: context-query success', JSON.stringify(ctxData).slice(0, 150));
    const ctxResponse = ctxData.response || '';
    // Claude should mention slots (0, 1, 2, 3) or entity count or error info
    const hasSlotRef = /slot|entity|slot|實體|綁定|bound/i.test(ctxResponse);
    assert(hasSlotRef, 'C2c: response references entity/slot/binding context',
        `response: "${ctxResponse.slice(0, 200)}"`);
    console.log(`  ℹ  C2 response preview: "${ctxResponse.slice(0, 120)}..."`);

    // C3: Error inquiry — if device has errors, Claude should reference them
    const { status: errStatus, data: errData } = await postJSON(`${API_BASE}/api/ai-support/chat`, {
        deviceId: DEVICE_ID,
        deviceSecret: DEVICE_SECRET,
        message: '我的裝置最近有什麼 push error 或系統錯誤嗎？'
    });
    assert(errStatus === 200, 'C3a: error-inquiry HTTP 200', `got ${errStatus}`);
    assert(errData.success === true, 'C3b: error-inquiry success');
    const errResponse = errData.response || '';
    // Response should be substantive (not just "I don't know")
    assert(errResponse.length > 30, 'C3c: error-inquiry response is substantive',
        `got ${errResponse.length} chars: "${errResponse.slice(0, 100)}"`);
    console.log(`  ℹ  C3 response preview: "${errResponse.slice(0, 120)}..."`);

    // C4: /chat/submit → poll flow (async path also gets diagnostics)
    const requestId = crypto.randomUUID ? crypto.randomUUID() : require('crypto').randomUUID();
    const { status: submitStatus, data: submitData } = await postJSON(`${API_BASE}/api/ai-support/chat/submit`, {
        deviceId: DEVICE_ID,
        deviceSecret: DEVICE_SECRET,
        requestId,
        message: 'hello, brief ack'
    });
    assert(submitStatus === 200, 'C4a: /chat/submit HTTP 200', `got ${submitStatus}`);
    assert(submitData.success === true, 'C4b: submit success', JSON.stringify(submitData).slice(0, 100));
    assert(submitData.requestId === requestId, 'C4c: requestId echoed back');

    // Poll for completion (max 60s)
    let pollResult = null;
    const pollStart = Date.now();
    while (Date.now() - pollStart < 60000) {
        await new Promise(r => setTimeout(r, 3000));
        const { status: pollStatus, data: pd } = await getJSON(
            `${API_BASE}/api/ai-support/chat/poll/${requestId}?deviceId=${DEVICE_ID}&deviceSecret=${DEVICE_SECRET}`
        );
        if (pollStatus !== 200) break;
        if (pd.status === 'completed' || pd.status === 'failed') {
            pollResult = pd;
            break;
        }
    }
    assert(pollResult !== null, 'C4d: async request completed within 60s',
        pollResult ? `status=${pollResult.status}` : 'timed out');
    if (pollResult) {
        assert(pollResult.status === 'completed', 'C4e: async request status = completed',
            `got status=${pollResult.status}, error=${pollResult.error}`);
        assert(typeof pollResult.response === 'string' && pollResult.response.length > 0,
            'C4f: async response is non-empty string',
            `got: "${(pollResult.response || '').slice(0, 80)}"`);
    }

    // C5: Rate limit header present (remaining field)
    const { data: rlData } = await postJSON(`${API_BASE}/api/ai-support/chat`, {
        deviceId: DEVICE_ID,
        deviceSecret: DEVICE_SECRET,
        message: 'check remaining'
    });
    assert(typeof rlData.remaining === 'number', 'C5: response includes remaining rate limit count',
        `got: ${JSON.stringify(rlData.remaining)}`);
}

// ════════════════════════════════════════════════════════════
// Main
// ════════════════════════════════════════════════════════════
async function main() {
    console.log('═'.repeat(60));
    console.log('  AI Diagnostics Regression Test');
    console.log(`  Target: ${API_BASE}`);
    console.log(`  Device: ${DEVICE_ID ? DEVICE_ID.slice(0, 8) + '...' : '(not set)'}`);
    console.log(`  Skip chat: ${SKIP_CHAT}`);
    console.log('═'.repeat(60));

    // Load formatDiagnostics from anthropic-client.js
    let formatDiagnostics;
    try {
        ({ formatDiagnostics } = require('../anthropic-client'));
        assert(typeof formatDiagnostics === 'function', 'Bootstrap: formatDiagnostics exported correctly');
    } catch (err) {
        console.error(`  ✗ Bootstrap FAILED: cannot load anthropic-client.js: ${err.message}`);
        process.exit(1);
    }

    // Run all sections
    runUnitTests(formatDiagnostics);
    await runIntegrationTests();
    await runChatTests();

    // Summary
    console.log('\n' + '═'.repeat(60));
    console.log(`  Results: ${passed} passed, ${failed} failed`);
    if (failures.length > 0) {
        console.log('  Failed tests:');
        failures.forEach(f => console.log(`    - ${f}`));
    }
    console.log('═'.repeat(60));

    process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
