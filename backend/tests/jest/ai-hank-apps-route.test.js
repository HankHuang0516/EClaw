const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');

const backendDir = path.resolve(__dirname, '../..');
const serverSource = fs.readFileSync(path.join(backendDir, 'index.js'), 'utf8');
const portfolioDir = path.join(backendDir, 'public', 'AiHankApps');

describe('AiHankApps portfolio route', () => {
    test('redirects only the bare path and serves the trailing-slash URL', async () => {
        expect(serverSource).toContain("app.get(/^\\/AiHankApps$/");
        expect(serverSource).toContain("res.redirect(308, '/AiHankApps/')");
        expect(serverSource).toContain("app.use('/AiHankApps', express.static");

        const routeApp = express();
        routeApp.get(/^\/AiHankApps$/, (_req, res) => res.redirect(308, '/AiHankApps/'));
        routeApp.use('/AiHankApps', express.static(portfolioDir));

        const bareResponse = await request(routeApp).get('/AiHankApps');
        expect(bareResponse.status).toBe(308);
        expect(bareResponse.headers.location).toBe('/AiHankApps/');

        const pageResponse = await request(routeApp).get('/AiHankApps/');
        expect(pageResponse.status).toBe(200);
        expect(pageResponse.text).toContain('我的APP作品集');
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
