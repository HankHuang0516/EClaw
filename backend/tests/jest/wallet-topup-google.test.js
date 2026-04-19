/**
 * Google Play androidpublisher v3 verification tests.
 *
 * Covers the 8 cases from the spec:
 *   1. Happy path: purchaseState=0 → verifyGooglePurchase returns
 *      { valid:true, orderId }; endpoint credits the ledger using
 *      Google's orderId (NOT the raw purchaseToken) as external_txn_id.
 *   2. purchaseState=1 (canceled) → 402 purchase_not_verified.
 *   3. purchaseState=2 (pending)  → 402 purchase_not_verified.
 *   4. Token exchange HTTP 401   → 500 google_auth_failed (detail masked).
 *   5. GOOGLE_PLAY_SERVICE_ACCOUNT unset → FAIL-CLOSED 500 google_auth_failed.
 *      (We chose fail-closed over fallback-to-trust; see PR body.)
 *   6. Access-token cache: two successive verifications → only ONE POST
 *      to oauth2.googleapis.com/token.
 *   7. Dedup: same purchaseToken credited twice → second call is deduped
 *      (same orderId in response; wallet balance unchanged).
 *   8. Acknowledge is fire-and-forget: mock ack to reject → endpoint
 *      still returns 200 and ledger is still credited.
 *
 * Strategy: reuse the wallet.test.js pg simulator (same jest.mock shape),
 * mock `global.fetch` per test, and drive the route via supertest.
 */

// ── In-memory pg simulator (mirrors wallet.test.js) ─────────────────────
jest.mock('pg', () => {
    const state = {
        wallets: new Map(),
        ledger: [],
        nextLedgerId: 1,
        topupOrders: [],
        nextOrderId: 1,
        userAccounts: new Map(),
    };
    globalThis.__walletFakeState = state;

    function ensureWallet(userId) {
        if (!state.wallets.has(userId)) {
            state.wallets.set(userId, {
                balance_mli: 0n,
                held_mli: 0n,
                lifetime_earned_mli: 0n,
                lifetime_spent_mli: 0n,
            });
        }
    }

    function runQuery(sql, params = []) {
        const norm = sql.replace(/\s+/g, ' ').trim();
        if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(norm)) return { rows: [], rowCount: 0 };
        if (/^CREATE (TABLE|INDEX|UNIQUE INDEX)/i.test(norm)) return { rows: [], rowCount: 0 };
        if (/^INSERT INTO wallets \(user_id\) VALUES/i.test(norm)) {
            ensureWallet(params[0]);
            return { rows: [], rowCount: 1 };
        }
        if (/^SELECT .* FROM wallet_ledger WHERE idempotency_key = \$1$/i.test(norm)) {
            const match = state.ledger.find(r => r.idempotency_key === params[0]);
            return { rows: match ? [match] : [], rowCount: match ? 1 : 0 };
        }
        if (/^SELECT balance_mli, held_mli FROM wallets WHERE user_id = \$1 FOR UPDATE$/i.test(norm)) {
            const w = state.wallets.get(params[0]);
            if (!w) return { rows: [], rowCount: 0 };
            return {
                rows: [{ balance_mli: w.balance_mli.toString(), held_mli: w.held_mli.toString() }],
                rowCount: 1,
            };
        }
        if (/^UPDATE wallets SET balance_mli = \$1, held_mli = \$2/i.test(norm)) {
            const [bal, held, earnedInc, spentInc, userId] = params;
            const w = state.wallets.get(userId);
            if (!w) return { rows: [], rowCount: 0 };
            w.balance_mli = BigInt(bal);
            w.held_mli = BigInt(held);
            w.lifetime_earned_mli += BigInt(earnedInc);
            w.lifetime_spent_mli += BigInt(spentInc);
            return { rows: [], rowCount: 1 };
        }
        if (/^INSERT INTO wallet_ledger/i.test(norm)) {
            const [userId, deltaMli, heldDeltaMli, balanceAfter, heldAfter,
                   type, refType, refId, counterparty, note, idemKey] = params;
            if (state.ledger.some(r => r.idempotency_key === idemKey)) {
                throw new Error('duplicate key value violates unique constraint "wallet_ledger_idempotency_key_key"');
            }
            const row = {
                id: state.nextLedgerId++,
                user_id: userId,
                delta_mli: String(deltaMli),
                held_delta_mli: String(heldDeltaMli),
                balance_after_mli: String(balanceAfter),
                held_after_mli: String(heldAfter),
                type, ref_type: refType, ref_id: refId,
                counterparty_user_id: counterparty,
                note, idempotency_key: idemKey,
                created_at: new Date(),
            };
            state.ledger.push(row);
            return { rows: [{ id: row.id, created_at: row.created_at }], rowCount: 1 };
        }
        if (/^SELECT balance_mli, held_mli, lifetime_earned_mli, lifetime_spent_mli FROM wallets/i.test(norm)) {
            const w = state.wallets.get(params[0]);
            if (!w) return { rows: [], rowCount: 0 };
            return {
                rows: [{
                    balance_mli: w.balance_mli.toString(),
                    held_mli: w.held_mli.toString(),
                    lifetime_earned_mli: w.lifetime_earned_mli.toString(),
                    lifetime_spent_mli: w.lifetime_spent_mli.toString(),
                }],
                rowCount: 1,
            };
        }
        if (/^SELECT id, status, ecoin_total_mli FROM topup_orders WHERE channel = \$1 AND external_txn_id = \$2$/i.test(norm)) {
            const [channel, txnId] = params;
            const match = state.topupOrders.find(o => o.channel === channel && o.external_txn_id === txnId);
            return {
                rows: match ? [{ id: match.id, status: match.status, ecoin_total_mli: String(match.ecoin_total_mli) }] : [],
                rowCount: match ? 1 : 0,
            };
        }
        if (/^INSERT INTO topup_orders/i.test(norm)) {
            const [userId, channel, amountTwd, baseMli, bonusMli, totalMli, externalTxnId, externalRaw] = params;
            const id = `order-${state.nextOrderId++}`;
            const row = {
                id, user_id: userId, channel, amount_twd: amountTwd,
                ecoin_base_mli: baseMli, ecoin_bonus_mli: bonusMli, ecoin_total_mli: totalMli,
                status: 'pending', external_txn_id: externalTxnId, external_raw: externalRaw,
                created_at: new Date(), paid_at: null,
            };
            state.topupOrders.push(row);
            return { rows: [{ id, status: 'pending', ecoin_total_mli: String(totalMli) }], rowCount: 1 };
        }
        if (/^SELECT id, status FROM topup_orders WHERE id = \$1 FOR UPDATE$/i.test(norm)) {
            const order = state.topupOrders.find(o => o.id === params[0]);
            if (!order) return { rows: [], rowCount: 0 };
            return { rows: [{ id: order.id, status: order.status }], rowCount: 1 };
        }
        if (/^UPDATE topup_orders SET status = 'paid', paid_at = NOW\(\) WHERE id = \$1$/i.test(norm)) {
            const order = state.topupOrders.find(o => o.id === params[0]);
            if (!order) return { rows: [], rowCount: 0 };
            order.status = 'paid';
            order.paid_at = new Date();
            return { rows: [], rowCount: 1 };
        }
        throw new Error(`[fake-pg] Unhandled SQL: ${norm}`);
    }

    class FakeClient {
        async query(sql, params) { return runQuery(sql, params); }
        release() { /* noop */ }
    }
    class FakePool {
        async connect() { return new FakeClient(); }
        async query(sql, params) { return runQuery(sql, params); }
    }
    return { Pool: jest.fn().mockImplementation(() => new FakePool()) };
});

jest.mock('fs', () => {
    const real = jest.requireActual('fs');
    return {
        ...real,
        readFileSync: jest.fn((p, enc) => {
            if (typeof p === 'string' && p.endsWith('wallet_schema.sql')) return '';
            return real.readFileSync(p, enc);
        }),
    };
});

const fake = { get state() { return globalThis.__walletFakeState; } };

// ── Test-only RSA keypair for GSA (never used outside this file) ────────
const { generateKeyPairSync } = require('crypto');
const { privateKey: _testPrivateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const TEST_PRIVATE_KEY_PEM = _testPrivateKey.export({ type: 'pkcs8', format: 'pem' });

const FAKE_GSA = {
    type: 'service_account',
    project_id: 'eclaw-play-billing',
    private_key_id: 'test-kid',
    private_key: TEST_PRIVATE_KEY_PEM,
    client_email: 'eclaw-play-billing-verifier@eclaw-play-billing.iam.gserviceaccount.com',
    client_id: '1234567890',
    auth_uri: 'https://accounts.google.com/o/oauth2/auth',
    token_uri: 'https://oauth2.googleapis.com/token',
};

const ALICE = '11111111-1111-1111-1111-111111111111';

// ── Test harness ────────────────────────────────────────────────────────
const express = require('express');
const supertest = require('supertest');
const wallet = require('../../wallet');

function resetState() {
    fake.state.wallets.clear();
    fake.state.ledger.length = 0;
    fake.state.nextLedgerId = 1;
    fake.state.topupOrders.length = 0;
    fake.state.nextOrderId = 1;
    fake.state.userAccounts.clear();
}

function buildApp({ user = { userId: ALICE }, serverLog } = {}) {
    const app = express();
    app.use(express.json());
    const fakeAuth = (req, _res, next) => { if (user) req.user = user; next(); };
    const w = wallet({ authMiddleware: fakeAuth, serverLog: serverLog || (() => {}) });
    app.use('/api/wallet', w.router);
    return { app, walletApi: w };
}

/**
 * Build a single-shot fetch mock that dispatches based on URL. Each call
 * increments a counter so tests can assert token-cache behavior.
 */
function makeFetchMock({ onToken, onProductsGet, onAck, tokenResponder } = {}) {
    const calls = { token: 0, productsGet: 0, ack: 0, urls: [] };
    global.fetch = jest.fn().mockImplementation(async (url, opts = {}) => {
        calls.urls.push(url);
        if (typeof url === 'string' && url.includes('oauth2.googleapis.com/token')) {
            calls.token += 1;
            if (tokenResponder) return tokenResponder(url, opts, calls);
            if (onToken) return onToken(url, opts, calls);
            return {
                ok: true, status: 200,
                json: async () => ({ access_token: `at-${calls.token}`, expires_in: 3600, token_type: 'Bearer' }),
            };
        }
        if (typeof url === 'string' && url.endsWith(':acknowledge')) {
            calls.ack += 1;
            if (onAck) return onAck(url, opts, calls);
            return { ok: true, status: 204, json: async () => ({}) };
        }
        if (typeof url === 'string' && url.includes('/purchases/products/')) {
            calls.productsGet += 1;
            if (onProductsGet) return onProductsGet(url, opts, calls);
            return { ok: true, status: 200, json: async () => ({ purchaseState: 0, orderId: 'GPA.0000-0000-0000-0001' }) };
        }
        throw new Error(`[fetch-mock] unexpected URL: ${url}`);
    });
    return calls;
}

beforeEach(() => {
    resetState();
    process.env.GOOGLE_PLAY_SERVICE_ACCOUNT = JSON.stringify(FAKE_GSA);
    delete process.env.GOOGLE_PLAY_ALLOW_UNVERIFIED;
    if (wallet._resetGoogleCache) wallet._resetGoogleCache();
});

afterEach(() => {
    delete process.env.GOOGLE_PLAY_SERVICE_ACCOUNT;
    delete process.env.GOOGLE_PLAY_ALLOW_UNVERIFIED;
    if (global.fetch && global.fetch.mockRestore) global.fetch.mockRestore();
});

// ── Tests ────────────────────────────────────────────────────────────────

describe('wallet: verifyGooglePurchase helper', () => {
    test('case 1: happy path — purchaseState=0 returns { valid:true, orderId }', async () => {
        makeFetchMock({
            onProductsGet: () => ({
                ok: true, status: 200,
                json: async () => ({
                    purchaseState: 0,
                    consumptionState: 0,
                    acknowledgementState: 0,
                    orderId: 'GPA.3311-0000-0000-0001',
                    purchaseTimeMillis: String(Date.now()),
                }),
            }),
        });
        const result = await wallet.verifyGooglePurchase(
            wallet.GOOGLE_PACKAGE_NAME,
            'ec.topup.starter',
            'fake-purchase-token-happy'
        );
        expect(result.valid).toBe(true);
        expect(result.orderId).toBe('GPA.3311-0000-0000-0001');
        expect(result.purchaseState).toBe(0);
    });

    test('case 2: purchaseState=1 (canceled) throws google_token_canceled', async () => {
        makeFetchMock({
            onProductsGet: () => ({
                ok: true, status: 200,
                json: async () => ({ purchaseState: 1, orderId: 'GPA.canceled' }),
            }),
        });
        await expect(wallet.verifyGooglePurchase(
            wallet.GOOGLE_PACKAGE_NAME, 'ec.topup.starter', 'token-canceled'
        )).rejects.toThrow('google_token_canceled');
    });

    test('case 3: purchaseState=2 (pending) throws google_token_pending', async () => {
        makeFetchMock({
            onProductsGet: () => ({
                ok: true, status: 200,
                json: async () => ({ purchaseState: 2, orderId: 'GPA.pending' }),
            }),
        });
        await expect(wallet.verifyGooglePurchase(
            wallet.GOOGLE_PACKAGE_NAME, 'ec.topup.starter', 'token-pending'
        )).rejects.toThrow('google_token_pending');
    });

    test('case 4: token exchange HTTP 401 throws google_auth_failed', async () => {
        makeFetchMock({
            tokenResponder: () => ({ ok: false, status: 401, json: async () => ({ error: 'invalid_grant' }) }),
        });
        await expect(wallet.verifyGooglePurchase(
            wallet.GOOGLE_PACKAGE_NAME, 'ec.topup.starter', 'token-bad-jwt'
        )).rejects.toThrow('google_auth_failed');
    });

    test('case 6: access-token cache — two verifications → one POST to oauth2/token', async () => {
        const calls = makeFetchMock();  // default: both GETs succeed with purchaseState=0
        await wallet.verifyGooglePurchase(
            wallet.GOOGLE_PACKAGE_NAME, 'ec.topup.starter', 'tok-cache-a'
        );
        await wallet.verifyGooglePurchase(
            wallet.GOOGLE_PACKAGE_NAME, 'ec.topup.starter', 'tok-cache-b'
        );
        expect(calls.token).toBe(1);       // only one token exchange
        expect(calls.productsGet).toBe(2); // two product lookups
    });
});

describe('wallet: POST /topup/verify-google (integration)', () => {
    test('case 1: happy path → credits wallet and uses Google orderId as external_txn_id', async () => {
        makeFetchMock({
            onProductsGet: () => ({
                ok: true, status: 200,
                json: async () => ({
                    purchaseState: 0,
                    consumptionState: 0,
                    acknowledgementState: 0,
                    orderId: 'GPA.REAL-ORDER-0001',
                }),
            }),
        });
        const { app } = buildApp();
        const res = await supertest(app).post('/api/wallet/topup/verify-google')
            .send({ productId: 'ec.topup.starter', purchaseToken: 'user-facing-token-0001' })
            .expect(200);

        expect(res.body.success).toBe(true);
        expect(res.body.order.status).toBe('paid');
        expect(res.body.order.ecoinTotal).toBe(9450);  // 9000 + 5% bonus (450)
        expect(res.body.order.deduped).toBe(false);

        // Order MUST be keyed by Google's orderId, not the raw purchaseToken.
        const orderRow = fake.state.topupOrders[0];
        expect(orderRow.external_txn_id).toBe('GPA.REAL-ORDER-0001');
        expect(orderRow.external_txn_id).not.toBe('user-facing-token-0001');
    });

    test('case 2: canceled purchase → 402 purchase_not_verified', async () => {
        makeFetchMock({
            onProductsGet: () => ({
                ok: true, status: 200,
                json: async () => ({ purchaseState: 1, orderId: 'GPA.cancel' }),
            }),
        });
        const { app } = buildApp();
        const res = await supertest(app).post('/api/wallet/topup/verify-google')
            .send({ productId: 'ec.topup.starter', purchaseToken: 'token-cancel-0002' })
            .expect(402);
        expect(res.body.error).toBe('purchase_not_verified');
        expect(res.body.details.code).toBe('google_token_canceled');
        // No ledger row written, no order created.
        expect(fake.state.ledger).toHaveLength(0);
        expect(fake.state.topupOrders).toHaveLength(0);
    });

    test('case 3: pending purchase → 402 purchase_not_verified', async () => {
        makeFetchMock({
            onProductsGet: () => ({
                ok: true, status: 200,
                json: async () => ({ purchaseState: 2 }),
            }),
        });
        const { app } = buildApp();
        const res = await supertest(app).post('/api/wallet/topup/verify-google')
            .send({ productId: 'ec.topup.starter', purchaseToken: 'token-pending-0003' })
            .expect(402);
        expect(res.body.error).toBe('purchase_not_verified');
        expect(res.body.details.code).toBe('google_token_pending');
        expect(fake.state.ledger).toHaveLength(0);
    });

    test('case 4: bad JWT / 401 from Google → 500 google_auth_failed (detail masked)', async () => {
        makeFetchMock({
            tokenResponder: () => ({ ok: false, status: 401, json: async () => ({ error: 'invalid_grant' }) }),
        });
        const { app } = buildApp();
        const res = await supertest(app).post('/api/wallet/topup/verify-google')
            .send({ productId: 'ec.topup.starter', purchaseToken: 'token-auth-fail' })
            .expect(500);
        expect(res.body.error).toBe('google_auth_failed');
        // The upstream "invalid_grant" reason is NOT leaked to the client.
        expect(JSON.stringify(res.body)).not.toMatch(/invalid_grant/);
        expect(fake.state.ledger).toHaveLength(0);
    });

    test('case 5: GOOGLE_PLAY_SERVICE_ACCOUNT unset → FAIL-CLOSED (500 google_auth_failed)', async () => {
        delete process.env.GOOGLE_PLAY_SERVICE_ACCOUNT;
        if (wallet._resetGoogleCache) wallet._resetGoogleCache();
        makeFetchMock();  // won't be called
        const { app } = buildApp();
        const res = await supertest(app).post('/api/wallet/topup/verify-google')
            .send({ productId: 'ec.topup.starter', purchaseToken: 'token-no-gsa' })
            .expect(500);
        expect(res.body.error).toBe('google_auth_failed');
        expect(fake.state.ledger).toHaveLength(0);
        expect(fake.state.topupOrders).toHaveLength(0);
    });

    test('case 5b: GOOGLE_PLAY_ALLOW_UNVERIFIED=1 + no GSA → legacy trust path (audited fallback)', async () => {
        delete process.env.GOOGLE_PLAY_SERVICE_ACCOUNT;
        process.env.GOOGLE_PLAY_ALLOW_UNVERIFIED = '1';
        if (wallet._resetGoogleCache) wallet._resetGoogleCache();
        makeFetchMock();  // won't be called
        const audited = [];
        const { app } = buildApp({ serverLog: (lvl, tag, msg, meta) => audited.push({ lvl, tag, msg, meta }) });
        const res = await supertest(app).post('/api/wallet/topup/verify-google')
            .send({ productId: 'ec.topup.starter', purchaseToken: 'token-rollback-path' })
            .expect(200);
        expect(res.body.success).toBe(true);
        const warn = audited.find(a => a.lvl === 'warn' && /skipped/.test(a.msg));
        expect(warn).toBeDefined();
    });

    test('case 6: same-session cache — two verifications hit token endpoint once', async () => {
        const calls = makeFetchMock({
            onProductsGet: (url) => ({
                ok: true, status: 200,
                json: async () => {
                    // Distinct orderIds so dedup doesn't hide the second call.
                    const orderSuffix = url.includes('token-cache-2') ? '2' : '1';
                    return { purchaseState: 0, orderId: `GPA.CACHE-${orderSuffix}` };
                },
            }),
        });
        const { app } = buildApp();
        await supertest(app).post('/api/wallet/topup/verify-google')
            .send({ productId: 'ec.topup.starter', purchaseToken: 'token-cache-1' })
            .expect(200);
        await supertest(app).post('/api/wallet/topup/verify-google')
            .send({ productId: 'ec.topup.starter', purchaseToken: 'token-cache-2' })
            .expect(200);
        expect(calls.token).toBe(1);       // token exchange happened exactly once
        expect(calls.productsGet).toBe(2); // two separate purchase lookups
    });

    test('case 7: dedup — same purchaseToken → second call returns deduped, no double credit', async () => {
        makeFetchMock({
            onProductsGet: () => ({
                ok: true, status: 200,
                json: async () => ({
                    purchaseState: 0,
                    orderId: 'GPA.DEDUP-0001',   // same orderId both times
                }),
            }),
        });
        const { app, walletApi } = buildApp();
        const first = await supertest(app).post('/api/wallet/topup/verify-google')
            .send({ productId: 'ec.topup.starter', purchaseToken: 'token-dedup' })
            .expect(200);
        expect(first.body.order.deduped).toBe(false);

        const second = await supertest(app).post('/api/wallet/topup/verify-google')
            .send({ productId: 'ec.topup.starter', purchaseToken: 'token-dedup' })
            .expect(200);
        expect(second.body.order.deduped).toBe(true);

        // Wallet balance is credited exactly once (9450 e幣 = 9,450,000 mli).
        const bal = await walletApi.getBalance(ALICE);
        expect(bal.balance_ecoin).toBe(9450);
        expect(fake.state.ledger).toHaveLength(1);
    });

    test('case 8: acknowledge is fire-and-forget — ack failure does NOT break the 200 response', async () => {
        const calls = makeFetchMock({
            onProductsGet: () => ({
                ok: true, status: 200,
                json: async () => ({ purchaseState: 0, orderId: 'GPA.ACK-FAIL-0001' }),
            }),
            onAck: () => ({ ok: false, status: 500, json: async () => ({ error: { code: 500 } }) }),
        });
        const { app } = buildApp();
        const res = await supertest(app).post('/api/wallet/topup/verify-google')
            .send({ productId: 'ec.topup.starter', purchaseToken: 'token-ack-fail' })
            .expect(200);
        expect(res.body.success).toBe(true);
        expect(res.body.order.ecoinTotal).toBe(9450);

        // Give the fire-and-forget ack a tick to reach the mock.
        await new Promise((r) => setImmediate(r));
        expect(calls.ack).toBe(1);
        // Ledger still credited even though ack returned 500.
        expect(fake.state.ledger).toHaveLength(1);
    });

    test('rejects missing/invalid inputs with 400', async () => {
        makeFetchMock();
        const { app } = buildApp();
        await supertest(app).post('/api/wallet/topup/verify-google').send({}).expect(400);
        await supertest(app).post('/api/wallet/topup/verify-google')
            .send({ productId: 'ec.topup.starter' }).expect(400);
        await supertest(app).post('/api/wallet/topup/verify-google')
            .send({ productId: 'ec.topup.starter', purchaseToken: 'short' }).expect(400);
        await supertest(app).post('/api/wallet/topup/verify-google')
            .send({ productId: 'fake_tier', purchaseToken: 'long-enough-token' }).expect(400);
    });
});
