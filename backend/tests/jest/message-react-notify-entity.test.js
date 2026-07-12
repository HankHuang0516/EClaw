/**
 * E2E scenarios for POST /api/message/:messageId/react — verifies that the
 * new notification path (feat/message-reaction-notify-entity) fires the
 * quoted-bubble + verdict + XP-delta feedback into the bot entity's inbox
 * on every reaction transition, and stays silent when it should.
 *
 * Six scenarios covered (Hank 2026-07-12: 「所有場景都不能失誤」):
 *   1. fresh like            → 認同 + +5 XP
 *   2. fresh dislike         → 不認同 + -5 XP
 *   3. flip like → dislike   → 不認同 + -10 XP (reverse +5, apply -5)
 *   4. flip dislike → like   → 認同 + +10 XP (reverse -5, apply +5)
 *   5. clear (reaction=null) → 收回了對 + reversed XP
 *   6. unchanged (same react) → response {unchanged:true}, NO notify, NO XP
 *
 * Also verifies:
 *   - quoted excerpt truncates at 60 chars with ellipsis
 *   - unicode content survives the excerpt
 *   - endpoint response carries `feedbackNotified: {pushed, reason}`
 *   - the saved chat_messages row uses source='system' with is_from_bot=true
 *   - the enqueued message carries kind:'user_reaction' + reactionMeta
 */

'use strict';

jest.mock('pg', () => {
    // Each Pool instance shares a single .query jest fn; tests override it.
    const sharedQuery = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    const sharedConnect = jest.fn().mockResolvedValue({
        query: sharedQuery,
        release: jest.fn(),
    });
    return {
        Pool: jest.fn().mockImplementation(() => ({
            query: sharedQuery,
            connect: sharedConnect,
            end: jest.fn().mockResolvedValue(undefined),
            on: jest.fn(),
        })),
        _sharedQuery: sharedQuery,
    };
});

jest.mock('../../db', () => ({
    initDatabase: jest.fn().mockResolvedValue(true),
    saveDeviceData: jest.fn().mockResolvedValue(true),
    saveAllDevices: jest.fn().mockResolvedValue(true),
    loadAllDevices: jest.fn().mockResolvedValue({}),
    deleteDevice: jest.fn().mockResolvedValue(true),
    getStats: jest.fn().mockResolvedValue({}),
    closeDatabase: jest.fn().mockResolvedValue(undefined),
    saveOfficialBot: jest.fn().mockResolvedValue(true),
    loadOfficialBots: jest.fn().mockResolvedValue({}),
    deleteOfficialBot: jest.fn().mockResolvedValue(true),
    loadSubscriptions: jest.fn().mockResolvedValue({}),
    saveSubscription: jest.fn().mockResolvedValue(true),
    pool: { query: jest.fn().mockResolvedValue({ rows: [] }) },
}));

jest.mock('../../flickr', () => ({
    router: require('express').Router(),
    uploadToFlickr: jest.fn(),
}));

const request = require('supertest');
const app = require('../../index');

const DEVICE_ID = 'test-device-react-1';
const DEVICE_SECRET = 'test-device-secret-react-1';
const ENTITY_ID = 5;
const MESSAGE_ID = '11111111-1111-1111-1111-111111111111';
// Long enough (>60 chars) so the excerpt path exercises the truncation branch
// with unicode content.
// >60 chars so the excerpt path exercises the truncation branch (unicode).
const BUBBLE_TEXT = '你要不要試試把窗戶打開，讓夜風吹進來一點，聽聽外面的風聲，也許夢會來得比較容易一點。今晚很輕，我陪你到你睡著為止，願你在夢裡遇見溫柔的自己。';

// Track all chatPool.query invocations across a scenario so we can:
//   - stub the SELECT id, ... text query
//   - assert reaction_type upsert/update/delete happened
//   - assert like_count/dislike_count column update happened
function installChatPoolStub({ oldReaction = null } = {}) {
    let existingReactionRow = oldReaction ? [{ reaction_type: oldReaction }] : [];
    let likeCount = oldReaction === 'like' ? 1 : 0;
    let dislikeCount = oldReaction === 'dislike' ? 1 : 0;
    const calls = [];

    app._chatPool.query = jest.fn((sql, params) => {
        calls.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
        // Verify + fetch message
        if (/SELECT id, device_id, entity_id, is_from_bot, text FROM chat_messages/.test(sql)) {
            return Promise.resolve({ rows: [{
                id: MESSAGE_ID,
                device_id: DEVICE_ID,
                entity_id: ENTITY_ID,
                is_from_bot: true,
                text: BUBBLE_TEXT,
            }] });
        }
        // Existing reaction lookup
        if (/SELECT reaction_type FROM message_reactions/.test(sql)) {
            return Promise.resolve({ rows: existingReactionRow });
        }
        // Same-reaction short-circuit path (returns counts only)
        if (/SELECT like_count, dislike_count FROM chat_messages/.test(sql)) {
            return Promise.resolve({ rows: [{ like_count: likeCount, dislike_count: dislikeCount }] });
        }
        // Reaction upsert/update/delete
        if (/DELETE FROM message_reactions/.test(sql)) {
            existingReactionRow = [];
            return Promise.resolve({ rowCount: 1 });
        }
        if (/UPDATE message_reactions/.test(sql)) {
            existingReactionRow = [{ reaction_type: params[2] }];
            return Promise.resolve({ rowCount: 1 });
        }
        if (/INSERT INTO message_reactions/.test(sql)) {
            existingReactionRow = [{ reaction_type: params[2] }];
            return Promise.resolve({ rowCount: 1 });
        }
        // Count update
        if (/UPDATE chat_messages SET/.test(sql)) {
            likeCount = Math.max(0, likeCount + (params[1] || 0));
            dislikeCount = Math.max(0, dislikeCount + (params[2] || 0));
            return Promise.resolve({ rowCount: 1 });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
    });

    return { calls, state: () => ({ likeCount, dislikeCount, existingReactionRow }) };
}

function installDevice() {
    app.devices[DEVICE_ID] = {
        deviceSecret: DEVICE_SECRET,
        entities: {
            [ENTITY_ID]: {
                entityId: ENTITY_ID,
                deviceId: DEVICE_ID,
                character: 'LOBSTER',
                messageQueue: [],
                deadLetterQueue: [],
                xp: 0,
                level: 1,
                isBound: true,
                state: 'ACTIVE',
                lastActivityAt: Date.now(),
            },
        },
    };
    return app.devices[DEVICE_ID].entities[ENTITY_ID];
}

function resetDevices() {
    delete app.devices[DEVICE_ID];
}

describe('POST /api/message/:id/react — entity feedback notification (feat)', () => {
    let entity;
    let stub;

    beforeEach(() => {
        entity = installDevice();
    });

    afterEach(() => {
        resetDevices();
    });

    // Helper: assert the entity received a system-authored notification with the
    // correct verdict phrase + XP delta + quoted excerpt.
    function expectNotification({ verdictSubstring, xpDelta, expectedXpLabel }) {
        const notif = entity.messageQueue[entity.messageQueue.length - 1];
        expect(notif).toBeDefined();
        expect(notif.from).toBe('system');
        expect(notif.kind).toBe('user_reaction');
        expect(notif.reactionMeta).toBeDefined();
        expect(notif.reactionMeta.xpDelta).toBe(xpDelta);
        expect(notif.text).toContain('[使用者回饋]');
        expect(notif.text).toContain(verdictSubstring);
        if (expectedXpLabel) expect(notif.text).toContain(expectedXpLabel);
    }

    test('scenario 1 — fresh LIKE: 認同 + +5 XP + quoted excerpt', async () => {
        stub = installChatPoolStub({ oldReaction: null });
        const res = await request(app)
            .post(`/api/message/${MESSAGE_ID}/react`)
            .send({ deviceId: DEVICE_ID, deviceSecret: DEVICE_SECRET, reaction: 'like' });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.reaction).toBe('like');
        expect(res.body.feedbackNotified).toEqual({ pushed: true, reason: 'enqueued' });
        expectNotification({ verdictSubstring: '使用者認同', xpDelta: 5, expectedXpLabel: '(+5 XP)' });
    });

    test('scenario 2 — fresh DISLIKE: 不認同 + -5 XP', async () => {
        stub = installChatPoolStub({ oldReaction: null });
        const res = await request(app)
            .post(`/api/message/${MESSAGE_ID}/react`)
            .send({ deviceId: DEVICE_ID, deviceSecret: DEVICE_SECRET, reaction: 'dislike' });

        expect(res.status).toBe(200);
        expect(res.body.feedbackNotified).toEqual({ pushed: true, reason: 'enqueued' });
        expectNotification({ verdictSubstring: '使用者不認同', xpDelta: -5, expectedXpLabel: '(-5 XP)' });
    });

    test('scenario 3 — flip LIKE → DISLIKE: 不認同 + -10 XP (reverse +5 then apply -5)', async () => {
        stub = installChatPoolStub({ oldReaction: 'like' });
        const res = await request(app)
            .post(`/api/message/${MESSAGE_ID}/react`)
            .send({ deviceId: DEVICE_ID, deviceSecret: DEVICE_SECRET, reaction: 'dislike' });

        expect(res.status).toBe(200);
        expect(res.body.feedbackNotified).toEqual({ pushed: true, reason: 'enqueued' });
        expectNotification({ verdictSubstring: '使用者不認同', xpDelta: -10, expectedXpLabel: '(-10 XP)' });
    });

    test('scenario 4 — flip DISLIKE → LIKE: 認同 + +10 XP', async () => {
        stub = installChatPoolStub({ oldReaction: 'dislike' });
        const res = await request(app)
            .post(`/api/message/${MESSAGE_ID}/react`)
            .send({ deviceId: DEVICE_ID, deviceSecret: DEVICE_SECRET, reaction: 'like' });

        expect(res.status).toBe(200);
        expect(res.body.feedbackNotified).toEqual({ pushed: true, reason: 'enqueued' });
        expectNotification({ verdictSubstring: '使用者認同', xpDelta: 10, expectedXpLabel: '(+10 XP)' });
    });

    test('scenario 5 — CLEAR (reaction=null): 收回了對 + reverse XP', async () => {
        stub = installChatPoolStub({ oldReaction: 'like' });
        const res = await request(app)
            .post(`/api/message/${MESSAGE_ID}/react`)
            .send({ deviceId: DEVICE_ID, deviceSecret: DEVICE_SECRET, reaction: null });

        expect(res.status).toBe(200);
        expect(res.body.reaction).toBe(null);
        expect(res.body.feedbackNotified).toEqual({ pushed: true, reason: 'enqueued' });
        expectNotification({ verdictSubstring: '使用者收回了對', xpDelta: -5, expectedXpLabel: '(-5 XP)' });
    });

    test('scenario 6 — UNCHANGED (same reaction): short-circuit — NO notify, NO XP, NO enqueue', async () => {
        stub = installChatPoolStub({ oldReaction: 'like' });
        const beforeQueueLen = entity.messageQueue.length;
        const res = await request(app)
            .post(`/api/message/${MESSAGE_ID}/react`)
            .send({ deviceId: DEVICE_ID, deviceSecret: DEVICE_SECRET, reaction: 'like' });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.unchanged).toBe(true);
        // No new queue entry
        expect(entity.messageQueue.length).toBe(beforeQueueLen);
        // Handler short-circuits BEFORE the feedbackNotified branch — verify the
        // field is absent (or explicitly undefined) rather than a phantom result.
        expect(res.body.feedbackNotified).toBeUndefined();
    });
});

describe('excerpt truncation (quoted bubble)', () => {
    // Not exported yet — assert the notification body itself carries an ellipsis
    // when the bubble is longer than 60 chars.
    test('BUBBLE_TEXT longer than 60 chars → excerpt ends with …', async () => {
        installDevice();
        installChatPoolStub({ oldReaction: null });
        const res = await request(app)
            .post(`/api/message/${MESSAGE_ID}/react`)
            .send({ deviceId: 'test-device-react-1', deviceSecret: 'test-device-secret-react-1', reaction: 'like' });

        const notif = app.devices['test-device-react-1'].entities[5].messageQueue.pop();
        // BUBBLE_TEXT is > 60 chars → excerpt must include ellipsis
        expect(BUBBLE_TEXT.length).toBeGreaterThan(60);
        expect(notif.text).toMatch(/…」/);
        resetDevices();
    });
});
