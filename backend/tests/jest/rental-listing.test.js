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
        contracts: [],
        snapshots: [],
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

        // BUG-M2: Duplicate listing check (SELECT before INSERT)
        if (/^SELECT id, status FROM bot_listings WHERE owner_device_id/i.test(norm)) {
            const [ownerDeviceId, ownerEntityId] = params;
            const existing = state.listings.find(l =>
                l.owner_device_id === ownerDeviceId &&
                l.owner_entity_id === ownerEntityId &&
                ['draft', 'listed', 'paused', 'interview'].includes(l.status)
            );
            if (existing) {
                return { rows: [{ id: existing.id, status: existing.status }], rowCount: 1 };
            }
            return { rows: [], rowCount: 0 };
        }

        // INSERT new listing
        if (/^INSERT INTO bot_listings/i.test(norm)) {
            // card_68242d883b51c3b6ceda09cb: id now generated in JS and passed
            // explicitly as $1; prod DB's lost-DEFAULT failure mode was the
            // original root cause of the 執行面試 P0.
            const [id, ownerUserId, ownerDeviceId, ownerEntityId, title, description,
                   rate, minMin, maxMin, avatarUrl, boundRebindCount /* 'draft' status is literal */] = params;
            const row = {
                id: id || genId(),
                owner_user_id: ownerUserId,
                owner_device_id: ownerDeviceId,
                owner_entity_id: ownerEntityId,
                title,
                description,
                rate_mli_per_ktoken: rate,
                min_rental_minutes: minMin,
                max_rental_minutes: maxMin,
                avatar_url: avatarUrl,
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
                bound_rebind_count: boundRebindCount ?? 0,
                created_at: new Date(),
                updated_at: new Date(),
            };
            state.listings.push(row);
            return { rows: [{
                id: row.id, status: row.status, created_at: row.created_at,
                bound_rebind_count: row.bound_rebind_count,
            }], rowCount: 1 };
        }

        // Specific status-transition handlers MUST come before the generic
        // UPDATE handler, because the generic one would otherwise match.

        // Publish: UPDATE ... WHERE id AND owner AND interview_passed AND rate>0 AND status IN (draft,paused)
        if (/^UPDATE bot_listings SET status = 'listed'/i.test(norm)) {
            const [id, ownerUserId] = params;
            const row = state.listings.find(l => l.id === id);
            if (!row || row.owner_user_id !== ownerUserId || !row.interview_passed
                || Number(row.rate_mli_per_ktoken || 0) <= 0
                || !['draft', 'paused'].includes(row.status)) {
                return { rows: [], rowCount: 0 };
            }
            row.status = 'listed';
            row.updated_at = new Date();
            return { rows: [{ id: row.id, status: row.status }], rowCount: 1 };
        }

        // SELECT interview_passed, owner_user_id, status[, rate] FROM bot_listings WHERE id = $1
        if (/^SELECT interview_passed, owner_user_id.*FROM bot_listings WHERE id = \$1$/i.test(norm)) {
            const row = state.listings.find(l => l.id === params[0]);
            if (!row) return { rows: [], rowCount: 0 };
            return { rows: [{
                interview_passed: row.interview_passed,
                owner_user_id: row.owner_user_id,
                status: row.status,
                rate_mli_per_ktoken: row.rate_mli_per_ktoken,
            }], rowCount: 1 };
        }

        // Interview gate: SELECT interview_passed FROM bot_listings WHERE id = $1 AND owner_user_id = $2
        if (/^SELECT interview_passed FROM bot_listings WHERE id = \$1 AND owner_user_id = \$2$/i.test(norm)) {
            const [id, ownerUserId] = params;
            const row = state.listings.find(l => l.id === id && l.owner_user_id === ownerUserId);
            if (!row) return { rows: [], rowCount: 0 };
            return { rows: [{ interview_passed: row.interview_passed }], rowCount: 1 };
        }

        // P0 Phase 3 rebind cascade: UPDATE ... status='paused' WHERE owner_device_id AND owner_entity_id AND status IN (...)
        if (/^UPDATE bot_listings SET status = 'paused', updated_at = NOW\(\) WHERE owner_device_id = \$1 AND owner_entity_id = \$2 AND status IN/i.test(norm)) {
            const [deviceId, entityId] = params;
            const affected = state.listings.filter(l =>
                l.owner_device_id === deviceId &&
                l.owner_entity_id === entityId &&
                ['draft', 'interview', 'listed'].includes(l.status));
            for (const row of affected) {
                row.status = 'paused';
                row.updated_at = new Date();
            }
            return { rows: affected.map(r => ({ id: r.id, status: r.status })), rowCount: affected.length };
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
        if (/^SELECT id, owner_user_id.*title.*description.*rate_mli_per_ktoken/i.test(norm)) {
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

        // Market snapshot refresh: aggregate listed, interview-passed listings by model family.
        if (/^SELECT bl\.id, bl\.model_detected, bl\.rate_mli_per_ktoken, COUNT\(c\.id\)::int AS started_contracts/i.test(norm)) {
            const now = Date.now();
            const rows = state.listings
                .filter(l => l.status === 'listed' && l.interview_passed === true)
                .filter(l => Number(l.rate_mli_per_ktoken) > 0)
                .filter(l => !l.soft_pause_until || new Date(l.soft_pause_until).getTime() <= now)
                .map((l) => {
                    const contracts = state.contracts.filter(c => c.listing_id === l.id);
                    return {
                        id: l.id,
                        model_detected: l.model_detected,
                        rate_mli_per_ktoken: l.rate_mli_per_ktoken,
                        started_contracts: contracts.length,
                        successful_contracts: contracts.filter(c => c.status === 'ended_normal').length,
                    };
                });
            return { rows, rowCount: rows.length };
        }

        if (/^INSERT INTO pricing_market_snapshots/i.test(norm)) {
            const [snapshotAt, modelFamily, listingCount, rateP25Mli, rateP50Mli,
                   rateP75Mli, rateP95Mli, rentalSuccessRate] = params;
            state.snapshots.push({
                snapshot_at: snapshotAt,
                model_family: modelFamily,
                listing_count: listingCount,
                rate_p25_mli: rateP25Mli,
                rate_p50_mli: rateP50Mli,
                rate_p75_mli: rateP75Mli,
                rate_p95_mli: rateP95Mli,
                rental_success_rate: rentalSuccessRate,
            });
            return { rows: [], rowCount: 1 };
        }

        // Marketplace search (handles bl. table alias prefix from LEFT JOIN query)
        if (/FROM bot_listings\b.*WHERE\b.*status\s*=\s*'listed'/i.test(norm)) {
            let rows = state.listings.filter(l => l.status === 'listed' && l.interview_passed);
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
                    has_active_contract: false,
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
// The listing tests don't exercise contract code, but the factory now
// hard-requires walletModule — pass a stub with just withTransaction.
const stubWallet = {
    withTransaction: async () => { throw new Error('not_used_in_listing_tests'); },
    LEDGER_TYPES: {},
};
const api = rental({ authMiddleware: noopAuth, walletModule: stubWallet });

const OWNER = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';

function resetState() {
    const state = globalThis.__rentalFakeState;
    state.listings.length = 0;
    state.contracts.length = 0;
    state.snapshots.length = 0;
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
    test('creates a draft listing with rate forced to 0 (interview-gate)', async () => {
        const listing = await api.createListing({
            ownerUserId: OWNER,
            ownerDeviceId: 'device-abc',
            ownerEntityId: 0,
            title: 'My Bot',
            rateMliPerKtoken: 5000, // ignored — always 0 at creation
        });
        // card_68242d883b51c3b6ceda09cb: id is now JS-generated as 'listing_<hex>'
        expect(listing.id).toMatch(/^listing_[0-9a-f]{24}$/);
        expect(listing.status).toBe('draft');
        const row = globalThis.__rentalFakeState.listings.find(l => l.id === listing.id);
        expect(row.rate_mli_per_ktoken).toBe(0);
        expect(row.interview_passed).toBe(false);
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

    // P0 entity-rebind cascade — Phase 1
    test('snapshots boundRebindCount=0 by default', async () => {
        const listing = await api.createListing({
            ownerUserId: OWNER,
            ownerDeviceId: 'device-rb-default',
            ownerEntityId: 0,
            title: 'Default rebind',
            rateMliPerKtoken: 0,
        });
        const row = globalThis.__rentalFakeState.listings.find(l => l.id === listing.id);
        expect(row.bound_rebind_count).toBe(0);
    });

    test('snapshots boundRebindCount supplied at creation time', async () => {
        const listing = await api.createListing({
            ownerUserId: OWNER,
            ownerDeviceId: 'device-rb-snap',
            ownerEntityId: 1,
            title: 'Snapshot rebind',
            rateMliPerKtoken: 0,
            boundRebindCount: 7,
        });
        const row = globalThis.__rentalFakeState.listings.find(l => l.id === listing.id);
        expect(row.bound_rebind_count).toBe(7);
    });

    test('coerces negative or non-integer boundRebindCount to 0', async () => {
        const a = await api.createListing({
            ownerUserId: OWNER, ownerDeviceId: 'device-rb-neg', ownerEntityId: 0,
            title: 'Neg', rateMliPerKtoken: 0, boundRebindCount: -3,
        });
        const b = await api.createListing({
            ownerUserId: OWNER, ownerDeviceId: 'device-rb-str', ownerEntityId: 0,
            title: 'Str', rateMliPerKtoken: 0, boundRebindCount: 'oops',
        });
        const rowA = globalThis.__rentalFakeState.listings.find(l => l.id === a.id);
        const rowB = globalThis.__rentalFakeState.listings.find(l => l.id === b.id);
        expect(rowA.bound_rebind_count).toBe(0);
        expect(rowB.bound_rebind_count).toBe(0);
    });
});

describe('rental: updateListing', () => {
    async function seed() {
        return api.createListing({
            ownerUserId: OWNER, ownerDeviceId: 'd', ownerEntityId: 0,
            title: 'Seed', rateMliPerKtoken: 5000,
        });
    }

    test('title/description edits are allowed before interview passes', async () => {
        const listing = await seed();
        await api.updateListing(listing.id, OWNER, { title: 'Updated' });
        const row = globalThis.__rentalFakeState.listings.find(l => l.id === listing.id);
        expect(row.title).toBe('Updated');
    });

    test('rate update is blocked before interview passes', async () => {
        const listing = await seed();
        await expect(api.updateListing(listing.id, OWNER, {
            rateMliPerKtoken: 8000,
        })).rejects.toThrow('interview_required_before_pricing');
    });

    test('rate update succeeds after interview_passed=true', async () => {
        const listing = await seed();
        const row = globalThis.__rentalFakeState.listings.find(l => l.id === listing.id);
        row.interview_passed = true;
        await api.updateListing(listing.id, OWNER, { rateMliPerKtoken: 8000 });
        expect(row.rate_mli_per_ktoken).toBe(8000);
    });

    test('min/max duration updates also require interview_passed', async () => {
        const listing = await seed();
        await expect(api.updateListing(listing.id, OWNER, {
            minRentalMinutes: 60,
        })).rejects.toThrow('interview_required_before_pricing');
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
    // Helper: simulate a successful interview + rate set (both gates cleared).
    function markReadyToPublish(listingId, rate = 5000) {
        const row = globalThis.__rentalFakeState.listings.find(l => l.id === listingId);
        row.interview_passed = true;
        row.rate_mli_per_ktoken = rate;
        return row;
    }

    test('cannot publish without interview_passed=true', async () => {
        const listing = await seedDraft();
        await expect(api.publishListing(listing.id, OWNER))
            .rejects.toThrow('interview_not_passed');
    });

    test('cannot publish with interview_passed=true but rate still 0', async () => {
        const listing = await seedDraft();
        const row = globalThis.__rentalFakeState.listings.find(l => l.id === listing.id);
        row.interview_passed = true;
        // rate stays 0 (createListing forces it)
        await expect(api.publishListing(listing.id, OWNER))
            .rejects.toThrow('rate_not_set');
    });

    test('can publish after interview passes AND rate set', async () => {
        const listing = await seedDraft();
        markReadyToPublish(listing.id);
        const pub = await api.publishListing(listing.id, OWNER);
        expect(pub.status).toBe('listed');
    });

    test('non-owner cannot publish', async () => {
        const listing = await seedDraft();
        markReadyToPublish(listing.id);
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
        const row = markReadyToPublish(listing.id);
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
        rowA.rate_mli_per_ktoken = 5000;
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
            row.rate_mli_per_ktoken = 5000 + i * 100;
            await api.publishListing(l.id, OWNER);
        }
        const results = await api.searchMarketplace({ limit: 2 });
        expect(results).toHaveLength(2);
    });
});

describe('rental: refreshPricingMarketSnapshots', () => {
    function seedMarketRow(row) {
        globalThis.__rentalFakeState.listings.push({
            id: row.id,
            owner_user_id: row.ownerUserId || OWNER,
            owner_device_id: row.ownerDeviceId || `device-${row.id}`,
            owner_entity_id: row.ownerEntityId || 0,
            title: row.title || row.id,
            description: '',
            rate_mli_per_ktoken: row.rateMli,
            min_rental_minutes: 30,
            max_rental_minutes: 1440,
            model_detected: row.model,
            capabilities: {},
            benchmark_score: {},
            interview_passed: row.interviewPassed !== false,
            avg_rating: 0,
            total_rentals: 0,
            uptime_pct: 100,
            status: row.status || 'listed',
            soft_pause_until: row.softPauseUntil || null,
            soft_pause_reason: null,
            bound_rebind_count: 0,
            created_at: new Date(),
            updated_at: new Date(),
        });
    }

    test('aggregates active listed rates by detected model family', async () => {
        seedMarketRow({ id: 'sonnet-a', model: 'Claude Sonnet 4', rateMli: 5000 });
        seedMarketRow({ id: 'sonnet-b', model: 'claude-3.5-sonnet', rateMli: 7000 });
        seedMarketRow({ id: 'mini-a', model: 'gpt-4o-mini', rateMli: 2000 });
        seedMarketRow({ id: 'draft-ignored', model: 'Claude Sonnet', rateMli: 9000, status: 'draft' });
        seedMarketRow({ id: 'failed-ignored', model: 'Claude Sonnet', rateMli: 9000, interviewPassed: false });
        seedMarketRow({ id: 'paused-ignored', model: 'Claude Sonnet', rateMli: 9000, softPauseUntil: '2999-01-01T00:00:00.000Z' });
        globalThis.__rentalFakeState.contracts.push(
            { id: 'c1', listing_id: 'sonnet-a', status: 'ended_normal' },
            { id: 'c2', listing_id: 'sonnet-b', status: 'ended_normal' },
            { id: 'c3', listing_id: 'sonnet-b', status: 'ended_early_by_renter' },
        );

        const result = await api.refreshPricingMarketSnapshots({
            snapshotAt: '2026-05-24T00:00:00.000Z',
        });

        expect(result.familyCount).toBe(2);
        expect(result.listingCount).toBe(3);
        expect(result.rows).toEqual([
            {
                modelFamily: 'gpt-4o-mini',
                listingCount: 1,
                rateP25Mli: 2000,
                rateP50Mli: 2000,
                rateP75Mli: 2000,
                rateP95Mli: 2000,
                rentalSuccessRate: null,
            },
            {
                modelFamily: 'sonnet',
                listingCount: 2,
                rateP25Mli: 5000,
                rateP50Mli: 5000,
                rateP75Mli: 7000,
                rateP95Mli: 7000,
                rentalSuccessRate: 0.667,
            },
        ]);
        expect(globalThis.__rentalFakeState.snapshots).toHaveLength(2);
        expect(globalThis.__rentalFakeState.snapshots[1]).toMatchObject({
            model_family: 'sonnet',
            listing_count: 2,
            rate_p50_mli: 5000,
            rental_success_rate: 0.667,
        });
    });
});

describe('rental: filterDriftedListings (P0 Phase 2)', () => {
    const listings = [
        { id: 'l1', title: 'Match', owner_device_id: 'd1', owner_entity_id: 0, bound_rebind_count: 0 },
        { id: 'l2', title: 'Drifted', owner_device_id: 'd1', owner_entity_id: 1, bound_rebind_count: 0 },
        { id: 'l3', title: 'Match-rebound', owner_device_id: 'd2', owner_entity_id: 0, bound_rebind_count: 3 },
        { id: 'l4', title: 'Slot-gone',  owner_device_id: 'd3', owner_entity_id: 0, bound_rebind_count: 0 },
    ];
    const devices = {
        d1: { entities: { 0: { rebindCount: 0 }, 1: { rebindCount: 5 } } },
        d2: { entities: { 0: { rebindCount: 3 } } },
        // d3 is missing → l4 hidden
    };

    test('returns input unchanged if devicesMap is missing', () => {
        expect(api.filterDriftedListings(listings, null)).toEqual(listings);
        expect(api.filterDriftedListings(listings, undefined)).toEqual(listings);
    });

    test('keeps listings whose live rebindCount matches the snapshot', () => {
        const out = api.filterDriftedListings(listings, devices);
        const ids = out.map(l => l.id).sort();
        expect(ids).toEqual(['l1', 'l3']);
    });

    test('drops listings with no matching device or entity slot', () => {
        const out = api.filterDriftedListings(listings, devices);
        expect(out.find(l => l.id === 'l4')).toBeUndefined();
    });

    test('treats missing rebindCount on entity as 0 (legacy entities)', () => {
        const legacyDevices = {
            d1: { entities: { 0: { /* no rebindCount */ } } },
        };
        const matchedLegacy = [{ id: 'lz', owner_device_id: 'd1', owner_entity_id: 0, bound_rebind_count: 0 }];
        expect(api.filterDriftedListings(matchedLegacy, legacyDevices)).toHaveLength(1);
    });

    test('treats missing bound_rebind_count on listing as 0', () => {
        const oldListings = [{ id: 'lo', owner_device_id: 'd1', owner_entity_id: 0 }];
        // d1.0 has rebindCount=0, listing has no bound_rebind_count → both 0 → keep
        expect(api.filterDriftedListings(oldListings, devices)).toHaveLength(1);
    });
});

describe('rental: pauseListingsOnRebind (P0 Phase 3)', () => {
    const DEV_A = 'dev-a';
    const DEV_B = 'dev-b';

    function seedListing({ id, deviceId, entityId, status = 'listed' }) {
        const state = globalThis.__rentalFakeState;
        state.listings.push({
            id, owner_user_id: OWNER,
            owner_device_id: deviceId, owner_entity_id: entityId,
            title: id, description: '', rate_mli_per_ktoken: 1,
            min_rental_minutes: 5, max_rental_minutes: 60,
            interview_passed: true, status,
            bound_rebind_count: 0,
            created_at: new Date(), updated_at: new Date(),
        });
    }

    test('flips draft/interview/listed → paused for matching device+entity', async () => {
        seedListing({ id: 'p1', deviceId: DEV_A, entityId: 0, status: 'draft' });
        seedListing({ id: 'p2', deviceId: DEV_A, entityId: 0, status: 'listed' });
        seedListing({ id: 'p3', deviceId: DEV_A, entityId: 0, status: 'paused' });
        seedListing({ id: 'p4', deviceId: DEV_A, entityId: 0, status: 'delisted' });
        seedListing({ id: 'p5', deviceId: DEV_A, entityId: 1, status: 'listed' }); // different entity
        seedListing({ id: 'p6', deviceId: DEV_B, entityId: 0, status: 'listed' }); // different device

        const paused = await api.pauseListingsOnRebind(DEV_A, 0);
        expect(paused.sort()).toEqual(['p1', 'p2']);

        const state = globalThis.__rentalFakeState;
        expect(state.listings.find(l => l.id === 'p1').status).toBe('paused');
        expect(state.listings.find(l => l.id === 'p2').status).toBe('paused');
        expect(state.listings.find(l => l.id === 'p3').status).toBe('paused'); // unchanged
        expect(state.listings.find(l => l.id === 'p4').status).toBe('delisted'); // unchanged
        expect(state.listings.find(l => l.id === 'p5').status).toBe('listed'); // entity 1 untouched
        expect(state.listings.find(l => l.id === 'p6').status).toBe('listed'); // device B untouched
    });

    test('returns [] when no listings match', async () => {
        const paused = await api.pauseListingsOnRebind('nope-device', 0);
        expect(paused).toEqual([]);
    });

    test('rejects bad inputs without throwing', async () => {
        await expect(api.pauseListingsOnRebind(null, 0)).resolves.toEqual([]);
        await expect(api.pauseListingsOnRebind('dev', null)).resolves.toEqual([]);
        await expect(api.pauseListingsOnRebind('dev', 'not-int')).resolves.toEqual([]);
    });
});

describe('rental: factory hard-fail', () => {
    test('throws when authMiddleware is missing', () => {
        expect(() => rental({ walletModule: stubWallet })).toThrow(/authMiddleware/);
    });
});
