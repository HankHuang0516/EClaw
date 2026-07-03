'use strict';

/**
 * Waiting-state surfacer — phases 2-3 of card_76b073959c279d6204d9fd42.
 *
 * Two layers under test:
 *   A. The pure classifier backend/waiting-state.js:classifyCardWaitingState
 *      (required directly).
 *   B. The surfacer routine backend/kanban.js:surfaceOwnerWaitingStates
 *      (extracted from source + reconstructed with mock pool/devicePrefs/
 *      createActionRequest/dismiss deps — same extract-and-run pattern as
 *      kanban-stall-severity-gate.test.js).
 *
 * Safety invariants pinned here:
 *   - flag FALSE (default) → complete no-op (no createActionRequest, no dismiss).
 *   - flag TRUE + owner card + no existing item → EXACTLY one createActionRequest
 *     with decisionContext.surfacer === true.
 *   - flag TRUE + existing surfacer item → no duplicate create.
 *   - wait cleared + existing surfacer item → dismiss called (surfacer-only guard).
 *   - classifier never throws on a malformed card (returns null).
 */

const fs = require('fs');
const path = require('path');

const { classifyCardWaitingState } = require('../../waiting-state');

const kanbanSrc = fs.readFileSync(
    path.join(__dirname, '..', '..', 'kanban.js'),
    'utf8'
);

function extractFunctionBody(src, signature) {
    const start = src.indexOf(signature);
    if (start === -1) throw new Error(`function not found: ${signature}`);
    const open = src.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < src.length; i++) {
        const ch = src[i];
        if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0) return src.slice(open, i + 1);
        }
    }
    throw new Error(`unterminated function: ${signature}`);
}

// ─────────────────────────────────────────────────────────────────────────
// A. Classifier
// ─────────────────────────────────────────────────────────────────────────
describe('classifyCardWaitingState — waiting-party classifier', () => {
    test("blocked + owner-only reason → 'owner'", () => {
        expect(classifyCardWaitingState(
            { status: 'blocked', title: 'drop table users', gate_reason: 'irreversible data op' }, {}
        )).toBe('owner');
    });

    test("review + decision_context.ownerOnly → 'owner'", () => {
        expect(classifyCardWaitingState(
            { status: 'review', title: 'ship it' }, { decisionContext: { ownerOnly: true } }
        )).toBe('owner');
    });

    test("in_progress + narrow [await-owner] marker in latest comment → 'owner'", () => {
        expect(classifyCardWaitingState(
            { status: 'in_progress', title: 'the feature' },
            { latestComment: 'coded + tested. [await-owner] on the pricing call.' }
        )).toBe('owner');
        // 繁中 marker variant.
        expect(classifyCardWaitingState(
            { status: 'in_progress', title: 'x' }, { latestComment: '做完了 [等Hank] 拍板' }
        )).toBe('owner');
    });

    test("explicit config flags → 'owner'", () => {
        expect(classifyCardWaitingState({ status: 'in_progress', config: { waitingOn: 'owner' } }, {})).toBe('owner');
        expect(classifyCardWaitingState({ status: 'todo', config: { awaitOwner: true } }, {})).toBe('owner');
    });

    test("plain todo / in_progress (no marker) → null (no false-surface)", () => {
        expect(classifyCardWaitingState({ status: 'todo', title: 'do a thing' }, {})).toBeNull();
        // 'billing' would trip the owner-decision keyword classifier, but we do NOT
        // run it for in_progress → must stay null (flood guard).
        expect(classifyCardWaitingState(
            { status: 'in_progress', title: 'billing integration' }, { latestComment: 'still coding' }
        )).toBeNull();
    });

    test("review WITHOUT ownerOnly → 'commander' (NOT owner, not surfaced)", () => {
        expect(classifyCardWaitingState({ status: 'review', title: 'x' }, {})).toBe('commander');
    });

    test("blocked WITHOUT owner reason → 'entity' (NOT owner, not surfaced)", () => {
        expect(classifyCardWaitingState({ status: 'blocked', title: 'waiting on peer bot #4' }, {})).toBe('entity');
    });

    test('fail-safe: never throws on a malformed card → null', () => {
        expect(classifyCardWaitingState(null, {})).toBeNull();
        expect(classifyCardWaitingState(undefined, undefined)).toBeNull();
        expect(classifyCardWaitingState({ status: 123, config: 'oops' }, { latestComment: {} })).toBeNull();
        expect(classifyCardWaitingState('not-an-object', {})).toBeNull();
    });
});

// ─────────────────────────────────────────────────────────────────────────
// B. Surfacer routine
// ─────────────────────────────────────────────────────────────────────────
describe('surfaceOwnerWaitingStates — gated dark-launch surfacer', () => {
    const surfacerBody = extractFunctionBody(
        kanbanSrc, 'async function surfaceOwnerWaitingStates(deviceId)'
    );
    const reasonBody = extractFunctionBody(
        kanbanSrc, 'function describeOwnerWaitReason(card, latestComment)'
    );

    // Reconstruct surfaceOwnerWaitingStates + its describeOwnerWaitReason helper in
    // isolation, injecting mock pool / devicePrefs / createActionRequest /
    // dismissSurfacerActionRequestsForCard. `require` is stubbed to return the REAL
    // waiting-state classifier module. Both function bodies are re-declared with
    // their real signatures so the surfacer can call the helper by name.
    function makeSurfacer(deps) {
        const realRequire = require;
        const stubRequire = (mod) => {
            if (mod === './waiting-state') return realRequire('../../waiting-state');
            return realRequire(mod);
        };
        // eslint-disable-next-line no-new-func
        return new Function(
            'pool', 'devicePrefs', 'createActionRequest', 'dismissSurfacerActionRequestsForCard', 'require', 'console',
            `function describeOwnerWaitReason(card, latestComment) ${reasonBody}\n` +
            `return async function surfaceOwnerWaitingStates(deviceId) ${surfacerBody}`
        )(
            deps.pool, deps.devicePrefs, deps.createActionRequest,
            deps.dismissSurfacerActionRequestsForCard, stubRequire,
            { log: () => {}, error: () => {} }
        );
    }

    // Mock pool.query dispatches by SQL shape:
    //   - SELECT * FROM kanban_cards ...           → candidate cards
    //   - SELECT related_card_id ... surfacer      → existing surfacer items
    //   - SELECT text FROM kanban_comments ...     → latest comment
    function makeDeps({ prefs, cards = [], openSurfacerCardIds = [], comments = {} }) {
        const creates = [];
        const dismisses = [];
        const pool = {
            query: async (sql, params) => {
                if (/FROM kanban_cards/.test(sql)) {
                    return { rows: cards };
                }
                if (/decision_context #>> '\{surfacer\}'/.test(sql) && /SELECT related_card_id/.test(sql)) {
                    return { rows: openSurfacerCardIds.map(id => ({ cardId: id })) };
                }
                if (/FROM kanban_comments/.test(sql)) {
                    const cardId = params[0];
                    const text = comments[cardId];
                    return { rows: text != null ? [{ text }] : [] };
                }
                return { rows: [] };
            },
        };
        return {
            creates, dismisses,
            pool,
            devicePrefs: { getPrefs: async () => prefs },
            createActionRequest: async (arg) => { creates.push(arg); return { id: `req_${creates.length}` }; },
            dismissSurfacerActionRequestsForCard: async (deviceId, cardId) => { dismisses.push({ deviceId, cardId }); return []; },
        };
    }

    const ownerBlockedCard = {
        id: 'card_owner_1', device_id: 'dev1', status: 'blocked',
        title: 'delete account flow', gate_reason: 'irreversible', assigned_bots: [4],
    };

    test('flag FALSE (default) → complete no-op (no create, no dismiss, no card query)', async () => {
        const deps = makeDeps({ prefs: { waiting_state_surfacer_enabled: false }, cards: [ownerBlockedCard] });
        let cardQueried = false;
        const origQuery = deps.pool.query;
        deps.pool.query = async (sql, params) => {
            if (/FROM kanban_cards/.test(sql)) cardQueried = true;
            return origQuery(sql, params);
        };
        const fn = makeSurfacer(deps);
        await fn('dev1');
        expect(deps.creates.length).toBe(0);
        expect(deps.dismisses.length).toBe(0);
        expect(cardQueried).toBe(false); // early-return before any DB work
    });

    test('flag UNSET → treated as false → no-op', async () => {
        const deps = makeDeps({ prefs: {}, cards: [ownerBlockedCard] });
        const fn = makeSurfacer(deps);
        await fn('dev1');
        expect(deps.creates.length).toBe(0);
        expect(deps.dismisses.length).toBe(0);
    });

    test('flag TRUE + owner card + no existing item → EXACTLY one create w/ decisionContext.surfacer===true', async () => {
        const deps = makeDeps({
            prefs: { waiting_state_surfacer_enabled: true },
            cards: [ownerBlockedCard],
            openSurfacerCardIds: [],
        });
        const fn = makeSurfacer(deps);
        await fn('dev1');
        expect(deps.creates.length).toBe(1);
        const arg = deps.creates[0];
        expect(arg.deviceId).toBe('dev1');
        expect(arg.relatedCardId).toBe('card_owner_1');
        expect(arg.type).toBe('decision');
        expect(arg.decisionContext.surfacer).toBe(true);
        expect(arg.decisionContext.waitingOn).toBe('owner');
        expect(arg.decisionContext.ownerOnly).toBe(true);
        expect(arg.fromEntityId).toBe(4); // first assigned bot
        expect(deps.dismisses.length).toBe(0);
    });

    test('flag TRUE + existing surfacer item for that card → NO duplicate create', async () => {
        const deps = makeDeps({
            prefs: { waiting_state_surfacer_enabled: true },
            cards: [ownerBlockedCard],
            openSurfacerCardIds: ['card_owner_1'], // already surfaced
        });
        const fn = makeSurfacer(deps);
        await fn('dev1');
        expect(deps.creates.length).toBe(0);
        expect(deps.dismisses.length).toBe(0); // still owner-waiting → keep, don't dismiss
    });

    test('wait cleared (card now non-owner) + existing surfacer item → dismiss called', async () => {
        // Card is now a plain review card (no ownerOnly) → classifier returns
        // 'commander', not 'owner' → its stale surfacer item must be dismissed.
        const clearedCard = { id: 'card_owner_1', device_id: 'dev1', status: 'review', title: 'x', assigned_bots: [4] };
        const deps = makeDeps({
            prefs: { waiting_state_surfacer_enabled: true },
            cards: [clearedCard],
            openSurfacerCardIds: ['card_owner_1'],
        });
        const fn = makeSurfacer(deps);
        await fn('dev1');
        expect(deps.creates.length).toBe(0);
        expect(deps.dismisses.length).toBe(1);
        expect(deps.dismisses[0]).toEqual({ deviceId: 'dev1', cardId: 'card_owner_1' });
    });

    test('card LEFT the waiting statuses entirely (gone from candidates) → stale surfacer item swept', async () => {
        // No candidate cards at all, but a surfacer item still open → dismiss sweep.
        const deps = makeDeps({
            prefs: { waiting_state_surfacer_enabled: true },
            cards: [],
            openSurfacerCardIds: ['card_gone_9'],
        });
        const fn = makeSurfacer(deps);
        await fn('dev1');
        expect(deps.creates.length).toBe(0);
        expect(deps.dismisses.length).toBe(1);
        expect(deps.dismisses[0].cardId).toBe('card_gone_9');
    });

    test('in_progress card with [await-owner] marker in latest comment → surfaced', async () => {
        const ipCard = { id: 'card_ip_2', device_id: 'dev1', status: 'in_progress', title: 'feature', assigned_bots: [] };
        const deps = makeDeps({
            prefs: { waiting_state_surfacer_enabled: true },
            cards: [ipCard],
            comments: { card_ip_2: 'done + tested. [await-owner] on the go/no-go.' },
        });
        const fn = makeSurfacer(deps);
        await fn('dev1');
        expect(deps.creates.length).toBe(1);
        expect(deps.creates[0].relatedCardId).toBe('card_ip_2');
        expect(deps.creates[0].fromEntityId).toBe(0); // no assigned bots → 0
    });

    test('non-owner cards (plain in_progress / review-no-ownerOnly) with NO item → nothing happens', async () => {
        const deps = makeDeps({
            prefs: { waiting_state_surfacer_enabled: true },
            cards: [
                { id: 'a', status: 'in_progress', title: 'coding', assigned_bots: [1] },
                { id: 'b', status: 'review', title: 'reviewing', assigned_bots: [1] },
            ],
            comments: { a: 'still working' },
        });
        const fn = makeSurfacer(deps);
        await fn('dev1');
        expect(deps.creates.length).toBe(0);
        expect(deps.dismisses.length).toBe(0);
    });
});
