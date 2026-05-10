/**
 * Community SSR renderer contract — locks the SEO-critical bits so a future
 * styling tweak can't silently strip <title>, JSON-LD, canonical, or escaping.
 */

const ssr = require('../../community-ssr');

const SAMPLE = {
    publicCode: '31tlkr',
    name: 'Ｍac_ClaudeAce主管',
    character: 'LOBSTER',
    avatar: '🦸',
    agentCard: {
        tags: ['eclaw', 'commander', 'automation'],
        capabilities: ['orchestration', 'backend-dev'],
        protocols: ['A2A', 'HTTP'],
        description: 'EClaw 總指揮 Claude Code',
    },
    avgRating: 4.5,
    ratingCount: 12,
    messageCount: 87,
    publishedAt: '2026-04-25T05:46:43.886Z',
    level: 30,
    xp: 89380,
    state: 'IDLE',
};

describe('community-ssr.isValidPublicCode', () => {
    it('accepts 6-char alphanumeric codes', () => {
        expect(ssr.isValidPublicCode('31tlkr')).toBe(true);
        expect(ssr.isValidPublicCode('AbCd12')).toBe(true);
    });
    it('rejects bad shapes', () => {
        expect(ssr.isValidPublicCode('abc')).toBe(false);          // too short
        expect(ssr.isValidPublicCode('a'.repeat(20))).toBe(false); // too long
        expect(ssr.isValidPublicCode('has space')).toBe(false);
        expect(ssr.isValidPublicCode('drop;table')).toBe(false);
        expect(ssr.isValidPublicCode(null)).toBe(false);
        expect(ssr.isValidPublicCode(undefined)).toBe(false);
    });
});

describe('community-ssr.renderBotPageHtml', () => {
    const html = ssr.renderBotPageHtml(SAMPLE);

    it('emits <title> with bot name', () => {
        expect(html).toContain('<title>Ｍac_ClaudeAce主管 — EClawbot Bot Plaza</title>');
    });
    it('emits canonical link to /community/<code>', () => {
        expect(html).toContain('<link rel="canonical" href="https://eclawbot.com/community/31tlkr">');
    });
    it('emits Open Graph tags', () => {
        expect(html).toContain('property="og:title"');
        expect(html).toContain('property="og:url" content="https://eclawbot.com/community/31tlkr"');
    });
    it('emits a JSON-LD block with name + description', () => {
        const jsonLd = html.match(/<script type="application\/ld\+json">([\s\S]+?)<\/script>/);
        expect(jsonLd).toBeTruthy();
        const data = JSON.parse(jsonLd[1]);
        expect(data['@type']).toBe('WebPage');
        expect(data.name).toBe('Ｍac_ClaudeAce主管');
        expect(data.about.aggregateRating.ratingValue).toBe(4.5);
    });
    it('renders capabilities and tags as chips', () => {
        expect(html).toContain('orchestration');
        expect(html).toContain('eclaw');
        expect(html).toContain('A2A');
    });
    it('links the live plaza CTA with the bot code', () => {
        expect(html).toContain('href="https://eclawbot.com/portal/community.html?bot=31tlkr"');
    });
});

describe('community-ssr.renderBotPageHtml — escaping', () => {
    it('escapes HTML in name and description', () => {
        const card = {
            ...SAMPLE,
            name: '<script>alert(1)</script>',
            agentCard: { ...SAMPLE.agentCard, description: 'A & B "quoted" </script>' },
        };
        const html = ssr.renderBotPageHtml(card);
        expect(html).not.toContain('<script>alert(1)</script>');
        expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
        expect(html).toContain('A &amp; B &quot;quoted&quot; &lt;/script&gt;');
    });
    it('escapes </script> inside JSON-LD payload', () => {
        const card = { ...SAMPLE, name: 'Bot</script><img src=x>' };
        const html = ssr.renderBotPageHtml(card);
        const ldBlock = html.match(/<script type="application\/ld\+json">([\s\S]+?)<\/script>/)[1];
        expect(ldBlock).not.toContain('</script>');
        expect(ldBlock).toContain('\\u003c/script');
    });
    it('omits aggregateRating block when ratingCount is 0', () => {
        const card = { ...SAMPLE, ratingCount: 0, avgRating: 0 };
        const html = ssr.renderBotPageHtml(card);
        const ld = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]+?)<\/script>/)[1]);
        expect(ld.about.aggregateRating).toBeUndefined();
    });
});

describe('community-ssr.renderNotFoundHtml', () => {
    it('returns a noindex 404 page that escapes the requested code', () => {
        const html = ssr.renderNotFoundHtml('<bad>');
        expect(html).toContain('<meta name="robots" content="noindex">');
        expect(html).toContain('&lt;bad&gt;');
        expect(html).not.toContain('<bad>');
    });
});

describe('community-ssr.renderCommunitySitemapXml', () => {
    it('includes the plaza root + a per-bot URL for each entry', () => {
        const xml = ssr.renderCommunitySitemapXml([
            { publicCode: 'aaa111', publishedAt: '2026-04-01T00:00:00Z' },
            { publicCode: 'bbb222', publishedAt: '2026-05-09T00:00:00Z' },
        ]);
        expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
        expect(xml).toContain('<loc>https://eclawbot.com/portal/community.html</loc>');
        expect(xml).toContain('<loc>https://eclawbot.com/community/aaa111</loc>');
        expect(xml).toContain('<loc>https://eclawbot.com/community/bbb222</loc>');
        expect(xml).toContain('<lastmod>2026-04-01</lastmod>');
        expect(xml).toContain('<lastmod>2026-05-09</lastmod>');
    });
    it('handles empty bot list', () => {
        const xml = ssr.renderCommunitySitemapXml([]);
        expect(xml).toContain('<urlset');
        expect(xml).toContain('<loc>https://eclawbot.com/portal/community.html</loc>');
    });
});
