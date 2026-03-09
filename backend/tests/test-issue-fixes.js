/**
 * Issue Fixes Regression Test
 *
 * Verifies all fixes merged in commit c532245:
 *   #145 — AI Chat CancellationException treated as network error on reopen
 *   #146-149 — Android skill dialog missing template selector (+ i18n)
 *   #150 — Portal chat images not processed when using CLI proxy fallback
 *
 * Tests are split into two groups:
 *   1. Static code checks — read source files, assert fix patterns exist (no auth)
 *   2. Runtime API checks  — call GET /api/skill-templates, verify response shape
 *
 * Usage:
 *   node backend/tests/test-issue-fixes.js
 */

'use strict';

const path = require('path');
const fs   = require('fs');

// ── Config ──────────────────────────────────────────────────────────────────

const API_BASE = 'https://eclawbot.com';
const ROOT     = path.resolve(__dirname, '..', '..');

// ── Mini test framework (sequential) ────────────────────────────────────────

let passed   = 0;
let failed   = 0;
const failures = [];
const tests  = [];   // collected as { name, fn }

function test(name, fn) {
    tests.push({ name, fn });
}

function section(title) {
    console.log(`\n── ${title} ──`);
}

async function runAll() {
    for (const { name, fn } of tests) {
        try {
            await fn();
            console.log(`  ✓  ${name}`);
            passed++;
        } catch (e) {
            console.error(`  ✗  ${name}`);
            console.error(`       ${e.message}`);
            failed++;
            failures.push({ name, reason: e.message });
        }
    }
}

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function readSrc(relPath) {
    return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

// ════════════════════════════════════════════════════════════════════════════
// Test definitions
// ════════════════════════════════════════════════════════════════════════════

// ── 1. Static: #145 — AiChatActivity.kt CancellationException fix ───────────

section('Static: #145 – AiChatActivity.kt CancellationException fix');

const AI_CHAT_PATH = 'app/src/main/java/com/hank/clawlive/AiChatActivity.kt';

test('#145 catch block re-throws CancellationException', () => {
    const src = readSrc(AI_CHAT_PATH);
    assert(
        src.includes('is kotlinx.coroutines.CancellationException') &&
        src.includes('throw e'),
        'CancellationException re-throw pattern not found in AiChatActivity.kt'
    );
});

test('#145 finally block guards saveHistory() with !isFinishing', () => {
    const src = readSrc(AI_CHAT_PATH);
    assert(
        src.includes('!isFinishing'),
        '!isFinishing guard not found in AiChatActivity.kt'
    );
});

// ── 2. Static: #146-149 — ClawApiService.kt getSkillTemplates ───────────────

section('Static: #146-149 – ClawApiService.kt skill templates API');

const API_SERVICE_PATH = 'app/src/main/java/com/hank/clawlive/data/remote/ClawApiService.kt';

test('#146-149 getSkillTemplates() method exists', () => {
    const src = readSrc(API_SERVICE_PATH);
    assert(src.includes('getSkillTemplates'), 'getSkillTemplates() not found in ClawApiService.kt');
});

test('#146-149 SkillTemplatesResponse data class exists', () => {
    const src = readSrc(API_SERVICE_PATH);
    assert(src.includes('SkillTemplatesResponse'), 'SkillTemplatesResponse class not found');
});

test('#146-149 SkillTemplate data class exists', () => {
    const src = readSrc(API_SERVICE_PATH);
    assert(src.includes('data class SkillTemplate'), 'SkillTemplate data class not found');
});

// ── 3. Static: #146-149 — dialog_mission_skill.xml Spinner ──────────────────

section('Static: #146-149 – dialog_mission_skill.xml template Spinner');

const DIALOG_XML_PATH = 'app/src/main/res/layout/dialog_mission_skill.xml';

test('#146-149 template browse button exists in dialog XML (btnBrowseTemplates)', () => {
    const src = readSrc(DIALOG_XML_PATH);
    // Originally designed as a Spinner (spinnerTemplate), later implemented as
    // a browse button + selected-template indicator layout (btnBrowseTemplates).
    assert(
        src.includes('btnBrowseTemplates') || src.includes('spinnerTemplate'),
        'Neither btnBrowseTemplates nor spinnerTemplate found in dialog_mission_skill.xml'
    );
});

test('#146-149 dialog uses @string/skill_title_hint (no hardcoded text)', () => {
    const src = readSrc(DIALOG_XML_PATH);
    assert(
        src.includes('@string/skill_title_hint'),
        'skill_title_hint string ref missing — hint is hardcoded'
    );
});

test('#146-149 dialog uses @string/skill_url_hint (no hardcoded text)', () => {
    const src = readSrc(DIALOG_XML_PATH);
    assert(
        src.includes('@string/skill_url_hint'),
        'skill_url_hint string ref missing — hint is hardcoded'
    );
});

// ── 4. Static: #146-149 — MissionControlActivity.kt loadSkillTemplates ──────

section('Static: #146-149 – MissionControlActivity.kt template loading');

const MISSION_PATH = 'app/src/main/java/com/hank/clawlive/MissionControlActivity.kt';

test('#146-149 loadSkillTemplates() function exists', () => {
    const src = readSrc(MISSION_PATH);
    assert(src.includes('loadSkillTemplates'), 'loadSkillTemplates() not found in MissionControlActivity.kt');
});

test('#146-149 template selector wired in showSkillDialogInternal()', () => {
    const src = readSrc(MISSION_PATH);
    assert(src.includes('btnBrowseTemplates') || src.includes('spinnerTemplate'), 'Template selector (btnBrowseTemplates or spinnerTemplate) not found in MissionControlActivity.kt');
});

test('#146-149 dialog title uses R.string.add_skill_dialog_title', () => {
    const src = readSrc(MISSION_PATH);
    assert(
        src.includes('add_skill_dialog_title'),
        'Hardcoded dialog title still present — should use R.string.add_skill_dialog_title'
    );
});

// ── 5. Static: #146-149 — i18n strings.xml (default English) ────────────────

section('Static: #146-149 – i18n strings.xml (default English)');

const STRINGS_EN_PATH = 'app/src/main/res/values/strings.xml';

const REQUIRED_STRINGS = [
    'skill_template',
    'skill_template_custom',
    'skill_title_hint',
    'skill_url_hint',
    'add_skill_dialog_title',
];

for (const key of REQUIRED_STRINGS) {
    test(`#146-149 strings.xml (en) has "${key}"`, () => {
        const src = readSrc(STRINGS_EN_PATH);
        assert(src.includes(`name="${key}"`), `Missing key "${key}" in values/strings.xml`);
    });
}

// ── 6. Static: #146-149 — i18n zh-rTW strings ───────────────────────────────

section('Static: #146-149 – i18n values-zh-rTW/strings.xml');

const STRINGS_ZH_PATH = 'app/src/main/res/values-zh-rTW/strings.xml';

for (const key of REQUIRED_STRINGS) {
    test(`#146-149 strings.xml (zh-rTW) has "${key}"`, () => {
        const src = readSrc(STRINGS_ZH_PATH);
        assert(src.includes(`name="${key}"`), `Missing key "${key}" in values-zh-rTW/strings.xml`);
    });
}

// ── 7. Static: #150 — ai-support.js sync path strips images from CLI proxy ───

section('Static: #150 – ai-support.js strips images from CLI proxy');

const AI_SUPPORT_PATH = 'backend/ai-support.js';

test('#150 proxyMessage variable exists (image-stripping wrapper)', () => {
    const src = readSrc(AI_SUPPORT_PATH);
    assert(src.includes('proxyMessage'), 'proxyMessage variable not found in ai-support.js');
});

test('#150 image-stripping note present (sync + async paths, expect ≥2 occurrences)', () => {
    const src = readSrc(AI_SUPPORT_PATH);
    const NOTE = 'image analysis is only supported via the direct Anthropic API';
    const count = (src.match(new RegExp(NOTE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
    assert(count >= 2, `Expected ≥2 occurrences of image-stripping note (sync+async), found ${count}`);
});

// ── 8. Runtime: GET /api/skill-templates ────────────────────────────────────

section('Runtime: GET /api/skill-templates');

const EXPECTED_IDS = [
    'claude-proxy',
    'x-tweet-fetcher',
    'model-hierarchy',
    'openclaw-search-skills',
];

// State shared between runtime tests (populated sequentially)
let templatesData = null;

test('#146-149 GET /api/skill-templates returns HTTP 200', async () => {
    const res = await fetch(`${API_BASE}/api/skill-templates`);
    assert(res.status === 200, `Expected HTTP 200, got ${res.status}`);
    templatesData = await res.json();
});

test('#146-149 response.success === true', () => {
    assert(templatesData !== null, 'No response data — HTTP test failed');
    assert(templatesData.success === true, `success is not true: ${JSON.stringify(templatesData)}`);
});

test('#146-149 response.templates is an array', () => {
    assert(Array.isArray(templatesData && templatesData.templates), 'templates is not an array');
});

test(`#146-149 templates array has at least ${EXPECTED_IDS.length} entries`, () => {
    const count = (templatesData.templates || []).length;
    assert(count >= EXPECTED_IDS.length, `Expected at least ${EXPECTED_IDS.length} templates, got ${count}`);
});

for (const id of EXPECTED_IDS) {
    test(`#146-149 template "${id}" present`, () => {
        const found = (templatesData && templatesData.templates || []).find(t => t.id === id);
        assert(found !== undefined, `Template "${id}" not found in response`);
    });
}

test('#146-149 every template has id, label, title', () => {
    for (const t of (templatesData && templatesData.templates || [])) {
        assert(t.id,    `Template missing "id": ${JSON.stringify(t)}`);
        assert(t.label, `Template "${t.id}" missing "label"`);
        assert(t.title, `Template "${t.id}" missing "title"`);
    }
});

// ════════════════════════════════════════════════════════════════════════════
// Run
// ════════════════════════════════════════════════════════════════════════════

runAll().then(() => {
    console.log('\n' + '─'.repeat(56));
    console.log(`Results: ${passed} passed, ${failed} failed`);
    if (failures.length > 0) {
        console.log('\nFailures:');
        for (const f of failures) {
            console.error(`  ✗ ${f.name}`);
            console.error(`    ${f.reason}`);
        }
        process.exit(1);
    } else {
        console.log('\nAll issue-fix regression tests passed.');
        process.exit(0);
    }
});
