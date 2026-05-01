describe('db SSL mode selection', () => {
    const originalEnv = process.env;

    beforeEach(() => {
        jest.resetModules();
        process.env = { ...originalEnv };
    });

    afterAll(() => {
        process.env = originalEnv;
    });

    test('disables SSL for Railway internal Postgres hosts', () => {
        process.env.NODE_ENV = 'production';
        delete process.env.PGSSLMODE;
        const db = require('../../db');

        expect(db._shouldUseSsl('postgresql://user:pass@postgres-pgvector.railway.internal:5432/railway')).toBe(false);
    });

    test('keeps SSL enabled for external production Postgres hosts', () => {
        process.env.NODE_ENV = 'production';
        delete process.env.PGSSLMODE;
        const db = require('../../db');

        expect(db._shouldUseSsl('postgresql://user:pass@example.com:5432/railway')).toEqual({
            rejectUnauthorized: false,
        });
    });

    test('respects explicit PGSSLMODE disable', () => {
        process.env.NODE_ENV = 'production';
        process.env.PGSSLMODE = 'disable';
        const db = require('../../db');

        expect(db._shouldUseSsl('postgresql://user:pass@example.com:5432/railway')).toBe(false);
    });
});
