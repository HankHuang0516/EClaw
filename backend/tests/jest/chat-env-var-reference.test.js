'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const chatHtml = fs.readFileSync(path.join(ROOT, 'public', 'portal', 'chat.html'), 'utf8');

function extractInitEnvVarBtn() {
    const start = chatHtml.indexOf('async function initEnvVarBtn(deviceId, deviceSecret)');
    expect(start).toBeGreaterThan(0);
    const end = chatHtml.indexOf('function openEnvVarFromMenu()', start);
    expect(end).toBeGreaterThan(start);
    return chatHtml.slice(start, end);
}

function buildContext(serverVars, initialLocalVars = {}) {
    const calls = [];
    const storage = new Map();
    storage.set('eclawLocalVars_device-1', JSON.stringify(initialLocalVars));
    const elements = {
        attachMenuEnvBtn: { style: { display: 'inline-flex' } },
        envVarChips: { innerHTML: 'stale chip' },
    };

    return {
        calls,
        elements,
        context: {
            apiCall: async (method, url, body) => {
                calls.push({ method, url, body });
                return { vars: serverVars };
            },
            document: {
                getElementById: id => elements[id] || null,
            },
            localStorage: {
                getItem: key => storage.has(key) ? storage.get(key) : null,
                setItem: (key, value) => storage.set(key, value),
                removeItem: key => storage.delete(key),
            },
            encodeURIComponent,
            JSON,
            Array,
            Object,
        },
        storage,
    };
}

describe('chat Key Reference server authority', () => {
    test('loads key chips from GET /api/device-vars without POST-merging local cache', async () => {
        const fnSource = extractInitEnvVarBtn();
        const { context, calls, storage, elements } = buildContext(
            { KEEP_ME: 'server-value' },
            { KEEP_ME: 'old-value', DELETED_ON_TASK_PAGE: 'stale-value' },
        );
        vm.createContext(context);
        const initEnvVarBtn = vm.runInContext(`${fnSource}; initEnvVarBtn;`, context);

        await initEnvVarBtn('device-1', 'secret-1');

        expect(calls).toEqual([
            {
                method: 'GET',
                url: '/api/device-vars?deviceId=device-1&deviceSecret=secret-1',
                body: undefined,
            },
        ]);
        expect(calls.some(call => call.method === 'POST')).toBe(false);
        expect(JSON.parse(storage.get('eclawLocalVars_device-1'))).toEqual({ KEEP_ME: 'server-value' });
        expect(elements.attachMenuEnvBtn.style.display).toBe('');
        expect(elements.envVarChips.innerHTML).toContain('{{KEEP_ME}}');
        expect(elements.envVarChips.innerHTML).not.toContain('DELETED_ON_TASK_PAGE');
    });

    test('clears stale local cache and hides chips when server vault is empty', async () => {
        const fnSource = extractInitEnvVarBtn();
        const { context, calls, storage, elements } = buildContext(
            {},
            { DELETED_ON_TASK_PAGE: 'stale-value' },
        );
        vm.createContext(context);
        const initEnvVarBtn = vm.runInContext(`${fnSource}; initEnvVarBtn;`, context);

        await initEnvVarBtn('device-1', 'secret-1');

        expect(calls).toHaveLength(1);
        expect(calls[0].method).toBe('GET');
        expect(calls.some(call => call.method === 'POST')).toBe(false);
        expect(storage.has('eclawLocalVars_device-1')).toBe(false);
        expect(elements.attachMenuEnvBtn.style.display).toBe('none');
        expect(elements.envVarChips.innerHTML).toBe('');
    });
});
