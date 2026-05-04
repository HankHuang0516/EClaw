/**
 * Regression: updatePrefs() merges with stored prefs instead of overwriting.
 *
 * Symptom (Hank, 2026-05-03, card_166b2d64ececb06d1feefb8f): user toggled all
 * 6 notification switches off in Settings, but server only persisted the last
 * one — the rest reverted to DEFAULT_PREFS=true and FCM pushes kept arriving.
 *
 * Root cause: settings.html#toggleNotifPref sends one key per PUT. The old
 * updatePrefs built a partial JSON from the request body and DO UPDATE SET
 * prefs = $2 — so each call overwrote the entire JSONB column with the
 * single-key payload.
 *
 * Fix: SELECT existing prefs, spread into the sanitized partial, then write.
 */

const { initNotificationTables, updatePrefs, getPrefs, DEFAULT_PREFS } = require('../../notifications');

function makeMockPool() {
    let stored = null; // null = no row yet
    const calls = [];
    return {
        async query(sql, params) {
            calls.push({ sql: sql.trim().slice(0, 60), params });
            if (/CREATE TABLE|CREATE INDEX/i.test(sql)) {
                return { rows: [] };
            }
            if (/^SELECT prefs FROM notification_preferences/i.test(sql.trim())) {
                if (stored === null) return { rows: [] };
                return { rows: [{ prefs: stored }] };
            }
            if (/INSERT INTO notification_preferences/i.test(sql)) {
                // Emulate `prefs = COALESCE(prefs,'{}'::jsonb) || EXCLUDED.prefs`
                // shallow-merge so the test exercises post-refactor behavior.
                const incoming = typeof params[1] === 'string' ? JSON.parse(params[1]) : params[1];
                if (stored === null) {
                    stored = JSON.stringify(incoming);
                } else {
                    const existing = typeof stored === 'string' ? JSON.parse(stored) : (stored || {});
                    stored = JSON.stringify({ ...existing, ...incoming });
                }
                return { rows: [], rowCount: 1 };
            }
            return { rows: [] };
        },
        _getStored() { return stored; },
        _calls: calls
    };
}

describe('updatePrefs — partial merge regression', () => {
    let pool;

    beforeEach(async () => {
        pool = makeMockPool();
        await initNotificationTables(pool);
    });

    test('first partial PUT writes only that key on top of defaults', async () => {
        await updatePrefs('dev1', { bot_reply: false });
        const prefs = await getPrefs('dev1');
        expect(prefs.bot_reply).toBe(false);
        expect(prefs.broadcast).toBe(true);
        expect(prefs.speak_to).toBe(true);
    });

    test('second partial PUT does NOT erase the first key', async () => {
        await updatePrefs('dev1', { bot_reply: false });
        await updatePrefs('dev1', { broadcast: false });
        const prefs = await getPrefs('dev1');
        expect(prefs.bot_reply).toBe(false); // ← would be true under the old bug
        expect(prefs.broadcast).toBe(false);
        expect(prefs.speak_to).toBe(true);
    });

    test('rapid sequence of 6 single-key toggles all persist', async () => {
        const keys = ['bot_reply', 'broadcast', 'speak_to', 'feedback_resolved', 'todo_done', 'scheduled'];
        for (const k of keys) {
            await updatePrefs('dev1', { [k]: false });
        }
        const prefs = await getPrefs('dev1');
        for (const k of keys) {
            expect(prefs[k]).toBe(false);
        }
        // platform_command was never touched → stays at default
        expect(prefs.platform_command).toBe(true);
    });

    test('toggling a key back to true preserves other false keys', async () => {
        await updatePrefs('dev1', { bot_reply: false });
        await updatePrefs('dev1', { broadcast: false });
        await updatePrefs('dev1', { bot_reply: true });
        const prefs = await getPrefs('dev1');
        expect(prefs.bot_reply).toBe(true);
        expect(prefs.broadcast).toBe(false);
    });

    test('full-blob PUT (all keys at once) still works', async () => {
        const allOff = {};
        for (const k of Object.keys(DEFAULT_PREFS)) allOff[k] = false;
        await updatePrefs('dev1', allOff);
        const prefs = await getPrefs('dev1');
        for (const k of Object.keys(DEFAULT_PREFS)) {
            expect(prefs[k]).toBe(false);
        }
    });

    test('unknown keys in the PUT body are ignored, not persisted', async () => {
        await updatePrefs('dev1', { bot_reply: false, evil_key: true, __proto__: { polluted: true } });
        const prefs = await getPrefs('dev1');
        expect(prefs.bot_reply).toBe(false);
        expect(prefs.evil_key).toBeUndefined();
    });
});
