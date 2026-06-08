/**
 * Channel Repair Log endpoint tests
 *
 * Covers GET /api/channel-repair-log (public read shape) and
 * POST /api/channel-repair-log auth chain + validation + secret-scrub.
 * pg Pool is mocked; queries are routed by SQL substring so ensureSchema()
 * bootstrap and the route handlers both resolve deterministically.
 */

let mockQuery;

jest.mock('pg', () => ({
    Pool: jest.fn().mockImplementation(() => ({
        query: (...args) => mockQuery(...args),
        connect: jest.fn(),
        end: jest.fn(),
    })),
}));

const express = require('express');
const request = require('supertest');

let app;

const SAMPLE_ROW = {
    id: 1,
    channel_type: 'openclaw-channel-eclaw',
    entity_refs: null,
    kind: 'fix',
    title: 'Sample',
    detail: 'Sample detail',
    status: 'mitigated',
    occurred_at: '2026-06-08T05:33:00.000Z',
    source: 'seed',
    pr_url: null,
};

beforeEach(() => {
    jest.resetModules();
    // SQL-aware mock: meta reports the current seed version (so reconcileSeed is a
    // no-op), GET returns one canned record + total, INSERT returns an id.
    mockQuery = jest.fn((sql) => {
        if (/FROM channel_repair_log_meta/i.test(sql)) return Promise.resolve({ rows: [{ v: '2' }] });
        if (/INSERT INTO channel_repair_log\b/i.test(sql)) return Promise.resolve({ rows: [{ id: 99 }] });
        if (/COUNT\(\*\)/i.test(sql)) return Promise.resolve({ rows: [{ c: 8 }] });
        if (/SELECT id, channel_type/i.test(sql)) return Promise.resolve({ rows: [SAMPLE_ROW] });
        return Promise.resolve({ rows: [] });
    });

    const mockDevices = {
        'dev1': {
            deviceSecret: 'sec1',
            entities: { 2: { isBound: true, botSecret: 'bot2-sec' } },
        },
    };

    app = express();
    const mod = require('../../channel-repair-log')(mockDevices);
    app.use('/api/channel-repair-log', mod.router);
});

describe('GET /api/channel-repair-log (public)', () => {
    it('returns records + channels metadata without auth', async () => {
        const res = await request(app).get('/api/channel-repair-log');
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(Array.isArray(res.body.records)).toBe(true);
        expect(Array.isArray(res.body.channels)).toBe(true);
        expect(res.body.channels.length).toBe(4);
        expect(res.body.records[0].channel_type).toBe('openclaw-channel-eclaw');
    });
});

describe('POST /api/channel-repair-log auth', () => {
    const base = { channel_type: 'openclaw-channel-eclaw', kind: 'fix', title: 'New record' };

    it('400 when deviceId missing', async () => {
        const res = await request(app).post('/api/channel-repair-log').send({ ...base });
        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
    });

    it('401 on wrong deviceSecret', async () => {
        const res = await request(app).post('/api/channel-repair-log')
            .send({ deviceId: 'dev1', deviceSecret: 'WRONG', ...base });
        expect(res.status).toBe(401);
    });

    it('200 with valid deviceSecret', async () => {
        const res = await request(app).post('/api/channel-repair-log')
            .send({ deviceId: 'dev1', deviceSecret: 'sec1', ...base });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.id).toBe(99);
    });

    it('200 with valid entityId + botSecret', async () => {
        const res = await request(app).post('/api/channel-repair-log')
            .send({ deviceId: 'dev1', entityId: 2, botSecret: 'bot2-sec', ...base });
        expect(res.status).toBe(200);
    });
});

describe('POST /api/channel-repair-log validation', () => {
    const auth = { deviceId: 'dev1', deviceSecret: 'sec1' };

    it('400 on invalid channel_type', async () => {
        const res = await request(app).post('/api/channel-repair-log')
            .send({ ...auth, channel_type: 'bogus', kind: 'fix', title: 'x' });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/channel_type/i);
    });

    it('400 on invalid kind', async () => {
        const res = await request(app).post('/api/channel-repair-log')
            .send({ ...auth, channel_type: 'codex-eclaw-bridge', kind: 'nope', title: 'x' });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/kind/i);
    });

    it('400 on missing title', async () => {
        const res = await request(app).post('/api/channel-repair-log')
            .send({ ...auth, channel_type: 'codex-eclaw-bridge', kind: 'fix', title: '  ' });
        expect(res.status).toBe(400);
    });

    it('400 on invalid status', async () => {
        const res = await request(app).post('/api/channel-repair-log')
            .send({ ...auth, channel_type: 'codex-eclaw-bridge', kind: 'fix', title: 'x', status: 'weird' });
        expect(res.status).toBe(400);
    });

    it('400 when detail looks like a secret', async () => {
        const res = await request(app).post('/api/channel-repair-log')
            .send({ ...auth, channel_type: 'codex-eclaw-bridge', kind: 'fix', title: 'x', detail: 'botSecret=944738a1eece' });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/secret/i);
    });

    it('400 on future occurred_at', async () => {
        const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
        const res = await request(app).post('/api/channel-repair-log')
            .send({ ...auth, channel_type: 'codex-eclaw-bridge', kind: 'fix', title: 'x', occurred_at: future });
        expect(res.status).toBe(400);
    });

    it('400 on non-github pr_url', async () => {
        const res = await request(app).post('/api/channel-repair-log')
            .send({ ...auth, channel_type: 'codex-eclaw-bridge', kind: 'fix', title: 'x', pr_url: 'https://evil.example.com/x' });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/pr_url/i);
    });

    it('200 with a valid github pr_url', async () => {
        const res = await request(app).post('/api/channel-repair-log')
            .send({ ...auth, channel_type: 'codex-eclaw-bridge', kind: 'fix', title: 'x', pr_url: 'https://github.com/HankHuang0516/EClaw/pull/3233' });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });
});

describe('internal helpers', () => {
    let internal;
    beforeEach(() => {
        const mod = require('../../channel-repair-log')({});
        internal = mod._internal;
    });

    it('looksLikeSecret flags credentials, passes clean text', () => {
        expect(internal.looksLikeSecret('here is a token: abc')).toBe(true);
        expect(internal.looksLikeSecret('deviceSecret leak')).toBe(true);
        expect(internal.looksLikeSecret('eck_abc123def')).toBe(true);
        expect(internal.looksLikeSecret('A normal repair note about cooldown')).toBe(false);
    });

    it('whitelists the four channel types and four kinds', () => {
        expect(internal.VALID_CHANNELS.size).toBe(4);
        expect(internal.VALID_KINDS.has('fix')).toBe(true);
        expect(internal.VALID_KINDS.has('bogus')).toBe(false);
    });

    it('channel metadata is user-facing (no internal entity refs)', () => {
        for (const ch of internal.CHANNELS) {
            expect(ch).toHaveProperty('summary');
            expect(ch).not.toHaveProperty('entities');
            expect(ch.summary).not.toMatch(/#\d|Mac_|project-[a-z]/);
        }
    });

    it('PR_URL_RE accepts github URLs and rejects others', () => {
        expect(internal.PR_URL_RE.test('https://github.com/HankHuang0516/EClaw/pull/3233')).toBe(true);
        expect(internal.PR_URL_RE.test('https://evil.example.com/x')).toBe(false);
        expect(internal.PR_URL_RE.test('http://github.com/x')).toBe(false);
        expect(internal.PR_URL_RE.test('https://github.com/a" onerror=x')).toBe(false);
    });
});
