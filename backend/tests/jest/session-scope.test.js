const fs = require('fs');
const path = require('path');

const {
    buildOrgEntitySessionKey,
    isOrgEntitySessionKey,
    sanitizeSessionScopePart
} = require('../../session-scope');

describe('official bot org/entity session scope', () => {
    test('builds session keys that include org and entity identity', () => {
        expect(buildOrgEntitySessionKey('agent:main', 'org 7', 6))
            .toBe('agent:main:org:org_7:entity:6');
    });

    test('rejects stale session keys from a different org or entity', () => {
        const key = buildOrgEntitySessionKey('agent:main', 'org-a', 6);
        expect(isOrgEntitySessionKey(key, 'agent:main', 'org-a', 6)).toBe(true);
        expect(isOrgEntitySessionKey(key, 'agent:main', 'org-b', 6)).toBe(false);
        expect(isOrgEntitySessionKey(key, 'agent:main', 'org-a', 7)).toBe(false);
    });

    test('sanitizes scope pieces without dropping useful base-key separators', () => {
        expect(sanitizeSessionScopePart('agent:main/session', 'default', true)).toBe('agent:main_session');
        expect(sanitizeSessionScopePart('org/id:with spaces', 'unknown')).toBe('org_id_with_spaces');
    });

    test('binding code uses scoped keys with fallback to discovered sessions', () => {
        const source = fs.readFileSync(path.join(__dirname, '../../index.js'), 'utf8');
        expect(source).toContain("buildOrgEntitySessionKey(freeBot.session_key_template || 'default', deviceId, eId)");
        expect(source).toContain("buildOrgEntitySessionKey(personalBot.session_key_template || 'default', deviceId, eId)");
        // Fallback loop restored so bind-free works when gateway lacks scoped sessions
        expect(source).toContain("Trying discovered session");
        expect(source).toMatch(/for \(const sk of sessions\)/);
    });
});
