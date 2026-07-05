/**
 * Price-aware matchmaking — EClaw side (card_e1b8af79).
 *
 * Hank's confirmed defaults:
 *   - Price is OPTIONAL. Filter ONLY when BOTH sides have a price; either side
 *     missing ⇒ name/tags-only fallback (do NOT exclude).
 *   - Currency default TWD; DIFFERENT currencies ⇒ cannot compare (no FX) ⇒
 *     name-only fallback.
 *   - Compatible ⇔ buyer.maxPrice >= seller.askPrice (same currency).
 *
 * Tests drive the REAL control paths through supertest and assert the load-bearing
 * invariant: an INCOMPATIBLE pair produces NO b2b send. Price is an ADDITIONAL
 * filter — it can only BLOCK, never enable, a send.
 */

const express = require('express');
const request = require('supertest');
const mm = require('../../wishlist-matchmaking');
const p3 = require('../../wishlist-matchmaking-p3');

// ── Fixtures ────────────────────────────────────────────────────────────────

const BUYER = { deviceId: 'dev-buyer', entityId: 2, botSecret: 'BUYER_SECRET', publicCode: 'buyera' };
const SELLER = { deviceId: 'dev-seller', entityId: 3, botSecret: 'SELLER_SECRET', publicCode: 'sellrx' };

function fakeAuth() {
    return async ({ deviceId, botSecret }) => {
        if (deviceId === BUYER.deviceId && botSecret === BUYER.botSecret) return { ok: true, publicCode: BUYER.publicCode };
        if (deviceId === SELLER.deviceId && botSecret === SELLER.botSecret) return { ok: true, publicCode: SELLER.publicCode };
        return { ok: false };
    };
}

// A P2 app with everyone opted in + reachable, capturing every b2b send.
function buildP2(over = {}) {
    const sent = [];
    const prefs = over.prefs || {
        [BUYER.deviceId]: { wishlist_matchmaking_enabled: true },
        [SELLER.deviceId]: { wishlist_matchmaking_enabled: true },
    };
    const roster = {
        [SELLER.publicCode]: { publicCode: SELLER.publicCode, entityId: SELLER.entityId, state: 'IDLE', lastUpdated: Date.now(), isBound: true },
        [BUYER.publicCode]: { publicCode: BUYER.publicCode, entityId: BUYER.entityId, state: 'IDLE', lastUpdated: Date.now(), isBound: true },
    };
    const resolveMap = {
        [SELLER.publicCode]: { deviceId: SELLER.deviceId, entityId: SELLER.entityId, entity: {} },
        [BUYER.publicCode]: { deviceId: BUYER.deviceId, entityId: BUYER.entityId, entity: {} },
    };
    const store = mm.createMatchStore();
    const router = mm.createRouter({
        authenticateCaller: fakeAuth(),
        searchItems: over.searchItems || (async () => ({ items: [] })),
        resolvePublicCode: (code) => resolveMap[code] || null,
        getRosterEntry: (code) => roster[code] || null,
        getDevicePrefs: async (deviceId) => prefs[deviceId] || {},
        sendB2bMessage: async (m) => { sent.push(m); return { success: true }; },
        matchStore: store,
    });
    const app = express();
    app.use(express.json());
    app.use('/mm', router);
    return { app, sent, store };
}

const p2invite = (app, body) => request(app).post('/mm/invite').send({ ...BUYER, ...body });

// ── 1) priceCompat pure helper (every branch) ───────────────────────────────

describe('priceCompat (pure)', () => {
    it('both present, same currency, buyer >= seller ⇒ compatible', () => {
        expect(mm.priceCompat({ buyerMaxPrice: 9000, buyerCurrency: 'TWD', sellerAskPrice: 8000, sellerCurrency: 'TWD' }))
            .toEqual({ compatible: true, reason: 'price_compatible' });
        // exact equality is compatible (>=).
        expect(mm.priceCompat({ buyerMaxPrice: 8000, buyerCurrency: 'TWD', sellerAskPrice: 8000, sellerCurrency: 'TWD' }).compatible).toBe(true);
    });
    it('both present, same currency, buyer < seller ⇒ INCOMPATIBLE', () => {
        expect(mm.priceCompat({ buyerMaxPrice: 5000, buyerCurrency: 'TWD', sellerAskPrice: 8000, sellerCurrency: 'TWD' }))
            .toEqual({ compatible: false, reason: 'price_incompatible' });
    });
    it('either side missing price ⇒ name-only fallback (compatible)', () => {
        expect(mm.priceCompat({ sellerAskPrice: 8000, sellerCurrency: 'TWD' }).reason).toBe('no_price_fallback');
        expect(mm.priceCompat({ buyerMaxPrice: 5000, buyerCurrency: 'TWD' }).reason).toBe('no_price_fallback');
        expect(mm.priceCompat({}).reason).toBe('no_price_fallback');
        // A buyer max below the ask but NO seller ask ⇒ still fallback (not excluded).
        expect(mm.priceCompat({ buyerMaxPrice: 1, buyerCurrency: 'TWD' }).compatible).toBe(true);
    });
    it('DIFFERENT currencies ⇒ cannot compare (no FX) ⇒ fallback', () => {
        const d = mm.priceCompat({ buyerMaxPrice: 100, buyerCurrency: 'USD', sellerAskPrice: 8000, sellerCurrency: 'TWD' });
        expect(d).toEqual({ compatible: true, reason: 'currency_mismatch_fallback' });
    });
    it('INVALID price (NaN/negative/absurd) is treated as ABSENT ⇒ fallback, never a false-compatible', () => {
        // A garbage buyer max must NOT make an incompatible pair look compatible.
        expect(mm.priceCompat({ buyerMaxPrice: 'abc', buyerCurrency: 'TWD', sellerAskPrice: 8000, sellerCurrency: 'TWD' }).reason).toBe('no_price_fallback');
        expect(mm.priceCompat({ buyerMaxPrice: -5, buyerCurrency: 'TWD', sellerAskPrice: 8000, sellerCurrency: 'TWD' }).reason).toBe('no_price_fallback');
        expect(mm.priceCompat({ buyerMaxPrice: Infinity, buyerCurrency: 'TWD', sellerAskPrice: 8000, sellerCurrency: 'TWD' }).reason).toBe('no_price_fallback');
    });
    it('numeric strings are accepted (upstream sends strings)', () => {
        expect(mm.priceCompat({ buyerMaxPrice: '9000', buyerCurrency: 'twd', sellerAskPrice: '8000', sellerCurrency: 'TWD' }).compatible).toBe(true);
        expect(mm.priceCompat({ buyerMaxPrice: '5000', buyerCurrency: 'twd', sellerAskPrice: '8000', sellerCurrency: 'TWD' }).compatible).toBe(false);
    });
});

// ── 2) P2 /invite REAL control path ─────────────────────────────────────────

describe('P2 /invite — price-aware, on the real control path', () => {
    it('COMPATIBLE (buyer 9000 >= ask 8000, TWD) ⇒ invite FIRES + envelope carries price', async () => {
        const { app, sent } = buildP2();
        const res = await p2invite(app, {
            sellerPublicCode: SELLER.publicCode, itemId: 1, itemName: 'Sony WH-1000XM5',
            buyerMaxPrice: 9000, sellerAskPrice: 8000, priceCurrency: 'TWD',
        });
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('invited');
        expect(sent).toHaveLength(1);
        // The invite envelope carries the price BASIS so the recipient can judge.
        expect(sent[0].envelope.price).toEqual({ buyerMaxPrice: 9000, sellerAskPrice: 8000, currency: 'TWD' });
    });

    it('INCOMPATIBLE (buyer 5000 < ask 8000, TWD) ⇒ 409 price_incompatible + NO send', async () => {
        const { app, sent } = buildP2();
        const res = await p2invite(app, {
            sellerPublicCode: SELLER.publicCode, itemId: 1, itemName: 'Sony WH-1000XM5',
            buyerMaxPrice: 5000, sellerAskPrice: 8000, priceCurrency: 'TWD',
        });
        expect(res.status).toBe(409);
        expect(res.body.reason).toBe('price_incompatible');
        expect(sent).toHaveLength(0); // the load-bearing assertion: nothing sent
    });

    it('ONE SIDE MISSING price ⇒ name-only fallback: invite STILL fires', async () => {
        const { app, sent } = buildP2();
        // Seller ask present, buyer max absent — must NOT exclude.
        const res = await p2invite(app, {
            sellerPublicCode: SELLER.publicCode, itemId: 2, itemName: 'thing',
            sellerAskPrice: 8000, priceCurrency: 'TWD',
        });
        expect(res.status).toBe(200);
        expect(sent).toHaveLength(1);
        // Only the seller ask is echoed in the envelope; no buyer max.
        expect(sent[0].envelope.price).toEqual({ sellerAskPrice: 8000, currency: 'TWD' });
    });

    it('MISMATCHED currency (buyer USD vs seller TWD) ⇒ name-only fallback: invite fires', async () => {
        const { app, sent } = buildP2();
        const res = await p2invite(app, {
            sellerPublicCode: SELLER.publicCode, itemId: 3, itemName: 'thing',
            buyerMaxPrice: 100, buyerCurrency: 'USD', sellerAskPrice: 8000, sellerCurrency: 'TWD',
        });
        expect(res.status).toBe(200);
        expect(sent).toHaveLength(1);
    });

    it('NO prices at all ⇒ classic behaviour: invite fires, no price in envelope', async () => {
        const { app, sent } = buildP2();
        const res = await p2invite(app, { sellerPublicCode: SELLER.publicCode, itemId: 4, itemName: 'thing' });
        expect(res.status).toBe(200);
        expect(sent).toHaveLength(1);
        expect(sent[0].envelope.price).toBeUndefined();
    });

    it('price filter can NEVER bypass opt-in: compatible price + buyer opt-in OFF ⇒ still no send', async () => {
        const { app, sent } = buildP2({ prefs: { [BUYER.deviceId]: {}, [SELLER.deviceId]: { wishlist_matchmaking_enabled: true } } });
        const res = await p2invite(app, {
            sellerPublicCode: SELLER.publicCode, itemId: 5, itemName: 'thing',
            buyerMaxPrice: 9000, sellerAskPrice: 8000, priceCurrency: 'TWD',
        });
        expect(res.status).toBe(403);
        expect(res.body.reason).toBe('opt_in_off');
        expect(sent).toHaveLength(0);
    });
});

// ── 3) P3 seller-listing-scan + rescan price filtering (real governed path) ──

// A price-threading governed sink that mirrors index.js runP2InviteInProcess
// (caller = P2 principal) AND forwards the price basis into P2 /invite.
function buildP3(over = {}) {
    const sent = [];
    const prefs = {
        [BUYER.deviceId]: { wishlist_matchmaking_enabled: true },
        [SELLER.deviceId]: { wishlist_matchmaking_enabled: true },
    };
    const roster = {
        [SELLER.publicCode]: { publicCode: SELLER.publicCode, entityId: SELLER.entityId, state: 'IDLE', lastUpdated: Date.now(), isBound: true },
        [BUYER.publicCode]: { publicCode: BUYER.publicCode, entityId: BUYER.entityId, state: 'IDLE', lastUpdated: Date.now(), isBound: true },
    };
    const resolveMap = {
        [SELLER.publicCode]: { deviceId: SELLER.deviceId, entityId: SELLER.entityId, entity: {} },
        [BUYER.publicCode]: { deviceId: BUYER.deviceId, entityId: BUYER.entityId, entity: {} },
    };
    const store = mm.createMatchStore();
    const p2app = express();
    p2app.use(express.json());
    p2app.use('/mm', mm.createRouter({
        authenticateCaller: fakeAuth(),
        searchItems: async () => ({ items: [] }),
        resolvePublicCode: (code) => resolveMap[code] || null,
        getRosterEntry: (code) => roster[code] || null,
        getDevicePrefs: async (deviceId) => prefs[deviceId] || {},
        sendB2bMessage: async (m) => { sent.push(m); return { success: true }; },
        matchStore: store,
    }));

    async function governedInvite({ callerCreds, toPublicCode, itemId, itemName, note, bypassFriendsOnly, buyerMaxPrice, buyerCurrency, sellerAskPrice, sellerCurrency }) {
        const res = await request(p2app).post(`/mm/${bypassFriendsOnly ? 'connect' : 'invite'}`).send({
            deviceId: callerCreds.deviceId, entityId: callerCreds.entityId, botSecret: callerCreds.botSecret,
            sellerPublicCode: toPublicCode, itemId, itemName, note,
            buyerMaxPrice, buyerCurrency, sellerAskPrice, sellerCurrency,
        });
        if (res.status === 200) return { status: res.body.deduped ? 'invited' : (res.body.status || 'invited'), matchId: res.body.matchId, deduped: !!res.body.deduped };
        return { status: 'blocked', reason: res.body && res.body.reason };
    }

    const router = p3.createRouter({
        authenticateCaller: fakeAuth(),
        searchItems: over.searchItems || (async () => ({ items: [] })),
        governedInvite,
        matchStore: store,
    });
    const app = express();
    app.use(express.json());
    app.use('/p3', router);
    return { app, sent, store };
}

describe('P3 seller-listing-scan — price filter on invites', () => {
    // The reverse buyer search returns a buyer wish carrying maxPrice + priceCurrency.
    const buyerWish = (maxPrice, priceCurrency) => ({
        items: [{ id: 11, name: 'Sony WH-1000XM5', publicCode: BUYER.publicCode, maxPrice, priceCurrency }],
    });

    it('buyer maxPrice 9000 >= seller ask 8000 (TWD) ⇒ buyer INVITED', async () => {
        const { app, sent } = buildP3({ searchItems: async () => buyerWish(9000, 'TWD') });
        const res = await request(app).post('/p3/seller-listing-scan').send({
            ...SELLER, itemId: 1, itemName: 'Sony WH-1000XM5', askPrice: 8000, priceCurrency: 'TWD',
        });
        expect(res.status).toBe(200);
        expect(res.body.invitedCount).toBe(1);
        expect(sent).toHaveLength(1);
        expect(sent[0].envelope.price).toEqual({ buyerMaxPrice: 9000, sellerAskPrice: 8000, currency: 'TWD' });
    });

    it('buyer maxPrice 5000 < seller ask 8000 (TWD) ⇒ NOT invited (no send)', async () => {
        const { app, sent } = buildP3({ searchItems: async () => buyerWish(5000, 'TWD') });
        const res = await request(app).post('/p3/seller-listing-scan').send({
            ...SELLER, itemId: 1, itemName: 'Sony WH-1000XM5', askPrice: 8000, priceCurrency: 'TWD',
        });
        expect(res.status).toBe(200);
        expect(res.body.invitedCount).toBe(0);
        expect(res.body.skipped.some((s) => s.reason === 'price_incompatible')).toBe(true);
        expect(sent).toHaveLength(0); // load-bearing: nothing sent
    });

    it('seller sets NO askPrice ⇒ name-only fallback: buyer still invited even if maxPrice is low', async () => {
        const { app, sent } = buildP3({ searchItems: async () => buyerWish(5000, 'TWD') });
        const res = await request(app).post('/p3/seller-listing-scan').send({
            ...SELLER, itemId: 1, itemName: 'Sony WH-1000XM5', // no askPrice
        });
        expect(res.status).toBe(200);
        expect(res.body.invitedCount).toBe(1);
        expect(sent).toHaveLength(1);
    });
});

describe('P3 rescan — price filter on invites', () => {
    it('compatible wish ⇒ ONE invite; incompatible wish ⇒ none', async () => {
        const { app, sent } = buildP3();
        const res = await request(app).post('/p3/rescan').send({
            ...BUYER,
            wishes: [
                { itemId: 1, sellerPublicCode: SELLER.publicCode, itemName: 'a', maxPrice: 9000, sellerAskPrice: 8000, priceCurrency: 'TWD' }, // ok
            ],
        });
        expect(res.status).toBe(200);
        expect(res.body.sentCount).toBe(1);
        expect(sent).toHaveLength(1);

        // Fresh app for the incompatible case (own store).
        const { app: app2, sent: sent2 } = buildP3();
        const res2 = await request(app2).post('/p3/rescan').send({
            ...BUYER,
            wishes: [
                { itemId: 2, sellerPublicCode: SELLER.publicCode, itemName: 'b', maxPrice: 5000, sellerAskPrice: 8000, priceCurrency: 'TWD' }, // buyer < ask
            ],
        });
        expect(res2.status).toBe(200);
        expect(res2.body.sentCount).toBe(0);
        expect(res2.body.invalid.some((i) => i.reason === 'price_incompatible')).toBe(true);
        expect(sent2).toHaveLength(0);
    });

    it('wish with no prices ⇒ name-only fallback: invite still fires', async () => {
        const { app, sent } = buildP3();
        const res = await request(app).post('/p3/rescan').send({
            ...BUYER,
            wishes: [{ itemId: 3, sellerPublicCode: SELLER.publicCode, itemName: 'c' }],
        });
        expect(res.status).toBe(200);
        expect(res.body.sentCount).toBe(1);
        expect(sent).toHaveLength(1);
    });
});
