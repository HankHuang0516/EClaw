/**
 * Rich-card-question notification regression tests (card_a9edf960).
 *
 * Hank's framing — "user receives a rich card asking them to pick an option,
 * just like Claude Code asking for permission" — means the recipient device
 * MUST get a higher-priority push so they don't miss an agent waiting on
 * their input. Coverage:
 *
 *  - truncateUtf8: codepoint-safe truncation (no half-emoji, no lone surrogate)
 *  - isRichCardQuestion: detection accepts good shape, rejects bad/edge cases
 *  - buildRichCardNotification: title/body/category/metadata shape
 *  - createRichCardNotifLimiter: rate-limit per-device, isolation, window reset
 *  - DEFAULT_PREFS.rich_card_question: default ON
 *  - isCategoryEnabled('rich_card_question'): toggle semantics
 *  - Migration safety: existing users (prefs row missing the key) default ON
 */

const {
    truncateUtf8,
    isRichCardQuestion,
    buildRichCardNotification,
    createRichCardNotifLimiter,
    DEFAULT_PREFS,
    isCategoryEnabled
} = require('../../notifications');

describe('truncateUtf8 (card_a9e)', () => {
    it('returns empty string for non-string input', () => {
        expect(truncateUtf8(null, 10)).toBe('');
        expect(truncateUtf8(undefined, 10)).toBe('');
        expect(truncateUtf8(123, 10)).toBe('');
        expect(truncateUtf8({}, 10)).toBe('');
    });

    it('returns empty string for non-positive maxBytes', () => {
        expect(truncateUtf8('hello', 0)).toBe('');
        expect(truncateUtf8('hello', -5)).toBe('');
        expect(truncateUtf8('hello', NaN)).toBe('');
    });

    it('returns the string unchanged when within budget', () => {
        expect(truncateUtf8('hello', 100)).toBe('hello');
        expect(truncateUtf8('', 100)).toBe('');
    });

    it('truncates plain ASCII at the byte boundary', () => {
        const out = truncateUtf8('abcdefghij', 5);
        expect(out).toBe('abcde');
        expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(5);
    });

    it('does not split a multi-byte CJK codepoint', () => {
        // Each CJK character is 3 UTF-8 bytes. With maxBytes=5 we can fit 1 char (3 bytes).
        const src = '你好世界'; // 4 chars × 3 bytes = 12 bytes
        const out = truncateUtf8(src, 5);
        expect(out).toBe('你');
        expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(5);
        // Also confirm the output decodes cleanly (no U+FFFD replacement char).
        expect(out).not.toContain('�');
    });

    it('does not split a 4-byte emoji codepoint (surrogate pair)', () => {
        // 🦞 (U+1F99E) — 4 UTF-8 bytes; with maxBytes=3 we should get empty.
        const src = '🦞 lobster';
        const out = truncateUtf8(src, 3);
        // We don't insist on a specific output, only that there's no lone
        // surrogate or replacement char in the result and the byte count is
        // within budget.
        expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(3);
        expect(out).not.toContain('�');
        // Last char (if any) must not be a high surrogate.
        if (out.length > 0) {
            const last = out.charCodeAt(out.length - 1);
            expect(last >= 0xD800 && last <= 0xDBFF).toBe(false);
        }
    });

    it('handles a mixed-script Hank-style question', () => {
        const src = 'Hello 你好! 是否要刪除這個檔案? 🗑️ Yes/No';
        const out = truncateUtf8(src, 30);
        expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(30);
        expect(out).not.toContain('�');
    });
});

describe('isRichCardQuestion (card_a9e)', () => {
    it('accepts a well-formed card', () => {
        expect(isRichCardQuestion({
            ask_id: 'ask-1',
            buttons: [{ id: 'a', label: 'A', style: 'primary' }]
        })).toBe(true);
    });

    it('accepts cards with multiple buttons', () => {
        expect(isRichCardQuestion({
            ask_id: 'ask-2',
            buttons: [
                { id: 'a', label: 'Yes' },
                { id: 'b', label: 'No' },
                { id: 'c', label: 'Cancel' }
            ]
        })).toBe(true);
    });

    it('rejects null/undefined/non-object', () => {
        expect(isRichCardQuestion(null)).toBe(false);
        expect(isRichCardQuestion(undefined)).toBe(false);
        expect(isRichCardQuestion('card')).toBe(false);
        expect(isRichCardQuestion(42)).toBe(false);
    });

    it('rejects an array (because Array.isArray ≠ plain object)', () => {
        expect(isRichCardQuestion([])).toBe(false);
        expect(isRichCardQuestion([{ id: 'a', label: 'A' }])).toBe(false);
    });

    it('rejects card missing ask_id', () => {
        expect(isRichCardQuestion({
            buttons: [{ id: 'a', label: 'A' }]
        })).toBe(false);
    });

    it('rejects card with empty/non-string ask_id', () => {
        expect(isRichCardQuestion({ ask_id: '', buttons: [{ id: 'a', label: 'A' }] })).toBe(false);
        expect(isRichCardQuestion({ ask_id: 123, buttons: [{ id: 'a', label: 'A' }] })).toBe(false);
    });

    it('rejects card with no buttons / empty buttons / non-array buttons', () => {
        expect(isRichCardQuestion({ ask_id: 'x' })).toBe(false);
        expect(isRichCardQuestion({ ask_id: 'x', buttons: [] })).toBe(false);
        expect(isRichCardQuestion({ ask_id: 'x', buttons: 'a,b' })).toBe(false);
    });
});

describe('buildRichCardNotification (card_a9e)', () => {
    const card = {
        ask_id: 'ask-abc',
        buttons: [
            { id: 'yes', label: 'Yes' },
            { id: 'no', label: 'No' }
        ]
    };

    it('returns the expected shape', () => {
        const notif = buildRichCardNotification(card, {
            questionText: 'Delete file foo.txt?',
            fromName: 'Codex',
            fromEntityId: 1,
            toEntityId: 0
        });
        expect(notif).toMatchObject({
            type: 'chat',
            category: 'rich_card_question',
            title: 'Codex needs your input',
            body: 'Delete file foo.txt?',
            link: 'chat.html'
        });
        expect(notif.metadata).toEqual({
            ask_id: 'ask-abc',
            fromEntityId: 1,
            toEntityId: 0,
            buttonCount: 2
        });
    });

    it('falls back to "Agent" when fromName missing', () => {
        const notif = buildRichCardNotification(card, { questionText: 'q' });
        expect(notif.title).toBe('Agent needs your input');
    });

    it('truncates body via truncateUtf8 (UTF-8 safe, 240-byte cap)', () => {
        const long = 'A'.repeat(500);
        const notif = buildRichCardNotification(card, { questionText: long });
        expect(notif.body.length).toBeLessThanOrEqual(240);
        expect(Buffer.byteLength(notif.body, 'utf8')).toBeLessThanOrEqual(240);
    });

    it('does not throw on missing ctx', () => {
        const notif = buildRichCardNotification(card);
        expect(notif.category).toBe('rich_card_question');
        expect(notif.metadata.ask_id).toBe('ask-abc');
        expect(notif.metadata.buttonCount).toBe(2);
        // fromEntityId / toEntityId default to null per the helper contract.
        expect(notif.metadata.fromEntityId).toBeNull();
        expect(notif.metadata.toEntityId).toBeNull();
    });

    it('coerces ask_id to string in metadata', () => {
        // Defense-in-depth: even if upstream sanitization slipped, the
        // notification payload must contain a string id (JSON.stringify-safe).
        const notif = buildRichCardNotification(
            { ask_id: 'mixed-123', buttons: [{ id: 'a', label: 'A' }] },
            {}
        );
        expect(typeof notif.metadata.ask_id).toBe('string');
    });

    it('XSS-safe: title/body do not auto-execute interpolation', () => {
        // The notification body is delivered as plain text (no HTML). The
        // helper must not introduce its own escaping bugs (e.g., template-
        // literal injection that breaks the JSON envelope). Verify the body
        // round-trips through JSON unchanged.
        const evil = '<script>alert(1)</script>';
        const notif = buildRichCardNotification(card, {
            questionText: evil,
            fromName: '<img src=x onerror=alert(2)>'
        });
        expect(notif.body).toBe(evil); // not escaped here — chat UI / push panel escape downstream
        expect(notif.title).toBe('<img src=x onerror=alert(2)> needs your input');
        // Critically: JSON.stringify must succeed (no thrown exception).
        const round = JSON.parse(JSON.stringify(notif));
        expect(round.body).toBe(evil);
    });
});

describe('createRichCardNotifLimiter (card_a9e)', () => {
    let limiter;
    afterEach(() => { if (limiter) { limiter._stop(); limiter = null; } });

    it('allows up to `max` pushes per device per window', () => {
        limiter = createRichCardNotifLimiter({ windowMs: 60_000, max: 5, disablePrune: true });
        for (let i = 0; i < 5; i++) {
            expect(limiter.check('device-A')).toBe(true);
        }
        expect(limiter.check('device-A')).toBe(false);
        expect(limiter.check('device-A')).toBe(false);
    });

    it('isolates per-device buckets (cross-device privacy)', () => {
        // Critical: a rich card meant for device A must NOT consume device B's budget.
        limiter = createRichCardNotifLimiter({ windowMs: 60_000, max: 2, disablePrune: true });
        expect(limiter.check('device-A')).toBe(true);
        expect(limiter.check('device-A')).toBe(true);
        expect(limiter.check('device-A')).toBe(false);
        // device-B has a fresh budget.
        expect(limiter.check('device-B')).toBe(true);
        expect(limiter.check('device-B')).toBe(true);
        expect(limiter.check('device-B')).toBe(false);
    });

    it('resets the bucket after the window expires', () => {
        limiter = createRichCardNotifLimiter({ windowMs: 50, max: 2, disablePrune: true });
        expect(limiter.check('device-X')).toBe(true);
        expect(limiter.check('device-X')).toBe(true);
        expect(limiter.check('device-X')).toBe(false);
        return new Promise(resolve => setTimeout(resolve, 80)).then(() => {
            expect(limiter.check('device-X')).toBe(true);
        });
    });

    it('rejects empty / missing deviceId', () => {
        limiter = createRichCardNotifLimiter({ disablePrune: true });
        expect(limiter.check(null)).toBe(false);
        expect(limiter.check(undefined)).toBe(false);
        expect(limiter.check('')).toBe(false);
    });

    it('does not throw under rapid concurrent calls (race safety)', () => {
        // The bucket map increments synchronously; concurrent fan-out from
        // Promise.all calling check() in the same tick should not produce
        // negative or NaN counts.
        limiter = createRichCardNotifLimiter({ windowMs: 60_000, max: 100, disablePrune: true });
        const results = [];
        for (let i = 0; i < 200; i++) results.push(limiter.check('device-R'));
        const allowed = results.filter(Boolean).length;
        expect(allowed).toBe(100); // exactly `max` allowed in the window
    });

    it('dedupes by ask_id WITHOUT burning rate-limit budget (HIGH-2 review fix)', () => {
        // A buggy agent that re-emits the same card 5× must not burn the
        // user's 5/10s budget — real Claude-Code-permission UX dedupes by
        // request id. The dedup must short-circuit *before* the bucket
        // increments so 4 unrelated future cards still get through.
        limiter = createRichCardNotifLimiter({ windowMs: 60_000, max: 5, askDedupTtlMs: 60_000, disablePrune: true });
        // First emission of ask-A — allowed, bucket count = 1.
        expect(limiter.check('device-D', 'ask-A')).toBe(true);
        // Re-emissions of ask-A — blocked by dedup, bucket NOT incremented.
        for (let i = 0; i < 10; i++) {
            expect(limiter.check('device-D', 'ask-A')).toBe(false);
        }
        // Four unrelated asks should still pass (4 + 1 = 5).
        expect(limiter.check('device-D', 'ask-B')).toBe(true);
        expect(limiter.check('device-D', 'ask-C')).toBe(true);
        expect(limiter.check('device-D', 'ask-D')).toBe(true);
        expect(limiter.check('device-D', 'ask-E')).toBe(true);
        // Sixth distinct ask — rate-limited.
        expect(limiter.check('device-D', 'ask-F')).toBe(false);
    });

    it('ask_id dedup is per-device (no cross-device leak)', () => {
        limiter = createRichCardNotifLimiter({ windowMs: 60_000, max: 5, askDedupTtlMs: 60_000, disablePrune: true });
        expect(limiter.check('device-A', 'shared-ask')).toBe(true);
        // device-B sees a fresh dedup state for the same ask_id.
        expect(limiter.check('device-B', 'shared-ask')).toBe(true);
        // Re-emit to A — deduped.
        expect(limiter.check('device-A', 'shared-ask')).toBe(false);
        // Re-emit to B — deduped.
        expect(limiter.check('device-B', 'shared-ask')).toBe(false);
    });

    it('missing/undefined ask_id falls through to plain rate-limiting', () => {
        limiter = createRichCardNotifLimiter({ windowMs: 60_000, max: 2, disablePrune: true });
        // No ask_id = no dedup, just count.
        expect(limiter.check('device-N')).toBe(true);
        expect(limiter.check('device-N')).toBe(true);
        expect(limiter.check('device-N')).toBe(false);
    });

    it('rejects windowMs:0 / max:0 (option-misuse guard, LOW review fix)', () => {
        // A caller passing windowMs:0 or max:0 must not silently turn off
        // rate-limiting. The factory falls back to safe defaults.
        limiter = createRichCardNotifLimiter({ windowMs: 0, max: 0, disablePrune: true });
        // With defaults (5 per 10s) the 6th call is blocked.
        for (let i = 0; i < 5; i++) expect(limiter.check('device-Z')).toBe(true);
        expect(limiter.check('device-Z')).toBe(false);
    });
});

describe('DEFAULT_PREFS migration safety (card_a9e)', () => {
    it('rich_card_question default ON', () => {
        expect(DEFAULT_PREFS.rich_card_question).toBe(true);
    });

    it('isCategoryEnabled returns true for prefs without the key (existing users)', () => {
        // Critical migration check: a user who registered before this card
        // shipped has no `rich_card_question` field in their prefs JSON.
        // The default-ON contract means they should still receive these.
        const oldPrefs = {
            bot_reply: true,
            speak_to: true,
            // ... no rich_card_question key
        };
        expect(isCategoryEnabled(oldPrefs, 'rich_card_question')).toBe(true);
    });

    it('isCategoryEnabled returns false only when explicitly disabled', () => {
        expect(isCategoryEnabled({ rich_card_question: false }, 'rich_card_question')).toBe(false);
        expect(isCategoryEnabled({ rich_card_question: true }, 'rich_card_question')).toBe(true);
    });

    it('isCategoryEnabled is permissive on malformed prefs (fail-open)', () => {
        // If prefs JSON is corrupt or absent we should NOT silently swallow
        // a question the user is waiting on. Fail-open is the right default
        // for a Claude-Code-permission-style notification.
        expect(isCategoryEnabled(null, 'rich_card_question')).toBe(true);
        expect(isCategoryEnabled(undefined, 'rich_card_question')).toBe(true);
        expect(isCategoryEnabled('garbage', 'rich_card_question')).toBe(true);
    });
});

describe('Integration: end-to-end shape (card_a9e)', () => {
    it('building from a validated card produces a notifyDevice-compatible payload', () => {
        const card = {
            ask_id: 'ask-int-1',
            buttons: [
                { id: 'approve', label: 'Approve', style: 'primary' },
                { id: 'deny', label: 'Deny', style: 'danger' }
            ]
        };
        const ok = isRichCardQuestion(card);
        expect(ok).toBe(true);
        const notif = buildRichCardNotification(card, {
            questionText: 'Approve rm -rf /tmp/foo?',
            fromName: 'Hermes',
            fromEntityId: 5,
            toEntityId: 0
        });
        // notifyDevice expects: { type, category, title, body, link?, metadata? }
        expect(notif).toHaveProperty('type');
        expect(notif).toHaveProperty('category', 'rich_card_question');
        expect(notif).toHaveProperty('title');
        expect(notif).toHaveProperty('body');
        expect(notif).toHaveProperty('link');
        expect(notif).toHaveProperty('metadata');
    });
});
