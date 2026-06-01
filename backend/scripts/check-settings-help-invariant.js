#!/usr/bin/env node
'use strict';

/**
 * Settings help invariant gate.
 *
 * Enforces the settings field trio from docs/specs/settings-help-icon.md:
 *   <field>_label + <field>_help + a nearby HELP-KEY annotation.
 *
 * The full help -> code invariant is scoped by backend/settings-help-keys.json
 * when that generated registry exists. Before the registry lands, the checker
 * still gates newly added/modified settings labels from the PR diff.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

// __dirname-anchored paths. BACKEND_DIR is always the parent of scripts/.
// REPO_ROOT is one level above BACKEND_DIR — but on Railway the backend
// directory is deployed at root (no <repo>/backend/ wrapper), so BACKEND_DIR
// can equal '/' on Railway and REPO_ROOT computed via `..` would step outside
// the deploy tree. The fix is to anchor BACKEND_DIR off __dirname and use it
// directly for backend-internal lookups (i18n.js, settings-help-keys.json),
// only falling through to REPO_ROOT for cross-package scans (e.g. ios-app/,
// openclaw-channel-eclaw/) which are handled separately in walk()'s root list.
const BACKEND_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(BACKEND_DIR, '..');
const PUBLIC_DIR = path.join(BACKEND_DIR, 'public');
const I18N_FILE = path.join(PUBLIC_DIR, 'shared', 'i18n.js');
const REGISTRY_FILE = path.join(BACKEND_DIR, 'settings-help-keys.json');
const SETTINGS_FILE_RE = /^backend\/public\/(?:.*\/)?settings[^/]*\.html$/;
const LABEL_RE = /\bdata-i18n\s*=\s*["']([A-Za-z0-9_.-]+)_label["']/g;
const HELP_ANNOTATION_RE = /HELP-KEY:\s*([A-Za-z0-9_.-]+)/g;

function parseArgs(argv) {
    const args = { all: false, base: null, head: 'HEAD' };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--all') args.all = true;
        else if (arg === '--base') args.base = argv[++i];
        else if (arg === '--head') args.head = argv[++i];
        else if (arg === '--help') {
            console.log('Usage: node backend/scripts/check-settings-help-invariant.js [--base <ref>] [--head <ref>] [--all]');
            process.exit(0);
        } else {
            throw new Error(`Unknown argument: ${arg}`);
        }
    }
    return args;
}

function runGit(args) {
    return execFileSync('git', args, {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    });
}

function diffRange(base, head) {
    if (!base) return null;
    return `${base}...${head || 'HEAD'}`;
}

function listChangedFiles(base, head) {
    const range = diffRange(base, head);
    if (!range) return [];
    try {
        return runGit(['diff', '--name-only', range])
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean);
    } catch (err) {
        console.warn(`[settings-help] Could not list changed files for ${range}: ${err.message}`);
        return [];
    }
}

function loadTranslations() {
    const src = fs.readFileSync(I18N_FILE, 'utf8');
    const noop = () => {};
    const sandbox = {
        _result: null,
        localStorage: { getItem: noop, setItem: noop },
        navigator: { language: 'en' },
        document: {
            querySelectorAll: () => [],
            documentElement: { lang: 'en' },
            addEventListener: noop,
            getElementById: () => null,
        },
        window: { location: { search: '' } },
        setTimeout: noop,
        console: { log: noop, warn: noop, error: noop },
    };
    vm.createContext(sandbox);
    vm.runInContext(`${src}\n_result = TRANSLATIONS;`, sandbox, { timeout: 5000 });
    if (!sandbox._result || typeof sandbox._result !== 'object') {
        throw new Error('Failed to extract TRANSLATIONS from backend/public/shared/i18n.js');
    }
    return sandbox._result;
}

function hasTranslation(translations, locale, key) {
    return !!(
        translations[locale] &&
        typeof translations[locale] === 'object' &&
        Object.prototype.hasOwnProperty.call(translations[locale], key)
    );
}

function loadRegistry() {
    if (!fs.existsSync(REGISTRY_FILE)) return null;
    const raw = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'));
    const entries = Array.isArray(raw.keys) ? raw.keys : [];
    return entries.map((entry) => ({
        fieldKey: entry.field_key,
        labelKey: entry.label_key,
        helpKey: entry.help_key,
        source: 'registry',
    }));
}

function collectDiffAddedSettingsLabels(base, head) {
    const range = diffRange(base, head);
    if (!range) return [];
    let diff;
    try {
        diff = runGit(['diff', '--unified=0', '--no-ext-diff', range, '--', 'backend/public']);
    } catch (err) {
        console.warn(`[settings-help] Could not read settings diff for ${range}: ${err.message}`);
        return [];
    }

    const labels = new Map();
    let currentFile = null;
    for (const line of diff.split(/\r?\n/)) {
        if (line.startsWith('+++ b/')) {
            currentFile = line.slice('+++ b/'.length);
            continue;
        }
        if (!currentFile || !SETTINGS_FILE_RE.test(currentFile)) continue;
        if (!line.startsWith('+') || line.startsWith('+++')) continue;
        LABEL_RE.lastIndex = 0;
        let match;
        while ((match = LABEL_RE.exec(line)) !== null) {
            labels.set(match[1], currentFile);
        }
    }
    return [...labels.entries()].map(([fieldKey, sourceFile]) => ({
        fieldKey,
        labelKey: `${fieldKey}_label`,
        helpKey: `${fieldKey}_help`,
        source: `diff:${sourceFile}`,
    }));
}

function shouldSkipDir(name) {
    return name === '.git' ||
        name === 'node_modules' ||
        name === 'build' ||
        name === '.gradle' ||
        name === '.kotlin' ||
        name === 'release_v1.0.75' ||
        name === 'release_v1.0.76' ||
        name === 'release_v1.0.78' ||
        name === 'release_v1.0.79' ||
        name === 'release_v1.0.80' ||
        name === 'release_v1.0.85' ||
        name === 'release_v1.0.88' ||
        name === 'release_v1.0.89';
}

function shouldScanFile(filePath) {
    if (filePath === I18N_FILE) return false;
    const rel = path.relative(REPO_ROOT, filePath);
    if (rel.startsWith('docs/')) return false;
    return /\.(html|js|jsx|ts|tsx|kt|java|mjs|cjs)$/.test(filePath);
}

function walk(dir, out = []) {
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
            if (!shouldSkipDir(entry.name)) walk(path.join(dir, entry.name), out);
        } else {
            const full = path.join(dir, entry.name);
            if (shouldScanFile(full)) out.push(full);
        }
    }
    return out;
}

function collectHelpAnnotations() {
    const roots = [
        path.join(REPO_ROOT, 'backend'),
        path.join(REPO_ROOT, 'app', 'src'),
        path.join(REPO_ROOT, 'ios-app'),
        path.join(REPO_ROOT, 'openclaw-channel-eclaw', 'src'),
    ];
    const annotations = new Map();
    for (const file of roots.flatMap((root) => walk(root))) {
        const text = fs.readFileSync(file, 'utf8');
        HELP_ANNOTATION_RE.lastIndex = 0;
        let match;
        while ((match = HELP_ANNOTATION_RE.exec(text)) !== null) {
            const key = match[1];
            const line = text.slice(0, match.index).split(/\r?\n/).length;
            if (!annotations.has(key)) annotations.set(key, []);
            annotations.get(key).push(`${path.relative(REPO_ROOT, file)}:${line}`);
        }
    }
    return annotations;
}

function addRequired(required, entry) {
    if (!entry.fieldKey || !entry.labelKey || !entry.helpKey) return;
    if (!required.has(entry.helpKey)) required.set(entry.helpKey, { ...entry });
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    const translations = loadTranslations();
    const registry = loadRegistry();
    const changedFiles = args.all ? [] : listChangedFiles(args.base, args.head);
    const diffLabels = args.all ? [] : collectDiffAddedSettingsLabels(args.base, args.head);
    const annotations = collectHelpAnnotations();

    const required = new Map();
    if (registry) {
        for (const entry of registry) addRequired(required, entry);
    }
    for (const entry of diffLabels) addRequired(required, entry);

    const registryHelpKeys = new Set((registry || []).map((entry) => entry.helpKey));
    const errors = [];

    for (const entry of required.values()) {
        // Canonical locale pair is en + zh — zh-TW is intentionally a thin
        // override stub (publisher-guide-only), with zh holding the canonical
        // Traditional Chinese dict (enforced by tests/jest/i18n-fallback-chain).
        for (const locale of ['en', 'zh']) {
            if (!hasTranslation(translations, locale, entry.labelKey)) {
                errors.push(`${entry.source}: missing ${locale} label key ${entry.labelKey}`);
            }
            if (!hasTranslation(translations, locale, entry.helpKey)) {
                errors.push(`${entry.source}: missing ${locale} help key ${entry.helpKey}`);
            }
        }
        if (!annotations.has(entry.helpKey)) {
            errors.push(`${entry.source}: missing HELP-KEY annotation for ${entry.helpKey}`);
        }
        if (registry && entry.source.startsWith('diff:') && !registryHelpKeys.has(entry.helpKey)) {
            errors.push(`${entry.source}: ${entry.helpKey} is not present in backend/settings-help-keys.json; regenerate the registry`);
        }
    }

    for (const [helpKey, locations] of annotations.entries()) {
        for (const locale of ['en', 'zh']) {
            if (!hasTranslation(translations, locale, helpKey)) {
                errors.push(`HELP-KEY ${helpKey} at ${locations.join(', ')} points to missing ${locale} i18n key`);
            }
        }
    }

    if (errors.length > 0) {
        console.error('\nFAIL: settings help invariant violations:\n');
        for (const error of errors) console.error(`  - ${error}`);
        console.error('\nEvery settings field added or listed in backend/settings-help-keys.json must have:');
        console.error('  1. <field>_label in en and zh');
        console.error('  2. <field>_help in en and zh');
        console.error('  3. A code-side HELP-KEY annotation pointing at <field>_help');
        console.error('  (zh-TW is a thin override stub — Traditional Chinese canonical lives in zh)');
        process.exit(1);
    }

    const changedSummary = changedFiles.length ? `${changedFiles.length} changed file(s)` : 'no diff range';
    const registrySummary = registry ? `${registry.length} registry key(s)` : 'no registry yet';
    const diffSummary = diffLabels.length ? `${diffLabels.length} added/modified settings label(s)` : 'no added settings labels';
    console.log(`[settings-help] OK: ${registrySummary}; ${diffSummary}; ${annotations.size} annotation key(s); ${changedSummary}.`);
}

if (require.main === module) main();

module.exports = {
    collectDiffAddedSettingsLabels,
    collectHelpAnnotations,
    hasTranslation,
    loadRegistry,
    loadTranslations,
};
