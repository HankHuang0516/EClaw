/**
 * resolveIsAdmin admin-principal guard — card_2c41721c
 *
 * Regression for the prod ERROR:
 *   [AI-Support] resolveIsAdmin failed for device_11486328-5c39-45d5-9d7b-a6afc0519aee :
 *   invalid input syntax for type uuid: "device_11486328-5c39-45d5-9d7b-a6afc0519aee"
 *
 * Device-secret-authenticated callers get a synthetic principal
 * `req.user.userId = "device_<deviceId>"` (ai-support.js, 3 routes). Feeding
 * that into `SELECT is_admin FROM user_accounts WHERE id = $1` (a uuid column)
 * throws and used to be caught + logged as ERROR on every such request.
 * `isAccountUuid()` now gates resolveIsAdmin so non-uuid principals short-circuit
 * to `false` BEFORE the doomed query — behaviour-preserving (device sessions were
 * never admins) and ERROR-free.
 */
const { isAccountUuid } = require('../../ai-support');

describe('isAccountUuid — admin-lookup principal guard', () => {
    test('the exact device principal from the prod ERROR is rejected (no uuid query)', () => {
        expect(isAccountUuid('device_11486328-5c39-45d5-9d7b-a6afc0519aee')).toBe(false);
    });

    test('any device_<deviceId> synthetic principal is rejected', () => {
        expect(isAccountUuid('device_abcdef01-2345-6789-abcd-ef0123456789')).toBe(false);
        expect(isAccountUuid('device_not-a-uuid')).toBe(false);
    });

    test('a bare account uuid is accepted (real admins still resolve)', () => {
        expect(isAccountUuid('11486328-5c39-45d5-9d7b-a6afc0519aee')).toBe(true);
        expect(isAccountUuid('AABBCCDD-1122-3344-5566-778899AABBCC')).toBe(true); // case-insensitive
    });

    test('empty / null / non-string principals are rejected (matches !userId guard)', () => {
        expect(isAccountUuid('')).toBe(false);
        expect(isAccountUuid(null)).toBe(false);
        expect(isAccountUuid(undefined)).toBe(false);
        expect(isAccountUuid(12345)).toBe(false);
        expect(isAccountUuid({})).toBe(false);
    });

    test('malformed uuid-ish strings are rejected (no partial / padded matches)', () => {
        expect(isAccountUuid('11486328-5c39-45d5-9d7b')).toBe(false); // too short
        expect(isAccountUuid('11486328-5c39-45d5-9d7b-a6afc0519aee-extra')).toBe(false); // trailing
        expect(isAccountUuid(' 11486328-5c39-45d5-9d7b-a6afc0519aee')).toBe(false); // leading space
        expect(isAccountUuid('zz486328-5c39-45d5-9d7b-a6afc0519aee')).toBe(false); // non-hex
    });
});
