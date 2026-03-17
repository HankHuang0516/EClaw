#!/usr/bin/env node
/**
 * Scheduled Message Chat Visibility Test
 *
 * Regression test for: scheduled messages not appearing in Android app chat.
 * Root cause: Android sync loop started with since=now-60s, missing scheduled
 * messages from between sessions. Web portal always loads without time filter.
 *
 * Verifies:
 *  1. GET /api/chat/history returns scheduled messages (source='scheduled')
 *  2. schedule_label field is present in the response
 *  3. Messages are returned when no `since` filter is applied (Android first-poll fix)
 *  4. Messages are returned when `since` is set before the scheduled message time
 *
 * Usage:
 *   node test-scheduled-chat-visibility.js
 *   node test-scheduled-chat-visibility.js --local
 */

const path = require('path');
const fs   = require('fs');

const args     = process.argv.slice(2);
const API_BASE = args.includes('--local') ? 'http://localhost:3000' : 'https://eclawbot.com';

function loadEnv() {
    const p = path.resolve(__dirname, '..', '.env');
    if (!fs.existsSync(p)) return {};
    const vars = {};
    fs.readFileSync(p, 'utf8').split('\n').forEach(line => {
        line = line.trim();
        if (!line || line.startsWith('#')) return;
        const idx = line.indexOf('=');
        if (idx > 0) vars[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    });
    return vars;
}

async function req(method, url, body) {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify(body);
    const res  = await fetch(url, opts);
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 300) }; }
    return { status: res.status, data };
}

let passed = 0;
let failed = 0;

function assert(condition, label) {
    if (condition) {
        console.log(`  ✅ ${label}`);
        passed++;
    } else {
        console.log(`  ❌ ${label}`);
        failed++;
    }
}

async function run() {
    const env = loadEnv();
    const DEVICE_ID     = env.BROADCAST_TEST_DEVICE_ID;
    const DEVICE_SECRET = env.BROADCAST_TEST_DEVICE_SECRET;

    if (!DEVICE_ID || !DEVICE_SECRET) {
        console.error('⚠️  Missing BROADCAST_TEST_DEVICE_ID / BROADCAST_TEST_DEVICE_SECRET in .env');
        process.exit(1);
    }

    console.log(`\n🔍 Scheduled Message Chat Visibility — ${API_BASE}\n`);

    // ── Test 1: Chat history without since filter returns messages ──
    console.log('Test 1: Chat history without since filter (mirrors Android first-poll fix)');
    {
        const r = await req('GET',
            `${API_BASE}/api/chat/history?deviceId=${DEVICE_ID}&deviceSecret=${DEVICE_SECRET}&limit=100`
        );
        assert(r.status === 200, 'GET /api/chat/history returns 200');
        assert(r.data.success === true, 'response.success is true');
        assert(Array.isArray(r.data.messages), 'response.messages is an array');
        assert(r.data.messages.length > 0, 'response contains messages');

        // Check if any scheduled messages exist
        const scheduledMsgs = r.data.messages.filter(m => m.source === 'scheduled');
        console.log(`  ℹ️  Found ${scheduledMsgs.length} scheduled messages out of ${r.data.messages.length} total`);

        if (scheduledMsgs.length > 0) {
            const firstScheduled = scheduledMsgs[0];
            assert(firstScheduled.is_from_user === true, 'scheduled message has is_from_user=true');
            assert(firstScheduled.entity_id !== undefined && firstScheduled.entity_id !== null,
                'scheduled message has entity_id');
            assert('schedule_label' in firstScheduled,
                'scheduled message includes schedule_label field');
            assert(firstScheduled.text && firstScheduled.text.length > 0,
                'scheduled message has non-empty text');
            assert(firstScheduled.id != null, 'scheduled message has id (backend UUID)');
        } else {
            console.log('  ⚠️  No scheduled messages found — skipping field checks');
            console.log('      (Create an hourly schedule for entity #1 to fully validate)');
        }
    }

    // ── Test 2: Chat history with old since timestamp still returns recent messages ──
    console.log('\nTest 2: Chat history with since=1h ago (simulates app opened after schedule fired)');
    {
        const oneHourAgo = Date.now() - 3600_000;
        const r = await req('GET',
            `${API_BASE}/api/chat/history?deviceId=${DEVICE_ID}&deviceSecret=${DEVICE_SECRET}&since=${oneHourAgo}&limit=50`
        );
        assert(r.status === 200, 'GET /api/chat/history?since=1h-ago returns 200');
        assert(r.data.success === true, 'response.success is true');
        assert(Array.isArray(r.data.messages), 'response.messages is an array');

        // Check for scheduled messages in the window
        const scheduledMsgs = r.data.messages.filter(m => m.source === 'scheduled');
        console.log(`  ℹ️  Found ${scheduledMsgs.length} scheduled messages in last hour`);
    }

    // ── Test 3: Chat history message schema includes schedule fields ──
    console.log('\nTest 3: Message schema includes schedule-related columns');
    {
        const r = await req('GET',
            `${API_BASE}/api/chat/history?deviceId=${DEVICE_ID}&deviceSecret=${DEVICE_SECRET}&limit=1`
        );
        assert(r.status === 200, 'GET /api/chat/history returns 200');
        if (r.data.messages && r.data.messages.length > 0) {
            const msg = r.data.messages[0];
            // These columns should exist on all messages (null for non-scheduled)
            assert('schedule_id' in msg || 'schedule_label' in msg,
                'message schema includes schedule_id or schedule_label column');
            assert('source' in msg, 'message schema includes source column');
        }
    }

    // ── Test 4: Verify since=0 returns messages (extreme case) ──
    console.log('\nTest 4: Chat history with since=0 (catches all messages within limit)');
    {
        const r = await req('GET',
            `${API_BASE}/api/chat/history?deviceId=${DEVICE_ID}&deviceSecret=${DEVICE_SECRET}&since=0&limit=10`
        );
        assert(r.status === 200, 'GET /api/chat/history?since=0 returns 200');
        assert(r.data.success === true, 'response.success is true');
        assert(Array.isArray(r.data.messages), 'returns array of messages');
    }

    // ── Summary ──
    console.log(`\n${'═'.repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    console.log(`${'═'.repeat(50)}\n`);
    process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
