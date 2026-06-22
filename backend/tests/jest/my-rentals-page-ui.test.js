const fs = require('fs');
const path = require('path');

describe('my rentals page self-improvement UI', () => {
    const pagePath = path.join(__dirname, '../../public/portal/my-rentals.html');
    const html = fs.readFileSync(pagePath, 'utf8');

    test('renders accessible rental tabs and a live result summary panel', () => {
        expect(html).toContain('<div class="mr-tabs" role="tablist" aria-label="Rental views">');
        expect(html).toContain('id="tabRenter" role="tab" aria-selected="true" aria-controls="mrContent"');
        expect(html).toContain('id="tabOwner" role="tab" aria-selected="false" aria-controls="mrContent"');
        expect(html).toContain('id="mrContent" role="tabpanel" aria-labelledby="tabRenter"');
        expect(html).toContain('id="mrResultPanel" role="status" aria-live="polite" aria-atomic="true"');
        expect(html).toContain('id="mrResultSummary" data-i18n="mr_result_loading"');
        expect(html).toContain('id="mrRetryBtn" onclick="loadTab()" hidden data-i18n="mr_retry"');
    });

    test('keeps tab state and the panel label synchronized during tab switches', () => {
        expect(html).toContain("t.setAttribute('aria-selected', selected ? 'true' : 'false')");
        expect(html).toContain("content.setAttribute('aria-labelledby', TAB_BUTTONS[tab] || 'tabRenter')");
        expect(html).toContain("fillTemplate(tt('mr_result_loading_tab', 'Loading {label}'), { label: tt(meta.labelKey, meta.label) })");
        expect(html).toContain("fillTemplate(tt('mr_result_ready', 'Showing {count} {label}'), { count, label: tabResultLabel() })");
    });

    test('uses a translation fallback that does not expose raw missing keys', () => {
        expect(html).toContain("const value = (typeof i18n !== 'undefined' && i18n.t) ? i18n.t(k) : null;");
        expect(html).toContain('return value && value !== k ? value : fb;');
    });

    test('shows tab-specific empty guidance instead of generic empty text only', () => {
        expect(html).toContain("emptyDetailKey: 'mr_empty_renter_help'");
        expect(html).toContain("emptyDetailKey: 'mr_empty_owner_help'");
        expect(html).toContain("emptyDetailKey: 'mr_empty_listings_help'");
        expect(html).toContain("emptyDetailKey: 'mr_empty_disputes_help'");
        expect(html).toContain('function showEmptyState(titleKey, titleFallback, detailKey, detailFallback)');
        expect(html).toContain('class="mr-empty-title"');
        expect(html).toContain('class="mr-empty-detail"');
    });

    test('summarizes each loaded tab and exposes retry on load failure', () => {
        expect(html).toContain("tt('mr_result_meta_contracts', '{active} active · {suspended} suspended · {ended} ended')");
        expect(html).toContain("tt('mr_result_meta_listings', '{listed} listed · {paused} paused · {draft} draft')");
        expect(html).toContain("tt('mr_result_meta_disputes', '{open} open · {resolved} resolved · {rejected} rejected')");
        expect(html).toContain("tt('mr_load_error_help', 'The tab did not load. Check your connection or retry.')");
        expect(html).toContain('setResultPanel(');
        expect(html).toContain("'error',");
        expect(html).toContain('true');
    });
});
