/**
 * Regression test for the publicCode allocator tombstone fix
 * (audit card_0256a6c043d20be35b8388d1).
 *
 * Before the fix, `generatePublicCode()` only checked the live `publicCodeIndex`,
 * so a code freed by an unbind/delete could be re-issued to a different entity.
 * That broke any stale QR or saved card pointing at the old code — it would
 * silently route to the new entity (FK-style risk).
 *
 * The fix wraps `publicCodeIndex` in a Proxy that records every released key
 * into a `deletedPublicCodes` tombstone Set, and `generatePublicCode()` rejects
 * any candidate already in that set.
 */

jest.mock('pg', () => ({
    Pool: jest.fn().mockImplementation(() => ({
        query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
        connect: jest.fn().mockResolvedValue({
            query: jest.fn().mockResolvedValue({ rows: [] }),
            release: jest.fn(),
        }),
        end: jest.fn().mockResolvedValue(undefined),
    })),
}));

const app = require('../../index');
const generatePublicCode = app._generatePublicCode;
const publicCodeIndex = app._publicCodeIndex;
const deletedPublicCodes = app._deletedPublicCodes;

afterAll(async () => {
    const { httpServer } = require('../../index');
    await new Promise((resolve) => httpServer.close(resolve));
});

describe('publicCode allocator — tombstone never re-issues freed codes', () => {
    beforeEach(() => {
        // Clean slate per test
        for (const k of Object.keys(publicCodeIndex)) delete publicCodeIndex[k];
        deletedPublicCodes.clear();
    });

    test('exposes generator + index + tombstone set', () => {
        expect(typeof generatePublicCode).toBe('function');
        expect(publicCodeIndex).toBeTruthy();
        expect(deletedPublicCodes).toBeInstanceOf(Set);
    });

    test('produces 6-char lowercase alphanumeric codes', () => {
        for (let i = 0; i < 50; i++) {
            const code = generatePublicCode();
            expect(code).toMatch(/^[a-z0-9]{6}$/);
            // Simulate the binding flow: register the code in the index.
            publicCodeIndex[code] = { deviceId: 'devA', entityId: i };
        }
    });

    test('deleting from publicCodeIndex auto-tombstones the code', () => {
        publicCodeIndex.aaaaaa = { deviceId: 'd', entityId: 1 };
        expect(deletedPublicCodes.has('aaaaaa')).toBe(false);
        delete publicCodeIndex.aaaaaa;
        expect(deletedPublicCodes.has('aaaaaa')).toBe(true);
    });

    test('deleting an absent key does NOT tombstone it', () => {
        delete publicCodeIndex.zzzzzz;
        expect(deletedPublicCodes.has('zzzzzz')).toBe(false);
    });

    test('generator never re-issues a tombstoned code (force-collide)', () => {
        // Pre-tombstone the first 19 candidates the generator will produce.
        // The generator caps at 20 attempts — if it didn't honor the tombstone
        // set, it would return one of these. Attempt 20 lands on a fresh code
        // and must succeed.
        const cryptoMod = require('crypto');
        const realRandomBytes = cryptoMod.randomBytes;
        const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';

        const queued = [];
        for (let i = 0; i < 19; i++) {
            const buf = realRandomBytes(6);
            let code = '';
            for (let j = 0; j < 6; j++) code += chars.charAt(buf[j] % chars.length);
            queued.push({ buf, code });
            deletedPublicCodes.add(code);
        }
        const fresh = realRandomBytes(6);
        let freshCode = '';
        for (let j = 0; j < 6; j++) freshCode += chars.charAt(fresh[j] % chars.length);
        deletedPublicCodes.delete(freshCode);

        const sequence = [...queued.map((q) => q.buf), fresh];
        const spy = jest.spyOn(cryptoMod, 'randomBytes').mockImplementation((n) => {
            if (sequence.length === 0) return realRandomBytes(n);
            return sequence.shift();
        });

        try {
            const got = generatePublicCode();
            expect(got).toBe(freshCode);
            // Every tombstoned candidate must still be tombstoned afterwards.
            for (const q of queued) {
                expect(deletedPublicCodes.has(q.code)).toBe(true);
            }
        } finally {
            spy.mockRestore();
        }
    });

    test('1k generate→delete→generate cycles never collide with tombstones', () => {
        const issued = new Set();
        for (let i = 0; i < 500; i++) {
            const code = generatePublicCode();
            // Tombstone must never hand back something already buried.
            expect(deletedPublicCodes.has(code)).toBe(false);
            // Index must never hand back something already live.
            expect(publicCodeIndex[code]).toBeUndefined();
            publicCodeIndex[code] = { deviceId: 'devA', entityId: i };
            issued.add(code);
        }

        // Free half — odd indices.
        let freed = 0;
        for (const code of issued) {
            if (freed % 2 === 1) delete publicCodeIndex[code];
            freed++;
        }

        // Issue 500 more. None of them may collide with deletedPublicCodes.
        for (let i = 0; i < 500; i++) {
            const code = generatePublicCode();
            expect(deletedPublicCodes.has(code)).toBe(false);
            expect(publicCodeIndex[code]).toBeUndefined();
            publicCodeIndex[code] = { deviceId: 'devB', entityId: i };
        }
    });

    test('tombstone explicitly clearable (used by trash-restore + custom-set)', () => {
        publicCodeIndex.bbbbbb = { deviceId: 'd', entityId: 1 };
        delete publicCodeIndex.bbbbbb;
        expect(deletedPublicCodes.has('bbbbbb')).toBe(true);

        // Simulate the restore path: live entity reclaims the code.
        publicCodeIndex.bbbbbb = { deviceId: 'd', entityId: 2 };
        deletedPublicCodes.delete('bbbbbb');
        expect(deletedPublicCodes.has('bbbbbb')).toBe(false);
    });
});
