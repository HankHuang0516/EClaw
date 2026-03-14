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
// 1b. Runtime: requiredVars format — never send raw strings (Gson crash)
//     Root cause: DB contributions stored ["KEY"] instead of [{key:"KEY"}].
//     Gson expected BEGIN_OBJECT but got STRING → entire response parse failed.
// ════════════════════════════════════════════════════════════════════════════

section('Runtime: GET /api/skill-templates — requiredVars format (Gson compat)');

test('every template.requiredVars entry is an object with a "key" string (never a raw string)', () => {
    const templates = templatesData?.templates || [];
    for (const t of templates) {
        if (!t.requiredVars || t.requiredVars.length === 0) continue;
        for (let i = 0; i < t.requiredVars.length; i++) {
            const v = t.requiredVars[i];
            assert(
                typeof v === 'object' && v !== null,
                `Template "${t.id}" requiredVars[${i}] is ${typeof v} ("${v}"), expected {key: string}. ` +
                `This causes Gson JsonSyntaxException on Android (Expected BEGIN_OBJECT but was STRING).`
            );
            assert(
                typeof v.key === 'string' && v.key.trim() !== '',
                `Template "${t.id}" requiredVars[${i}].key is missing or empty`
            );
        }
    }
});

test('normalizeRequiredVars is applied in GET response (static check)', () => {
    const src = readSrc('backend/index.js');
    const getRoute = src.indexOf("app.get('/api/skill-templates'");
    assert(getRoute !== -1, 'GET /api/skill-templates route not found');
    const routeBody = src.slice(getRoute, getRoute + 500);
    assert(
        routeBody.includes('normalizeRequiredVars'),
        'GET /api/skill-templates does not call normalizeRequiredVars() — raw strings may leak to clients'
    );
});

// ════════════════════════════════════════════════════════════════════════════
// 1c. Runtime: POST /api/skill-templates/contribute — requiredVars validation
// ════════════════════════════════════════════════════════════════════════════

section('Static + Runtime: POST /api/skill-templates/contribute — requiredVars validation');

// --- Static checks: validation code exists ---

test('contribute endpoint validates requiredVars is an array (static check)', () => {
    const src = readSrc('backend/index.js');
    const contributeRoute = src.indexOf("app.post('/api/skill-templates/contribute'");
    assert(contributeRoute !== -1, 'POST /api/skill-templates/contribute route not found');
    const routeBody = src.slice(contributeRoute, contributeRoute + 4000);
    assert(
        routeBody.includes("!Array.isArray(requiredVars)"),
        'Contribute endpoint missing Array.isArray(requiredVars) check'
    );
});

test('contribute endpoint validates requiredVars entries have .key (static check)', () => {
    const src = readSrc('backend/index.js');
    const contributeRoute = src.indexOf("app.post('/api/skill-templates/contribute'");
    const routeBody = src.slice(contributeRoute, contributeRoute + 4000);
    assert(
        routeBody.includes('.key') && routeBody.includes('non-empty string'),
        'Contribute endpoint missing requiredVars[].key validation'
    );
});

test('normalizeRequiredVars is applied in contribute entry creation (static check)', () => {
    const src = readSrc('backend/index.js');
    const contributeRoute = src.indexOf("app.post('/api/skill-templates/contribute'");
    assert(contributeRoute !== -1, 'POST /api/skill-templates/contribute route not found');
    const routeBody = src.slice(contributeRoute, contributeRoute + 6000);
    assert(
        routeBody.includes('normalizeRequiredVars(requiredVars)'),
        'Contribute endpoint does not call normalizeRequiredVars() when building entry — raw strings may be stored in DB'
    );
});

// --- Runtime checks: actual HTTP validation ---
// Note: bad requiredVars validation happens AFTER auth (device + botSecret).
// Tests use the real test device + a fake botSecret to reach the validation layer
// only when device exists. For format-only checks, we rely on static analysis above.

test('contribute endpoint rejects missing required skill fields before reaching requiredVars', async () => {
    const res = await fetch(`${API_BASE}/api/skill-templates/contribute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            deviceId: 'test-validator', botSecret: 'fake',
            skill: { id: 'x' }  // missing title, url, steps
        })
    });
    // Either 400 (missing fields) or 404 (device not found) — both acceptable
    assert(res.status === 400 || res.status === 404, `Expected 400 or 404, got ${res.status}`);
});

test('contribute endpoint does not crash on requiredVars: "NOT_AN_ARRAY" (no 500)', async () => {
    const res = await fetch(`${API_BASE}/api/skill-templates/contribute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            deviceId: 'test-validator', botSecret: 'fake',
            skill: {
                id: 'test-bad-1', title: 'T', url: 'https://github.com/t/t',
                steps: '1. Step one.', requiredVars: 'NOT_AN_ARRAY'
            }
        })
    });
    assert(res.status !== 500, `Server returned 500 — requiredVars validation not catching bad input`);
});

test('contribute endpoint does not crash on requiredVars: [42] (no 500)', async () => {
    const res = await fetch(`${API_BASE}/api/skill-templates/contribute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            deviceId: 'test-validator', botSecret: 'fake',
            skill: {
                id: 'test-bad-2', title: 'T', url: 'https://github.com/t/t',
                steps: '1. Step one.', requiredVars: [42]
            }
        })
    });
    assert(res.status !== 500, `Server returned 500 — requiredVars validation not catching numeric entries`);
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
