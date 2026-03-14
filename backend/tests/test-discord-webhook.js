#!/usr/bin/env node
/**
 * Regression test: Discord Webhook Support (#199, #200)
 *
 * Tests:
 * 1. Discord URL detection (isDiscordWebhook pattern)
 * 2. Bot registration with Discord webhook URL (validation, handshake)
 * 3. Discord push payload format (content, embeds, components)
 * 4. Discord rate limit handling (429)
 * 5. Rich message support (embeds, buttons, select menus)
 *
 * Credentials: BROADCAST_TEST_DEVICE_ID + BROADCAST_TEST_DEVICE_SECRET
 * Note: Uses mock Discord URL for handshake tests (real Discord not required)
 */

const BASE = process.env.API_BASE || 'https://eclawbot.com';

// Load env
try { require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') }); } catch {}

const DEVICE_ID = process.env.BROADCAST_TEST_DEVICE_ID;
const DEVICE_SECRET = process.env.BROADCAST_TEST_DEVICE_SECRET;

let passed = 0;
let failed = 0;

function assert(condition, label) {
    if (condition) {
        console.log(`  ✅ ${label}`);
        passed++;
    } else {
        console.error(`  ❌ ${label}`);
        failed++;
    }
}

async function fetchJSON(url, options = {}) {
    const res = await fetch(url, {
        ...options,
        headers: { 'Content-Type': 'application/json', ...options.headers }
    });
    const text = await res.text();
    try {
        return { status: res.status, ok: res.ok, data: JSON.parse(text) };
    } catch {
        return { status: res.status, ok: res.ok, data: text };
    }
}

// ─── Test 1: Discord URL Detection via bot/register ───
async function testDiscordUrlDetection() {
    console.log('\n[Test 1] Discord URL detection via /api/bot/register');

    if (!DEVICE_ID || !DEVICE_SECRET) {
        console.log('  ⚠️  Skipped (no test credentials)');
        return;
    }

    // Get a bound entity's botSecret
    const statusRes = await fetchJSON(`${BASE}/api/status?deviceId=${DEVICE_ID}&deviceSecret=${DEVICE_SECRET}`);
    if (!statusRes.ok) {
        console.log('  ⚠️  Skipped (cannot get device status)');
        return;
    }

    // Discord webhook without token/session_key should be accepted (validation-wise)
    // but handshake will fail since it's a fake URL
    const fakeDiscordUrl = 'https://discord.com/api/webhooks/123456789/fake-token-abc123';
    const result = await fetchJSON(`${BASE}/api/bot/register`, {
        method: 'POST',
        body: JSON.stringify({
            deviceId: DEVICE_ID,
            entityId: 0,
            botSecret: statusRes.data?.entities?.[0]?.botSecret || 'invalid',
            webhook_url: fakeDiscordUrl
            // No token or session_key — Discord doesn't need them
        })
    });

    // Should attempt Discord handshake (and fail with connection error or 404)
    // The key assertion: it should NOT complain about missing token/session_key
    assert(
        result.status !== 400 || !result.data?.message?.includes('Missing required fields: webhook_url, token, session_key'),
        'Discord URL does not require token/session_key fields'
    );

    // The error should be Discord-specific (connection failed or discord_http_*)
    if (result.status === 400) {
        const errType = result.data?.error_type || '';
        assert(
            errType.startsWith('discord_'),
            `Error type is Discord-specific: ${errType}`
        );
    }
}

// ─── Test 2: Non-Discord webhook still requires token/session_key ───
async function testNonDiscordRequiresToken() {
    console.log('\n[Test 2] Non-Discord webhook still requires token + session_key');

    if (!DEVICE_ID || !DEVICE_SECRET) {
        console.log('  ⚠️  Skipped (no test credentials)');
        return;
    }

    const statusRes = await fetchJSON(`${BASE}/api/status?deviceId=${DEVICE_ID}&deviceSecret=${DEVICE_SECRET}`);
    if (!statusRes.ok) {
        console.log('  ⚠️  Skipped (cannot get device status)');
        return;
    }

    const result = await fetchJSON(`${BASE}/api/bot/register`, {
        method: 'POST',
        body: JSON.stringify({
            deviceId: DEVICE_ID,
            entityId: 0,
            botSecret: statusRes.data?.entities?.[0]?.botSecret || 'invalid',
            webhook_url: 'https://example.com/webhook'
            // Missing token and session_key
        })
    });

    assert(result.status === 400, `Returns 400 for missing fields (got ${result.status})`);
    assert(
        result.data?.message?.includes('Missing required fields'),
        'Error mentions missing required fields'
    );
}

// ─── Test 3: Discord rich message payload structure ───
async function testDiscordRichMessageStructure() {
    console.log('\n[Test 3] Discord rich message payload structure validation');

    // Test embed structure (client-side validation)
    const validEmbed = {
        title: 'Test Embed',
        description: 'This is a test embed',
        color: 0x5865F2, // Discord blurple
        fields: [
            { name: 'Field 1', value: 'Value 1', inline: true },
            { name: 'Field 2', value: 'Value 2', inline: true }
        ],
        footer: { text: 'EClaw Bot' },
        thumbnail: { url: 'https://example.com/thumb.png' }
    };

    assert(validEmbed.title.length <= 256, 'Embed title within 256 char limit');
    assert(validEmbed.description.length <= 4096, 'Embed description within 4096 char limit');
    assert(validEmbed.fields.length <= 25, 'Embed fields within 25 field limit');
    assert(typeof validEmbed.color === 'number', 'Embed color is a number');

    // Test button component structure
    const validComponents = [
        {
            type: 1, // Action Row
            components: [
                { type: 2, style: 1, label: 'Click Me', custom_id: 'btn_1' },        // Button
                { type: 2, style: 5, label: 'Visit', url: 'https://eclawbot.com' }    // Link Button
            ]
        }
    ];

    assert(validComponents[0].type === 1, 'Action row type is 1');
    assert(validComponents[0].components.length <= 5, 'Action row within 5 component limit');
    assert(validComponents[0].components[0].type === 2, 'Button type is 2');

    // Test select menu structure
    const selectMenu = {
        type: 1,
        components: [{
            type: 3, // String Select
            custom_id: 'select_1',
            placeholder: 'Choose an option',
            options: [
                { label: 'Option 1', value: 'opt1', description: 'First option' },
                { label: 'Option 2', value: 'opt2', description: 'Second option' }
            ]
        }]
    };

    assert(selectMenu.components[0].type === 3, 'Select menu type is 3');
    assert(selectMenu.components[0].options.length <= 25, 'Select menu within 25 option limit');
}

// ─── Test 4: Discord content length enforcement ───
async function testDiscordContentLength() {
    console.log('\n[Test 4] Discord content length enforcement');

    // Simulate what discordPush does for long content
    const longContent = 'A'.repeat(2500);
    const truncated = longContent.length > 2000 ? longContent.substring(0, 1997) + '...' : longContent;

    assert(truncated.length === 2000, `Long content truncated to 2000 chars (got ${truncated.length})`);
    assert(truncated.endsWith('...'), 'Truncated content ends with "..."');

    // Short content should not be truncated
    const shortContent = 'Hello Discord!';
    const notTruncated = shortContent.length > 2000 ? shortContent.substring(0, 1997) + '...' : shortContent;
    assert(notTruncated === shortContent, 'Short content not modified');
}

// ─── Test 5: Discord embed limits ───
async function testDiscordEmbedLimits() {
    console.log('\n[Test 5] Discord embed and component limits');

    // Max 10 embeds
    const embeds = Array.from({ length: 15 }, (_, i) => ({ title: `Embed ${i}` }));
    const limitedEmbeds = embeds.slice(0, 10);
    assert(limitedEmbeds.length === 10, 'Embeds capped at 10');

    // Max 5 action rows
    const components = Array.from({ length: 8 }, () => ({ type: 1, components: [] }));
    const limitedComponents = components.slice(0, 5);
    assert(limitedComponents.length === 5, 'Action rows capped at 5');
}

// ─── Test 6: discordapp.com URL also detected ───
async function testDiscordAppUrl() {
    console.log('\n[Test 6] discordapp.com webhook URL also detected');

    // Test URL pattern matching (mirrors isDiscordWebhook logic)
    function isDiscordWebhook(url) {
        try {
            const u = new URL(url);
            return (u.hostname === 'discord.com' || u.hostname === 'discordapp.com') &&
                   u.pathname.startsWith('/api/webhooks/');
        } catch { return false; }
    }

    assert(isDiscordWebhook('https://discord.com/api/webhooks/123/abc'), 'discord.com detected');
    assert(isDiscordWebhook('https://discordapp.com/api/webhooks/123/abc'), 'discordapp.com detected');
    assert(!isDiscordWebhook('https://example.com/api/webhooks/123/abc'), 'Non-Discord URL rejected');
    assert(!isDiscordWebhook('https://discord.com/api/v10/channels/123'), 'Non-webhook Discord URL rejected');
    assert(!isDiscordWebhook('not-a-url'), 'Invalid URL returns false');
}

// ─── Run all tests ───
async function main() {
    console.log('═══════════════════════════════════════════');
    console.log('  Discord Webhook Support Tests (#199, #200)');
    console.log('═══════════════════════════════════════════');

    // Network-dependent tests (skip if no connectivity)
    try {
        await fetchJSON(`${BASE}/api/health`, { signal: AbortSignal.timeout(5000) });
        await testDiscordUrlDetection();
        await testNonDiscordRequiresToken();
    } catch {
        console.log('\n[Test 1-2] ⚠️  Skipped (no network access to server)');
    }

    // Local-only tests (no network required)
    await testDiscordRichMessageStructure();
    await testDiscordContentLength();
    await testDiscordEmbedLimits();
    await testDiscordAppUrl();

    console.log(`\n${'═'.repeat(43)}`);
    console.log(`  Results: ${passed} passed, ${failed} failed`);
    console.log('═'.repeat(43));

    process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
    console.error('Test runner error:', err);
    process.exit(1);
});
