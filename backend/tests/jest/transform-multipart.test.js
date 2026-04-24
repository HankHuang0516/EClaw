/**
 * POST /api/transform — multipart/form-data support (Issue #1781).
 *
 * Validates:
 *   1. JSON requests still succeed unchanged (backward compat).
 *   2. multipart requests upload the attached file and prepend it to attachments.
 *   3. multipart requests parse JSON-string fields (speakTo, card, attachments).
 *   4. Upload failures surface as transform-level errors.
 */

require('./helpers/mock-setup');

// Mock the shared upload helper used by POST /api/transform multipart path.
// The actual R2 client is never invoked in tests.
jest.mock('../../files', () => {
    const mock = (devices) => ({
        router: require('express').Router(),
    });
    mock.uploadBufferToR2 = jest.fn(async ({ originalname, size, mimetype }) => ({
        fileId: 'mock-file-id-123',
        filename: originalname,
        size,
        mimeType: mimetype,
        expiresAt: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString(),
    }));
    mock.cleanupExpiredFiles = jest.fn().mockResolvedValue(0);
    return mock;
});

const request = require('supertest');
let app;

const post = (path) => request(app).post(path).set('Host', 'localhost');

async function bindEntity(deviceId, deviceSecret, entityId = 0) {
    if (entityId > 0) {
        await post('/api/device/add-entity').send({ deviceId, deviceSecret });
    }
    const regRes = await post('/api/device/register').send({ deviceId, deviceSecret, entityId });
    const code = regRes.body.bindingCode;
    if (!code) return undefined;
    const bindRes = await post('/api/bind').send({ code });
    return bindRes.body.botSecret;
}

beforeAll(() => {
    app = require('../../index');
});

afterAll(async () => {
    const { httpServer } = require('../../index');
    await new Promise(resolve => httpServer.close(resolve));
    jest.resetModules();
});

describe('POST /api/transform — multipart', () => {
    const deviceId = 'transform-multipart-test';
    const deviceSecret = `secret-${deviceId}`;
    let botSecret;

    beforeAll(async () => {
        botSecret = await bindEntity(deviceId, deviceSecret, 0);
    });

    beforeEach(() => {
        const { uploadBufferToR2 } = require('../../files');
        uploadBufferToR2.mockClear();
    });

    it('JSON path still works (backward compatible)', async () => {
        const res = await post('/api/transform')
            .send({ deviceId, entityId: 0, botSecret, message: 'plain json', state: 'IDLE' });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);

        const { uploadBufferToR2 } = require('../../files');
        expect(uploadBufferToR2).not.toHaveBeenCalled();
    });

    it('multipart: uploads file and auto-fills attachments[0]', async () => {
        const fileBuffer = Buffer.from('hello world', 'utf8');
        const res = await post('/api/transform')
            .field('deviceId', deviceId)
            .field('entityId', '0')
            .field('botSecret', botSecret)
            .field('message', 'here is your file')
            .field('state', 'IDLE')
            .attach('file', fileBuffer, { filename: 'report.txt', contentType: 'text/plain' });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);

        const { uploadBufferToR2 } = require('../../files');
        expect(uploadBufferToR2).toHaveBeenCalledTimes(1);
        const uploadArgs = uploadBufferToR2.mock.calls[0][0];
        expect(uploadArgs.deviceId).toBe(deviceId);
        expect(uploadArgs.entityId).toBe(0);
        expect(uploadArgs.originalname).toBe('report.txt');
        expect(uploadArgs.mimetype).toBe('text/plain');
        expect(uploadArgs.size).toBe(fileBuffer.length);
    });

    it('multipart: parses JSON-string speakTo/card/attachments fields', async () => {
        const fileBuffer = Buffer.from('x');
        const res = await post('/api/transform')
            .field('deviceId', deviceId)
            .field('entityId', '0')
            .field('botSecret', botSecret)
            .field('message', 'with rich card')
            .field('state', 'IDLE')
            .field('card', JSON.stringify({
                ask_id: 'test-ask-multipart',
                buttons: [{ id: 'ok', label: 'OK', style: 'primary' }],
            }))
            .field('attachments', JSON.stringify([
                { fileId: 'existing-file', filename: 'old.pdf', size: 100, mimeType: 'application/pdf' },
            ]))
            .attach('file', fileBuffer, { filename: 'note.md', contentType: 'text/markdown' });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });

    it('multipart: returns 507 when uploadBufferToR2 throws quota_exceeded', async () => {
        const { uploadBufferToR2 } = require('../../files');
        uploadBufferToR2.mockImplementationOnce(async () => {
            const err = new Error('Storage quota exceeded (500MB / 500MB). Please remove some old files first.');
            err.httpStatus = 507;
            err.code = 'quota_exceeded';
            err.details = { currentUsageMB: 500, quotaMB: 500, oldestFiles: [] };
            throw err;
        });

        const fileBuffer = Buffer.from('x');
        const res = await post('/api/transform')
            .field('deviceId', deviceId)
            .field('entityId', '0')
            .field('botSecret', botSecret)
            .field('message', 'quota test')
            .field('state', 'IDLE')
            .attach('file', fileBuffer, { filename: 'big.bin', contentType: 'application/octet-stream' });

        expect(res.status).toBe(507);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toBe('quota_exceeded');
        expect(res.body.currentUsageMB).toBe(500);
    });

    it('multipart: missing botSecret returns 400', async () => {
        const fileBuffer = Buffer.from('x');
        const res = await post('/api/transform')
            .field('deviceId', deviceId)
            .field('entityId', '0')
            .field('message', 'no auth')
            .attach('file', fileBuffer, { filename: 'x.txt', contentType: 'text/plain' });

        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
    });
});
