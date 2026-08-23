const community = require('../app-portfolio-community');

describe('app portfolio community validation', () => {
    test('accepts only portfolio app ids', () => {
        expect(community.isValidAppId('eclawbot')).toBe(true);
        expect(community.isValidAppId('unknown-app')).toBe(false);
    });

    test('hashes valid visitor ids without storing raw ids', () => {
        const value = 'visitor-1234567890';
        const hash = community.visitorHash(value);
        expect(hash).toHaveLength(64);
        expect(hash).not.toContain(value);
        expect(community.visitorHash('short')).toBeNull();
    });

    test('normalizes and limits public text', () => {
        expect(community.cleanText('  hello\r\nworld  ', 50)).toBe('hello\nworld');
        expect(community.cleanText('abcdef', 3)).toBe('abc');
        expect(community.cleanText(null, 20)).toBe('');
    });
});
