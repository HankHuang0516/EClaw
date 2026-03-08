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
    // Verbose output for CI readability
    verbose: true,
};
