'use strict';

const {
    categorizeChatMessage,
    categorizeChatSource,
    passesSystemFilter,
    storageKey,
    CATEGORIES,
    DEFAULT_ACTIVE,
    STORAGE_KEY_PREFIX,
} = require('../../public/portal/shared/chat-source-category');

describe('categorizeChatMessage — inventory pattern coverage', () => {
    test.each([
        ['web_chat', 'conversation'],
        ['client', 'conversation'],
        ['android_chat', 'conversation'],
        ['android_widget', 'conversation'],
        ['widget', 'conversation'],
        ['form_submission', 'conversation'],
        ['bot', 'conversation'],
        ['entity:2:LOBSTER->6', 'conversation'],
        ['entity:6:LOBSTER->2', 'conversation'],
        ['entity:2:LOBSTER->1,3,4', 'conversation'],
        ['xdevice:tbwb9e->3xa3h4', 'conversation'],
        ['Mac_ClaudeAce主管', 'conversation'],

        ['kanban_notify', 'kanban'],
        ['kanban_notify:2,6', 'kanban'],
        ['mission_notify', 'kanban'],
        ['mission_notify:2', 'kanban'],
        ['reopen', 'kanban'],
        ['kanban_comments', 'kanban'],
        ['kanban_pending_notify', 'kanban'],

        ['monitor-healthcheck-2', 'health'],
        ['monitor-healthcheck', 'health'],
        ['monitor-modelcheck-6', 'health'],
        ['manual-steps123-healthcheck-2', 'health'],
        ['healthcheck', 'health'],
        ['rental_health_system', 'health'],

        ['platform', 'platform'],
        ['SYSTEM', 'platform'],
        ['System', 'platform'],
        ['system', 'platform'],
        ['admin_secret_notify', 'platform'],
        ['bind_handshake', 'platform'],
        ['bot_register', 'platform'],
        ['bot_register_handshake', 'platform'],
        ['invite_redeem', 'platform'],
        ['codex-final-ack-2', 'platform'],
        ['target-mode-2', 'platform'],
        ['target_mode', 'platform'],

        ['scheduled', 'scheduled'],
    ])('source %s → %s', (source, expected) => {
        expect(categorizeChatMessage({ source })).toBe(expected);
    });
});

describe('false-positive guards (#6 amendment)', () => {
    test.each([
        ['mission_notifyfoo', 'unknown'],
        ['kanban_notifybar', 'unknown'],
        ['mission_notify_legacy', 'unknown'],
        ['kanban_notifyXXX', 'unknown'],
    ])('broad prefix MUST NOT match: %s → %s', (source, expected) => {
        expect(categorizeChatMessage({ source })).toBe(expected);
    });
});

describe('whitespace normalization (source.trim)', () => {
    test('leading/trailing whitespace trimmed before match', () => {
        expect(categorizeChatMessage({ source: '  web_chat  ' })).toBe('conversation');
        expect(categorizeChatMessage({ source: '\tkanban_notify\n' })).toBe('kanban');
    });
});

describe('flag fallback for null/empty source', () => {
    test('null source + is_from_user → conversation', () => {
        expect(categorizeChatMessage({ source: null, is_from_user: true })).toBe('conversation');
    });
    test('empty source + is_from_bot → conversation', () => {
        expect(categorizeChatMessage({ source: '', is_from_bot: true })).toBe('conversation');
    });
    test('null source + no flags → unknown', () => {
        expect(categorizeChatMessage({ source: null })).toBe('unknown');
        expect(categorizeChatMessage({})).toBe('unknown');
    });
});

describe('flag fallback for unrecognized source', () => {
    test('unrecognized source + is_from_bot → conversation (legacy bot row)', () => {
        expect(categorizeChatMessage({ source: 'SomeLegacyBotLabel', is_from_bot: true }))
            .toBe('conversation');
    });
    test('unrecognized source + no flags → unknown', () => {
        expect(categorizeChatMessage({ source: 'totally_unknown_2026' })).toBe('unknown');
    });
});

describe('categorizeChatSource back-compat shim', () => {
    test('string-only call delegates to message form', () => {
        expect(categorizeChatSource('kanban_notify')).toBe('kanban');
        expect(categorizeChatSource('SYSTEM')).toBe('platform');
        expect(categorizeChatSource('totally_unknown')).toBe('unknown');
    });
});

describe('passesSystemFilter', () => {
    const ALL_ON = {
        conversation: true, kanban: true, scheduled: true,
        platform: true, health: true,
    };
    const DEFAULT = DEFAULT_ACTIVE;

    test('all chips on → everything passes', () => {
        expect(passesSystemFilter({ source: 'web_chat' }, ALL_ON)).toBe(true);
        expect(passesSystemFilter({ source: 'kanban_notify' }, ALL_ON)).toBe(true);
        expect(passesSystemFilter({ source: 'monitor-healthcheck-2' }, ALL_ON)).toBe(true);
    });

    test('default state hides platform + health, keeps rest', () => {
        expect(passesSystemFilter({ source: 'web_chat' }, DEFAULT)).toBe(true);
        expect(passesSystemFilter({ source: 'kanban_notify' }, DEFAULT)).toBe(true);
        expect(passesSystemFilter({ source: 'scheduled' }, DEFAULT)).toBe(true);
        expect(passesSystemFilter({ source: 'monitor-healthcheck-2' }, DEFAULT)).toBe(false);
        expect(passesSystemFilter({ source: 'platform' }, DEFAULT)).toBe(false);
    });

    test('unknown ALWAYS passes regardless of chip state (regression-safe)', () => {
        const allOff = { conversation: false, kanban: false, scheduled: false, platform: false, health: false };
        expect(passesSystemFilter({ source: 'totally_unknown_xxx' }, allOff)).toBe(true);
        expect(passesSystemFilter({ source: null }, allOff)).toBe(true);
    });

    test('null activeSet treated as all-on (defensive)', () => {
        expect(passesSystemFilter({ source: 'monitor-healthcheck-2' }, null)).toBe(true);
    });
});

describe('storageKey', () => {
    test('per-device key', () => {
        expect(storageKey('480def4c-2183-4d8e-afd0-b131ae89adcc'))
            .toBe('eclaw.chatSysFilter.v1:480def4c-2183-4d8e-afd0-b131ae89adcc');
    });
    test('no device falls back to prefix only', () => {
        expect(storageKey('')).toBe(STORAGE_KEY_PREFIX);
        expect(storageKey(null)).toBe(STORAGE_KEY_PREFIX);
    });
});

describe('constants', () => {
    test('CATEGORIES exposed as frozen array of 5 (unknown excluded)', () => {
        expect(CATEGORIES).toEqual(['conversation', 'kanban', 'scheduled', 'platform', 'health']);
        expect(Object.isFrozen(CATEGORIES)).toBe(true);
        expect(CATEGORIES).not.toContain('unknown');
    });
    test('DEFAULT_ACTIVE matches spec defaults', () => {
        expect(DEFAULT_ACTIVE.conversation).toBe(true);
        expect(DEFAULT_ACTIVE.kanban).toBe(true);
        expect(DEFAULT_ACTIVE.scheduled).toBe(true);
        expect(DEFAULT_ACTIVE.platform).toBe(false);
        expect(DEFAULT_ACTIVE.health).toBe(false);
    });
});
