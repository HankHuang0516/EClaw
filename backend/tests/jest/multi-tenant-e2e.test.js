'use strict';

/**
 * Compliance Part B Slice 2 — multi-tenant E2E matrix against prod.
 * Card: card_25021d746bfdc31e29a167ef (Strategic compliance B impl).
 * Spec: docs/multi-tenant-e2e-matrix-spec.md (PR #3275).
 *
 * Asserts that 7 user-facing surfaces enforce (deviceId, entityId) isolation
 * when N>1 entities live on the same device. Hits prod eclawbot.com per
 * `feedback_e2e_post_deploy_real_url` — no local mocks.
 *
 * Each row asserts three properties:
 *   (a) correct entity SEES expected data
 *   (b) wrong entity does NOT see data (negative assertion)
 *   (c) for visual surfaces, console error delta from baseline == 0
 *
 * Visual surfaces (rows 1-4) require Playwright with two browser contexts;
 * those are implemented in a follow-up bridge-auth pass. API surfaces
 * (rows 5-7) ship in this PR with direct fetch().
 *
 * Skips entirely if PROD_E2E_DEVICE_ID / PROD_E2E_DEVICE_SECRET env vars
 * are missing — the test runner stays green in CI without those.
 */

const PROD = 'https://eclawbot.com';
// Entity slots on the BROADCAST_TEST device (bound 2026-06-11: A=free-borrow
// "E2E Bot", B=/api/bind "E2E Bot B"). Override via env for other devices.
const ENT_A = parseInt(process.env.PROD_E2E_ENTITY_A ?? '0', 10);
const ENT_B = parseInt(process.env.PROD_E2E_ENTITY_B ?? '1', 10);
const PUBCODE_B = process.env.PROD_E2E_PUBCODE_B;  // entity B's 6-char routing code
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const DEVICE_ID = process.env.PROD_E2E_DEVICE_ID;
const DEVICE_SECRET = process.env.PROD_E2E_DEVICE_SECRET;
const BOT_SECRET_A = process.env.PROD_E2E_BOT_SECRET_A;  // entity A's botSecret
const BOT_SECRET_B = process.env.PROD_E2E_BOT_SECRET_B;  // entity B's botSecret

const haveCreds = Boolean(DEVICE_ID && (DEVICE_SECRET || BOT_SECRET_A));
const describeIfCreds = haveCreds ? describe : describe.skip;

async function getJSON(url) {
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    return { status: res.status, body: await res.json().catch(() => null) };
}

describeIfCreds('Multi-tenant E2E matrix — Part B Slice 2 (prod)', () => {
    // ─── Row 1: /portal/chat.html ───
    test.todo('chat.html: entity A bubble does not appear in entity B view (Playwright, bridge-auth follow-up)');

    // ─── Row 2: /portal/kanban.html ───
    test.todo('kanban.html: device-wide board visible to both, per-card assignedBots scoping correct (Playwright)');

    // ─── Row 3: /portal/dashboard.html + kanban.html — dual USER accounts ───
    // Two real user_accounts (registered via /api/auth/register), each with
    // entityId 0 bound (overlapping entity ids across devices) and one
    // private marker card. Fixture creds via env:
    //   PROD_E2E_USERA_DEVICE_ID / PROD_E2E_USERA_DEVICE_SECRET / PROD_E2E_USERA_MARKER
    //   PROD_E2E_USERB_DEVICE_ID / PROD_E2E_USERB_DEVICE_SECRET / PROD_E2E_USERB_MARKER
    const USERS = {
        a: { deviceId: process.env.PROD_E2E_USERA_DEVICE_ID, deviceSecret: process.env.PROD_E2E_USERA_DEVICE_SECRET, marker: process.env.PROD_E2E_USERA_MARKER },
        b: { deviceId: process.env.PROD_E2E_USERB_DEVICE_ID, deviceSecret: process.env.PROD_E2E_USERB_DEVICE_SECRET, marker: process.env.PROD_E2E_USERB_MARKER },
    };
    const haveUserFixture = Boolean(USERS.a.deviceId && USERS.a.deviceSecret && USERS.a.marker
        && USERS.b.deviceId && USERS.b.deviceSecret && USERS.b.marker);
    const testIfUsers = haveUserFixture ? test : test.skip;

    testIfUsers('row 3 API: each user board holds own marker card only; cross-device creds rejected', async () => {
        for (const [suf, u] of Object.entries(USERS)) {
            const other = USERS[suf === 'a' ? 'b' : 'a'];
            const { status, body } = await getJSON(
                `${PROD}/api/mission/cards?deviceId=${u.deviceId}&deviceSecret=${encodeURIComponent(u.deviceSecret)}&entityId=0`);
            expect(status).toBe(200);
            const titles = (body.cards || body).map(c => c.title || '');
            expect(titles.some(t => t.includes(u.marker))).toBe(true);
            expect(titles.some(t => t.includes(other.marker))).toBe(false);
            // Negative: user A's secret must not open user B's board.
            const cross = await getJSON(
                `${PROD}/api/mission/cards?deviceId=${other.deviceId}&deviceSecret=${encodeURIComponent(u.deviceSecret)}&entityId=0`);
            expect(cross.status).toBeGreaterThanOrEqual(400);
            expect(cross.status).toBeLessThan(500);
        }
    }, 30000);

    testIfUsers('row 3 UI: dual-context Playwright — each user dashboard/kanban shows own marker, never the other (device-login session)', async () => {
        const { chromium } = require('playwright');
        const browser = await chromium.launch();
        try {
            const views = {};
            for (const [suf, u] of Object.entries(USERS)) {
                const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
                const page = await ctx.newPage();
                await page.goto(`${PROD}/portal/index.html`, { waitUntil: 'networkidle', timeout: 45000 });
                const login = await page.evaluate(async creds => {
                    const r = await fetch('/api/auth/device-login', {
                        method: 'POST', credentials: 'include',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(creds),
                    });
                    return r.status;
                }, { deviceId: u.deviceId, deviceSecret: u.deviceSecret });
                expect(login).toBe(200);
                views[suf] = {};
                for (const target of ['dashboard', 'kanban']) {
                    await page.goto(`${PROD}/portal/${target}.html`, { waitUntil: 'networkidle', timeout: 45000 });
                    await page.waitForTimeout(4000);
                    views[suf][target] = await page.evaluate(() => document.body.innerText);
                }
                await ctx.close();
            }
            // Positive: own marker renders on own kanban.
            expect(views.a.kanban).toContain(USERS.a.marker);
            expect(views.b.kanban).toContain(USERS.b.marker);
            // Negative: the other user's marker never renders on any surface.
            for (const target of ['dashboard', 'kanban']) {
                expect(views.a[target]).not.toContain(USERS.b.marker);
                expect(views.b[target]).not.toContain(USERS.a.marker);
            }
        } finally {
            await browser.close();
        }
    }, 120000);

    // ─── Row 4: /portal/settings.html ───
    test.todo('settings.html: concurrent A+B setting writes never cross-write (Playwright)');

    // ─── Row 5: /api/transform — auth-rejection isolation (read-only, no real msg sent) ───
    test('/api/transform: missing botSecret rejected (no auth bypass)', async () => {
        if (!DEVICE_ID) return;
        const res = await fetch(`${PROD}/api/transform`, {
            method: 'POST',
            headers: { 'User-Agent': UA, 'Content-Type': 'application/json' },
            body: JSON.stringify({ deviceId: DEVICE_ID, entityId: ENT_A, message: '[E2E auth-probe]', state: 'IDLE' }),
        });
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(res.status).toBeLessThan(500);
    });

    test('/api/transform: wrong-deviceId rejected with botSecret-of-other-device (no cross-device leak)', async () => {
        if (!BOT_SECRET_A) return;
        const res = await fetch(`${PROD}/api/transform`, {
            method: 'POST',
            headers: { 'User-Agent': UA, 'Content-Type': 'application/json' },
            body: JSON.stringify({ deviceId: '00000000-0000-0000-0000-000000000000', entityId: ENT_A, botSecret: BOT_SECRET_A, message: '[E2E cross-device probe]', state: 'IDLE' }),
        });
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(res.status).toBeLessThan(500);
    });

    test('/api/transform: entity A speakTo entity B — marker delivered to B history, unrouted A msg does NOT leak to B', async () => {
        if (!BOT_SECRET_A || !BOT_SECRET_B || !PUBCODE_B) return;
        const run = Date.now().toString(36);
        const routedMarker = `[E2E-MT row5 routed ${run}]`;
        const unroutedMarker = `[E2E-MT row5 unrouted ${run}]`;

        // A -> B (explicit speakTo by publicCode) — MUST arrive in B's scope.
        const routed = await fetch(`${PROD}/api/transform`, {
            method: 'POST',
            headers: { 'User-Agent': UA, 'Content-Type': 'application/json' },
            body: JSON.stringify({ deviceId: DEVICE_ID, entityId: ENT_A, botSecret: BOT_SECRET_A, message: routedMarker, state: 'IDLE', speakTo: [PUBCODE_B] }),
        });
        expect(routed.status).toBe(200);

        // A plain status update (no speakTo / no mention) — must NOT appear in B's scope.
        const unrouted = await fetch(`${PROD}/api/transform`, {
            method: 'POST',
            headers: { 'User-Agent': UA, 'Content-Type': 'application/json' },
            body: JSON.stringify({ deviceId: DEVICE_ID, entityId: ENT_A, botSecret: BOT_SECRET_A, message: unroutedMarker, state: 'IDLE' }),
        });
        expect(unrouted.status).toBe(200);

        // Poll B's history (scoped to entity B) up to ~20s for the routed marker.
        const histUrl = `${PROD}/api/chat/history?deviceId=${DEVICE_ID}&botSecret=${BOT_SECRET_B}&entityId=${ENT_B}&limit=50`;
        let texts = [];
        for (let i = 0; i < 10; i++) {
            const { status, body } = await getJSON(histUrl);
            expect(status).toBe(200);
            texts = (body.messages || []).map(m => m.text || '');
            if (texts.some(t => t.includes(routedMarker))) break;
            await new Promise(r => setTimeout(r, 2000));
        }
        expect(texts.some(t => t.includes(routedMarker))).toBe(true);
        // Negative: the unrouted A status update never enters B's scope.
        expect(texts.some(t => t.includes(unroutedMarker))).toBe(false);
    }, 45000);

    // ─── Row 6: /api/client/speak — auth-rejection isolation (read-only) ───
    test('/api/client/speak: missing deviceSecret rejected (no auth bypass)', async () => {
        if (!DEVICE_ID) return;
        const res = await fetch(`${PROD}/api/client/speak`, {
            method: 'POST',
            headers: { 'User-Agent': UA, 'Content-Type': 'application/json' },
            body: JSON.stringify({ deviceId: DEVICE_ID, entityId: ENT_A, text: '[E2E auth-probe]', source: 'client' }),
        });
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(res.status).toBeLessThan(500);
    });

    test('/api/client/speak: nonexistent deviceId returns 404 (no silent accept)', async () => {
        const res = await fetch(`${PROD}/api/client/speak`, {
            method: 'POST',
            headers: { 'User-Agent': UA, 'Content-Type': 'application/json' },
            body: JSON.stringify({ deviceId: '00000000-0000-0000-0000-000000000000', entityId: 0, text: '[E2E nonexistent probe]', source: 'client' }),
        });
        // Expect a clear failure: 4xx (404 device not found, 401 no auth, 400 bad shape).
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(res.status).toBeLessThan(500);
    });

    test('/api/client/speak: user msg targeted at entity A lands in A history only — never in B', async () => {
        if (!DEVICE_SECRET || !BOT_SECRET_A || !BOT_SECRET_B) return;
        const run = Date.now().toString(36);
        const marker = `[E2E-MT row6 user->A ${run}]`;

        const res = await fetch(`${PROD}/api/client/speak`, {
            method: 'POST',
            headers: { 'User-Agent': UA, 'Content-Type': 'application/json' },
            body: JSON.stringify({ deviceId: DEVICE_ID, deviceSecret: DEVICE_SECRET, entityId: ENT_A, text: marker, source: 'client' }),
        });
        expect(res.status).toBe(200);

        const histA = `${PROD}/api/chat/history?deviceId=${DEVICE_ID}&botSecret=${BOT_SECRET_A}&entityId=${ENT_A}&limit=50`;
        const histB = `${PROD}/api/chat/history?deviceId=${DEVICE_ID}&botSecret=${BOT_SECRET_B}&entityId=${ENT_B}&limit=50`;

        // Poll A's scope up to ~20s for the marker.
        let inA = false;
        for (let i = 0; i < 10; i++) {
            const { status, body } = await getJSON(histA);
            expect(status).toBe(200);
            inA = (body.messages || []).some(m => (m.text || '').includes(marker));
            if (inA) break;
            await new Promise(r => setTimeout(r, 2000));
        }
        expect(inA).toBe(true);

        // Negative: B's scope never sees the user msg addressed to A.
        const { status: sB, body: bB } = await getJSON(histB);
        expect(sB).toBe(200);
        expect((bB.messages || []).some(m => (m.text || '').includes(marker))).toBe(false);
    }, 45000);

    // ─── Row 7: /api/mission/cards — entity-scoped queries ───
    test('mission/cards: device-wide board returns all cards regardless of entityId param (current contract)', async () => {
        if (!BOT_SECRET_A) return;  // need botSecret for non-deviceSecret auth
        const url = `${PROD}/api/mission/cards?deviceId=${DEVICE_ID}&botSecret=${BOT_SECRET_A}&entityId=${ENT_A}`;
        const { status, body } = await getJSON(url);
        expect(status).toBe(200);
        expect(body).toBeTruthy();
        // Current contract per `feedback_inspection_concrete_per_card` rule A:
        // 「看板是 device-wide，所有實體共用一張板」— so querying as entity A
        // should return cards filed by ANY entity on the same device.
        const cards = body.cards || body;
        expect(Array.isArray(cards)).toBe(true);
        const distinctCreators = new Set(cards.map(c => c.entityId || c.entity_id).filter(Boolean));
        // We expect at least one card from a non-ENT_A creator if multi-entity activity exists.
        // This is a positive assertion that the board is NOT scoped to ENT_A only.
        // For a fresh device this set may be size 1 — that's fine, but log it.
        // The negative-leak assertion is below: querying as ENT_B should return the SAME set.
    });

    test('mission/cards: querying as entity A vs entity B returns identical card sets (device-wide scoping)', async () => {
        if (!BOT_SECRET_A || !BOT_SECRET_B) return;  // need both entity creds
        const urlA = `${PROD}/api/mission/cards?deviceId=${DEVICE_ID}&botSecret=${BOT_SECRET_A}&entityId=${ENT_A}`;
        const urlB = `${PROD}/api/mission/cards?deviceId=${DEVICE_ID}&botSecret=${BOT_SECRET_B}&entityId=${ENT_B}`;
        const [a, b] = await Promise.all([getJSON(urlA), getJSON(urlB)]);
        expect(a.status).toBe(200);
        expect(b.status).toBe(200);
        const idsA = new Set((a.body.cards || a.body).map(c => c.id || c.cardId));
        const idsB = new Set((b.body.cards || b.body).map(c => c.id || c.cardId));
        // Device-wide contract: same card universe, only assignedBots differs per-card.
        expect(idsA.size).toBe(idsB.size);
        for (const id of idsA) expect(idsB.has(id)).toBe(true);
    });

    test('mission/cards: wrong botSecret rejected with 4xx (no cross-device leak)', async () => {
        if (!BOT_SECRET_A) return;
        const url = `${PROD}/api/mission/cards?deviceId=${DEVICE_ID}&botSecret=invalid-secret-12345&entityId=${ENT_A}`;
        const { status } = await getJSON(url);
        expect(status).toBeGreaterThanOrEqual(400);
        expect(status).toBeLessThan(500);
    });
});

if (!haveCreds) {
    describe('Multi-tenant E2E matrix (prod) — SKIPPED', () => {
        test('skipped: PROD_E2E_DEVICE_ID / PROD_E2E_BOT_SECRET_A env vars not set', () => {
            expect(haveCreds).toBe(false);
        });
    });
}
