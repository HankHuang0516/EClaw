/**
 * rental → OODA-R episode emit on 500 — card_7fc8e7ab (SI stream C).
 *
 * Verifies that when rentalRoute's catch fires (synthesized via a forced
 * pool error), the wired agentImprovementModule.ingestEpisode is called
 * with a well-formed Episode payload pinned to the SI anchor card.
 */
'use strict';

jest.mock('pg', () => {
    class FakePool {
        async connect() {
            return {
                query: async () => { throw new Error('forced fake-pg failure'); },
                release: () => {},
            };
        }
        async query() { throw new Error('forced fake-pg failure'); }
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

const stubAuth = (req, _res, next) => {
    req.user = { userId: 'u-test', deviceId: 'dev-test' };
    next();
};
const stubWallet = {
    withTransaction: async () => { throw new Error('not_used'); },
    LEDGER_TYPES: {},
};

describe('rentalRoute 500 path emits an OODA-R Episode (card_7fc8e7ab — SI stream C)', () => {
    test('ingestEpisode called with episode anchored to the SI card on 500', async () => {
        const ingestCalls = [];
        const agentImprovementModule = {
            ingestEpisode: async (episode /*, pool*/) => {
                ingestCalls.push(episode);
                return { id: 1 };
            },
        };
        const api = rental({
            authMiddleware: stubAuth,
            walletModule: stubWallet,
            agentImprovementModule,
        });

        // Pull the registered POST /listing route handler directly so we don't
        // need a full Express harness — the rentalRoute wrapper is the
        // subject under test.
        const routeLayer = api.router.stack.find(l =>
            l.route && l.route.path === '/listing' && l.route.methods.post
        );
        expect(routeLayer).toBeTruthy();
        // Stack: [authMiddleware, rentalRoute(...handler...)]. The wrapper is
        // the LAST entry on the layer.
        const rentalRouteHandler = routeLayer.route.stack[routeLayer.route.stack.length - 1].handle;

        const req = {
            user: { userId: 'u-test', deviceId: 'dev-test' },
            method: 'POST',
            originalUrl: '/api/rental/listing',
            path: '/listing',
            body: {
                ownerDeviceId: 'd', ownerEntityId: 0, title: 'x', rateMliPerKtoken: 5000,
            },
        };
        let captured;
        const res = {
            status(code) { captured = { code }; return this; },
            json(body) { captured.body = body; return this; },
        };

        await rentalRouteHandler(req, res);

        // Response shape — surface contract unchanged.
        expect(captured.code).toBe(500);
        expect(captured.body).toEqual({ success: false, error: 'internal_error' });

        // The fire-and-forget emit is awaited as a microtask — flush.
        await new Promise(r => setImmediate(r));

        expect(ingestCalls.length).toBe(1);
        const ep = ingestCalls[0];
        expect(ep.cardId).toBe('card_7fc8e7abc3cb546e89721a26');
        expect(ep.taskType).toBe('rental_handler_500');
        expect(ep.severity).toBe('P0');
        expect(ep.userVisibleResult).toBe('internal_error');
        expect(ep.painTags).toEqual(expect.arrayContaining(['delivery_reliability', 'test_coverage']));
        expect(ep.missedChecks).toEqual(expect.arrayContaining(['schema-drift-sentinel']));
        expect(typeof ep.occurredAt).toBe('string');
        // ISO-8601 parseable
        expect(Number.isNaN(Date.parse(ep.occurredAt))).toBe(false);
    });

    test('no episode emit when agentImprovementModule is not wired (back-compat)', async () => {
        const api = rental({
            authMiddleware: stubAuth,
            walletModule: stubWallet,
            // No agentImprovementModule — exactly how old call sites looked.
        });
        const routeLayer = api.router.stack.find(l =>
            l.route && l.route.path === '/listing' && l.route.methods.post
        );
        const handler = routeLayer.route.stack[routeLayer.route.stack.length - 1].handle;

        const req = {
            user: { userId: 'u-test' },
            method: 'POST',
            originalUrl: '/api/rental/listing',
            body: { ownerDeviceId: 'd', ownerEntityId: 0, title: 'x', rateMliPerKtoken: 5000 },
        };
        let captured;
        const res = {
            status(code) { captured = { code }; return this; },
            json(body) { captured.body = body; return this; },
        };

        // Must not throw even though episode emit path is absent.
        await expect(handler(req, res)).resolves.toBeUndefined();
        expect(captured.code).toBe(500);
        expect(captured.body).toEqual({ success: false, error: 'internal_error' });
    });
});
