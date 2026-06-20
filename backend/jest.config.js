/** @type {import('jest').Config} */
module.exports = {
    testEnvironment: 'node',
    // Set required env vars before any test module loads
    setupFiles: ['./tests/jest/helpers/env-setup.js'],
    testMatch: ['**/tests/jest/**/*.test.js'],
    // Worktrees from concurrent claude sessions pollute the test scan and
    // crash on missing 'pg' from their stale node_modules; skip them.
    // Found 2026-06-10 02:57 TW via Run 9 of the perpetual E2E card (gap J1).
    testPathIgnorePatterns: ['/node_modules/', '/.claude/', '/.git/', '/.worktrees/'],
    testTimeout: 15000,
    // Prevent open handles from keeping Jest alive
    forceExit: true,
    // Clear mocks between tests
    clearMocks: true,
    // Reset module registry between test files to avoid shared state
    restoreMocks: true,
    // Verbose output for CI readability
    verbose: true,
    // Coverage reporting
    collectCoverage: !!process.env.CI,
    coverageDirectory: 'coverage',
    coverageReporters: ['text-summary', 'lcov'],
};
