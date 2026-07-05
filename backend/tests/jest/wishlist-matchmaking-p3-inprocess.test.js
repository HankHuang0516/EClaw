/**
 * wishlist-matchmaking-p3 IN-PROCESS wiring test (card_496f752a).
 *
 * index.js wires P3's `governedInvite` by driving the ALREADY-MOUNTED P2 express
 * router in-process via `router.handle(req, res, next)` with a synthetic req/res —
 * so P3 reuses P2's ENTIRE governed invite path with zero duplication. The P3 unit
 * suite fakes that sink with supertest; THIS file exercises the actual
 * `router.handle()` mechanism index.js uses, against a REAL P2 router, so a break in
 * that glue (wrong url, res shape, store sharing) is caught here — not in prod.
 *
 * It replicates index.js's runP2InviteInProcess EXACTLY (same synthetic req/res),
 * shares the P2 store with P3, and asserts:
 *   - a governed seller scan actually delivers a P2 invite envelope via the shared
 *     router + store;
 *   - governance still fires through the in-process path (opt-in OFF ⇒ blocked, no send);
 *   - the shared store makes P3 dedup symmetric with a direct P2 invite.
 */

const express = require('express');
const request = require('supertest');
const mm = require('../../wishlist-matchmaking');
const p3 = require('../../wishlist-matchmaking-p3');

const SELLER = { deviceId: 'dev-seller', entityId: 2, botSecret: 'S_SEC', publicCode: 'sellra' };
const BUYER = { deviceId: 'dev-buyer', entityId: 3, botSecret: 'B_SEC', publicCode: 'buyerx' };

// devices map + publicCodeIndex, mirroring index.js server state.
const devices = {
    [SELLER.deviceId]: { entities: { 2: { isBound: true, botSecret: SELLER.botSecret, publicCode: SELLER.publicCode, entityId: 2, name: 'Seller' } } },
    [BUYER.deviceId]: { entities: { 3: { isBound: true, botSecret: BUYER.botSecret, publicCode: BUYER.publicCode, entityId: 3, name: 'Buyer' } } },
};
const publicCodeIndex = {
    [SELLER.publicCode]: { deviceId: SELLER.deviceId, entityId: 2 },
    [BUYER.publicCode]: { deviceId: BUYER.deviceId, entityId: 3 },
};

function auth() {
    return async ({ deviceId, botSecret }) => {
        const d = devices[deviceId];
        for (const e of Object.values((d && d.entities) || {})) {
            if (e.botSecret === botSecret) return { ok: true, publicCode: e.publicCode };
        }
        return { ok: false };
    };
}

function build({ buyerOptIn = true } = {}) {
    const sent = [];
    const prefs = {
        [SELLER.deviceId]: { wishlist_matchmaking_enabled: true },
        [BUYER.deviceId]: buyerOptIn ? { wishlist_matchmaking_enabled: true } : {},
    };
    const roster = {
        [SELLER.publicCode]: { publicCode: SELLER.publicCode, entityId: 2, state: 'IDLE', lastUpdated: Date.now(), isBound: true },
        [BUYER.publicCode]: { publicCode: BUYER.publicCode, entityId: 3, state: 'IDLE', lastUpdated: Date.now(), isBound: true },
    };

    // REAL P2 router, mounted, with a capturing sender — exactly like index.js.
    const p2Router = mm.createRouter({
        authenticateCaller: auth(),
        searchItems: async () => ({ items: [] }),
        resolvePublicCode: (code) => (publicCodeIndex[code] ? { deviceId: publicCodeIndex[code].deviceId, entityId: publicCodeIndex[code].entityId, entity: {} } : null),
        getRosterEntry: (code) => roster[code] || null,
        getDevicePrefs: async (deviceId) => prefs[deviceId] || {},
        sendB2bMessage: async (m) => { sent.push(m); return { success: true }; },
    });

    // ── EXACT COPY of index.js runP2InviteInProcess (buyer drives P2 /invite) ──
    function runP2InviteInProcess({ buyerPublicCode, sellerPublicCode, itemId, itemName, note, bypassFriendsOnly }) {
        return new Promise((resolve) => {
            const buyerTarget = publicCodeIndex[buyerPublicCode];
            if (!buyerTarget) return resolve({ status: 'blocked', reason: 'buyer_not_found' });
            const buyerDevice = devices[buyerTarget.deviceId];
            const buyerEntity = buyerDevice && buyerDevice.entities[buyerTarget.entityId];
            if (!buyerEntity || !buyerEntity.botSecret) return resolve({ status: 'blocked', reason: 'buyer_secret_unavailable' });
            const req = {
                method: 'POST',
                url: bypassFriendsOnly ? '/connect' : '/invite',
                originalUrl: bypassFriendsOnly ? '/connect' : '/invite',
                body: {
                    deviceId: buyerTarget.deviceId,
                    entityId: buyerTarget.entityId,
                    botSecret: buyerEntity.botSecret,
                    sellerPublicCode,
                    itemId,
                    itemName,
                    note,
                },
                headers: {},
                get() { return undefined; },
            };
            const res = {
                statusCode: 200,
                status(code) { this.statusCode = code; return this; },
                json(payload) {
                    if (this.statusCode === 200) {
                        resolve({ status: payload.deduped ? 'invited' : (payload.status || 'invited'), matchId: payload.matchId, deduped: !!payload.deduped });
                    } else {
                        resolve({ status: 'blocked', reason: payload && payload.reason });
                    }
                    return this;
                },
            };
            p2Router.handle(req, res, () => resolve({ status: 'blocked', reason: 'route_not_found' }));
        });
    }

    const p3app = express();
    p3app.use(express.json());
    p3app.use('/p3', p3.createRouter({
        authenticateCaller: auth(),
        searchItems: async () => ({ items: [{ id: 5, name: 'thing', publicCode: BUYER.publicCode }] }),
        recognizeItem: async () => ({ itemName: 'thing', tags: [] }),
        governedInvite: async (a) => runP2InviteInProcess(a),
        matchStore: p2Router._store, // SHARED store (index.js shares wishlistMatchmakingRouter._store)
    }));

    return { p3app, p2Router, sent };
}

describe('in-process P2 invite wiring (router.handle)', () => {
    it('seller scan delivers a real P2 invite envelope via router.handle + shared store', async () => {
        const { p3app, sent } = build();
        const res = await request(p3app).post('/p3/seller-listing-scan').send({ ...SELLER, itemId: 5, itemName: 'thing' });
        expect(res.status).toBe(200);
        expect(res.body.invitedCount).toBe(1);
        expect(sent).toHaveLength(1);
        expect(sent[0].envelope.type).toBe('wishlist_trade_invite');
    });

    it('governance fires through the in-process path: buyer opt-in OFF ⇒ blocked, no send', async () => {
        const { p3app, sent } = build({ buyerOptIn: false });
        const res = await request(p3app).post('/p3/seller-listing-scan').send({ ...SELLER, itemId: 5, itemName: 'thing' });
        expect(res.status).toBe(200);
        expect(res.body.invitedCount).toBe(0);
        expect(sent).toHaveLength(0);
    });

    it('shared store makes P3 dedup symmetric with a direct P2 invite', async () => {
        const { p3app, p2Router, sent } = build();
        // First, invite directly via P2 (buyer -> seller) so the matchId lands in the store.
        const p2app = express();
        p2app.use(express.json());
        p2app.use('/mm', p2Router);
        await request(p2app).post('/mm/invite').send({
            deviceId: BUYER.deviceId, entityId: 3, botSecret: BUYER.botSecret,
            sellerPublicCode: SELLER.publicCode, itemId: 5,
        }).expect(200);
        expect(sent).toHaveLength(1);
        // Now a P3 rescan for the SAME (buyer,item,seller) must dedup — no second send.
        const res = await request(p3app).post('/p3/rescan').send({
            ...BUYER,
            wishes: [{ itemId: 5, sellerPublicCode: SELLER.publicCode }],
        });
        expect(res.status).toBe(200);
        expect(res.body.sentCount).toBe(0);
        expect(res.body.dedupedCount).toBe(1);
        expect(sent).toHaveLength(1); // still just the direct P2 one
    });
});
