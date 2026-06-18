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

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,128}$/;

function createRouter({ r2, bucket, log } = {}) {
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

    router.get('/:slug/sprite.webp', (req, res) => streamPetdxWebp(req, res, 'sprite.webp'));
    // Plaza Plan-3 Phase 4: single-frame avatar (derived frame 0, ≤512×512).
    router.get('/:slug/avatar.webp', (req, res) => streamPetdxWebp(req, res, 'avatar.webp'));

    return router;
}

module.exports = { createRouter, SLUG_PATTERN };
