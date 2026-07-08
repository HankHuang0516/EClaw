// 需要你 NEGOTIATION / CONSENSUS WORKFLOW (owner-approved build).
//
// Drives the FULL negotiation lifecycle against a small STATEFUL in-memory pg
// mock that models the real SQL the engine + routes run — the guarded
// (CAS) UPDATEs, the marker SELECTs, and the votes child table. That makes the
// state transitions REAL: an opened round actually carries consensus_triggered_at,
// a second concurrent open provably loses the CAS, voting outside S1 is rejected,
// the owner-synth write makes the row terminal, and the fallback NEVER hangs.
//
// Every test here exercises behaviour that DOES NOT EXIST on origin/main (the
// engine functions, the /vote + /votes + /negotiation-result endpoints, the
// isNegotiable/tallyVotes helpers, the new prefs) — so each FAILS on old code and
// PASSES on new.

// ── Stateful in-memory pg mock ──
let store;   // Map<id, requestRow>
let votes;   // Array<voteRow>
let seq;

function newId() {
    seq += 1;
    const h = seq.toString(16).padStart(12, '0');
    return `00000000-0000-4000-8000-${h}`;
}
function minutesAgo(m) { return new Date(Date.now() - m * 60000); }

// Read a positional $N param (1-based) out of params.
function paramAt(sql, re, params) {
    const m = sql.match(re);
    if (!m) return undefined;
    return params[parseInt(m[1], 10) - 1];
}

const mockQuery = jest.fn(async (sql, params = []) => {
    const s = String(sql);

    // ── device scan ──
    if (/SELECT DISTINCT device_id/.test(s)) {
        const ids = [...new Set([...store.values()].filter(r => r.status === 'pending').map(r => r.device_id))];
        return { rows: ids.map(device_id => ({ device_id })), rowCount: ids.length };
    }

    // ── votes child table ──
    if (/FROM agent_action_request_votes/.test(s) && /COUNT\(\*\)/.test(s)) {
        const reqId = params[0];
        const n = votes.filter(v => v.request_id === reqId).length;
        return { rows: [{ total: n }], rowCount: 1 };
    }
    if (/FROM agent_action_request_votes/.test(s)) {
        const reqId = params[0];
        const rows = votes.filter(v => v.request_id === reqId)
            .sort((a, b) => a.created_at - b.created_at)
            .map(v => ({ ...v }));
        return { rows, rowCount: rows.length };
    }
    if (/INSERT INTO agent_action_request_votes/.test(s)) {
        const [request_id, entity_id, option_index, free_text, rationale] = params;
        const existing = votes.find(v => v.request_id === request_id && v.entity_id === entity_id);
        if (existing) {
            existing.option_index = option_index;
            existing.free_text = free_text;
            existing.rationale = rationale;
            existing.created_at = new Date();
        } else {
            votes.push({ request_id, entity_id, option_index, free_text, rationale, created_at: new Date() });
        }
        return { rows: [], rowCount: 1 };
    }

    // ── partial-column load for the /votes route ──
    if (/SELECT options, decision_context FROM agent_action_requests/.test(s)) {
        const id = paramAt(s, /id = \$(\d+)/, params);
        const dev = paramAt(s, /device_id = \$(\d+)/, params);
        const row = store.get(id);
        if (!row || row.device_id !== dev) return { rows: [], rowCount: 0 };
        return { rows: [{ options: row.options, decision_context: row.decision_context }], rowCount: 1 };
    }

    // ── agent_action_requests reads ──
    if (/SELECT \* FROM agent_action_requests/.test(s)) {
        // Single-row load by id (vote / negotiation-result): no ORDER BY.
        if (!/ORDER BY/.test(s) && /id = \$\d+/.test(s)) {
            const id = paramAt(s, /id = \$(\d+)/, params);
            const dev = paramAt(s, /device_id = \$(\d+)/, params);
            const row = store.get(id);
            if (!row || (dev !== undefined && row.device_id !== dev)) return { rows: [], rowCount: 0 };
            return { rows: [{ ...row }], rowCount: 1 };
        }
        // Multi-row query (list / advance / backstop / timeout).
        const dev = params[0];
        let rows = [...store.values()].filter(r => r.device_id === dev);
        if (/status = 'pending'/.test(s)) rows = rows.filter(r => r.status === 'pending');
        const statusParam = s.match(/status = \$(\d+)/);
        if (statusParam) {
            const st = params[parseInt(statusParam[1], 10) - 1];
            if (st != null) rows = rows.filter(r => r.status === st);
        }
        const feParam = s.match(/from_entity_id = \$(\d+)/);
        if (feParam) {
            const fe = params[parseInt(feParam[1], 10) - 1];
            if (fe != null) rows = rows.filter(r => r.from_entity_id === fe);
        }
        if (/consensus_triggered_at IS NOT NULL/.test(s)) rows = rows.filter(r => r.consensus_triggered_at != null);
        if (/consensus_triggered_at IS NULL/.test(s)) rows = rows.filter(r => r.consensus_triggered_at == null);
        if (/consensus_collect_at IS NOT NULL/.test(s)) rows = rows.filter(r => r.consensus_collect_at != null);
        if (/consensus_collect_at IS NULL/.test(s)) rows = rows.filter(r => r.consensus_collect_at == null);
        if (/negotiation IS NULL/.test(s)) rows = rows.filter(r => r.negotiation == null);
        if (/jsonb_array_length\(options\) >= 2/.test(s)) rows = rows.filter(r => Array.isArray(r.options) && r.options.length >= 2);
        // clock thresholds
        const trigClock = s.match(/consensus_triggered_at < NOW\(\) - \(\$(\d+) \* interval/);
        if (trigClock) {
            const mins = params[parseInt(trigClock[1], 10) - 1];
            const thr = Date.now() - mins * 60000;
            rows = rows.filter(r => r.consensus_triggered_at && new Date(r.consensus_triggered_at).getTime() < thr);
        }
        const collClock = s.match(/consensus_collect_at < NOW\(\) - \(\$(\d+) \* interval/);
        if (collClock) {
            const mins = params[parseInt(collClock[1], 10) - 1];
            const thr = Date.now() - mins * 60000;
            rows = rows.filter(r => r.consensus_collect_at && new Date(r.consensus_collect_at).getTime() < thr);
        }
        const createdClock = s.match(/created_at < NOW\(\) - \(\$(\d+) \* interval/);
        if (createdClock) {
            const mins = params[parseInt(createdClock[1], 10) - 1];
            const thr = Date.now() - mins * 60000;
            rows = rows.filter(r => r.created_at && new Date(r.created_at).getTime() < thr);
        }
        rows.sort((a, b) => a.created_at - b.created_at);
        return { rows: rows.map(r => ({ ...r })), rowCount: rows.length };
    }

    // ── INSERT a request ──
    if (/INSERT INTO agent_action_requests/.test(s)) {
        const [device_id, from_entity_id, anchor_message_id, type, prompt, optionsJson, related_card_id, decisionJson] = params;
        const row = {
            id: newId(), device_id, from_entity_id,
            anchor_message_id: anchor_message_id || null, type, prompt,
            options: optionsJson != null ? JSON.parse(optionsJson) : null,
            related_card_id: related_card_id || null,
            decision_context: decisionJson != null ? JSON.parse(decisionJson) : null,
            status: 'pending', answer: null,
            created_at: new Date(Date.now() + seq), resolved_at: null,
            consensus_triggered_at: null, consensus_collect_at: null, negotiation: null,
        };
        store.set(row.id, row);
        return { rows: [{ ...row }], rowCount: 1 };
    }

    // ── guarded UPDATEs (CAS) ──
    if (/UPDATE agent_action_requests/.test(s)) {
        const id = paramAt(s, /id = \$(\d+)/, params);
        const row = store.get(id);
        if (!row) return { rows: [], rowCount: 0 };
        // guards (presence in SQL)
        if (/status = 'pending'/.test(s) && row.status !== 'pending') return { rows: [], rowCount: 0 };
        if (/consensus_triggered_at IS NULL/.test(s) && row.consensus_triggered_at != null) return { rows: [], rowCount: 0 };
        if (/consensus_triggered_at IS NOT NULL/.test(s) && row.consensus_triggered_at == null) return { rows: [], rowCount: 0 };
        if (/consensus_collect_at IS NULL/.test(s) && row.consensus_collect_at != null) return { rows: [], rowCount: 0 };
        if (/consensus_collect_at IS NOT NULL/.test(s) && row.consensus_collect_at == null) return { rows: [], rowCount: 0 };
        if (/negotiation IS NULL/.test(s) && row.negotiation != null) return { rows: [], rowCount: 0 };
        if (/decision_context IS NOT NULL/.test(s) && row.decision_context == null) return { rows: [], rowCount: 0 };
        const devGuard = s.match(/device_id = \$(\d+)/);
        if (devGuard && row.device_id !== params[parseInt(devGuard[1], 10) - 1]) return { rows: [], rowCount: 0 };
        const feGuard = s.match(/from_entity_id = \$(\d+)/);
        if (feGuard && row.from_entity_id !== params[parseInt(feGuard[1], 10) - 1]) return { rows: [], rowCount: 0 };
        // SET application
        if (/consensus_triggered_at = NOW\(\)/.test(s)) row.consensus_triggered_at = new Date();
        if (/consensus_collect_at = NOW\(\)/.test(s)) row.consensus_collect_at = new Date();
        const negSet = s.match(/negotiation = \$(\d+)::jsonb/);
        if (negSet) row.negotiation = JSON.parse(params[parseInt(negSet[1], 10) - 1]);
        if (/status = 'resolved'/.test(s)) {
            row.status = 'resolved';
            const ans = s.match(/answer = \$(\d+)::jsonb/);
            if (ans) { const a = params[parseInt(ans[1], 10) - 1]; row.answer = a != null ? JSON.parse(a) : null; }
            row.resolved_at = new Date();
        }
        if (/status = 'dismissed'/.test(s)) { row.status = 'dismissed'; row.resolved_at = new Date(); }
        return { rows: [{ ...row }], rowCount: 1 };
    }

    return { rows: [], rowCount: 0 };
});

jest.mock('pg', () => ({
    Pool: jest.fn().mockImplementation(() => ({
        query: (...a) => mockQuery(...a),
        connect: jest.fn().mockResolvedValue({ query: (...a) => mockQuery(...a), release: jest.fn() }),
        end: jest.fn().mockResolvedValue(undefined),
    })),
}));

const express = require('express');
const request = require('supertest');
const factory = require('../../agent-action-requests');

const deviceId = 'dev-neg';
const deviceSecret = 'dev-secret-neg';

// Consensus prefs: policy=consensus, short window, min 2 entities.
const consensusPrefs = {
    action_request_timeout_policy: 'consensus',
    action_request_timeout_minutes: 1440,
    consensus_window_minutes: 30,
    consensus_synthesis_grace_minutes: 360,
    consensus_min_entities: 2,
};

function buildDevices() {
    return {
        [deviceId]: {
            deviceSecret,
            entities: {
                2: { isBound: true, botSecret: 'bot-2', bindingType: 'channel' }, // owner / synthesizer
                5: { isBound: true, botSecret: 'bot-5', bindingType: 'channel' },
                6: { isBound: true, botSecret: 'bot-6', bindingType: 'channel' },
            },
        },
    };
}

function buildApp({ prefs = consensusPrefs, devices = buildDevices() } = {}) {
    const app = express();
    app.use(express.json());
    const emitToRoom = jest.fn();
    const io = { to: jest.fn(() => ({ emit: emitToRoom })) };
    const pushes = [];
    const unifiedPush = jest.fn((entity, dId, type, payload) => { pushes.push({ entityId: entity, type, payload }); return Promise.resolve(); });
    const getDevicePrefs = jest.fn().mockResolvedValue(prefs);
    const mod = factory(devices, { serverLog: () => {}, io, unifiedPush, getDevicePrefs });
    app.use('/api/action-requests', mod.router);
    return { app, mod, emitToRoom, unifiedPush, pushes, devices };
}

beforeEach(() => { store = new Map(); votes = []; seq = 0; mockQuery.mockClear(); });

const post = (app, p, body) => request(app).post(p).send(body);
const get = (app, p) => request(app).get(p);

// Seed a pending request straight into the store (bypasses on-arrival open).
function seedRequest(over = {}) {
    const id = newId();
    const row = {
        id, device_id: deviceId, from_entity_id: 2, anchor_message_id: null,
        type: 'decision', prompt: 'ship A or B?', options: ['A', 'B'],
        related_card_id: null, decision_context: null,
        status: 'pending', answer: null,
        created_at: new Date(Date.now() + seq), resolved_at: null,
        consensus_triggered_at: null, consensus_collect_at: null, negotiation: null,
        ...over,
    };
    store.set(id, row);
    return row;
}

// ════════════════════════════════════════════════════════════════════════
describe('trigger eligibility — isNegotiable(row, prefs, boundEntityCount)', () => {
    const { isNegotiable } = factory;
    const row = { status: 'pending', consensus_triggered_at: null, options: ['A', 'B'] };

    test('options>=2 + enough entities + consensus pref → eligible', () => {
        expect(isNegotiable(row, consensusPrefs, 2)).toBe(true);
        expect(isNegotiable(row, consensusPrefs, 3)).toBe(true);
    });
    test('<2 options → NOT eligible', () => {
        expect(isNegotiable({ ...row, options: ['only'] }, consensusPrefs, 3)).toBe(false);
        expect(isNegotiable({ ...row, options: null }, consensusPrefs, 3)).toBe(false);
    });
    test('< consensus_min_entities bound entities → NOT eligible', () => {
        expect(isNegotiable(row, consensusPrefs, 1)).toBe(false);
        expect(isNegotiable(row, { ...consensusPrefs, consensus_min_entities: 3 }, 2)).toBe(false);
    });
    test('policy !== consensus → NOT eligible', () => {
        expect(isNegotiable(row, { ...consensusPrefs, action_request_timeout_policy: 'keep' }, 3)).toBe(false);
    });
    test('already opened (consensus_triggered_at set) or not pending → NOT eligible', () => {
        expect(isNegotiable({ ...row, consensus_triggered_at: new Date() }, consensusPrefs, 3)).toBe(false);
        expect(isNegotiable({ ...row, status: 'resolved' }, consensusPrefs, 3)).toBe(false);
    });
});

describe('deterministic plurality tally — tallyVotes()', () => {
    const { tallyVotes } = factory;
    test('clear plurality winner', () => {
        const r = tallyVotes([{ option_index: 0 }, { option_index: 1 }, { option_index: 1 }], 2, null);
        expect(r).toEqual({ bestOptionIndex: 1, count: 2, total: 3 });
    });
    test('tie → recommendedOptionIndex if among tied', () => {
        const r = tallyVotes([{ option_index: 0 }, { option_index: 2 }], 3, 2);
        expect(r.bestOptionIndex).toBe(2);
    });
    test('tie → lowest index when recommendation not among tied', () => {
        const r = tallyVotes([{ option_index: 1 }, { option_index: 2 }], 3, 0);
        expect(r.bestOptionIndex).toBe(1);
    });
    test('zero option-votes → recommendedOptionIndex ?? null; free-text still counts toward total', () => {
        expect(tallyVotes([{ free_text: 'maybe' }], 2, 1)).toEqual({ bestOptionIndex: 1, count: 0, total: 1 });
        expect(tallyVotes([], 2, null)).toEqual({ bestOptionIndex: null, count: 0, total: 0 });
    });
});

// ════════════════════════════════════════════════════════════════════════
describe('ON-ARRIVAL — createActionRequest opens a round when eligible', () => {
    test('a consensus-policy device with options>=2 + 3 entities opens the round on emit', async () => {
        const { app, emitToRoom, unifiedPush } = buildApp();
        const res = await post(app, '/api/action-requests', {
            deviceId, botSecret: 'bot-2', entityId: 2, type: 'decision',
            prompt: 'ship A or B?', options: ['A', 'B'],
        });
        expect(res.status).toBe(200);
        const id = res.body.request.id;
        // round stamped in the store
        expect(store.get(id).consensus_triggered_at).not.toBeNull();
        // consensus_triggered emitted + structured vote prompt broadcast to all 3
        expect(emitToRoom).toHaveBeenCalledWith('action_request:changed',
            expect.objectContaining({ kind: 'consensus_triggered', requestId: id }));
        const votePrompts = unifiedPush.mock.calls.filter(c => /協商共識/.test(c[3].message) && /\/vote/.test(c[3].message));
        expect(votePrompts.length).toBe(3);
    });

    test('NOT opened when only 1 option (request still created, no round)', async () => {
        const { app, emitToRoom } = buildApp();
        const res = await post(app, '/api/action-requests', {
            deviceId, botSecret: 'bot-2', entityId: 2, type: 'decision',
            prompt: 'just FYI', options: ['only'],
        });
        expect(res.status).toBe(200);
        expect(store.get(res.body.request.id).consensus_triggered_at).toBeNull();
        const opened = emitToRoom.mock.calls.find(c => c[1].kind === 'consensus_triggered');
        expect(opened).toBeUndefined();
    });

    test('NOT opened when fewer than consensus_min_entities are bound', async () => {
        const devices = buildDevices();
        delete devices[deviceId].entities[5];
        delete devices[deviceId].entities[6]; // only entity 2 left
        const { app } = buildApp({ devices });
        const res = await post(app, '/api/action-requests', {
            deviceId, botSecret: 'bot-2', entityId: 2, type: 'decision',
            prompt: 'ship A or B?', options: ['A', 'B'],
        });
        expect(res.status).toBe(200);
        expect(store.get(res.body.request.id).consensus_triggered_at).toBeNull();
    });

    test('a request-creation push failure NEVER fails request creation (best-effort)', async () => {
        const { app, unifiedPush } = buildApp();
        unifiedPush.mockImplementationOnce(() => { throw new Error('push boom'); });
        const res = await post(app, '/api/action-requests', {
            deviceId, botSecret: 'bot-2', entityId: 2, type: 'decision',
            prompt: 'ship A or B?', options: ['A', 'B'],
        });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });
});

// ════════════════════════════════════════════════════════════════════════
describe('WORKER BACKSTOP — opens a pre-existing eligible row (no age clause)', () => {
    test('a pending options>=2 row with no round gets opened by the worker', async () => {
        const { mod, emitToRoom } = buildApp();
        const row = seedRequest({ created_at: new Date() }); // brand new — no timeout age elapsed
        await mod.enforceActionRequestTimeouts();
        expect(store.get(row.id).consensus_triggered_at).not.toBeNull();
        expect(emitToRoom).toHaveBeenCalledWith('action_request:changed',
            expect.objectContaining({ kind: 'consensus_triggered', requestId: row.id }));
    });
});

// ════════════════════════════════════════════════════════════════════════
describe('S1 voting — POST /:id/vote', () => {
    async function openRow() {
        const { app, mod, emitToRoom, unifiedPush } = buildApp();
        const row = seedRequest();
        await mod.openNegotiationRound(row, buildDevices()[deviceId]);
        return { app, mod, emitToRoom, unifiedPush, row };
    }

    test('a bound entity can vote; emits kind=vote with k/N progress', async () => {
        const { app, emitToRoom, row } = await openRow();
        const res = await post(app, `/api/action-requests/${row.id}/vote`, {
            deviceId, botSecret: 'bot-5', entityId: 5, optionIndex: 1, rationale: 'B is safer',
        });
        expect(res.status).toBe(200);
        expect(res.body.tally).toEqual({ count: 1, total: 3 });
        expect(emitToRoom).toHaveBeenCalledWith('action_request:changed',
            expect.objectContaining({ kind: 'vote', requestId: row.id, votes: { count: 1, total: 3 } }));
    });

    test('upsert is idempotent — re-voting updates in place (one row, last-write-wins)', async () => {
        const { app, row } = await openRow();
        await post(app, `/api/action-requests/${row.id}/vote`, { deviceId, botSecret: 'bot-5', entityId: 5, optionIndex: 0 });
        await post(app, `/api/action-requests/${row.id}/vote`, { deviceId, botSecret: 'bot-5', entityId: 5, optionIndex: 1 });
        const mine = votes.filter(v => v.request_id === row.id && v.entity_id === 5);
        expect(mine).toHaveLength(1);
        expect(mine[0].option_index).toBe(1);
    });

    test('optionIndex out of range → 400', async () => {
        const { app, row } = await openRow();
        const res = await post(app, `/api/action-requests/${row.id}/vote`, { deviceId, botSecret: 'bot-5', entityId: 5, optionIndex: 9 });
        expect(res.status).toBe(400);
    });

    test('vote REJECTED outside S1 (after the collection window closes)', async () => {
        const { app, mod, row } = await openRow();
        // close the window → S2
        store.get(row.id).consensus_triggered_at = minutesAgo(60);
        await mod.advanceNegotiations(deviceId, consensusPrefs, buildDevices()[deviceId]);
        expect(store.get(row.id).consensus_collect_at).not.toBeNull();
        const res = await post(app, `/api/action-requests/${row.id}/vote`, { deviceId, botSecret: 'bot-6', entityId: 6, optionIndex: 0 });
        expect(res.status).toBe(409);
    });

    test('vote requires bot auth (deviceSecret/human rejected)', async () => {
        const { app, row } = await openRow();
        const res = await post(app, `/api/action-requests/${row.id}/vote`, { deviceId, deviceSecret, optionIndex: 0 });
        expect(res.status).toBe(400);
    });
});

// ════════════════════════════════════════════════════════════════════════
describe('T2 CLOSE — window elapsed stamps consensus_collect_at + prompts the OWNER only', () => {
    test('advance stamps collect_at and pushes the synthesize prompt to the owner', async () => {
        const { mod, emitToRoom, unifiedPush } = buildApp();
        const row = seedRequest({ consensus_triggered_at: minutesAgo(60) }); // window (30) elapsed
        await mod.advanceNegotiations(deviceId, consensusPrefs, buildDevices()[deviceId]);
        expect(store.get(row.id).consensus_collect_at).not.toBeNull();
        expect(store.get(row.id).negotiation).toBeNull(); // not concluded
        expect(emitToRoom).toHaveBeenCalledWith('action_request:changed',
            expect.objectContaining({ kind: 'consensus_collecting', requestId: row.id }));
        // synth prompt to OWNER (#2) ONLY
        const synthPushes = unifiedPush.mock.calls.filter(c => /協商綜整/.test(c[3].message));
        expect(synthPushes).toHaveLength(1);
        expect(synthPushes[0][0].botSecret).toBe('bot-2'); // entity #2 = the owner/synthesizer
    });

    test('does NOT close before the window elapses', async () => {
        const { mod } = buildApp();
        const row = seedRequest({ consensus_triggered_at: minutesAgo(5) }); // window 30 not elapsed
        await mod.advanceNegotiations(deviceId, consensusPrefs, buildDevices()[deviceId]);
        expect(store.get(row.id).consensus_collect_at).toBeNull();
    });
});

// ════════════════════════════════════════════════════════════════════════
describe('T3a OWNER-SYNTH — POST /:id/negotiation-result', () => {
    function collectingRow(over = {}) {
        return seedRequest({ consensus_triggered_at: minutesAgo(60), consensus_collect_at: minutesAgo(30), ...over });
    }

    test('owner (from_entity_id) writes negotiation; status STAYS pending; emits negotiation_concluded', async () => {
        const { app, emitToRoom } = buildApp();
        const row = collectingRow();
        votes.push({ request_id: row.id, entity_id: 5, option_index: 1, free_text: null, rationale: null, created_at: new Date() });
        const res = await post(app, `/api/action-requests/${row.id}/negotiation-result`, {
            deviceId, botSecret: 'bot-2', entityId: 2,
            conclusion: 'B wins on safety', bestSolution: 'B', bestOptionIndex: 1,
        });
        expect(res.status).toBe(200);
        const after = store.get(row.id);
        expect(after.status).toBe('pending');            // NOT resolved
        expect(after.negotiation).not.toBeNull();
        expect(after.negotiation.fallback).toBe(false);
        expect(after.negotiation.bestOptionIndex).toBe(1);
        expect(after.negotiation.synthesizedBy).toBe(2);
        expect(after.negotiation.votes).toEqual({ count: 1, total: 1 });
        expect(emitToRoom).toHaveBeenCalledWith('action_request:changed',
            expect.objectContaining({ kind: 'negotiation_concluded', requestId: row.id, fallback: false }));
    });

    test('a NON-owner bot cannot synthesize (restrictToEntityId) → 403', async () => {
        const { app } = buildApp();
        const row = collectingRow();
        const res = await post(app, `/api/action-requests/${row.id}/negotiation-result`, {
            deviceId, botSecret: 'bot-5', entityId: 5, conclusion: 'sneaky', bestOptionIndex: 0,
        });
        expect(res.status).toBe(403);
        expect(store.get(row.id).negotiation).toBeNull();
    });

    test('human deviceSecret may also synthesize (synthesizedBy=human)', async () => {
        const { app } = buildApp();
        const row = collectingRow();
        const res = await post(app, `/api/action-requests/${row.id}/negotiation-result`, {
            deviceId, deviceSecret, conclusion: 'owner decides', bestOptionIndex: 0,
        });
        expect(res.status).toBe(200);
        expect(store.get(row.id).negotiation.synthesizedBy).toBe('human');
    });

    test('GET /:id/votes returns the votes + tally', async () => {
        const { app } = buildApp();
        const row = collectingRow();
        votes.push({ request_id: row.id, entity_id: 5, option_index: 1, free_text: null, rationale: 'safer', created_at: new Date() });
        votes.push({ request_id: row.id, entity_id: 6, option_index: 1, free_text: null, rationale: null, created_at: new Date() });
        const res = await get(app, `/api/action-requests/${row.id}/votes?deviceId=${deviceId}&deviceSecret=${deviceSecret}`);
        expect(res.status).toBe(200);
        expect(res.body.votes).toHaveLength(2);
        expect(res.body.tally).toEqual({ bestOptionIndex: 1, count: 2, total: 2 });
    });
});

// ════════════════════════════════════════════════════════════════════════
describe('T3b FALLBACK — NEVER-HANG when the owner never synthesizes', () => {
    test('after the synth grace elapses the server tallies a fallback conclusion (never resolves)', async () => {
        const { mod, emitToRoom } = buildApp();
        const row = seedRequest({ consensus_triggered_at: minutesAgo(800), consensus_collect_at: minutesAgo(400) }); // grace 360 elapsed
        votes.push({ request_id: row.id, entity_id: 5, option_index: 0, free_text: null, rationale: null, created_at: new Date() });
        votes.push({ request_id: row.id, entity_id: 6, option_index: 0, free_text: null, rationale: null, created_at: new Date() });
        votes.push({ request_id: row.id, entity_id: 2, option_index: 1, free_text: null, rationale: null, created_at: new Date() });
        await mod.advanceNegotiations(deviceId, consensusPrefs, buildDevices()[deviceId]);
        const after = store.get(row.id);
        expect(after.status).toBe('pending');            // NEVER resolved
        expect(after.negotiation).not.toBeNull();
        expect(after.negotiation.fallback).toBe(true);
        expect(after.negotiation.synthesizedBy).toBe('server_fallback');
        // deterministic plurality: option 0 wins 2-1
        expect(after.negotiation.bestOptionIndex).toBe(0);
        expect(after.negotiation.votes).toEqual({ count: 2, total: 3 });
        expect(emitToRoom).toHaveBeenCalledWith('action_request:changed',
            expect.objectContaining({ kind: 'negotiation_concluded', requestId: row.id, fallback: true }));
    });

    test('zero votes → bestOptionIndex = recommendedOptionIndex ?? null + the "請您裁決" conclusion', async () => {
        const { mod } = buildApp();
        const row = seedRequest({
            consensus_triggered_at: minutesAgo(800), consensus_collect_at: minutesAgo(400),
            decision_context: { recommendedOptionIndex: 1 },
        });
        await mod.advanceNegotiations(deviceId, consensusPrefs, buildDevices()[deviceId]);
        const neg = store.get(row.id).negotiation;
        expect(neg.fallback).toBe(true);
        expect(neg.bestOptionIndex).toBe(1);             // from recommendedOptionIndex
        expect(neg.votes).toEqual({ count: 0, total: 0 });
        expect(neg.conclusion).toMatch(/請您裁決/);
    });

    test('does NOT fire before the synth grace elapses', async () => {
        const { mod } = buildApp();
        const row = seedRequest({ consensus_triggered_at: minutesAgo(800), consensus_collect_at: minutesAgo(10) }); // grace 360 not elapsed
        await mod.advanceNegotiations(deviceId, consensusPrefs, buildDevices()[deviceId]);
        expect(store.get(row.id).negotiation).toBeNull();
    });
});

// ════════════════════════════════════════════════════════════════════════
describe('owner-only (decision_context != null) — deliberates but is NEVER auto-resolved', () => {
    test('a decision_context row DOES open a consensus round on-arrival', async () => {
        const { app } = buildApp();
        const res = await post(app, '/api/action-requests', {
            deviceId, deviceSecret, fromEntityId: 2, type: 'decision',
            prompt: 'irreversible spend?', options: ['yes', 'no'],
            decisionContext: { whatWasDone: 'x', recommendedOptionIndex: 1 },
        });
        expect(res.status).toBe(200);
        expect(store.get(res.body.request.id).consensus_triggered_at).not.toBeNull();
    });

    test('the full advance pass concludes it (surfaced) but the worker NEVER flips status', async () => {
        const { mod } = buildApp();
        const row = seedRequest({
            decision_context: { whatWasDone: 'x', recommendedOptionIndex: 0 },
            consensus_triggered_at: minutesAgo(800), consensus_collect_at: minutesAgo(400),
        });
        await mod.enforceActionRequestTimeouts(); // ratify + advance + (consensus backstop)
        const after = store.get(row.id);
        expect(after.negotiation).not.toBeNull();   // concluded (surfaced)
        expect(after.status).toBe('pending');       // NEVER auto-resolved
    });
});

// ════════════════════════════════════════════════════════════════════════
describe('CAS races — no double-open / double-conclude', () => {
    test('two concurrent opens of the same row → exactly one wins (one consensus_triggered_at write)', async () => {
        const { mod } = buildApp();
        const row = seedRequest();
        const dev = buildDevices()[deviceId];
        const [a, b] = await Promise.all([
            mod.openNegotiationRound({ ...row }, dev),
            mod.openNegotiationRound({ ...row }, dev),
        ]);
        const winners = [a, b].filter(Boolean);
        expect(winners).toHaveLength(1); // the CAS guard let only one stamp it
    });

    test('owner-synth and fallback cannot both write — second is a no-op (negotiation already set)', async () => {
        const { app, mod } = buildApp();
        const row = seedRequest({ consensus_triggered_at: minutesAgo(800), consensus_collect_at: minutesAgo(400) });
        // owner synthesizes first
        const res = await post(app, `/api/action-requests/${row.id}/negotiation-result`, {
            deviceId, botSecret: 'bot-2', entityId: 2, conclusion: 'owner picked', bestOptionIndex: 0,
        });
        expect(res.status).toBe(200);
        expect(store.get(row.id).negotiation.fallback).toBe(false);
        // fallback now runs — must NOT overwrite (negotiation IS NULL guard fails)
        await mod.advanceNegotiations(deviceId, consensusPrefs, buildDevices()[deviceId]);
        expect(store.get(row.id).negotiation.fallback).toBe(false); // still the owner's
    });
});
