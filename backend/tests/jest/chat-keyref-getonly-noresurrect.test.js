/**
 * Regression guard for the Key Reference vault-sync bug (card_f6038f0f, P1).
 *
 * chat.html's initEnvVarBtn used to POST the localStorage cache back to
 * /api/device-vars on open ("merge"), which resurrected keys deleted on the
 * mission page: a var Hank deleted reappeared as a {{KEY}} chip AND got pushed
 * back onto the server vault. Fix: the popup is a READ surface — GET-only, server
 * is the single source of truth, and the local cache is reconciled to match the
 * server (deletions propagate). It must NEVER POST.
 *
 * This test drives the REAL initEnvVarBtn extracted from chat.html against a
 * mocked apiCall/localStorage/document and asserts: no POST ever, deletions
 * propagate, fresh sessions adopt server vars, and offline falls back to cache
 * read-only.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const CHAT_HTML = path.resolve(__dirname, '../../public/portal/chat.html');

function extractInitEnvVarBtn(html) {
    const start = html.indexOf('async function initEnvVarBtn(deviceId, deviceSecret)');
    if (start === -1) throw new Error('chat.html: initEnvVarBtn not found');
    // Close on the first 8-space-indented `}` (the function terminator; inner
    // braces are indented deeper).
    const end = html.indexOf('\n        }', start);
    if (end === -1) throw new Error('chat.html: initEnvVarBtn terminator not found');
    return html.slice(start, end + '\n        }'.length);
}

function harness(serverBehavior, initialCache) {
    const store = new Map();
    if (initialCache !== undefined) {
        store.set('eclawLocalVars_dev1', JSON.stringify(initialCache));
    }
    const localStorage = {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, String(v)),
    };
    const calls = [];
    const apiCall = async (method, url) => {
        calls.push({ method, url });
        return serverBehavior(method, url);
    };
    const chipsEl = { innerHTML: '' };
    const envBtn = { style: { display: 'none' } };
    const document = {
        getElementById: (id) => (id === 'envVarChips' ? chipsEl : envBtn),
    };
    const src = extractInitEnvVarBtn(fs.readFileSync(CHAT_HTML, 'utf8'));
    const initEnvVarBtn = new Function('apiCall', 'localStorage', 'document', src + '\nreturn initEnvVarBtn;')(apiCall, localStorage, document);
    return { initEnvVarBtn, calls, store, chipsEl, envBtn };
}

const cachedKeys = (store) => Object.keys(JSON.parse(store.get('eclawLocalVars_dev1') || '{}'));

describe('chat.html Key Reference — GET-only, no resurrect (card_f6038f0f)', () => {
    test('deletion propagates: a cached key the server no longer has is dropped, and NO POST fires', async () => {
        // Cache still has A + STALE (deleted on mission page); server has only A.
        const { initEnvVarBtn, calls, store, chipsEl } = harness(
            (method) => (method === 'GET' ? { vars: { API_KEY: 'a' }, updatedAt: 111 } : { mergedVars: {} }),
            { API_KEY: 'a', STALE_DELETED: 'x' },
        );
        await initEnvVarBtn('dev1', 'sec1');

        // THE FIX: never POST the localStorage cache back (that resurrected keys).
        expect(calls.some((c) => c.method === 'POST')).toBe(false);
        expect(calls.filter((c) => c.method === 'GET')).toHaveLength(1);
        // Cache reconciled to server truth — STALE_DELETED is gone.
        expect(cachedKeys(store).sort()).toEqual(['API_KEY']);
        // Chip UI shows only the live key, not the resurrected one.
        expect(chipsEl.innerHTML).toContain('{{API_KEY}}');
        expect(chipsEl.innerHTML).not.toContain('STALE_DELETED');
    });

    test('fresh session adopts server vars (no POST of an empty set)', async () => {
        const { initEnvVarBtn, calls, store, chipsEl, envBtn } = harness(
            (method) => (method === 'GET' ? { vars: { A: '1', B: '2' }, updatedAt: 5 } : null),
            undefined, // no cache
        );
        await initEnvVarBtn('dev1', 'sec1');
        expect(calls.some((c) => c.method === 'POST')).toBe(false);
        expect(cachedKeys(store).sort()).toEqual(['A', 'B']);
        expect(chipsEl.innerHTML).toContain('{{A}}');
        expect(chipsEl.innerHTML).toContain('{{B}}');
        expect(envBtn.style.display).toBe('');
    });

    test('empty vault clears the cache and hides chips (no POST)', async () => {
        const { initEnvVarBtn, calls, store, chipsEl } = harness(
            (method) => (method === 'GET' ? { vars: {}, updatedAt: 9 } : null),
            { OLD: 'v' },
        );
        await initEnvVarBtn('dev1', 'sec1');
        expect(calls.some((c) => c.method === 'POST')).toBe(false);
        expect(cachedKeys(store)).toEqual([]);
        expect(chipsEl.innerHTML).toBe(''); // early return, chips untouched/empty
    });

    test('offline (GET throws): falls back to cache read-only, still NO POST', async () => {
        const { initEnvVarBtn, calls, store, chipsEl } = harness(
            () => { throw new Error('network down'); },
            { API_KEY: 'a' },
        );
        await initEnvVarBtn('dev1', 'sec1');
        expect(calls.some((c) => c.method === 'POST')).toBe(false);
        // Cache untouched; display falls back to it (read-only, no resurrection risk).
        expect(cachedKeys(store).sort()).toEqual(['API_KEY']);
        expect(chipsEl.innerHTML).toContain('{{API_KEY}}');
    });
});
