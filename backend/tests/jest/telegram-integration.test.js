/**
 * Telegram polling adapter — pure-function contract tests.
 *
 * Covers:
 *  - normalizeUpdate handles message + edited_message; rejects malformed
 *  - isAllowed enforces csv whitelist (empty = deny)
 *  - 4096-char message clipping in handleTransformFollowup is implicit; not unit-tested here
 */
'use strict';

const { normalizeUpdate, isAllowed } = require('../../telegram-integration');

describe('telegram-integration normalizeUpdate', () => {
    test('extracts text + sender + chatId from message update', () => {
        const norm = normalizeUpdate({
            update_id: 42,
            message: {
                from: { id: 12345, username: 'alice' },
                chat: { id: -1001234 },
                text: 'hello bot'
            }
        });
        expect(norm).toEqual({
            senderId: 12345,
            senderName: 'alice',
            text: 'hello bot',
            chatId: -1001234,
            isCommand: false,
            updateId: 42
        });
    });

    test('handles edited_message identically', () => {
        const norm = normalizeUpdate({
            update_id: 7,
            edited_message: {
                from: { id: 9, first_name: 'Bob' },
                chat: { id: 1 },
                text: '/ask still here'
            }
        });
        expect(norm.senderName).toBe('Bob');
        expect(norm.isCommand).toBe(true);
    });

    test('falls back to caption when text missing', () => {
        const norm = normalizeUpdate({
            update_id: 8,
            message: {
                from: { id: 1 },
                chat: { id: 2 },
                caption: 'photo caption'
            }
        });
        expect(norm.text).toBe('photo caption');
    });

    test('returns null for empty / non-text updates', () => {
        expect(normalizeUpdate(null)).toBeNull();
        expect(normalizeUpdate({})).toBeNull();
        expect(normalizeUpdate({ update_id: 1, message: {} })).toBeNull();
        expect(normalizeUpdate({ update_id: 1, message: { from: { id: 1 }, chat: { id: 2 } } })).toBeNull();
    });

    test('synthesizes senderName from id when username/first_name missing', () => {
        const norm = normalizeUpdate({
            update_id: 1,
            message: { from: { id: 99 }, chat: { id: 0 }, text: 'hi' }
        });
        expect(norm.senderName).toBe('tg_99');
    });
});

describe('telegram-integration isAllowed', () => {
    test('matches numeric id in csv', () => {
        expect(isAllowed('111,222,333', 222)).toBe(true);
        expect(isAllowed('111,222,333', '222')).toBe(true);
    });

    test('rejects non-listed id', () => {
        expect(isAllowed('111,222', 999)).toBe(false);
    });

    test('treats empty whitelist as DENY (fail-closed)', () => {
        expect(isAllowed('', 1)).toBe(false);
        expect(isAllowed(null, 1)).toBe(false);
        expect(isAllowed(undefined, 1)).toBe(false);
    });

    test('tolerates whitespace and trailing commas', () => {
        expect(isAllowed(' 111 , 222 , ', 111)).toBe(true);
        expect(isAllowed(',,222,,', 222)).toBe(true);
    });
});
