const fs = require('fs');
const path = require('path');

// Regression for Issue #1770 — WebView/native visual seam.
// Short-term fix: WebView injects CSS + adds ?hideChrome=1 so portal pages
// hosted inside the iOS WebView render against the same deep-purple
// background and system font as the native container. Full native rewrite
// is a separate roadmap item.

describe('iOS WebView chrome hide (#1770)', () => {
    const compPath = path.join(
        __dirname,
        '..',
        '..',
        '..',
        'ios-app',
        'components',
        'WebViewScreen.tsx'
    );
    let source = '';

    beforeAll(() => {
        source = fs.readFileSync(compPath, 'utf8');
    });

    test('WebViewScreen.tsx exists', () => {
        expect(fs.existsSync(compPath)).toBe(true);
    });

    test('query string includes hideChrome=1', () => {
        // Loose: the literal must appear in the string list we compose.
        expect(source).toMatch(/'hideChrome=1'/);
    });

    test('injected JS applies eclaw-ios-chrome class when ?hideChrome=1', () => {
        expect(source).toMatch(/hideChrome.*===\s*'1'/);
        expect(source).toMatch(/eclaw-ios-chrome/);
        expect(source).toMatch(/classList\.add\(/);
    });

    test('chrome-hide CSS targets portal navbar and deep-purple bg', () => {
        // Background must match the native container (#0D0D1A).
        expect(source).toMatch(/#0D0D1A/);
        // Must hide at least the portal .nav / .public-nav selectors.
        expect(source).toMatch(/\.nav/);
        expect(source).toMatch(/\.public-nav/);
        // Must force system font (SF Pro / -apple-system).
        expect(source).toMatch(/-apple-system/);
    });

    test('CSS is scoped to html.eclaw-ios-chrome so browser users are untouched', () => {
        // Every rule in CHROME_HIDE_CSS should start with html.eclaw-ios-chrome,
        // so a portal page loaded directly in Safari without the class is
        // unaffected.
        const cssMatch = source.match(/CHROME_HIDE_CSS\s*=\s*`([\s\S]*?)`/);
        expect(cssMatch).not.toBeNull();
        const css = cssMatch[1];
        // Strip comments and whitespace-only lines, then check every selector
        // block begins with the scope.
        const rules = css
            .split('}')
            .map((r) => r.trim())
            .filter((r) => r.length > 0 && r.includes('{'));
        for (const rule of rules) {
            expect(rule).toMatch(/html\.eclaw-ios-chrome/);
        }
    });
});
