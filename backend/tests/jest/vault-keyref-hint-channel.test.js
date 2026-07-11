/**
 * Vault {{VAR}} interpolation — per-entity resolution (card_247a3a68 P0 fix)
 *
 * Owner-decided semantics (card_247a3a68 spec correction 2026-07-11):
 *   - Channel-bound (keyref-first) agents receive `[[VAULT_KEYREF name=X]]`
 *     and fetch the value on-demand via GET /api/device-vars/value.
 *   - Legacy webhook agents keep receiving the expanded value inline
 *     (back-compat — they predate the keyref endpoint).
 *   - Chat_messages ALWAYS stores the literal `{{VAR}}` for privacy
 *     (that's guarded by the callers of resolveVaultTokens, not the helper
 *     itself — resolveVaultTokens only transforms the push-facing string).
 *
 * Live-repro that this test regresses against:
 *   2026-07-11 23:17 TW: Hank typed `{{TEST_A}}` in web_chat.
 *   Before the fix: the channel-mode agent's pushText was inlined to the
 *     TEST_A vault value → agent context leaked the value.
 *   After the fix: the channel-mode agent's pushText carries the literal
 *     `[[VAULT_KEYREF name=TEST_A]]` token; value never traverses chat/log.
 */

require('./helpers/mock-setup');
const { _resolveVaultTokens: resolveVaultTokens } = require('../../index');

const CHANNEL_ENTITY = { bindingType: 'channel' };
const WEBHOOK_ENTITY = { bindingType: 'webhook', webhook: { type: 'openclaw' } };
const DISCORD_ENTITY = { bindingType: 'webhook', webhook: { type: 'discord' } };
const VARS_MAP = { TEST_A: 'SECRET_VALUE_TEST_A', RAILWAY_TOKEN: 'raw-uuid-of-doom' };

describe('resolveVaultTokens — channel receiver (keyref-first)', () => {
    it('rewrites {{VAR}} to [[VAULT_KEYREF name=VAR]] and NEVER inlines the value', () => {
        const out = resolveVaultTokens('use {{TEST_A}} to call the api', VARS_MAP, CHANNEL_ENTITY);
        expect(out).toBe('use [[VAULT_KEYREF name=TEST_A]] to call the api');
        expect(out).not.toContain('SECRET_VALUE_TEST_A');
    });

    it('handles multiple distinct {{VAR}} tokens in the same message', () => {
        const out = resolveVaultTokens(
            'A={{TEST_A}} R={{RAILWAY_TOKEN}}',
            VARS_MAP,
            CHANNEL_ENTITY
        );
        expect(out).toBe('A=[[VAULT_KEYREF name=TEST_A]] R=[[VAULT_KEYREF name=RAILWAY_TOKEN]]');
        expect(out).not.toContain('SECRET_VALUE_TEST_A');
        expect(out).not.toContain('raw-uuid-of-doom');
    });

    it('still emits hint form even when the vault map is null (locked/absent)', () => {
        const out = resolveVaultTokens('try {{TEST_A}}', null, CHANNEL_ENTITY);
        expect(out).toBe('try [[VAULT_KEYREF name=TEST_A]]');
    });

    it('leaves the string alone when there are no {{...}} tokens', () => {
        const out = resolveVaultTokens('plain hello', VARS_MAP, CHANNEL_ENTITY);
        expect(out).toBe('plain hello');
    });
});

describe('resolveVaultTokens — legacy webhook receiver (back-compat)', () => {
    it('expands {{VAR}} to the vault value inline for openclaw', () => {
        const out = resolveVaultTokens('use {{TEST_A}} now', VARS_MAP, WEBHOOK_ENTITY);
        expect(out).toBe('use SECRET_VALUE_TEST_A now');
    });

    it('expands {{VAR}} to the vault value inline for discord', () => {
        const out = resolveVaultTokens('use {{TEST_A}} now', VARS_MAP, DISCORD_ENTITY);
        expect(out).toBe('use SECRET_VALUE_TEST_A now');
    });

    it('leaves an unknown key literal (no vault entry) instead of leaking undefined', () => {
        const out = resolveVaultTokens('use {{NOT_A_KEY}} now', VARS_MAP, WEBHOOK_ENTITY);
        expect(out).toBe('use {{NOT_A_KEY}} now');
    });

    it('leaves the token literal when varsMap is null (locked vault) — no crash, no leak', () => {
        const out = resolveVaultTokens('use {{TEST_A}} now', null, WEBHOOK_ENTITY);
        expect(out).toBe('use {{TEST_A}} now');
    });
});

describe('resolveVaultTokens — defensive edge cases', () => {
    it('handles a null/undefined entity by falling through to legacy expansion', () => {
        const out = resolveVaultTokens('use {{TEST_A}}', VARS_MAP, null);
        expect(out).toBe('use SECRET_VALUE_TEST_A');
    });

    it('does nothing for empty pushText', () => {
        expect(resolveVaultTokens('', VARS_MAP, CHANNEL_ENTITY)).toBe('');
        expect(resolveVaultTokens(null, VARS_MAP, CHANNEL_ENTITY)).toBe(null);
    });

    it('does NOT re-expand a `[[VAULT_KEYREF name=X]]` token (idempotence)', () => {
        const already = 'use [[VAULT_KEYREF name=TEST_A]] to call';
        expect(resolveVaultTokens(already, VARS_MAP, CHANNEL_ENTITY)).toBe(already);
        expect(resolveVaultTokens(already, VARS_MAP, WEBHOOK_ENTITY)).toBe(already);
    });
});
