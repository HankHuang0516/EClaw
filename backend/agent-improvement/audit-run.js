#!/usr/bin/env node
'use strict';

/**
 * Weekly compliance + multi-tenant audit runner.
 * Card: card_923709f59ecb0c1cd66bc786 (Hank 2026-06-07 20:32 TW).
 *
 * Walks the shipped source tree, applies the pure-data rules in
 * audit-rules.js, and emits findings grouped by (ruleId, file). Designed to
 * run from the weekly cron card (`0 9 * * 1` Asia/Taipei): the cron dispatch
 * runs `node audit-run.js --json`, then files one kanban subcard per distinct
 * (ruleId) group at the rule's severity.
 *
 * Globe-user safe (per feedback_platform_user_rule_compliance): no hardcoded
 * device/owner — it audits the repo, takes the repo root as argv or cwd.
 *
 * Usage:
 *   node audit-run.js                 # human summary to stdout
 *   node audit-run.js --json          # machine JSON ({findings, groups, stats})
 *   node audit-run.js --root <dir>    # override scan root (default: repo backend/)
 *
 *   # PR-DIFF PREFLIGHT (card_3c6fb87 SPEC v2, #6): scan ONLY files changed vs a
 *   # base ref, so a CI preflight catches NEW operability (and any) regressions
 *   # on a branch WITHOUT flooding on the pre-existing tree. Intersects the git
 *   # changed-file set with the scannable extensions; full-scan stays the default.
 *   node audit-run.js --diff <baseRef>   # scan files changed vs <baseRef> (e.g. origin/main)
 *   node audit-run.js --changed          # shorthand for --diff origin/main
 *   node audit-run.js --diff origin/main --json
 *   # Exit code: with --diff, exits 1 if any finding is produced (CI gate);
 *   # the full scan always exits 0 (the weekly cron files cards, it doesn't fail CI).
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { scanText, RULES } = require('./audit-rules');

// Directories we never walk — vendored code, build output, the audit's own
// rule definitions (which contain the offending patterns as data), and VCS.
const SKIP_DIRS = new Set([
    'node_modules', '.git', 'dist', 'build', 'coverage', '.next',
    'vendor', 'assets', '.worktrees', 'tmp',
]);
// The rules file legitimately contains every pattern as data; auditing it
// produces only self-references. Same for the runner and its tests.
const SELF_FILES = new Set(['audit-rules.js', 'audit-run.js', 'audit-rules.test.js']);
const SCAN_EXT = new Set(['.js', '.ts', '.html', '.sql']);
const MAX_FILE_BYTES = 2 * 1024 * 1024; // skip giant generated bundles (i18n.js etc.)

function* walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
        if (e.name.startsWith('.') && e.name !== '.') continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
            if (SKIP_DIRS.has(e.name)) continue;
            yield* walk(full);
        } else if (e.isFile()) {
            if (SELF_FILES.has(e.name)) continue;
            if (!SCAN_EXT.has(path.extname(e.name))) continue;
            yield full;
        }
    }
}

/**
 * Is this a file we would scan in a full walk? (extension + not self/skip).
 * `relPath` MUST be relative to the scan root — so SKIP_DIRS only matches dirs
 * UNDER the repo (a `tmp`/`vendor`/etc. segment in the absolute prefix like
 * `/private/tmp/…` must NOT cause a reject).
 */
function isScannableFile(relPath) {
    const base = path.basename(relPath);
    if (SELF_FILES.has(base)) return false;
    if (!SCAN_EXT.has(path.extname(base))) return false;
    const parts = relPath.split(path.sep).filter((p) => p && p !== '.' && p !== '..');
    if (parts.some((p) => SKIP_DIRS.has(p))) return false;
    return true;
}

/**
 * Files changed versus a base git ref (e.g. `origin/main`), resolved to the repo
 * root. Uses `git diff --name-only <base>...HEAD` (three-dot: changes on the
 * branch since it diverged) plus uncommitted working-tree changes, intersected
 * with the scannable set. Returns absolute paths that currently exist on disk.
 */
function changedScannableFiles(root, baseRef) {
    // Resolve symlinks (e.g. macOS /tmp → /private/tmp) so the gitRoot and the
    // scan root compare apples-to-apples.
    const realRoot = (() => { try { return fs.realpathSync(root); } catch { return path.resolve(root); } })();
    // git runs from the repo, not necessarily `root` (which may be backend/).
    let gitRoot;
    try {
        gitRoot = execFileSync('git', ['rev-parse', '--show-toplevel'],
            { cwd: realRoot, encoding: 'utf8' }).trim();
    } catch {
        gitRoot = realRoot;
    }
    try { gitRoot = fs.realpathSync(gitRoot); } catch { /* keep as-is */ }
    const out = new Set();
    const collect = (args) => {
        let res = '';
        try { res = execFileSync('git', args, { cwd: gitRoot, encoding: 'utf8' }); }
        catch { return; }
        for (const line of res.split('\n')) {
            const rel = line.trim();
            if (!rel) continue;
            out.add(path.resolve(gitRoot, rel));
        }
    };
    // Committed branch changes since divergence from base, plus staged + unstaged.
    collect(['diff', '--name-only', `${baseRef}...HEAD`]);
    collect(['diff', '--name-only', baseRef]);          // fallback / working-tree vs base
    collect(['diff', '--name-only', '--cached']);       // staged
    const rootPrefix = realRoot + path.sep;
    return [...out].filter((abs) =>
        abs.startsWith(rootPrefix)                       // only under the scan root
        && isScannableFile(path.relative(realRoot, abs)) // skip-check relative to root
        && fs.existsSync(abs));
}

function runAudit(root, fileList) {
    const findings = [];
    let filesScanned = 0;
    const files = fileList || walk(root);
    for (const file of files) {
        let stat;
        try { stat = fs.statSync(file); } catch { continue; }
        if (stat.size > MAX_FILE_BYTES) continue;
        let text;
        try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
        filesScanned++;
        // Use a repo-relative path so findings are portable / not owner-specific.
        const rel = path.relative(root, file);
        for (const f of scanText(rel, text)) findings.push(f);
    }
    // Group by ruleId so the cron files one subcard per rule class, not per line.
    const groups = {};
    for (const f of findings) {
        (groups[f.ruleId] ||= {
            ruleId: f.ruleId, dimension: f.dimension, severity: f.severity,
            title: f.title, rationale: f.rationale, hits: [],
        }).hits.push({ filePath: f.filePath, lineNo: f.lineNo, excerpt: f.excerpt });
    }
    const groupList = Object.values(groups).sort((a, b) =>
        ['P0', 'P1', 'P2', 'P3'].indexOf(a.severity) - ['P0', 'P1', 'P2', 'P3'].indexOf(b.severity));
    return {
        stats: { filesScanned, findings: findings.length, ruleGroups: groupList.length, rulesTotal: RULES.length },
        groups: groupList,
        findings,
    };
}

function main() {
    const argv = process.argv.slice(2);
    const rootIdx = argv.indexOf('--root');
    const root = rootIdx !== -1 ? argv[rootIdx + 1]
        : path.resolve(__dirname, '..'); // default: backend/

    // PR-diff preflight: --diff <baseRef> | --changed (== --diff origin/main).
    const diffIdx = argv.indexOf('--diff');
    const baseRef = diffIdx !== -1 ? argv[diffIdx + 1]
        : (argv.includes('--changed') ? 'origin/main' : null);
    let fileList = null;
    if (baseRef) {
        fileList = changedScannableFiles(root, baseRef);
    }

    const result = runAudit(root, fileList);
    if (baseRef) result.stats.mode = 'diff-preflight';
    if (baseRef) result.stats.baseRef = baseRef;

    if (argv.includes('--json')) {
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
        // CI gate: a diff preflight fails (exit 1) when it finds a regression in
        // the touched files; the full scan never fails CI (the cron files cards).
        if (baseRef && result.stats.findings > 0) process.exitCode = 1;
        return;
    }
    const { stats, groups } = result;
    if (baseRef) {
        console.log(`Diff preflight vs ${baseRef}: ${stats.filesScanned} changed file(s) scanned, ` +
            `${stats.findings} finding(s) across ${stats.ruleGroups}/${stats.rulesTotal} rules\n`);
    } else {
        console.log(`Audit: ${stats.filesScanned} files, ${stats.findings} findings across ${stats.ruleGroups}/${stats.rulesTotal} rules\n`);
    }
    for (const g of groups) {
        console.log(`[${g.severity}] ${g.dimension} :: ${g.ruleId} — ${g.hits.length} hit(s)`);
        console.log(`   ${g.title}`);
        for (const h of g.hits.slice(0, 5)) console.log(`     ${h.filePath}:${h.lineNo}  ${h.excerpt}`);
        if (g.hits.length > 5) console.log(`     … and ${g.hits.length - 5} more`);
        console.log('');
    }
    // CI gate (human mode too): a diff preflight fails when it finds a regression.
    if (baseRef && stats.findings > 0) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { runAudit, walk, changedScannableFiles, isScannableFile };
