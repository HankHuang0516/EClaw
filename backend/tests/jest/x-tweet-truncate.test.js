const { truncateTweet, X_TWEET_WEIGHTED_LIMIT } = require('../../article-publisher');
const twitterText = require('twitter-text');

function weighted(text) {
    return twitterText.parseTweet(text).weightedLength;
}

describe('truncateTweet', () => {
    it('passes short ASCII through unchanged', () => {
        const r = truncateTweet('Hello world');
        expect(r.truncated).toBe(false);
        expect(r.text).toBe('Hello world');
        expect(r.originalWeighted).toBe(11);
    });

    it('passes exactly-280 ASCII through unchanged', () => {
        const input = 'a'.repeat(280);
        const r = truncateTweet(input);
        expect(r.truncated).toBe(false);
        expect(r.text).toBe(input);
    });

    it('truncates 281 ASCII to fit weighted 280', () => {
        const r = truncateTweet('a'.repeat(281));
        expect(r.truncated).toBe(true);
        expect(weighted(r.text)).toBeLessThanOrEqual(X_TWEET_WEIGHTED_LIMIT);
        expect(r.text.endsWith('…')).toBe(true);
    });

    it('truncates long ASCII', () => {
        const r = truncateTweet('a'.repeat(500));
        expect(r.truncated).toBe(true);
        expect(weighted(r.text)).toBeLessThanOrEqual(X_TWEET_WEIGHTED_LIMIT);
    });

    it('treats CJK chars as weight 2', () => {
        const input = '測'.repeat(145);
        expect(weighted(input)).toBe(290);
        const r = truncateTweet(input);
        expect(r.truncated).toBe(true);
        expect(weighted(r.text)).toBeLessThanOrEqual(X_TWEET_WEIGHTED_LIMIT);
        expect(r.text.endsWith('…')).toBe(true);
    });

    it('passes CJK text at exactly weighted 280 unchanged', () => {
        const input = '測'.repeat(140);
        expect(weighted(input)).toBe(280);
        const r = truncateTweet(input);
        expect(r.truncated).toBe(false);
        expect(r.text).toBe(input);
    });

    it('keeps URL intact when truncating body around it', () => {
        const input = 'Check this out https://example.com/path ' + 'x'.repeat(300);
        const r = truncateTweet(input);
        expect(r.truncated).toBe(true);
        expect(weighted(r.text)).toBeLessThanOrEqual(X_TWEET_WEIGHTED_LIMIT);
        expect(r.text.includes('https://example.com/path')).toBe(true);
    });

    it('reports originalWeighted reflecting pre-truncation length', () => {
        const r = truncateTweet('a'.repeat(400));
        expect(r.originalWeighted).toBe(400);
    });

    it('handles null input without throwing', () => {
        const r = truncateTweet(null);
        expect(r.truncated).toBe(false);
        expect(r.text).toBe('');
        expect(r.originalWeighted).toBe(0);
    });

    it('handles undefined input without throwing', () => {
        const r = truncateTweet(undefined);
        expect(r.truncated).toBe(false);
        expect(r.text).toBe('');
        expect(r.originalWeighted).toBe(0);
    });

    it('handles empty string without truncating', () => {
        const r = truncateTweet('');
        expect(r.truncated).toBe(false);
        expect(r.text).toBe('');
        expect(r.originalWeighted).toBe(0);
    });

    it('handles pure-URL tweet (t.co weighted = 23)', () => {
        const r = truncateTweet('https://example.com/very/long/path/that/doesnt/matter');
        expect(r.truncated).toBe(false);
        expect(r.originalWeighted).toBe(23);
    });

    it('handles multiple URLs in one tweet', () => {
        const urls = Array(12).fill('https://example.com').join(' ');
        const r = truncateTweet(urls);
        // 12 URLs × 23 + 11 spaces = 287 > 280
        expect(r.truncated).toBe(true);
        expect(weighted(r.text)).toBeLessThanOrEqual(X_TWEET_WEIGHTED_LIMIT);
    });

    it('handles emoji and ZWJ sequences', () => {
        const emoji = '👨‍👩‍👧‍👦'.repeat(50) + 'a'.repeat(200);
        const r = truncateTweet(emoji);
        expect(r.truncated).toBe(true);
        expect(weighted(r.text)).toBeLessThanOrEqual(X_TWEET_WEIGHTED_LIMIT);
    });
});
