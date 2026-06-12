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
 */

const fs = require('fs');
const path = require('path');
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

function runAudit(root) {
    const findings = [];
    let filesScanned = 0;
    for (const file of walk(root)) {
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
    const result = runAudit(root);
    if (argv.includes('--json')) {
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
        return;
    }
    const { stats, groups } = result;
    console.log(`Audit: ${stats.filesScanned} files, ${stats.findings} findings across ${stats.ruleGroups}/${stats.rulesTotal} rules\n`);
    for (const g of groups) {
        console.log(`[${g.severity}] ${g.dimension} :: ${g.ruleId} — ${g.hits.length} hit(s)`);
        console.log(`   ${g.title}`);
        for (const h of g.hits.slice(0, 5)) console.log(`     ${h.filePath}:${h.lineNo}  ${h.excerpt}`);
        if (g.hits.length > 5) console.log(`     … and ${g.hits.length - 5} more`);
        console.log('');
    }
}

if (require.main === module) main();

module.exports = { runAudit, walk };
