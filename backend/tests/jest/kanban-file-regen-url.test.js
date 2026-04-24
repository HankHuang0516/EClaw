/**
 * Kanban card file — regenerate R2 signed URL on every read.
 *
 * Contract pinned by these tests:
 *   1. POST /card/:id/file with {fileId} hydrates metadata from r2_files
 *      and persists file_id (stored url is opaque `r2:<fileId>` cache).
 *   2. POST with {fileId} that doesn't exist → 404.
 *   3. Legacy POST with {url, filename} (no fileId) still works unchanged.
 *   4. GET /card/:id/files returns a freshly-signed URL for rows that have
 *      file_id; rows with only a stored url return it as-is.
 */

const mockQuery = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });

jest.mock('pg', () => ({
    Pool: jest.fn().mockImplementation(() => ({
        query: mockQuery,
        connect: jest.fn().mockResolvedValue({
            query: jest.fn().mockResolvedValue({ rows: [] }),
            release: jest.fn(),
        }),
        end: jest.fn().mockResolvedValue(undefined),
    })),
}));
jest.mock('../../safe-equal', () => (a, b) => a === b);

// Deterministic signed-URL stub so tests can assert regeneration without
// hitting AWS. Each call appends a monotonically increasing counter so we can
// prove the URL is freshly computed on every read.
jest.mock('@aws-sdk/s3-request-presigner', () => {
    let _count = 0;
    return {
        __getSignCallCount: () => _count,
        __resetSignCallCount: () => { _count = 0; },
        getSignedUrl: jest.fn(async () => {
            _count += 1;
            return `https://r2.example.test/fresh?sig=${_count}`;
        }),
    };
});
const presigner = require('@aws-sdk/s3-request-presigner');
const signCallCount = () => presigner.__getSignCallCount();

const express = require('express');
const request = require('supertest');

let app;

beforeAll(() => {
    app = express();
    app.use(express.json());

    const mockDevices = {
        'test-dev': {
            deviceSecret: 'test-secret',
            entities: {
                2: { isBound: true, botSecret: 'bot-sec-2', character: 'Bot2' },
            },
        },
    };

    const kanbanModule = require('../../kanban')(mockDevices, {});
    app.use('/api/mission', kanbanModule.router);
});

beforeEach(() => {
    mockQuery.mockReset();
    presigner.__resetSignCallCount();
});

const AUTH = { deviceId: 'test-dev', deviceSecret: 'test-secret', entityId: 2 };
const post = (p) => request(app).post(p);
const get = (p) => request(app).get(p);

// ════════════════════════════════════════════════════════════════
// POST /card/:id/file — fileId path
// ════════════════════════════════════════════════════════════════
describe('POST /card/:id/file with fileId', () => {
    it('hydrates metadata from r2_files and persists file_id', async () => {
        // 1) r2_files lookup
        mockQuery.mockResolvedValueOnce({
            rows: [{ filename: 'before.png', mime_type: 'image/png', size: 12345 }],
        });
        // 2) card existence check
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 'card_abc' }] });
        // 3) INSERT INTO kanban_files
        mockQuery.mockResolvedValueOnce({
            rows: [{
                id: 'f1',
                file_id: 'file-xyz',
                filename: 'before.png',
                url: 'r2:file-xyz',
                mime_type: 'image/png',
                file_size: 12345,
                uploaded_by: 2,
                device_id: 'test-dev',
                created_at: new Date(),
            }],
        });
        // 4) bump card updated_at
        mockQuery.mockResolvedValueOnce({ rows: [] });
        // 5) mapCardFileRow → signCardFileUrl → r2_files lookup for fresh URL
        mockQuery.mockResolvedValueOnce({
            rows: [{ r2_key: 'files/test-dev/file-xyz/before.png', filename: 'before.png', mime_type: 'image/png' }],
        });

        const res = await post('/api/mission/card/card_abc/file')
            .send({ ...AUTH, fileId: 'file-xyz' });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.file.fileId).toBe('file-xyz');
        expect(res.body.file.filename).toBe('before.png');
        expect(res.body.file.mimeType).toBe('image/png');
        expect(res.body.file.fileSize).toBe(12345);
        // URL is the freshly-signed one, not the opaque `r2:<fileId>` cache.
        expect(res.body.file.url).toMatch(/^https:\/\/r2\.example\.test\/fresh\?sig=/);
        expect(res.body.file.url).not.toContain('r2:');

        // INSERT received file_id as the 8th param.
        const insertCall = mockQuery.mock.calls.find(c => /INSERT INTO kanban_files/.test(c[0]));
        expect(insertCall[1][7]).toBe('file-xyz');
    });

    it('rejects fileId that is not in r2_files (404)', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [] }); // no r2_files row

        const res = await post('/api/mission/card/card_abc/file')
            .send({ ...AUTH, fileId: 'missing-id' });

        expect(res.status).toBe(404);
        expect(res.body.error).toMatch(/fileId/i);
    });
});

// ════════════════════════════════════════════════════════════════
// Legacy path — POST with only {url, filename} still accepted
// ════════════════════════════════════════════════════════════════
describe('POST /card/:id/file legacy path', () => {
    it('accepts a raw url without fileId and stores file_id NULL', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 'card_abc' }] });
        mockQuery.mockResolvedValueOnce({
            rows: [{
                id: 'f2',
                file_id: null,
                filename: 'legacy.png',
                url: 'https://external.example/legacy.png',
                mime_type: 'image/png',
                file_size: null,
                uploaded_by: 2,
                device_id: 'test-dev',
                created_at: new Date(),
            }],
        });
        mockQuery.mockResolvedValueOnce({ rows: [] });

        const res = await post('/api/mission/card/card_abc/file')
            .send({ ...AUTH, filename: 'legacy.png', url: 'https://external.example/legacy.png', mimeType: 'image/png' });

        expect(res.status).toBe(200);
        expect(res.body.file.fileId).toBeNull();
        // Legacy row: URL passes through unchanged, never re-signed.
        expect(res.body.file.url).toBe('https://external.example/legacy.png');
        expect(signCallCount()).toBe(0);
    });
});

// ════════════════════════════════════════════════════════════════
// GET /card/:id/files — fresh URL per read
// ════════════════════════════════════════════════════════════════
describe('GET /card/:id/files regeneration', () => {
    it('regenerates signed URL for rows with file_id; passes through for legacy rows', async () => {
        // card existence
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 'card_abc' }] });
        // kanban_files rows
        mockQuery.mockResolvedValueOnce({
            rows: [
                {
                    id: 'f1', file_id: 'file-xyz', filename: 'a.png',
                    url: 'r2:file-xyz', mime_type: 'image/png',
                    file_size: 1, uploaded_by: 2, device_id: 'test-dev',
                    created_at: new Date(),
                },
                {
                    id: 'f2', file_id: null, filename: 'legacy.png',
                    url: 'https://external.example/legacy.png',
                    mime_type: 'image/png', file_size: 2, uploaded_by: 2,
                    device_id: 'test-dev', created_at: new Date(),
                },
            ],
        });
        // r2_files lookup for f1 fresh URL
        mockQuery.mockResolvedValueOnce({
            rows: [{ r2_key: 'files/test-dev/file-xyz/a.png', filename: 'a.png', mime_type: 'image/png' }],
        });

        const res = await get('/api/mission/card/card_abc/files')
            .query(AUTH);

        expect(res.status).toBe(200);
        expect(res.body.files).toHaveLength(2);
        // file_id row → freshly signed URL
        expect(res.body.files[0].fileId).toBe('file-xyz');
        expect(res.body.files[0].url).toMatch(/^https:\/\/r2\.example\.test\/fresh\?sig=/);
        // legacy row → url passes through
        expect(res.body.files[1].fileId).toBeNull();
        expect(res.body.files[1].url).toBe('https://external.example/legacy.png');
        // Only one sign call — not wasted on legacy row.
        expect(signCallCount()).toBe(1);
    });

    it('two reads of the same card produce two distinct fresh URLs', async () => {
        const cardRow = { rows: [{ id: 'card_abc' }] };
        const filesRow = {
            rows: [{
                id: 'f1', file_id: 'file-xyz', filename: 'a.png',
                url: 'r2:file-xyz', mime_type: 'image/png',
                file_size: 1, uploaded_by: 2, device_id: 'test-dev',
                created_at: new Date(),
            }],
        };
        const r2Row = {
            rows: [{ r2_key: 'files/test-dev/file-xyz/a.png', filename: 'a.png', mime_type: 'image/png' }],
        };

        // First GET
        mockQuery.mockResolvedValueOnce(cardRow);
        mockQuery.mockResolvedValueOnce(filesRow);
        mockQuery.mockResolvedValueOnce(r2Row);
        const res1 = await get('/api/mission/card/card_abc/files').query(AUTH);

        // Second GET
        mockQuery.mockResolvedValueOnce(cardRow);
        mockQuery.mockResolvedValueOnce(filesRow);
        mockQuery.mockResolvedValueOnce(r2Row);
        const res2 = await get('/api/mission/card/card_abc/files').query(AUTH);

        expect(res1.body.files[0].url).not.toBe(res2.body.files[0].url);
    });
});
