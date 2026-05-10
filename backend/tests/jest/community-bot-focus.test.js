const fs = require('fs');
const path = require('path');

const COMMUNITY_HTML = path.join(__dirname, '../../public/portal/community.html');
const COMMUNITY_SSR = path.join(__dirname, '../../community-ssr.js');

describe('community.html ?bot=<publicCode> auto-focus', () => {
    const html = fs.readFileSync(COMMUNITY_HTML, 'utf8');

    test('reads bot param via URLSearchParams', () => {
        expect(html).toMatch(/new URLSearchParams\(location\.search\)\.get\(['"]bot['"]\)/);
    });

    test('validates publicCode shape (4-12 alnum) before opening detail', () => {
        expect(html).toMatch(/\/\^\[a-z0-9\]\{4,12\}\$\/i\.test\(_focusBotCode\)/);
    });

    test('calls openDetail with the focus code', () => {
        expect(html).toMatch(/openDetail\(_focusBotCode\)/);
    });

    test('autoFocusBotFromQuery is invoked after entry-point branches', () => {
        const matches = html.match(/autoFocusBotFromQuery\(\)/g) || [];
        expect(matches.length).toBeGreaterThanOrEqual(2);
    });
});

describe('community-ssr.js liveUrl bridges to ?bot=<publicCode>', () => {
    const src = fs.readFileSync(COMMUNITY_SSR, 'utf8');

    test('liveUrl points to community.html?bot=<encoded publicCode>', () => {
        expect(src).toMatch(/community\.html\?bot=\$\{encodeURIComponent\(card\.publicCode\)\}/);
    });
});
