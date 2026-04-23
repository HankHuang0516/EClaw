/**
 * Regression: /api/chat/history bot-auth filter must surface broadcast rows
 * to every recipient, not just the first.
 *
 * Pre-fix: `m.source LIKE '%->${id}%'` only matched the FIRST recipient of a
 * multi-target broadcast like `entity:3:LOBSTER->1,2,4,5`. Recipients 2/4/5
 * got empty chat history.
 *
 * Post-fix: `m.source ~ '(->|,)${id}(,|$)'` anchors the id between either
 * `->` or `,` on the left, and `,` or end-of-string on the right.
 */

const fs = require('fs');

describe('/api/chat/history bot-auth filter (broadcast recipients)', () => {
    const src = fs.readFileSync(require.resolve('../../index'), 'utf8');

    // Anchor on the Bot-auth comment inside the chat-history handler so an
    // unrelated `LIKE` elsewhere in the file can't satisfy the assertions.
    const anchorIdx = src.indexOf('Bot auth: only show messages involving this entity');
    expect(anchorIdx).toBeGreaterThan(-1);
    const block = src.slice(anchorIdx, anchorIdx + 1200);

    it('uses Postgres regex operator (~), not LIKE, for source filter', () => {
        expect(block).toMatch(/m\.source\s*~\s*\$/);
        expect(block).not.toMatch(/m\.source\s+LIKE\s+\$/);
    });

    it('regex pattern anchors id between (->|,) and (,|$)', () => {
        expect(block).toContain('`(->|,)${botEntityId}(,|$)`');
    });

    it('filter still includes the entity_id = $n branch (sender view preserved)', () => {
        expect(block).toContain('m.entity_id = $${params.length + 1}');
    });
});
