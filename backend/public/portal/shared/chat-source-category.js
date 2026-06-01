/**
 * Chat source category — collapse `chat_messages.source` raw patterns into
 * 5 user-facing categories for the smart-filter chips in portal/chat.html.
 *
 * Spec: docs/specs/chat-smart-filter-system-messages.md
 *
 * Categories: 'conversation' | 'kanban' | 'health' | 'platform' | 'scheduled' | 'unknown'
 *
 * Key contract (#6 amendments 2026-06-01):
 * - `categorizeChatMessage(msg)` is canonical — takes the whole message
 *   so it can fall back to `is_from_user || is_from_bot` flags for legacy
 *   bot rows where the source string is unreliable.
 * - `source.trim()` normalized; SYSTEM/platform case-insensitive.
 * - `kanban_notify` / `mission_notify` only EXACT or `:`-prefix match
 *   (never broad prefix — would mis-classify `mission_notifyfoo`).
 * - `unknown` is the last resort and MUST be shown by default; the UI
 *   guarantees this via `passesSystemFilter`.
 */
(function (global) {
    'use strict';

    function categorizeChatMessage(msg) {
        const raw = (msg && msg.source) || '';
        const s = String(raw).trim();
        const sLower = s.toLowerCase();

        if (!s) {
            if (msg && (msg.is_from_user || msg.is_from_bot)) return 'conversation';
            return 'unknown';
        }

        if (s === 'web_chat' || s === 'client' ||
            s === 'android_chat' || s === 'android_widget' || s === 'widget' ||
            s === 'form_submission' || s === 'bot') return 'conversation';

        if (s.startsWith('entity:') || s.startsWith('xdevice:')) return 'conversation';

        if (s === 'kanban_notify' || s.startsWith('kanban_notify:')) return 'kanban';
        if (s === 'mission_notify' || s.startsWith('mission_notify:')) return 'kanban';
        if (s === 'reopen' || s === 'kanban_comments' || s === 'kanban_pending_notify') return 'kanban';

        if (s.startsWith('monitor-healthcheck') ||
            s.startsWith('monitor-modelcheck') ||
            s.startsWith('manual-steps') ||
            s === 'healthcheck' ||
            s === 'rental_health_system') return 'health';

        if (sLower === 'platform' || sLower === 'system' ||
            s === 'admin_secret_notify' ||
            s.startsWith('bind_') ||
            s.startsWith('bot_register') ||
            s === 'invite_redeem' ||
            s.startsWith('codex-') ||
            s.startsWith('target-mode') ||
            s === 'target_mode') return 'platform';

        if (s === 'scheduled') return 'scheduled';

        if (msg && (msg.is_from_user || msg.is_from_bot)) return 'conversation';

        // Legacy 中文 label fallback: must end with 主管 (e.g. 'Mac_ClaudeAce主管').
        // Without this anchor the pattern would match any [A-Za-z_]+ string and
        // swallow unknown sources into conversation.
        if (/^[A-Za-z_一-鿿]+主管$/.test(s)) return 'conversation';

        return 'unknown';
    }

    function categorizeChatSource(source) {
        return categorizeChatMessage({ source: source });
    }

    const CATEGORIES = Object.freeze([
        'conversation', 'kanban', 'scheduled', 'platform', 'health'
    ]);

    const DEFAULT_ACTIVE = Object.freeze({
        conversation: true,
        kanban: true,
        scheduled: true,
        platform: false,
        health: false,
    });

    const STORAGE_KEY_PREFIX = 'eclaw.chatSysFilter.v1';

    function storageKey(deviceId) {
        if (!deviceId) return STORAGE_KEY_PREFIX;
        return STORAGE_KEY_PREFIX + ':' + deviceId;
    }

    function passesSystemFilter(msg, activeSet) {
        if (!activeSet) return true;
        const cat = categorizeChatMessage(msg);
        if (cat === 'unknown') return true;
        return !!activeSet[cat];
    }

    const api = {
        categorizeChatMessage: categorizeChatMessage,
        categorizeChatSource: categorizeChatSource,
        passesSystemFilter: passesSystemFilter,
        storageKey: storageKey,
        CATEGORIES: CATEGORIES,
        DEFAULT_ACTIVE: DEFAULT_ACTIVE,
        STORAGE_KEY_PREFIX: STORAGE_KEY_PREFIX,
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    if (global) {
        global.ChatSourceCategory = api;
    }
})(typeof window !== 'undefined' ? window : typeof globalThis !== 'undefined' ? globalThis : null);
