/**
 * petdex-route — /api/petdx/:slug/avatar.webp (Plaza Plan-3 Phase 4)
 *
 * Pure route test: inject a fake R2 (S3) client via createRouter({ r2 }), so no
 * network/AWS. Asserts the avatar.webp route mirrors sprite.webp: 200 + webp
 * when the key exists, 404 on missing key, 404 on bad slug (whitelist guard).
 */

const express = require('express');
const request = require('supertest');
const { Readable } = require('stream');
const { createRouter } = require('../../petdex-route');

// Fake R2: resolves a webp Body for keys we "have", throws NoSuchKey otherwise.
function makeFakeR2(presentKeys) {
    return {
        send(cmd) {
            const key = cmd.input.Key;
            if (presentKeys.has(key)) {
                const bytes = Buffer.from('RIFF....WEBPfake'); // stand-in payload
                return Promise.resolve({
                    Body: Readable.from([bytes]),
                    ContentLength: bytes.length,
                    ETag: '"deadbeef"',
                });
            }
            const err = new Error('not found');
            err.name = 'NoSuchKey';
            err.$metadata = { httpStatusCode: 404 };
            return Promise.reject(err);
        },
    };
}

function appWith(presentKeys) {
    const app = express();
    app.use('/api/petdx', createRouter({ r2: makeFakeR2(presentKeys), bucket: 'test-bucket' }));
    return app;
}

describe('GET /api/petdx/:slug/avatar.webp', () => {
    it('200 + image/webp when the avatar key exists in R2', async () => {
        const app = appWith(new Set(['petdx-sprites/zoro/avatar.webp']));
        const res = await request(app).get('/api/petdx/zoro/avatar.webp');
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toBe('image/webp');
        expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
        expect(res.body.length).toBeGreaterThan(0);
    });

    it('404 when the avatar key is missing (NoSuchKey)', async () => {
        const app = appWith(new Set()); // nothing in R2
        const res = await request(app).get('/api/petdx/zoro/avatar.webp');
        expect(res.status).toBe(404);
    });

    it('404 on an invalid slug (whitelist guard, no traversal)', async () => {
        const app = appWith(new Set(['petdx-sprites/zoro/avatar.webp']));
        // uppercase + dot-segment must be rejected before any R2 lookup
        const res = await request(app).get('/api/petdx/..%2Fsecret/avatar.webp');
        expect(res.status).toBe(404);
        const res2 = await request(app).get('/api/petdx/ZORO/avatar.webp');
        expect(res2.status).toBe(404);
    });

    it('avatar.webp and sprite.webp are independent keys', async () => {
        // Only the sprite exists → avatar 404s, sprite 200s (no cross-serving).
        const app = appWith(new Set(['petdx-sprites/luffy/sprite.webp']));
        expect((await request(app).get('/api/petdx/luffy/avatar.webp')).status).toBe(404);
        expect((await request(app).get('/api/petdx/luffy/sprite.webp')).status).toBe(200);
    });
});
