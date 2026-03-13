/**
 * Skill Templates — Regression Test
 *
 * Guards against the "No templates available" empty-gallery bug and ensures:
 *   1. Runtime: /api/skill-templates returns ≥1 template (never empty list in prod)
 *   2. Runtime: every template has required fields (id, label, title)
 *   3. Static: Android retry-on-empty logic exists in MissionControlActivity.kt
 *   4. Static: search bar is wired in showTemplateGalleryDialogInternal()
 *   5. Static: browse button shows template count
 *
 * Usage:
 *   node backend/tests/test-skill-templates.js
 *   node backend/tests/test-skill-templates.js --local
 */

'use strict';

const path = require('path');
const fs   = require('fs');

// ── Config ────────────────────────────────────────────────────────────────────

const args     = process.argv.slice(2);
const isLocal  = args.includes('--local');
const API_BASE = isLocal ? 'http://localhost:3000' : 'https://eclawbot.com';
const ROOT     = path.resolve(__dirname, '..', '..');

// ── Mini test framework ───────────────────────────────────────────────────────

let passed = 0, failed = 0;
const failures = [];
const tests = [];

function test(name, fn) { tests.push({ name, fn }); }
function section(title) { console.log(`\n── ${title} ──`); }
function assert(condition, message) { if (!condition) throw new Error(message); }

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

function readSrc(relPath) {
    return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

// ════════════════════════════════════════════════════════════════════════════
// 1. Runtime: /api/skill-templates health
// ════════════════════════════════════════════════════════════════════════════

section('Runtime: GET /api/skill-templates — never empty');

let templatesData = null;

test('GET /api/skill-templates returns HTTP 200', async () => {
    const res = await fetch(`${API_BASE}/api/skill-templates`);
    assert(res.status === 200, `Expected HTTP 200, got ${res.status}`);
    templatesData = await res.json();
});

test('response.success === true', () => {
    assert(templatesData !== null, 'No response data — HTTP test failed');
    assert(templatesData.success === true, `success is not true: ${JSON.stringify(templatesData)}`);
});

test('response.templates is a non-empty array (no "No templates available" in prod)', () => {
    const count = (templatesData?.templates || []).length;
    assert(count >= 1,
        `Templates array is empty (count=${count}) — Android gallery would show "No templates available". ` +
        `Check GET /api/skill-templates on ${API_BASE}.`
    );
});

test('every template has id, label, title', () => {
    for (const t of (templatesData?.templates || [])) {
        assert(t.id,    `Template missing "id": ${JSON.stringify(t)}`);
        assert(t.label, `Template "${t.id}" missing "label"`);
        assert(t.title, `Template "${t.id}" missing "title"`);
    }
});

test('no template has an empty label or title (would break UI display)', () => {
    for (const t of (templatesData?.templates || [])) {
        assert(t.label.trim() !== '', `Template "${t.id}" has blank label`);
        assert(t.title.trim() !== '', `Template "${t.id}" has blank title`);
    }
});

// ════════════════════════════════════════════════════════════════════════════
// 2. Static: Android retry-on-empty logic
// ════════════════════════════════════════════════════════════════════════════

section('Static: MissionControlActivity.kt — retry-on-empty fix');

const MISSION_PATH = 'app/src/main/java/com/hank/clawlive/MissionControlActivity.kt';

test('showTemplateGalleryDialog() checks isEmpty() before showing', () => {
    const src = readSrc(MISSION_PATH);
    assert(
        src.includes('showTemplateGalleryDialog') && src.includes('skillTemplates.isEmpty()'),
        'showTemplateGalleryDialog() does not check skillTemplates.isEmpty()'
    );
});

test('retry logic reloads templates when empty (calls api.getSkillTemplates inside showTemplateGalleryDialog)', () => {
    const src = readSrc(MISSION_PATH);
    // The retry block must contain getSkillTemplates BEFORE the internal call
    const dialogIdx  = src.indexOf('private fun showTemplateGalleryDialog(');
    const internalIdx = src.indexOf('private fun showTemplateGalleryDialogInternal(');
    assert(dialogIdx !== -1,  'showTemplateGalleryDialog() not found');
    assert(internalIdx !== -1, 'showTemplateGalleryDialogInternal() not found');
    const retryBlock = src.slice(dialogIdx, internalIdx);
    assert(
        retryBlock.includes('getSkillTemplates()'),
        'Retry block in showTemplateGalleryDialog() does not call getSkillTemplates()'
    );
});

// ════════════════════════════════════════════════════════════════════════════
// 3. Static: Search bar in gallery dialog
// ════════════════════════════════════════════════════════════════════════════

section('Static: MissionControlActivity.kt — search bar in gallery');

test('showTemplateGalleryDialogInternal() creates an EditText search bar', () => {
    const src = readSrc(MISSION_PATH);
    const internalIdx = src.indexOf('private fun showTemplateGalleryDialogInternal(');
    assert(internalIdx !== -1, 'showTemplateGalleryDialogInternal() not found');
    const body = src.slice(internalIdx, internalIdx + 3000);
    assert(
        body.includes('EditText'),
        'No EditText found in showTemplateGalleryDialogInternal() — search bar missing'
    );
});

test('gallery uses addTextChangedListener for live search filtering', () => {
    const src = readSrc(MISSION_PATH);
    assert(
        src.includes('addTextChangedListener'),
        'addTextChangedListener not found in MissionControlActivity.kt — live search not wired'
    );
});

test('gallery filters templates by label/title/author', () => {
    const src = readSrc(MISSION_PATH);
    assert(
        src.includes('ignoreCase = true'),
        'Case-insensitive filter (ignoreCase = true) not found — search may be case-sensitive'
    );
});

// ════════════════════════════════════════════════════════════════════════════
// 4. Static: Browse button shows count
// ════════════════════════════════════════════════════════════════════════════

section('Static: MissionControlActivity.kt — browse button shows template count');

test('btnBrowseTemplates text is updated with skillTemplates.size', () => {
    const src = readSrc(MISSION_PATH);
    assert(
        src.includes('skillTemplates.size'),
        'skillTemplates.size not referenced for button text — count badge missing'
    );
});

test('gallery dialog title includes template count', () => {
    const src = readSrc(MISSION_PATH);
    const internalIdx = src.indexOf('private fun showTemplateGalleryDialogInternal(');
    assert(internalIdx !== -1, 'showTemplateGalleryDialogInternal() not found');
    const body = src.slice(internalIdx, internalIdx + 6000);
    assert(
        body.includes('skillTemplates.size'),
        'Gallery dialog title does not include skillTemplates.size (count not shown in title)'
    );
});

// ════════════════════════════════════════════════════════════════════════════
// Run
// ════════════════════════════════════════════════════════════════════════════

runAll().then(() => {
    console.log('\n' + '─'.repeat(60));
    console.log(`Results: ${passed} passed, ${failed} failed`);
    if (failures.length > 0) {
        console.log('\nFailures:');
        for (const f of failures) {
            console.error(`  ✗ ${f.name}`);
            console.error(`    ${f.reason}`);
        }
        process.exit(1);
    } else {
        console.log('\nAll skill-template regression tests passed.');
        process.exit(0);
    }
});
