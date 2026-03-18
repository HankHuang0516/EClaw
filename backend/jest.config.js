/** @type {import('jest').Config} */
module.exports = {
    testEnvironment: 'node',
    testMatch: ['**/tests/jest/**/*.test.js'],
    testTimeout: 15000,
    // Prevent open handles from keeping Jest alive
    forceExit: true,
    // Run tests in band (main process) to avoid worker exit code issues on Windows
    runInBand: true,
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
