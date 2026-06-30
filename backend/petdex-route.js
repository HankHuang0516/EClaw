/**
 * Petdex public asset proxy — serves `/api/petdx/:slug/sprite.webp` (full sprite
 * sheet) and `/api/petdx/:slug/avatar.webp` (single-frame avatar) directly from
 * R2 without requiring deviceId/botSecret. Petdex sprites are MIT-licensed public
 * gallery assets; no auth needed.
 *
 * Spec: docs/specs/petdx-uiux-spec-amendment-2026-06-05-phase2-r2-pipeline.md §3.2
 *       docs/specs/companion-avatar-url-store-on-create.md §2.3 (avatar.webp key)
 * Phase 2 PR: #3176 (spec) · Plaza Plan-3 Phase 4 (avatar route)
 *
 * #1 sign-off guardrails:
 *   - Slug whitelist (no directory traversal, no R2 object listing surface).
 *   - Stream the bytes through the backend; do not 302 to a signed R2 URL.
 *   - Cache-Control: public, max-age=31536000, immutable — slugs are immutable
 *     per Petdex convention; rotate the key if upstream ever mutates.
 */

const express = require('express');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const {
    COMMUNITY_SPRITE_HOST,
    COMMUNITY_SLUG_PATTERN,
} = require('./petdex-bridge');

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,128}$/;

function createRouter({ r2, bucket, log, fetch: fetchImpl } = {}) {
    const router = express.Router();
    const client = r2 || new S3Client({
        region: 'auto',
        endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: {
            accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
            secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
        },
    });
    const bucketName = bucket || process.env.R2_BUCKET_NAME || 'eclaw-files';
    const logger = typeof log === 'function' ? log : () => {};
    const doFetch = fetchImpl || globalThis.fetch;

    // Shared streamer for the immutable public webp assets under
    // petdx-sprites/{slug}/. `filename` is the object basename (sprite.webp /
    // avatar.webp). 404 on bad slug or missing key, 502 on upstream error.
    async function streamPetdxWebp(req, res, filename) {
        const { slug } = req.params;
        if (!slug || !SLUG_PATTERN.test(slug)) {
            return res.status(404).type('text/plain').send('not found');
        }
        const key = `petdx-sprites/${slug}/${filename}`;
        try {
            const out = await client.send(new GetObjectCommand({ Bucket: bucketName, Key: key }));
            res.setHeader('Content-Type', 'image/webp');
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
            if (out.ContentLength != null) res.setHeader('Content-Length', String(out.ContentLength));
            if (out.ETag) res.setHeader('ETag', out.ETag);
            out.Body.pipe(res);
            out.Body.on('error', (err) => {
                logger('warn', 'petdex-route', `[petdx] stream ${slug}/${filename} failed: ${err.message}`);
                if (!res.headersSent) res.status(502).end();
                else res.end();
            });
        } catch (err) {
            const code = err && (err.name || err.Code);
            const status = err && err.$metadata && err.$metadata.httpStatusCode;
            if (code === 'NoSuchKey' || code === 'NotFound' || status === 404) {
                return res.status(404).type('text/plain').send('not found');
            }
            logger('error', 'petdex-route', `[petdx] R2 GET ${slug}/${filename} failed: ${code || status || err.message}`);
            return res.status(502).type('text/plain').send('upstream error');
        }
    }

    // Community sprite proxy — fixes the 🦞 fallback caused by Chrome ORB
    // (Opaque Response Blocking) on the cross-origin `assets.petdex.dev` CDN.
    // Streaming the bytes back same-origin removes the cross-origin condition
    // ORB blocks on. SECURITY: this is NOT an open proxy — the upstream host
    // and `/pets/<slug>/sprite.webp` path shape are hard-coded literals, and
    // only a charset-validated slug is interpolated (no host/scheme/path is
    // taken from the request), so it cannot be coerced into SSRF.
    async function streamCommunitySprite(req, res) {
        const { slug } = req.params;
        // Community sprites are .png (majority) OR .webp — preserve the requested
        // extension; anything else is rejected (keeps the path shape a literal).
        const ext = String(req.params.ext || '').toLowerCase();
        if (!slug || !COMMUNITY_SLUG_PATTERN.test(slug) || (ext !== 'webp' && ext !== 'png')) {
            return res.status(404).type('text/plain').send('not found');
        }
        if (typeof doFetch !== 'function') {
            logger('error', 'petdex-route', '[petdx] community proxy: no fetch available');
            return res.status(502).type('text/plain').send('upstream error');
        }
        const upstreamUrl = `https://${COMMUNITY_SPRITE_HOST}/pets/${slug}/sprite.${ext}`;
        let upstream;
        try {
            upstream = await doFetch(upstreamUrl, {
                headers: {
                    // Custom UA — a default urllib/empty UA can trip the CDN's
                    // edge UA filter (CF 1010). curl/named agents return 200
                    // (verified live: EClaw-petdex-proxy/1.0 → 200 for png+webp).
                    'User-Agent': 'EClaw-petdex-proxy/1.0',
                    'Accept': 'image/webp,image/png,image/*;q=0.8,*/*;q=0.5',
                },
            });
        } catch (err) {
            logger('warn', 'petdex-route', `[petdx] community fetch ${slug} failed: ${err.message}`);
            return res.status(502).type('text/plain').send('upstream error');
        }
        if (!upstream.ok) {
            if (upstream.status === 404) {
                return res.status(404).type('text/plain').send('not found');
            }
            logger('warn', 'petdex-route', `[petdx] community ${slug} upstream HTTP ${upstream.status}`);
            return res.status(502).type('text/plain').send('upstream error');
        }
        let buf;
        try {
            buf = Buffer.from(await upstream.arrayBuffer());
        } catch (err) {
            logger('warn', 'petdex-route', `[petdx] community ${slug} body read failed: ${err.message}`);
            return res.status(502).type('text/plain').send('upstream error');
        }
        res.setHeader('Content-Type', ext === 'png' ? 'image/png' : 'image/webp');
        // Not immutable: community sprites can recover/update upstream, so cache
        // for a day rather than the year-long immutable TTL the R2 assets use.
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.setHeader('Content-Length', String(buf.length));
        return res.end(buf);
    }

    router.get('/:slug/sprite.webp', (req, res) => streamPetdxWebp(req, res, 'sprite.webp'));
    // Plaza Plan-3 Phase 4: single-frame avatar (derived frame 0, ≤512×512).
    router.get('/:slug/avatar.webp', (req, res) => streamPetdxWebp(req, res, 'avatar.webp'));
    // Community partner sprites still on the external CDN (ORB same-origin fix).
    // Accept .png (majority) and .webp; the (png|webp) constraint keeps it tight.
    router.get('/community/:slug/sprite.:ext(png|webp)', (req, res) => streamCommunitySprite(req, res));

    return router;
}

module.exports = { createRouter, SLUG_PATTERN };
