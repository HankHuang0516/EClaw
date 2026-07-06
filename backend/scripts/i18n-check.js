#!/usr/bin/env node
/**
 * i18n strict checker. Hard-fails CI when any key referenced via
 * `data-i18n` (or its -title / -placeholder variants) in HTML, or via
 * `i18n.t('...')` in JS, is missing from the English locale in
 * `backend/public/shared/i18n.js`. Also reports per-locale coverage so
 * translators can see where gaps are. The settings-help registry is also
 * checked as a soft fanout warning so the i18n patrol can file follow-up work
 * without turning locale backlog into a hard CI block.
 *
 * Run locally: `node backend/scripts/i18n-check.js`
 * Exit codes:
 *   0 = all referenced keys resolve in EN
 *   1 = at least one referenced key is missing from EN (fatal)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const BACKEND_DIR = path.join(REPO_ROOT, 'backend');
const PUBLIC_DIR = path.join(BACKEND_DIR, 'public');
const I18N_FILE = path.join(PUBLIC_DIR, 'shared', 'i18n.js');
const SETTINGS_HELP_REGISTRY_FILE = path.join(BACKEND_DIR, 'settings-help-keys.json');
// Locales that are Traditional-Chinese dictionaries and must never contain
// Simplified-distinguishing characters (card_2f3a43d6: 161 Simplified keys —
// incl. every dialog_* destructive-confirm key — leaked into `zh`).
const ZH_SIMPLIFIED_CHARS_FILE = path.join(__dirname, 'i18n-zh-simplified-chars.json');
const SIMPLIFIED_GATED_LOCALES = ['zh', 'zh-TW'];
const COVERAGE_WARN_THRESHOLD = 0.8;
const SETTINGS_HELP_CANONICAL_LOCALES = new Set(['en', 'zh']);
const SETTINGS_HELP_STUB_LOCALES = new Set(['zh-TW']);
const COVERAGE_STUB_LOCALES = new Set(['zh-TW']);

function walk(dir, exts) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        if (entry.name === 'node_modules') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            out.push(...walk(full, exts));
        } else if (exts.some(ext => entry.name.endsWith(ext))) {
            out.push(full);
        }
    }
    return out;
}

function loadTranslations() {
    const src = fs.readFileSync(I18N_FILE, 'utf8');
    const noop = () => {};
    const sandbox = {
        _result: null,
        localStorage: { getItem: noop, setItem: noop },
        navigator: { language: 'en' },
        document: { querySelectorAll: () => [], documentElement: { lang: 'en' }, addEventListener: noop, getElementById: () => null },
        window: { location: { search: '' } },
        setTimeout: noop,
        console: { log: noop, warn: noop, error: noop }
    };
    vm.createContext(sandbox);
    vm.runInContext(src + '\n_result = TRANSLATIONS;', sandbox, { timeout: 5000 });
    if (!sandbox._result || typeof sandbox._result !== 'object') {
        throw new Error('Failed to extract TRANSLATIONS from i18n.js');
    }
    return sandbox._result;
}

// --- HTML reference scanning ------------------------------------------------
// Matches: data-i18n="key", data-i18n-title="key", data-i18n-placeholder="key"
const ATTR_RE = /\bdata-i18n(?:-title|-placeholder)?\s*=\s*(?:"([^"]+)"|'([^']+)')/g;
// Matches inline <script> blocks (skipping src=... external refs)
const INLINE_SCRIPT_RE = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;

// `[html]foo` is an opt-in "HTML content IS the fallback" convention used in
// info.html etc. Such keys are intentionally absent from the EN dictionary —
// the untranslated DOM text is treated as the canonical English. We record
// them so locale coverage still reflects reality, but they are excluded from
// the hard-fail "missing from EN" check.
function isHtmlFallbackKey(key) {
    return typeof key === 'string' && key.startsWith('[html]');
}

function extractKeysFromHtml(filePath, text) {
    const hits = [];
    let m;
    ATTR_RE.lastIndex = 0;
    while ((m = ATTR_RE.exec(text)) !== null) {
        const key = m[1] || m[2];
        if (key && !key.includes('${')) hits.push({ key, file: filePath });
    }
    INLINE_SCRIPT_RE.lastIndex = 0;
    while ((m = INLINE_SCRIPT_RE.exec(text)) !== null) {
        for (const h of extractKeysFromJs(filePath, m[1])) hits.push(h);
    }
    return hits;
}

// --- JS reference scanning --------------------------------------------------
// Matches: i18n.t('key') / i18n.t("key", fallback) / window.i18n.t('key')
// Requires `,` or `)` after the closing quote — this rejects concatenation
// patterns like `i18n.t('prefix_' + c.status)` where the captured string is a
// runtime prefix, not a real dictionary key.
const T_CALL_RE = /\bi18n\.t\s*\(\s*(?:"([a-zA-Z0-9_.-]+)"|'([a-zA-Z0-9_.-]+)')\s*[,)]/g;

// Matches local convenience wrappers used in inline page scripts, e.g.
// `tt('mp_chat_cta', 'Start chat')` and `ttt("settings_title", fallback)`.
// These wrappers call i18n.t() internally, so missing dictionary keys render as
// raw key text when i18n.t() returns the input key instead of null.
const LOCAL_T_CALL_RE = /\bttt?\s*\(\s*(?:"([a-zA-Z0-9_.-]+)"|'([a-zA-Z0-9_.-]+)')\s*[,)]/g;

function extractKeysWithRegex(filePath, text, re) {
    const hits = [];
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(text)) !== null) {
        const key = m[1] || m[2];
        if (key) hits.push({ key, file: filePath });
    }
    return hits;
}

function extractKeysFromJs(filePath, text) {
    return [
        ...extractKeysWithRegex(filePath, text, T_CALL_RE),
        ...extractKeysWithRegex(filePath, text, LOCAL_T_CALL_RE),
    ];
}

function findOrphanKeys(translations) {
    return Object.keys(translations).filter(
        k => typeof translations[k] !== 'object' || translations[k] === null
    );
}

const ORPHAN_BASELINE_FILE = path.join(__dirname, 'i18n-orphan-baseline.json');

function loadOrphanBaseline() {
    try {
        return JSON.parse(fs.readFileSync(ORPHAN_BASELINE_FILE, 'utf8'));
    } catch {
        return [];
    }
}

// --- Simplified-char gate for Traditional-Chinese locales --------------------
// `zh` is the canonical Traditional dictionary (zh-TW falls back to it, see
// i18n.t). Simplified values leaking in render 简体 on a 繁體 UI — worst on
// destructive dialogs (dialog_confirm was 确认). The distinguishing-char set
// (chars valid ONLY in Simplified text, per OpenCC tables) is snapshot in
// i18n-zh-simplified-chars.json; any gated-locale value containing one fails.
function loadZhSimplifiedCharSet(filePath = ZH_SIMPLIFIED_CHARS_FILE) {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (typeof raw.chars !== 'string' || raw.chars.length === 0) {
        throw new Error(`Invalid simplified-char data file: ${filePath}`);
    }
    // supplementalChars: de-facto Simplified chars the pure OpenCC derivation
    // misses because ST self-maps them (e.g. 确→確 确). See data file docs.
    return new Set([...raw.chars, ...(raw.supplementalChars || '')]);
}

function collectSimplifiedCharOffenders(translations, simpChars, locales = SIMPLIFIED_GATED_LOCALES) {
    const offenders = [];
    for (const locale of locales) {
        const dict = translations[locale];
        if (!dict || typeof dict !== 'object') continue;
        for (const [key, value] of Object.entries(dict)) {
            if (typeof value !== 'string') continue;
            const hits = new Set();
            for (const ch of value) {
                if (simpChars.has(ch)) hits.add(ch);
            }
            if (hits.size > 0) {
                offenders.push({ locale, key, chars: [...hits].join(''), preview: value.slice(0, 60).replace(/\n/g, ' ') });
            }
        }
    }
    return offenders;
}

function loadSettingsHelpRegistry(filePath = SETTINGS_HELP_REGISTRY_FILE) {
    try {
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return Array.isArray(raw.keys)
            ? raw.keys
                .map(entry => ({
                    labelKey: entry.label_key,
                    helpKey: entry.help_key,
                }))
                .filter(entry => entry.labelKey && entry.helpKey)
            : [];
    } catch {
        return [];
    }
}

function realLocaleNames(translations) {
    return Object.keys(translations || {})
        .filter(locale => translations[locale] && typeof translations[locale] === 'object')
        .sort();
}

function collectSettingsHelpFanoutGaps(translations, registryEntries, {
    canonicalLocales = SETTINGS_HELP_CANONICAL_LOCALES,
    stubLocales = SETTINGS_HELP_STUB_LOCALES,
    locales = null,
} = {}) {
    const canonical = canonicalLocales instanceof Set ? canonicalLocales : new Set(canonicalLocales);
    const stubs = stubLocales instanceof Set ? stubLocales : new Set(stubLocales);
    const requiredKeys = [...new Set((registryEntries || []).flatMap(entry => [entry.labelKey, entry.helpKey]).filter(Boolean))];
    if (requiredKeys.length === 0) return [];

    return (locales || realLocaleNames(translations))
        .filter(locale => !canonical.has(locale) && !stubs.has(locale))
        .map(locale => {
            const dict = translations[locale];
            if (!dict || typeof dict !== 'object') return null;
            const missingKeys = requiredKeys.filter(key => !Object.prototype.hasOwnProperty.call(dict, key));
            return missingKeys.length ? { locale, missingKeys } : null;
        })
        .filter(Boolean);
}

function formatSettingsHelpFanoutWarnings(gaps, { maxPreviewKeys = 8 } = {}) {
    if (!gaps || gaps.length === 0) return [];
    const totalMissing = gaps.reduce((sum, gap) => sum + gap.missingKeys.length, 0);
    const lines = [
        '',
        `[i18n-check] ⚠  Settings-help fanout gaps: ${totalMissing} missing key(s) across ${gaps.length} locale(s).`,
        '[i18n-check]    Soft warning only: en + zh stay hard-gated; zh-TW is a thin fallback stub and is skipped.',
    ];
    for (const gap of gaps) {
        const preview = gap.missingKeys.slice(0, maxPreviewKeys).join(', ');
        const suffix = gap.missingKeys.length > maxPreviewKeys
            ? `, ... +${gap.missingKeys.length - maxPreviewKeys} more`
            : '';
        lines.push(`[i18n-check]    ${gap.locale}: ${gap.missingKeys.length} missing (${preview}${suffix})`);
    }
    return lines;
}

function updateOrphanBaseline() {
    const TRANSLATIONS = loadTranslations();
    const orphans = findOrphanKeys(TRANSLATIONS).sort();
    fs.writeFileSync(ORPHAN_BASELINE_FILE, JSON.stringify(orphans, null, 2) + '\n');
    console.log(`Wrote ${orphans.length} orphan keys to ${path.relative(REPO_ROOT, ORPHAN_BASELINE_FILE)}`);
}

function main() {
    if (process.argv.includes('--update-baseline')) {
        updateOrphanBaseline();
        return;
    }
    // 1. Load + parse TRANSLATIONS
    let TRANSLATIONS;
    try {
        TRANSLATIONS = loadTranslations();
    } catch (err) {
        console.error('FATAL: could not load TRANSLATIONS from i18n.js:', err.message);
        process.exit(1);
    }
    const enKeys = new Set(Object.keys(TRANSLATIONS.en || {}));
    if (enKeys.size === 0) {
        console.error('FATAL: TRANSLATIONS.en is empty or missing');
        process.exit(1);
    }

    // 1b. Reject NEW orphan keys at outer TRANSLATIONS scope. Any non-object
    // value here is a locale key that was accidentally inserted BETWEEN locale
    // blocks (a sibling of `en`/`zh-TW`/... instead of a member). Syntactically
    // legal JS but runtime-useless: TRANSLATIONS[lang][key] will miss it.
    //
    // There's an existing backlog of 558 orphan keys (mostly harmless EN
    // duplicates) snapshot in `i18n-orphan-baseline.json`. CI fails only when
    // NEW keys appear outside that baseline — that's how we stop regressions
    // without blocking all PRs until the backlog is drained.
    const orphans = findOrphanKeys(TRANSLATIONS);
    const baseline = new Set(loadOrphanBaseline());
    const newOrphans = orphans.filter(k => !baseline.has(k));
    if (newOrphans.length > 0) {
        console.error(`\n❌ FAIL: ${newOrphans.length} NEW orphan key(s) at outer TRANSLATIONS scope (not in baseline):\n`);
        for (const k of newOrphans) {
            const preview = String(TRANSLATIONS[k]).slice(0, 60).replace(/\n/g, ' ');
            console.error(`  • ${k}: ${JSON.stringify(preview)}`);
        }
        console.error('\nThese keys are siblings of locale blocks inside TRANSLATIONS — they will never resolve via i18n.t().');
        console.error('Fix: move each key INSIDE the intended locale object (e.g. `"de": { ... <here> }`), before its closing "},".');
        process.exit(1);
    }
    const fixed = Array.from(baseline).filter(k => !orphans.includes(k));
    if (fixed.length > 0) {
        console.log(`[i18n-check] ℹ  ${fixed.length} baseline orphan(s) were cleaned up — regenerate baseline via: node backend/scripts/i18n-check.js --update-baseline`);
    }

    // 1c. Reject Simplified-Chinese characters in Traditional-Chinese locales.
    // `zh` is the canonical Traditional dict (zh-TW/zh-CN fall back to it);
    // Simplified values here render 简体 on a 繁體 UI — the dialog_confirm=确认
    // class of bug (card_2f3a43d6, 161 keys). Hard gate so it cannot recur.
    let simpCharSet;
    try {
        simpCharSet = loadZhSimplifiedCharSet();
    } catch (err) {
        console.error('FATAL: could not load simplified-char data file:', err.message);
        process.exit(1);
    }
    const simpOffenders = collectSimplifiedCharOffenders(TRANSLATIONS, simpCharSet);
    if (simpOffenders.length > 0) {
        console.error(`\n❌ FAIL: ${simpOffenders.length} key(s) in Traditional-Chinese locale(s) contain Simplified-Chinese characters:\n`);
        for (const o of simpOffenders) {
            console.error(`  • ${o.locale}.${o.key} [${o.chars}]: ${JSON.stringify(o.preview)}`);
        }
        console.error('\nThe `zh` / `zh-TW` dictionaries are Traditional Chinese. Rewrite these values in Traditional');
        console.error('(copy the zh-TW value if one exists, or convert via OpenCC s2twp). Distinguishing-char set:');
        console.error(`backend/scripts/${path.basename(ZH_SIMPLIFIED_CHARS_FILE)}.`);
        process.exit(1);
    }
    console.log(`[i18n-check] Simplified-char gate: 0 offenders across ${SIMPLIFIED_GATED_LOCALES.join(', ')}`);

    // 2. Scan references
    const htmlFiles = walk(PUBLIC_DIR, ['.html']);
    const jsFiles = walk(PUBLIC_DIR, ['.js']).filter(f => f !== I18N_FILE);

    const refs = [];
    for (const f of htmlFiles) refs.push(...extractKeysFromHtml(f, fs.readFileSync(f, 'utf8')));
    for (const f of jsFiles)   refs.push(...extractKeysFromJs(f, fs.readFileSync(f, 'utf8')));

    // 3. Fail on missing EN keys (skip [html]-prefixed intentional-fallback keys)
    const missing = new Map();  // key -> [files]
    let htmlFallbackSkips = 0;
    for (const ref of refs) {
        if (isHtmlFallbackKey(ref.key)) { htmlFallbackSkips++; continue; }
        if (!enKeys.has(ref.key)) {
            if (!missing.has(ref.key)) missing.set(ref.key, new Set());
            missing.get(ref.key).add(path.relative(REPO_ROOT, ref.file));
        }
    }

    const totalRefs = refs.length;
    const uniqueRefs = new Set(refs.map(r => r.key));
    console.log(`[i18n-check] Scanned ${htmlFiles.length} HTML files + ${jsFiles.length} JS files`);
    console.log(`[i18n-check] Found ${totalRefs} i18n references across ${uniqueRefs.size} unique keys`);
    console.log(`[i18n-check] EN dictionary has ${enKeys.size} keys`);
    if (htmlFallbackSkips > 0) {
        console.log(`[i18n-check] Skipped ${htmlFallbackSkips} [html]-prefixed refs (HTML content is the canonical source)`);
    }

    if (missing.size > 0) {
        console.error(`\n❌ FAIL: ${missing.size} key(s) referenced but missing from EN dictionary:\n`);
        for (const [key, files] of missing) {
            console.error(`  • ${key}`);
            for (const f of files) console.error(`      ${f}`);
        }
        console.error('\nFix: add these keys to the `"en": { ... }` block in backend/public/shared/i18n.js.');
        process.exit(1);
    }

    // 4. Per-locale coverage (warn only — graceful EN fallback in i18n.t means
    // missing non-EN keys render as English, not broken).
    // Only count TRANSLATIONS entries whose value is an object (a real locale
    // dict). i18n.js has historical key leakage to TRANSLATIONS root — those
    // are not locales and must be skipped.
    const langs = Object.keys(TRANSLATIONS)
        .filter(l => l !== 'en' && TRANSLATIONS[l] && typeof TRANSLATIONS[l] === 'object')
        .sort();
    console.log('\n[i18n-check] Per-locale coverage (vs EN):');
    const below = [];
    const stubBelow = [];
    for (const lang of langs) {
        const count = Object.keys(TRANSLATIONS[lang] || {}).length;
        const pct = count / enKeys.size;
        const bar = '█'.repeat(Math.round(pct * 20)).padEnd(20, '·');
        const pctStr = (pct * 100).toFixed(1) + '%';
        const isStub = COVERAGE_STUB_LOCALES.has(lang);
        console.log(`  ${(isStub ? `${lang}*` : lang).padEnd(8)} ${bar} ${count.toString().padStart(5)} / ${enKeys.size}  ${pctStr}`);
        if (pct < COVERAGE_WARN_THRESHOLD) {
            if (isStub) stubBelow.push({ lang, pct });
            else below.push({ lang, pct });
        }
    }
    if (below.length) {
        console.log(`\n[i18n-check] ⚠  ${below.length} locale(s) below ${Math.round(COVERAGE_WARN_THRESHOLD*100)}% coverage — users will see English fallback for gaps.`);
    }
    if (stubBelow.length) {
        console.log(`\n[i18n-check] ℹ  Coverage threshold skipped fallback stub locale(s): ${stubBelow.map(({ lang }) => lang).join(', ')}.`);
    }

    // 5. Settings-help fanout gaps (warn only). The hard invariant gate blocks
    // missing canonical `en`/`zh` settings help keys; this patrol-side layer
    // surfaces missing non-canonical locale work without breaking CI or cron.
    const settingsHelpRegistry = loadSettingsHelpRegistry();
    const settingsHelpFanoutGaps = collectSettingsHelpFanoutGaps(TRANSLATIONS, settingsHelpRegistry);
    for (const line of formatSettingsHelpFanoutWarnings(settingsHelpFanoutGaps)) {
        console.log(line);
    }

    console.log('\n✅ [i18n-check] All referenced keys resolve in EN. No runtime "i18n not defined" risk.');
}

if (require.main === module) main();

module.exports = {
    collectSettingsHelpFanoutGaps,
    collectSimplifiedCharOffenders,
    findOrphanKeys,
    formatSettingsHelpFanoutWarnings,
    loadOrphanBaseline,
    loadSettingsHelpRegistry,
    loadZhSimplifiedCharSet,
    SIMPLIFIED_GATED_LOCALES,
};
