#!/usr/bin/env node
/**
 * AI Chat WebView Guard — Regression Test
 *
 * Verifies that portal pages served to Android WebView do NOT include
 * the AI chat widget, preventing duplicate AI service (#419).
 *
 * Tests:
 *   1. Portal HTML pages include inline __blockAiChatWidget guard
 *   2. ai-chat.js respects __blockAiChatWidget flag (early return)
 *   3. ai-chat.js has isAndroidWebView() detection
 *   4. Cache-Control: no-store on HTML and JS to prevent stale WebView cache
 *   5. ai-chat.js served to Android UA still contains detection code
 *
 * Credentials: None required (static content checks)
 *
 * Usage:
 *   node backend/tests/test-ai-chat-webview-guard.js
 *   node backend/tests/test-ai-chat-webview-guard.js --local
 */

const path = require('path');
const fs = require('fs');

// ── Load .env ────────────────────────────────────────────────
const envPath = path.resolve(__dirname, '../.env');
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

// ── Config ───────────────────────────────────────────────────
const args = process.argv.slice(2);
const API_BASE = args.includes('--local') ? 'http://localhost:3000' : 'https://eclawbot.com';

// Android WebView User-Agent (simulates the real app)
const ANDROID_WEBVIEW_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.0.0 Mobile Safari/537.36 EClawAndroid';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36';

// Pages that load ai-chat.js
const AI_CHAT_PAGES = [
    'chat.html',
    'dashboard.html',
    'admin.html',
    'settings.html',
    'kanban.html',
    'env-vars.html',
    'files.html',
    'feedback.html',
    'card-holder.html',
];

let passed = 0;
let failed = 0;

function ok(desc) { passed++; console.log(`  ✅ ${desc}`); }
function fail(desc, detail) { failed++; console.log(`  ❌ ${desc}${detail ? ' — ' + detail : ''}`); }

async function fetchText(urlPath, ua) {
    const res = await fetch(`${API_BASE}${urlPath}`, {
        headers: { 'User-Agent': ua || BROWSER_UA },
        redirect: 'follow',
    });
    return { status: res.status, headers: res.headers, body: await res.text() };
}

// ── Test 1: Inline guard present in all ai-chat pages ────────
async function testInlineGuard() {
    console.log('\n[1] Inline __blockAiChatWidget guard in portal pages');
    for (const page of AI_CHAT_PAGES) {
        const { status, body } = await fetchText(`/portal/${page}`);
        if (status !== 200) { fail(`${page} — HTTP ${status}`); continue; }
        if (body.includes('__blockAiChatWidget')) {
            ok(`${page} has inline guard`);
        } else {
            fail(`${page} missing __blockAiChatWidget guard`);
        }
    }
}

// ── Test 2: Guard appears BEFORE ai-chat.js script tag ───────
async function testGuardOrder() {
    console.log('\n[2] Guard appears before ai-chat.js script tag');
    for (const page of AI_CHAT_PAGES) {
        const { body } = await fetchText(`/portal/${page}`);
        const guardIdx = body.indexOf('__blockAiChatWidget');
        const scriptIdx = body.indexOf('ai-chat.js');
        if (guardIdx > -1 && scriptIdx > -1 && guardIdx < scriptIdx) {
            ok(`${page} guard precedes ai-chat.js`);
        } else {
            fail(`${page} guard order wrong (guard=${guardIdx}, script=${scriptIdx})`);
        }
    }
}

// ── Test 3: ai-chat.js has WebView detection ─────────────────
async function testAiChatJsDetection() {
    console.log('\n[3] ai-chat.js contains WebView detection');
    const { status, body } = await fetchText('/portal/shared/ai-chat.js');
    if (status !== 200) { fail(`ai-chat.js HTTP ${status}`); return; }

    const checks = [
        ['__blockAiChatWidget early return', /window\.__blockAiChatWidget/],
        ['isAndroidWebView function', /function isAndroidWebView/],
        ['AndroidBridge check', /AndroidBridge/],
        ['EClawAndroid UA check', /EClawAndroid/],
    ];
    for (const [desc, re] of checks) {
        re.test(body) ? ok(desc) : fail(desc);
    }
}

// ── Test 4: No debug instrumentation in ai-chat.js ──────────
async function testNoDebugCode() {
    console.log('\n[4] ai-chat.js has no debug instrumentation');
    const { body } = await fetchText('/portal/shared/ai-chat.js');
    const banned = [
        ['dbg() function', /function dbg\(/],
        ['flushDebugToServer', /flushDebugToServer/],
        ['_debugLogs array', /_debugLogs/],
        ['visible debug banner', /background:\s*red/],
        ['AI-CHAT DEBUG REPORT', /AI-CHAT DEBUG REPORT/],
    ];
    for (const [desc, re] of banned) {
        re.test(body) ? fail(`${desc} still present`) : ok(`no ${desc}`);
    }
}

// ── Test 5: Cache-Control: no-store on HTML and JS ───────────
async function testCacheHeaders() {
    console.log('\n[5] Cache-Control: no-store on portal HTML and JS');

    // Test HTML
    const htmlRes = await fetchText('/portal/chat.html');
    const htmlCC = htmlRes.headers.get('cache-control') || '';
    htmlCC.includes('no-store') ? ok('chat.html has no-store') : fail(`chat.html cache-control: ${htmlCC}`);

    // Test JS
    const jsRes = await fetchText('/portal/shared/ai-chat.js');
    const jsCC = jsRes.headers.get('cache-control') || '';
    jsCC.includes('no-store') ? ok('ai-chat.js has no-store') : fail(`ai-chat.js cache-control: ${jsCC}`);
}

// ── Test 6: Same ai-chat.js served regardless of UA ──────────
async function testUaIndependence() {
    console.log('\n[6] ai-chat.js content identical for browser vs Android UA');
    const browser = await fetchText('/portal/shared/ai-chat.js', BROWSER_UA);
    const android = await fetchText('/portal/shared/ai-chat.js', ANDROID_WEBVIEW_UA);
    if (browser.body === android.body) {
        ok('ai-chat.js identical for both UAs (detection is client-side)');
    } else {
        fail('ai-chat.js differs between UAs — unexpected server-side branching');
    }
}

// ── Main ─────────────────────────────────────────────────────
async function main() {
    console.log(`\n🛡️  AI Chat WebView Guard — Regression Test (#419)`);
    console.log(`   Target: ${API_BASE}\n`);

    await testInlineGuard();
    await testGuardOrder();
    await testAiChatJsDetection();
    await testNoDebugCode();
    await testCacheHeaders();
    await testUaIndependence();

    console.log(`\n${'─'.repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed out of ${passed + failed}`);
    if (failed > 0) process.exit(1);
    console.log('✅ All checks passed!\n');
}

main().catch(err => { console.error(err); process.exit(1); });
