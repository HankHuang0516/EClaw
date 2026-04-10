/**
 * Invite / Referral System Tests — P5 Growth Engine
 */

jest.mock('pg', () => {
    const state = { codes: [], redemptions: [], nextId: 1 };
    globalThis.__inviteState = state;

    function runQuery(sql, params = []) {
        const norm = sql.replace(/\s+/g, ' ').trim();
        if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(norm)) return { rows: [], rowCount: 0 };
        if (/^CREATE (TABLE|INDEX|UNIQUE INDEX)/i.test(norm)) return { rows: [], rowCount: 0 };

        // Get existing code
        if (/^SELECT code, use_count, created_at FROM invite_codes WHERE owner_user_id/i.test(norm)) {
            const c = state.codes.find(x => x.owner_user_id === params[0]);
            return c ? { rows: [{ code: c.code, use_count: c.use_count, created_at: c.created_at }], rowCount: 1 } : { rows: [], rowCount: 0 };
        }

        // Insert code
        if (/^INSERT INTO invite_codes/i.test(norm)) {
            const row = { code: params[0], owner_user_id: params[1], use_count: 0, max_uses: null, expires_at: null, created_at: new Date() };
            if (state.codes.some(c => c.code === row.code)) throw new Error('duplicate key');
            state.codes.push(row);
            return { rows: [{ code: row.code, use_count: 0, created_at: row.created_at }], rowCount: 1 };
        }

        // Lookup code for redeem
        if (/^SELECT code, owner_user_id, max_uses, use_count, expires_at FROM invite_codes WHERE code/i.test(norm)) {
            const c = state.codes.find(x => x.code === params[0]);
            return c ? { rows: [c], rowCount: 1 } : { rows: [], rowCount: 0 };
        }

        // Dup check
        if (/^SELECT id FROM invite_redemptions WHERE invitee_user_id/i.test(norm)) {
            const r = state.redemptions.find(x => x.invitee_user_id === params[0]);
            return r ? { rows: [r], rowCount: 1 } : { rows: [], rowCount: 0 };
        }

        // Insert redemption
        if (/^INSERT INTO invite_redemptions/i.test(norm)) {
            state.redemptions.push({ id: `red-${state.nextId++}`, code: params[0], invitee_user_id: params[1] });
            return { rows: [], rowCount: 1 };
        }

        // Update use_count
        if (/^UPDATE invite_codes SET use_count/i.test(norm)) {
            const c = state.codes.find(x => x.code === params[0]);
            if (c) c.use_count++;
            return { rows: [], rowCount: 1 };
        }

        // Stats
        if (/^SELECT COUNT\(\*\) AS total/i.test(norm)) {
            return { rows: [{ total: '0', total_earned_mli: '0', bonus_earned_mli: '0' }], rowCount: 1 };
        }

        throw new Error(`[fake-pg invite] Unhandled SQL: ${norm}`);
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

const invite = require('../../invite');
const noopAuth = (_r, _s, next) => next();
const mockWallet = { creditTopup: jest.fn().mockResolvedValue({ deduped: false }) };
const api = invite({ authMiddleware: noopAuth, walletModule: mockWallet });

const USER_A = '11111111-1111-1111-1111-111111111111';
const USER_B = '22222222-2222-2222-2222-222222222222';

function reset() {
    const s = globalThis.__inviteState;
    s.codes.length = 0; s.redemptions.length = 0; s.nextId = 1;
    mockWallet.creditTopup.mockClear();
}
beforeEach(() => reset());

describe('P5: getOrCreateMyCode', () => {
    test('creates a new code on first call', async () => {
        const result = await api.getOrCreateMyCode(USER_A);
        expect(result.code).toBeDefined();
        expect(result.code.length).toBeGreaterThanOrEqual(4);
    });

    test('returns same code on second call', async () => {
        const first = await api.getOrCreateMyCode(USER_A);
        const second = await api.getOrCreateMyCode(USER_A);
        expect(second.code).toBe(first.code);
    });
});

describe('P5: redeemCode', () => {
    test('successful redemption credits both parties', async () => {
        const code = await api.getOrCreateMyCode(USER_A);
        const result = await api.redeemCode({ code: code.code, inviteeUserId: USER_B, walletModule: mockWallet });
        expect(result.inviterRewardEcoin).toBe(500);
        expect(result.inviteeRewardEcoin).toBe(100);
        expect(mockWallet.creditTopup).toHaveBeenCalledTimes(2); // inviter + invitee
    });

    test('rejects self-invite', async () => {
        const code = await api.getOrCreateMyCode(USER_A);
        await expect(api.redeemCode({ code: code.code, inviteeUserId: USER_A, walletModule: mockWallet }))
            .rejects.toThrow('self_invite_forbidden');
    });

    test('rejects double redemption by same invitee', async () => {
        const code = await api.getOrCreateMyCode(USER_A);
        await api.redeemCode({ code: code.code, inviteeUserId: USER_B, walletModule: mockWallet });
        await expect(api.redeemCode({ code: code.code, inviteeUserId: USER_B, walletModule: mockWallet }))
            .rejects.toThrow('already_redeemed');
    });

    test('rejects unknown code', async () => {
        await expect(api.redeemCode({ code: 'ZZZZZZ', inviteeUserId: USER_B, walletModule: mockWallet }))
            .rejects.toThrow('code_not_found');
    });

    test('rejects invalid code format', async () => {
        await expect(api.redeemCode({ code: 'ab', inviteeUserId: USER_B, walletModule: mockWallet }))
            .rejects.toThrow('code_invalid');
    });
});

describe('P5: getInviteStats', () => {
    test('returns stats for user with no invites', async () => {
        const stats = await api.getInviteStats(USER_A);
        expect(stats.totalInvited).toBe(0);
    });
});

describe('P5: Factory', () => {
    test('throws when authMiddleware missing', () => {
        expect(() => invite({})).toThrow(/authMiddleware/);
    });
});

describe('P5: Fraud detection (pure functions)', () => {
    const fraud = require('../../fraud-detection');

    test('blocks self-rental', () => {
        const r = fraud.evaluateRentalRisk({ ownerUserId: USER_A, renterUserId: USER_A, depositMli: 1000 });
        expect(r.allowed).toBe(false);
        expect(r.flags).toContain('self_rental');
    });

    test('new account gets +50% deposit premium', () => {
        const r = fraud.evaluateRentalRisk({
            ownerUserId: USER_A, renterUserId: USER_B,
            renterCreatedAt: new Date(), // just now
            depositMli: 10000,
        });
        expect(r.flags).toContain('new_account');
        expect(r.adjustedDepositMli).toBe(15000); // 10000 * 1.5
    });

    test('old account keeps original deposit', () => {
        const oldDate = new Date(Date.now() - 30 * 24 * 3600 * 1000); // 30 days ago
        const r = fraud.evaluateRentalRisk({
            ownerUserId: USER_A, renterUserId: USER_B,
            renterCreatedAt: oldDate,
            depositMli: 10000,
        });
        expect(r.flags).not.toContain('new_account');
        expect(r.adjustedDepositMli).toBe(10000);
    });

    test('review weight is reduced for new accounts', () => {
        const newWeight = fraud.computeReviewWeight(new Date());
        expect(newWeight).toBe(0.3);

        const oldWeight = fraud.computeReviewWeight(new Date(Date.now() - 30 * 24 * 3600 * 1000));
        expect(oldWeight).toBe(1);
    });
});
