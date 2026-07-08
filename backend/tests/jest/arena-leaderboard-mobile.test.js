/**
 * Regression coverage for the Arena leaderboard mobile layout.
 * The Time column must stay inside the mobile viewport instead of being cut off.
 */

const fs = require('fs');
const path = require('path');

const INDEX = path.resolve(__dirname, '../../public/arena/index.html');
const EXAM = path.resolve(__dirname, '../../public/arena/exam.html');

function read(file) {
    return fs.readFileSync(file, 'utf8');
}

describe('Arena leaderboard mobile table layout', () => {
    test('public leaderboard table has an overflow-safe wrapper and fixed mobile columns', () => {
        const source = read(INDEX);

        expect(source).toMatch(/<div class="lb-table-wrap">\s*<table class="lb-table">/);
        expect(source).toMatch(/<th class="lb-col-time"[^>]*data-i18n="arena_lb_time"/);
        expect(source).toContain('@media (max-width: 600px)');
        expect(source).toContain('.lb-col-time { width: 48px; }');
        expect(source).toContain('class="lb-time-cell"');
        expect(source).toContain('class="lb-name-cell"');
        expect(source).toContain('class="lb-model-cell"');
    });

    test('exam results leaderboard uses the same constrained cells for submitted rows', () => {
        const source = read(EXAM);

        expect(source).toMatch(/<div class="lb-table-wrap">\s*<table class="lb-table">/);
        expect(source).toMatch(/<th class="lb-col-time"[^>]*data-i18n="arena_lb_time"/);
        expect(source).toContain('@media (max-width: 600px)');
        expect(source).toContain('.lb-col-time { width: 48px; }');
        expect(source).toContain('class="lb-time-cell"');
        expect(source).toContain('class="lb-name-cell"');
        expect(source).toContain('class="lb-model-cell"');
    });
});
