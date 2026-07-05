/**
 * wishlist-matchmaking DUAL-CONSENT — INTEGRATION test (security review HIGH #1/#2).
 *
 * The unit suite (wishlist-matchmaking.test.js) stubs getActionRequestStatus, so it
 * never exercises the REAL approval gate. THIS file wires the REAL
 * agent-action-requests module (with a mocked pg Pool) into a REAL getActionRequestStatus
 * — exactly like index.js — and drives the actual resolve path. It proves:
 *
 *   (a) an AGENT self-resolving its own emitted consent does NOT count as approved
 *       (resolved_by_user is false) → /contact/release stays gated;
 *   (b) only a real HUMAN (deviceSecret / isUser) resolve counts → both-human ⇒ release;
 *   (c) one-human-approve + one-pending ⇒ still gated;
 *   plus: isNegotiable EXCLUDES a crossOwnerPii consent (no bot /vote can synthesize it);
 *   plus: a human resolve with a DECLINE answer is NOT approved (fail-closed).
 *
 * (d) /contact/release from a non-party caller → 403 and (e) /connect to a
 * non-opted-in target → refused are covered in wishlist-matchmaking.test.js.
 */

// Mock pg BEFORE requiring the module (same pattern as action-request-cross-target).
const mockPoolQuery = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
jest.mock('pg', () => ({
    Pool: jest.fn().mockImplementation(() => ({
        query: mockPoolQuery,
        connect: jest.fn().mockResolvedValue({ query: mockPoolQuery, release: jest.fn() }),
        end: jest.fn().mockResolvedValue(undefined),
    })),
}));

const express = require('express');
const request = require('supertest');
const mm = require('../../wishlist-matchmaking');
// isNegotiable is a STATIC export on the factory function object (not the instance).
const aarStatic = require('../../agent-action-requests');

// ── EClaw fixtures ──────────────────────────────────────────────────────────
const BUYER = { deviceId: 'dev-buyer', entityId: 2, botSecret: 'bot-2', publicCode: 'buyera' };
const SELLER = { deviceId: 'dev-seller', entityId: 3, botSecret: 'bot-3', publicCode: 'sellrx' };

// Two devices with one bound entity each, deviceSecret = the HUMAN owner path.
const devices = {
    [BUYER.deviceId]: { deviceSecret: 'buyer-devsecret', entities: { 2: { isBound: true, botSecret: BUYER.botSecret, publicCode: BUYER.publicCode, entityId: 2, name: 'Buyer Bot' } } },
    [SELLER.deviceId]: { deviceSecret: 'seller-devsecret', entities: { 3: { isBound: true, botSecret: SELLER.botSecret, publicCode: SELLER.publicCode, entityId: 3, name: 'Seller Bot' } } },
};

// Real agent-action-requests module on the mocked pool. getDevicePrefs override
// avoids the singleton device-preferences pool; policy 'keep' so nothing auto-negotiates.
const aar = require('../../agent-action-requests')(devices, {
    serverLog: () => {},
    getDevicePrefs: async () => ({ action_request_timeout_policy: 'keep', consensus_min_entities: 2 }),
});

// A per-request in-memory model of agent_action_requests rows so the REAL SQL the
// module issues (INSERT ... RETURNING *, the resolve UPDATE ... RETURNING *, and the
// getRequestStatus SELECT) behaves like a tiny Postgres. Keyed by id.
const rows = new Map();
let seq = 0;
function uuid() {
    seq += 1;
    const h = seq.toString(16).padStart(12, '0');
    return `aaaaaaaa-0000-4000-8000-${h}`;
}

mockPoolQuery.mockImplementation(async (sql, params) => {
    const s = String(sql);
    // createActionRequest INSERT
    if (/INSERT INTO agent_action_requests/.test(s)) {
        const id = uuid();
        const [device_id, from_entity_id, anchor, type, prompt, optionsJson, relatedCardId, decisionJson] = params;
        const row = {
            id, device_id, from_entity_id, anchor_message_id: anchor, type, prompt,
            options: optionsJson ? JSON.parse(optionsJson) : null,
            related_card_id: relatedCardId, decision_context: decisionJson ? JSON.parse(decisionJson) : null,
            status: 'pending', answer: null, resolved_by_user: null,
            created_at: new Date(), resolved_at: null,
            consensus_triggered_at: null, consensus_collect_at: null, negotiation: null,
        };
        rows.set(id, row);
        return { rows: [row], rowCount: 1 };
    }
    // resolveActionRequest UPDATE ... status='resolved' ... RETURNING *
    if (/UPDATE agent_action_requests/.test(s) && /status = 'resolved'/.test(s)) {
        // params[1] = requestId, params[2] = deviceId; answer = params[0]
        // resolved_by_user may be an added param; restrictToEntityId may be another.
        const answer = params[0] ? JSON.parse(params[0]) : null;
        const requestId = params[1];
        const deviceId = params[2];
        const row = rows.get(requestId);
        if (!row || row.device_id !== deviceId || row.status !== 'pending') return { rows: [], rowCount: 0 };
        // Reconstruct optional params by scanning: a boolean → resolved_by_user; a
        // number/string entityId → restrictToEntityId (must match from_entity_id).
        let resolvedByUser = null;
        let restrict = null;
        for (let i = 3; i < params.length; i++) {
            if (typeof params[i] === 'boolean') resolvedByUser = params[i];
            else if (params[i] != null) restrict = params[i];
        }
        if (restrict != null && Number(restrict) !== Number(row.from_entity_id)) return { rows: [], rowCount: 0 };
        row.status = 'resolved';
        row.answer = answer;
        row.resolved_at = new Date();
        if (resolvedByUser !== null) row.resolved_by_user = resolvedByUser;
        return { rows: [row], rowCount: 1 };
    }
    // getRequestStatus SELECT
    if (/SELECT id, status, answer, resolved_by_user, decision_context FROM agent_action_requests/.test(s)) {
        const [id, deviceId] = params;
        const row = rows.get(id);
        if (!row || row.device_id !== deviceId) return { rows: [], rowCount: 0 };
        return { rows: [row], rowCount: 1 };
    }
    // Negotiation open CAS / vote reads / anything else → no-op.
    return { rows: [], rowCount: 0 };
});

// getActionRequestStatus wired EXACTLY like index.js (the real gate under test).
function answerIsApproval(answer) {
    if (answer == null) return false;
    let a = answer;
    if (typeof a === 'string') { try { a = JSON.parse(a); } catch (_) { a = { text: answer }; } }
    if (!a || typeof a !== 'object') return false;
    const oi = a.optionIndex ?? a.selectedOptionIndex;
    if (oi != null && oi !== '') return Number(oi) === 0;
    const raw = String(a.text ?? a.answer ?? a.value ?? '').trim();
    if (!raw) return false;
    if (/decline|reject|denied?|拒絕|不同意|不要|\bno\b|\bnot\b|別|否/i.test(raw)) return false;
    const norm = raw.toLowerCase();
    const allow = new Set(['同意釋出 / approve', '同意釋出', '同意', 'approve', 'approved', 'approve release', 'yes', '是']);
    return norm === '同意釋出 / approve' || allow.has(norm);
}
async function realGetActionRequestStatus(requestId, deviceId) {
    const r = await aar.getRequestStatus(requestId, deviceId);
    if (!r || !r.found) return { status: 'unknown', approved: false };
    const dc = (r.decisionContext && typeof r.decisionContext === 'object') ? r.decisionContext : {};
    const approved = r.status === 'resolved' && r.resolvedByUser === true && dc.crossOwnerPii === true && answerIsApproval(r.answer);
    return { status: r.status, approved, resolvedByUser: r.resolvedByUser === true };
}

// Real matchmaking router wired to the REAL consent create + status + a trusted
// server-side contact source. Everything else stubbed minimally.
function buildApp() {
    const sent = [];
    const opts = {
        authenticateCaller: async ({ deviceId, botSecret }) => {
            if (deviceId === BUYER.deviceId && botSecret === BUYER.botSecret) return { ok: true, publicCode: BUYER.publicCode };
            if (deviceId === SELLER.deviceId && botSecret === SELLER.botSecret) return { ok: true, publicCode: SELLER.publicCode };
            return { ok: false };
        },
        resolvePublicCode: (c) => c === SELLER.publicCode ? { deviceId: SELLER.deviceId, entityId: SELLER.entityId }
            : c === BUYER.publicCode ? { deviceId: BUYER.deviceId, entityId: BUYER.entityId } : null,
        getRosterEntry: (c) => c === SELLER.publicCode ? { publicCode: c, entityId: 3, state: 'IDLE', lastUpdated: Date.now(), isBound: true }
            : c === BUYER.publicCode ? { publicCode: c, entityId: 2, state: 'IDLE', lastUpdated: Date.now(), isBound: true } : null,
        getDevicePrefs: async () => ({ wishlist_matchmaking_enabled: true }),
        sendB2bMessage: async (m) => { sent.push(m); },
        createOwnerActionRequest: (args) => aar.createActionRequest({ ...args, type: 'approval' }),
        getActionRequestStatus: realGetActionRequestStatus,
        getPartyContact: async ({ deviceId, publicCode }) => ({
            nameCard: { publicCode, displayName: `Owner-${deviceId}`, caps: ['trade'] },
            contactInfo: deviceId === BUYER.deviceId ? { email: 'buyer@trusted' } : { email: 'seller@trusted' },
        }),
    };
    const router = mm.createRouter(opts);
    const app = express();
    app.use(express.json());
    app.use('/api/wishlist-matchmaking', router);
    return { app, sent };
}
const P = (app, p) => request(app).post(`/api/wishlist-matchmaking${p}`);

// Resolve a consent via the REAL module resolve path. isUserResolve mirrors what the
// HTTP /:id/resolve route passes (true for deviceSecret/human, false for botSecret/bot).
async function resolveConsent(reqId, deviceId, answer, { asUser, asEntityId }) {
    const device = devices[deviceId];
    const restrict = asUser ? null : asEntityId;
    return aar.resolveActionRequest(deviceId, reqId, answer, device, restrict, asUser);
}

beforeEach(() => { rows.clear(); seq = 0; });

async function seedBothApprovedPending() {
    const { app, sent } = buildApp();
    const inv = await P(app, '/invite').send({ ...BUYER, sellerPublicCode: SELLER.publicCode, itemId: 5, itemName: 'Camera' });
    const matchId = inv.body.matchId;
    await P(app, '/accept').send({ ...SELLER, matchId });
    const cr = await P(app, '/contact/request').send({ ...BUYER, matchId });
    return { app, sent, matchId, buyerReqId: cr.body.buyerConsentReqId, sellerReqId: cr.body.sellerConsentReqId };
}

describe('DUAL consent — REAL resolve path (HIGH #1)', () => {
    it('(a) AGENT self-resolves its OWN consent ⇒ NOT approved ⇒ release stays gated', async () => {
        const { app, sent, matchId, buyerReqId, sellerReqId } = await seedBothApprovedPending();
        const before = sent.length;
        // Each emitting agent resolves its own consent as a BOT (botSecret path):
        // from_entity_id === restrictToEntityId, isUserResolve=false.
        const rb = await resolveConsent(buyerReqId, BUYER.deviceId, { text: 'approve', optionIndex: 0 }, { asUser: false, asEntityId: BUYER.entityId });
        const rs = await resolveConsent(sellerReqId, SELLER.deviceId, { text: 'approve', optionIndex: 0 }, { asUser: false, asEntityId: SELLER.entityId });
        expect(rb).not.toBeNull(); // the resolve itself succeeds (status→resolved)
        expect(rs).not.toBeNull();
        expect(rb.resolved_by_user).toBe(false); // but NOT by a human
        // The release gate must therefore refuse.
        const rel = await P(app, '/contact/release').send({ ...BUYER, matchId });
        expect(rel.status).toBe(409);
        expect(rel.body.reason).toBe('dual_consent_pending');
        expect(rel.body.buyerApproved).toBe(false);
        expect(rel.body.sellerApproved).toBe(false);
        expect(sent.length).toBe(before); // NOTHING leaked
    });

    it('(b) BOTH resolved by the HUMAN owner (deviceSecret) ⇒ approved ⇒ release fires', async () => {
        const { app, sent, matchId, buyerReqId, sellerReqId } = await seedBothApprovedPending();
        const before = sent.length;
        await resolveConsent(buyerReqId, BUYER.deviceId, { text: '同意釋出 / Approve', optionIndex: 0 }, { asUser: true });
        await resolveConsent(sellerReqId, SELLER.deviceId, { text: '同意釋出 / Approve', optionIndex: 0 }, { asUser: true });
        const rel = await P(app, '/contact/release').send({ ...BUYER, matchId });
        expect(rel.status).toBe(200);
        expect(rel.body.status).toBe('contact_released');
        const releases = sent.slice(before);
        expect(releases).toHaveLength(2);
        const toBuyer = releases.find((m) => m.toPublicCode === BUYER.publicCode);
        expect(toBuyer.envelope.contactInfo).toEqual({ email: 'seller@trusted' }); // trusted source
        expect(toBuyer.envelope.disclaimer).toMatch(/only introduces, does not endorse/);
    });

    it('(c) ONE human-approve + ONE pending ⇒ still gated (409)', async () => {
        const { app, sent, matchId, buyerReqId } = await seedBothApprovedPending();
        const before = sent.length;
        await resolveConsent(buyerReqId, BUYER.deviceId, { optionIndex: 0 }, { asUser: true }); // buyer human-approves
        // seller stays pending
        const rel = await P(app, '/contact/release').send({ ...BUYER, matchId });
        expect(rel.status).toBe(409);
        expect(rel.body.buyerApproved).toBe(true);
        expect(rel.body.sellerApproved).toBe(false);
        expect(sent.length).toBe(before);
    });

    it('human resolve with a DECLINE answer is NOT approval (fail-closed)', async () => {
        const { app, matchId, buyerReqId, sellerReqId } = await seedBothApprovedPending();
        await resolveConsent(buyerReqId, BUYER.deviceId, { text: '同意嗎? 不要' }, { asUser: true });
        await resolveConsent(sellerReqId, SELLER.deviceId, { text: 'approve? no' }, { asUser: true });
        const rel = await P(app, '/contact/release').send({ ...BUYER, matchId });
        expect(rel.status).toBe(409); // both resolved by human but both DECLINED
        expect(rel.body.buyerApproved).toBe(false);
        expect(rel.body.sellerApproved).toBe(false);
    });
});

describe('isNegotiable EXCLUDES cross-owner PII consents (HIGH #2)', () => {
    it('a crossOwnerPii consent row is NOT negotiable even on a consensus device', async () => {
        const consensusPrefs = { action_request_timeout_policy: 'consensus', consensus_min_entities: 2 };
        const piiRow = {
            status: 'pending', consensus_triggered_at: null,
            options: ['同意釋出 / Approve', '拒絕 / Decline'],
            decision_context: { crossOwnerPii: true, humanOnly: true, ownerOnly: true },
        };
        // 2 bound entities, consensus policy, options length 2 → would negotiate WITHOUT the fix.
        expect(aarStatic.isNegotiable(piiRow, consensusPrefs, 2)).toBe(false);
        // Control: an ordinary 2-option owner-decision row IS still negotiable (no regression).
        const ordinary = { status: 'pending', consensus_triggered_at: null, options: ['A', 'B'], decision_context: { ownerOnly: true } };
        expect(aarStatic.isNegotiable(ordinary, consensusPrefs, 2)).toBe(true);
    });
});
