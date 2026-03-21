/**
 * Account Deletion regression test (Jest)
 *
 * Verifies DELETE /api/auth/account cleans up ALL related tables,
 * including tappay_transactions FK that previously caused 500 errors.
 *
 * Regression: Account deletion failed with "Failed to delete account"
 * because tappay_transactions had a FK to user_accounts without CASCADE.
 */

const mockClientQuery = jest.fn();
const mockClientRelease = jest.fn();
const mockPoolConnect = jest.fn().mockResolvedValue({
    query: mockClientQuery,
    release: mockClientRelease,
});
const mockPoolQuery = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });

jest.mock('pg', () => ({
    Pool: jest.fn().mockImplementation(() => ({
        query: mockPoolQuery,
        connect: mockPoolConnect,
        end: jest.fn().mockResolvedValue(undefined),
    })),
}));

jest.mock('bcrypt', () => ({
    hash: jest.fn().mockResolvedValue('hashed'),
    compare: jest.fn().mockResolvedValue(false),
}));

jest.mock('jsonwebtoken', () => ({
    sign: jest.fn().mockReturnValue('mock-token'),
    verify: jest.fn().mockImplementation((token) => {
        if (token === 'valid-token') return { userId: 'test-uuid-123', deviceId: 'test-device' };
        throw new Error('invalid');
    }),
}));

jest.mock('google-auth-library', () => ({
    OAuth2Client: jest.fn().mockImplementation(() => ({
        verifyIdToken: jest.fn().mockRejectedValue(new Error('mock')),
    })),
}));

jest.mock('resend', () => ({
    Resend: jest.fn().mockImplementation(() => ({
        emails: { send: jest.fn().mockResolvedValue({}) },
    })),
}));

const express = require('express');
const request = require('supertest');
const cookieParser = require('cookie-parser');

let app;

beforeAll(() => {
    // Must require auth AFTER mocks are set up
    const authModule = require('../../auth');
    const authResult = authModule(
        {},
        jest.fn().mockReturnValue({ entities: [] }),
        jest.fn()
    );

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/auth', authResult.router);
});

beforeEach(() => {
    mockClientQuery.mockReset();
    mockClientRelease.mockReset();
    mockPoolConnect.mockResolvedValue({
        query: mockClientQuery,
        release: mockClientRelease,
    });
});

describe('DELETE /api/auth/account', () => {
    it('returns 401 without auth', async () => {
        const res = await request(app).delete('/api/auth/account');
        expect(res.status).toBe(401);
    });

    it('returns 403 for device-only session (no userId)', async () => {
        // Create token with no userId
        const jwt = require('jsonwebtoken');
        jwt.verify.mockImplementationOnce(() => ({ deviceId: 'test-device' }));

        const res = await request(app)
            .delete('/api/auth/account')
            .set('Cookie', 'eclaw_session=device-only-token');
        expect(res.status).toBe(403);
    });

    it('returns 404 when account not found', async () => {
        mockClientQuery
            .mockResolvedValueOnce({}) // BEGIN
            .mockResolvedValueOnce({ rows: [] }); // SELECT user_accounts → empty

        const res = await request(app)
            .delete('/api/auth/account')
            .set('Cookie', 'eclaw_session=valid-token');
        expect(res.status).toBe(404);
    });

    it('deletes all device-scoped and user-scoped data on success', async () => {
        const defaultResult = { rows: [], rowCount: 0 };
        mockClientQuery
            .mockResolvedValueOnce(defaultResult) // BEGIN
            .mockResolvedValueOnce({ rows: [{ device_id: 'dev-123', email: 'test@example.com' }] }) // SELECT user_accounts
            .mockResolvedValue(defaultResult); // all subsequent DELETEs/UPDATEs

        const res = await request(app)
            .delete('/api/auth/account')
            .set('Cookie', 'eclaw_session=valid-token');

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);

        // Collect all SQL queries made in the transaction
        const queries = mockClientQuery.mock.calls.map(c => c[0]);

        // Verify device-scoped tables are cleaned
        expect(queries).toEqual(expect.arrayContaining([
            expect.stringContaining('DELETE FROM chat_messages'),
            expect.stringContaining('DELETE FROM mission_dashboard'),
            expect.stringContaining('DELETE FROM official_bot_bindings'),
            expect.stringContaining('DELETE FROM message_reactions'),
            expect.stringContaining('DELETE FROM device_vars'),
            expect.stringContaining('DELETE FROM device_telemetry'),
            expect.stringContaining('DELETE FROM schedules'),
            expect.stringContaining('DELETE FROM agent_card_holder'),
            expect.stringContaining('DELETE FROM entity_trash'),
            expect.stringContaining('DELETE FROM channel_accounts'),
            expect.stringContaining('DELETE FROM bot_files'),
            expect.stringContaining('DELETE FROM feedback'),
            expect.stringContaining('DELETE FROM push_subscriptions'),
            expect.stringContaining('DELETE FROM usage_tracking'),
            expect.stringContaining('DELETE FROM server_logs'),
            expect.stringContaining('DELETE FROM pending_cross_messages'),
        ]));

        // Verify entities are unbound (not deleted)
        expect(queries).toEqual(expect.arrayContaining([
            expect.stringContaining('UPDATE entities SET is_bound = FALSE'),
        ]));

        // Verify user-scoped FK tables are cleaned (regression: tappay_transactions)
        expect(queries).toEqual(expect.arrayContaining([
            expect.stringContaining('DELETE FROM tappay_transactions'),
            expect.stringContaining('DELETE FROM user_roles'),
        ]));

        // Verify user_accounts is deleted last
        expect(queries).toEqual(expect.arrayContaining([
            expect.stringContaining('DELETE FROM user_accounts'),
        ]));

        // Verify COMMIT
        expect(queries).toEqual(expect.arrayContaining(['COMMIT']));
    });

    it('rolls back on database error', async () => {
        mockClientQuery
            .mockResolvedValueOnce({}) // BEGIN
            .mockResolvedValueOnce({ rows: [{ device_id: 'dev-123', email: 'test@example.com' }] }) // SELECT
            .mockRejectedValueOnce(new Error('DB connection lost')); // first DELETE fails

        const res = await request(app)
            .delete('/api/auth/account')
            .set('Cookie', 'eclaw_session=valid-token');

        expect(res.status).toBe(500);
        expect(res.body.error).toMatch(/Failed to delete account/);

        const queries = mockClientQuery.mock.calls.map(c => c[0]);
        expect(queries).toEqual(expect.arrayContaining(['ROLLBACK']));
    });

    it('skips device cleanup when user has no linked device', async () => {
        const defaultResult = { rows: [], rowCount: 0 };
        mockClientQuery
            .mockResolvedValueOnce(defaultResult) // BEGIN
            .mockResolvedValueOnce({ rows: [{ device_id: null, email: 'test@example.com' }] }) // SELECT (no device)
            .mockResolvedValue(defaultResult); // remaining

        const res = await request(app)
            .delete('/api/auth/account')
            .set('Cookie', 'eclaw_session=valid-token');

        expect(res.status).toBe(200);

        const queries = mockClientQuery.mock.calls.map(c => c[0]);
        // Should NOT have device-scoped deletes
        expect(queries).not.toEqual(expect.arrayContaining([
            expect.stringContaining('DELETE FROM chat_messages'),
        ]));
        // Should still have user-scoped cleanup
        expect(queries).toEqual(expect.arrayContaining([
            expect.stringContaining('DELETE FROM tappay_transactions'),
            expect.stringContaining('DELETE FROM user_accounts'),
        ]));
    });
});
