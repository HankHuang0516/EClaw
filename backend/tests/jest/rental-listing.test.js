/**
 * Rental module — listing CRUD + marketplace search unit tests.
 *
 * Uses an in-memory pg simulator tuned to the queries rental.js emits.
 * Tests verify input validation, ownership enforcement, and the
 * immutable-after-interview constraint on capability fields.
 */

jest.mock('pg', () => {
    const state = {
        listings: [],
        nextId: 1,
    };
    globalThis.__rentalFakeState = state;

    function genId() {
        return `listing-${state.nextId++}`;
    }

    function runQuery(sql, params = []) {
        const norm = sql.replace(/\s+/g, ' ').trim();

        if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(norm)) return { rows: [], rowCount: 0 };
        if (/^CREATE (TABLE|INDEX|UNIQUE INDEX)/i.test(norm)) return { rows: [], rowCount: 0 };

        // INSERT new listing
        if (/^INSERT INTO bot_listings/i.test(norm)) {
            const [ownerUserId, ownerDeviceId, ownerEntityId, title, description,
                   rate, minMin, maxMin /* 'draft' status is literal */] = params;
            const row = {
                id: genId(),
                owner_user_id: ownerUserId,
                owner_device_id: ownerDeviceId,
                owner_entity_id: ownerEntityId,
                title,
                description,
                rate_mli_per_ktoken: rate,
                min_rental_minutes: minMin,
                max_rental_minutes: maxMin,
                availability_windows: [],
                model_detected: null,
                capabilities: {},
                benchmark_score: {},
                interview_passed: false,
                last_interview_at: null,
                avg_rating: 0,
                total_rentals: 0,
                uptime_pct: 100,
                status: 'draft',
                created_at: new Date(),
                updated_at: new Date(),
            };
            state.listings.push(row);
            return { rows: [{ id: row.id, status: row.status, created_at: row.created_at }], rowCount: 1 };
        }

        // Specific status-transition handlers MUST come before the generic
        // UPDATE handler, because the generic one would otherwise match.

        // Publish: UPDATE ... WHERE id AND owner AND interview_passed = TRUE
        if (/^UPDATE bot_listings SET status = 'listed'/i.test(norm)) {
            const [id, ownerUserId] = params;
            const row = state.listings.find(l => l.id === id);
            if (!row || row.owner_user_id !== ownerUserId || !row.interview_passed) {
                return { rows: [], rowCount: 0 };
            }
            row.status = 'listed';
            row.updated_at = new Date();
            return { rows: [{ id: row.id, status: row.status }], rowCount: 1 };
        }

        // SELECT interview_passed, owner_user_id FROM bot_listings WHERE id = $1
        if (/^SELECT interview_passed, owner_user_id FROM bot_listings WHERE id = \$1$/i.test(norm)) {
            const row = state.listings.find(l => l.id === params[0]);
            if (!row) return { rows: [], rowCount: 0 };
            return { rows: [{ interview_passed: row.interview_passed, owner_user_id: row.owner_user_id }], rowCount: 1 };
        }

        // Pause: UPDATE ... status='paused' WHERE id AND owner AND status='listed'
        if (/^UPDATE bot_listings SET status = 'paused'/i.test(norm)) {
            const [id, ownerUserId] = params;
            const row = state.listings.find(l => l.id === id);
            if (!row || row.owner_user_id !== ownerUserId || row.status !== 'listed') {
                return { rows: [], rowCount: 0 };
            }
            row.status = 'paused';
            return { rows: [{ id: row.id, status: row.status }], rowCount: 1 };
        }

        // Delist: UPDATE ... status='delisted' WHERE id AND owner
        if (/^UPDATE bot_listings SET status = 'delisted'/i.test(norm)) {
            const [id, ownerUserId] = params;
            const row = state.listings.find(l => l.id === id);
            if (!row || row.owner_user_id !== ownerUserId) return { rows: [], rowCount: 0 };
            row.status = 'delisted';
            return { rows: [{ id: row.id, status: row.status }], rowCount: 1 };
        }

        // Generic UPDATE with whitelisted fields (dynamic SET list from updateListing)
        if (/^UPDATE bot_listings SET/i.test(norm) &&
            / WHERE id = \$1 AND owner_user_id = \$2/i.test(norm)) {
            const [id, ownerUserId, ...fieldValues] = params;
            const row = state.listings.find(l => l.id === id);
            if (!row || row.owner_user_id !== ownerUserId) return { rows: [], rowCount: 0 };

            const setClause = norm.match(/SET (.+?) WHERE/i)[1];
            const assignments = setClause.split(',').map(s => s.trim());
            let valueIdx = 0;
            for (const asg of assignments) {
                const m = asg.match(/^(\w+)\s*=\s*\$(\d+)/);
                if (!m) continue; // updated_at = NOW()
                const col = m[1];
                row[col] = fieldValues[valueIdx++];
            }
            row.updated_at = new Date();
            return { rows: [{ id: row.id, status: row.status, updated_at: row.updated_at }], rowCount: 1 };
        }

        // GET single listing
        if (/^SELECT id, owner_user_id, title, description, rate_mli_per_ktoken/i.test(norm)) {
            const row = state.listings.find(l => l.id === params[0]);
            if (!row) return { rows: [], rowCount: 0 };
            return { rows: [{ ...row }], rowCount: 1 };
        }

        // List my listings
        if (/FROM bot_listings WHERE owner_user_id = \$1 ORDER BY created_at DESC/i.test(norm)) {
            const rows = state.listings
                .filter(l => l.owner_user_id === params[0])
                .map(r => ({
                    id: r.id, title: r.title,
                    rate_mli_per_ktoken: r.rate_mli_per_ktoken,
                    status: r.status, interview_passed: r.interview_passed,
                    avg_rating: r.avg_rating, total_rentals: r.total_rentals,
                    created_at: r.created_at,
                }))
                .sort((a, b) => b.created_at - a.created_at);
            return { rows, rowCount: rows.length };
        }

        // Marketplace search
        if (/FROM bot_listings WHERE status = 'listed'/i.test(norm)) {
            let rows = state.listings.filter(l => l.status === 'listed' && l.interview_passed);
            // Dynamic params are $N (min/max rate, capability), then limit + offset at the end.
            // For simplicity the simulator only checks rate_mli upper/lower filters.
            const limitParam = params[params.length - 2];
            const offsetParam = params[params.length - 1];
            rows = rows.slice(offsetParam, offsetParam + limitParam);
            return {
                rows: rows.map(r => ({
                    id: r.id, title: r.title, description: r.description,
                    rate_mli_per_ktoken: r.rate_mli_per_ktoken,
                    min_rental_minutes: r.min_rental_minutes,
                    max_rental_minutes: r.max_rental_minutes,
                    model_detected: r.model_detected,
                    capabilities: r.capabilities,
                    benchmark_score: r.benchmark_score,
                    avg_rating: r.avg_rating,
                    total_rentals: r.total_rentals,
                    uptime_pct: r.uptime_pct,
                })),
                rowCount: rows.length,
            };
        }

        throw new Error(`[fake-pg rental] Unhandled SQL: ${norm}`);
    }

    class FakePool {
        async connect() {
            return {
                query: async (sql, params) => runQuery(sql, params),
                release: () => {},
            };
        }
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

const rental = require('../../rental');

const noopAuth = (_req, _res, next) => next();
const api = rental({ authMiddleware: noopAuth });

const OWNER = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';

function resetState() {
    const state = globalThis.__rentalFakeState;
    state.listings.length = 0;
    state.nextId = 1;
}
beforeEach(() => { resetState(); });

describe('rental: constants', () => {
    test('exposes listing and contract status enums', () => {
        expect(rental.LISTING_STATUSES.LISTED).toBe('listed');
        expect(rental.CONTRACT_STATUSES.RESERVED).toBe('reserved');
    });

    test('computeDepositMli = rate × 20', () => {
        expect(rental.computeDepositMli(1000)).toBe(20_000);
        expect(rental.computeDepositMli(10_000)).toBe(200_000);
    });

    test('INTERVIEW_PASS_SCORE is 60', () => {
        expect(rental.INTERVIEW_PASS_SCORE).toBe(60);
    });
});

describe('rental: createListing', () => {
    test('creates a draft listing with valid input', async () => {
        const listing = await api.createListing({
            ownerUserId: OWNER,
            ownerDeviceId: 'device-abc',
            ownerEntityId: 0,
            title: 'My Bot',
            rateMliPerKtoken: 5000,
        });
        expect(listing.id).toMatch(/^listing-/);
        expect(listing.status).toBe('draft');
    });

    test('rejects zero or negative rate', async () => {
        await expect(api.createListing({
            ownerUserId: OWNER, ownerDeviceId: 'd', ownerEntityId: 0,
            title: 'Bad', rateMliPerKtoken: 0,
        })).rejects.toThrow('rate_mli_per_ktoken_invalid');
    });

    test('rejects title longer than 120 chars', async () => {
        await expect(api.createListing({
            ownerUserId: OWNER, ownerDeviceId: 'd', ownerEntityId: 0,
            title: 'x'.repeat(200), rateMliPerKtoken: 5000,
        })).rejects.toThrow('title_invalid');
    });

    test('rejects min > max rental duration', async () => {
        await expect(api.createListing({
            ownerUserId: OWNER, ownerDeviceId: 'd', ownerEntityId: 0,
            title: 'OK', rateMliPerKtoken: 5000,
            minRentalMinutes: 60, maxRentalMinutes: 30,
        })).rejects.toThrow('rental_duration_range_invalid');
    });

    test('rejects max exceeding 7 days', async () => {
        await expect(api.createListing({
            ownerUserId: OWNER, ownerDeviceId: 'd', ownerEntityId: 0,
            title: 'OK', rateMliPerKtoken: 5000,
            maxRentalMinutes: 999_999,
        })).rejects.toThrow('max_rental_minutes_invalid');
    });
});

describe('rental: updateListing', () => {
    async function seed() {
        return api.createListing({
            ownerUserId: OWNER, ownerDeviceId: 'd', ownerEntityId: 0,
            title: 'Seed', rateMliPerKtoken: 5000,
        });
    }

    test('owner can update rate and title', async () => {
        const listing = await seed();
        await api.updateListing(listing.id, OWNER, {
            title: 'Updated', rateMliPerKtoken: 8000,
        });
        const state = globalThis.__rentalFakeState;
        const row = state.listings.find(l => l.id === listing.id);
        expect(row.title).toBe('Updated');
        expect(row.rate_mli_per_ktoken).toBe(8000);
    });

    test('non-owner is rejected with listing_not_found_or_forbidden', async () => {
        const listing = await seed();
        await expect(api.updateListing(listing.id, OTHER, { title: 'Hacked' }))
            .rejects.toThrow('listing_not_found_or_forbidden');
    });

    test('capabilities field is silently ignored (locked after interview)', async () => {
        const listing = await seed();
        await expect(api.updateListing(listing.id, OWNER, {
            capabilities: { python_exec: { supported: true } },
        })).rejects.toThrow('no_fields_to_update');
    });

    test('empty patch rejected', async () => {
        const listing = await seed();
        await expect(api.updateListing(listing.id, OWNER, {}))
            .rejects.toThrow('no_fields_to_update');
    });
});

describe('rental: publish / pause / delist', () => {
    async function seedDraft() {
        return api.createListing({
            ownerUserId: OWNER, ownerDeviceId: 'd', ownerEntityId: 0,
            title: 'Publishable', rateMliPerKtoken: 5000,
        });
    }

    test('cannot publish without interview_passed=true', async () => {
        const listing = await seedDraft();
        await expect(api.publishListing(listing.id, OWNER))
            .rejects.toThrow('interview_not_passed');
    });

    test('can publish after interview passes', async () => {
        const listing = await seedDraft();
        const row = globalThis.__rentalFakeState.listings.find(l => l.id === listing.id);
        row.interview_passed = true;

        const pub = await api.publishListing(listing.id, OWNER);
        expect(pub.status).toBe('listed');
    });

    test('non-owner cannot publish', async () => {
        const listing = await seedDraft();
        const row = globalThis.__rentalFakeState.listings.find(l => l.id === listing.id);
        row.interview_passed = true;
        await expect(api.publishListing(listing.id, OTHER))
            .rejects.toThrow('listing_forbidden');
    });

    test('pause requires current status = listed', async () => {
        const listing = await seedDraft();
        await expect(api.pauseListing(listing.id, OWNER))
            .rejects.toThrow('listing_not_found_or_forbidden');
    });

    test('pause then delist flow', async () => {
        const listing = await seedDraft();
        const row = globalThis.__rentalFakeState.listings.find(l => l.id === listing.id);
        row.interview_passed = true;
        await api.publishListing(listing.id, OWNER);
        await api.pauseListing(listing.id, OWNER);
        expect(row.status).toBe('paused');
        await api.delistListing(listing.id, OWNER);
        expect(row.status).toBe('delisted');
    });
});

describe('rental: getListing + listMyListings', () => {
    test('getListing returns full row when exists', async () => {
        const listing = await api.createListing({
            ownerUserId: OWNER, ownerDeviceId: 'd', ownerEntityId: 0,
            title: 'Get me', rateMliPerKtoken: 5000,
        });
        const got = await api.getListing(listing.id);
        expect(got.title).toBe('Get me');
    });

    test('getListing returns null for unknown id', async () => {
        expect(await api.getListing('listing-999')).toBeNull();
    });

    test('listMyListings returns only the requesting owner', async () => {
        await api.createListing({
            ownerUserId: OWNER, ownerDeviceId: 'd', ownerEntityId: 0,
            title: 'Mine', rateMliPerKtoken: 5000,
        });
        await api.createListing({
            ownerUserId: OTHER, ownerDeviceId: 'd2', ownerEntityId: 0,
            title: 'Theirs', rateMliPerKtoken: 3000,
        });
        const mine = await api.listMyListings(OWNER);
        expect(mine).toHaveLength(1);
        expect(mine[0].title).toBe('Mine');
    });
});

describe('rental: searchMarketplace', () => {
    test('only returns listed + interview_passed', async () => {
        const a = await api.createListing({
            ownerUserId: OWNER, ownerDeviceId: 'd', ownerEntityId: 0,
            title: 'Published', rateMliPerKtoken: 5000,
        });
        const b = await api.createListing({
            ownerUserId: OWNER, ownerDeviceId: 'd', ownerEntityId: 1,
            title: 'Draft', rateMliPerKtoken: 3000,
        });
        const state = globalThis.__rentalFakeState;
        const rowA = state.listings.find(l => l.id === a.id);
        rowA.interview_passed = true;
        await api.publishListing(a.id, OWNER);
        // b stays draft

        const results = await api.searchMarketplace({});
        expect(results).toHaveLength(1);
        expect(results[0].title).toBe('Published');
    });

    test('respects limit parameter', async () => {
        for (let i = 0; i < 5; i++) {
            const l = await api.createListing({
                ownerUserId: OWNER, ownerDeviceId: 'd', ownerEntityId: i,
                title: `Bot ${i}`, rateMliPerKtoken: 5000 + i * 100,
            });
            const row = globalThis.__rentalFakeState.listings.find(x => x.id === l.id);
            row.interview_passed = true;
            await api.publishListing(l.id, OWNER);
        }
        const results = await api.searchMarketplace({ limit: 2 });
        expect(results).toHaveLength(2);
    });
});

describe('rental: factory hard-fail', () => {
    test('throws when authMiddleware is missing', () => {
        expect(() => rental({})).toThrow(/authMiddleware/);
    });
});
