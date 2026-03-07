/**
 * AI Chat Image Upload — End-to-End Verification
 *
 * Mimics exactly what AiChatActivity.kt does:
 *   1. POST /api/ai-support/chat/submit  (with base64 image + deviceId/deviceSecret)
 *   2. GET  /api/ai-support/chat/poll/:requestId  (poll until done)
 *   3. Print AI response — confirms whether image was analyzed or stripped
 *
 * Usage:
 *   node backend/tests/test-ai-chat-image.js
 */

'use strict';

const path = require('path');
const fs   = require('fs');
const { randomUUID } = require('crypto');

const API_BASE       = 'https://eclawbot.com';
const POLL_INTERVAL  = 3000;
const POLL_TIMEOUT   = 60000;

// ── Load .env ────────────────────────────────────────────────────────────────

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
// Resolve ID+SECRET as a matched pair to avoid credential mismatch
let DEVICE_ID, DEVICE_SECRET;
if (env.TEST_DEVICE_ID && env.TEST_DEVICE_SECRET) {
    DEVICE_ID     = env.TEST_DEVICE_ID;
    DEVICE_SECRET = env.TEST_DEVICE_SECRET;
} else if (env.BROADCAST_TEST_DEVICE_ID && env.BROADCAST_TEST_DEVICE_SECRET) {
    DEVICE_ID     = env.BROADCAST_TEST_DEVICE_ID;
    DEVICE_SECRET = env.BROADCAST_TEST_DEVICE_SECRET;
} else {
    console.error('ERROR: Set TEST_DEVICE_ID+TEST_DEVICE_SECRET or BROADCAST_TEST_DEVICE_ID+BROADCAST_TEST_DEVICE_SECRET in backend/.env');
    process.exit(1);
}

// ── Build a minimal 1x1 red JPEG in base64 (no external deps) ───────────────
// This is a real valid JPEG (smallest possible: 1x1 red pixel).
// Same format as what AiChatActivity produces (JPEG base64, NO_WRAP).
const TINY_RED_JPEG_B64 =
    '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8U' +
    'HRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgN' +
    'DRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIy' +
    'MjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFgABAQEAAAAAAAAAAAAAAAAABgUE/8QAIhAA' +
    'AgIBBAMAAAAAAAAAAAAAAQIDBAUREiExUf/EABQBAQAAAAAAAAAAAAAAAAAAAAD/xAAUEQEA' +
    'AAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCv1nNpWlac9yyqxlRBuSRjxgeT7D3RRX' +
    'QFFFFAf//Z';

// ── Poll helper ──────────────────────────────────────────────────────────────

async function poll(requestId) {
    const url = `${API_BASE}/api/ai-support/chat/poll/${requestId}?deviceId=${DEVICE_ID}&deviceSecret=${encodeURIComponent(DEVICE_SECRET)}`;
    const deadline = Date.now() + POLL_TIMEOUT;
    let attempt = 0;

    while (Date.now() < deadline) {
        attempt++;
        const res  = await fetch(url);
        const data = await res.json();

        if (!data.success) throw new Error(`Poll error: ${JSON.stringify(data)}`);

        const { status, response, progress } = data;
        const prog = progress && typeof progress === 'string' ? ` [${progress}]` : '';
        process.stdout.write(`\r  polling (${attempt})${prog} — status: ${status}   `);

        if (status === 'completed') {
            process.stdout.write('\n');
            return response;
        }
        if (status === 'failed' || status === 'expired') {
            process.stdout.write('\n');
            throw new Error(`AI returned ${status}: ${data.error}`);
        }

        await new Promise(r => setTimeout(r, POLL_INTERVAL));
    }
    throw new Error(`Timed out after ${POLL_TIMEOUT / 1000}s`);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
    console.log('AI Chat Image Upload — End-to-End Test');
    console.log(`Device: ${DEVICE_ID}`);
    console.log(`API:    ${API_BASE}\n`);

    const requestId = randomUUID();
    const message   = 'Please describe what you see in this image. Reply with "I can see a red pixel" if you can analyze it, or describe what you received.';

    const body = {
        requestId,
        deviceId:     DEVICE_ID,
        deviceSecret: DEVICE_SECRET,
        message,
        history:      [],
        page:         'android_app',
        images: [
            { data: TINY_RED_JPEG_B64, mimeType: 'image/jpeg' }
        ]
    };

    // ── Step 1: Submit ───────────────────────────────────────────────────────
    console.log('Step 1: POST /api/ai-support/chat/submit (with 1 image)');
    const submitRes = await fetch(`${API_BASE}/api/ai-support/chat/submit`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body)
    });
    const submitData = await submitRes.json();

    if (!submitData.success) {
        console.error('Submit failed:', JSON.stringify(submitData, null, 2));
        process.exit(1);
    }
    console.log(`  requestId: ${submitData.requestId || requestId}`);

    // ── Step 2: Poll ─────────────────────────────────────────────────────────
    console.log('Step 2: polling for response...');
    const response = await poll(submitData.requestId || requestId);

    // ── Step 3: Analyse result ───────────────────────────────────────────────
    console.log('\n── AI Response ─────────────────────────────────────────────');
    console.log(response);
    console.log('────────────────────────────────────────────────────────────\n');

    // Detect CLI proxy path: either exact stripping note OR Claude's natural rephrasing of it
    const STRIP_NOTE_EXACT  = 'image analysis is only supported via the direct Anthropic API';
    const STRIP_NOTE_REPHRASE = /image analysis (is not|isn't) supported|can't analyze|unable to (analyze|view)|not able to (analyze|view)/i;
    const VISION_INDICATORS   = /I can see|I see a|the image (shows|contains|depicts)|red pixel|looking at|in the image/i;

    if (response.includes(STRIP_NOTE_EXACT)) {
        console.log('RESULT: CLI Proxy path — stripping note passed verbatim to Claude.');
        console.log('  Image was correctly stripped; Claude echoed the note as-is.');
        console.log('  To enable vision, set ANTHROPIC_API_KEY on Railway.');
    } else if (STRIP_NOTE_REPHRASE.test(response)) {
        console.log('RESULT: CLI Proxy path — image was STRIPPED (fix #150 working correctly).');
        console.log('  Claude rephrased the stripping note in a friendly way.');
        console.log('  The AI did NOT receive or analyze the image binary data.');
        console.log('  To enable vision, set ANTHROPIC_API_KEY on Railway.');
    } else if (VISION_INDICATORS.test(response)) {
        console.log('RESULT: Direct Anthropic API path — image ANALYZED by Claude vision.');
        console.log('  Claude described the image content — vision is working end-to-end.');
    } else {
        console.log('RESULT: Ambiguous — review the AI response above to determine path.');
    }
}

main().catch(err => {
    console.error('\nFATAL:', err.message);
    process.exit(1);
});
