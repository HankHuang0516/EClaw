#!/usr/bin/env node
/**
 * Agent Card UI — Regression Test
 *
 * Verifies the Agent Card API from the perspective of all three platform UIs
 * (Web Portal, Android, iOS). Tests the field shapes, validation limits,
 * and CRUD operations that the UI relies on.
 *
 * Complements test-agent-card.js (which tests auth + lookup integration)
 * by focusing on UI-specific field validation and three-platform parity.
 *
 * Credentials: BROADCAST_TEST_DEVICE_ID + BROADCAST_TEST_DEVICE_SECRET
 */

const path = require('path');
const fs = require('fs');

const args = process.argv.slice(2);
const API_BASE = args.includes('--local') ? 'http://localhost:3000' : 'https://eclawbot.com';

// Load .env
function loadEnv() {
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

const env = loadEnv();
const DEVICE_ID = env.BROADCAST_TEST_DEVICE_ID || process.env.BROADCAST_TEST_DEVICE_ID;
const DEVICE_SECRET = env.BROADCAST_TEST_DEVICE_SECRET || process.env.BROADCAST_TEST_DEVICE_SECRET;

let passed = 0;
let failed = 0;

function assert(cond, label) {
    if (cond) { console.log(`  ✅ ${label}`); passed++; }
    else { console.error(`  ❌ ${label}`); failed++; }
}

async function api(method, path, body) {
    const opts = {
        method,
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(10000)
    };
    if (body) opts.body = JSON.stringify(body);
    const url = method === 'GET' && body ? `${API_BASE}${path}?${new URLSearchParams(body)}` : `${API_BASE}${path}`;
    if (method === 'GET') delete opts.body;
    const res = await fetch(url, opts);
    const text = await res.text();
    try { return { status: res.status, ok: res.ok, data: JSON.parse(text) }; }
    catch { return { status: res.status, ok: res.ok, data: text }; }
}

// ─── Test 1: Full agent card with all fields (UI parity) ───
async function testFullCardCreate() {
    console.log('\n[Test 1] Create agent card with all UI fields');

    const card = {
        description: 'Test entity for EClaw platform — supports chat, search, and automation tasks.',
        capabilities: [
            { id: 'chat', name: 'Chat', description: 'Real-time conversation' },
            { id: 'search', name: 'Web Search', description: 'Search the internet' },
            { id: 'translate', name: 'Translate', description: 'Multi-language translation' }
        ],
        protocols: ['A2A', 'REST', 'gRPC'],
        tags: ['IoT', 'claw-machine', 'automation', 'chat'],
        version: '1.0.0',
        website: 'https://eclawbot.com',
        contactEmail: 'test@eclawbot.com'
    };

    const res = await api('PUT', '/api/entity/agent-card', {
        deviceId: DEVICE_ID,
        deviceSecret: DEVICE_SECRET,
        entityId: 0,
        agentCard: card
    });

    assert(res.ok, `PUT returns 200 (got ${res.status})`);
    assert(res.data?.success === true, 'Response success=true');

    // Verify GET returns all fields
    const get = await api('GET', '/api/entity/agent-card', {
        deviceId: DEVICE_ID,
        deviceSecret: DEVICE_SECRET,
        entityId: 0
    });

    assert(get.ok, 'GET returns 200');
    const ac = get.data?.agentCard;
    assert(ac != null, 'agentCard is not null');
    assert(ac?.description === card.description, 'description matches');
    assert(Array.isArray(ac?.capabilities) && ac.capabilities.length === 3, 'capabilities: 3 items');
    assert(ac?.capabilities?.[0]?.name === 'Chat', 'capability[0].name = Chat');
    assert(ac?.capabilities?.[0]?.id === 'chat', 'capability[0].id = chat');
    assert(ac?.capabilities?.[0]?.description === 'Real-time conversation', 'capability[0].description preserved');
    assert(Array.isArray(ac?.protocols) && ac.protocols.length === 3, 'protocols: 3 items');
    assert(ac?.protocols?.includes('A2A'), 'protocols includes A2A');
    assert(Array.isArray(ac?.tags) && ac.tags.length === 4, 'tags: 4 items');
    assert(ac?.tags?.includes('IoT'), 'tags includes IoT');
    assert(ac?.version === '1.0.0', 'version matches');
    assert(ac?.website === 'https://eclawbot.com', 'website matches');
    assert(ac?.contactEmail === 'test@eclawbot.com', 'contactEmail matches');
}

// ─── Test 2: Minimal card (description only — UI minimum) ───
async function testMinimalCard() {
    console.log('\n[Test 2] Minimal card (description only)');

    const res = await api('PUT', '/api/entity/agent-card', {
        deviceId: DEVICE_ID,
        deviceSecret: DEVICE_SECRET,
        entityId: 0,
        agentCard: { description: 'Minimal test card' }
    });

    assert(res.ok, 'PUT with only description succeeds');

    const get = await api('GET', '/api/entity/agent-card', {
        deviceId: DEVICE_ID,
        deviceSecret: DEVICE_SECRET,
        entityId: 0
    });

    const ac = get.data?.agentCard;
    assert(ac?.description === 'Minimal test card', 'description saved');
    assert(!ac?.capabilities || ac.capabilities.length === 0, 'capabilities empty/absent');
    assert(!ac?.protocols || ac.protocols.length === 0, 'protocols empty/absent');
    assert(!ac?.tags || ac.tags.length === 0, 'tags empty/absent');
}

// ─── Test 3: Field length validation ───
async function testFieldLimits() {
    console.log('\n[Test 3] Field length validation');

    // Description > 500 chars should be rejected
    const longDesc = 'A'.repeat(501);
    const res = await api('PUT', '/api/entity/agent-card', {
        deviceId: DEVICE_ID,
        deviceSecret: DEVICE_SECRET,
        entityId: 0,
        agentCard: { description: longDesc }
    });
    assert(!res.ok || res.data?.success === false, 'Description > 500 chars rejected');

    // Too many capabilities (> 10)
    const manyCaps = Array.from({ length: 11 }, (_, i) => ({
        id: `cap${i}`, name: `Cap ${i}`, description: ''
    }));
    const res2 = await api('PUT', '/api/entity/agent-card', {
        deviceId: DEVICE_ID,
        deviceSecret: DEVICE_SECRET,
        entityId: 0,
        agentCard: { description: 'Test', capabilities: manyCaps }
    });
    assert(!res2.ok || res2.data?.success === false, '> 10 capabilities rejected');

    // Too many tags (> 20)
    const manyTags = Array.from({ length: 21 }, (_, i) => `tag${i}`);
    const res3 = await api('PUT', '/api/entity/agent-card', {
        deviceId: DEVICE_ID,
        deviceSecret: DEVICE_SECRET,
        entityId: 0,
        agentCard: { description: 'Test', tags: manyTags }
    });
    assert(!res3.ok || res3.data?.success === false, '> 20 tags rejected');
}

// ─── Test 4: Update existing card (UI save button behavior) ───
async function testUpdateCard() {
    console.log('\n[Test 4] Update existing card');

    // Create initial card
    await api('PUT', '/api/entity/agent-card', {
        deviceId: DEVICE_ID,
        deviceSecret: DEVICE_SECRET,
        entityId: 0,
        agentCard: { description: 'Initial card', version: '1.0.0' }
    });

    // Update with new fields
    const res = await api('PUT', '/api/entity/agent-card', {
        deviceId: DEVICE_ID,
        deviceSecret: DEVICE_SECRET,
        entityId: 0,
        agentCard: {
            description: 'Updated card',
            version: '2.0.0',
            tags: ['new-tag']
        }
    });

    assert(res.ok, 'PUT update returns 200');

    const get = await api('GET', '/api/entity/agent-card', {
        deviceId: DEVICE_ID,
        deviceSecret: DEVICE_SECRET,
        entityId: 0
    });

    const ac = get.data?.agentCard;
    assert(ac?.description === 'Updated card', 'description updated');
    assert(ac?.version === '2.0.0', 'version updated');
    assert(ac?.tags?.[0] === 'new-tag', 'tags updated');
}

// ─── Test 5: Delete card (UI delete button behavior) ───
async function testDeleteCard() {
    console.log('\n[Test 5] Delete card');

    // Ensure a card exists
    await api('PUT', '/api/entity/agent-card', {
        deviceId: DEVICE_ID,
        deviceSecret: DEVICE_SECRET,
        entityId: 0,
        agentCard: { description: 'To be deleted' }
    });

    const del = await api('DELETE', '/api/entity/agent-card', {
        deviceId: DEVICE_ID,
        deviceSecret: DEVICE_SECRET,
        entityId: 0
    });

    assert(del.ok, 'DELETE returns 200');
    assert(del.data?.success === true, 'DELETE success=true');

    // Verify card is gone
    const get = await api('GET', '/api/entity/agent-card', {
        deviceId: DEVICE_ID,
        deviceSecret: DEVICE_SECRET,
        entityId: 0
    });

    assert(get.ok, 'GET after delete returns 200');
    assert(get.data?.agentCard == null, 'agentCard is null after delete');
}

// ─── Test 6: Missing description rejected (UI validation) ───
async function testMissingDescription() {
    console.log('\n[Test 6] Missing description rejected');

    const res = await api('PUT', '/api/entity/agent-card', {
        deviceId: DEVICE_ID,
        deviceSecret: DEVICE_SECRET,
        entityId: 0,
        agentCard: { version: '1.0.0', tags: ['test'] }
    });

    assert(!res.ok || res.data?.success === false, 'Card without description rejected');
}

// ─── Run ───
async function main() {
    console.log('═══════════════════════════════════════════');
    console.log('  Agent Card UI Regression Tests');
    console.log('═══════════════════════════════════════════');

    if (!DEVICE_ID || !DEVICE_SECRET) {
        console.log('\n  ⚠️  Skipped: BROADCAST_TEST_DEVICE_ID/SECRET not set');
        console.log('  Set in backend/.env to run these tests');
        process.exit(0);
    }

    // Check connectivity
    try {
        await api('GET', '/api/health', null);
    } catch {
        console.log('\n  ⚠️  Skipped: Cannot reach server at ' + API_BASE);
        process.exit(0);
    }

    await testFullCardCreate();
    await testMinimalCard();
    await testFieldLimits();
    await testUpdateCard();
    await testDeleteCard();
    await testMissingDescription();

    // Cleanup: delete any test card left
    try {
        await api('DELETE', '/api/entity/agent-card', {
            deviceId: DEVICE_ID, deviceSecret: DEVICE_SECRET, entityId: 0
        });
    } catch {}

    console.log(`\n${'═'.repeat(43)}`);
    console.log(`  Results: ${passed} passed, ${failed} failed`);
    console.log('═'.repeat(43));

    process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
    console.error('Test runner error:', err);
    process.exit(1);
});
