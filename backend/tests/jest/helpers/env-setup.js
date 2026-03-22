/**
 * Jest global env setup — runs before each test file.
 * Sets required environment variables that would otherwise cause fail-fast errors.
 */
if (!process.env.JWT_SECRET) process.env.JWT_SECRET = 'test-jwt-secret-for-jest';
