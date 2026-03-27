/**
 * Contract Test: /api/auth/me response schema
 *
 * Verifies that the /api/auth/me endpoint returns ALL fields that
 * portal frontend pages depend on via `currentUser.XXX`.
 *
 * WHY THIS EXISTS:
 * Issue #490 removed `deviceSecret` from /me response for security,
 * but 17 portal pages depend on `currentUser.deviceSecret` for API calls.
 * All existing tests passed because they use hardcoded credentials from .env,
 * not from the /me response. This contract test prevents that class of bug.
 *
 * HOW IT WORKS:
 * 1. Scans all portal HTML/JS files for `currentUser.XXX` property accesses
 * 2. Verifies auth.js /me handler source code includes those field names
 * 3. Fails loudly if a backend change removes a field the frontend needs
 */

const fs = require('fs');
const path = require('path');

const portalDir = path.join(__dirname, '../../public/portal');
const sharedPortalDir = path.join(portalDir, 'shared');
const authJsPath = path.join(__dirname, '../../auth.js');

// Collect all unique currentUser.XXX field names from portal source files
function scanCurrentUserFields() {
    const fields = new Set();
    const dirs = [portalDir, sharedPortalDir];

    for (const dir of dirs) {
        if (!fs.existsSync(dir)) continue;
        const files = fs.readdirSync(dir).filter(f => f.endsWith('.html') || f.endsWith('.js'));
        for (const file of files) {
            const content = fs.readFileSync(path.join(dir, file), 'utf8');
            const matches = content.matchAll(/currentUser\.(\w+)/g);
            for (const m of matches) {
                fields.add(m[1]);
            }
        }
    }
    return fields;
}

// Fields that are critical — removing any of these from /me will break portal pages
const CRITICAL_FIELDS = [
    'deviceId',
    'deviceSecret',
    'email',
    'subscriptionStatus',
    'language',
];

describe('currentUser field contract (static analysis)', () => {
    test('portal code uses all expected critical fields', () => {
        const found = scanCurrentUserFields();
        for (const field of CRITICAL_FIELDS) {
            expect(found.has(field)).toBe(true);
        }
    });

    test('auth.js /me handler returns all critical fields', () => {
        const authSource = fs.readFileSync(authJsPath, 'utf8');

        // Extract the /me route handler block
        const meStart = authSource.indexOf("router.get('/me'");
        expect(meStart).toBeGreaterThan(-1);

        // Get the handler up to the next router.xxx( call
        const afterMe = authSource.substring(meStart);
        const nextRoute = afterMe.search(/\n\s+router\.\w+\(/);
        const meHandler = nextRoute > 0 ? afterMe.substring(0, nextRoute) : afterMe.substring(0, 2000);

        for (const field of CRITICAL_FIELDS) {
            // Check that field appears as an object key in res.json response (e.g. "deviceSecret:")
            // Must match `fieldName:` as a property assignment, not just any mention
            const keyPattern = new RegExp(`\\b${field}\\s*:`);
            const found = keyPattern.test(meHandler);
            if (!found) {
                throw new Error(
                    `CRITICAL: auth.js /me handler does NOT return "${field}" ` +
                    `but portal pages use currentUser.${field} in ${countUsages(field)} places. ` +
                    `Removing this field will break the portal!`
                );
            }
        }
    });

    test('warn if new currentUser fields appear without contract coverage', () => {
        const found = scanCurrentUserFields();
        const ALL_KNOWN = new Set([
            ...CRITICAL_FIELDS,
            'id', 'isAdmin', 'displayName', 'avatarUrl',
            'googleLinked', 'facebookLinked', 'subscriptionExpiresAt',
            'createdAt', 'usageToday', 'usageLimit', 'emailVerified',
        ]);

        const unknown = [...found].filter(f => !ALL_KNOWN.has(f));
        if (unknown.length > 0) {
            console.warn(
                `\n⚠️  New currentUser fields found in portal code: ${unknown.join(', ')}\n` +
                `   → Add to CRITICAL_FIELDS or ALL_KNOWN in auth-me-contract.test.js\n` +
                `   → Verify /api/auth/me returns them\n`
            );
        }
        // Pass — just warn, don't fail for optional fields
        expect(true).toBe(true);
    });
});

function countUsages(field) {
    let count = 0;
    const dirs = [portalDir, sharedPortalDir];
    for (const dir of dirs) {
        if (!fs.existsSync(dir)) continue;
        const files = fs.readdirSync(dir).filter(f => f.endsWith('.html') || f.endsWith('.js'));
        for (const file of files) {
            const content = fs.readFileSync(path.join(dir, file), 'utf8');
            const matches = content.match(new RegExp(`currentUser\\.${field}`, 'g'));
            if (matches) count += matches.length;
        }
    }
    return count;
}
