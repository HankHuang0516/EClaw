/**
 * Publisher referral CTA helper tests (slice 4/4 of card_ced134b5)
 *
 * Verifies appendReferralCTA() / buildReferralCTA() output for md, html, npf
 * formats and the includeReferralCTA=false opt-out path.
 *
 * Pure unit tests — no DB, no HTTP. Helper is exported from article-publisher.js.
 */

const { appendReferralCTA, buildReferralCTA, REFERRAL_CTA_URL } = require('../../article-publisher');

describe('buildReferralCTA', () => {
    it('produces zh-TW markdown by default', () => {
        const out = buildReferralCTA();
        expect(out).toContain('喜歡這篇嗎');
        expect(out).toContain('邀請人 +500 e幣');
        expect(out).toContain(REFERRAL_CTA_URL);
        expect(out).toMatch(/^\n\n---/);
    });

    it('produces English markdown when locale=en', () => {
        const out = buildReferralCTA({ format: 'md', locale: 'en' });
        expect(out).toContain('Enjoyed this');
        expect(out).toContain('+100 e-coins');
        expect(out).toContain(`(${REFERRAL_CTA_URL})`);
    });

    it('produces HTML with hr separator', () => {
        const out = buildReferralCTA({ format: 'html' });
        expect(out).toContain('<hr/>');
        expect(out).toContain(`<a href="${REFERRAL_CTA_URL}">`);
    });

    it('produces NPF block array for Tumblr', () => {
        const out = buildReferralCTA({ format: 'npf' });
        expect(Array.isArray(out)).toBe(true);
        expect(out.length).toBeGreaterThanOrEqual(4);
        const linkBlock = out.find(b => b.formatting?.some(f => f.type === 'link'));
        expect(linkBlock).toBeDefined();
        expect(linkBlock.formatting[0].url).toBe(REFERRAL_CTA_URL);
    });

    it('produces Telegraph node objects with proper tag/children/attrs structure', () => {
        const out = buildReferralCTA({ format: 'telegraph-nodes' });
        expect(Array.isArray(out)).toBe(true);
        // First node is <hr>
        expect(out[0]).toEqual({ tag: 'hr' });
        // Anchor node carries href in attrs
        const anchor = out
            .flatMap(n => n.children || [])
            .find(c => typeof c === 'object' && c.tag === 'a');
        expect(anchor).toBeDefined();
        expect(anchor.attrs.href).toBe(REFERRAL_CTA_URL);
        // No raw HTML strings — every node is an object so Telegraph won't render literal markup
        const hasRawHtmlString = out.some(n => typeof n === 'string' && n.includes('<'));
        expect(hasRawHtmlString).toBe(false);
    });

    it('throws on unknown format', () => {
        expect(() => buildReferralCTA({ format: 'rtf' })).toThrow(/Unknown referral CTA format/);
    });

    it('falls back to zh-TW when locale unknown', () => {
        const out = buildReferralCTA({ format: 'md', locale: 'klingon' });
        expect(out).toContain('喜歡這篇嗎');
    });
});

describe('appendReferralCTA', () => {
    it('appends md CTA to a markdown body', () => {
        const original = '# Hello\n\nbody text';
        const out = appendReferralCTA(original, { format: 'md', locale: 'en' });
        expect(out.startsWith(original)).toBe(true);
        expect(out).toContain('Enjoyed this');
        expect(out).toContain(REFERRAL_CTA_URL);
    });

    it('appends html CTA to an html body', () => {
        const original = '<p>article content</p>';
        const out = appendReferralCTA(original, { format: 'html' });
        expect(out.startsWith(original)).toBe(true);
        expect(out).toContain('<hr/>');
    });

    it('concatenates NPF blocks for Tumblr arrays', () => {
        const original = [{ type: 'text', text: 'body' }];
        const out = appendReferralCTA(original, { format: 'npf' });
        expect(out[0]).toEqual(original[0]);
        expect(out.length).toBeGreaterThan(original.length);
    });

    it('returns body unchanged when skip=true', () => {
        const original = 'untouched body';
        const out = appendReferralCTA(original, { format: 'md', skip: true });
        expect(out).toBe(original);
    });

    it('handles empty/null body for md', () => {
        expect(appendReferralCTA('', { format: 'md' })).toContain(REFERRAL_CTA_URL);
        expect(appendReferralCTA(null, { format: 'md' })).toContain(REFERRAL_CTA_URL);
    });

    it('handles empty NPF array', () => {
        const out = appendReferralCTA(null, { format: 'npf' });
        expect(Array.isArray(out)).toBe(true);
        expect(out.length).toBeGreaterThan(0);
        // First appended block is the heading
        expect(out[0].subtype).toBe('heading2');
    });

    it('concatenates Telegraph nodes after existing nodes', () => {
        const original = [{ tag: 'p', children: ['hello'] }];
        const out = appendReferralCTA(original, { format: 'telegraph-nodes' });
        expect(out[0]).toEqual(original[0]);
        // CTA's first node (hr) follows original
        expect(out[1]).toEqual({ tag: 'hr' });
    });
});

describe('REFERRAL_CTA_URL constant', () => {
    it('points at the canonical invite page', () => {
        expect(REFERRAL_CTA_URL).toBe('https://eclawbot.com/portal/invite.html');
    });
});
