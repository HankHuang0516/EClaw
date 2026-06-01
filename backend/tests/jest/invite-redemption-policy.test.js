/**
 * Source-grep guard for Option B (per-code-once, many codes per device).
 *
 * Spec: docs/specs/invite-redemption-policy.md
 *
 * We use grep-style assertions against the /api/invite/redeem handler
 * because (a) it's schema-identical to the existing invite-tiers.test.js
 * pattern in this repo, and (b) the regression risk here is specifically
 * the reintroduction of the old per-device-lifetime check — a pattern
 * easy to catch at the source level.
 */

const fs = require('fs');
const path = require('path');

const INDEX_JS = fs.readFileSync(
    path.join(__dirname, '..', '..', 'index.js'),
    'utf8'
);

describe('invite redemption policy — Option B (per-code-once)', () => {
    test('per-code-once check remains at the top of the handler', () => {
        // A code whose used_by_device_id is already set must 409.
        expect(INDEX_JS).toMatch(
            /if \(used_by_device_id\)\s*\{\s*return \{ error: 'Invite code already used', status: 409 \};\s*\}/
        );
    });

    test('self-invite guard remains', () => {
        expect(INDEX_JS).toMatch(
            /if \(owner_device_id === deviceId\)\s*\{\s*return \{ error: 'Cannot redeem your own invite code', status: 400 \};\s*\}/
        );
    });

    test('transaction early errors are returned through the response handler', () => {
        expect(INDEX_JS).toMatch(
            /if \(result\.error\)\s*\{\s*return res\.status\(result\.status\)\.json\(\{ success: false, error: result\.error \}\);\s*\}/
        );
    });

    test('per-device-lifetime guard is removed', () => {
        // The prior "SELECT 1 FROM invite_codes WHERE used_by_device_id = $1"
        // check inside the redeem handler is deleted; Option B allows one
        // device to redeem many different codes (one per inviter).
        //
        // getInviteClickStatsForOwner still uses used_by_device_id = $1 for
        // its own aggregate — that's fine. The regression we're guarding
        // against is specifically a bare SELECT ... WHERE used_by_device_id
        // with no JOIN to invite_clicks or other aggregate context, inside
        // the redeem flow.
        const redeemMatch = INDEX_JS.match(
            /app\.post\('\/api\/invite\/redeem'[\s\S]*?\n\}\);/
        );
        expect(redeemMatch).toBeTruthy();
        const redeemBody = redeemMatch[0];
        expect(redeemBody).not.toMatch(
            /SELECT 1 FROM invite_codes WHERE used_by_device_id/
        );
        expect(redeemBody).not.toMatch(/You have already redeemed an invite code/);
    });

    test('handler still credits invitee and inviter rewards', () => {
        // Regression guard — removing the lifetime lock must not have taken
        // the reward INSERTs with it.
        const redeemMatch = INDEX_JS.match(
            /app\.post\('\/api\/invite\/redeem'[\s\S]*?\n\}\);/
        );
        const redeemBody = redeemMatch[0];
        expect(redeemBody).toMatch(/INSERT INTO invite_rewards/);
        expect(redeemBody).toMatch(/bonus_messages/);
    });
});
