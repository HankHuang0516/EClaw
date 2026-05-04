/**
 * Regression coverage for the Info → User Guide mobile layout.
 * On 390px screens the guide must not expose a clipped horizontal sidebar
 * followed by every feature card, Why EClaw slide card, and demo card as one
 * long vertical wall.
 */

const fs = require('fs');
const path = require('path');

const INFO_HTML = path.resolve(__dirname, '../../public/portal/info.html');
const INFO_CSS = path.resolve(__dirname, '../../public/portal/shared/info.css');
const INFO_JS = path.resolve(__dirname, '../../public/portal/shared/info.js');
const INDEX_JS = path.resolve(__dirname, '../../index.js');

describe('Info guide mobile compact navigation', () => {
    const html = fs.readFileSync(INFO_HTML, 'utf8');
    const css = fs.readFileSync(INFO_CSS, 'utf8');
    const js = fs.readFileSync(INFO_JS, 'utf8');

    test('keeps guide content routed through one active panel at a time', () => {
        expect(css).toMatch(/\.guide-panel\s*\{\s*display:\s*none;\s*\}/);
        expect(css).toMatch(/\.guide-panel\.active\s*\{\s*display:\s*block;\s*\}/);
        expect(js).toContain('guidePanels.forEach(p => p.classList.remove(\'active\'))');
        expect(js).toContain("const panel = document.getElementById('guide-' + tabId)");
    });

    test('replaces the clipped mobile sidebar rail with a select picker', () => {
        expect(js).toContain('buildGuideMobilePicker');
        expect(js).toContain('guide-mobile-picker');
        expect(js).toContain('guide-mobile-select');
        expect(css).toMatch(/#panel-guide\s+#guideSidebarUG\s*\{[\s\S]*display:\s*none/);
        expect(css).toMatch(/#panel-guide\s+\.guide-mobile-picker\s*\{[\s\S]*display:\s*grid/);
    });

    test('converts dense feature, slide, and demo groups into swipe carousels on mobile', () => {
        expect(css).toMatch(/#panel-guide\s+\.guide-content\s+\.feat-grid[\s\S]*overflow-x:\s*auto/);
        expect(css).toMatch(/#panel-guide\s+\.guide-content\s+\.feat-grid[\s\S]*scroll-snap-type:\s*x\s+mandatory/);
        expect(css).toMatch(/#panel-guide\s+\.guide-content\s+\.demo-showcase[\s\S]*overflow-x:\s*auto/);
        expect(css).toMatch(/#panel-guide\s+\.guide-content\s+\.feat-grid\s*>\s+\.feat-card[\s\S]*scroll-snap-align:\s*start/);
        expect(html.match(/info-why-eclaw-b\d+-[^"']+\.html/g)).toHaveLength(11);
    });
});

describe('info-guide-mobile-layout debug endpoint registration', () => {
    test('backend exposes an authenticated temporary debug endpoint for guide mobile verification', () => {
        const source = fs.readFileSync(INDEX_JS, 'utf8');
        expect(source).toMatch(/app\.get\(['"]\/api\/debug\/info-guide-mobile-layout['"]/);
        expect(source).toMatch(/mobilePickerJsPresent/);
        expect(source).toMatch(/featureCardsUseCarousel/);
        expect(source).toMatch(/demoCardsUseCarousel/);
        expect(source).toMatch(/onlyActiveGuidePanelVisible/);
    });
});
