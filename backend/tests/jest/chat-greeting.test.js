
describe('greet banner — theme-token regression guard (card_079ea943)', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'portal', 'chat.html'), 'utf8');
    const tokens = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'portal', 'shared', 'style.css'), 'utf8');

    test('banner uses REAL tokens (--card/--card-border/--text), not phantom --bg-card', () => {
        const block = src.slice(src.indexOf('.greet-banner {'), src.indexOf('.greet-banner-text'));
        expect(block).toMatch(/background: var\(--card, #1A1A2E\)/);
        expect(block).toMatch(/color: var\(--text, #ffffff\)/);
        expect(block).not.toMatch(/--bg-card/);
    });
    test('every var() token referenced by the greet block is defined in style.css :root', () => {
        const block = src.slice(src.indexOf('.greet-banner {'), src.indexOf('.density-switcher'));
        const used = [...new Set([...block.matchAll(/var\((--[a-z-]+)/g)].map(m => m[1]))];
        for (const t of used) {
            expect(tokens).toMatch(new RegExp(t.replace(/[-]/g, '\\-') + '\\s*:'));
        }
    });
});
