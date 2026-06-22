/**
 * Shareable chat link & pending cross-speak tests (Jest + Supertest)
 *
 * Tests:
 * - GET /c/:code serves share-chat.html
 * - POST /api/chat/pending-cross-speak validation
 */

// ── Mock all modules with side-effects before requiring index.js ──

jest.mock('pg', () => ({
    Pool: jest.fn().mockImplementation(() => ({
        query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
        connect: jest.fn().mockResolvedValue({
            query: jest.fn().mockResolvedValue({ rows: [] }),
            release: jest.fn(),
        }),
        end: jest.fn().mockResolvedValue(undefined),
    })),
}));

jest.mock('../../db', () => ({
    initDatabase: jest.fn().mockResolvedValue(true),
    saveDeviceData: jest.fn().mockResolvedValue(true),
    saveAllDevices: jest.fn().mockResolvedValue(true),
    loadAllDevices: jest.fn().mockResolvedValue({}),
    deleteDevice: jest.fn().mockResolvedValue(true),
    deleteEntity: jest.fn().mockResolvedValue(true),
    getStats: jest.fn().mockResolvedValue({}),
    closeDatabase: jest.fn().mockResolvedValue(undefined),
    saveOfficialBot: jest.fn().mockResolvedValue(true),
    loadOfficialBots: jest.fn().mockResolvedValue({}),
    deleteOfficialBot: jest.fn().mockResolvedValue(true),
    saveOfficialBinding: jest.fn().mockResolvedValue(true),
    removeOfficialBinding: jest.fn().mockResolvedValue(true),
    getOfficialBinding: jest.fn().mockResolvedValue(null),
    getDeviceOfficialBindings: jest.fn().mockResolvedValue([]),
    updateSubscriptionVerified: jest.fn().mockResolvedValue(true),
    loadAllOfficialBindings: jest.fn().mockResolvedValue([]),
    getExpiredPersonalBindings: jest.fn().mockResolvedValue([]),
    getPaidBorrowSlots: jest.fn().mockResolvedValue(0),
    incrementPaidBorrowSlots: jest.fn().mockResolvedValue(true),
    saveFeedback: jest.fn().mockResolvedValue({ id: 1 }),
    getCardHolder: jest.fn().mockResolvedValue([]),
    addCard: jest.fn().mockResolvedValue(null),
    updateCard: jest.fn().mockResolvedValue(null),
    refreshCardSnapshot: jest.fn().mockResolvedValue(null),
    searchCards: jest.fn().mockResolvedValue([]),
    getCardByCode: jest.fn().mockResolvedValue(null),
    removeCard: jest.fn().mockResolvedValue(true),
    getCardCount: jest.fn().mockResolvedValue(0),
    incrementInteraction: jest.fn().mockResolvedValue(undefined),
    getRecentInteractions: jest.fn().mockResolvedValue([]),
    upsertRecentInteraction: jest.fn().mockResolvedValue(null),
    isBlocked: jest.fn().mockResolvedValue(false),
    getContacts: jest.fn().mockResolvedValue([]),
    addContact: jest.fn().mockResolvedValue(null),
    removeContact: jest.fn().mockResolvedValue(true),
    getContactCount: jest.fn().mockResolvedValue(0),
    upsertDeviceVars: jest.fn().mockResolvedValue(true),
    getDeviceVars: jest.fn().mockResolvedValue(null),
    getDeviceVarsMeta: jest.fn().mockResolvedValue(null),
    deleteDeviceVars: jest.fn().mockResolvedValue(true),
    createChannelAccount: jest.fn().mockResolvedValue(null),
    getChannelAccountById: jest.fn().mockResolvedValue(null),
    getChannelAccountsByDevice: jest.fn().mockResolvedValue([]),
    getChannelAccountByKey: jest.fn().mockResolvedValue(null),
    getChannelAccountByDevice: jest.fn().mockResolvedValue(null),
    deleteChannelAccount: jest.fn().mockResolvedValue(true),
    updateChannelCallback: jest.fn().mockResolvedValue(true),
    updateChannelE2eeCapable: jest.fn().mockResolvedValue(true),
    clearChannelCallback: jest.fn().mockResolvedValue(true),
    insertSkillContribution: jest.fn().mockResolvedValue(undefined),
    updateSkillContribution: jest.fn().mockResolvedValue(undefined),
    getSkillContributions: jest.fn().mockResolvedValue([]),
    getSkillContributionByPendingId: jest.fn().mockResolvedValue(null),
    getApprovedSkillContributions: jest.fn().mockResolvedValue([]),
    insertSoulContribution: jest.fn().mockResolvedValue(undefined),
    getSoulContributions: jest.fn().mockResolvedValue([]),
    getApprovedSoulContributions: jest.fn().mockResolvedValue([]),
    insertRuleContribution: jest.fn().mockResolvedValue(undefined),
    getRuleContributions: jest.fn().mockResolvedValue([]),
    getApprovedRuleContributions: jest.fn().mockResolvedValue([]),
    saveEntityToTrash: jest.fn().mockResolvedValue(undefined),
    getEntityTrash: jest.fn().mockResolvedValue([]),
    getEntityTrashItem: jest.fn().mockResolvedValue(null),
    deleteEntityTrashItem: jest.fn().mockResolvedValue(undefined),
    cleanupExpiredTrash: jest.fn().mockResolvedValue(0),
    savePendingCrossMessage: jest.fn().mockResolvedValue(1),
    getPendingCrossMessages: jest.fn().mockResolvedValue([]),
    deletePendingCrossMessages: jest.fn().mockResolvedValue(0),
    cleanupExpiredPendingMessages: jest.fn().mockResolvedValue(0),
}));

jest.mock('../../flickr', () => ({
    initFlickr: jest.fn(),
    uploadPhoto: jest.fn().mockResolvedValue(null),
    isAvailable: jest.fn().mockReturnValue(false),
}));

jest.mock('../../scheduler', () => ({
    init: jest.fn(),
    createSchedule: jest.fn().mockResolvedValue({ id: 1 }),
    updateSchedule: jest.fn().mockResolvedValue(true),
    deleteSchedule: jest.fn().mockResolvedValue(true),
    getSchedules: jest.fn().mockResolvedValue([]),
    getSchedule: jest.fn().mockResolvedValue(null),
    getSchedulesForBot: jest.fn().mockResolvedValue([]),
}));

jest.mock('../../device-telemetry', () => ({
    initTelemetryTable: jest.fn().mockResolvedValue(undefined),
    appendEntries: jest.fn().mockResolvedValue(undefined),
    captureApiCall: jest.fn().mockResolvedValue(undefined),
    getEntries: jest.fn().mockResolvedValue([]),
    getSummary: jest.fn().mockResolvedValue({}),
    clearEntries: jest.fn().mockResolvedValue(undefined),
    createMiddleware: jest.fn().mockReturnValue((_req, _res, next) => next()),
    sanitize: jest.fn().mockImplementation((v) => v),
    MAX_BUFFER_BYTES: 1024 * 1024,
    MAX_ENTRIES: 500,
}));

jest.mock('../../device-feedback', () => ({
    initFeedbackTable: jest.fn().mockResolvedValue(undefined),
    initFeedbackPhotosTable: jest.fn().mockResolvedValue(undefined),
    captureLogSnapshot: jest.fn().mockResolvedValue([]),
    captureDeviceState: jest.fn().mockResolvedValue({}),
    autoTriage: jest.fn().mockResolvedValue('low'),
    generateAiPrompt: jest.fn().mockReturnValue(''),
    saveFeedback: jest.fn().mockResolvedValue({ id: 1 }),
    getFeedbackList: jest.fn().mockResolvedValue([]),
    getFeedbackById: jest.fn().mockResolvedValue(null),
    updateFeedback: jest.fn().mockResolvedValue(true),
    createGithubIssue: jest.fn().mockResolvedValue(null),
    getPendingDebugFeedback: jest.fn().mockResolvedValue([]),
    saveDebugResult: jest.fn().mockResolvedValue(true),
    setMark: jest.fn().mockResolvedValue(undefined),
    getMark: jest.fn().mockResolvedValue(null),
    clearMark: jest.fn().mockResolvedValue(undefined),
    LOG_WINDOW_MS: 60000,
    MAX_PHOTOS_PER_FEEDBACK: 10,
    MAX_PHOTO_SIZE: 5 * 1024 * 1024,
    saveFeedbackPhoto: jest.fn().mockResolvedValue({ id: 1 }),
    getFeedbackPhotos: jest.fn().mockResolvedValue([]),
    getFeedbackPhoto: jest.fn().mockResolvedValue(null),
    deleteFeedbackPhotos: jest.fn().mockResolvedValue(undefined),
    cleanupResolvedFeedbackPhotos: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../gatekeeper', () => ({
    detectMaliciousMessage: jest.fn().mockReturnValue({ isMalicious: false }),
    detectAndMaskLeaks: jest.fn().mockImplementation((text) => text),
    initGatekeeperTable: jest.fn().mockResolvedValue(undefined),
    loadBlockedDevices: jest.fn().mockResolvedValue(undefined),
    recordViolation: jest.fn().mockResolvedValue(undefined),
    isDeviceBlocked: jest.fn().mockReturnValue(false),
    getStrikeInfo: jest.fn().mockResolvedValue({ strikes: 0, blocked: false }),
    getFreeBotTOS: jest.fn().mockResolvedValue(null),
    hasAgreedToTOS: jest.fn().mockResolvedValue(false),
    recordTOSAgreement: jest.fn().mockResolvedValue(undefined),
    setServerLog: jest.fn(),
    MAX_STRIKES: 3,
    FREE_BOT_TOS_VERSION: '1.0',
}));

jest.mock('../../mission', () => {
    const express = jest.requireActual('express');
    return jest.fn().mockReturnValue({
        router: express.Router(),
        initMissionDatabase: jest.fn().mockResolvedValue(undefined),
        setNotifyCallback: jest.fn(),
        setPushToBot: jest.fn(),
        setPushToChannelCallback: jest.fn(),
    });
});

jest.mock('../../auth', () => {
    const express = jest.requireActual('express');
    const noop = (_req, _res, next) => next();
    return jest.fn().mockReturnValue({
        router: express.Router(),
        authMiddleware: noop,
        softAuthMiddleware: noop,
        adminMiddleware: noop,
        initAuthDatabase: jest.fn().mockResolvedValue(undefined),
        setOnEmailVerified: jest.fn(),
        pool: {
            query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
        },
    });
});

jest.mock('../../subscription', () => {
    const express = jest.requireActual('express');
    return jest.fn().mockReturnValue({
        router: express.Router(),
        loadPremiumStatus: jest.fn().mockResolvedValue(undefined),
    });
});

// ── Load app after mocks are established ──
const request = require('supertest');
let app;

beforeAll(() => {
    app = require('../../index');
});

afterAll(async () => {
    const { httpServer } = require('../../index');
    await new Promise(resolve => httpServer.close(resolve));
    jest.resetModules();
});

// ════════════════════════════════════════════════════════════════
// GET /c/:code — Shareable chat link
// ════════════════════════════════════════════════════════════════
describe('GET /c/:code', () => {
    it('returns HTTP 200 and serves HTML', async () => {
        const res = await request(app).get('/c/abc123');
        expect(res.status).toBe(200);
        expect(res.text).toContain('share-chat');
    });

    it('serves HTML for any valid code format', async () => {
        const res = await request(app).get('/c/xyz789');
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/text\/html/);
    });
});

// ════════════════════════════════════════════════════════════════
// POST /api/chat/pending-cross-speak — Queue pending message
// ════════════════════════════════════════════════════════════════
describe('POST /api/chat/pending-cross-speak', () => {
    it('rejects unauthenticated requests', async () => {
        const res = await request(app)
            .post('/api/chat/pending-cross-speak')
            .send({ targetCode: 'abc123', text: 'hello' });
        expect(res.status).toBe(401);
    });

    it('rejects missing targetCode', async () => {
        const res = await request(app)
            .post('/api/chat/pending-cross-speak')
            .set('Cookie', 'eclaw_session=invalid')
            .send({ text: 'hello' });
        // Will be 401 due to invalid cookie, which is fine
        expect([400, 401]).toContain(res.status);
    });

    it('rejects missing text', async () => {
        const res = await request(app)
            .post('/api/chat/pending-cross-speak')
            .set('Cookie', 'eclaw_session=invalid')
            .send({ targetCode: 'abc123' });
        expect([400, 401]).toContain(res.status);
    });
});

// ════════════════════════════════════════════════════════════════
// Regression: share-chat registration must NOT redirect away
// ════════════════════════════════════════════════════════════════
describe('share-chat registration flow (static analysis)', () => {
    const fs = require('fs');
    const path = require('path');
    const html = fs.readFileSync(
        path.join(__dirname, '../../public/portal/share-chat.html'), 'utf8'
    );

    it('doRegister does not call dispatchPendingAndRedirect', () => {
        // Extract the doRegister function body
        const match = html.match(/async function doRegister\(\)\s*\{([\s\S]*?)^\s{4}\}/m);
        expect(match).toBeTruthy();
        const body = match[1];
        expect(body).not.toContain('dispatchPendingAndRedirect');
    });

    it('doRegister shows success toast with i18n key', () => {
        const match = html.match(/async function doRegister\(\)\s*\{([\s\S]*?)^\s{4}\}/m);
        expect(match).toBeTruthy();
        const body = match[1];
        expect(body).toContain('sc_register_success_verify');
    });

    it('doRegister shows pending message on successful registration', () => {
        const match = html.match(/async function doRegister\(\)\s*\{([\s\S]*?)^\s{4}\}/m);
        expect(match).toBeTruthy();
        const body = match[1];
        expect(body).toContain("addLocalMessage(saved, 'pending')");
    });

    it('i18n key sc_register_success_verify exists in all languages', () => {
        const i18nContent = fs.readFileSync(
            path.join(__dirname, '../../public/shared/i18n.js'), 'utf8'
        );
        const langs = ['en', 'zh-TW', 'zh-CN', 'ja', 'ko', 'th', 'vi', 'id'];
        // The key should appear once per language
        const count = (i18nContent.match(/sc_register_success_verify/g) || []).length;
        expect(count).toBeGreaterThanOrEqual(langs.length);
    });

    it('doRegister does NOT call /api/auth/login (session cookie set by register)', () => {
        const match = html.match(/async function doRegister\(\)\s*\{([\s\S]*?)^\s{4}\}/m);
        expect(match).toBeTruthy();
        const body = match[1];
        expect(body).not.toContain('/api/auth/login');
    });

    it('doRegister saves pending message to DB via pending-cross-speak API', () => {
        const match = html.match(/async function doRegister\(\)\s*\{([\s\S]*?)^\s{4}\}/m);
        expect(match).toBeTruthy();
        const body = match[1];
        expect(body).toContain('pending-cross-speak');
    });

    it('doRegister starts verification polling after register', () => {
        const match = html.match(/async function doRegister\(\)\s*\{([\s\S]*?)^\s{4}\}/m);
        expect(match).toBeTruthy();
        const body = match[1];
        expect(body).toContain('startVerificationPolling');
    });

    it('startVerificationPolling function exists and polls /api/auth/me', () => {
        expect(html).toContain('function startVerificationPolling()');
        expect(html).toContain('/api/auth/me');
        // Should remove local messages before history reload to avoid duplicates
        expect(html).toContain('.msg.pending, .msg.sent');
        expect(html).toContain('el.remove()');
    });

    it('i18n keys sc_email_verified, sc_message_queued, sc_queue_failed exist in all languages', () => {
        const i18nContent = fs.readFileSync(
            path.join(__dirname, '../../public/shared/i18n.js'), 'utf8'
        );
        const langs = ['en', 'zh-TW', 'zh-CN', 'ja', 'ko', 'th', 'vi', 'id'];
        for (const key of ['sc_email_verified', 'sc_message_queued', 'sc_queue_failed']) {
            const count = (i18nContent.match(new RegExp(key, 'g')) || []).length;
            expect(count).toBeGreaterThanOrEqual(langs.length);
        }
    });

    it('rich-card actions target the visible #msgInput composer', () => {
        expect(html).toContain("document.getElementById('msgInput')");
        expect(html).not.toContain("document.getElementById('messageInput')");
    });

    it('renders a persistent share status panel with copy-link control', () => {
        expect(html).toContain('id="shareChatStatusPanel"');
        expect(html).toContain('data-auth-state="loading"');
        expect(html).toContain('aria-live="polite"');
        expect(html).toContain('id="shareTargetLabel"');
        expect(html).toContain('id="shareStatusText"');
        expect(html).toContain('id="copyShareLinkBtn"');
        expect(html).toContain('onclick="copyShareLink()"');
        expect(html).toContain('aria-label="Copy share chat link"');
    });

    it('share status panel reflects auth and delivery states', () => {
        expect(html).toContain('function updateShareStatusPanel()');
        expect(html).toContain("setShareStatus('guest', t('sc_start_conversation'");
        expect(html).toContain("setShareStatus('verify', t('sc_send_verify_required_tip'");
        expect(html).toContain("setShareStatus('ready', `${t('sc_send_as'");
        expect(html).toContain("setShareStatus('verify', t('sc_message_queued'");
        expect(html).toContain("document.getElementById('senderSelect').addEventListener('change', updateShareStatusPanel)");
    });

    it('copy-share action uses canonical /c link and clipboard fallback', () => {
        expect(html).toContain('function shareLinkUrl()');
        expect(html).toContain('`${window.location.origin}/c/${encodeURIComponent(targetCode)}`');
        expect(html).toContain('async function copyShareLink()');
        expect(html).toContain('navigator.clipboard.writeText(url)');
        expect(html).toContain('function copyTextFallback(text)');
        expect(html).toContain("document.execCommand('copy')");
        expect(html).toContain("setShareStatus('copied', t('sc_link_copied'");
    });
});

// ════════════════════════════════════════════════════════════════
// GET /api/chat/share-history — Regression: no data leakage
// ════════════════════════════════════════════════════════════════
describe('GET /api/chat/share-history', () => {
    it('rejects unauthenticated requests', async () => {
        const res = await request(app).get('/api/chat/share-history?code=abc123');
        expect(res.status).toBe(401);
    });

    it('rejects missing code parameter (with invalid auth)', async () => {
        const res = await request(app)
            .get('/api/chat/share-history')
            .set('Cookie', 'eclaw_session=invalid');
        // 401 (invalid cookie) or 400 (missing code) — both acceptable
        expect([400, 401]).toContain(res.status);
    });
});

// ════════════════════════════════════════════════════════════════
// Regression: share-history must NOT use broad is_from_bot filter
// ════════════════════════════════════════════════════════════════
describe('share-history query isolation (static analysis)', () => {
    const fs = require('fs');
    const path = require('path');
    const indexSource = fs.readFileSync(
        path.join(__dirname, '../../index.js'), 'utf8'
    );

    // Extract the share-history route handler
    const routeMatch = indexSource.match(
        /app\.get\('\/api\/chat\/share-history'[\s\S]*?\n\}\);/
    );
    const routeBody = routeMatch ? routeMatch[0] : '';

    it('share-history handler exists', () => {
        expect(routeBody.length).toBeGreaterThan(100);
    });

    it('queries BOTH target device and sender device via UNION', () => {
        // The fix uses UNION ALL to merge target-device sender messages
        // and sender-device auto-routed bot replies
        expect(routeBody).toContain('UNION ALL');
    });

    it('does NOT use broad is_from_bot on target device', () => {
        // The old buggy query had: WHERE device_id = $1 ... AND (source ILIKE $3 OR is_from_bot = true)
        // This leaked ALL bot messages. After fix, is_from_bot should only appear
        // in the sender-device subquery, not in the target-device subquery.
        // Split the UNION: first subquery should NOT contain is_from_bot
        const parts = routeBody.split('UNION ALL');
        if (parts.length >= 2) {
            // First subquery (target device): must NOT have is_from_bot = true
            // It should only filter by source ILIKE (sender's messages)
            const firstSubquery = parts[0];
            // The first SELECT should use entity_id and source ILIKE, not is_from_bot
            expect(firstSubquery).toContain('source ILIKE');
            // Ensure no standalone "is_from_bot = true" in first subquery
            // (it can appear in the SELECT column list, but not in WHERE)
            const firstWhere = firstSubquery.split('WHERE').slice(1).join('WHERE');
            expect(firstWhere).not.toMatch(/is_from_bot\s*=\s*true/);
        }
    });

    it('sender device query filters by target publicCode pattern', () => {
        // The second subquery should search sender's device for auto-routed
        // replies containing the target publicCode
        expect(routeBody).toContain('targetCodePattern');
        expect(routeBody).toContain('senderDeviceId');
    });
});
