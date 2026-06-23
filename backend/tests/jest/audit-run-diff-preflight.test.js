'use strict';

/**
 * PR-diff preflight unit tests for the operability/compliance audit runner.
 * Card: card_3c6fb87efc650c6903e22e53 (SPEC v2 #6 — scan only changed files in CI
 * so NEW regressions are caught without flooding on the pre-existing tree).
 *
 * These pin the pure, side-effect-free helpers. The git-driven file collection
 * (`changedScannableFiles`) is exercised end-to-end by the runner; here we lock
 * the classification logic that decides which changed files are in scope —
 * including the macOS `/private/tmp` regression where an absolute-path segment
 * (`tmp`) wrongly matched SKIP_DIRS.
 */

const path = require('path');
const runner = require('../../agent-improvement/audit-run');

describe('audit-run — diff-preflight helpers', () => {
    test('exports the diff-preflight surface', () => {
        expect(typeof runner.changedScannableFiles).toBe('function');
        expect(typeof runner.isScannableFile).toBe('function');
        expect(typeof runner.runAudit).toBe('function');
    });

    test('isScannableFile keeps scannable extensions under the repo', () => {
        expect(runner.isScannableFile(path.join('public', 'portal', 'community.html'))).toBe(true);
        expect(runner.isScannableFile(path.join('routes', 'index.js'))).toBe(true);
        expect(runner.isScannableFile(path.join('migrations', '001.sql'))).toBe(true);
    });

    test('isScannableFile rejects non-scannable extensions + self files', () => {
        expect(runner.isScannableFile(path.join('public', 'logo.png'))).toBe(false);
        expect(runner.isScannableFile('README.md')).toBe(false);
        expect(runner.isScannableFile(path.join('agent-improvement', 'audit-rules.js'))).toBe(false);
        expect(runner.isScannableFile(path.join('agent-improvement', 'audit-run.js'))).toBe(false);
    });

    test('isScannableFile rejects files inside skipped dirs (relative segments)', () => {
        expect(runner.isScannableFile(path.join('node_modules', 'pkg', 'index.js'))).toBe(false);
        expect(runner.isScannableFile(path.join('dist', 'bundle.js'))).toBe(false);
    });

    test('isScannableFile does NOT misfire on a benign relative path', () => {
        // The skip-check runs on the RELATIVE path, so a scannable file in a
        // normal portal subdir is kept (the absolute-prefix `/private/tmp` bug
        // would have rejected this if the check ran over absolute segments).
        expect(runner.isScannableFile(path.join('public', 'portal', 'admin', 'rental-monitor.html'))).toBe(true);
    });
});
