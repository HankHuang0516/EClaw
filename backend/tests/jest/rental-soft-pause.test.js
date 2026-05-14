/**
 * Listing soft-pause regression coverage.
 *
 * Soft-pause is an availability overlay: bot_listings.status stays 'listed',
 * marketplace hides active pauses, detail remains reachable, and new rentals
 * fail 503 without touching existing active contracts.
 */

jest.mock('pg', () => {
    const state = {
        listings: [],
        contracts: [],
        snapshots: [],
        wallets: new Map(),
    };
    globalThis.__softPauseState = state;

    function rows(list) { return { rows: list, rowCount: list.length }; }
    function getListing(id) { return state.listings.find((l) => l.id === id); }
    function activeContracts(listingId) {
        return state.contracts.filter((c) => c.listing_id === listingId && ['reserved', 'active', 'suspended_insufficient_funds'].includes(c.status));
    }

    function runQuery(sql, params = []) {
        const norm = sql.replace(/\s+/g, ' ').trim();
        if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(norm)) return rows([]);
        if (/^CREATE (TABLE|INDEX|UNIQUE INDEX)/i.test(norm)) return rows([]);
        if (/^ALTER TABLE/i.test(norm)) return rows([]);

        if (/^SELECT id, owner_user_id, rate_mli_per_ktoken,\s*min_rental_minutes, max_rental_minutes,\s*status, interview_passed, soft_pause_until, soft_pause_reason\s*FROM bot_listings WHERE id = \$1 FOR UPDATE$/i.test(norm)) {
            const l = getListing(params[0]);
            return l ? rows([{ ...l }]) : rows([]);
        }
        if (/^SELECT cooldown_until FROM rental_cooldowns/i.test(norm)) return rows([]);
        if (/^SELECT id FROM rental_contracts\s+WHERE listing_id = \$1\s+AND status IN/i.test(norm)) {
            return rows(activeContracts(params[0]).map((c) => ({ id: c.id })));
        }
        if (/^SELECT balance_mli FROM wallets WHERE user_id = \$1$/i.test(norm)) {
            const w = state.wallets.get(params[0]);
            return w ? rows([{ balance_mli: String(w.balance_mli) }]) : rows([]);
        }
        if (/^INSERT INTO rental_contracts/i.test(norm)) {
            const [id, listingId, ownerUserId, renterUserId, renterDeviceId, rateSnapshot, depositMli, durationMin, totalDurationSec] = params;
            const row = {
                id, listing_id: listingId, owner_user_id: ownerUserId, renter_user_id: renterUserId,
                renter_device_id: renterDeviceId, rate_mli_per_ktoken_snapshot: rateSnapshot,
                deposit_mli: depositMli, planned_duration_min: durationMin, total_duration_sec: totalDurationSec,
                started_at: new Date(), ends_at: new Date(Date.now() + durationMin * 60000), status: 'active',
                created_at: new Date(),
            };
            state.contracts.push(row);
            return rows([{ id, status: 'active', started_at: row.started_at, ends_at: row.ends_at, deposit_mli: depositMli, total_duration_sec: totalDurationSec }]);
        }
        if (/^INSERT INTO rental_snapshots/i.test(norm)) {
            state.snapshots.push({ contract_id: params[0] });
            return rows([{}]);
        }

        if (/^UPDATE bot_listings\s+SET soft_pause_until = \$2,/i.test(norm)) {
            const [id, until, reason] = params;
            const l = getListing(id);
            if (!l || l.status !== 'listed') return rows([]);
            l.soft_pause_until = until;
            l.soft_pause_reason = reason;
            l.updated_at = new Date();
            return rows([{ id: l.id, status: l.status, soft_pause_until: l.soft_pause_until, soft_pause_reason: l.soft_pause_reason }]);
        }
        if (/^UPDATE bot_listings\s+SET soft_pause_until = NULL,/i.test(norm)) {
            const [id, ownerUserId] = params;
            const l = getListing(id);
            if (!l || (ownerUserId && l.owner_user_id !== ownerUserId)) return rows([]);
            l.soft_pause_until = null;
            l.soft_pause_reason = null;
            l.updated_at = new Date();
            return rows([{ id: l.id, status: l.status, soft_pause_until: null, soft_pause_reason: null }]);
        }

        if (/^SELECT id, owner_user_id, owner_device_id, owner_entity_id,.*soft_pause_until, soft_pause_reason,.*FROM bot_listings WHERE id = \$1$/i.test(norm)) {
            const l = getListing(params[0]);
            return l ? rows([{ ...l }]) : rows([]);
        }
        if (/^SELECT id FROM rental_contracts WHERE listing_id = \$1 AND status LIKE 'active%' LIMIT 1$/i.test(norm)) {
            return rows(state.contracts.filter((c) => c.listing_id === params[0] && String(c.status).startsWith('active')).slice(0, 1).map((c) => ({ id: c.id })));
        }
        if (/^SELECT total_score, max_score FROM arena_exams/i.test(norm)) return rows([]);

        if (/FROM bot_listings WHERE owner_user_id = \$1 ORDER BY created_at DESC/i.test(norm)) {
            return rows(state.listings.filter((l) => l.owner_user_id === params[0]).sort((a, b) => b.created_at - a.created_at).map((l) => ({
                id: l.id, owner_device_id: l.owner_device_id, owner_entity_id: l.owner_entity_id,
                title: l.title, rate_mli_per_ktoken: l.rate_mli_per_ktoken, status: l.status,
                interview_passed: l.interview_passed, avg_rating: l.avg_rating, total_rentals: l.total_rentals,
                soft_pause_until: l.soft_pause_until, soft_pause_reason: l.soft_pause_reason, created_at: l.created_at,
            })));
        }

        if (/FROM bot_listings bl\s+WHERE/i.test(norm) && /bl.status = 'listed'/i.test(norm)) {
            const now = Date.now();
            const limit = params[params.length - 2] || 20;
            const offset = params[params.length - 1] || 0;
            const visible = state.listings.filter((l) => l.status === 'listed' && l.interview_passed && (!l.soft_pause_until || new Date(l.soft_pause_until).getTime() <= now));
            return rows(visible.slice(offset, offset + limit).map((l) => ({
                id: l.id, title: l.title, description: l.description, rate_mli_per_ktoken: l.rate_mli_per_ktoken,
                min_rental_minutes: l.min_rental_minutes, max_rental_minutes: l.max_rental_minutes,
                model_detected: l.model_detected, capabilities: l.capabilities, benchmark_score: l.benchmark_score,
                avg_rating: l.avg_rating, total_rentals: l.total_rentals, uptime_pct: l.uptime_pct,
                owner_device_id: l.owner_device_id, owner_entity_id: l.owner_entity_id, avatar_url: l.avatar_url,
                bound_rebind_count: l.bound_rebind_count, soft_pause_until: l.soft_pause_until, soft_pause_reason: l.soft_pause_reason,
                has_active_contract: activeContracts(l.id).length > 0,
            })));
        }

        if (/FROM rental_contracts/i.test(norm) && /ORDER BY.*created_at DESC/i.test(norm)) {
            const userId = params[0];
            return rows(state.contracts.filter((c) => c.renter_user_id === userId || c.owner_user_id === userId));
        }

        throw new Error(`[fake-pg soft-pause] Unhandled SQL: ${norm}`);
    }

    class FakePool {
        async connect() { return { query: async (sql, params) => runQuery(sql, params), release: () => {} }; }
        async query(sql, params) { return runQuery(sql, params); }
    }
    return { Pool: jest.fn().mockImplementation(() => new FakePool()) };
});

jest.mock('fs', () => {
    const real = jest.requireActual('fs');
    return {
        ...real,
        readFileSync: jest.fn((p, enc) => {
            if (typeof p === 'string' && p.endsWith('rental_schema.sql')) return '';
            return real.readFileSync(p, enc);
        }),
    };
});

const express = require('express');
const request = require('supertest');
const rental = require('../../rental');

const OWNER = '11111111-1111-1111-1111-111111111111';
const RENTER = '22222222-2222-2222-2222-222222222222';
const OTHER = '33333333-3333-3333-3333-333333333333';

const walletApi = {
    LEDGER_TYPES: { DEPOSIT_HOLD: 'deposit_hold' },
    withTransaction: async (fn) => fn({ query: async (sql, params) => globalThis.__softPauseQuery(sql, params) }),
    applyLedgerEntry: async (_client, entry) => {
        const s = globalThis.__softPauseState;
        const w = s.wallets.get(entry.userId) || { balance_mli: 0n, held_mli: 0n };
        w.balance_mli += BigInt(entry.balanceDelta || 0);
        w.held_mli += BigInt(entry.heldDelta || 0);
        s.wallets.set(entry.userId, w);
        return { id: 1 };
    },
};

// Bridge for walletApi.withTransaction client.
beforeAll(() => {
    const pool = rental({ authMiddleware: (_req, _res, next) => next(), walletModule: walletApi })._internals.pool;
    globalThis.__softPauseQuery = (sql, params) => pool.query(sql, params);
});

function resetState() {
    const s = globalThis.__softPauseState;
    s.listings.length = 0;
    s.contracts.length = 0;
    s.snapshots.length = 0;
    s.wallets.clear();
}

function seedListing(overrides = {}) {
    const row = {
        id: overrides.id || 'listing-soft-1',
        owner_user_id: overrides.owner_user_id || OWNER,
        owner_device_id: overrides.owner_device_id || 'owner-dev',
        owner_entity_id: overrides.owner_entity_id ?? 0,
        title: overrides.title || 'Soft pause bot',
        description: overrides.description || 'desc',
        rate_mli_per_ktoken: overrides.rate_mli_per_ktoken || 5000,
        min_rental_minutes: overrides.min_rental_minutes || 30,
        max_rental_minutes: overrides.max_rental_minutes || 120,
        availability_windows: [], model_detected: 'gpt-test', capabilities: {}, benchmark_score: {},
        interview_passed: overrides.interview_passed ?? true,
        last_interview_at: null, avg_rating: 5, total_rentals: 0, uptime_pct: 100,
        status: overrides.status || 'listed', bound_rebind_count: 0, avatar_url: null,
        soft_pause_until: overrides.soft_pause_until || null,
        soft_pause_reason: overrides.soft_pause_reason || null,
        created_at: overrides.created_at || new Date(), updated_at: new Date(),
    };
    globalThis.__softPauseState.listings.push(row);
    return row;
}

function buildApi(userId = RENTER) {
    const authMiddleware = (req, _res, next) => {
        req.user = { userId: req.get('x-user-id') || userId, deviceId: req.get('x-device-id') || 'web-dev' };
        next();
    };
    const api = rental({ authMiddleware, softAuthMiddleware: authMiddleware, walletModule: walletApi });
    const app = express();
    app.use(express.json());
    app.use('/api/rental', api.router);
    return { app, api };
}

beforeEach(resetState);

describe('listing soft-pause service + DB behavior', () => {
    test('marketplace hides active soft-paused listings by default while status remains listed', async () => {
        const paused = seedListing({ id: 'listing-paused', soft_pause_until: new Date(Date.now() + 3600000).toISOString(), soft_pause_reason: 'health_degraded' });
        seedListing({ id: 'listing-visible', owner_entity_id: 1, title: 'Visible bot' });
        const { api } = buildApi();

        const listings = await api.searchMarketplace({});
        expect(listings.map((l) => l.id)).toEqual(['listing-visible']);
        expect(paused.status).toBe('listed');
    });

    test('owner listing/detail include soft-pause fields', async () => {
        const until = new Date(Date.now() + 3600000).toISOString();
        seedListing({ soft_pause_until: until, soft_pause_reason: 'response_timeout' });
        const { api } = buildApi();

        const detail = await api.getListing('listing-soft-1');
        expect(detail.is_soft_paused).toBe(true);
        expect(detail.soft_pause_reason).toBe('response_timeout');

        const mine = await api.listMyListings(OWNER);
        expect(mine[0]).toMatchObject({ is_soft_paused: true, soft_pause_reason: 'response_timeout' });
    });

    test('health degradation over one hour soft-pauses; five consecutive OK clears it', async () => {
        seedListing();
        const { api } = buildApi();

        const degraded = await api.recordListingHealthSample({
            listingId: 'listing-soft-1',
            status: 'degraded',
            degradedSince: new Date(Date.now() - 61 * 60000).toISOString(),
            reason: 'response_timeout',
        });
        expect(degraded).toMatchObject({ changed: true, action: 'soft_paused' });
        expect(globalThis.__softPauseState.listings[0].soft_pause_reason).toBe('response_timeout');

        const recovered = await api.recordListingHealthSample({ listingId: 'listing-soft-1', status: 'ok', okStreak: 5 });
        expect(recovered).toMatchObject({ changed: true, action: 'soft_pause_cleared' });
        expect(globalThis.__softPauseState.listings[0].soft_pause_until).toBeNull();
    });

    test('existing active rental remains visible to contract queries after listing soft-pause', async () => {
        seedListing();
        globalThis.__softPauseState.wallets.set(RENTER, { balance_mli: 1000000n, held_mli: 0n });
        const { api } = buildApi();
        const contract = await api.startRental({ listingId: 'listing-soft-1', renterUserId: RENTER, renterDeviceId: 'renter-dev', durationMinutes: 60 }, walletApi);

        await api.softPauseListing('listing-soft-1', { reason: 'response_timeout' });
        expect(globalThis.__softPauseState.contracts.find((c) => c.id === contract.id).status).toBe('active');
        const mine = await api.getMyContracts(RENTER);
        expect(mine).toHaveLength(1);
        expect(mine[0].id).toBe(contract.id);
    });
});

describe('listing soft-pause API behavior', () => {
    test('non-owner listing detail remains reachable and exposes unavailable state without owner id', async () => {
        seedListing({ soft_pause_until: new Date(Date.now() + 3600000).toISOString(), soft_pause_reason: 'health_degraded' });
        const { app } = buildApi(OTHER);

        const res = await request(app).get('/api/rental/listing/listing-soft-1').expect(200);
        expect(res.body.listing.is_soft_paused).toBe(true);
        expect(res.body.listing.soft_pause_reason).toBe('health_degraded');
        expect(res.body.listing.owner_user_id).toBeUndefined();
    });

    test('POST /contract and /create reject new rentals for soft-paused listing with 503 body code', async () => {
        const until = new Date(Date.now() + 3600000).toISOString();
        seedListing({ soft_pause_until: until, soft_pause_reason: 'response_timeout' });
        globalThis.__softPauseState.wallets.set(RENTER, { balance_mli: 1000000n, held_mli: 0n });
        const { app } = buildApi(RENTER);

        for (const path of ['/api/rental/contract', '/api/rental/create']) {
            const res = await request(app)
                .post(path)
                .send({ listingId: 'listing-soft-1', renterDeviceId: 'renter-dev', durationMinutes: 60 })
                .expect(503);
            expect(res.body).toMatchObject({ success: false, error: 'listing_soft_paused', code: 'LISTING_SOFT_PAUSED', reason: 'response_timeout' });
            expect(res.body.resumeEta).toBe(until);
        }
        expect(globalThis.__softPauseState.contracts).toHaveLength(0);
    });

    test('owner-only POST /listing/:id/resume clears soft-pause', async () => {
        seedListing({ soft_pause_until: new Date(Date.now() + 3600000).toISOString(), soft_pause_reason: 'health_degraded' });
        const { app } = buildApi(OWNER);

        const forbidden = await request(app)
            .post('/api/rental/listing/listing-soft-1/resume')
            .set('x-user-id', OTHER)
            .send({})
            .expect(403);
        expect(forbidden.body.error).toBe('listing_not_found_or_forbidden');

        const resumed = await request(app)
            .post('/api/rental/listing/listing-soft-1/resume')
            .set('x-user-id', OWNER)
            .send({})
            .expect(200);
        expect(resumed.body.listing).toMatchObject({ id: 'listing-soft-1', status: 'listed', is_soft_paused: false, soft_pause_until: null, soft_pause_reason: null });
    });
});
