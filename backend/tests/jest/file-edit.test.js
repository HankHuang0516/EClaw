/**
 * Jest test: GET /api/files/:fileId/content + PUT /api/files/:fileId
 * Validates ownership enforcement, text-extension whitelist, size limit,
 * and happy path for the Monaco online editor backend.
 */

const mockQuery = jest.fn();
const mockR2Send = jest.fn();

jest.mock('pg', () => {
    const Pool = jest.fn().mockImplementation(() => ({
        query: mockQuery,
        connect: jest.fn(),
        end: jest.fn(),
    }));
    return { Pool };
});

jest.mock('@aws-sdk/client-s3', () => ({
    S3Client: jest.fn().mockImplementation(() => ({ send: mockR2Send })),
    GetObjectCommand: jest.fn().mockImplementation((p) => ({ __cmd: 'Get', ...p })),
    PutObjectCommand: jest.fn().mockImplementation((p) => ({ __cmd: 'Put', ...p })),
    DeleteObjectCommand: jest.fn().mockImplementation((p) => ({ __cmd: 'Delete', ...p })),
}));

jest.mock('@aws-sdk/s3-request-presigner', () => ({
    getSignedUrl: jest.fn().mockResolvedValue('https://signed.example/url'),
}));

const express = require('express');
const request = require('supertest');

const OWNER = 'owner-device';
const OWNER_SECRET = 'owner-secret';
const ATTACKER = 'attacker-device';
const ATTACKER_SECRET = 'attacker-secret';

const devices = {
    [OWNER]: { deviceSecret: OWNER_SECRET, entities: {} },
    [ATTACKER]: { deviceSecret: ATTACKER_SECRET, entities: {} },
};

const buildApp = () => {
    const app = express();
    app.use(express.json());
    const filesModule = require('../../files')(devices);
    app.use('/api/files', filesModule.router);
    return app;
};

const fileRow = (overrides = {}) => ({
    file_id: 'file-1',
    device_id: OWNER,
    entity_id: null,
    filename: 'notes.md',
    size: 42,
    mime_type: 'text/markdown',
    r2_key: `files/${OWNER}/file-1/notes.md`,
    created_at: new Date(),
    expires_at: new Date(Date.now() + 86400000),
    ...overrides,
});

beforeEach(() => {
    mockQuery.mockReset();
    mockR2Send.mockReset();
    // initFilesTable() runs CREATE TABLE on require — swallow it.
    mockQuery.mockResolvedValueOnce({ rows: [] });
});

describe('GET /api/files/:fileId/content', () => {
    test('rejects missing credentials', async () => {
        const app = buildApp();
        const res = await request(app).get('/api/files/file-1/content');
        expect(res.status).toBe(401);
    });

    test('rejects when another device tries to read', async () => {
        const app = buildApp();
        // Ownership filter (device_id = $2) returns no rows for the attacker.
        mockQuery.mockResolvedValueOnce({ rows: [] });
        const res = await request(app)
            .get(`/api/files/file-1/content?deviceId=${ATTACKER}&deviceSecret=${ATTACKER_SECRET}`);
        expect(res.status).toBe(404);
    });

    test('refuses binary file extension (415)', async () => {
        const app = buildApp();
        mockQuery.mockResolvedValueOnce({ rows: [fileRow({ filename: 'photo.png' })] });
        const res = await request(app)
            .get(`/api/files/file-1/content?deviceId=${OWNER}&deviceSecret=${OWNER_SECRET}`);
        expect(res.status).toBe(415);
        expect(res.body.error).toBe('binary_file');
    });

    test('refuses files >512KB (413)', async () => {
        const app = buildApp();
        mockQuery.mockResolvedValueOnce({ rows: [fileRow({ size: 600 * 1024 })] });
        const res = await request(app)
            .get(`/api/files/file-1/content?deviceId=${OWNER}&deviceSecret=${OWNER_SECRET}`);
        expect(res.status).toBe(413);
        expect(res.body.error).toBe('too_large');
    });

    test('happy path returns text/plain body', async () => {
        const app = buildApp();
        mockQuery.mockResolvedValueOnce({ rows: [fileRow()] });
        // R2 GetObject returns an async-iterable Body
        mockR2Send.mockResolvedValueOnce({
            Body: (async function* () { yield Buffer.from('# hello\nworld', 'utf8'); })(),
        });
        const res = await request(app)
            .get(`/api/files/file-1/content?deviceId=${OWNER}&deviceSecret=${OWNER_SECRET}`);
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/text\/plain/);
        expect(res.text).toBe('# hello\nworld');
    });
});

describe('PUT /api/files/:fileId', () => {
    test('rejects missing credentials', async () => {
        const app = buildApp();
        const res = await request(app)
            .put('/api/files/file-1')
            .set('Content-Type', 'text/plain')
            .send('hello');
        expect(res.status).toBe(401);
    });

    test('rejects cross-device write', async () => {
        const app = buildApp();
        mockQuery.mockResolvedValueOnce({ rows: [] }); // ownership lookup fails
        const res = await request(app)
            .put(`/api/files/file-1?deviceId=${ATTACKER}&deviceSecret=${ATTACKER_SECRET}`)
            .set('Content-Type', 'text/plain')
            .send('pwn');
        expect(res.status).toBe(404);
    });

    test('refuses binary extension server-side', async () => {
        const app = buildApp();
        mockQuery.mockResolvedValueOnce({ rows: [fileRow({ filename: 'evil.exe' })] });
        const res = await request(app)
            .put(`/api/files/file-1?deviceId=${OWNER}&deviceSecret=${OWNER_SECRET}`)
            .set('Content-Type', 'text/plain')
            .send('payload');
        expect(res.status).toBe(415);
        expect(res.body.error).toBe('binary_file');
    });

    test('refuses payload >512KB', async () => {
        const app = buildApp();
        mockQuery.mockResolvedValueOnce({ rows: [fileRow()] });
        const big = 'a'.repeat(513 * 1024);
        const res = await request(app)
            .put(`/api/files/file-1?deviceId=${OWNER}&deviceSecret=${OWNER_SECRET}`)
            .set('Content-Type', 'text/plain')
            .send(big);
        expect(res.status).toBe(413);
        expect(res.body.error).toBe('too_large');
    });

    test('happy path text/plain writes to R2 and updates size', async () => {
        const app = buildApp();
        mockQuery.mockResolvedValueOnce({ rows: [fileRow()] }); // ownership lookup
        mockR2Send.mockResolvedValueOnce({}); // PutObject
        mockQuery.mockResolvedValueOnce({ rows: [] }); // UPDATE size
        const body = '# updated\nbody';
        const res = await request(app)
            .put(`/api/files/file-1?deviceId=${OWNER}&deviceSecret=${OWNER_SECRET}`)
            .set('Content-Type', 'text/plain')
            .send(body);
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.size).toBe(Buffer.byteLength(body, 'utf8'));
        expect(res.body.updatedAt).toBeTruthy();
        expect(mockR2Send).toHaveBeenCalledTimes(1);
        const putCmd = mockR2Send.mock.calls[0][0];
        expect(putCmd.__cmd).toBe('Put');
        expect(putCmd.Key).toBe(`files/${OWNER}/file-1/notes.md`);
    });

    test('happy path JSON {content} body', async () => {
        const app = buildApp();
        mockQuery.mockResolvedValueOnce({ rows: [fileRow()] });
        mockR2Send.mockResolvedValueOnce({});
        mockQuery.mockResolvedValueOnce({ rows: [] });
        const res = await request(app)
            .put(`/api/files/file-1?deviceId=${OWNER}&deviceSecret=${OWNER_SECRET}`)
            .set('Content-Type', 'application/json')
            .send({ content: 'hi' });
        expect(res.status).toBe(200);
        expect(res.body.size).toBe(2);
    });

    test('rejects unsupported content-type', async () => {
        const app = buildApp();
        mockQuery.mockResolvedValueOnce({ rows: [fileRow()] });
        const res = await request(app)
            .put(`/api/files/file-1?deviceId=${OWNER}&deviceSecret=${OWNER_SECRET}`)
            .set('Content-Type', 'application/octet-stream')
            .send('binary-ish');
        expect(res.status).toBe(415);
    });
});
