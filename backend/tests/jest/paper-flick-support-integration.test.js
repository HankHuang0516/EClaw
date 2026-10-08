const fs = require('fs');
const path = require('path');
const vm = require('vm');
const express = require('express');
const request = require('supertest');

const publicDir = path.resolve(__dirname, '../../public');
const canonicalPath = '/AiHankApps/guides/paper-flick-soldiers/';
const legacyPath = '/AiHankApps/support/paper-flick-soldiers/';
const legacy = fs.readFileSync(path.join(publicDir, legacyPath, 'index.html'), 'utf8');
const guide = fs.readFileSync(path.join(publicDir, canonicalPath, 'index.html'), 'utf8');

describe('Paper Flick Soldiers consolidated support', () => {
    const app = express();
    app.use(express.static(publicDir));

    test.each([
        ['', '', '#support'],
        ['?lang=en', '', '?lang=en#support'],
        ['?lang=zh&from=store', '#review-video', '?lang=zh&from=store#review-video'],
        ['?lang=en', '#privacy', '?lang=en#privacy'],
        ['', '#unknown', '#support'],
    ])('legacy entry preserves query and valid support anchors (%s %s)', (search, hash, suffix) => {
        const replace = jest.fn();
        const script = legacy.match(/<script>([\s\S]*?)<\/script>/)[1];
        vm.runInNewContext(script, { location: { search, hash, replace } });
        expect(replace).toHaveBeenCalledTimes(1);
        const target = new URL(replace.mock.calls[0][0], 'https://eclawbot.com' + legacyPath);
        expect(target.href).toBe('https://eclawbot.com' + canonicalPath + suffix);
    });

    test('legacy URL has a no-JavaScript redirect and accessible fallback', async () => {
        const response = await request(app).get(legacyPath).expect(200);
        expect(response.text).toContain('http-equiv="refresh"');
        expect(response.text).toContain('url=../../guides/paper-flick-soldiers/#support');
        expect(response.text).toContain('href="../../guides/paper-flick-soldiers/#support"');
        expect(response.text).not.toContain('<video');
    });

    test('QR canonical stays unchanged and download leads to its support section', async () => {
        const response = await request(app).get(canonicalPath).expect(200);
        expect(response.text).toContain('rel="canonical" href="https://eclawbot.com' + canonicalPath + '"');
        expect(response.text).toContain('id="support"');
        expect(response.text).toContain('href="#support"');
        expect(response.text).toContain('支援:#support');
        expect(response.text).toContain('https://play.google.com/store/apps/details?id=com.hankhuang.paperflicksoldiers');
        expect(response.text).toContain('https://apps.apple.com/tw/app/id6814515567');
        expect(response.text).not.toMatch(/正式版 1\.0\.0／Android BETA 1\.0\.4/);
    });

    test('preserves public support resources and original review video URL', async () => {
        await request(app).get('/AiHankApps/privacy/').expect(200);
        const response = await request(app)
            .get(legacyPath + 'media/paper-flick-soldiers-review-demo-v1.mp4')
            .set('Range', 'bytes=0-1023').expect(206);
        expect(response.headers['content-type']).toBe('video/mp4');
        expect(Number(response.headers['content-length'])).toBe(1024);
        expect(guide).toContain('../../support/paper-flick-soldiers/media/paper-flick-soldiers-review-demo-v1.mp4');
    });

    test('public support describes private feedback without embedding or fetching records', () => {
        const support = guide.slice(guide.indexOf('id="support"'));
        expect(support).toContain('不會展示在這個公開介紹頁');
        expect(support).toContain('installation identifier');
        expect(support).toContain('does not send account, device, or advertising identifiers');
        expect(support).toContain('lang="en"');
        expect(guide).not.toMatch(/\/api\/(?:admin|app-portfolio)\/[^"']*beta-feedback/);
        expect(guide).not.toMatch(/<form\b/i);
        expect(guide).toContain('preload="none"');
    });
});
