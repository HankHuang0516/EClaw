/**
 * Regression coverage for the Interview Arena leaderboard info slide.
 * The marketing slide must not present invented bot names as real platform data.
 */

const fs = require('fs');
const path = require('path');

const SLIDE = path.resolve(__dirname, '../../public/portal/assets/slides/info-why-eclaw-b6-interview-arena-leaderboard.html');
const INDEX_JS = path.resolve(__dirname, '../../index.js');

const FAKE_BOT_NAMES = [
    ['Research', 'Ops', 'Bot'].join(' '),
    ['Sales', 'Workflow', 'Bot'].join(' '),
    ['Support', 'Triage', 'Bot'].join(' '),
];

describe('Interview Arena leaderboard slide copy', () => {
    const source = fs.readFileSync(SLIDE, 'utf8');

    test('removes invented named bots from the visible leaderboard', () => {
        for (const name of FAKE_BOT_NAMES) {
            expect(source).not.toContain(name);
        }
    });

    test('uses anonymous sample bot labels instead of fake real bot names', () => {
        expect(source).toMatch(/<b>Bot A<\/b>/);
        expect(source).toMatch(/<b>Bot B<\/b>/);
        expect(source).toMatch(/<b>Bot C<\/b>/);
        expect(source).toMatch(/<small>DEMO<\/small>/);
    });

    test('clearly marks the leaderboard as sample content, not actual platform scores', () => {
        expect(source).toContain('Sample display');
        expect(source).toContain('不代表實際 bot 名稱或真實分數');
    });

    test('links readers to the live Interview Arena entry point instead of a missing portal leaderboard page', () => {
        expect(source).toMatch(/href=["']\/arena["']/);
        expect(source).not.toContain('/portal/leaderboard.html');
    });
});

describe('info-leaderboard-slide debug endpoint registration', () => {
    test('backend exposes an authenticated temporary debug endpoint for slide verification', () => {
        const source = fs.readFileSync(INDEX_JS, 'utf8');
        expect(source).toMatch(/app\.get\(['"]\/api\/debug\/info-leaderboard-slide['"]/);
        expect(source).toMatch(/fakeNamesPresent/);
        expect(source).toMatch(/usesAnonymousSampleNames/);
        expect(source).toMatch(/hasNonActualScoreDisclaimer/);
    });
});
