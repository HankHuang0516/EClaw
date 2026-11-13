/**
 * Synthetic EClaw admin snapshots in the Hub. Run the browser IIFE in a VM,
 * as the other Hub UI tests do; no server, database or real credentials.
 */
/* global jest, afterEach, describe, test, expect */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const express = require('express');
const request = require('supertest');
const hub = require('../../aihankapps-hub');

const PAGE_DIR = path.resolve(__dirname, '../../aihankapps-hub');
const SOURCES = [
    ['users', '/api/admin/users', 'users', ['email', 'source', 'subscriptionExpiresAt', 'heldEcoin']],
    ['bots', '/api/admin/bots?readOnly=1', 'bots', ['botId', 'conversations24h', 'avgConvPer5h', 'uniqueUsers24h', 'assignedEntityId']],
    ['bindings', '/api/admin/bindings', 'bindings', ['botId', 'entityId', 'subscriptionVerifiedAt']],
    ['skills', '/api/skill-templates/contributions', 'contributions', ['id', 'status', 'verificationResult.githubStatus', 'verificationResult.stars']],
    ['souls', '/api/soul-templates/contributions', 'contributions', ['id', 'description', 'submittedBy.entityName']],
    ['rules', '/api/rule-templates/contributions', 'contributions', ['id', 'ruleType', 'description']],
    ['arena', '/api/arena/feedback?limit=50', 'feedback', ['model', 'total_score', 'desired_capabilities', 'credibility_score']],
    ['paper', '/api/admin/paper-beta-feedback', 'items', ['rating', 'continuation', 'comment', 'createdAt']],
    ['submissions', '/api/admin/minigame-submissions?limit=50', 'submissions', ['category', 'severity', 'status', 'message', 'github_issue_url']],
    ['errors', '/api/admin/minigame-analytics?hours=24&limit=25', 'errorStats', ['gameId', 'serverErrors', 'telemetryErrors', 'errorSignature']]
];
const STATS_URL = '/api/admin/stats';
const SECRET = 'SYNTHETIC_DO_NOT_RENDER_credential';
const ATTACK = '<img src=x onerror="alert(1)"><script>alert(2)</script>&\'"';
const text = (key, vars = {}) => key + Object.entries(vars).map(([k, v]) => ' ' + k + '=' + v).join('');
const decode = s => s.replace(/&(?:amp|lt|gt|quot|#39);/g, e => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" }[e]));

// Only the DOM surface used by this IIFE: HTML containers, selectors, delegated
// events, focus and scrolling. Parse real emitted markup so assertions observe
// replacements/clears, rather than returning permanently pre-populated nodes.
function fakeDom() {
    const document = { hidden: false, activeElement: null };
    const VOID = new Set(['input', 'img', 'br', 'hr', 'meta', 'link']);
    class Element {
        constructor(tag = 'div', opening = '<div>') {
            this.tagName = tag;
            this.opening = opening;
            this.parts = [];
            this.attrs = {};
            this.parentElement = null;
            this.listeners = new Map();
            for (const m of opening.replace(/^<[^\s>]+/, '').matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
                this.attrs[m[1]] = decode(m[2] ?? m[3] ?? m[4] ?? '');
            }
            this.dataset = Object.fromEntries(Object.entries(this.attrs).filter(([k]) => k.startsWith('data-'))
                .map(([k, v]) => [k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase()), v]));
            this.value = this.attrs.value || '';
            this.checked = Object.hasOwn(this.attrs, 'checked');
            this.disabled = Object.hasOwn(this.attrs, 'disabled');
            this.scrollIntoView = jest.fn();
        }
        get isConnected() { return this.parentElement ? this.parentElement.isConnected : this.connected === true; }
        get children() { return this.parts.filter(p => p instanceof Element); }
        get innerHTML() { return this.parts.map(p => typeof p === 'string' ? p : p.outerHTML).join(''); }
        get outerHTML() { return this.opening + (VOID.has(this.tagName) ? '' : this.innerHTML + '</' + this.tagName + '>'); }
        get textContent() { return this.parts.map(p => typeof p === 'string' ? decode(p) : p.textContent).join(''); }
        set innerHTML(html) {
            this.replaceChildren();
            const stack = [this];
            for (const token of String(html).match(/<!--[\s\S]*?-->|<\/?[a-z][^>]*>|[^<]+|</gi) || []) {
                if (token.startsWith('<!--')) continue;
                if (token.startsWith('</')) { if (stack.length > 1) stack.pop(); continue; }
                const start = /^<([a-z][\w-]*)/i.exec(token);
                if (!start) { stack.at(-1).parts.push(token); continue; }
                const child = new Element(start[1].toLowerCase(), token);
                child.parentElement = stack.at(-1);
                child.parentElement.parts.push(child);
                if (!VOID.has(child.tagName)) stack.push(child);
            }
        }
        replaceChildren() { this.children.forEach(c => { c.parentElement = null; }); this.parts = []; }
        insertAdjacentHTML(where, html) {
            if (where !== 'beforeend') throw new Error('Unsupported insertion: ' + where);
            const holder = new Element(); holder.innerHTML = html;
            holder.children.forEach(c => { c.parentElement = this; });
            this.parts.push(...holder.parts);
        }
        matches(selector) {
            if (selector.startsWith('.')) return (this.attrs.class || '').split(/\s+/).includes(selector.slice(1));
            if (selector.startsWith('#')) return this.attrs.id === selector.slice(1);
            if (selector.startsWith('[')) return [...selector.matchAll(/\[([^=\]]+)(?:="([^"]*)")?\]/g)]
                .every(([, key, value]) => Object.hasOwn(this.attrs, key) && (value === undefined || this.attrs[key] === value));
            return this.tagName === selector;
        }
        querySelectorAll(selector) {
            const all = [], selectors = selector.split(',').map(s => s.trim().split(/\s+/));
            const visit = node => node.children.forEach(child => {
                if (selectors.some(parts => {
                    if (!child.matches(parts.at(-1))) return false;
                    let ancestor = child.parentElement;
                    for (let i = parts.length - 2; i >= 0; i--) {
                        while (ancestor && !ancestor.matches(parts[i])) ancestor = ancestor.parentElement;
                        if (!ancestor) return false;
                        ancestor = ancestor.parentElement;
                    }
                    return true;
                })) all.push(child);
                visit(child);
            });
            visit(this); return all;
        }
        querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
        closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
        contains(node) { return !!node && (node === this || this.children.some(c => c.contains(node))); }
        addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); }
        removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
        emit(type, target = this) { for (const fn of this.listeners.get(type) || []) fn({ type, target }); }
        focus() { document.activeElement = this; }
    }
    const root = new Element(); root.connected = true;
    return { root, document };
}

function user(email, extra = {}) {
    return { email, source: 'registered', emailVerified: true, isAdmin: false, subscriptionStatus: 'free',
        balanceEcoin: 0, deviceId: 'synthetic-device', createdAt: 0, lastLoginAt: null, ...extra };
}
function snapshots() {
    return {
        stats: { success: true, users: { total: 101, premium: 13, verified: 97 }, devices: { total: 83, entities: 61, boundEntities: 47 },
            bindings: { total: 41, free: 31, personal: 10 }, messagesToday: 127, currentAppVersion: '1.2.3',
            recentSignups: [{ date: '2026-11-13', count: 17 }], platformBreakdown: { web: 71, app: 12, total: 83 },
            officialBots: { free: { total: 19, assigned: 11 }, personal: { total: 7, assigned: 3 } },
            botConversationsDaily: [{ date: '2026-11-13', botType: 'free', msgCount: 29, uniqueDevices: 23 }] },
        users: { success: true, users: [user('member@example.invalid')], totalDevices: 83 },
        bots: { success: true, bots: [{ botId: 'official-one', displayName: 'Helper', botType: 'free', status: 'available', conversations24h: 12, avgConvPer5h: 2.5, uniqueUsers24h: 5, avgUsersPer5h: 1, bindingCount: 3, assignedEntityId: 0, token: SECRET, webhookUrl: 'https://private.invalid/' + SECRET }] },
        bindings: { success: true, bindings: [{ botId: 'official-one', botType: 'free', deviceId: 'synthetic-device', entityId: 0 }] },
        skills: { success: true, contributions: [{ id: 'skill-one', title: 'Useful skill', status: 'pending', submittedBy: { entityName: 'Maker', entityId: 0 }, verificationResult: { githubStatus: 200, stars: 3 } }] },
        souls: { success: true, contributions: [{ id: 'soul-one', name: 'Patient', description: 'Patient assistant', submittedBy: { entityName: 'Maker' } }] },
        rules: { success: true, contributions: [{ id: 'rule-one', name: 'Review', ruleType: 'CODE_REVIEW', description: 'Check the changes' }] },
        arena: { success: true, feedback: [{ model: 'synthetic-model', total_score: 0, desired_capabilities: ['reasoning'], credibility_score: 0 }] },
        paper: { success: true, summary: { total: '51', averageRating: null, continuation: { yes: '0', maybe: null, no: '1' } }, items: [{ rating: 4, continuation: 'yes', comment: 'Keep it', version: '0.1', platform: 'web', createdAt: 0 }], nextCursor: '9007199254740993' },
        submissions: { success: true, summary: { total: 1, open: 1, bugReports: 1, highPriority: 0 }, submissions: [{ category: 'bug', severity: 'high', status: 'open', message: 'Button failed', github_issue_url: 'https://example.invalid/1' }] },
        errors: { success: true, summary: { errorEvents: 2, affectedGames: 1, pageViews: null, playActions: 0, uniqueDevices: null, totalEvents: 8 }, errorStats: [{ gameId: 'GAME-123', count: 2, serverErrors: 1, telemetryErrors: 1, errorSignature: 'Synthetic error' }],
            gameStats: [{ gameId: 'GAME-456', totalEvents: 8, playActions: 0, avgDurationMs: null }], recentErrors: [{ source: 'server_log', gameId: 'GAME-789', level: 'warn', message: 'Recent synthetic error', createdAt: 0 }] }
    };
}
const reply = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const settle = () => new Promise(resolve => setImmediate(resolve));
const runtimes = [];
function boot(responder) {
    const dom = fakeDom(), data = snapshots(), events = new Map(), intervals = new Map(), timeouts = new Map();
    const translationKeys = new Set();
    let timerId = 0, dispose;
    const storage = { getItem: jest.fn(() => null), setItem: jest.fn() };
    const location = { origin: 'https://eclawbot.com', href: '/AiHankApps/hub/' };
    const window = { HubEclawText: { t: (key, vars) => { translationKeys.add(key); return text(key, vars); }, locale: 'en-GB' },
        addEventListener: (type, fn) => { if (!events.has(type)) events.set(type, new Set()); events.get(type).add(fn); },
        removeEventListener: (type, fn) => events.get(type)?.delete(fn), parent: { postMessage: jest.fn() } };
    window.self = window; window.top = window;
    const fetch = jest.fn((url, options) => {
        const source = url === STATS_URL ? 'stats' : SOURCES.find(([, route]) => route.split('?')[0] === url.split('?')[0])?.[0];
        if (!source) throw new Error('Unexpected API request: ' + url);
        return responder ? responder(url, options, data[source], source) : Promise.resolve(reply(200, data[source]));
    });
    const context = { window, document: dom.document, localStorage: storage, location, fetch, AbortController, Intl, Date,
        setInterval: (fn, ms) => { const id = ++timerId; intervals.set(id, { fn, ms }); return id; }, clearInterval: id => intervals.delete(id),
        setTimeout: (fn, ms) => { const id = ++timerId; timeouts.set(id, { fn, ms }); return id; }, clearTimeout: id => timeouts.delete(id) };
    vm.runInNewContext(fs.readFileSync(path.join(PAGE_DIR, 'hub-eclaw.js'), 'utf8'), context, { filename: 'hub-eclaw.js' });
    const runtime = { api: window.HubEclaw, ...dom, data, fetch, window, storage, location, events, intervals, timeouts, translationKeys,
        mount: options => { dispose = window.HubEclaw.mount(dom.root, options); return dispose; },
        dispose: () => dispose?.(), emit: (type, event = {}) => { for (const fn of events.get(type) || []) fn(event); } };
    runtimes.push(runtime); return runtime;
}
afterEach(() => { for (const runtime of runtimes.splice(0)) runtime.dispose(); });
function click(root, action, value) {
    const selector = '[data-ec="' + action + '"]' + (value === undefined ? '' : '[data-value="' + value + '"]');
    const button = root.querySelector(selector);
    if (!button) throw new Error('Missing control: ' + selector);
    root.emit('click', button); return button;
}
function search(root, value) {
    const input = root.querySelector('[data-ec-input="search"]'); input.value = value; root.emit('input', input);
}
const rows = root => root.querySelectorAll('.ec-results tbody tr');
const definition = (api, id) => api.definitions.find(d => d.id === id);

describe('EClaw Hub: source coverage and safe field projection', () => {
    test.each(SOURCES)('%s keeps its API contract and essential drill-down fields', (id, url, list, required) => {
        const { api } = boot(), def = definition(api, id);
        expect(def).toMatchObject({ id, url, list });
        expect([...def.cols, ...(def.more || [])].map(c => c.key)).toEqual(expect.arrayContaining(required));
    });

    test.each(SOURCES)('%s projects only named fields, including nested leaves, without copying credentials', id => {
        const { api } = boot(), def = definition(api, id);
        const row = { id: 'stable-id', email: 'safe@example.invalid', title: 'Safe title', name: 'Safe name', botId: 'safe-bot',
            token: SECRET, webhookUrl: SECRET, deviceSecret: SECRET, unexpectedSecret: { nested: SECRET },
            submittedBy: { entityName: 'Safe maker', entityId: 0, secret: SECRET },
            verificationResult: { githubStatus: 200, stars: 0, token: SECRET } };
        const projected = api.project(row, def);
        expect(JSON.stringify(projected)).not.toContain(SECRET);
        for (const key of ['token', 'webhookUrl', 'deviceSecret', 'unexpectedSecret', 'submittedBy', 'verificationResult']) {
            expect(Object.hasOwn(projected, key)).toBe(false);
        }
        if (id === 'skills') expect(projected).toMatchObject({ title: 'Safe title', 'submittedBy.entityName': 'Safe maker', 'verificationResult.stars': 0 });
        expect(row.token).toBe(SECRET); // projection must not mutate the API snapshot
    });

    test('object and array display never serializes hidden payloads or interprets HTML', () => {
        const { api } = boot();
        expect(api.display({ token: SECRET }, {})).toBe('—');
        expect(api.display(['reasoning', { token: SECRET }, 0], {})).toBe('reasoning、0');
        expect(api.display(ATTACK, {})).toBe(ATTACK); // escaping belongs to the HTML renderer
        expect(api.display([], {})).toBe('—');
    });

    test('overview covers every original count and escapes a malicious app version', () => {
        const { api, data, root } = boot(); data.stats.currentAppVersion = ATTACK;
        root.innerHTML = api.overview(data.stats);
        const cards = Object.fromEntries(root.querySelectorAll('.dm-c').map(card => [card.querySelector('span').textContent, card.querySelector('b').textContent]));
        expect(cards).toMatchObject({ totalUsers: '101', premium: '13', verified: '97', devices: '83', entities: '61', boundEntities: '47', totalBindings: '41', freeBindings: '31', personalBindings: '10', messagesToday: '127' });
        expect(root.textContent).toContain(ATTACK);
        expect(root.innerHTML).toContain('&lt;img');
        expect(root.querySelectorAll('img,script')).toHaveLength(0);
    });

    test('missing aggregate counts stay unknown while genuine zero counts are rendered', () => {
        const { api, root } = boot();
        expect(api.overview(null)).toBe('');
        root.innerHTML = api.overview({ users: { total: null, verified: 0 }, messagesToday: 0 });
        const values = Object.fromEntries(root.querySelectorAll('.dm-c').map(card => [card.querySelector('span').textContent, card.querySelector('b').textContent]));
        expect(values).toMatchObject({ totalUsers: '—', premium: '—', verified: '0', devices: '—', totalBindings: '—', messagesToday: '0' });
        expect(api.insights({ stats: { users: { total: null, verified: 0 } }, errors: { summary: { errorEvents: null } } })).toEqual([]);
    });

    test.each([null, undefined, '', 'not-a-date'])('unknown or invalid date %p is not an epoch timestamp', value => {
        expect(boot().api.display(value, { format: 'date' })).toBe('—');
    });
    test('dates cross the calendar boundary in Taipei and timestamp zero remains valid', () => {
        const { api } = boot();
        expect(api.display('2026-11-13T16:30:00Z', { format: 'date' })).toBe('14/11/2026, 00:30:00');
        expect(api.display(0, { format: 'date' })).toBe('01/01/1970, 08:00:00');
        expect(api.display(0, { format: 'num' })).toBe('0');
        expect(api.display(null, { format: 'num' })).toBe('—');
        expect(api.display(Infinity, { format: 'num' })).toBe('—');
    });

    test('day buckets preserve the source calendar day without manufacturing a local time', () => {
        const { api } = boot();
        for (const value of ['2026-11-13', '2026-11-13T00:00:00.000Z', '2026-11-13T23:30:00-08:00']) {
            expect(api.display(value, { format: 'day' })).toBe('2026-11-13');
        }
        for (const value of [null, undefined, '', 'not-a-day', 0]) expect(api.display(value, { format: 'day' })).toBe('—');
    });

    test.each(['souls', 'rules'])('%s preserves the old name-or-label fallback without replacing an existing name', id => {
        const { api } = boot(), def = definition(api, id), column = def.cols.find(col => col.key === 'name');
        for (const name of [undefined, null, '']) {
            const row = { name, label: 'Legacy display label' }, projected = api.project(row, def);
            expect(api.display(projected.name, column)).toBe('Legacy display label');
            expect(row.name).toBe(name);
        }
        expect(api.project({ name: 'Preferred name', label: 'Fallback label' }, def).name).toBe('Preferred name');
        expect(api.display(api.project({}, def).name, column)).toBe('—');
    });

    test('APP-only devices have no account verification, role or wallet values; real account false and zero remain meaningful', () => {
        const { api } = boot(), def = definition(api, 'users'), cols = [...def.cols, ...def.more];
        const row = user(null, { source: 'app_device', emailVerified: false, isAdmin: false, balanceEcoin: 0, heldEcoin: 0, boundEntities: 2 });
        const appDevice = api.project(row, def), account = api.project({ ...row, source: 'registered' }, def);
        for (const key of ['emailVerified', 'isAdmin', 'balanceEcoin', 'heldEcoin']) {
            expect(appDevice[key]).toBeNull();
            expect(api.display(appDevice[key], cols.find(col => col.key === key))).toBe('—');
        }
        expect(account).toMatchObject({ emailVerified: false, isAdmin: false, balanceEcoin: 0, heldEcoin: 0 });
        expect(api.display(account.emailVerified, cols.find(col => col.key === 'emailVerified'))).toBe('no');
        expect(api.display(account.isAdmin, cols.find(col => col.key === 'isAdmin'))).toBe('member');
        expect(api.display(account.balanceEcoin, cols.find(col => col.key === 'balanceEcoin'))).toBe('0');
        expect(appDevice.boundEntities).toBe(2);
        expect(row).toMatchObject({ emailVerified: false, isAdmin: false, balanceEcoin: 0, heldEcoin: 0 });
    });

    test('personal bots omit free-only unique-user measures while retaining conversation activity', () => {
        const { api } = boot(), def = definition(api, 'bots');
        const row = { botType: 'personal', uniqueUsers24h: 12, avgUsersPer5h: 2.5, conversations24h: 24, avgConvPer5h: 5 };
        const personal = api.project(row, def);
        for (const key of ['uniqueUsers24h', 'avgUsersPer5h']) {
            expect(personal[key]).toBeNull();
            expect(api.display(personal[key], def.cols.find(col => col.key === key))).toBe('—');
        }
        expect(personal).toMatchObject({ conversations24h: 24, avgConvPer5h: 5 });
        expect(api.project({ ...row, botType: 'free' }, def)).toMatchObject({ uniqueUsers24h: 12, avgUsersPer5h: 2.5 });
        expect(api.project({ ...row, botType: 'free', uniqueUsers24h: 0, avgUsersPer5h: 0 }, def)).toMatchObject({ uniqueUsers24h: 0, avgUsersPer5h: 0 });
        expect(row.uniqueUsers24h).toBe(12);
    });

    test.each([
        ['users', { source: 'registered', emailVerified: false }, true], ['users', { source: 'registered', emailVerified: true }, false],
        ['users', { source: 'app_device', emailVerified: false }, false], ['skills', { status: 'pending' }, true], ['skills', { status: 'approved' }, false],
        ['submissions', { status: 'open' }, true], ['submissions', { status: 'closed' }, false], ['submissions', { status: 'resolved' }, false],
        ['errors', { count: 1 }, true], ['bots', { status: 'assigned' }, false]
    ])('%s attention reflects actionable state %j', (id, row, expected) => {
        expect(boot().api.attention(row, id)).toBe(expected);
    });
    test.each([
        [{ isTestDevice: true, email: 'real@example.invalid' }, true], [{ email: 'QA+run@example.invalid' }, true],
        [{ email: 'e2e.run@example.invalid' }, true], [{ email: 'test@example.invalid' }, true], [{ email: 'arena_test_17@example.invalid' }, true],
        [{ isTestDevice: false, email: 'contest@example.invalid' }, false], [{ email: 'qauser@example.invalid' }, false], [{}, false]
    ])('QA classification preserves regular accounts: %j', (row, expected) => {
        expect(boot().api.isQa(row)).toBe(expected);
    });
    test('insights point to the relevant list and attention filter, using actual source totals', () => {
        const { api, data } = boot(), items = api.insights(data);
        expect(items).toEqual(expect.arrayContaining([
            expect.objectContaining({ tab: 'users', filter: 'attention', text: 'unverifiedInsight n=4' }),
            expect.objectContaining({ tab: 'bindings', text: 'bindingInsight n=1' }),
            expect.objectContaining({ tab: 'skills', filter: 'attention', text: 'pendingInsight n=1' }),
            expect.objectContaining({ tab: 'errors', text: 'errorsInsight n=2' })
        ]));
    });
});

describe('EClaw Hub: mounted reading, filtering and lifecycle', () => {
    test('mount reads all eleven sources privately, displays stats drill-downs and excludes credentials', async () => {
        const r = boot(); r.mount();
        expect(r.root.querySelector('.ec-status').textContent).toContain('loading');
        await settle();
        expect(r.fetch.mock.calls.map(([url]) => url).sort()).toEqual([STATS_URL, ...SOURCES.map(([, url]) => url)].sort());
        for (const [, options] of r.fetch.mock.calls) {
            expect(options).toMatchObject({ credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } });
            expect(options.method || 'GET').toBe('GET'); expect(options.body).toBeUndefined();
            expect(options.signal.aborted).toBe(false);
        }
        expect(r.root.querySelectorAll('.ec-tabs [data-ec="tab"]')).toHaveLength(10);
        expect(rows(r.root)[0].textContent).toContain('member@example.invalid');
        const overview = r.root.querySelector('.ec-overview');
        for (const label of ['signup', 'platform', 'botOverview', 'botDaily']) expect(overview.textContent).toContain(label);
        for (const value of ['17', '71', '19', '29', '23']) expect(overview.textContent).toContain(value);
        click(r.root, 'tab', 'bots'); click(r.root, 'detail', '0');
        expect(r.root.querySelector('#ec-detail').textContent).toContain('official-one');
        expect(r.root.innerHTML).not.toContain(SECRET);
        expect(r.timeouts.size).toBe(0);
    });

    test('signup and conversation tables render API day buckets as days, separately from timestamp fields', async () => {
        const r = boot();
        r.data.stats.recentSignups[0].date = '2026-11-13T00:00:00.000Z';
        r.data.stats.botConversationsDaily[0].date = '2026-11-13T23:30:00-08:00';
        r.mount(); await settle();
        const dayCells = r.root.querySelectorAll('.ec-stats tbody tr').map(row => row.querySelector('td').textContent)
            .filter(value => value.startsWith('2026'));
        expect(dayCells).toEqual(['2026-11-13', '2026-11-13']);
        expect(rows(r.root)[0].textContent).toContain('01/01/1970, 08:00:00'); // an actual timestamp still uses Taipei
    });

    test('row and detail renderers escape whitelisted hostile text and do not make HTML executable', async () => {
        const r = boot(); r.data.users.users = [user(ATTACK, { token: SECRET, hiddenPayload: SECRET })]; r.mount(); await settle();
        expect(rows(r.root)[0].textContent).toContain(ATTACK);
        click(r.root, 'detail', '0');
        expect(r.root.querySelector('#ec-detail').textContent).toContain(ATTACK);
        expect(r.root.querySelectorAll('img,script')).toHaveLength(0);
        expect(r.root.innerHTML).toContain('&lt;script&gt;');
        expect(r.root.innerHTML).not.toContain(SECRET);
        expect(r.root.querySelector('#ec-detail').scrollIntoView).toHaveBeenCalled();
    });

    test('pagination and search reset the current page and cannot search excluded secrets', async () => {
        const r = boot(); r.data.users.users = Array.from({ length: 52 }, (_, i) => user('person-' + String(i).padStart(2, '0') + '@example.invalid', { token: SECRET }));
        r.mount(); await settle();
        expect(rows(r.root)).toHaveLength(25); expect(rows(r.root)[0].textContent).toContain('person-00@');
        expect(r.root.querySelector('[data-ec="previous"]').disabled).toBe(true);
        click(r.root, 'next'); expect(rows(r.root)[0].textContent).toContain('person-25@');
        click(r.root, 'next'); expect(rows(r.root)).toHaveLength(2);
        expect(r.root.querySelector('[data-ec="next"]').disabled).toBe(true);
        search(r.root, 'PERSON-01@'); expect(rows(r.root)).toHaveLength(1);
        expect(rows(r.root)[0].textContent).toContain('person-01@');
        search(r.root, SECRET); expect(rows(r.root)).toHaveLength(0);
        expect(r.root.querySelector('.ec-results').textContent).toContain('noMatch');
        search(r.root, ''); expect(rows(r.root)).toHaveLength(25);
        click(r.root, 'next'); click(r.root, 'previous'); expect(rows(r.root)[0].textContent).toContain('person-00@');
        expect(r.fetch).toHaveBeenCalledTimes(11); // local exploration must not reload all sources
    });

    test('numeric sorting changes direction and leaves missing balances last', async () => {
        const r = boot(); r.data.users.users = [user('ten@example.invalid', { balanceEcoin: 10 }), user('missing@example.invalid', { balanceEcoin: null }), user('two@example.invalid', { balanceEcoin: 2 })];
        r.mount(); await settle();
        click(r.root, 'sort', 'balanceEcoin');
        expect(rows(r.root).map(row => row.querySelectorAll('td')[1].textContent)).toEqual(['two@example.invalid', 'ten@example.invalid', 'missing@example.invalid']);
        click(r.root, 'sort', 'balanceEcoin');
        expect(rows(r.root).map(row => row.querySelectorAll('td')[1].textContent)).toEqual(['ten@example.invalid', 'two@example.invalid', 'missing@example.invalid']);
    });

    test('QA is visible by default; QA, attention and platform filters compose without hiding real users', async () => {
        const r = boot(); r.data.users.users = [user('qa+one@example.invalid', { emailVerified: false }), user('regular@example.invalid', { emailVerified: false }), user('verified@example.invalid'), user(null, { source: 'app_device', emailVerified: false })];
        r.mount(); await settle(); expect(rows(r.root)).toHaveLength(4);
        const checkbox = r.root.querySelector('[data-ec-input="qa"]'); checkbox.checked = true; r.root.emit('input', checkbox);
        expect(rows(r.root)).toHaveLength(3);
        click(r.root, 'filter', 'attention'); expect(rows(r.root)).toHaveLength(1);
        expect(rows(r.root)[0].textContent).toContain('regular@example.invalid');
        click(r.root, 'filter', 'app'); expect(rows(r.root)).toHaveLength(1);
        expect(rows(r.root)[0].textContent).not.toContain('regular@example.invalid');
    });

    test('a failed source leaves successful data available and a retry requests only that source', async () => {
        let fail = true;
        const r = boot((_url, _options, data, id) => Promise.resolve(reply(id === 'skills' && fail ? 503 : 200, data)));
        r.mount(); await settle();
        expect(r.root.querySelector('.ec-insights').textContent).toContain('partial');
        expect(rows(r.root)[0].textContent).toContain('member@example.invalid');
        click(r.root, 'tab', 'skills'); expect(r.root.querySelector('.ec-body').textContent).toContain('unavailable');
        fail = false; click(r.root, 'retry', 'skills'); await settle();
        expect(r.fetch).toHaveBeenCalledTimes(12);
        expect(r.fetch.mock.calls.at(-1)[0]).toBe('/api/skill-templates/contributions');
        expect(rows(r.root)[0].textContent).toContain('Useful skill');
        expect(r.root.querySelector('.ec-insights').textContent).not.toContain('partial');
    });

    test.each([{ success: false, users: [] }, { success: true, users: {} }])('malformed success response %j cannot masquerade as an empty users list', async body => {
        const r = boot((_url, _options, data, id) => Promise.resolve(reply(200, id === 'users' ? body : data)));
        r.mount(); await settle();
        expect(r.root.querySelector('.ec-body').textContent).toContain('unavailable');
        expect(r.root.querySelector('.ec-body').textContent).not.toContain('empty');
        expect(r.root.querySelector('[data-ec="retry"][data-value="users"]')).not.toBeNull();
    });

    test.each([401, 403])('HTTP %i on refresh clears previously loaded private data and stops background refresh', async status => {
        let denied = false;
        const r = boot((_url, _options, data, id) => Promise.resolve(reply(denied && id === 'users' ? status : 200, data)));
        r.mount(); await settle(); expect(rows(r.root)[0].textContent).toContain('member@example.invalid');
        denied = true; click(r.root, 'refresh'); await settle();
        expect(r.root.querySelector('.ec-status').textContent).toContain('denied');
        for (const selector of ['.ec-overview', '.ec-insights', '.ec-tabs', '.ec-body']) expect(r.root.querySelector(selector).innerHTML).toBe('');
        expect(r.root.innerHTML).not.toContain('member@example.invalid');
        expect(r.intervals.size).toBe(0);
        expect(r.fetch.mock.calls.at(-1)[1].signal.aborted).toBe(true);
    });

    test('refresh failure removes stale rows instead of displaying the old snapshot as current', async () => {
        let fail = false;
        const r = boot((_url, _options, data, id) => Promise.resolve(reply(fail && id === 'users' ? 500 : 200, data)));
        r.mount(); await settle(); fail = true; click(r.root, 'refresh'); await settle();
        expect(r.root.querySelector('.ec-body').textContent).toContain('unavailable');
        expect(r.root.innerHTML).not.toContain('member@example.invalid');
        expect(r.root.querySelector('.ec-overview').textContent).toContain('101');
    });

    test('dispose aborts in-flight reads, unregisters handlers, and rejects late repainting', async () => {
        const pending = [];
        const r = boot((_url, options, data) => new Promise(resolve => pending.push({ options, resolve, data })));
        r.mount(); expect(pending).toHaveLength(11);
        r.dispose(); const disposedHtml = r.root.innerHTML;
        expect(pending.every(p => p.options.signal.aborted)).toBe(true);
        expect(r.intervals.size).toBe(0);
        expect(r.root.listeners.get('click').size).toBe(0); expect(r.root.listeners.get('input').size).toBe(0);
        expect(r.events.get('pagehide').size).toBe(0); expect(r.events.get('pageshow').size).toBe(0);
        pending.forEach(p => p.resolve(reply(200, p.data))); await settle();
        expect(r.root.innerHTML).toBe(disposedHtml); expect(r.timeouts.size).toBe(0);
    });

    test.each([401, 403])('a delayed old HTTP %i after a bfcache reload cannot revoke the new snapshot', async status => {
        let finishOldRequest, oldSignal;
        const r = boot((_url, options, data, id) => {
            // Model a transport whose response arrives despite the old signal being aborted.
            if (id === 'users' && !finishOldRequest) {
                oldSignal = options.signal;
                return new Promise(resolve => { finishOldRequest = resolve; });
            }
            return Promise.resolve(reply(200, data));
        });
        r.mount(); await settle();
        expect(oldSignal.aborted).toBe(false);
        r.emit('pagehide');
        expect(oldSignal.aborted).toBe(true);
        r.data.users = { success: true, users: [user('new-session@example.invalid')] };
        r.emit('pageshow', { persisted: true }); await settle();
        const currentSignal = r.fetch.mock.calls.at(-1)[1].signal;
        expect(currentSignal).not.toBe(oldSignal);
        expect(rows(r.root)[0].textContent).toContain('new-session@example.invalid');
        const stale = reply(status, { success: false }); stale.json = jest.fn();
        finishOldRequest(stale); await settle();
        expect(currentSignal.aborted).toBe(false);
        expect(stale.json).not.toHaveBeenCalled();
        expect(r.root.querySelector('.ec-status').textContent).not.toContain('denied');
        expect(rows(r.root)[0].textContent).toContain('new-session@example.invalid');
        expect(r.intervals.size).toBe(1);
        click(r.root, 'tab', 'bots');
        expect(rows(r.root)[0].textContent).toContain('official-one');
    });

    test('an older load timeout cannot abort the controller of a newer in-flight load', async () => {
        const pending = { old: [], current: [] };
        let generation = 'old';
        const r = boot((_url, options, data) => new Promise(resolve => {
            pending[generation].push({ signal: options.signal, data, resolve });
        }));
        r.mount();
        const oldTimeout = [...r.timeouts.values()].find(timer => timer.ms === 20000);
        expect(oldTimeout).toBeDefined(); expect(pending.old).toHaveLength(11);
        r.emit('pagehide'); generation = 'current';
        r.data.users = { success: true, users: [user('current-load@example.invalid')] };
        r.emit('pageshow', { persisted: true });
        expect(pending.current).toHaveLength(11);
        const currentSignal = pending.current[0].signal;
        expect(currentSignal).not.toBe(pending.old[0].signal);
        expect(currentSignal.aborted).toBe(false);
        oldTimeout.fn();
        expect(pending.old.every(p => p.signal.aborted)).toBe(true);
        expect(currentSignal.aborted).toBe(false);
        pending.old.forEach(p => p.resolve(reply(200, p.data))); await settle();
        expect(currentSignal.aborted).toBe(false);
        pending.current.forEach(p => p.resolve(reply(200, p.data))); await settle();
        expect(rows(r.root)[0].textContent).toContain('current-load@example.invalid');
        expect(r.root.querySelector('.ec-status').textContent).not.toContain('unavailable');
        expect(r.timeouts.size).toBe(0);
    });

    test('paper cursor paging preserves large string IDs and refreshes only the paper source', async () => {
        const r = boot(); r.mount(); await settle(); click(r.root, 'tab', 'paper');
        const summary = Object.fromEntries(r.root.querySelectorAll('.ec-body .dm-c').map(card => [card.querySelector('span').textContent, card.querySelector('b').textContent]));
        expect(summary).toMatchObject({ paperTotal: '51', averageRating: '—', paperYes: '0', paperMaybe: '—' });
        r.data.paper = { ...r.data.paper, nextCursor: null, items: [{ rating: 2, continuation: 'maybe', comment: 'Older response' }] };
        click(r.root, 'paper-older'); await settle();
        expect(r.fetch).toHaveBeenCalledTimes(12);
        expect(r.fetch.mock.calls.at(-1)[0]).toBe('/api/admin/paper-beta-feedback?before=9007199254740993');
        expect(rows(r.root)[0].textContent).toContain('Older response');
        expect(r.root.querySelector('[data-ec="paper-older"]').disabled).toBe(true);
        click(r.root, 'paper-latest'); await settle();
        expect(r.fetch.mock.calls.at(-1)[0]).toBe('/api/admin/paper-beta-feedback');
    });

    test('background refresh pauses while editing a text input but resumes with a focused button', async () => {
        const r = boot(); r.mount(); await settle();
        const tick = [...r.intervals.values()][0].fn;
        r.root.querySelector('[data-ec-input="search"]').focus();
        tick(); await settle(); expect(r.fetch).toHaveBeenCalledTimes(11);
        r.root.querySelector('[data-ec="tab"][data-value="users"]').focus();
        tick(); await settle(); expect(r.fetch).toHaveBeenCalledTimes(22);
        expect(rows(r.root)[0].textContent).toContain('member@example.invalid');
    });

    test('older submission pages pause polling until the operator returns to the latest source page', async () => {
        const r = boot(), latest = { ...r.data.submissions, submissions: Array.from({ length: 50 }, (_, i) => ({ status: 'open', message: 'Latest submission ' + i })) };
        r.data.submissions = latest; r.mount(); await settle(); click(r.root, 'tab', 'submissions');
        r.data.submissions = { ...latest, submissions: [{ status: 'open', message: 'Older submission' }] };
        click(r.root, 'submissions-older'); await settle();
        expect(r.fetch.mock.calls.at(-1)[0]).toBe('/api/admin/minigame-submissions?limit=50&offset=50');
        expect(rows(r.root)[0].textContent).toContain('Older submission');
        const tick = [...r.intervals.values()][0].fn;
        tick(); await settle(); expect(r.fetch).toHaveBeenCalledTimes(12);
        expect(rows(r.root)[0].textContent).toContain('Older submission');
        r.data.submissions = latest; click(r.root, 'submissions-latest'); await settle();
        expect(r.fetch.mock.calls.at(-1)[0]).toBe('/api/admin/minigame-submissions?limit=50');
        expect(rows(r.root)[0].textContent).toContain('Latest submission 0');
        tick(); await settle(); expect(r.fetch).toHaveBeenCalledTimes(24);
    });

    test('analytics exposes all three datasets and keeps unknown summaries distinct from zero', async () => {
        const r = boot(); r.data.errors.recentErrors[0].message = ATTACK; r.mount(); await settle();
        click(r.root, 'tab', 'errors'); expect(rows(r.root)[0].textContent).toContain('GAME-123');
        const summary = Object.fromEntries(r.root.querySelectorAll('.ec-body .dm-c').map(card => [card.querySelector('span').textContent, card.querySelector('b').textContent]));
        expect(summary).toMatchObject({ pageViews: '—', plays: '0', devices: '—', telemetryEvents: '8' });
        click(r.root, 'error-tab', 'gameStats'); expect(rows(r.root)[0].textContent).toContain('GAME-456');
        click(r.root, 'error-tab', 'recentErrors'); expect(rows(r.root)[0].textContent).toContain('GAME-789');
        expect(rows(r.root)[0].textContent).toContain(ATTACK);
        expect(r.root.querySelectorAll('img,script')).toHaveLength(0);
    });

    test('pagehide clears private views and a bfcache return obtains fresh data', async () => {
        const r = boot(); r.mount(); await settle();
        r.emit('pagehide'); expect(r.root.innerHTML).not.toContain('member@example.invalid');
        r.data.users.users = [user('fresh@example.invalid')]; r.emit('pageshow', { persisted: true }); await settle();
        expect(rows(r.root)[0].textContent).toContain('fresh@example.invalid');
        expect(r.fetch).toHaveBeenCalledTimes(22);
    });
});

describe('original admin entry: authenticated redirect and explicit operation access', () => {
    function adminEntry(query) {
        const html = fs.readFileSync(path.resolve(PAGE_DIR, '../public/portal/admin.html'), 'utf8');
        const source = html.match(/async function init\(\)\s*\{[\s\S]*?\n        \}/);
        if (!source) throw new Error('Cannot locate the original admin init function');
        let authenticate;
        const content = fakeDom().root;
        const checkAuth = jest.fn(() => new Promise(resolve => { authenticate = resolve; }));
        const loadAll = jest.fn().mockResolvedValue(undefined), replace = jest.fn(), initPortalSocket = jest.fn();
        const sandbox = { renderNav: jest.fn(), renderFooter: jest.fn(), i18n: { t: text, apply: jest.fn(), onLanguageChange: jest.fn() },
            statsData: null, render: jest.fn(), checkAuth, loadAll, initPortalSocket, URLSearchParams,
            document: { getElementById: id => id === 'adminContent' ? content : null }, window: { location: { search: query, replace } } };
        const init = vm.runInNewContext(source[0] + '\ninit;', sandbox);
        return { init, content, checkAuth, loadAll, replace, initPortalSocket, authenticate: user => authenticate(user) };
    }

    test.each(['', '?operations=0', '?operations=01', '?other=1'])('admin entry %s redirects to the Hub only after authentication', async query => {
        const entry = adminEntry(query), work = entry.init();
        expect(entry.checkAuth).toHaveBeenCalledTimes(1);
        expect(entry.replace).not.toHaveBeenCalled(); expect(entry.loadAll).not.toHaveBeenCalled();
        expect(entry.initPortalSocket).not.toHaveBeenCalled();
        entry.authenticate({ isAdmin: true }); await work;
        expect(entry.replace).toHaveBeenCalledWith('/AiHankApps/hub/#app-eclawbot');
        expect(entry.loadAll).not.toHaveBeenCalled();
    });

    test.each(['?operations=1', '?other=1&operations=1'])('explicit %s preserves loadAll after successful admin authentication', async query => {
        const entry = adminEntry(query), work = entry.init();
        expect(entry.loadAll).not.toHaveBeenCalled(); expect(entry.replace).not.toHaveBeenCalled();
        entry.authenticate({ isAdmin: true }); await work;
        expect(entry.loadAll).toHaveBeenCalledTimes(1);
        expect(entry.initPortalSocket).toHaveBeenCalledTimes(1);
        expect(entry.replace).not.toHaveBeenCalled();
    });

    test.each(['', '?operations=1'])('an unauthenticated visitor to %s receives neither private data nor an admin redirect', async query => {
        const entry = adminEntry(query), work = entry.init(); entry.authenticate(null); await work;
        expect(entry.loadAll).not.toHaveBeenCalled(); expect(entry.replace).not.toHaveBeenCalled();
        expect(entry.initPortalSocket).not.toHaveBeenCalled();
    });

    test.each(['', '?operations=1'])('a non-admin visitor to %s cannot use the operation bypass', async query => {
        const entry = adminEntry(query), work = entry.init(); entry.authenticate({ isAdmin: false }); await work;
        expect(entry.loadAll).not.toHaveBeenCalled(); expect(entry.replace).not.toHaveBeenCalled();
        expect(entry.content.querySelector('[data-i18n="admin_access_denied"]')).not.toBeNull();
    });
});

describe('EClaw localization: field and rendered label coverage', () => {
    function dictionaries() {
        const sandbox = { window: {}, document: { documentElement: { lang: 'en' } }, localStorage: { getItem: () => null } };
        vm.runInNewContext(fs.readFileSync(path.join(PAGE_DIR, 'hub-eclaw-i18n.js'), 'utf8'), sandbox);
        return sandbox.window.HubEclawText;
    }
    function missingKeys(messages, keys) {
        return Object.entries(messages).flatMap(([locale, dictionary]) => [...keys].filter(key =>
            !Object.hasOwn(dictionary, key) || typeof dictionary[key] !== 'string' || !dictionary[key].trim())
            .map(key => locale + ':' + key));
    }
    test('every published dictionary owns all declared table and detail labels, without English fallback', () => {
        const { api } = boot(), localization = dictionaries();
        const labels = new Set(api.definitions.flatMap(def => [...def.cols, ...(def.more || [])].map(col => col.label)));
        expect(labels.size).toBeGreaterThan(0);
        expect(localization.messages.en).toBeDefined();
        expect(localization.locales.slice().sort()).toEqual(Object.keys(localization.messages).sort());
        expect(missingKeys(localization.messages, labels)).toEqual([]);
    });
    test('all dictionaries cover labels actually requested by stats, summaries, lists and detail renderers', async () => {
        const r = boot(); r.mount(); await settle();
        for (const def of r.api.definitions) {
            click(r.root, 'tab', def.id); click(r.root, 'detail', '0');
        }
        for (const kind of ['gameStats', 'recentErrors']) {
            click(r.root, 'error-tab', kind); click(r.root, 'detail', '0');
        }
        const localization = dictionaries();
        expect(missingKeys(localization.messages, r.translationKeys)).toEqual([]);
    });
});

describe('EClaw Hub assets retain the existing private allowlist and admin gate', () => {
    function app() {
        const server = express(), pool = { query: jest.fn() };
        const routers = hub.createRouters({
            authMiddleware: (req, res, next) => {
                const role = req.get('x-test-role');
                if (!['admin', 'member'].includes(role)) return res.status(401).json({ success: false });
                req.user = { role }; next();
            },
            adminMiddleware: (req, res, next) => req.user.role === 'admin' ? next() : res.status(403).json({ success: false }),
            getPool: () => pool, getAuthPool: () => pool, isReady: () => true
        });
        server.use('/AiHankApps/hub', routers.page);
        return { server, pool };
    }
    test.each(['hub-eclaw.js', 'hub-eclaw-i18n.js', 'hub-eclaw.css'])('%s is inaccessible to anonymous and member sessions, and served privately to an admin', async file => {
        const { server, pool } = app(), url = '/AiHankApps/hub/' + file;
        expect((await request(server).get(url)).status).toBe(401);
        expect((await request(server).get(url).set('x-test-role', 'member')).status).toBe(403);
        const allowed = await request(server).get(url).set('x-test-role', 'admin');
        expect(allowed.status).toBe(200);
        expect(allowed.headers['cache-control']).toContain('private, no-store');
        expect(allowed.headers['cdn-cache-control']).toBe('no-store');
        expect(allowed.text).toBe(fs.readFileSync(path.join(PAGE_DIR, file), 'utf8'));
        expect(pool.query).not.toHaveBeenCalled();
    });
    test('source maps, traversal, writes and foreign origins do not bypass asset protection', async () => {
        const { server } = app();
        for (const name of ['hub-eclaw.js.map', 'hub-eclaw-secret.js', '..%2Faihankapps-hub.js']) {
            expect((await request(server).get('/AiHankApps/hub/' + name).set('x-test-role', 'admin')).status).toBe(404);
        }
        expect((await request(server).post('/AiHankApps/hub/hub-eclaw.js').set('x-test-role', 'admin')).status).toBe(405);
        expect((await request(server).get('/AiHankApps/hub/hub-eclaw.js').set('x-test-role', 'admin').set('origin', 'https://evil.invalid')).status).toBe(403);
    });
});
