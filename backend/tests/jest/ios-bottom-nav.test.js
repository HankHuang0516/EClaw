const fs = require('fs');
const path = require('path');

// Regression for Issue #1769 — bottom nav cramped in CJK locales.
// The static guard below proves three invariants in
// ios-app/app/(tabs)/_layout.tsx:
//   1. A custom TabLabel component exists.
//   2. The label returns null when !focused (so inactive tabs are icon-only,
//      giving the 5 icons enough breathing room on iPhone 17 Pro width).
//   3. The active label uses numberOfLines=1 + adjustsFontSizeToFit so the
//      3-character CJK tab name ("任務", "名片夾") never truncates.

describe('iOS bottom nav icon-only layout (#1769)', () => {
    const layoutPath = path.join(
        __dirname,
        '..',
        '..',
        '..',
        'ios-app',
        'app',
        '(tabs)',
        '_layout.tsx'
    );
    let source = '';

    beforeAll(() => {
        source = fs.readFileSync(layoutPath, 'utf8');
    });

    test('(tabs)/_layout.tsx exists', () => {
        expect(fs.existsSync(layoutPath)).toBe(true);
    });

    test('TabLabel component is declared', () => {
        expect(source).toMatch(/function\s+TabLabel\s*\(/);
    });

    test('TabLabel returns null when !focused', () => {
        // Matches `if (!focused) return null;` (whitespace-flexible).
        expect(source).toMatch(/if\s*\(\s*!\s*focused\s*\)\s*return\s+null/);
    });

    test('active label has numberOfLines=1 and adjustsFontSizeToFit', () => {
        expect(source).toMatch(/numberOfLines=\{1\}/);
        expect(source).toMatch(/adjustsFontSizeToFit/);
    });

    test('all 5 tabs wire tabBarLabel through TabLabel', () => {
        const matches = source.match(/tabBarLabel:\s*\(\s*\{[^}]*\}\s*\)\s*=>\s*\(\s*<TabLabel/g) || [];
        expect(matches.length).toBe(5);
    });
});
