// E2E lifecycle + i18n parity for the "需要你" HITL inbox (card_41de0be8).
//
// The sibling unit suite (agent-action-requests.test.js) asserts each endpoint
// in isolation by feeding the pg mock a single canned row per call. This suite
// instead drives the FULL lifecycle as an integration sequence against a small
// STATEFUL in-memory store that models the real SQL the router runs (INSERT /
// guarded pending-only UPDATE / device-scoped SELECT). That makes the state
// transitions real: a resolved/dismissed request actually disappears from the
// next `list pending`, and resolving one of two concurrent requests provably
// does NOT touch the other — the multi-request-no-mix case the parent spec
// (card_a03d9d09) explicitly calls out.
//
// It also strengthens the i18n coverage beyond the inbox suite's 7-key
// spot-check: every action_request_* key referenced by chat.html (static keys
// + the dynamic action_request_type_<type> prefix over the backend's
// VALID_TYPES) is asserted to exist in BOTH the en and zh locales.

const path = require('path');
const fs = require('fs');

// ── Stateful in-memory pg mock ──
// Captured rows keyed by id. The router only issues four shapes of query:
//   INSERT ... RETURNING *                       → create a pending row
//   UPDATE ... SET status='resolved' ... pending → guarded resolve
//   UPDATE ... SET status='dismissed' ... pending→ guarded dismiss
//   SELECT * ... WHERE device_id ... [status]    → device-scoped list
// We parse just enough of each to mutate/return the right rows.
const store = new Map();
let seq = 0;
function newId() {
    seq += 1;
    // deterministic v4-shaped uuid so UUID_RE in the router accepts it
    const h = seq.toString(16).padStart(12, '0');
    return `00000000-0000-4000-8000-${h}`;
}

const mockQuery = jest.fn(async (sql, params = []) => {
    const text = String(sql);

    if (/^\s*INSERT INTO agent_action_requests/i.test(text)) {
        const [device_id, from_entity_id, anchor_message_id, type, prompt, optionsJson] = params;
        const row = {
            id: newId(),
            device_id,
            from_entity_id,
            anchor_message_id: anchor_message_id || null,
            type,
            prompt,
            options: optionsJson != null ? JSON.parse(optionsJson) : null,
            status: 'pending',
            answer: null,
            created_at: new Date(Date.now() + seq), // preserve insert order for ORDER BY created_at ASC
            resolved_at: null,
        };
        store.set(row.id, row);
        return { rows: [row], rowCount: 1 };
    }

    if (/UPDATE agent_action_requests/i.test(text) && /status = 'resolved'/i.test(text)) {
        // params: [answerJson, requestId, deviceId]
        const [answerJson, requestId, deviceId] = params;
        const row = store.get(requestId);
        if (!row || row.device_id !== deviceId || row.status !== 'pending') return { rows: [], rowCount: 0 };
        row.status = 'resolved';
        row.answer = answerJson != null ? JSON.parse(answerJson) : null;
        row.resolved_at = new Date();
        return { rows: [{ ...row }], rowCount: 1 };
    }

    if (/UPDATE agent_action_requests/i.test(text) && /status = 'dismissed'/i.test(text)) {
        // params: [requestId, deviceId]
        const [requestId, deviceId] = params;
        const row = store.get(requestId);
        if (!row || row.device_id !== deviceId || row.status !== 'pending') return { rows: [], rowCount: 0 };
        row.status = 'dismissed';
        row.resolved_at = new Date();
        return { rows: [{ ...row }], rowCount: 1 };
    }

    if (/^\s*SELECT \* FROM agent_action_requests/i.test(text)) {
        // params: [deviceId, status?, fromEntityId?] — order follows the router's push order.
        const deviceId = params[0];
        let rest = params.slice(1);
        const hasStatus = /AND status = \$/i.test(text);
        const hasFromEntity = /AND from_entity_id = \$/i.test(text);
        let status = null;
        let fromEntity = null;
        if (hasStatus) { status = rest.shift(); }
        if (hasFromEntity) { fromEntity = rest.shift(); }
        let rows = [...store.values()].filter((r) => r.device_id === deviceId);
        if (hasStatus && status != null) rows = rows.filter((r) => r.status === status);
        if (hasFromEntity && fromEntity != null) rows = rows.filter((r) => r.from_entity_id === fromEntity);
        rows.sort((a, b) => a.created_at - b.created_at);
        return { rows: rows.map((r) => ({ ...r })), rowCount: rows.length };
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

const deviceId = 'dev-e2e';
const deviceSecret = 'dev-secret-e2e';

let app;
let resolveActionRequest;

beforeAll(() => {
    app = express();
    app.use(express.json());
    const devices = {
        [deviceId]: {
            deviceSecret,
            entities: {
                2: { isBound: true, botSecret: 'bot-2' },
                6: { isBound: true, botSecret: 'bot-6' },
            },
        },
    };
    const mod = require('../../agent-action-requests')(devices, { serverLog: () => {} });
    app.use('/api/action-requests', mod.router);
    resolveActionRequest = mod.resolveActionRequest;
});

beforeEach(() => {
    store.clear();
    seq = 0;
    mockQuery.mockClear();
});

const post = (p) => request(app).post(p);
const get = (p) => request(app).get(p);

const listPending = () =>
    get(`/api/action-requests?deviceId=${deviceId}&deviceSecret=${deviceSecret}`);
const listStatus = (status) =>
    get(`/api/action-requests?deviceId=${deviceId}&deviceSecret=${deviceSecret}&status=${status}`);

async function emit(over = {}) {
    const res = await post('/api/action-requests').send({
        deviceId, botSecret: 'bot-2', entityId: 2,
        type: 'decision', prompt: 'pick A or B', options: ['A', 'B'],
        ...over,
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    return res.body.request;
}

describe('E2E lifecycle: emit → list → resolve → list', () => {
    it('a resolved request leaves the pending list and reads back as status=resolved', async () => {
        // emit (bot auth)
        const reqObj = await emit({ prompt: 'deploy to prod?', type: 'approval' });
        expect(reqObj.status).toBe('pending');

        // list pending sees it
        let pending = await listPending();
        expect(pending.body.requests.map((r) => r.id)).toContain(reqObj.id);

        // resolve {answer} (user auth)
        const resolved = await post(`/api/action-requests/${reqObj.id}/resolve`)
            .send({ deviceId, deviceSecret, answer: 'yes ship it' });
        expect(resolved.status).toBe(200);
        expect(resolved.body.request.status).toBe('resolved');
        expect(resolved.body.request.answer).toBe('yes ship it');

        // list pending no longer sees it
        pending = await listPending();
        expect(pending.body.requests.map((r) => r.id)).not.toContain(reqObj.id);

        // but it's visible (and resolved) under status=resolved
        const done = await listStatus('resolved');
        const found = done.body.requests.find((r) => r.id === reqObj.id);
        expect(found).toBeDefined();
        expect(found.status).toBe('resolved');
        expect(found.answer).toBe('yes ship it');
    });

    it('re-resolving an already-resolved request 404s (guarded pending-only UPDATE)', async () => {
        const reqObj = await emit();
        await post(`/api/action-requests/${reqObj.id}/resolve`).send({ deviceId, deviceSecret, answer: 'A' });
        const again = await post(`/api/action-requests/${reqObj.id}/resolve`).send({ deviceId, deviceSecret, answer: 'B' });
        expect(again.status).toBe(404);
        // answer was NOT overwritten by the second attempt
        const done = await listStatus('resolved');
        expect(done.body.requests.find((r) => r.id === reqObj.id).answer).toBe('A');
    });
});

describe('E2E lifecycle: emit → dismiss → list', () => {
    it('a dismissed request leaves the pending list and reads back as status=dismissed', async () => {
        const reqObj = await emit({ prompt: 'noise, ignore', type: 'clarify' });

        let pending = await listPending();
        expect(pending.body.requests.map((r) => r.id)).toContain(reqObj.id);

        const dismissed = await post(`/api/action-requests/${reqObj.id}/dismiss`).send({ deviceId, deviceSecret });
        expect(dismissed.status).toBe(200);
        expect(dismissed.body.request.status).toBe('dismissed');

        pending = await listPending();
        expect(pending.body.requests.map((r) => r.id)).not.toContain(reqObj.id);

        const dropped = await listStatus('dismissed');
        expect(dropped.body.requests.find((r) => r.id === reqObj.id)).toBeDefined();
    });

    it('dismissing then resolving the same request 404s (already terminal)', async () => {
        const reqObj = await emit();
        await post(`/api/action-requests/${reqObj.id}/dismiss`).send({ deviceId, deviceSecret });
        const res = await post(`/api/action-requests/${reqObj.id}/resolve`).send({ deviceId, deviceSecret, answer: 'A' });
        expect(res.status).toBe(404);
    });
});

describe('multi-request-no-mix (parent spec card_a03d9d09)', () => {
    it('resolving one of two concurrent requests does NOT touch the other', async () => {
        const a = await emit({ prompt: 'request A', type: 'decision' });
        const b = await emit({ prompt: 'request B', type: 'input' });

        // both pending
        let pending = await listPending();
        let ids = pending.body.requests.map((r) => r.id);
        expect(ids).toEqual(expect.arrayContaining([a.id, b.id]));
        expect(pending.body.requests).toHaveLength(2);

        // resolve A only
        const resA = await post(`/api/action-requests/${a.id}/resolve`).send({ deviceId, deviceSecret, answer: 'answer-A' });
        expect(resA.status).toBe(200);

        // B is untouched: still pending, no answer
        pending = await listPending();
        ids = pending.body.requests.map((r) => r.id);
        expect(ids).toContain(b.id);
        expect(ids).not.toContain(a.id);
        const bRow = pending.body.requests.find((r) => r.id === b.id);
        expect(bRow.status).toBe('pending');
        expect(bRow.answer).toBeNull();

        // A carries its own answer, not B's
        const resolved = await listStatus('resolved');
        expect(resolved.body.requests.find((r) => r.id === a.id).answer).toBe('answer-A');
        expect(resolved.body.requests.find((r) => r.id === b.id)).toBeUndefined();
    });

    it('dismissing one of two concurrent requests leaves the other pending', async () => {
        const a = await emit({ prompt: 'keep me', type: 'review' });
        const b = await emit({ prompt: 'drop me', type: 'clarify' });

        await post(`/api/action-requests/${b.id}/dismiss`).send({ deviceId, deviceSecret });

        const pending = await listPending();
        const ids = pending.body.requests.map((r) => r.id);
        expect(ids).toContain(a.id);
        expect(ids).not.toContain(b.id);
    });

    it('the shared resolveActionRequest() helper is also request-scoped (no cross-resolve)', async () => {
        const a = await emit({ prompt: 'helper A' });
        const b = await emit({ prompt: 'helper B' });
        // resolve A via the exported helper (the path /api/client/speak uses)
        const row = await resolveActionRequest(deviceId, a.id, 'helper-answer', { entities: {} });
        expect(row).not.toBeNull();
        expect(row.id).toBe(a.id);
        // B untouched
        const pending = await listPending();
        expect(pending.body.requests.map((r) => r.id)).toEqual([b.id]);
    });
});

describe('list ordering + device scoping across the lifecycle', () => {
    it('pending list returns requests in created_at ASC (oldest first)', async () => {
        const first = await emit({ prompt: 'first' });
        const second = await emit({ prompt: 'second' });
        const third = await emit({ prompt: 'third' });
        const pending = await listPending();
        expect(pending.body.requests.map((r) => r.id)).toEqual([first.id, second.id, third.id]);
    });
});

// ── i18n EN/ZH parity for every key the 需要你 inbox references ──
// Strengthens the inbox suite's 7-key spot-check to a full parity gate over
// the static keys in chat.html AND the dynamic action_request_type_<type>
// prefix expanded across the backend's VALID_TYPES.
describe('i18n EN/ZH parity for the 需要你 inbox surface', () => {
    const ROOT = path.join(__dirname, '..', '..');
    const chatHtml = fs.readFileSync(path.join(ROOT, 'public', 'portal', 'chat.html'), 'utf8');
    const i18nJs = fs.readFileSync(path.join(ROOT, 'public', 'shared', 'i18n.js'), 'utf8');

    // Mirror the backend VALID_TYPES so the dynamic prefix is covered exactly.
    const VALID_TYPES = ['decision', 'approval', 'input', 'credential', 'review', 'clarify'];

    // Static action_request_* keys referenced in chat.html, minus the bare
    // dynamic prefix (which is expanded below into one key per VALID_TYPE).
    const staticKeys = [...new Set(
        [...chatHtml.matchAll(/['"]([a-z0-9_]*action_request_[a-z0-9_]+)['"]/g)].map((m) => m[1])
    )].filter((k) => k !== 'action_request_type_');

    const referencedKeys = [
        ...staticKeys,
        ...VALID_TYPES.map((t) => `action_request_type_${t}`),
    ];

    // Locate the en{} and zh{} locale blocks once so we can assert per-locale.
    const enIdx = i18nJs.indexOf('\n    en: {');
    const zhIdx = i18nJs.indexOf('\n    zh: {');

    function definedIn(localeStart, localeEnd, key) {
        const block = i18nJs.slice(localeStart, localeEnd);
        return new RegExp(`["']${key}["']\\s*:`).test(block);
    }

    it('locates the en and zh locale blocks', () => {
        expect(enIdx).toBeGreaterThan(-1);
        expect(zhIdx).toBeGreaterThan(enIdx);
    });

    it('found every referenced action_request_ key (static + dynamic types)', () => {
        // Guards against the audit silently degrading to zero keys if chat.html
        // is refactored to compute key names differently.
        expect(staticKeys.length).toBeGreaterThanOrEqual(10);
        expect(referencedKeys).toContain('action_request_inbox_title');
        expect(referencedKeys).toContain('action_request_type_decision');
        expect(referencedKeys).toContain('action_request_dismissed');
        expect(referencedKeys).toContain('action_request_resolved');
    });

    it.each(referencedKeys)('"%s" has BOTH an en and a zh entry', (key) => {
        expect(definedIn(enIdx, zhIdx, key)).toBe(true); // en
        expect(definedIn(zhIdx, i18nJs.length, key)).toBe(true); // zh
    });

    it('zh entries for the type labels are real translations, not English fallbacks', () => {
        // Sanity: the localized type labels actually carry CJK, so we know zh
        // wasn't stubbed with the English value.
        const zhBlock = i18nJs.slice(zhIdx);
        const cjk = /[一-鿿]/;
        for (const t of VALID_TYPES) {
            const m = zhBlock.match(new RegExp(`"action_request_type_${t}"\\s*:\\s*"([^"]*)"`));
            expect(m).not.toBeNull();
            expect(cjk.test(m[1])).toBe(true);
        }
    });
});
