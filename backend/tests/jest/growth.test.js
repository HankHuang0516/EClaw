/**
 * Growth Metrics endpoint tests
 *
 * Covers GET /api/growth/daily auth chain + aggregation contract.
 * pg Pool is mocked; queries are intercepted to return canned rows so we
 * verify the route's handling of each branch (signups, retention, plaza).
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
const fs = require('fs');
const path = require('path');

let app;
let growthModule;

beforeEach(() => {
    jest.resetModules();
    mockQuery = jest.fn();

    app = express();
    app.use(express.json());

    const mockDevices = {
        'admin-dev': {
            deviceSecret: 'sec',
            entities: {
                2: { isBound: true, botSecret: 'admin-bot-sec', character: 'A' },
            },
        },
        'user-dev': {
            deviceSecret: 'sec2',
            entities: {
                2: { isBound: true, botSecret: 'user-bot-sec', character: 'U' },
            },
        },
        'unknown-dev': {
            deviceSecret: 'sec3',
            entities: {
                2: { isBound: true, botSecret: 'orphan-bot-sec', character: 'O' },
            },
        },
    };

    growthModule = require('../../growth')(mockDevices);
    app.use('/api/growth', growthModule.router);

    // clear rate buckets between tests
    growthModule._internal.rateBuckets.clear();
});

const get = (qs) => request(app).get('/api/growth/daily' + qs);

function setupAdminQueries({
    signups = 5, cohort = 10, active = 4, plaza = 2,
    total_codes = 0, redeemed_codes = 0,
    sourceRows,
} = {}) {
    const finalSourceRows = sourceRows || [{ source: 'web_portal', count: signups }];
    // is_admin lookup → 5 metric queries (parallel order: signups, retention, plaza, invite, source_channel)
    mockQuery
        .mockResolvedValueOnce({ rows: [{ is_admin: true }] })
        .mockResolvedValueOnce({ rows: [{ c: signups }] })
        .mockResolvedValueOnce({ rows: [{ cohort_size: cohort, active_size: active }] })
        .mockResolvedValueOnce({ rows: [{ c: plaza }] })
        .mockResolvedValueOnce({ rows: [{ total_codes, redeemed_codes }] })
        .mockResolvedValueOnce({ rows: finalSourceRows });
}

describe('Growth /daily auth', () => {
    it('rejects missing query params (400)', async () => {
        const res = await get('?deviceId=admin-dev');
        expect(res.status).toBe(400);
    });

    it('rejects invalid botSecret (401)', async () => {
        const res = await get('?deviceId=admin-dev&botSecret=wrong&entityId=2');
        expect(res.status).toBe(401);
    });

    it('rejects unknown deviceId (401)', async () => {
        const res = await get('?deviceId=ghost&botSecret=admin-bot-sec&entityId=2');
        expect(res.status).toBe(401);
    });

    it('rejects when owner is not admin (403)', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ is_admin: false }] });
        const res = await get('?deviceId=user-dev&botSecret=user-bot-sec&entityId=2');
        expect(res.status).toBe(403);
    });

    it('rejects when no user_account row matches deviceId (403)', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [] });
        const res = await get('?deviceId=unknown-dev&botSecret=orphan-bot-sec&entityId=2');
        expect(res.status).toBe(403);
    });
});

describe('Growth /daily aggregation contract', () => {
    it('returns the 5 metrics + date + follow-ups list', async () => {
        setupAdminQueries({
            signups: 7, cohort: 20, active: 8, plaza: 3, total_codes: 50, redeemed_codes: 11,
            sourceRows: [{ source: 'invite', count: 4 }, { source: 'web_portal', count: 3 }],
        });
        const res = await get('?deviceId=admin-dev&botSecret=admin-bot-sec&entityId=2');
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.today_signups).toBe(7);
        expect(res.body.source_channel).toEqual([{ source: 'invite', count: 4 }, { source: 'web_portal', count: 3 }]);
        expect(res.body.retention_7d).toEqual({ cohort_size: 20, active_size: 8, pct: 40 });
        expect(res.body.plaza_new_listed_today).toBe(3);
        expect(res.body.invite_conversion).toEqual({ total_codes: 50, redeemed_codes: 11, pct: 22 });
        expect(res.body.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(Array.isArray(res.body.follow_ups)).toBe(true);
        expect(res.body.follow_ups.length).toBe(3);
        expect(res.body.follow_ups.some(s => /schema lacks signup_source/i.test(s))).toBe(false);
        expect(res.body.follow_ups.some(s => /invite_conversion.*cumulative/i.test(s))).toBe(true);
    });

    it('source_channel SQL groups by signup_source without leaking user rows', async () => {
        setupAdminQueries({
            signups: 6,
            sourceRows: [{ source: 'utm:twitter', count: 4 }, { source: 'unknown', count: 2 }],
        });
        const res = await get('?deviceId=admin-dev&botSecret=admin-bot-sec&entityId=2&date=2026-04-17');
        expect(res.status).toBe(200);
        expect(res.body.source_channel).toEqual([{ source: 'utm:twitter', count: 4 }, { source: 'unknown', count: 2 }]);

        const sourceCall = mockQuery.mock.calls.find(c => /signup_source/i.test(c[0]) && /GROUP BY 1/i.test(c[0]));
        expect(sourceCall).toBeDefined();
        expect(sourceCall[1]).toEqual(['Asia/Taipei', '2026-04-17']);
        expect(sourceCall[0]).not.toMatch(/email|device_id|ip/i);
    });

    it('reports invite_conversion pct as null when no codes issued', async () => {
        setupAdminQueries({ total_codes: 0, redeemed_codes: 0 });
        const res = await get('?deviceId=admin-dev&botSecret=admin-bot-sec&entityId=2');
        expect(res.status).toBe(200);
        expect(res.body.invite_conversion).toEqual({ total_codes: 0, redeemed_codes: 0, pct: null });
    });

    it('rounds invite_conversion pct to one decimal', async () => {
        setupAdminQueries({ total_codes: 3, redeemed_codes: 1 });
        const res = await get('?deviceId=admin-dev&botSecret=admin-bot-sec&entityId=2');
        expect(res.body.invite_conversion.pct).toBe(33.3);
    });

    it('invite_conversion SQL targets invite_codes (live table), not Phase-5 invite_redemptions', async () => {
        setupAdminQueries({ total_codes: 5, redeemed_codes: 2 });
        await get('?deviceId=admin-dev&botSecret=admin-bot-sec&entityId=2');
        const inviteCall = mockQuery.mock.calls.find(c => /total_codes/i.test(c[0]) && /redeemed_codes/i.test(c[0]));
        expect(inviteCall).toBeDefined();
        const sql = inviteCall[0];
        expect(sql).toMatch(/FROM\s+invite_codes\b/i);
        expect(sql).toMatch(/used_by_device_id/);
        expect(sql).not.toMatch(/invite_redemptions/);
    });

    it('never leaks PII fields (id/email/ip/device_id) in response', async () => {
        setupAdminQueries({ signups: 1, cohort: 1, active: 1, plaza: 1 });
        const res = await get('?deviceId=admin-dev&botSecret=admin-bot-sec&entityId=2');
        const body = JSON.stringify(res.body);
        expect(body).not.toMatch(/\bid\b\s*:/i);
        expect(body).not.toMatch(/email/i);
        expect(body).not.toMatch(/ip_address|"ip"/i);
        expect(body).not.toMatch(/device_id|deviceId/);
    });

    it('handles non-numeric entityId as 401 (NaN safe)', async () => {
        const res = await get('?deviceId=admin-dev&botSecret=admin-bot-sec&entityId=abc');
        expect(res.status).toBe(401);
    });

    it('reports retention pct as null when cohort empty', async () => {
        setupAdminQueries({ cohort: 0, active: 0 });
        const res = await get('?deviceId=admin-dev&botSecret=admin-bot-sec&entityId=2');
        expect(res.status).toBe(200);
        expect(res.body.retention_7d.pct).toBeNull();
        expect(res.body.retention_7d.cohort_size).toBe(0);
    });

    it('rounds retention pct to one decimal', async () => {
        setupAdminQueries({ cohort: 7, active: 1 });
        const res = await get('?deviceId=admin-dev&botSecret=admin-bot-sec&entityId=2');
        expect(res.body.retention_7d.pct).toBe(14.3);
    });

    it('returns 500 on db error in metric query', async () => {
        mockQuery
            .mockResolvedValueOnce({ rows: [{ is_admin: true }] })
            .mockRejectedValueOnce(new Error('boom'));
        const res = await get('?deviceId=admin-dev&botSecret=admin-bot-sec&entityId=2');
        expect(res.status).toBe(500);
    });

    it('returns 500 on db error in admin check', async () => {
        mockQuery.mockRejectedValueOnce(new Error('admin check failed'));
        const res = await get('?deviceId=admin-dev&botSecret=admin-bot-sec&entityId=2');
        expect(res.status).toBe(500);
    });
});

describe('Growth /daily date param (historical snapshots)', () => {
    it('accepts date=YYYY-MM-DD and echoes it back in response', async () => {
        setupAdminQueries({ signups: 3, cohort: 10, active: 2, plaza: 1, total_codes: 20, redeemed_codes: 4 });
        const res = await get('?deviceId=admin-dev&botSecret=admin-bot-sec&entityId=2&date=2026-04-17');
        expect(res.status).toBe(200);
        expect(res.body.date).toBe('2026-04-17');
    });

    it('passes the supplied date into the signups SQL (not NOW())', async () => {
        setupAdminQueries({ signups: 9 });
        await get('?deviceId=admin-dev&botSecret=admin-bot-sec&entityId=2&date=2026-04-17');
        // Find the signups query (first metric after is_admin). Params[1] should be the anchor date.
        const signupsCall = mockQuery.mock.calls.find(c => /FROM user_accounts\s+WHERE created_at/.test(c[0]) && Array.isArray(c[1]));
        expect(signupsCall).toBeDefined();
        expect(signupsCall[1]).toEqual(['Asia/Taipei', '2026-04-17']);
    });

    it('two requests with different dates query DB with different anchor params', async () => {
        setupAdminQueries({ signups: 5 });
        await get('?deviceId=admin-dev&botSecret=admin-bot-sec&entityId=2&date=2026-04-17');
        const firstCalls = mockQuery.mock.calls.slice();
        mockQuery.mockReset();
        setupAdminQueries({ signups: 12 });
        await get('?deviceId=admin-dev&botSecret=admin-bot-sec&entityId=2&date=2026-04-18');
        const secondCalls = mockQuery.mock.calls.slice();

        const firstAnchors = firstCalls.map(c => (c[1] || [])[1]).filter(Boolean);
        const secondAnchors = secondCalls.map(c => (c[1] || [])[1]).filter(Boolean);
        expect(firstAnchors).toContain('2026-04-17');
        expect(secondAnchors).toContain('2026-04-18');
        expect(firstAnchors).not.toContain('2026-04-18');
        expect(secondAnchors).not.toContain('2026-04-17');
    });

    it('rejects malformed date with 400', async () => {
        const res = await get('?deviceId=admin-dev&botSecret=admin-bot-sec&entityId=2&date=2026/04/17');
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/date/i);
    });

    it('rejects impossible date (Feb 30) with 400', async () => {
        const res = await get('?deviceId=admin-dev&botSecret=admin-bot-sec&entityId=2&date=2026-02-30');
        expect(res.status).toBe(400);
    });

    it('defaults to today in Taipei TZ when date omitted', async () => {
        setupAdminQueries({ signups: 2 });
        const res = await get('?deviceId=admin-dev&botSecret=admin-bot-sec&entityId=2');
        expect(res.status).toBe(200);
        const expected = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
        expect(res.body.date).toBe(expected);
    });

    it('validates date before auth/rate — bad date 400 even without valid creds', async () => {
        const res = await get('?deviceId=admin-dev&botSecret=wrong&entityId=2&date=garbage');
        expect(res.status).toBe(400);
    });
});

describe('Growth /daily rate limit', () => {
    it('allows up to 60 requests per botSecret per hour', async () => {
        for (let i = 0; i < 60; i++) {
            setupAdminQueries();
            const res = await get('?deviceId=admin-dev&botSecret=admin-bot-sec&entityId=2');
            expect(res.status).toBe(200);
        }
        // 61st should 429
        mockQuery.mockResolvedValueOnce({ rows: [{ is_admin: true }] });
        const res = await get('?deviceId=admin-dev&botSecret=admin-bot-sec&entityId=2');
        expect(res.status).toBe(429);
    }, 30000);

    it('separates rate buckets per botSecret', async () => {
        for (let i = 0; i < 60; i++) {
            setupAdminQueries();
            await get('?deviceId=admin-dev&botSecret=admin-bot-sec&entityId=2');
        }
        // user-dev with its own secret should still work (assuming admin)
        setupAdminQueries();
        const res = await get('?deviceId=user-dev&botSecret=user-bot-sec&entityId=2');
        expect(res.status).toBe(200);
    }, 30000);
});

describe('Growth signup_source schema contract', () => {
    it('auth schema creates and migrates user_accounts.signup_source', () => {
        const schema = fs.readFileSync(path.join(__dirname, '../../auth_schema.sql'), 'utf8');
        expect(schema).toMatch(/signup_source\s+VARCHAR\(64\)/i);
        expect(schema).toMatch(/ALTER TABLE user_accounts ADD COLUMN IF NOT EXISTS signup_source/i);
        expect(schema).toMatch(/idx_user_accounts_signup_source/i);
    });

    it('portal registration surfaces send a signupSource field', () => {
        const portalIndex = fs.readFileSync(path.join(__dirname, '../../public/portal/index.html'), 'utf8');
        const shareChat = fs.readFileSync(path.join(__dirname, '../../public/portal/share-chat.html'), 'utf8');
        const iosApi = fs.readFileSync(path.join(__dirname, '../../../ios-app/services/api.ts'), 'utf8');
        const growthTracking = fs.readFileSync(path.join(__dirname, '../../public/js/growth-tracking.js'), 'utf8');

        const backendIndex = fs.readFileSync(path.join(__dirname, '../../index.js'), 'utf8');

        expect(growthTracking).toMatch(/collectSignupSource/);
        expect(growthTracking).toMatch(/utm:/);
        expect(backendIndex).toMatch(/app\.use\('\/js',\s*express\.static\(path\.join\(__dirname, 'public\/js'\)/);
        expect(portalIndex).toMatch(/EClawGrowthTracking\.collectSignupSource\(\{ fallback: 'web_portal' \}\)/);
        expect(portalIndex).toMatch(/signupSource:\s*collectSignupSource\(\)/);
        expect(shareChat).toMatch(/EClawGrowthTracking\.collectSignupSource\(\{ fallback: 'share_chat' \}\)/);
        expect(iosApi).toMatch(/signupSource\s*=\s*'ios_app'/);
    });
});
