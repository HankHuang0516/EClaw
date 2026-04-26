/**
 * i18n.js syntax, structure, and HTML integration regression tests
 *
 * 1. Ensures the i18n translation file parses correctly
 * 2. Validates all language sections are properly structured
 * 3. Checks every HTML page that uses i18n has a valid script path
 * 4. Checks pages calling i18n.t() actually load i18n.js
 * 5. Checks inline handlers referencing i18n have typeof guards
 *
 * Regression: orphaned French arena translations between es/de sections
 * caused a SyntaxError preventing the entire i18n.js from loading,
 * crashing all portal pages.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { globSync } = (() => {
    try { return require('glob'); } catch { return { globSync: null }; }
})();

const PUBLIC_DIR = path.join(__dirname, '../../public');
const I18N_PATH = path.join(PUBLIC_DIR, 'shared/i18n.js');

// Collect all HTML files under public/
function findHtmlFiles(dir) {
    const results = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) results.push(...findHtmlFiles(full));
        else if (entry.name.endsWith('.html')) results.push(full);
    }
    return results;
}

// ── i18n.js file validation ────────────────────────────────────────────────
describe('i18n.js syntax and structure', () => {
    let content;

    beforeAll(() => {
        content = fs.readFileSync(I18N_PATH, 'utf8');
    });

    test('file parses without syntax errors', () => {
        expect(() => {
            new vm.Script(content, { filename: 'i18n.js' });
        }).not.toThrow();
    });

    test('TRANSLATIONS object contains all required languages', () => {
        const sandbox = {
            localStorage: { getItem: () => null, setItem: () => {} },
            navigator: { language: 'en' },
            document: {
                addEventListener: () => {},
                querySelectorAll: () => [],
                documentElement: { lang: '' }
            },
            fetch: () => Promise.resolve(),
            console,
            _result: {}
        };
        vm.createContext(sandbox);
        vm.runInContext(content + '\n_result.TRANSLATIONS = TRANSLATIONS; _result.i18n = i18n;', sandbox);

        const { TRANSLATIONS, i18n } = sandbox._result;

        const requiredLangs = ['en', 'zh', 'ja', 'ko', 'fr', 'es', 'de'];
        for (const lang of requiredLangs) {
            expect(TRANSLATIONS).toHaveProperty(lang);
            expect(typeof TRANSLATIONS[lang]).toBe('object');
        }

        expect(i18n).toBeDefined();
        expect(typeof i18n.t).toBe('function');
        expect(typeof i18n.setLanguage).toBe('function');
    });

    test('i18n.t() returns translations, not raw keys', () => {
        const sandbox = {
            localStorage: { getItem: () => null, setItem: () => {} },
            navigator: { language: 'en' },
            document: {
                addEventListener: () => {},
                querySelectorAll: () => [],
                documentElement: { lang: '' }
            },
            fetch: () => Promise.resolve(),
            console,
            _result: {}
        };
        vm.createContext(sandbox);
        vm.runInContext(content + '\n_result.i18n = i18n;', sandbox);

        const { i18n } = sandbox._result;
        const result = i18n.t('mc_title');
        expect(result).not.toBe('mc_title');
        expect(result).toBe('EClawbot Mission Control');
    });

    test('French (fr) section contains arena translations', () => {
        const sandbox = {
            localStorage: { getItem: () => null, setItem: () => {} },
            navigator: { language: 'en' },
            document: {
                addEventListener: () => {},
                querySelectorAll: () => [],
                documentElement: { lang: '' }
            },
            fetch: () => Promise.resolve(),
            console,
            _result: {}
        };
        vm.createContext(sandbox);
        vm.runInContext(content + '\n_result.TRANSLATIONS = TRANSLATIONS;', sandbox);

        const fr = sandbox._result.TRANSLATIONS.fr;
        expect(fr).toBeDefined();
        expect(fr['arena_title']).toBeDefined();
        expect(fr['arena_subtitle']).toBeDefined();
        expect(fr['arena_generate']).toBeDefined();
    });
});

// ── Orphan-key regression (i18n-check hardening) ────────────────────────────
// Regression: Mac_E's PRs #1956-1962 inserted `analytics_*` blocks BETWEEN
// locale objects (e.g. between `th: {...},` and `vi: {...},`). Syntactically
// legal JS, but TRANSLATIONS[lang][key] resolves to undefined at runtime.
// i18n-check.js now rejects this via findOrphanKeys().
describe('i18n-check findOrphanKeys', () => {
    const { findOrphanKeys } = require('../../scripts/i18n-check');

    test('returns [] when every top-level entry is a locale object', () => {
        expect(findOrphanKeys({ en: {}, 'zh-TW': {}, ja: {} })).toEqual([]);
    });

    test('detects string values at outer scope', () => {
        expect(findOrphanKeys({ en: {}, analytics_title: 'Phân tích trang web' }))
            .toEqual(['analytics_title']);
    });

    test('detects null values at outer scope', () => {
        expect(findOrphanKeys({ en: {}, broken: null })).toEqual(['broken']);
    });

    test('production TRANSLATIONS has no NEW orphans beyond the baseline', () => {
        const { loadOrphanBaseline } = require('../../scripts/i18n-check');
        const content = fs.readFileSync(I18N_PATH, 'utf8');
        const sandbox = {
            localStorage: { getItem: () => null, setItem: () => {} },
            navigator: { language: 'en' },
            document: { addEventListener: () => {}, querySelectorAll: () => [], documentElement: { lang: '' } },
            fetch: () => Promise.resolve(),
            console,
            _result: {}
        };
        vm.createContext(sandbox);
        vm.runInContext(content + '\n_result.TRANSLATIONS = TRANSLATIONS;', sandbox);
        const orphans = findOrphanKeys(sandbox._result.TRANSLATIONS);
        const baseline = new Set(loadOrphanBaseline());
        const newOrphans = orphans.filter(k => !baseline.has(k));
        expect(newOrphans).toEqual([]);
    });
});

// ── Locale-tag enforcement (script charset guard) ───────────────────────────
// Regression: PR #2123 pasted Korean translations into ja/th/vi/id/fr/es/de/ms/hi
// blocks of guide_cc_channel_warn_experimental, leaking 한글 into 9 non-ko
// locales until PR #2136. This guard catches script-foreign-to-locale at CI time.
//
// Existing leaks (1745 keys as of 2026-04-26 — mass mistranslation across the
// fr/es/de/ja/ko/hi/ar guide_* blocks) are tracked in i18n-locale-leak-baseline.json.
// Cleanup is a separate companion card; this guard ensures no NEW leak slips in.
describe('i18n locale-tag enforcement (per-locale charset)', () => {
    const SCRIPTS = {
        hangul: /[가-힯ᄀ-ᇿ㄰-㆏]/,
        thai: /[฀-๿]/,
        devanagari: /[ऀ-ॿ]/,
        arabic: /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/,
        hiragana: /[぀-ゟ]/,
        katakana: /[゠-ヿㇰ-ㇿ]/,
        cjk: /[㐀-䶿一-鿿豈-﫿]/,
    };

    // For each locale: scripts that MUST NOT appear in any value.
    // ja allows cjk (kanji); ko allows cjk (hanja); zh-* allows cjk; everyone
    // else is Latin-script and must reject all CJ/K/Thai/Arabic/Devanagari.
    const FORBID = {
        en:      ['hangul','thai','devanagari','arabic','hiragana','katakana','cjk'],
        'zh-TW': ['hangul','thai','devanagari','arabic','hiragana','katakana'],
        'zh-CN': ['hangul','thai','devanagari','arabic','hiragana','katakana'],
        zh:      ['hangul','thai','devanagari','arabic','hiragana','katakana'],
        ja:      ['hangul','thai','devanagari','arabic'],
        ko:      ['thai','devanagari','arabic','hiragana','katakana'],
        fr:      ['hangul','thai','devanagari','arabic','hiragana','katakana','cjk'],
        es:      ['hangul','thai','devanagari','arabic','hiragana','katakana','cjk'],
        de:      ['hangul','thai','devanagari','arabic','hiragana','katakana','cjk'],
        th:      ['hangul','devanagari','arabic','hiragana','katakana','cjk'],
        vi:      ['hangul','thai','devanagari','arabic','hiragana','katakana','cjk'],
        id:      ['hangul','thai','devanagari','arabic','hiragana','katakana','cjk'],
        ms:      ['hangul','thai','devanagari','arabic','hiragana','katakana','cjk'],
        hi:      ['hangul','thai','arabic','hiragana','katakana','cjk'],
        ar:      ['hangul','thai','devanagari','hiragana','katakana','cjk'],
    };

    let TRANSLATIONS;
    let baseline;
    beforeAll(() => {
        const content = fs.readFileSync(I18N_PATH, 'utf8');
        const sandbox = {
            localStorage: { getItem: () => null, setItem: () => {} },
            navigator: { language: 'en' },
            document: { addEventListener: () => {}, querySelectorAll: () => [], documentElement: { lang: '' } },
            fetch: () => Promise.resolve(),
            console,
            _result: {}
        };
        vm.createContext(sandbox);
        vm.runInContext(content + '\n_result.TRANSLATIONS = TRANSLATIONS;', sandbox);
        TRANSLATIONS = sandbox._result.TRANSLATIONS;
        const baselinePath = path.join(__dirname, 'i18n-locale-leak-baseline.json');
        baseline = new Set(JSON.parse(fs.readFileSync(baselinePath, 'utf8')).keys);
    });

    test('no NEW value contains script foreign to its locale', () => {
        const newViolations = [];
        const stillLeaking = new Set();
        for (const [locale, forbidList] of Object.entries(FORBID)) {
            const block = TRANSLATIONS[locale];
            if (!block) continue;
            for (const [key, val] of Object.entries(block)) {
                if (typeof val !== 'string') continue;
                const id = `${locale}.${key}`;
                for (const script of forbidList) {
                    if (SCRIPTS[script].test(val)) {
                        if (baseline.has(id)) {
                            stillLeaking.add(id);
                        } else {
                            newViolations.push(`${id}: contains ${script} (forbidden in ${locale}) — "${val.slice(0, 80).replace(/\n/g, ' ')}"`);
                        }
                        break;
                    }
                }
            }
        }
        if (newViolations.length) {
            throw new Error(
                `NEW locale-tag leak detected — translation contains script foreign to its locale block.\n` +
                `Same regression class as PR #2123 cc_warn ko-leak (fixed by #2136).\n` +
                `If a key is intentionally non-native (brand name, quoted foreign phrase), add it to ` +
                `backend/tests/jest/i18n-locale-leak-baseline.json. Otherwise translate to the correct script.\n\n  ` +
                newViolations.join('\n  ')
            );
        }
    });
});

// ── HTML page i18n integration ─────────────────────────────────────────────
describe('HTML pages i18n integration', () => {
    const htmlFiles = findHtmlFiles(PUBLIC_DIR);

    test('all HTML files that load i18n.js use a valid path', () => {
        const errors = [];

        for (const file of htmlFiles) {
            const html = fs.readFileSync(file, 'utf8');
            // Find all <script src="...i18n.js..."> tags
            const scriptMatches = html.matchAll(/<script\s+src=["']([^"']*i18n\.js[^"']*)["']/g);

            for (const match of scriptMatches) {
                const src = match[1];
                const rel = path.relative(PUBLIC_DIR, file);

                // Resolve the script path relative to the HTML file's directory
                const htmlDir = path.dirname(file);
                let resolvedPath;

                if (src.startsWith('/')) {
                    // Absolute path from web root
                    resolvedPath = path.join(PUBLIC_DIR, src.split('?')[0]);
                } else {
                    // Relative path from HTML file
                    resolvedPath = path.join(htmlDir, src.split('?')[0]);
                }

                if (!fs.existsSync(resolvedPath)) {
                    errors.push(`${rel}: script src="${src}" → file not found (resolved: ${path.relative(PUBLIC_DIR, resolvedPath)})`);
                }
            }
        }

        if (errors.length > 0) {
            throw new Error('Invalid i18n.js paths:\n  ' + errors.join('\n  '));
        }
    });

    test('pages calling i18n.t() or i18n.setLanguage() actually load i18n.js', () => {
        const errors = [];

        for (const file of htmlFiles) {
            const html = fs.readFileSync(file, 'utf8');
            const rel = path.relative(PUBLIC_DIR, file);

            // Check if page calls i18n.t() or i18n.setLanguage() in JS
            const usesI18n = /\bi18n\.(t|setLanguage|apply|applyPage)\s*\(/.test(html);
            if (!usesI18n) continue;

            // Check if page loads i18n.js
            const loadsI18n = /<script\s+src=["'][^"']*i18n\.js[^"']*["']/.test(html);
            if (!loadsI18n) {
                errors.push(`${rel}: calls i18n methods but does not load i18n.js`);
            }
        }

        if (errors.length > 0) {
            throw new Error('Pages missing i18n.js script:\n  ' + errors.join('\n  '));
        }
    });

    test('inline HTML handlers referencing i18n have typeof guards', () => {
        const errors = [];
        // Match inline handlers like onchange="i18n.xxx()" onclick="i18n.xxx()"
        const inlineHandlerRe = /\bon\w+\s*=\s*["']([^"']*\bi18n\b[^"']*)["']/g;

        for (const file of htmlFiles) {
            const html = fs.readFileSync(file, 'utf8');
            const rel = path.relative(PUBLIC_DIR, file);
            const lines = html.split('\n');

            for (let i = 0; i < lines.length; i++) {
                let match;
                inlineHandlerRe.lastIndex = 0;
                while ((match = inlineHandlerRe.exec(lines[i])) !== null) {
                    const handler = match[1];
                    // Must have typeof guard or optional chaining
                    if (!handler.includes('typeof i18n') && !handler.includes('i18n?.')) {
                        errors.push(`${rel}:${i + 1}: inline handler "${handler.substring(0, 60)}" lacks typeof i18n guard`);
                    }
                }
            }
        }

        if (errors.length > 0) {
            throw new Error('Unguarded inline i18n handlers:\n  ' + errors.join('\n  '));
        }
    });
});
