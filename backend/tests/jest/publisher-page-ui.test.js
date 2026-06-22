const fs = require('fs');
const path = require('path');

describe('publisher page self-improvement UI', () => {
    const pagePath = path.join(__dirname, '../../public/portal/publisher.html');
    const html = fs.readFileSync(pagePath, 'utf8');

    test('init() guards checkAuth so an auth.js load failure cannot brick the page at Loading (card_8da798aa)', () => {
        // Intermittent 522 on shared/auth.js leaves checkAuth undefined; an
        // unguarded `await checkAuth()` throws and the page stays stuck on the
        // loading state. init() must guard the call and still reveal content.
        expect(html).toContain("if (typeof checkAuth === 'function')");
        expect(html).toContain('currentUser = await checkAuth();');
        // the guarded call is wrapped so a throw can't abort init()
        const init = html.slice(html.indexOf('async function init()'), html.indexOf('function hydrateApiKey()'));
        expect(init).toMatch(/try\s*\{[\s\S]*typeof checkAuth === 'function'[\s\S]*await checkAuth\(\)[\s\S]*\}\s*catch/);
        // render must still happen after the guarded auth block
        expect(init).toContain("document.getElementById('loadingState').style.display = 'none';");
        expect(init).toContain("document.getElementById('pageContent').style.display = 'block';");
    });

    test('renders a live platform result panel and filter controls', () => {
        expect(html).toContain('class="platform-result-panel" id="platformResultPanel" role="status" aria-live="polite" aria-atomic="true"');
        expect(html).toContain('id="platformResultSummary" data-i18n="pub_result_loading"');
        expect(html).toContain('id="platformResultMeta" data-i18n="pub_result_meta_idle"');
        expect(html).toContain('id="clearPlatformFilters" onclick="clearPlatformFilter()" data-i18n="pub_clear_filters" disabled');
        expect(html).toContain('class="platform-filters" role="group" aria-label="Publisher platform filters"');
        expect(html).toContain('data-platform-filter="ready" onclick="setPlatformFilter(\'ready\')" aria-pressed="false"');
        expect(html).toContain('data-platform-filter="compose" onclick="setPlatformFilter(\'compose\')" aria-pressed="false"');
    });

    test('keeps platform filter state, clear action, and result counts synchronized', () => {
        expect(html).toContain("let platformFilter = 'all';");
        expect(html).toContain('function getFilteredPlatforms()');
        expect(html).toContain("if (platformFilter === 'ready') return allPlatforms.filter(p => p.configured);");
        expect(html).toContain("if (platformFilter === 'unconfigured') return allPlatforms.filter(p => !p.configured);");
        expect(html).toContain("if (platformFilter === 'compose') return allPlatforms.filter(p => Boolean(SCHEMAS[p.id]));");
        expect(html).toContain('function syncPlatformFilterButtons()');
        expect(html).toContain("btn.setAttribute('aria-pressed', active ? 'true' : 'false');");
        expect(html).toContain("if (clear) clear.disabled = platformFilter === 'all';");
        expect(html).toContain('function clearPlatformFilter()');
        expect(html).toContain("i18n.t('pub_result_meta_counts', '{ready} ready · {unconfigured} need setup · {composeReady} compose forms')");
    });

    test('renders keyboard-accessible platform chips with selected state', () => {
        expect(html).toContain("return '<button type=\"button\" class=\"' + classes.join(' ') + '\" data-platform-id=\"' + esc(p.id) + '\"'");
        expect(html).toContain('aria-pressed="\' + (selected && selected.id === p.id ? \'true\' : \'false\') + \'"');
        expect(html).toContain('aria-label="\' + esc(p.name + \' \' + (p.configured ? i18n.t(\'pub_chip_ready\', \'ready\') : i18n.t(\'pub_chip_unconfigured\', \'unconfigured\'))) + \'"');
        expect(html).toContain("el.addEventListener('click', () => selectPlatform(el.dataset.platformId));");
        expect(html).toContain("if (!SCHEMAS[p.id]) extra.push('<div style=\"font-size:11px;color:var(--text-muted);\">' +");
    });

    test('updates the status panel for loading and load failure states', () => {
        expect(html).toContain('function setPlatformResult(summary, meta = \'\', state = \'ready\')');
        expect(html).toContain("if (panel) panel.dataset.state = state;");
        expect(html).toContain("i18n.t('pub_result_loading', 'Loading publisher platforms')");
        expect(html).toContain("i18n.t('pub_result_error', 'Platform list did not load.')");
        expect(html).toContain("'error'");
        expect(html).toContain("i18n.t('pub_no_filtered_platforms', 'No platforms match this filter.')");
    });
});
