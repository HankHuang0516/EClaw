'use strict';

/**
 * Single-tenant violation scanner (per memory feedback_platform_user_rule_compliance).
 * Emits JSON report listing committed code that breaks the global-platform invariant.
 *
 *   node backend/scripts/compliance-scan.js              # stdout
 *   node backend/scripts/compliance-scan.js -o file.json # write to file
 *   node backend/scripts/compliance-scan.js --root <dir> # scan a different root
 */

const fs = require('fs');
const path = require('path');

const HANKS_DEVICE_ID = '480def4c-2183-4d8e-afd0-b131ae89adcc';
const HANKS_EMAIL = 'twopiggyhavefun@gmail.com';

const SKIP_DIRS = new Set([
    '.git', 'node_modules', 'dist', 'build', 'coverage',
    '.next', '.cache', '.turbo', 'out',
    '.worktrees', 'Pods',
]);

const SCAN_EXT = new Set([
    '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
    '.kt', '.java', '.swift', '.py', '.sh',
    '.html', '.css', '.yml', '.yaml',
]);

function isExempt(relPath) {
    const p = '/' + relPath.replace(/\\/g, '/');
    if (/\/tests?\//.test(p)) return true;
    if (/\/__tests__\//.test(p)) return true;
    if (/\.(test|spec)\.(js|ts|jsx|tsx|kt|java|py)$/.test(p)) return true;
    if (/\bjest\.config\./.test(p)) return true;
    if (/\/scripts\/dev-only\//.test(p)) return true;
    if (/\/docs\//.test(p)) return true;
    if (p === '/backend/scripts/compliance-scan.js') return true;
    if (p.endsWith('.test.json') || p.endsWith('.fixture.json')) return true;
    return false;
}

const RULES = [
    {
        id: 'hardcoded-device-id',
        description: "Hank's deviceId literal in committed code (single-tenant gate)",
        regex: new RegExp(HANKS_DEVICE_ID.replace(/-/g, '-'), 'g'),
    },
    {
        id: 'hardcoded-entity-id',
        description: "Hardcoded entityId comparison/literal in shared code path",
        regex: /\bentityId\s*(?:===?|!==?|:)\s*(\d+)\b/g,
        accept: (match) => {
            const n = Number(match[1]);
            return n > 0 && n < 100;
        },
    },
    {
        id: 'hardcoded-hank-path',
        description: "Filesystem path under /Users/hank/ in committed code",
        regex: /\/Users\/hank\//g,
    },
    {
        id: 'email-gate',
        description: "Conditional gate using Hank's personal email",
        regex: new RegExp(HANKS_EMAIL.replace(/[.@]/g, '\\$&'), 'gi'),
    },
    {
        id: 'non-eclawbot-prod-url',
        description: "Non-eclawbot.com production URL hardcoded (private-tenant carveout)",
        regex: /https?:\/\/(?!eclawbot\.com|localhost|127\.0\.0\.1|0\.0\.0\.0|example\.|github\.com|raw\.githubusercontent\.com|api\.github\.com|railway\.app|claude\.ai|anthropic\.com|google\.com|googleapis\.com|gstatic\.com|cdn\.|fonts\.|w3\.org|developer\.mozilla\.org|stackoverflow\.com|npmjs\.com|nodejs\.org)[a-z0-9.-]+\.[a-z]{2,}/gi,
        allowSubstrings: [
            'twopiggyhavefun-blog',
        ],
    },
];

function walk(root, relRoot = '', out = []) {
    let entries;
    try {
        entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
        return out;
    }
    for (const ent of entries) {
        const full = path.join(root, ent.name);
        const rel = relRoot ? `${relRoot}/${ent.name}` : ent.name;
        if (ent.isDirectory()) {
            if (SKIP_DIRS.has(ent.name)) continue;
            walk(full, rel, out);
        } else if (ent.isFile()) {
            const ext = path.extname(ent.name).toLowerCase();
            if (!SCAN_EXT.has(ext)) continue;
            out.push({ full, rel });
        }
    }
    return out;
}

function scanFile(full, rel, violations) {
    let text;
    try {
        text = fs.readFileSync(full, 'utf8');
    } catch {
        return;
    }
    if (text.length > 5 * 1024 * 1024) return;
    const lines = text.split('\n');

    for (const rule of RULES) {
        rule.regex.lastIndex = 0;
        let m;
        while ((m = rule.regex.exec(text)) !== null) {
            if (rule.accept && !rule.accept(m)) continue;
            const offset = m.index;
            let lineNo = 1;
            let acc = 0;
            for (let i = 0; i < lines.length; i++) {
                if (acc + lines[i].length >= offset) {
                    lineNo = i + 1;
                    break;
                }
                acc += lines[i].length + 1;
            }
            const snippet = lines[lineNo - 1].trim().slice(0, 160);
            if (rule.allowSubstrings && rule.allowSubstrings.some(s => snippet.includes(s))) continue;
            violations.push({ file: rel, line: lineNo, rule: rule.id, snippet });
        }
    }
}

function summarize(violations) {
    const by_rule = {};
    for (const v of violations) by_rule[v.rule] = (by_rule[v.rule] || 0) + 1;
    return { by_rule, total: violations.length };
}

function parseArgs(argv) {
    const out = { output: null, root: process.cwd() };
    for (let i = 2; i < argv.length; i++) {
        if (argv[i] === '-o' || argv[i] === '--output') {
            out.output = argv[++i];
        } else if (argv[i] === '--root') {
            out.root = argv[++i];
        }
    }
    return out;
}

function main() {
    const { output, root } = parseArgs(process.argv);
    const files = walk(root);
    const violations = [];
    for (const { full, rel } of files) {
        if (isExempt(rel)) continue;
        scanFile(full, rel, violations);
    }
    const report = {
        scanned_at: new Date().toISOString().slice(0, 10),
        root: path.relative(process.cwd(), root) || '.',
        files_scanned: files.length,
        violations,
        summary: summarize(violations),
    };
    const json = JSON.stringify(report, null, 2);
    if (output) {
        fs.writeFileSync(output, json + '\n');
        console.log(`Wrote ${violations.length} violations across ${Object.keys(report.summary.by_rule).length} rules to ${output}`);
    } else {
        process.stdout.write(json + '\n');
    }
}

if (require.main === module) main();

module.exports = { RULES, scanFile, summarize, isExempt, HANKS_DEVICE_ID, HANKS_EMAIL };
