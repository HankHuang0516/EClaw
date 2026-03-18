#!/usr/bin/env node
/**
 * Portal Duplicate Variable Declaration — Static Analysis Test
 *
 * Scans portal HTML pages for `let`/`const` variable declarations that
 * conflict with variables already declared in shared scripts (auth.js, etc.).
 *
 * In browsers, all <script> tags share the same global scope. A `let` or
 * `const` redeclaration causes an uncaught SyntaxError that silently kills
 * the entire inline <script> block.
 *
 * Regression for: card-holder.html "My Cards" blank page caused by
 * duplicate `let currentUser` (also declared in shared/auth.js).
 *
 * No credentials needed.
 *
 * Usage:
 *   node backend/tests/test-portal-duplicate-vars.js
 */

const fs = require('fs');
const path = require('path');

// ── Test Result Tracking ────────────────────────────────────
const results = [];
function check(name, passed, detail = '') {
    results.push({ name, passed, detail });
    const icon = passed ? '✅' : '❌';
    const suffix = detail ? ` — ${detail}` : '';
    console.log(`  ${icon} ${name}${suffix}`);
}

console.log('\n🔍 Portal Duplicate Variable Declaration Test\n');

// ── Shared scripts that declare global variables ────────────
const PORTAL_DIR = path.resolve(__dirname, '../public/portal');
const SHARED_DIR = path.join(PORTAL_DIR, 'shared');

// Extract top-level let/const declarations from a JS file
function extractGlobalDecls(jsContent) {
    const decls = new Set();
    // Match `let varName` or `const varName` at the start of a line (top-level)
    const re = /^(?:let|const)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/gm;
    let m;
    while ((m = re.exec(jsContent)) !== null) {
        decls.add(m[1]);
    }
    return decls;
}

// Build set of variables declared in shared scripts
const sharedVars = new Map(); // varName → filename
const sharedFiles = fs.readdirSync(SHARED_DIR).filter(f => f.endsWith('.js'));
for (const file of sharedFiles) {
    const content = fs.readFileSync(path.join(SHARED_DIR, file), 'utf8');
    for (const v of extractGlobalDecls(content)) {
        sharedVars.set(v, file);
    }
}

console.log(`  Shared scripts: ${sharedFiles.length} files, ${sharedVars.size} global declarations`);

// ── Scan each portal HTML page ──────────────────────────────
const htmlFiles = fs.readdirSync(PORTAL_DIR).filter(f => f.endsWith('.html'));
let totalDuplicates = 0;

for (const htmlFile of htmlFiles) {
    const content = fs.readFileSync(path.join(PORTAL_DIR, htmlFile), 'utf8');

    // Check which shared scripts this page includes
    const includedShared = new Set();
    const scriptSrcRe = /src=["'](?:shared\/|\.\.\/shared\/)([^"']+)["']/g;
    let sm;
    while ((sm = scriptSrcRe.exec(content)) !== null) {
        includedShared.add(sm[1]);
    }

    // Extract inline script variable declarations
    const inlineScriptRe = /<script>([^]*?)<\/script>/g;
    const inlineDecls = new Map(); // varName → lineNumber
    let im;
    while ((im = inlineScriptRe.exec(content)) !== null) {
        const scriptContent = im[1];
        const scriptStartOffset = im.index;
        const linesBefore = content.substring(0, scriptStartOffset).split('\n').length;

        const declRe = /^[ \t]*(?:let|const)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/gm;
        let dm;
        while ((dm = declRe.exec(scriptContent)) !== null) {
            const lineInScript = scriptContent.substring(0, dm.index).split('\n').length;
            inlineDecls.set(dm[1], linesBefore + lineInScript - 1);
        }
    }

    // Check for conflicts
    const duplicates = [];
    for (const [varName, lineNum] of inlineDecls) {
        if (sharedVars.has(varName)) {
            const sharedFile = sharedVars.get(varName);
            // Only flag if this page includes that shared script
            if (includedShared.has(sharedFile)) {
                duplicates.push({ varName, lineNum, sharedFile });
            }
        }
    }

    if (duplicates.length > 0) {
        totalDuplicates += duplicates.length;
        for (const d of duplicates) {
            check(
                `${htmlFile}:${d.lineNum} — no duplicate \`${d.varName}\``,
                false,
                `already declared in shared/${d.sharedFile}`
            );
        }
    }
}

// Summary check
check(
    'No duplicate variable declarations across portal pages',
    totalDuplicates === 0,
    totalDuplicates > 0 ? `${totalDuplicates} duplicate(s) found` : `${htmlFiles.length} pages scanned`
);

// ── Summary ─────────────────────────────────────────────────
console.log('\n' + '─'.repeat(55));
const passed = results.filter(r => r.passed).length;
const failed = results.filter(r => !r.passed).length;
console.log(`  Total: ${results.length} checks — ${passed} passed, ${failed} failed`);
if (failed > 0) {
    console.log('  ⚠️  Fix duplicate declarations to prevent SyntaxError in browsers');
    process.exit(1);
}
console.log('  ✅ All clear!\n');
