/**
 * Trust & Risk Management Tests — P3 reviews/disputes + P4 blacklist/cooldown
 */

jest.mock('pg', () => {
    const state = {
        reviews: [],
        disputes: [],
        credits: new Map(),
        blacklist: [],
        cooldowns: [],
        contracts: [],
        listings: [],
        users: new Map(),
        fraudLog: [],
        nextId: 1,
    };
    globalThis.__trustState = state;

    function runQuery(sql, params = []) {
        const norm = sql.replace(/\s+/g, ' ').trim();
        if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(norm)) return { rows: [], rowCount: 0 };
        if (/^CREATE (TABLE|INDEX|UNIQUE INDEX)/i.test(norm)) return { rows: [], rowCount: 0 };
        if (/^ALTER TABLE/i.test(norm)) return { rows: [], rowCount: 0 };

        // Contract lookup for review
        if (/^SELECT id, listing_id, renter_user_id, owner_user_id, status\s+FROM rental_contracts/i.test(norm)) {
            const c = state.contracts.find(x => x.id === params[0]);
            return c ? { rows: [c], rowCount: 1 } : { rows: [], rowCount: 0 };
        }

        // Review exists check
        if (/^SELECT id FROM bot_reviews WHERE contract_id/i.test(norm)) {
            const r = state.reviews.find(x => x.contract_id === params[0]);
            return r ? { rows: [r], rowCount: 1 } : { rows: [], rowCount: 0 };
        }

        // Insert review
        if (/^INSERT INTO bot_reviews/i.test(norm)) {
            const row = { id: `rev-${state.nextId++}`, contract_id: params[0], listing_id: params[1], reviewer_user_id: params[2], owner_user_id: params[3], rating: params[4], comment: params[5], created_at: new Date() };
            state.reviews.push(row);
            return { rows: [{ id: row.id, rating: row.rating, created_at: row.created_at }], rowCount: 1 };
        }

        // Update listing avg
        if (/^UPDATE bot_listings SET\s+avg_rating/i.test(norm)) {
            return { rows: [], rowCount: 1 };
        }

        // Get listing reviews
        if (/^SELECT id, rating, comment, created_at FROM bot_reviews/i.test(norm)) {
            const rows = state.reviews.filter(r => r.listing_id === params[0]).slice(0, params[1]);
            return { rows, rowCount: rows.length };
        }

        // Insert dispute
        if (/^INSERT INTO disputes/i.test(norm)) {
            const row = { id: `disp-${state.nextId++}`, contract_id: params[0], raised_by: params[1], type: params[2], evidence: params[3], status: 'open', sla_resolve_by: params[5], created_at: new Date() };
            state.disputes.push(row);
            return { rows: [{ id: row.id, status: row.status, sla_resolve_by: row.sla_resolve_by, created_at: row.created_at }], rowCount: 1 };
        }

        // Resolve dispute
        if (/^UPDATE disputes SET\s+status = 'resolved'/i.test(norm)) {
            const d = state.disputes.find(x => x.id === params[0] && ['open', 'investigating'].includes(x.status));
            if (!d) return { rows: [], rowCount: 0 };
            d.status = 'resolved'; d.resolution = params[1]; d.resolved_at = new Date();
            return { rows: [{ id: d.id, status: d.status, resolved_at: d.resolved_at }], rowCount: 1 };
        }

        // Reject dispute
        if (/^UPDATE disputes SET\s+status = 'rejected'/i.test(norm)) {
            const d = state.disputes.find(x => x.id === params[0] && ['open', 'investigating'].includes(x.status));
            if (!d) return { rows: [], rowCount: 0 };
            d.status = 'rejected';
            return { rows: [{ id: d.id, status: d.status }], rowCount: 1 };
        }

        // My disputes
        if (/FROM disputes WHERE raised_by/i.test(norm)) {
            const rows = state.disputes.filter(d => d.raised_by === params[0]).slice(0, params[1]);
            return { rows, rowCount: rows.length };
        }

        // Open disputes (admin)
        if (/FROM disputes d\s+WHERE d.status IN/i.test(norm)) {
            const rows = state.disputes.filter(d => ['open', 'investigating'].includes(d.status)).slice(0, params[0]);
            return { rows, rowCount: rows.length };
        }

        // Credit score upsert
        if (/^INSERT INTO user_credit_scores/i.test(norm)) {
            if (!state.credits.has(params[0])) state.credits.set(params[0], { score: 5 });
            return { rows: [], rowCount: 1 };
        }
        if (/^WITH stats AS/i.test(norm) && /UPDATE user_credit_scores/i.test(norm)) {
            return { rows: [{ score: '5.00', avg_rating_received: '4.50' }], rowCount: 1 };
        }
        if (/^SELECT \* FROM user_credit_scores/i.test(norm)) {
            const c = state.credits.get(params[0]);
            return c ? { rows: [{ user_id: params[0], ...c }], rowCount: 1 } : { rows: [], rowCount: 0 };
        }

        // Blacklist
        if (/^SELECT id FROM user_blacklist/i.test(norm)) {
            const b = state.blacklist.find(x => x.user_id === params[0]);
            return b ? { rows: [b], rowCount: 1 } : { rows: [], rowCount: 0 };
        }
        if (/^INSERT INTO user_blacklist/i.test(norm)) {
            const row = { id: `bl-${state.nextId++}`, user_id: params[0], reason: params[1], expires_at: params[2] };
            state.blacklist.push(row);
            return { rows: [{ id: row.id, expires_at: row.expires_at }], rowCount: 1 };
        }
        if (/^DELETE FROM user_blacklist/i.test(norm)) {
            state.blacklist = state.blacklist.filter(x => x.user_id !== params[0]);
            return { rows: [], rowCount: 1 };
        }

        // Cooldown
        if (/^SELECT cooldown_until FROM rental_cooldowns/i.test(norm)) {
            const c = state.cooldowns.find(x => x.user_id === params[0] && x.listing_id === params[1]);
            if (c && new Date(c.cooldown_until) > new Date()) return { rows: [c], rowCount: 1 };
            return { rows: [], rowCount: 0 };
        }
        if (/^INSERT INTO rental_cooldowns/i.test(norm)) {
            state.cooldowns.push({ user_id: params[0], listing_id: params[1], cooldown_until: params[2] });
            return { rows: [], rowCount: 1 };
        }

        // Age confirmation
        if (/^SELECT age_confirmed_at FROM user_accounts/i.test(norm)) {
            const u = state.users.get(params[0]);
            return u ? { rows: [u], rowCount: 1 } : { rows: [], rowCount: 0 };
        }
        if (/^UPDATE user_accounts SET age_confirmed_at/i.test(norm)) {
            const u = state.users.get(params[0]) || {};
            u.age_confirmed_at = new Date();
            state.users.set(params[0], u);
            return { rows: [], rowCount: 1 };
        }
        if (/^INSERT INTO fraud_detection_log/i.test(norm)) {
            // SQL may use literal strings for rule_name, so extract from norm
            const ruleMatch = norm.match(/'([a-z_]+)'/);
            state.fraudLog.push({ user_id: params[0], rule_name: ruleMatch ? ruleMatch[1] : params[1] });
            return { rows: [], rowCount: 1 };
        }

        throw new Error(`[fake-pg trust] Unhandled SQL: ${norm}`);
    }

    class FakePool {
        async connect() { return { query: async (s, p) => runQuery(s, p), release: () => {} }; }
        async query(s, p) { return runQuery(s, p); }
    }
    return { Pool: jest.fn().mockImplementation(() => new FakePool()) };
});

jest.mock('fs', () => {
    const real = jest.requireActual('fs');
    return { ...real, readFileSync: jest.fn((p, e) => p.endsWith('.sql') ? '' : real.readFileSync(p, e)) };
});

const trust = require('../../trust');
const noopAuth = (_r, _s, next) => next();
const api = trust({ authMiddleware: noopAuth });

const RENTER = '11111111-1111-1111-1111-111111111111';
const OWNER = '22222222-2222-2222-2222-222222222222';

function reset() {
    const s = globalThis.__trustState;
    s.reviews.length = 0; s.disputes.length = 0; s.credits.clear();
    s.blacklist.length = 0; s.cooldowns.length = 0; s.contracts.length = 0;
    s.users.clear(); s.fraudLog.length = 0; s.nextId = 1;
}
beforeEach(() => reset());

describe('P3: Reviews', () => {
    beforeEach(() => {
        globalThis.__trustState.contracts.push({
            id: 'c-1', listing_id: 'l-1', renter_user_id: RENTER,
            owner_user_id: OWNER, status: 'ended_normal',
        });
    });

    test('submits a valid review', async () => {
        const r = await api.submitReview({ contractId: 'c-1', reviewerUserId: RENTER, rating: 4, comment: 'Great bot!' });
        expect(r.rating).toBe(4);
    });

    test('rejects review from non-renter', async () => {
        await expect(api.submitReview({ contractId: 'c-1', reviewerUserId: OWNER, rating: 5 }))
            .rejects.toThrow('review_forbidden');
    });

    test('rejects duplicate review', async () => {
        await api.submitReview({ contractId: 'c-1', reviewerUserId: RENTER, rating: 3 });
        await expect(api.submitReview({ contractId: 'c-1', reviewerUserId: RENTER, rating: 5 }))
            .rejects.toThrow('review_already_exists');
    });

    test('rejects invalid rating', async () => {
        await expect(api.submitReview({ contractId: 'c-1', reviewerUserId: RENTER, rating: 6 }))
            .rejects.toThrow('rating_invalid');
        await expect(api.submitReview({ contractId: 'c-1', reviewerUserId: RENTER, rating: 0 }))
            .rejects.toThrow('rating_invalid');
    });

    test('rejects review on active contract', async () => {
        globalThis.__trustState.contracts[0].status = 'active';
        await expect(api.submitReview({ contractId: 'c-1', reviewerUserId: RENTER, rating: 4 }))
            .rejects.toThrow('contract_not_ended');
    });
});

describe('P3: Disputes', () => {
    test('opens a valid dispute', async () => {
        const d = await api.openDispute({ contractId: 'c-1', raisedBy: RENTER, type: 'bot_crash' });
        expect(d.status).toBe('open');
        expect(d.sla_resolve_by).toBeDefined();
    });

    test('rejects invalid dispute type', async () => {
        await expect(api.openDispute({ contractId: 'c-1', raisedBy: RENTER, type: 'fake_type' }))
            .rejects.toThrow('dispute_type_invalid');
    });

    test('resolves a dispute', async () => {
        const d = await api.openDispute({ contractId: 'c-1', raisedBy: RENTER, type: 'bot_quality' });
        const resolved = await api.resolveDispute({ disputeId: d.id, resolution: 'Bot was fine', resolvedBy: OWNER });
        expect(resolved.status).toBe('resolved');
    });

    test('rejects resolving already-closed dispute', async () => {
        const d = await api.openDispute({ contractId: 'c-1', raisedBy: RENTER, type: 'financial' });
        await api.resolveDispute({ disputeId: d.id, resolution: 'done', resolvedBy: OWNER });
        await expect(api.resolveDispute({ disputeId: d.id, resolution: 'again', resolvedBy: OWNER }))
            .rejects.toThrow('dispute_not_found_or_closed');
    });

    test('rejects a dispute', async () => {
        const d = await api.openDispute({ contractId: 'c-1', raisedBy: RENTER, type: 'bot_crash' });
        const result = await api.rejectDispute({ disputeId: d.id, resolution: 'invalid claim', resolvedBy: OWNER });
        expect(result.status).toBe('rejected');
    });
});

describe('P3: Credit scores', () => {
    test('recalculate returns a score', async () => {
        const result = await api.recalculateCreditScore(RENTER);
        expect(result.score).toBeDefined();
    });

    test('getCreditScore returns null for unknown user', async () => {
        const result = await api.getCreditScore('unknown-uuid-1234-5678');
        expect(result).toBeNull();
    });
});

describe('P4: Blacklist', () => {
    test('adds and checks blacklist', async () => {
        expect(await api.isBlacklisted(RENTER)).toBe(false);
        await api.addToBlacklist({ userId: RENTER, reason: 'fraud', durationDays: 30 });
        expect(await api.isBlacklisted(RENTER)).toBe(true);
    });

    test('removes from blacklist', async () => {
        await api.addToBlacklist({ userId: RENTER, reason: 'test' });
        await api.removeFromBlacklist(RENTER);
        expect(await api.isBlacklisted(RENTER)).toBe(false);
    });
});

describe('P4: Cooldown', () => {
    test('no cooldown initially', async () => {
        const result = await api.checkCooldown(RENTER, 'l-1');
        expect(result.blocked).toBe(false);
    });

    test('sets and checks cooldown', async () => {
        await api.setCooldown(RENTER, 'l-1');
        const result = await api.checkCooldown(RENTER, 'l-1');
        expect(result.blocked).toBe(true);
        expect(result.until).toBeDefined();
    });
});

describe('P4: Age confirmation', () => {
    test('unconfirmed user returns false', async () => {
        globalThis.__trustState.users.set(RENTER, { age_confirmed_at: null });
        const r = await api.checkAgeConfirmation(RENTER);
        expect(r.confirmed).toBe(false);
    });

    test('confirms age and records to fraud log', async () => {
        globalThis.__trustState.users.set(RENTER, { age_confirmed_at: null });
        await api.confirmAge(RENTER, '127.0.0.1');
        const r = await api.checkAgeConfirmation(RENTER);
        expect(r.confirmed).toBe(true);
        expect(globalThis.__trustState.fraudLog.length).toBeGreaterThan(0);
        expect(globalThis.__trustState.fraudLog[0].rule_name).toBe('age_confirmation');
    });
});

describe('P3: Factory', () => {
    test('throws when authMiddleware missing', () => {
        expect(() => trust({})).toThrow(/authMiddleware/);
    });
});
