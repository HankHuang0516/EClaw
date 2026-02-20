/**
 * Mission Control Incremental Publish Test
 *
 * Tests the Mission Control notification flow and delta publishing:
 * 1. Create a TODO item → save → notify → verify notification sent
 * 2. Fetch dashboard → record version/state
 * 3. Add a RULE → save → notify
 * 4. Verify notification only contains the RULE changes (delta publish)
 * 5. Verify dashboard version incremented
 * 6. Clean up: delete TODO and RULE
 */

const API_BASE = process.env.API_BASE || 'https://eclaw.up.railway.app';

const TEST_DEVICE_ID = `test-mission-${Date.now()}`;
const TEST_DEVICE_SECRET = 'test-secret';

let passed = 0;
let failed = 0;
let boundEntities = [];

// ==============================
// Helpers
// ==============================

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
        console.log(`  ✅ ${label}`);
        passed++;
    } else {
        console.log(`  ❌ ${label}${detail ? ': ' + JSON.stringify(detail) : ''}`);
        failed++;
    }
}

async function registerAndBind(entityId) {
    const { data: regData } = await api('POST', '/api/device/register', {
        deviceId: TEST_DEVICE_ID,
        deviceSecret: TEST_DEVICE_SECRET,
        entityId,
        appVersion: '1.0.3',
        isTestDevice: true
    });
    const { data: bindData } = await api('POST', '/api/bind', {
        code: regData.bindingCode
    });
    return { entityId, botSecret: bindData.botSecret };
}

// ==============================
// Setup
// ==============================

async function setup() {
    console.log('============================================================');
    console.log('MISSION CONTROL INCREMENTAL PUBLISH TEST');
    console.log('============================================================');
    console.log(`API Base: ${API_BASE}`);
    console.log(`Test Device: ${TEST_DEVICE_ID}\n`);

    // Bind entities 0 and 1
    for (let i = 0; i < 2; i++) {
        const ent = await registerAndBind(i);
        boundEntities.push(ent);
        console.log(`Setup: Entity ${i} bound`);
    }
    console.log('');
}

// ==============================
// Tests
// ==============================

async function testCreateTodoAndNotify() {
    console.log('--- Step 1: Create TODO and notify ---');

    const todoTitle = `Test-TODO-${Date.now()}`;

    // Add a TODO
    const { status: addStatus, data: addData } = await api('POST', '/api/mission/todo/add', {
        deviceId: TEST_DEVICE_ID,
        deviceSecret: TEST_DEVICE_SECRET,
        title: todoTitle,
        description: 'Test task for incremental publish',
        priority: 2,
        assignedBot: '0,1'
    });

    assert('TODO created successfully', addStatus === 200 && addData.success, addData);
    assert('TODO item returned', addData.item?.title === todoTitle, addData.item);

    // Send notification for the TODO
    const { status: notifyStatus, data: notifyData } = await api('POST', '/api/mission/notify', {
        deviceId: TEST_DEVICE_ID,
        deviceSecret: TEST_DEVICE_SECRET,
        notifications: [{
            type: 'TODO',
            title: todoTitle,
            priority: 2,
            entityIds: [0, 1]
        }]
    });

    assert('notify returns 200', notifyStatus === 200, { status: notifyStatus });
    assert('notify success', notifyData.success === true, notifyData);
    assert('chatMessageId returned', notifyData.chatMessageId != null, notifyData);
    assert('notification sent to 2 entities', notifyData.total === 2, notifyData);

    return todoTitle;
}

async function testGetDashboardVersion() {
    console.log('\n--- Step 2: Get dashboard version ---');

    const { status, data } = await api('GET',
        `/api/mission/dashboard?deviceId=${TEST_DEVICE_ID}&deviceSecret=${TEST_DEVICE_SECRET}`
    );

    assert('dashboard returns 200', status === 200, { status });
    assert('dashboard success', data.success === true, data);
    assert('dashboard has version', typeof data.dashboard?.version === 'number', data.dashboard);
    assert('dashboard has todoList', Array.isArray(data.dashboard?.todoList), data.dashboard);

    return data.dashboard?.version || 0;
}

async function testAddRuleAndNotify(todoTitle) {
    console.log('\n--- Step 3: Add RULE and send delta notification ---');

    const ruleName = `Test-Rule-${Date.now()}`;

    // Add a RULE
    const { status: ruleStatus, data: ruleData } = await api('POST', '/api/mission/rule/add', {
        deviceId: TEST_DEVICE_ID,
        deviceSecret: TEST_DEVICE_SECRET,
        name: ruleName,
        description: 'Always respond in Traditional Chinese',
        ruleType: 'BEHAVIOR',
        assignedEntities: ['0', '1']
    });

    assert('RULE created successfully', ruleStatus === 200 && ruleData.success, ruleData);

    // Send notification ONLY for the RULE (delta - not re-sending the TODO)
    const { status: notifyStatus, data: notifyData } = await api('POST', '/api/mission/notify', {
        deviceId: TEST_DEVICE_ID,
        deviceSecret: TEST_DEVICE_SECRET,
        notifications: [{
            type: 'RULE',
            title: ruleName,
            priority: 2,
            entityIds: [0, 1]
        }]
    });

    assert('RULE notify returns 200', notifyStatus === 200, { status: notifyStatus });
    assert('RULE notify success', notifyData.success === true, notifyData);

    // Verify the notification chat message contains ONLY the RULE, not the TODO
    const { data: historyData } = await api('GET',
        `/api/chat/history?deviceId=${TEST_DEVICE_ID}&deviceSecret=${TEST_DEVICE_SECRET}&limit=5`
    );

    if (historyData.success && historyData.messages?.length > 0) {
        // Find the most recent mission_notify message
        const latestNotify = historyData.messages
            .filter(m => m.source?.startsWith('mission_notify'))
            .pop();

        if (latestNotify) {
            const containsRule = latestNotify.text.includes(ruleName);
            const containsTodo = latestNotify.text.includes(todoTitle);

            assert('latest notification contains RULE', containsRule, { text: latestNotify.text?.slice(0, 100) });
            assert('latest notification does NOT contain previous TODO (delta)', !containsTodo,
                { text: latestNotify.text?.slice(0, 100) });
        } else {
            assert('mission_notify message found in history', false, { messages: historyData.messages?.length });
        }
    } else {
        assert('chat history available for delta check', false, historyData);
    }

    return ruleName;
}

async function testVersionIncremented(prevVersion) {
    console.log('\n--- Step 4: Verify dashboard version incremented ---');

    const { data } = await api('GET',
        `/api/mission/dashboard?deviceId=${TEST_DEVICE_ID}&deviceSecret=${TEST_DEVICE_SECRET}`
    );

    const newVersion = data.dashboard?.version || 0;
    assert('dashboard version incremented', newVersion > prevVersion,
        { prevVersion, newVersion });

    // Verify both TODO and RULE exist
    const todoCount = data.dashboard?.todoList?.length || 0;
    const ruleCount = data.dashboard?.rules?.length || 0;
    assert('todoList has items', todoCount > 0, { todoCount });
    // Rules may include system rules, check at least 1 custom
    assert('rules list has items', ruleCount > 0, { ruleCount });

    return newVersion;
}

async function testCleanup(todoTitle, ruleName) {
    console.log('\n--- Step 5: Cleanup (delete TODO and RULE) ---');

    const { status: s1, data: d1 } = await api('POST', '/api/mission/todo/delete', {
        deviceId: TEST_DEVICE_ID,
        deviceSecret: TEST_DEVICE_SECRET,
        title: todoTitle
    });
    assert('TODO deleted', s1 === 200 && d1.success, d1);

    const { status: s2, data: d2 } = await api('POST', '/api/mission/rule/delete', {
        deviceId: TEST_DEVICE_ID,
        deviceSecret: TEST_DEVICE_SECRET,
        name: ruleName
    });
    assert('RULE deleted', s2 === 200 && d2.success, d2);
}

async function testMissionApiErrors() {
    console.log('\n--- Step 6: Mission API error handling ---');

    // Missing notifications array
    const { status: s1 } = await api('POST', '/api/mission/notify', {
        deviceId: TEST_DEVICE_ID,
        deviceSecret: TEST_DEVICE_SECRET,
        notifications: []
    });
    assert('empty notifications returns 400', s1 === 400, { status: s1 });

    // Missing title on TODO add
    const { status: s2 } = await api('POST', '/api/mission/todo/add', {
        deviceId: TEST_DEVICE_ID,
        deviceSecret: TEST_DEVICE_SECRET,
        description: 'no title'
    });
    assert('missing title returns 400', s2 === 400, { status: s2 });

    // Delete non-existent TODO
    const { status: s3 } = await api('POST', '/api/mission/todo/delete', {
        deviceId: TEST_DEVICE_ID,
        deviceSecret: TEST_DEVICE_SECRET,
        title: 'non-existent-todo-xyz'
    });
    assert('delete non-existent TODO returns 404', s3 === 404, { status: s3 });

    // Invalid device
    const { status: s4 } = await api('GET',
        `/api/mission/dashboard?deviceId=non-existent-xxx&deviceSecret=wrong`
    );
    // Dashboard auto-creates on first access, so this might return 200 or 401
    assert('invalid device dashboard does not crash (not 500)', s4 !== 500, { status: s4 });

    // Bot auth: valid botSecret can access dashboard
    const ent0 = boundEntities[0];
    const { status: s5, data: d5 } = await api('GET',
        `/api/mission/dashboard?deviceId=${TEST_DEVICE_ID}&botSecret=${ent0.botSecret}&entityId=0`
    );
    assert('bot can access dashboard', s5 === 200 && d5.success, { status: s5 });
}

// ==============================
// Main
// ==============================

async function main() {
    try {
        await setup();

        // Step 1: Create TODO + notify
        const todoTitle = await testCreateTodoAndNotify();

        // Step 2: Record dashboard version
        const prevVersion = await testGetDashboardVersion();

        // Step 3: Add RULE + delta notify
        const ruleName = await testAddRuleAndNotify(todoTitle);

        // Step 4: Verify version incremented
        await testVersionIncremented(prevVersion);

        // Step 5: Cleanup
        await testCleanup(todoTitle, ruleName);

        // Step 6: Error handling
        await testMissionApiErrors();

        // Step 7: Log / Telemetry API Verification
        console.log('\n--- Log / Telemetry API Verification ---');

        const telRes = await api('GET',
            `/api/device-telemetry?deviceId=${TEST_DEVICE_ID}&deviceSecret=${TEST_DEVICE_SECRET}&type=api_req`
        );
        if (telRes.status === 200 && telRes.data.entries) {
            const actions = telRes.data.entries.map(e => e.action);
            assert('Telemetry captured API calls', telRes.data.entries.length > 0, { count: telRes.data.entries.length });
            assert('Telemetry logged POST /api/device/register', actions.some(a => a.includes('/api/device/register')));
            assert('Telemetry logged POST /api/mission/todo/add', actions.some(a => a.includes('/api/mission/todo/add')));
            assert('Telemetry logged POST /api/mission/notify', actions.some(a => a.includes('/api/mission/notify')));
            assert('Telemetry logged GET /api/mission/dashboard', actions.some(a => a.includes('/api/mission/dashboard')));
            assert('Telemetry logged POST /api/mission/rule/add', actions.some(a => a.includes('/api/mission/rule/add')));
            assert('Telemetry logged GET /api/chat/history', actions.some(a => a.includes('/api/chat/history')));
            const withDuration = telRes.data.entries.filter(e => e.duration != null && e.duration > 0);
            assert('Telemetry entries include response duration', withDuration.length > 0, { withDuration: withDuration.length });
        }

        const logRes = await api('GET',
            `/api/logs?deviceId=${TEST_DEVICE_ID}&deviceSecret=${TEST_DEVICE_SECRET}&limit=50`
        );
        assert('Server log API accessible', logRes.status === 200 && logRes.data.success, { status: logRes.status });

        // Summary
        console.log('\n============================================================');
        console.log('MISSION CONTROL PUBLISH TEST SUMMARY');
        console.log('============================================================');
        console.log(`Results: ${passed} passed, ${failed} failed`);
        console.log('============================================================\n');

        if (failed > 0) {
            console.log('❌ Mission Control tests FAILED');
            process.exit(1);
        } else {
            console.log('✅ All Mission Control tests passed');
            process.exit(0);
        }
    } catch (e) {
        console.error('Test crashed:', e);
        process.exit(1);
    }
}

main();
