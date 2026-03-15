#!/usr/bin/env node
// Regression test: Publisher Platforms API
// Tests: /platforms listing, input validation for all 5 new platforms, Telegraph auto-account
// Run: node backend/tests/test-publisher-platforms.js

const BASE = process.env.TEST_BASE_URL || 'https://eclawbot.com';
let passed = 0, failed = 0;

function assert(cond, msg) {
    if (cond) { passed++; console.log(`  ✅ ${msg}`); }
    else { failed++; console.error(`  ❌ ${msg}`); }
}

async function api(method, path, body = null, headers = {}) {
    const opts = { method, headers: { 'Content-Type': 'application/json', ...headers } };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`${BASE}/api/publisher${path}`, opts);
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    return { status: res.status, data };
}

async function run() {
    console.log(`\n🧪 Publisher Platforms Tests (${BASE})\n`);

    // ── /platforms listing ──
    console.log('── GET /platforms ──');
    {
        const { status, data } = await api('GET', '/platforms');
        assert(status === 200, 'GET /platforms returns 200');
        assert(data.success === true, 'Response has success: true');
        assert(Array.isArray(data.platforms), 'platforms is array');
        assert(data.platforms.length === 12, `12 platforms listed (got ${data.platforms.length})`);

        const ids = data.platforms.map(p => p.id);
        for (const expected of ['blogger', 'hashnode', 'x', 'devto', 'wordpress', 'telegraph', 'qiita', 'wechat', 'tumblr', 'reddit', 'linkedin', 'mastodon']) {
            assert(ids.includes(expected), `Platform "${expected}" present`);
        }

        const telegraph = data.platforms.find(p => p.id === 'telegraph');
        assert(telegraph.configured === true, 'Telegraph always configured (auto-account)');
        assert(telegraph.region === 'global', 'Telegraph region is global');

        const qiita = data.platforms.find(p => p.id === 'qiita');
        assert(qiita.region === 'ja', 'Qiita region is ja');

        const wechat = data.platforms.find(p => p.id === 'wechat');
        assert(wechat.region === 'zh-CN', 'WeChat region is zh-CN');
        assert(wechat.draftsOnly === true, 'WeChat marked as draftsOnly');
    }

    // ── DEV.to input validation ──
    console.log('\n── DEV.to validation ──');
    {
        const { status, data } = await api('POST', '/devto/publish', { title: 'test' });
        // Should either be 400 (missing body_markdown) or 501 (not configured)
        assert(status === 400 || status === 501, `DEV.to publish without body_markdown → ${status}`);
        assert(data.error, `Has error message: "${data.error}"`);
    }
    {
        const { status, data } = await api('POST', '/devto/publish', {});
        assert(status === 400 || status === 501, `DEV.to publish empty body → ${status}`);
    }

    // ── WordPress validation ──
    console.log('\n── WordPress validation ──');
    {
        const { status, data } = await api('POST', '/wordpress/publish', { title: 'test', content: '<p>hi</p>' });
        assert(status === 400 || status === 501, `WordPress without siteId → ${status}`);
    }
    {
        const { status } = await api('DELETE', '/wordpress/post/123');
        assert(status === 400 || status === 501, `WordPress delete without siteId → ${status}`);
    }

    // ── Telegraph ──
    console.log('\n── Telegraph ──');
    {
        const { status, data } = await api('POST', '/telegraph/publish', { title: 'test' });
        assert(status === 400, `Telegraph without content → 400 (got ${status})`);
        assert(data.error === 'title, content required', 'Correct error message');
    }
    {
        const { status, data } = await api('PUT', '/telegraph/page/test-path', { title: 'test' });
        assert(status === 400, `Telegraph edit without content → 400 (got ${status})`);
    }

    // ── Qiita validation ──
    console.log('\n── Qiita validation ──');
    {
        const { status, data } = await api('POST', '/qiita/publish', { title: 'test' });
        assert(status === 400 || status === 501, `Qiita without body → ${status}`);
    }
    {
        const { status, data } = await api('POST', '/qiita/publish', {});
        assert(status === 400 || status === 501, `Qiita empty body → ${status}`);
    }

    // ── WeChat validation ──
    console.log('\n── WeChat validation ──');
    {
        const { status, data } = await api('POST', '/wechat/draft', { title: 'test', content: '<p>hi</p>' });
        assert(status === 400 || status === 501, `WeChat without thumb_media_id → ${status}`);
    }
    {
        const { status } = await api('POST', '/wechat/draft', {});
        assert(status === 400 || status === 501, `WeChat empty body → ${status}`);
    }

    // ── Tumblr validation ──
    console.log('\n── Tumblr validation ──');
    {
        const { status } = await api('POST', '/tumblr/publish', { blogName: 'test' });
        assert(status === 400 || status === 501, `Tumblr without content → ${status}`);
    }
    {
        const { status } = await api('POST', '/tumblr/publish', {});
        assert(status === 400 || status === 501, `Tumblr empty body → ${status}`);
    }
    {
        const { status } = await api('DELETE', '/tumblr/post/123');
        assert(status === 400 || status === 501, `Tumblr delete without blogName → ${status}`);
    }

    // ── Reddit validation ──
    console.log('\n── Reddit validation ──');
    {
        const { status } = await api('POST', '/reddit/submit', { subreddit: 'test' });
        assert(status === 400 || status === 501, `Reddit without title → ${status}`);
    }
    {
        const { status } = await api('POST', '/reddit/submit', {});
        assert(status === 400 || status === 501, `Reddit empty body → ${status}`);
    }

    // ── LinkedIn validation ──
    console.log('\n── LinkedIn validation ──');
    {
        const { status } = await api('POST', '/linkedin/publish', {});
        assert(status === 400 || status === 501, `LinkedIn without text → ${status}`);
    }

    // ── Mastodon validation ──
    console.log('\n── Mastodon validation ──');
    {
        const { status } = await api('POST', '/mastodon/publish', {});
        assert(status === 400 || status === 501, `Mastodon without status → ${status}`);
    }

    // ── Summary ──
    console.log(`\n${'='.repeat(40)}`);
    console.log(`Results: ${passed} passed, ${failed} failed (${passed + failed} total)`);
    process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => { console.error('Fatal:', err); process.exit(1); });
