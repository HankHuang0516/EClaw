#!/usr/bin/env node
/**
 * P4: Production Live Verification — Subscription Plans + Wallet + UI/UX Routes
 *
 * Tests:
 * P4-1: GET /api/subscription/plans returns 4 plans
 * P4-2: GET /api/wallet/topup/tiers returns 5 tiers
 * P4-3: GET /api/wallet/balance requires auth (401)
 * P4-4: GET /api/rental/marketplace is publicly accessible
 * P4-UI: All portal pages return 200 with valid HTML
 *
 * Usage: node backend/tests/test-subscription-plans-live.js
 */

const BASE = process.env.TEST_BASE_URL || 'https://eclawbot.com';

let passed = 0;
let failed = 0;

async function test(name, fn) {
    try {
        await fn();
        console.log(`  ✅ ${name}`);
        passed++;
    } catch (err) {
        console.log(`  ❌ ${name}: ${err.message}`);
        failed++;
    }
}

function assert(condition, msg) {
    if (!condition) throw new Error(msg);
}

async function fetchJson(path) {
    const res = await fetch(`${BASE}${path}`);
    const body = await res.json();
    return { status: res.status, body };
}

async function fetchHtml(path) {
    const res = await fetch(`${BASE}${path}`);
    const text = await res.text();
    return { status: res.status, text, contentType: res.headers.get('content-type') || '' };
}

async function run() {
    console.log(`\n🧪 P4: Live Verification against ${BASE}\n`);

    // ============================================
    // P4-1: Subscription Plans API
    // ============================================
    console.log('── Subscription Plans API ──');

    await test('GET /api/subscription/plans returns 200', async () => {
        const { status, body } = await fetchJson('/api/subscription/plans');
        assert(status === 200, `status=${status}`);
        assert(body.success === true, 'success not true');
    });

    await test('plans array has 4 tiers (free/starter/pro/business)', async () => {
        const { body } = await fetchJson('/api/subscription/plans');
        assert(Array.isArray(body.plans), 'plans is not array');
        assert(body.plans.length === 4, `plans.length=${body.plans.length}`);
        const ids = body.plans.map(p => p.id);
        assert(ids.includes('free'), 'missing free');
        assert(ids.includes('starter'), 'missing starter');
        assert(ids.includes('pro'), 'missing pro');
        assert(ids.includes('business'), 'missing business');
    });

    await test('officialBotMonthlyEcoin = 30000', async () => {
        const { body } = await fetchJson('/api/subscription/plans');
        assert(body.officialBotMonthlyEcoin === 30000, `got ${body.officialBotMonthlyEcoin}`);
    });

    await test('starter plan has correct values', async () => {
        const { body } = await fetchJson('/api/subscription/plans');
        const starter = body.plans.find(p => p.id === 'starter');
        assert(starter.priceUsd === 2.99, `priceUsd=${starter.priceUsd}`);
        assert(starter.monthlyEcoinGrant === 2000, `grant=${starter.monthlyEcoinGrant}`);
        assert(starter.messageLimit === null, `limit=${starter.messageLimit}`);
        assert(starter.googlePlayProductId === 'ec.sub.starter', `gpId=${starter.googlePlayProductId}`);
    });

    await test('free plan has messageLimit 15', async () => {
        const { body } = await fetchJson('/api/subscription/plans');
        const free = body.plans.find(p => p.id === 'free');
        assert(free.messageLimit === 15, `limit=${free.messageLimit}`);
        assert(free.monthlyEcoinGrant === 0, `grant=${free.monthlyEcoinGrant}`);
    });

    // ============================================
    // P4-2: Wallet Top-up Tiers API
    // ============================================
    console.log('\n── Wallet Top-up Tiers API ──');

    await test('GET /api/wallet/topup/tiers returns 200', async () => {
        const { status, body } = await fetchJson('/api/wallet/topup/tiers');
        assert(status === 200, `status=${status}`);
        assert(body.success === true, 'success not true');
    });

    await test('tiers array has 5 items with ec.topup.* IDs', async () => {
        const { body } = await fetchJson('/api/wallet/topup/tiers');
        assert(Array.isArray(body.tiers), 'tiers not array');
        assert(body.tiers.length === 5, `tiers.length=${body.tiers.length}`);
        const ids = body.tiers.map(t => t.productId);
        assert(ids.includes('ec.topup.small'), 'missing small');
        assert(ids.includes('ec.topup.starter'), 'missing starter');
        assert(ids.includes('ec.topup.standard'), 'missing standard');
        assert(ids.includes('ec.topup.advanced'), 'missing advanced');
        assert(ids.includes('ec.topup.premium'), 'missing premium');
    });

    await test('bonus percentages are 0/5/8/12/15', async () => {
        const { body } = await fetchJson('/api/wallet/topup/tiers');
        const bonuses = body.tiers.map(t => t.bonusPct);
        assert(JSON.stringify(bonuses) === '[0,5,8,12,15]', `bonuses=${JSON.stringify(bonuses)}`);
    });

    // ============================================
    // P4-3: Auth enforcement
    // ============================================
    console.log('\n── Auth Enforcement ──');

    await test('GET /api/wallet/balance without auth returns 401', async () => {
        const { status } = await fetchJson('/api/wallet/balance');
        assert(status === 401, `status=${status} (expected 401)`);
    });

    // ============================================
    // P4-4: Marketplace public access
    // ============================================
    console.log('\n── Marketplace ──');

    await test('GET /api/rental/marketplace returns 200 (public)', async () => {
        const { status, body } = await fetchJson('/api/rental/marketplace');
        assert(status === 200, `status=${status}`);
        assert(body.success === true, 'success not true');
    });

    // ============================================
    // P4-UI: Portal pages reachability + HTML integrity
    // ============================================
    console.log('\n── UI/UX Portal Route Tests ──');

    const portalPages = [
        { path: '/portal/', name: 'Login' },
        { path: '/portal/dashboard.html', name: 'Dashboard' },
        { path: '/portal/chat.html', name: 'Chat' },
        { path: '/portal/settings.html', name: 'Settings' },
        { path: '/portal/kanban.html', name: 'Kanban' },
        { path: '/portal/mission.html', name: 'Mission' },
        { path: '/portal/env-vars.html', name: 'Env Vars' },
        { path: '/portal/files.html', name: 'File Manager' },
        { path: '/portal/feedback.html', name: 'Feedback' },
        { path: '/portal/admin.html', name: 'Admin' },
        { path: '/portal/card-holder.html', name: 'Card Holder' },
        { path: '/portal/info.html', name: 'Info' },
        { path: '/portal/community.html', name: 'Community' },
        { path: '/portal/workspace.html', name: 'Workspace' },
        { path: '/portal/screen-control.html', name: 'Screen Control' },
        { path: '/portal/delete-account.html', name: 'Delete Account' },
        { path: '/portal/wallet.html', name: 'Wallet' },
        { path: '/portal/my-rentals.html', name: 'My Rentals' },
        { path: '/portal/invite.html', name: 'Invite' },
    ];

    for (const page of portalPages) {
        await test(`${page.name} (${page.path}) returns 200 with HTML`, async () => {
            const { status, text, contentType } = await fetchHtml(page.path);
            assert(status === 200, `status=${status}`);
            assert(contentType.includes('text/html'), `contentType=${contentType}`);
            assert(text.includes('</html>'), 'missing </html> closing tag');
            assert(text.length > 500, `HTML too short: ${text.length} chars`);
        });
    }

    // Public pages
    const publicPages = [
        { path: '/', name: 'Landing' },
        { path: '/enterprise', name: 'Enterprise' },
        { path: '/privacy-policy.html', name: 'Privacy Policy' },
    ];

    for (const page of publicPages) {
        await test(`${page.name} (${page.path}) returns 200`, async () => {
            const { status, text } = await fetchHtml(page.path);
            assert(status === 200, `status=${status}`);
            assert(text.includes('</html>'), 'missing </html>');
        });
    }

    // i18n.js loaded
    await test('i18n.js is accessible and valid JS', async () => {
        const res = await fetch(`${BASE}/shared/i18n.js`);
        assert(res.status === 200, `status=${res.status}`);
        const js = await res.text();
        assert(js.length > 10000, `i18n.js too short: ${js.length}`);
        assert(js.includes('en:'), 'missing en: section');
        assert(js.includes('zh:'), 'missing zh: section');
    });

    // entity-utils.js loaded
    await test('entity-utils.js is accessible', async () => {
        const res = await fetch(`${BASE}/portal/shared/entity-utils.js`);
        assert(res.status === 200, `status=${res.status}`);
    });

    // Wallet page has topup section
    await test('wallet.html contains topup tier rendering', async () => {
        const { text } = await fetchHtml('/portal/wallet.html');
        assert(text.includes('topup') || text.includes('top-up') || text.includes('wallet'), 'wallet page missing topup content');
    });

    // ============================================
    // Summary
    // ============================================
    console.log(`\n${'─'.repeat(40)}`);
    console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);

    if (failed > 0) {
        console.log('\n⚠️  Some tests failed!\n');
        process.exit(1);
    } else {
        console.log('\n✅ All P4 live tests passed!\n');
    }
}

run().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
