/**
 * Portal repo-rename + dash-tab a11y guard.
 *
 * The GitHub repo was renamed from `HankHuang0516/realbot` → `HankHuang0516/EClaw`
 * on 2026-04 (found via Wed E2E drill — card_e0f6677c3aae97470691d92e).
 * GitHub still 301-redirects the old slug, but every live link, env fallback
 * and doc reference should point to the canonical slug directly.
 *
 * This test also guards the dashboard tab a11y regression the drill caught:
 * the `.dash-tab` buttons must expose `role="tab"` + `aria-selected=true/false`
 * so screen readers can report which tab is active.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');

// Files that SHOULD NOT contain the old slug.
const STALE_SLUG = 'HankHuang0516/realbot';

// Skip historical / vendored / build output.
const EXCLUDE_RE = /(^|\/)(node_modules|\.git|coverage|dist|build|CHANGELOG\.md|tests\/jest\/portal-repo-rename\.test\.js)(\/|$)/;

function walk(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        const rel = path.relative(ROOT, full);
        if (EXCLUDE_RE.test(rel)) continue;
        if (entry.isDirectory()) walk(full, out);
        else if (/\.(js|html|json|md|example|env|ts|tsx|mjs|cjs)$/i.test(entry.name)) out.push(full);
    }
    return out;
}

describe('Portal repo-rename (HankHuang0516/realbot → EClaw)', () => {
    test('no live source file references the old repo slug', () => {
        const files = walk(ROOT);
        const offenders = [];
        for (const f of files) {
            const content = fs.readFileSync(f, 'utf8');
            if (content.includes(STALE_SLUG)) {
                offenders.push(path.relative(ROOT, f));
            }
        }
        if (offenders.length > 0) {
            throw new Error(
                `Found ${offenders.length} file(s) still referencing ${STALE_SLUG}:\n  ` +
                offenders.join('\n  ') +
                `\n→ Replace with HankHuang0516/EClaw. Add the file to EXCLUDE_RE only if genuinely historical (e.g. CHANGELOG).`
            );
        }
        expect(offenders).toEqual([]);
    });
});

describe('Dashboard tab a11y (#card_e0f6677c)', () => {
    const dashboardHtml = fs.readFileSync(path.join(ROOT, 'public/portal/dashboard.html'), 'utf8');

    test('tab container has role="tablist"', () => {
        expect(dashboardHtml).toMatch(/class="dash-tabs"[^>]*role="tablist"|role="tablist"[^>]*class="dash-tabs"/);
    });

    test('both tabs declare role="tab" + aria-selected', () => {
        // Entities tab — initial active
        expect(dashboardHtml).toMatch(/class="dash-tab active"[^>]*data-tab="entities"[^>]*role="tab"[^>]*aria-selected="true"/);
        // Org chart tab — initial inactive
        expect(dashboardHtml).toMatch(/class="dash-tab"[^>]*data-tab="orgchart"[^>]*role="tab"[^>]*aria-selected="false"/);
    });

    test('switchDashTab handler toggles aria-selected in lockstep with .active class', () => {
        // Find the handler body
        const handlerStart = dashboardHtml.indexOf('function switchDashTab(');
        expect(handlerStart).toBeGreaterThan(-1);
        const handlerBody = dashboardHtml.substring(handlerStart, handlerStart + 800);

        // Must toggle both the active class AND aria-selected for each tab.
        expect(handlerBody).toMatch(/classList\.toggle\(\s*['"]active['"]/);
        expect(handlerBody).toMatch(/setAttribute\(\s*['"]aria-selected['"]/);
    });
});
