/**
 * Tumblr NPF referral-CTA formatting ranges must be in UNICODE CODE POINTS,
 * not JS UTF-16 code units (card_2992f6a2). The zh-TW CTA text starts with an
 * emoji (surrogate pair), so `.length`-based ranges overrun by 1 and Tumblr
 * rejects the whole post with 400 Bad Request.
 *
 * Repro: fails on old code (end === UTF-16 length 8 > code points 7),
 * passes on the fix (ranges counted via [...text].length).
 */
const { buildReferralCTA } = require('../../article-publisher');

const codePoints = (s) => [...s].length;

describe('buildReferralCTA npf formatting ranges (Tumblr code-point rule)', () => {
    for (const locale of ['zh-TW', 'en']) {
        test(`${locale}: every formatting range fits within the code-point length`, () => {
            const blocks = buildReferralCTA({ format: 'npf', locale });
            expect(Array.isArray(blocks)).toBe(true);
            for (const b of blocks) {
                for (const f of b.formatting || []) {
                    expect(f.start).toBeGreaterThanOrEqual(0);
                    // end is exclusive; must not exceed the code-point count
                    expect(f.end).toBeLessThanOrEqual(codePoints(b.text));
                }
            }
        });
    }

    test('zh-TW link range covers the FULL cta text in code points (emoji-safe)', () => {
        const blocks = buildReferralCTA({ format: 'npf', locale: 'zh-TW' });
        const link = blocks.find(b => (b.formatting || []).some(f => f.type === 'link'));
        const f = link.formatting.find(f => f.type === 'link');
        expect(f.end).toBe(codePoints(link.text)); // old code: UTF-16 length ⇒ mismatch when emoji present
    });
});
