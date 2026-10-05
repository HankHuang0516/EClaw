const fs = require('fs');
const path = require('path');
const seed = require('../../dot-progress-seed.json');

test('every progress asset URL changes when the client bundle changes', () => {
    const crypto = require('crypto');
    const directory = path.join(__dirname, '../../public/AiHankApps/dot-progress');
    const assets = fs.readdirSync(directory).filter(name => /\.(?:css|js)$/.test(name)).sort();
    const hash = crypto.createHash('sha256');
    for (const name of assets) hash.update(name).update('\0').update(fs.readFileSync(path.join(directory, name))).update('\0');
    const version = hash.digest('hex').slice(0, 16);
    const html = fs.readFileSync(path.join(directory, 'index.html'), 'utf8');
    const urls = [...html.matchAll(/(?:href|src)="([^"?]+\.(?:css|js)(?:\?[^" ]*)?)"/g)].map(match => match[1]);
    expect(urls.sort()).toEqual(assets.map(name => `${name}?v=${version}`).sort());
});

test('the public repository seed contains only approved completed summaries', () => {
    expect(seed).toHaveLength(3);
    for (const row of seed) {
        expect(row.status).toBe('completed');
        expect(row.summary).toBeTruthy();
        expect(row.publicSummary).toBeTruthy();
        expect(row.blockers).toBe('');
        expect(row.nextStep).toBe('');
    }
});

test('static progress bundle obtains private content only through the protected API', () => {
    const directory = path.join(__dirname, '../../public/AiHankApps/dot-progress');
    const names = fs.readdirSync(directory);
    expect(names.sort()).toEqual(['decision-i18n.js', 'decisions.js', 'i18n.js', 'index.html', 'progress.css', 'progress.js', 'review.js', 'timeline-i18n.js', 'timeline.js']);
    const script = fs.readFileSync(path.join(directory, 'progress.js'), 'utf8');
    expect(script).toContain("request('/projects'");
    expect(script).not.toContain('dot-progress-seed');
    expect(script).not.toMatch(/(?:deviceSecret|botSecret|channelApiKey|localStorage)/);
});


test('decision and review clients contain no credentials or persistent private browser storage', () => {
    const directory = path.join(__dirname, '../../public/AiHankApps/dot-progress');
    for (const name of ['decisions.js', 'review.js', 'timeline.js']) {
        const script = fs.readFileSync(path.join(directory, name), 'utf8');
        expect(script).not.toMatch(/(?:deviceSecret|botSecret|channelApiKey|localStorage|sessionStorage|innerHTML)/);
    }
});

test('decision translation source supplies every canonical locale and respects zh-TW fallback', () => {
    const vm = require('vm');
    const source = fs.readFileSync(path.join(__dirname, '../../public/AiHankApps/dot-progress/decision-i18n.js'), 'utf8');
    const scope = { window: {} }; vm.runInNewContext(source, scope);
    const dict = scope.window.dotDecisionTranslations;
    const keys = Object.keys(dict.en).sort();
    for (const locale of ['zh', 'zh-CN', 'en', 'ja', 'ko', 'th', 'vi', 'id', 'fr', 'es', 'de', 'ms', 'hi', 'ar']) {
        expect(Object.keys(dict[locale]).sort()).toEqual(keys);
        expect(Object.values(dict[locale]).every(value => typeof value === 'string' && value.length > 0)).toBe(true);
    }
});

test('shared decision translations match the page-scoped canonical source without zh-TW overrides', () => {
    const vm = require('vm');
    const source = fs.readFileSync(path.join(__dirname, '../../public/AiHankApps/dot-progress/decision-i18n.js'), 'utf8');
    const local = { window: {} }; vm.runInNewContext(source, local);
    const noop = () => {};
    const shared = {
        window: { location: { search: '' } },
        document: { querySelectorAll: () => [], documentElement: {}, addEventListener: noop, getElementById: () => null },
        navigator: { language: 'en' }, localStorage: { getItem: noop, setItem: noop },
        setTimeout: noop, console: { log: noop, warn: noop, error: noop }
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../public/shared/i18n.js'), 'utf8') + '\n_result = TRANSLATIONS;', shared);
    for (const [locale, dictionary] of Object.entries(local.window.dotDecisionTranslations)) {
        for (const [key, value] of Object.entries(dictionary)) {
            expect(shared._result[locale][key]).toBe(value);
            expect(shared._result['zh-TW'][key]).toBeUndefined();
        }
    }
});


test('timeline translations share one canonical table across every effective web locale', () => {
    const vm = require('vm');
    const directory = path.join(__dirname, '../../public/AiHankApps/dot-progress');
    const local = {window: {}};
    vm.runInNewContext(fs.readFileSync(path.join(directory, 'timeline-i18n.js'), 'utf8'), local);
    const table = local.window.dotTimelineTranslations;
    const keys = Object.keys(table.en).sort();
    expect(keys).toHaveLength(44);
    const noop = () => {};
    const shared = {window: {location: {search: ''}}, document: {querySelectorAll: () => [], documentElement: {}, addEventListener: noop, getElementById: () => null}, navigator: {language: 'en'}, localStorage: {getItem: noop, setItem: noop}, setTimeout: noop, console: {log: noop, warn: noop, error: noop}};
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../public/shared/i18n.js'), 'utf8') + '\n_result = TRANSLATIONS;', shared);
    for (const locale of ['zh','en','zh-CN','ja','ko','th','vi','id','fr','es','de','ms','hi','ar']) {
        expect(Object.keys(table[locale]).sort()).toEqual(keys);
        for (const key of keys) {
            expect(typeof table[locale][key]).toBe('string');
            expect(table[locale][key].length).toBeGreaterThan(0);
            expect(shared._result[locale][key]).toBe(table[locale][key]);
            expect(shared._result['zh-TW'][key]).toBeUndefined();
        }
    }
});
