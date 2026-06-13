/**
 * Rental module — interview dispatch endpoint tests.
 *
 * Validates: auth, ownership, rate limiting, entity resolution,
 * status transitions, and interview result persistence.
 */

jest.mock('pg', () => {
    const state = {
        listings: [],
        interviews: [],
        nextId: 1,
    };
    globalThis.__rentalInterviewState = state;

    function genId() { return `listing-${state.nextId++}`; }

    function runQuery(sql, params = []) {
        const norm = sql.replace(/\s+/g, ' ').trim();

        if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(norm)) return { rows: [], rowCount: 0 };
        if (/^CREATE (TABLE|INDEX|UNIQUE INDEX)/i.test(norm)) return { rows: [], rowCount: 0 };
        if (/^DO \$\$/i.test(norm)) return { rows: [], rowCount: 0 };
        if (/^ALTER TABLE/i.test(norm)) return { rows: [], rowCount: 0 };

        // INSERT new listing
        if (/^INSERT INTO bot_listings/i.test(norm)) {
            // card_68242d88: id is now passed explicitly as $1 — shift the rest.
            const [explicitId, ownerUserId, ownerDeviceId, ownerEntityId, title, description,
                   rate, minMin, maxMin] = params;
            const row = {
                id: explicitId || genId(), owner_user_id: ownerUserId,
                owner_device_id: ownerDeviceId, owner_entity_id: ownerEntityId,
                title, description, rate_mli_per_ktoken: rate,
                min_rental_minutes: minMin, max_rental_minutes: maxMin,
                interview_passed: false, status: 'draft',
                capabilities: {}, benchmark_score: {},
                model_detected: null, last_interview_at: null,
                avg_rating: 0, total_rentals: 0, uptime_pct: 100,
                availability_windows: [],
                created_at: new Date(), updated_at: new Date(),
            };
            state.listings.push(row);
            return { rows: [{ id: row.id, status: row.status, created_at: row.created_at }], rowCount: 1 };
        }

        // SELECT listing by id — accept both legacy and `bl.`-aliased shape
        // (introduced when getListing picked up a petdx_avatar_url JOIN).
        if (/^SELECT .* FROM bot_listings(?:\s+bl)?.* WHERE (?:bl\.)?id = \$1$/i.test(norm)) {
            const row = state.listings.find(l => l.id === params[0]);
            return { rows: row ? [{ ...row, petdx_avatar_url: null }] : [], rowCount: row ? 1 : 0 };
        }

        // COUNT recent interviews (rate limit)
        if (/SELECT COUNT.*FROM bot_interviews.*listing_id/i.test(norm)) {
            const recentCount = state.interviews.filter(i => i.listing_id === params[0]).length;
            return { rows: [{ count: String(recentCount) }], rowCount: 1 };
        }

        // UPDATE listing status to 'interview'
        if (/UPDATE bot_listings SET status = 'interview'/i.test(norm)) {
            const listing = state.listings.find(l => l.id === params[0]);
            if (listing) { listing.status = 'interview'; listing.updated_at = new Date(); }
            return { rows: listing ? [listing] : [], rowCount: listing ? 1 : 0 };
        }

        // UPDATE listing interview passed
        if (/UPDATE bot_listings.*SET interview_passed = TRUE/i.test(norm)) {
            const listing = state.listings.find(l => l.id === params[0]);
            if (listing) {
                listing.interview_passed = true;
                listing.capabilities = JSON.parse(params[1]);
                listing.benchmark_score = JSON.parse(params[2]);
                listing.status = 'draft';
                listing.updated_at = new Date();
            }
            return { rows: listing ? [listing] : [], rowCount: listing ? 1 : 0 };
        }

        // UPDATE listing status back to draft (failed interview)
        if (/UPDATE bot_listings SET status = 'draft'/i.test(norm)) {
            const listing = state.listings.find(l => l.id === params[0]);
            if (listing) { listing.status = 'draft'; listing.updated_at = new Date(); }
            return { rows: listing ? [listing] : [], rowCount: listing ? 1 : 0 };
        }

        // INSERT interview record
        if (/^INSERT INTO bot_interviews/i.test(norm)) {
            const row = {
                id: `interview-${state.interviews.length + 1}`,
                listing_id: params[0],
                probes_json: params[1],
                responses_json: params[2],
                passed: params[3],
                score: params[4],
                duration_ms: params[5],
                failure_reason: params[6],
                created_at: new Date(),
            };
            state.interviews.push(row);
            return { rows: [row], rowCount: 1 };
        }

        // SELECT interviews for listing (history)
        if (/SELECT .* FROM bot_interviews WHERE listing_id/i.test(norm)) {
            const rows = state.interviews.filter(i => i.listing_id === params[0]);
            return { rows, rowCount: rows.length };
        }

        // SELECT interview detail
        if (/SELECT .* FROM bot_interviews WHERE id = \$1 AND listing_id = \$2/i.test(norm)) {
            const row = state.interviews.find(i => i.id === params[0] && i.listing_id === params[1]);
            return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
        }

        // SELECT listing by owner
        if (/FROM bot_listings WHERE owner_user_id/i.test(norm)) {
            const rows = state.listings.filter(l => l.owner_user_id === params[0]);
            return { rows, rowCount: rows.length };
        }

        // Catch-all
        return { rows: [], rowCount: 0 };
    }

    const mockClient = { query: jest.fn((sql, params) => runQuery(sql, params)), release: jest.fn() };
    const mockPool = {
        query: jest.fn((sql, params) => runQuery(sql, params)),
        connect: jest.fn().mockResolvedValue(mockClient),
    };
    return { Pool: jest.fn(() => mockPool) };
});

// Mock bot-interview runInterview to avoid actual polling
jest.mock('../../bot-interview', () => {
    const actual = jest.requireActual('../../bot-interview');
    return {
        ...actual,
        runInterview: jest.fn(),
    };
});

const request = require('supertest');
const express = require('express');
const { runInterview } = require('../../bot-interview');

// Build a minimal Express app with the rental module
const mockAuthMiddleware = (req, _res, next) => {
    req.user = req.headers['x-test-user'] ? JSON.parse(req.headers['x-test-user']) : null;
    next();
};

const mockWalletModule = {
    withTransaction: jest.fn(async (fn) => {
        const client = { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }), release: jest.fn() };
        return fn(client);
    }),
    applyLedgerEntry: jest.fn(),
    LEDGER_TYPES: { DEPOSIT_HOLD: 'deposit_hold', DEPOSIT_RELEASE: 'deposit_release', DEPOSIT_FORFEIT: 'deposit_forfeit', RENTAL_INCOME: 'rental_income', PLATFORM_FEE: 'platform_fee' },
};

const rentalFactory = require('../../rental');
const rentalModule = rentalFactory({
    authMiddleware: mockAuthMiddleware,
    adminMiddleware: (_req, _res, next) => next(),
    walletModule: mockWalletModule,
    serverLog: () => {},
});

// Inject interview deps with mock devices
const mockDevices = {
    'dev-001': {
        deviceId: 'dev-001',
        deviceSecret: 'secret',
        entities: {
            0: {
                entityId: 0, isBound: true, webhook: { url: 'http://test' },
                lastUpdated: 1000, message: '', _interviewInProgress: false,
            },
            1: {
                entityId: 1, isBound: false, webhook: null,
                lastUpdated: 0, message: '',
            },
        },
    },
};

const mockPushToBot = jest.fn().mockResolvedValue({ pushed: true });
rentalModule.setInterviewDeps({ pushToBot: mockPushToBot, devices: mockDevices });

const app = express();
app.use(express.json());
app.use('/api/rental', rentalModule.router);

const USER = { userId: 'user-001' };
const OTHER_USER = { userId: 'user-other' };

function authHeader(user) {
    return { 'x-test-user': JSON.stringify(user), 'Content-Type': 'application/json' };
}

describe('rental interview endpoints', () => {
    let listingId;

    beforeEach(() => {
        globalThis.__rentalInterviewState.listings = [];
        globalThis.__rentalInterviewState.interviews = [];
        globalThis.__rentalInterviewState.nextId = 1;
        jest.clearAllMocks();
        // Reset entity state
        mockDevices['dev-001'].entities[0]._interviewInProgress = false;
        mockDevices['dev-001'].entities[0].lastUpdated = 1000;
    });

    async function createTestListing() {
        const res = await request(app)
            .post('/api/rental/listing')
            .set(authHeader(USER))
            .send({
                ownerDeviceId: 'dev-001', ownerEntityId: 0,
                title: 'Test Bot', rateMliPerKtoken: 5000,
            });
        return res.body.listing.id;
    }

    describe('POST /api/rental/listing/:id/interview/start', () => {
        test('runs interview and returns result', async () => {
            listingId = await createTestListing();

            runInterview.mockResolvedValueOnce({
                score: 85, rawScore: 77, maxScore: 90, passed: true,
                probeResults: [], capabilities: { python_exec: { supported: true, probes: [] } },
                duration_ms: 5000, responses: ['Hello', '1024'],
            });

            const res = await request(app)
                .post(`/api/rental/listing/${listingId}/interview/start`)
                .set(authHeader(USER))
                .send();

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.interview.passed).toBe(true);
            expect(res.body.interview.score).toBe(85);

            // Verify listing updated
            const listing = globalThis.__rentalInterviewState.listings[0];
            expect(listing.interview_passed).toBe(true);
        });

        test('failed interview reverts listing to draft', async () => {
            listingId = await createTestListing();

            runInterview.mockResolvedValueOnce({
                score: 30, rawScore: 27, maxScore: 90, passed: false,
                probeResults: [], capabilities: {},
                duration_ms: 2000, responses: [null, null],
            });

            const res = await request(app)
                .post(`/api/rental/listing/${listingId}/interview/start`)
                .set(authHeader(USER))
                .send();

            expect(res.status).toBe(200);
            expect(res.body.interview.passed).toBe(false);
            expect(globalThis.__rentalInterviewState.listings[0].status).toBe('draft');
        });

        test('rejects non-owner', async () => {
            listingId = await createTestListing();

            const res = await request(app)
                .post(`/api/rental/listing/${listingId}/interview/start`)
                .set(authHeader(OTHER_USER))
                .send();

            expect(res.status).toBe(403);
        });

        test('rejects unauthenticated request', async () => {
            listingId = await createTestListing();

            const res = await request(app)
                .post(`/api/rental/listing/${listingId}/interview/start`)
                .set({ 'Content-Type': 'application/json' })
                .send();

            expect(res.status).toBe(401);
        });

        test('rejects when entity not bound', async () => {
            // Create listing pointing to unbound entity
            const state = globalThis.__rentalInterviewState;
            state.listings.push({
                id: 'list-unbound', owner_user_id: USER.userId,
                owner_device_id: 'dev-001', owner_entity_id: 1,
                status: 'draft', interview_passed: false,
                capabilities: {}, benchmark_score: {},
            });

            const res = await request(app)
                .post('/api/rental/listing/list-unbound/interview/start')
                .set(authHeader(USER))
                .send();

            expect(res.status).toBe(400);
            expect(res.body.error).toBe('owner_entity_not_bound');
        });

        test('rejects when device is offline', async () => {
            const state = globalThis.__rentalInterviewState;
            state.listings.push({
                id: 'list-offline', owner_user_id: USER.userId,
                owner_device_id: 'dev-nonexistent', owner_entity_id: 0,
                status: 'draft', interview_passed: false,
                capabilities: {}, benchmark_score: {},
            });

            const res = await request(app)
                .post('/api/rental/listing/list-offline/interview/start')
                .set(authHeader(USER))
                .send();

            expect(res.status).toBe(404);
            expect(res.body.error).toBe('owner_device_not_found');
        });

        test('rejects when interview already running', async () => {
            listingId = await createTestListing();
            mockDevices['dev-001'].entities[0]._interviewInProgress = true;

            const res = await request(app)
                .post(`/api/rental/listing/${listingId}/interview/start`)
                .set(authHeader(USER))
                .send();

            expect(res.status).toBe(400);
            expect(res.body.error).toBe('interview_already_running');
        });

        test('rate limits after 3 attempts in 7 days', async () => {
            listingId = await createTestListing();
            // Simulate 3 existing interviews
            for (let i = 0; i < 3; i++) {
                globalThis.__rentalInterviewState.interviews.push({
                    id: `int-${i}`, listing_id: listingId, passed: false, score: 20,
                    created_at: new Date(),
                });
            }

            const res = await request(app)
                .post(`/api/rental/listing/${listingId}/interview/start`)
                .set(authHeader(USER))
                .send();

            expect(res.status).toBe(400);
            expect(res.body.error).toBe('interview_rate_limited');
        });
    });

    describe('GET /api/rental/listing/:id/interviews', () => {
        test('returns interview history for owner', async () => {
            listingId = await createTestListing();
            globalThis.__rentalInterviewState.interviews.push({
                id: 'int-1', listing_id: listingId, passed: true, score: 85,
                duration_ms: 5000, failure_reason: null, created_at: new Date(),
            });

            const res = await request(app)
                .get(`/api/rental/listing/${listingId}/interviews`)
                .set(authHeader(USER));

            expect(res.status).toBe(200);
            expect(res.body.interviews).toHaveLength(1);
            expect(res.body.interviews[0].score).toBe(85);
        });

        test('rejects non-owner', async () => {
            listingId = await createTestListing();

            const res = await request(app)
                .get(`/api/rental/listing/${listingId}/interviews`)
                .set(authHeader(OTHER_USER));

            expect(res.status).toBe(403);
        });
    });

    describe('GET /api/rental/listing/:id/interview/:interviewId', () => {
        test('returns interview detail for owner', async () => {
            listingId = await createTestListing();
            globalThis.__rentalInterviewState.interviews.push({
                id: 'int-detail-1', listing_id: listingId, passed: true, score: 85,
                probes_json: '[]', responses_json: '[]',
                duration_ms: 5000, failure_reason: null, created_at: new Date(),
            });

            const res = await request(app)
                .get(`/api/rental/listing/${listingId}/interview/int-detail-1`)
                .set(authHeader(USER));

            expect(res.status).toBe(200);
            expect(res.body.interview.id).toBe('int-detail-1');
        });

        test('returns 404 for nonexistent interview', async () => {
            listingId = await createTestListing();

            const res = await request(app)
                .get(`/api/rental/listing/${listingId}/interview/nonexistent`)
                .set(authHeader(USER));

            expect(res.status).toBe(404);
        });
    });
});
