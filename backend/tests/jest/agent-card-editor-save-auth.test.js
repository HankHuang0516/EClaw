/**
 * card_2e65c220dc43fde62a1957e9 — name-card (card-holder) save 400 bug.
 *
 * Repro: AgentCardEditor.save() PUT /api/entity/agent-card omitted
 * deviceSecret → backend (index.js PUT handler) returned
 * 400 "deviceSecret or botSecret required".
 *
 * Fix: constructor threads opts.deviceSecret/opts.botSecret, save() puts
 * them into the request body. Call sites (card-holder.html, dashboard.html)
 * pass currentUser.deviceSecret.
 *
 * This suite asserts:
 *  1. save() includes deviceSecret in the PUT body when provided.
 *  2. save() falls back to botSecret when only that is provided.
 *  3. both editor call sites pass deviceSecret into the constructor.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PORTAL = path.join(__dirname, '..', '..', 'public', 'portal');
const EDITOR_SRC = path.join(PORTAL, 'shared', 'agent-card-editor.js');

function loadEditor(apiCallStub) {
    const src = fs.readFileSync(EDITOR_SRC, 'utf8');
    const ctx = {
        window: { AgentCardEditor: null },
        document: {
            createElement: () => ({ style: {}, textContent: '', innerHTML: '', appendChild() {} }),
            getElementById: () => null,
        },
        apiCall: apiCallStub,
        showToast: () => {},
        console: { error: () => {}, log: () => {}, warn: () => {} },
        Math, Date, JSON, encodeURIComponent, decodeURIComponent,
    };
    vm.createContext(ctx);
    vm.runInContext(src, ctx, { filename: 'agent-card-editor.js' });
    return ctx.window.AgentCardEditor;
}

describe('AgentCardEditor.save() auth (card_2e65c220)', () => {
    function makeEditor(opts, captured) {
        const AgentCardEditor = loadEditor(async (method, url, body) => {
            captured.method = method;
            captured.url = url;
            captured.body = body;
            return { success: true, agentCard: body.agentCard };
        });
        const ed = new AgentCardEditor('container', opts);
        // Bypass DOM-dependent collect() with a deterministic payload.
        ed.collect = () => ({ description: 'd', protocols: [], tags: [], version: '1.0.0', website: '', contactEmail: '' });
        return ed;
    }

    test('includes deviceSecret in PUT body', async () => {
        const captured = {};
        const ed = makeEditor({ entityId: 2, deviceId: 'dev-1', deviceSecret: 'SECRET_DS' }, captured);
        await ed.save();
        expect(captured.method).toBe('PUT');
        expect(captured.url).toBe('/api/entity/agent-card');
        expect(captured.body.deviceSecret).toBe('SECRET_DS');
        expect(captured.body.deviceId).toBe('dev-1');
        expect(captured.body.entityId).toBe(2);
    });

    test('falls back to botSecret when only botSecret provided', async () => {
        const captured = {};
        const ed = makeEditor({ entityId: 2, deviceId: 'dev-1', botSecret: 'SECRET_BS' }, captured);
        await ed.save();
        expect(captured.body.botSecret).toBe('SECRET_BS');
        expect(captured.body.deviceSecret).toBeUndefined();
    });

    test('REGRESSION: no auth → body would 400 (neither secret present)', async () => {
        // Documents the original bug shape: with no secret the body carries
        // neither field, which the backend rejects with
        // "deviceSecret or botSecret required".
        const captured = {};
        const ed = makeEditor({ entityId: 2, deviceId: 'dev-1' }, captured);
        await ed.save();
        expect(captured.body.deviceSecret).toBeUndefined();
        expect(captured.body.botSecret).toBeUndefined();
    });
});

describe('AgentCardEditor call sites pass deviceSecret', () => {
    const PAGES = ['card-holder.html', 'dashboard.html'];
    for (const page of PAGES) {
        test(`${page} passes deviceSecret into new AgentCardEditor`, () => {
            const content = fs.readFileSync(path.join(PORTAL, page), 'utf8');
            const idx = content.indexOf('new AgentCardEditor');
            expect(idx).toBeGreaterThan(-1);
            // Inspect the constructor opts object literal (next ~400 chars).
            const slice = content.slice(idx, idx + 600);
            expect(slice).toMatch(/deviceSecret:\s*currentUser/);
        });
    }
});
