/**
 * Note Page form submission → owner notification tests.
 *
 * Regression coverage for the bug where POST /api/mission/note/page/form-submit
 * notified the owning entity through an internal HTTP call to /api/transform
 * with `botSecret: null`. /api/transform rejects that with HTTP 400
 * ("botSecret required") and the rejection was swallowed, so the owner was
 * never notified.
 *
 * The fix delivers in-process through the same push callbacks used by
 * POST /api/mission/notify (channel callback for channel-bound entities,
 * pushToBot for the rest).
 */

// ── pg mock ────────────────────────────────────────────────────────────────
const mockPoolQuery = jest.fn();

jest.mock('pg', () => ({
    Pool: jest.fn().mockImplementation(() => ({
        query: mockPoolQuery,
        connect: jest.fn().mockResolvedValue({
            query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
            release: jest.fn(),
        }),
        end: jest.fn().mockResolvedValue(undefined),
    })),
}));

const express = require('express');
const request = require('supertest');

// ── fixtures ───────────────────────────────────────────────────────────────
const DEVICE_ID = 'test-device';
const PUBLIC_CODE = 'testpub';
const ENTITY_ID = 3;

const mockDevices = {
    [DEVICE_ID]: {
        deviceSecret: 'test-secret',
        entities: {
            0: { isBound: true, botSecret: 'bot-sec-0', character: 'Root', webhook: { type: 'webhook', url: 'https://example.com/hook' } },
            [ENTITY_ID]: {
                isBound: true,
                botSecret: 'bot-sec-3',
                character: 'NoteOwner',
                publicCode: PUBLIC_CODE,
                bindingType: 'device',
                webhook: { type: 'webhook', url: 'https://example.com/owner' },
            },
        },
    },
};

let missionApp;
let missionModule;
let pushToBotMock;
let pushToChannelMock;

beforeAll(() => {
    missionApp = express();
    missionApp.use(express.json());

    missionModule = require('../../mission')(mockDevices, {});

    pushToBotMock = jest.fn().mockResolvedValue({ pushed: true });
    pushToChannelMock = jest.fn().mockResolvedValue({ pushed: true });
    missionModule.setPushToBot(pushToBotMock);
    missionModule.setPushToChannelCallback(pushToChannelMock);

    missionApp.use('/api/mission', missionModule.router);
});

beforeEach(() => {
    jest.clearAllMocks();
    mockPoolQuery.mockImplementation(async (sql) => {
        const text = String(sql);
        if (text.includes('FROM form_submissions')) {
            return { rows: [{ cnt: 0 }], rowCount: 1 };
        }
        if (text.includes('INSERT INTO form_submissions')) {
            return { rows: [{ id: 42, created_at: '2026-10-23T00:00:00.000Z' }], rowCount: 1 };
        }
        if (text.includes('INSERT INTO chat_messages')) {
            return { rows: [{ id: 900 }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
    });
});

const post = (path) => request(missionApp).post(path);

// ═══════════════════════════════════════════════════════════════════════════
// Submission storage
// ═══════════════════════════════════════════════════════════════════════════
describe('form submission storage', () => {
    it('stores the submission and returns a submission id', async () => {
        const res = await post('/api/mission/note/page/form-submit').send({
            publicCode: PUBLIC_CODE,
            noteId: 'GAME-093',
            formData: { e: 'play', g: 'GAME-093', s: 42 },
        });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.submissionId).toBe(42);

        const insertCall = mockPoolQuery.mock.calls.find(([sql]) =>
            String(sql).includes('INSERT INTO form_submissions'));
        expect(insertCall).toBeDefined();
        expect(insertCall[1]).toEqual(expect.arrayContaining([DEVICE_ID, 'GAME-093', PUBLIC_CODE]));
    });

    it('returns 404 when the publicCode is unknown', async () => {
        const res = await post('/api/mission/note/page/form-submit').send({
            publicCode: 'does-not-exist',
            noteId: 'GAME-093',
            formData: { e: 'report' },
        });

        expect(res.status).toBe(404);
        expect(pushToBotMock).not.toHaveBeenCalled();
    });

    it('rejects missing fields', async () => {
        const res = await post('/api/mission/note/page/form-submit').send({ publicCode: PUBLIC_CODE });
        expect(res.status).toBe(400);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// Notification delivery (the regression)
// ═══════════════════════════════════════════════════════════════════════════
describe('form submission notification', () => {
    it('pushes a notification to the owning entity for a player report', async () => {
        const res = await post('/api/mission/note/page/form-submit').send({
            publicCode: PUBLIC_CODE,
            noteId: 'GAME-093',
            formData: { e: 'report', g: 'GAME-093', msg: '關卡 3 的龍捲風判定錯誤' },
        });
        expect(res.status).toBe(200);

        // allow the fire-and-forget delivery to settle
        await new Promise((r) => setTimeout(r, 20));

        expect(pushToBotMock).toHaveBeenCalledTimes(1);
        const [entity, deviceId, eventType, payload] = pushToBotMock.mock.calls[0];
        expect(deviceId).toBe(DEVICE_ID);
        expect(eventType).toBe('form_submission');
        expect(entity.publicCode).toBe(PUBLIC_CODE);
        expect(payload.message).toContain('新表單提交');
        expect(payload.message).toContain('GAME-093');
        expect(payload.message).toContain('關卡 3 的龍捲風判定錯誤');
    });

    it('pushes a notification for a player error report', async () => {
        await post('/api/mission/note/page/form-submit').send({
            publicCode: PUBLIC_CODE,
            noteId: 'GAME-093',
            formData: { e: 'error', g: 'GAME-093', msg: 'boom' },
        });
        await new Promise((r) => setTimeout(r, 20));

        expect(pushToBotMock).toHaveBeenCalledTimes(1);
        expect(pushToBotMock.mock.calls[0][2]).toBe('form_submission');
    });

    it('does NOT push a notification for analytics-only play events', async () => {
        const res = await post('/api/mission/note/page/form-submit').send({
            publicCode: PUBLIC_CODE,
            noteId: 'GAME-093',
            formData: { e: 'play', g: 'GAME-093', s: 42 },
        });
        expect(res.status).toBe(200);

        await new Promise((r) => setTimeout(r, 20));

        expect(pushToBotMock).not.toHaveBeenCalled();
        expect(pushToChannelMock).not.toHaveBeenCalled();
    });

    it('persists the notification into chat_messages with source form_submission', async () => {
        await post('/api/mission/note/page/form-submit').send({
            publicCode: PUBLIC_CODE,
            noteId: 'GAME-093',
            formData: { e: 'report', g: 'GAME-093', msg: 'hello' },
        });
        await new Promise((r) => setTimeout(r, 20));

        const chatCall = mockPoolQuery.mock.calls.find(([sql]) =>
            String(sql).includes('INSERT INTO chat_messages'));
        expect(chatCall).toBeDefined();
        expect(chatCall[1][3]).toBe('form_submission');
        expect(chatCall[1][2]).toContain('新表單提交');
    });

    it('truncates oversized form values', async () => {
        const longText = 'x'.repeat(5000);
        await post('/api/mission/note/page/form-submit').send({
            publicCode: PUBLIC_CODE,
            noteId: 'GAME-093',
            formData: { e: 'report', msg: longText },
        });
        await new Promise((r) => setTimeout(r, 20));

        const payload = pushToBotMock.mock.calls[0][3];
        expect(payload.message.length).toBeLessThan(4000);
        expect(payload.message).not.toContain(longText);
    });

    it('uses the channel callback for channel-bound entities', async () => {
        mockDevices[DEVICE_ID].entities[ENTITY_ID].bindingType = 'channel';
        mockDevices[DEVICE_ID].entities[ENTITY_ID].channelAccountId = 'chan-1';

        await post('/api/mission/note/page/form-submit').send({
            publicCode: PUBLIC_CODE,
            noteId: 'GAME-093',
            formData: { e: 'report', msg: 'channel bound' },
        });
        await new Promise((r) => setTimeout(r, 20));

        expect(pushToChannelMock).toHaveBeenCalledTimes(1);
        expect(pushToBotMock).not.toHaveBeenCalled();

        mockDevices[DEVICE_ID].entities[ENTITY_ID].bindingType = 'device';
    });

    it('does not fail the submission when delivery fails', async () => {
        pushToBotMock.mockRejectedValueOnce(new Error('webhook down'));

        const res = await post('/api/mission/note/page/form-submit').send({
            publicCode: PUBLIC_CODE,
            noteId: 'GAME-093',
            formData: { e: 'report', msg: 'boom' },
        });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        await new Promise((r) => setTimeout(r, 20));
    });
});
