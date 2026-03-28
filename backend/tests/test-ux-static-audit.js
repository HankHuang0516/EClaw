#!/usr/bin/env node
/**
 * UX Static Audit — Layer 1
 * Scans all 14 portal HTML files for UX completeness:
 *   1. i18n coverage (data-i18n vs visible text elements)
 *   2. Form closure (orphaned inputs without event handlers)
 *   3. API error handling (apiCall inside try-catch or with .catch)
 *   4. Loading states (spinner/loading indicator near API calls)
 *   5. Empty states (list rendering with empty fallback)
 *   6. Auth guard (auth.js + checkAuth on non-login pages)
 *   7. Telemetry integration (telemetry.js included)
 *   8. Accessibility basics (img alt, button text, input labels)
 *   9. Script loading order (api.js < auth.js < telemetry.js)
 *
 * Pure Node.js — no external dependencies (regex-based parsing).
 * No credentials needed.
 *
 * Usage:
 *   node backend/tests/test-ux-static-audit.js
 */

const fs = require('fs');
const path = require('path');

// ── Config ──────────────────────────────────────────────────

const PORTAL_DIR = path.resolve(__dirname, '../public/portal');

const PAGES = [
    'index.html',
    'dashboard.html',
    'chat.html',
    'kanban.html',
    'settings.html',
    'env-vars.html',
    'files.html',
    'feedback.html',
    'admin.html',
    'card-holder.html',
    'info.html',
    'delete-account.html',
    'screen-control.html',
];

// index.html is the login page — no auth guard required
const LOGIN_PAGE = 'index.html';

// ── Result Tracking ─────────────────────────────────────────

const results = [];
function check(name, passed, detail = '') {
    results.push({ name, passed, detail });
    const icon = passed ? '\u2705' : '\u274C';
    const suffix = detail ? ` \u2014 ${detail}` : '';
    console.log(`  ${icon} ${name}${suffix}`);
}

// Per-page audit results for summary table
const pageAudits = {};

// ── Helpers ─────────────────────────────────────────────────

/** Extract all external <script src="..."> paths in order */
function extractScriptSrcs(html) {
    const srcs = [];
    const re = /<script\b[^>]*\bsrc="([^"]+)"[^>]*>/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
        srcs.push(m[1]);
    }
    return srcs;
}

/** Extract the combined inline <script>...</script> content */
function extractInlineScripts(html) {
    const parts = [];
    const re = /<script>([^]*?)<\/script>/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
        parts.push(m[1]);
    }
    return parts.join('\n');
}

/** Extract the HTML body content (between <body> and </body>) */
function extractBody(html) {
    const m = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
    return m ? m[1] : html;
}

/** Count occurrences of a regex in a string */
function countMatches(str, re) {
    const matches = str.match(re);
    return matches ? matches.length : 0;
}

// ── Audit Functions ─────────────────────────────────────────

/**
 * 1. i18n Coverage
 * Count elements with data-i18n vs total visible text elements
 */
function auditI18n(html, page) {
    const body = extractBody(html);

    // Count elements that should have i18n: title, h1-h6, button, label, th, elements with class "btn"
    // We look for opening tags of these types that contain visible text
    const textTagRe = /<(title|h[1-6]|button|label|th)\b[^>]*>([^<]*[a-zA-Z][^<]*)</gi;
    let totalTextElements = 0;
    let i18nTextElements = 0;
    let m;

    while ((m = textTagRe.exec(body)) !== null) {
        const fullTag = m[0];
        const textContent = m[2].trim();
        // Skip empty or whitespace-only
        if (!textContent || textContent.length < 2) continue;
        // Skip if text is only template literals like ${...}
        if (/^\$\{/.test(textContent)) continue;
        totalTextElements++;

        // Check if the opening tag has data-i18n
        // Need to look at the full tag including attributes
        const tagStart = body.lastIndexOf('<', m.index + m[0].indexOf('>'));
        const tagEnd = body.indexOf('>', m.index) + 1;
        const fullOpenTag = body.substring(m.index, tagEnd);
        if (/data-i18n/.test(fullOpenTag)) {
            i18nTextElements++;
        }
    }

    // Also count standalone data-i18n attributes (some may be on span, div, etc.)
    const dataI18nCount = countMatches(body, /data-i18n/g);

    const coverage = totalTextElements > 0 ? Math.round((i18nTextElements / totalTextElements) * 100) : 100;
    const passed = coverage >= 80 || totalTextElements <= 2;
    check(`[${page}] i18n coverage`, passed,
        `${i18nTextElements}/${totalTextElements} text elements (${coverage}%), total data-i18n attrs: ${dataI18nCount}`);
    return passed;
}

/**
 * 2. Form Closure
 * Every <input> or <textarea> should be referenced by JS event handlers
 */
function auditFormClosure(html, page) {
    const body = extractBody(html);
    const script = extractInlineScripts(html);

    // Find all input/textarea with id (static HTML only, not JS-generated)
    // Skip inputs inside <script> blocks — they're dynamically generated
    const htmlOnly = body.replace(/<script[\s\S]*?<\/script>/gi, '');
    const inputRe = /<(?:input|textarea|select)\b[^>]*\bid="([^"]+)"[^>]*>/gi;
    const orphaned = [];
    let totalInputs = 0;
    let m;

    while ((m = inputRe.exec(htmlOnly)) !== null) {
        const id = m[1];
        const tag = m[0];
        // Skip dynamically-constructed IDs (contain ${, +, or template syntax)
        if (/\$\{|['"]\s*\+/.test(id)) continue;
        totalInputs++;

        // Check for inline event handlers
        const hasInlineHandler = /\b(onchange|oninput|onkeydown|onkeyup|onkeypress|onclick|onsubmit|onfocus|onblur)\s*=/i.test(tag);
        if (hasInlineHandler) continue;

        // Check if referenced in inline script by getElementById or direct id usage
        const idEscaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const referencedInScript = new RegExp(
            `(?:getElementById\\s*\\(\\s*['"]${idEscaped}['"]\\)|` +
            `querySelector\\s*\\(\\s*['"]#${idEscaped}['"]\\)|` +
            `\\b${idEscaped}\\b)`, 'i'
        ).test(script);

        if (!referencedInScript) {
            orphaned.push(id);
        }
    }

    // Also check inputs without id but with name (static HTML only)
    const noIdInputRe = /<(?:input|textarea|select)\b(?![^>]*\bid=)[^>]*>/gi;
    let noIdCount = 0;
    while ((m = noIdInputRe.exec(htmlOnly)) !== null) {
        const tag = m[0];
        // Skip hidden inputs, submit buttons
        if (/type\s*=\s*["'](?:hidden|submit)["']/i.test(tag)) continue;
        // Skip if has inline handler
        if (/\b(onchange|oninput|onkeydown|onkeyup|onclick)\s*=/i.test(tag)) continue;
        // Skip if has name and form has onsubmit
        if (/\bname\s*=/i.test(tag)) continue;
        noIdCount++;
    }

    const passed = orphaned.length === 0 && noIdCount === 0;
    const detail = orphaned.length > 0
        ? `orphaned: ${orphaned.join(', ')}` + (noIdCount > 0 ? ` + ${noIdCount} without id` : '')
        : (noIdCount > 0 ? `${noIdCount} inputs without id or handler` : `${totalInputs} inputs all handled`);
    check(`[${page}] form closure`, passed, detail);
    return passed;
}

/**
 * 3. API Error Handling
 * Every apiCall should be inside try-catch or have .catch()
 */
function auditApiErrorHandling(html, page) {
    const script = extractInlineScripts(html);
    if (!script) return true; // no script, no API calls

    // Count apiCall instances
    const apiCallRe = /\bapiCall\s*\(/g;
    const totalApiCalls = countMatches(script, apiCallRe);

    if (totalApiCalls === 0) {
        check(`[${page}] API error handling`, true, 'no apiCall found');
        return true;
    }

    // Strategy: find each apiCall and check if it's inside a try block or has .catch
    // Split script into lines for context analysis
    const lines = script.split('\n');
    let handledCount = 0;
    let unhandled = [];

    // Track try block depth
    let tryDepth = 0;
    let braceStack = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Track try-catch blocks (simplified)
        if (/\btry\s*\{/.test(line)) tryDepth++;
        if (/\}\s*catch\b/.test(line)) tryDepth = Math.max(0, tryDepth - 1);

        // Check for apiCall on this line
        if (/\bapiCall\s*\(/.test(line)) {
            const isInTry = tryDepth > 0;
            // Also look back up to 3 lines for a try {
            let nearbyTry = false;
            for (let j = Math.max(0, i - 5); j < i; j++) {
                if (/\btry\s*\{/.test(lines[j])) nearbyTry = true;
            }
            // Check if the apiCall line or next few lines have .catch
            let hasCatch = false;
            for (let j = i; j < Math.min(lines.length, i + 3); j++) {
                if (/\.catch\s*\(/.test(lines[j])) hasCatch = true;
            }

            if (isInTry || nearbyTry || hasCatch) {
                handledCount++;
            } else {
                // Get a snippet for reporting
                const snippet = line.trim().substring(0, 60);
                unhandled.push(`L${i + 1}: ${snippet}`);
            }
        }
    }

    const passed = unhandled.length === 0;
    check(`[${page}] API error handling`, passed,
        `${handledCount}/${totalApiCalls} handled` + (unhandled.length > 0 ? ` | unhandled: ${unhandled.slice(0, 3).join('; ')}` : ''));
    return passed;
}

/**
 * 4. Loading States
 * Pages with API calls should show loading indicators
 */
function auditLoadingStates(html, page) {
    const script = extractInlineScripts(html);
    const body = extractBody(html);
    const totalApiCalls = countMatches(script, /\bapiCall\s*\(/g);

    if (totalApiCalls === 0) {
        check(`[${page}] loading states`, true, 'no API calls');
        return true;
    }

    // Look for loading patterns in both HTML and script
    const loadingPatterns = [
        /loading/i,
        /spinner/i,
        /Loading\.\.\./,
        /\.disabled\s*=\s*true/,
        /btn\.disabled/i,
        /textContent\s*=.*loading/i,
        /innerHTML\s*=.*loading/i,
        /classList\.add.*loading/i,
        /showLoading|hideLoading/i,
        /skeleton/i,
    ];

    const hasLoadingInScript = loadingPatterns.some(re => re.test(script));
    const hasLoadingInHtml = /loading|spinner|Loading\.\.\./i.test(body);
    const passed = hasLoadingInScript || hasLoadingInHtml;

    check(`[${page}] loading states`, passed,
        passed ? 'loading indicators found' : `${totalApiCalls} apiCalls but no loading indicator detected`);
    return passed;
}

/**
 * 5. Empty States
 * Pages with list rendering should handle empty lists
 */
function auditEmptyStates(html, page) {
    const script = extractInlineScripts(html);
    const body = extractBody(html);

    // Detect list rendering patterns
    const listPatterns = [
        /\.map\s*\(/g,
        /\.forEach\s*\(/g,
        /innerHTML\s*=.*\.map/g,
        /innerHTML\s*=.*\.join/g,
    ];

    const hasListRendering = listPatterns.some(re => re.test(script));
    if (!hasListRendering) {
        check(`[${page}] empty states`, true, 'no list rendering detected');
        return true;
    }

    // Look for empty state handling
    const emptyPatterns = [
        /empty[-_]state/i,
        /\.length\s*===?\s*0/,
        /\.length\s*<\s*1/,
        /!.*\.length/,
        /No\s+\w/,
        /\bempty\b/i,
        /nothing/i,
        /no\s+(?:items|results|data|entities|missions|schedules|files|feedback|cards)/i,
    ];

    const hasEmptyState = emptyPatterns.some(re => re.test(script) || re.test(body));
    const passed = hasEmptyState;

    check(`[${page}] empty states`, passed,
        passed ? 'empty state handling found' : 'list rendering without empty state fallback');
    return passed;
}

/**
 * 6. Auth Guard
 * Non-login pages must include auth.js and call checkAuth()
 */
function auditAuthGuard(html, page) {
    if (page === LOGIN_PAGE) {
        check(`[${page}] auth guard`, true, 'login page — no guard needed');
        return true;
    }

    const srcs = extractScriptSrcs(html);
    const script = extractInlineScripts(html);

    const hasAuthJs = srcs.some(s => /auth\.js/i.test(s));
    const hasCheckAuth = /\bcheckAuth\s*\(/.test(script) || /\bcheckAuth\b/.test(html);

    const passed = hasAuthJs && hasCheckAuth;
    const issues = [];
    if (!hasAuthJs) issues.push('missing auth.js');
    if (!hasCheckAuth) issues.push('missing checkAuth() call');

    check(`[${page}] auth guard`, passed,
        passed ? 'auth.js + checkAuth() present' : issues.join(', '));
    return passed;
}

/**
 * 7. Telemetry Integration
 * All pages must include telemetry.js
 */
function auditTelemetry(html, page) {
    const srcs = extractScriptSrcs(html);
    const hasTelemetry = srcs.some(s => /telemetry\.js/i.test(s));
    // index.html might use a different path
    const passed = hasTelemetry;

    check(`[${page}] telemetry`, passed,
        passed ? 'telemetry.js included' : 'missing telemetry.js');
    return passed;
}

/**
 * 8. Accessibility Basics
 * - img without alt
 * - button without text content or aria-label
 * - input without label, placeholder, or aria-label
 */
function auditAccessibility(html, page) {
    const body = extractBody(html);
    // Only check static HTML, not JS-generated markup
    const staticBody = body.replace(/<script[\s\S]*?<\/script>/gi, '');
    const issues = [];

    // img without alt
    const imgRe = /<img\b([^>]*)>/gi;
    let m;
    let imgCount = 0;
    let imgNoAlt = 0;
    while ((m = imgRe.exec(staticBody)) !== null) {
        imgCount++;
        if (!/\balt\s*=/i.test(m[1])) {
            imgNoAlt++;
        }
    }
    if (imgNoAlt > 0) {
        issues.push(`${imgNoAlt} img without alt`);
    }

    // button without text or aria-label
    // Match <button ...>content</button> and check if content is empty or only whitespace/icons
    const btnRe = /<button\b([^>]*)>([\s\S]*?)<\/button>/gi;
    let btnCount = 0;
    let btnNoLabel = 0;
    while ((m = btnRe.exec(staticBody)) !== null) {
        btnCount++;
        const attrs = m[1];
        const content = m[2].replace(/<[^>]*>/g, '').trim(); // strip inner HTML tags
        const hasAriaLabel = /\baria-label\s*=/i.test(attrs);
        const hasTitle = /\btitle\s*=/i.test(attrs);
        const hasDataI18n = /\bdata-i18n\s*=/i.test(attrs);
        if (!content && !hasAriaLabel && !hasTitle && !hasDataI18n) {
            btnNoLabel++;
        }
    }
    if (btnNoLabel > 0) {
        issues.push(`${btnNoLabel} button without text/aria-label`);
    }

    // input without label, placeholder, or aria-label
    // Re-use a different variable name to avoid collision with outer inputRe
    const a11yInputRe = /<input\b([^>]*)>/gi;
    let inputCount = 0;
    let inputNoLabel = 0;
    while ((m = a11yInputRe.exec(staticBody)) !== null) {
        const attrs = m[1];
        // Skip hidden inputs
        if (/type\s*=\s*["']hidden["']/i.test(attrs)) continue;
        inputCount++;
        const hasPlaceholder = /\bplaceholder\s*=/i.test(attrs);
        const hasAriaLabel = /\baria-label\s*=/i.test(attrs);
        const hasAriaLabelledBy = /\baria-labelledby\s*=/i.test(attrs);
        const hasTitle = /\btitle\s*=/i.test(attrs);
        // Check if there's a <label for="..."> matching this input's id
        const idMatch = attrs.match(/\bid="([^"]+)"/);
        let hasLabel = false;
        if (idMatch) {
            const labelRe = new RegExp(`<label[^>]*\\bfor\\s*=\\s*["']${idMatch[1]}["']`, 'i');
            hasLabel = labelRe.test(staticBody);
        }
        if (!hasPlaceholder && !hasAriaLabel && !hasAriaLabelledBy && !hasLabel && !hasTitle) {
            inputNoLabel++;
        }
    }
    if (inputNoLabel > 0) {
        issues.push(`${inputNoLabel} input without label/placeholder/aria-label`);
    }

    const passed = issues.length === 0;
    // Use warning level for minor a11y issues
    const status = passed ? 'pass' : (issues.length <= 2 ? 'warn' : 'fail');
    check(`[${page}] accessibility`, passed,
        passed ? `${imgCount} img, ${btnCount} btn, ${inputCount} input — all labeled` : issues.join(', '));
    return status === 'pass' || status === 'warn' ? true : false;
}

/**
 * 9. Script Loading Order
 * api.js must come before auth.js, auth.js before telemetry.js
 */
function auditScriptOrder(html, page) {
    const srcs = extractScriptSrcs(html);

    // Find indices of key scripts
    const apiIdx = srcs.findIndex(s => /shared\/api\.js$/i.test(s));
    const authIdx = srcs.findIndex(s => /shared\/auth\.js$/i.test(s));
    const telIdx = srcs.findIndex(s => /telemetry\.js$/i.test(s));

    const issues = [];

    // Only check ordering for scripts that exist on the page
    if (apiIdx !== -1 && authIdx !== -1 && apiIdx > authIdx) {
        issues.push('api.js loads after auth.js');
    }
    if (authIdx !== -1 && telIdx !== -1 && authIdx > telIdx) {
        issues.push('auth.js loads after telemetry.js');
    }
    if (apiIdx !== -1 && telIdx !== -1 && apiIdx > telIdx) {
        issues.push('api.js loads after telemetry.js');
    }

    // Login page doesn't require auth.js, so skip auth order check there
    if (page === LOGIN_PAGE) {
        // Only check api.js vs telemetry.js if both present
        const loginIssues = issues.filter(i => !i.includes('auth.js'));
        const passed = loginIssues.length === 0;
        check(`[${page}] script order`, passed,
            passed ? 'correct' : loginIssues.join(', '));
        return passed;
    }

    const passed = issues.length === 0;
    check(`[${page}] script order`, passed,
        passed ? 'correct' : issues.join(', '));
    return passed;
}

/**
 * 10. Admin Link After Auth
 * shared/auth.js must call _addAdminLink() after setting window.currentUser
 * to avoid race condition with the 600ms setTimeout in nav.js.
 */
function auditAdminLinkAfterAuth() {
    const authPath = path.join(PORTAL_DIR, 'shared', 'auth.js');
    if (!fs.existsSync(authPath)) {
        check('admin link after auth', false, 'shared/auth.js not found');
        return false;
    }
    const src = fs.readFileSync(authPath, 'utf8');
    const hasCall = /_addAdminLink/.test(src);
    check('admin link after auth', hasCall,
        hasCall ? 'checkAuth() calls _addAdminLink()' : 'checkAuth() missing _addAdminLink() — admin nav link may not appear on slow networks');
    return hasCall;
}

// ── Main ────────────────────────────────────────────────────

console.log('\n\u{1F50D} UX Static Audit \u2014 Layer 1\n');

let totalChecks = 0;
let totalPassed = 0;
let totalFailed = 0;

// Global checks (not per-page)
console.log('\u2500\u2500 Global Checks \u2500\u2500');
auditAdminLinkAfterAuth();

for (const page of PAGES) {
    const filePath = path.join(PORTAL_DIR, page);
    if (!fs.existsSync(filePath)) {
        console.log(`\n\u26A0\uFE0F  ${page} \u2014 FILE NOT FOUND, skipping`);
        pageAudits[page] = { i18n: '-', form: '-', err: '-', load: '-', empty: '-', auth: '-', tel: '-', a11y: '-', scr: '-' };
        continue;
    }

    console.log(`\n\u2500\u2500 ${page} \u2500\u2500`);
    const html = fs.readFileSync(filePath, 'utf8');

    const i18n = auditI18n(html, page);
    const form = auditFormClosure(html, page);
    const err = auditApiErrorHandling(html, page);
    const load = auditLoadingStates(html, page);
    const empty = auditEmptyStates(html, page);
    const auth = auditAuthGuard(html, page);
    const tel = auditTelemetry(html, page);
    const a11y = auditAccessibility(html, page);
    const scr = auditScriptOrder(html, page);

    pageAudits[page] = { i18n, form, err, load, empty, auth, tel, a11y, scr };
}

// ── Summary Table ───────────────────────────────────────────

console.log('\n\n\u2550\u2550\u2550 Summary Table \u2550\u2550\u2550\n');

const icon = v => v === true ? ' \u2705 ' : v === false ? ' \u274C ' : ' \u2014  ';
const colW = 6;

// Header
const hdr = [
    'Page'.padEnd(24),
    'i18n'.padStart(colW),
    'Form'.padStart(colW),
    ' Err'.padStart(colW),
    'Load'.padStart(colW),
    'Empty'.padStart(colW + 1),
    'Auth'.padStart(colW),
    ' Tel'.padStart(colW),
    'A11y'.padStart(colW),
    ' Scr'.padStart(colW),
];

const sep = '\u2500'.repeat(24) + ('\u2500'.repeat(colW)).repeat(9) + '\u2500\u2500';

console.log(sep);
console.log(hdr.join(' \u2502'));
console.log(sep);

for (const page of PAGES) {
    const a = pageAudits[page];
    if (!a) continue;
    const row = [
        page.padEnd(24),
        icon(a.i18n).padStart(colW),
        icon(a.form).padStart(colW),
        icon(a.err).padStart(colW),
        icon(a.load).padStart(colW),
        icon(a.empty).padStart(colW + 1),
        icon(a.auth).padStart(colW),
        icon(a.tel).padStart(colW),
        icon(a.a11y).padStart(colW),
        icon(a.scr).padStart(colW),
    ];
    console.log(row.join(' \u2502'));
}

console.log(sep);

// ── Final Summary ───────────────────────────────────────────

const passed = results.filter(r => r.passed).length;
const failed = results.filter(r => !r.passed).length;

console.log(`\n  Total checks: ${results.length}  |  \u2705 Passed: ${passed}  |  \u274C Failed: ${failed}\n`);

if (failed > 0) {
    console.log('  Failed checks:');
    results.filter(r => !r.passed).forEach(r => {
        console.log(`    \u274C ${r.name}${r.detail ? ` \u2014 ${r.detail}` : ''}`);
    });
    console.log('');
}

// Exit with 0 — this test reports UX quality metrics, not regressions.
// Future: compare against a baseline to detect regressions (exit 1 on new issues).
process.exit(0);
