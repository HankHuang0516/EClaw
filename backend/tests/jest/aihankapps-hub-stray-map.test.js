/* Synthetic aggregates only; no production rows or credentials. */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const hub = require('../../aihankapps-hub');
const { validateEnvelope } = require('../../aihankapps-hub-store');
const { AGGREGATES } = require('../../../tools/aihankapps-hub/backends');
const collect = require('../../../tools/aihankapps-hub/collect');
const source = fs.readFileSync(path.resolve(__dirname, '../../aihankapps-hub/hub-stray-map.js'), 'utf8');
const NOW = Date.UTC(2026, 10, 26, 9);
function load(lang = 'zh-Hant') {
    const window = {}, document = { documentElement: { lang } };
    vm.runInNewContext(source, { window, document, Date });
    return window.HubStrayMap;
}
function snapshot(overrides = {}) {
    return { v: 1, source: 'stray-map', asOf: NOW, native: { total: 6, notDeleted: 4, deleted: 2, mapVisible: 3, new7d: 0, new30d: 1 },
        types: [['cat', 3], ['dog', 1]], statuses: [['recently_seen', 3], ['adopted', 1]], days: [['2026-11-24', 0], ['2026-11-25', 1]], external: null, ...overrides };
}
function render(api, facts = {}, imports = { ok: true }) {
    const el = { innerHTML: '', querySelector: () => ({ focus: jest.fn() }) };
    const result = api.mount(el, api.fromFacts(facts, imports, NOW));
    return { el, result };
}
describe('Stray Map private aggregate view', () => {
    test('preserves genuine zero while external stages remain unconnected, and explains provenance gaps', () => {
        const { el } = render(load(), { smMapStats: snapshot() });
        expect(el.innerHTML).toContain('<span>近 7 天建立</span><b>0</b>');
        expect(el.innerHTML.match(/<td class="num">未接通<\/td>/g)).toHaveLength(5);
        expect(el.innerHTML).toContain('沒有原生／外部來源標記');
        expect(el.innerHTML).toContain('未辨識 QA 紀錄');
        expect(el.innerHTML).toContain('Asia/Taipei');
        expect(el.innerHTML).not.toContain('已接通');
    });
    test('no snapshot means unknown counts, not a zero-valued success', () => {
        const { el } = render(load());
        expect(el.innerHTML).toContain('尚未匯入通報統計');
        expect(el.innerHTML).toContain('<span>未刪除通報</span><b>待確認</b>');
        expect(el.innerHTML).not.toContain('<b>0</b>');
    });
    test('source interruption retains a clearly dated last reading; stale and malformed readings are distinct', () => {
        const api = load();
        const { el } = render(api, { smMapStats: snapshot() }, { ok: false });
        expect(el.innerHTML).toContain('統計來源讀取中斷');
        expect(el.innerHTML).toContain('保留上次讀數');
        expect(el.innerHTML).toContain('<span>未刪除通報</span><b>4</b>');
        expect(api.fromFacts({ smMapStats: snapshot({ asOf: NOW - 37 * 3600000 }) }, {}, NOW).state).toBe('stale');
        for (const broken of [{ v: 2 }, { source: 'unverified' }, { asOf: NOW + 7200000 }, { asOf: 'yesterday' }]) {
            expect(api.fromFacts({ smMapStats: snapshot(broken) }, {}, NOW).snapshot).toBeNull();
        }
    });
    test('empty successful dataset is different from missing data', () => {
        const { el } = render(load(), { smMapStats: snapshot({ native: { notDeleted: 0 }, types: [], statuses: [], days: [] }) });
        expect(el.innerHTML).toContain('<span>未刪除通報</span><b>0</b>');
        expect(el.innerHTML).toContain('此範圍沒有紀錄');
        expect(el.innerHTML).not.toContain('尚未匯入通報統計');
    });
    test('only known aggregate fields and category labels render; hostile content and precise location cannot appear', () => {
        const attack = '<img src=x onerror=alert(1)>', sensitive = 'SYNTHETIC_PRIVATE_LOCATION';
        const { el } = render(load(), { smMapStats: snapshot({ native: { notDeleted: attack }, types: [[attack, 2]], statuses: [['unknown', 1]],
            days: [[attack, 10]], address: sensitive, latitude: 25.012345, sources: [{ name: sensitive }], external: { published: 900 } }) });
        expect(el.innerHTML).not.toContain(attack);
        expect(el.innerHTML).not.toContain(sensitive);
        expect(el.innerHTML).not.toContain('25.012345');
        expect(el.innerHTML).not.toContain('900');
        expect(el.innerHTML).toContain('<span>未刪除通報</span><b>待確認</b>');
    });
    test('trend selector changes the actual displayed day buckets and releases its event handler', () => {
        const api = load(), days = Array.from({ length: 20 }, (_, i) => ['2026-11-' + String(i + 1).padStart(2, '0'), i]);
        const { el, result } = render(api, { smMapStats: snapshot({ days }) });
        expect(el.innerHTML).not.toContain('2026-11-01');
        el.onchange({ target: { matches: () => true, value: '30' } });
        expect(el.innerHTML).toContain('2026-11-01');
        expect(el.innerHTML).toContain('不是歷史當天的地圖存量');
        result.destroy();
        expect(el.onchange).toBeNull();
    });
    test.each(['zh-TW', 'en', 'zh-CN', 'ja', 'ko'])('%s has complete translations and renders translated titles', locale => {
        const api = load(locale), keys = Object.keys(api.messages.en);
        expect(Object.keys(api.messages[locale]).sort()).toEqual(keys.sort());
        const { el } = render(api, { smMapStats: snapshot() });
        expect(el.innerHTML).toContain(api.messages[locale].title);
        expect(el.innerHTML).toContain(api.messages[locale].externalNote);
    });
    test('assets remain on the existing private Hub allowlist; browser code has no network or write API', () => {
        expect(hub.PAGE_FILES['hub-stray-map.js']).toBe('text/javascript; charset=utf-8');
        expect(hub.PAGE_FILES['hub-stray-map.css']).toBe('text/css; charset=utf-8');
        expect(source).not.toMatch(/fetch\(|XMLHttpRequest|localStorage|https:\/\//);
        const html = fs.readFileSync(path.resolve(__dirname, '../../aihankapps-hub/index.html'), 'utf8');
        expect(html).toContain('href="hub-stray-map.css"');
        expect(html).toContain('src="hub-stray-map.js"');
    });
    test('catalog baked-H flags survive normalization and the Hub reuses the portfolio placement and original layers', () => {
        const apps = hub.appsFromCatalog({ apps: [
            { communityId: 'stray-map', name: 'Synthetic A', icon: 'icons/a.png' },
            { communityId: 'timehut', name: 'Synthetic B', icon: 'icons/b.png', iconHasWatermark: true },
            { communityId: 'anthill', name: 'Synthetic C', icon: 'icons/anthill.png' }
        ] });
        expect(apps.map(a => a.iconHasWatermark)).toEqual([false, true, true]);
        const page = fs.readFileSync(path.resolve(__dirname, '../../aihankapps-hub/hub-app.js'), 'utf8');
        const portfolio = fs.readFileSync(path.resolve(__dirname, '../../public/AiHankApps/index.html'), 'utf8');
        const tight = name => new RegExp('const ' + name + ' = (\\{[\\s\\S]*?\\});');
        const a = vm.runInNewContext('(' + page.match(tight('H_TIGHT'))[1] + ')');
        const b = vm.runInNewContext('(' + portfolio.match(tight('H_WATERMARK_TIGHT'))[1] + ')');
        expect(JSON.parse(JSON.stringify(a))).toEqual(JSON.parse(JSON.stringify(b)));
        expect(page).toContain("!a.iconHasWatermark && a.key !== 'eclawbot'");
        const css = fs.readFileSync(path.resolve(__dirname, '../../aihankapps-hub/hub.css'), 'utf8');
        expect(css).toContain("url('/AiHankApps/brand/h-watermark-general-italic.png')");
        expect(css).toContain("url('/AiHankApps/brand/h-watermark-game-italic.png')");
        expect(css).not.toMatch(/\.app-ico-h-[^}]*\b(?:opacity|filter)\s*:/);
    });
});

describe('Stray Map collector privacy and consistency contract', () => {
    function fact() {
        const value = snapshot();
        delete value.source;
        value.days = Array.from({ length: 30 }, (_, i) => [new Date(Date.UTC(2026, 10, 26) - (30 - i) * 86400000).toISOString().slice(0, 10), i === 0 ? 1 : 0]);
        return value;
    }
    function envelope(value = fact()) {
        return { schemaVersion: 1, source: 'stray-map', collectedAt: NOW, series: [], facts: [{ app: 'stray-map', key: 'smMapStats', value }], notes: [] };
    }
    test('counts reconcile, fixed categories and 30 complete Taipei days are accepted; external counts remain null', () => {
        const clean = validateEnvelope(envelope(), ['stray-map']);
        expect(clean.facts[0].value.external).toBeNull();
        expect(clean.facts[0].value.native.notDeleted).toBe(4);
        expect(clean.facts[0].value.days.at(-1)[0]).toBe('2026-11-25');
    });
    test.each([
        v => { v.address = 'SYNTHETIC_PRIVATE_LOCATION'; },
        v => { v.native.deviceId = 'SYNTHETIC_DEVICE'; },
        v => { v.external = { published: 0 }; },
        v => { v.native.notDeleted = 99; },
        v => { v.native.mapVisible = 99; },
        v => { v.types[0][0] = 'SYNTHETIC_PRIVATE_PERSON'; },
        v => { v.statuses.push(['adopted', 0]); },
        v => { v.days[0][0] = '2026-11-26'; },
        v => { v.days.pop(); },
        v => { v.days[0][1] = -1; },
        v => { v.native.new7d = null; }
    ])('rejects additional private fields, forged external zeros, inconsistent totals and invalid buckets (%#)', mutate => {
        const v = fact(); mutate(v);
        expect(() => validateEnvelope(envelope(v), ['stray-map'])).toThrow('IMPORT_STRAY_MAP');
    });
    test('the reserved snapshot can only be imported by its fixed source and app, without other data channels', () => {
        for (const change of [e => { e.source = 'other'; }, e => { e.facts[0].app = 'other'; },
            e => { e.infra = []; }, e => { e.facts.push({ app: 'stray-map', key: 'extra', value: { text: 'not allowed' } }); }]) {
            const e = envelope(); change(e);
            expect(() => validateEnvelope(e, ['stray-map', 'other'])).toThrow('IMPORT_STRAY_MAP');
        }
    });
    test('the actual collector script only runs one bounded SELECT in a read-only transaction, and scrubs failures', async () => {
        const backend = AGGREGATES.find(b => b.id === 'stray-map');
        async function run(fail) {
            const sql = [], printed = [], value = fact();
            class Client {
                async connect() {}
                async query(text, args) {
                    sql.push({ text, args });
                    if (/WITH kept/.test(text)) {
                        if (fail) throw new Error('SYNTHETIC_SECRET_VALUE');
                        return { rows: [{ snapshot: value }] };
                    }
                    return { rows: [] };
                }
                async end() {}
            }
            const process = { env: { DATABASE_URL: 'SYNTHETIC_SECRET_VALUE' } };
            await vm.runInNewContext(backend.script('2026-11-26'), { require: name => { expect(name).toBe('pg'); return { Client }; }, process,
                console: { log: text => printed.push(text) } });
            return { sql, printed, process };
        }
        const good = await run(false);
        expect(good.sql.map(x => x.text.trim()).filter(s => !s.startsWith('WITH'))).toEqual(['BEGIN READ ONLY', 'SET LOCAL statement_timeout = 20000', 'ROLLBACK']);
        const question = good.sql.find(x => x.args);
        expect(question.args).toEqual(['2026-11-26']);
        expect(question.text).not.toMatch(/\b(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|city|district|location|description|reporter_name|created_by_device_id)\b/i);
        expect(good.printed).toHaveLength(1);
        const raw = JSON.parse(good.printed[0].slice('GIFT_RESULT '.length));
        expect(collect.toEnvelope(backend, { value: raw }, { now: NOW, appIds: new Set(['stray-map']) }).error).toBeUndefined();
        const failed = await run(true);
        expect(failed.printed).toEqual(['GIFT_RESULT {"error":"stray_map_read_failed"}']);
        expect(failed.process.exitCode).toBe(1);
        expect(failed.printed.join('')).not.toContain('SYNTHETIC_SECRET_VALUE');
    });
});
