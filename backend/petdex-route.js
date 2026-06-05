/**
 * Petdex public sprite proxy — serves `/api/petdx/:slug/sprite.webp` directly
 * from R2 without requiring deviceId/botSecret. Petdex sprites are MIT-licensed
 * public gallery assets; no auth needed.
 *
 * Spec: docs/specs/petdx-uiux-spec-amendment-2026-06-05-phase2-r2-pipeline.md §3.2
 * Phase 2 PR: #3176 (spec)
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

    router.get('/:slug/sprite.webp', async (req, res) => {
        const { slug } = req.params;
        if (!slug || !SLUG_PATTERN.test(slug)) {
            return res.status(404).type('text/plain').send('not found');
        }
        const key = `petdx-sprites/${slug}/sprite.webp`;
        try {
            const out = await client.send(new GetObjectCommand({ Bucket: bucketName, Key: key }));
            res.setHeader('Content-Type', 'image/webp');
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
            if (out.ContentLength != null) res.setHeader('Content-Length', String(out.ContentLength));
            if (out.ETag) res.setHeader('ETag', out.ETag);
            out.Body.pipe(res);
            out.Body.on('error', (err) => {
                logger('warn', 'petdex-route', `[petdx] stream ${slug} failed: ${err.message}`);
                if (!res.headersSent) res.status(502).end();
                else res.end();
            });
        } catch (err) {
            const code = err && (err.name || err.Code);
            const status = err && err.$metadata && err.$metadata.httpStatusCode;
            if (code === 'NoSuchKey' || code === 'NotFound' || status === 404) {
                return res.status(404).type('text/plain').send('not found');
            }
            logger('error', 'petdex-route', `[petdx] R2 GET ${slug} failed: ${code || status || err.message}`);
            return res.status(502).type('text/plain').send('upstream error');
        }
    });

    return router;
}

module.exports = { createRouter, SLUG_PATTERN };
