const fs = require('fs');
const path = require('path');

// Regression for Issue #1766 — production RN console error overlay.
// The iOS app (Expo Router) has no jest runner, so this static scan
// lives in the backend jest suite. It guards three invariants in
// ios-app/app/_layout.tsx:
//   1. LogBox.ignoreAllLogs() is called at module top-level.
//   2. A global handler is installed via ErrorUtils.setGlobalHandler.
//   3. The handler is gated behind `if (!__DEV__)` so dev keeps the
//      native red-box but production swallows uncaught errors.

describe('iOS production error overlay suppression (#1766)', () => {
    const layoutPath = path.join(
        __dirname,
        '..',
        '..',
        '..',
        'ios-app',
        'app',
        '_layout.tsx'
    );
    let source = '';

    beforeAll(() => {
        source = fs.readFileSync(layoutPath, 'utf8');
    });

    test('_layout.tsx exists', () => {
        expect(fs.existsSync(layoutPath)).toBe(true);
    });

    test('LogBox.ignoreAllLogs is called', () => {
        expect(source).toMatch(/LogBox\.ignoreAllLogs\s*\(\s*\)/);
    });

    test('global error handler is installed', () => {
        expect(source).toMatch(/ErrorUtils/);
        expect(source).toMatch(/setGlobalHandler/);
    });

    test('global handler is gated behind !__DEV__', () => {
        // The `if (!__DEV__) { ... setGlobalHandler(...) }` block must
        // appear in that order so the dev experience isn't altered.
        const match = source.match(/if\s*\(\s*!\s*__DEV__\s*\)\s*{([\s\S]*?)setGlobalHandler/);
        expect(match).not.toBeNull();
    });
});
