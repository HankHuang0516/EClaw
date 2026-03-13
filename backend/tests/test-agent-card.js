#!/usr/bin/env node
/**
 * Agent Card CRUD — Regression Test (#174)
 *
 * Tests the Agent Card lifecycle:
 *   1. Find a bound entity on the test device
 *   2. PUT /api/entity/agent-card with valid card → 200
 *   3. GET /api/entity/agent-card → returns the card
 *   4. GET /api/entity/lookup?code=<publicCode> → includes agentCard
 *   5. DELETE /api/entity/agent-card → 200
 *   6. GET /api/entity/agent-card → null after delete
 *   7. PUT with bad credentials → 403
 *   8. PUT with invalid entityId → 404
 *
 * Credentials from backend/.env:
 *   BROADCAST_TEST_DEVICE_ID, BROADCAST_TEST_DEVICE_SECRET
 *
 * Usage:
 *   node test-agent-card.js
 *   node test-agent-card.js --local
 *   node test-agent-card.js --skip-cleanup
 */

const path = require('path');
const fs = require('fs');

const args = process.argv.slice(2);
const API_BASE = args.includes('--local') ? 'http://localhost:3000' : 'https://eclawbot.com';
const skipCleanup = args.includes('--skip-cleanup');

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

// ── HTTP Helpers ────────────────────────────────────────────
async function fetchRaw(url) {
    const res = await fetch(url);
    const data = await res.json();
    return { status: res.status, data };
}

async function putJSON(url, body) {
    const res = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const data = await res.json();
    return { status: res.status, data };
}

async function deleteJSON(url, body) {
    const res = await fetch(url, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const data = await res.json();
    return { status: res.status, data };
}

// ── Test Result Tracking ────────────────────────────────────
const results = [];
function check(name, passed, detail = '') {
    results.push({ name, passed, detail });
    const icon = passed ? '✅' : '❌';
    const suffix = detail ? ` — ${detail}` : '';
    console.log(`  ${icon} ${name}${suffix}`);
}

// ── Main ────────────────────────────────────────────────────
async function main() {
    const env = loadEnvFile();

    const deviceId = env.BROADCAST_TEST_DEVICE_ID || process.env.BROADCAST_TEST_DEVICE_ID || '';
    const deviceSecret = env.BROADCAST_TEST_DEVICE_SECRET || process.env.BROADCAST_TEST_DEVICE_SECRET || '';

    if (!deviceId || !deviceSecret) {
        console.error('Error: BROADCAST_TEST_DEVICE_ID and BROADCAST_TEST_DEVICE_SECRET required in backend/.env');
        process.exit(1);
    }

    console.log('='.repeat(65));
    console.log('  Agent Card CRUD — Regression Test (#174)');
    console.log('='.repeat(65));
    console.log(`  API:    ${API_BASE}`);
    console.log(`  Device: ${deviceId}`);
    console.log('');

    // ── Phase 1: Find a bound entity ────────────────────────
    console.log('Phase 1: Find a bound entity');
    let entityId = null;
    let publicCode = null;
    let botSecret = null;
    try {
        const url = `${API_BASE}/api/entities?deviceId=${deviceId}&deviceSecret=${deviceSecret}`;
        const { status, data } = await fetchRaw(url);
        check('GET /api/entities returns 200', status === 200, `status=${status}`);

        if (data && data.entities) {
            const bound = data.entities.find(e => e.bound);
            if (bound) {
                entityId = bound.entityId;
                publicCode = bound.publicCode;
                botSecret = bound.botSecret;
                check('Found a bound entity', true, `entityId=${entityId}, publicCode=${publicCode}`);
            } else {
                check('Found a bound entity', false, 'no bound entities on device');
            }
        } else if (Array.isArray(data)) {
            const bound = data.find(e => e.bound);
            if (bound) {
                entityId = bound.entityId !== undefined ? bound.entityId : bound.id;
                publicCode = bound.publicCode;
                botSecret = bound.botSecret;
                check('Found a bound entity', true, `entityId=${entityId}, publicCode=${publicCode}`);
            } else {
                check('Found a bound entity', false, 'no bound entities on device');
            }
        } else {
            check('Entities response format', false, `unexpected shape: ${JSON.stringify(data).slice(0, 100)}`);
        }
    } catch (err) {
        check('GET /api/entities', false, err.message);
    }

    if (entityId === null) {
        console.error('Cannot proceed without a bound entity. Aborting.');
        process.exit(1);
    }

    const testCard = {
        name: 'Test Agent Card',
        description: 'Automated regression test agent card',
        capabilities: ['text', 'broadcast'],
        version: '1.0.0-test',
    };

    // ── Phase 2: PUT agent card ─────────────────────────────
    console.log('');
    console.log('Phase 2: PUT /api/entity/agent-card');
    try {
        const { status, data } = await putJSON(`${API_BASE}/api/entity/agent-card`, {
            deviceId,
            deviceSecret,
            entityId,
            agentCard: testCard,
        });
        check('PUT agent card returns 200', status === 200, `status=${status}`);
        check('PUT response indicates success', data && data.success === true,
            `success=${data?.success}`);
    } catch (err) {
        check('PUT agent card', false, err.message);
    }

    // ── Phase 3: GET agent card ─────────────────────────────
    console.log('');
    console.log('Phase 3: GET /api/entity/agent-card');
    try {
        const url = `${API_BASE}/api/entity/agent-card?deviceId=${deviceId}&deviceSecret=${deviceSecret}&entityId=${entityId}`;
        const { status, data } = await fetchRaw(url);
        check('GET agent card returns 200', status === 200, `status=${status}`);

        const card = data?.agentCard || data?.card || data;
        const nameMatch = card?.name === testCard.name;
        check('Agent card name matches', nameMatch,
            `expected="${testCard.name}", got="${card?.name}"`);

        const descMatch = card?.description === testCard.description;
        check('Agent card description matches', descMatch,
            `expected="${testCard.description}", got="${card?.description}"`);
    } catch (err) {
        check('GET agent card', false, err.message);
    }

    // ── Phase 4: Lookup includes agentCard ──────────────────
    console.log('');
    console.log('Phase 4: Lookup includes agentCard');
    if (publicCode) {
        try {
            const url = `${API_BASE}/api/entity/lookup?code=${publicCode}`;
            const { status, data } = await fetchRaw(url);
            check('Lookup by publicCode returns 200', status === 200, `status=${status}`);

            const hasAgentCard = data && ('agentCard' in data || 'agent_card' in data);
            check('Lookup response includes agentCard field', hasAgentCard,
                `keys: ${data ? Object.keys(data).join(', ') : 'null'}`);
        } catch (err) {
            check('Lookup includes agentCard', false, err.message);
        }
    } else {
        check('Lookup includes agentCard', false, 'no publicCode available — skipped');
    }

    // ── Phase 5: DELETE agent card ──────────────────────────
    console.log('');
    console.log('Phase 5: DELETE /api/entity/agent-card');
    if (!skipCleanup) {
        try {
            const { status, data } = await deleteJSON(`${API_BASE}/api/entity/agent-card`, {
                deviceId,
                deviceSecret,
                entityId,
            });
            check('DELETE agent card returns 200', status === 200, `status=${status}`);
        } catch (err) {
            check('DELETE agent card', false, err.message);
        }

        // ── Phase 6: Verify deletion ────────────────────────
        console.log('');
        console.log('Phase 6: Verify agent card deleted');
        try {
            const url = `${API_BASE}/api/entity/agent-card?deviceId=${deviceId}&deviceSecret=${deviceSecret}&entityId=${entityId}`;
            const { status, data } = await fetchRaw(url);
            check('GET after delete returns 200', status === 200, `status=${status}`);

            const card = data?.agentCard || data?.card;
            const isNull = card === null || card === undefined;
            check('Agent card is null after delete', isNull,
                `agentCard=${JSON.stringify(card)}`);
        } catch (err) {
            check('Verify deletion', false, err.message);
        }
    } else {
        console.log('  (skipped — --skip-cleanup flag)');
    }

    // ── Phase 7: Auth validation ────────────────────────────
    console.log('');
    console.log('Phase 7: Auth validation');
    try {
        const { status } = await putJSON(`${API_BASE}/api/entity/agent-card`, {
            deviceId,
            deviceSecret: 'bad-secret-12345',
            entityId,
            agentCard: testCard,
        });
        check('PUT with bad credentials returns 403', status === 403,
            `status=${status}`);
    } catch (err) {
        check('PUT with bad credentials', false, err.message);
    }

    try {
        const { status } = await putJSON(`${API_BASE}/api/entity/agent-card`, {
            deviceId,
            deviceSecret,
            entityId: 99,
            agentCard: testCard,
        });
        check('PUT with invalid entityId returns 404', status === 404,
            `status=${status}`);
    } catch (err) {
        check('PUT with invalid entityId', false, err.message);
    }

    // ── Summary ─────────────────────────────────────────────
    console.log('');
    console.log('='.repeat(65));
    const passed = results.filter(r => r.passed).length;
    const failed = results.filter(r => !r.passed).length;
    console.log(`  Results: ${passed} passed, ${failed} failed (${results.length} total)`);
    console.log('='.repeat(65));

    process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
