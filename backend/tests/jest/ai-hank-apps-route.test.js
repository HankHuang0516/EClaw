const fs = require('fs');
const path = require('path');

const backendDir = path.resolve(__dirname, '../..');
const serverSource = fs.readFileSync(path.join(backendDir, 'index.js'), 'utf8');
const portfolioDir = path.join(backendDir, 'public', 'AiHankApps');

describe('AiHankApps portfolio route', () => {
    test('redirects the bare path and serves the portfolio directory', () => {
        expect(serverSource).toContain("app.get('/AiHankApps'");
        expect(serverSource).toContain("res.redirect(308, '/AiHankApps/')");
        expect(serverSource).toContain("app.use('/AiHankApps', express.static");
    });

    test('includes the portfolio page and promotional images', () => {
        const htmlPath = path.join(portfolioDir, 'index.html');
        expect(fs.existsSync(htmlPath)).toBe(true);

        const html = fs.readFileSync(htmlPath, 'utf8');
        expect(html).toContain('我的APP作品集');
        expect(html).toContain("promo/eclawbot.jpg");
        expect(fs.existsSync(path.join(portfolioDir, 'promo', 'eclawbot.jpg'))).toBe(true);
    });
});
