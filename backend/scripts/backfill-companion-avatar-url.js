#!/usr/bin/env node
/**
 * Plaza Plan-3 Phase 5 — backfill companion single-frame avatars.
 *
 * For every companion still pointing avatar_url at a PETDX sprite sheet, derive
 * frame 0 (via companion-avatar-util.extractFrameZero), upload it to R2 at
 * petdx-sprites/{slug}/avatar.webp (the Phase 4 route key), and repoint
 * avatar_url to /api/petdx/{slug}/avatar.webp.
 *
 * Spec: docs/specs/companion-avatar-url-store-on-create.md §2.2/§2.3/§5
 *
 * Usage:
 *   node backend/scripts/backfill-companion-avatar-url.js --dry-run   # plan only
 *   node backend/scripts/backfill-companion-avatar-url.js --commit    # apply
 *
 * Idempotent: the SELECT only matches rows whose avatar_url still references a
 * sprite sheet, so re-running after a successful pass is a no-op.
 */

const { extractFrameZero } = require('../companion-avatar-util');

// Rows still on a sprite-sheet avatar. (Already-migrated rows point at
// avatar.webp and are excluded, making the script idempotent.)
const SELECT_SQL =
    "SELECT id, descriptor, asset_url, avatar_url FROM companions " +
    "WHERE asset_type = 'spritesheet' AND avatar_url LIKE '%sprite.webp%'";

// Pull the slug out of an EClaw petdx proxy URL: /api/petdx/<slug>/sprite.webp
function slugFromUrl(url) {
    if (typeof url !== 'string') return null;
    const m = url.match(/\/api\/petdx\/([a-z0-9][a-z0-9-]{0,128})\/sprite\.webp/i);
    return m ? m[1] : null;
}

async function bodyToBuffer(body) {
    // AWS SDK v3 stream: prefer transformToByteArray, fall back to async iter.
    if (body && typeof body.transformToByteArray === 'function') {
        return Buffer.from(await body.transformToByteArray());
    }
    const chunks = [];
    for await (const c of body) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    return Buffer.concat(chunks);
}

/**
 * Core backfill. Dependencies are injected so this is unit-testable without a
 * real DB/R2.
 *   deps.pool   — pg Pool (query)
 *   deps.r2     — S3 client (send)
 *   deps.GetObjectCommand / deps.PutObjectCommand — @aws-sdk commands
 *   deps.bucket — R2 bucket name
 *   deps.dryRun — when true, plan only (no R2 writes, no UPDATE)
 *   deps.logger — (level, msg) => void
 */
async function runBackfill(deps) {
    const { pool, r2, GetObjectCommand, PutObjectCommand, bucket } = deps;
    const dryRun = !!deps.dryRun;
    const log = deps.logger || (() => {});

    const summary = { scanned: 0, migrated: 0, skipped: 0, failed: 0, dryRun, rows: [] };
    const { rows } = await pool.query(SELECT_SQL);
    summary.scanned = rows.length;

    for (const row of rows) {
        const slug = slugFromUrl(row.avatar_url) || slugFromUrl(row.asset_url);
        if (!slug) {
            summary.skipped++;
            summary.rows.push({ id: row.id, action: 'skip', reason: 'no-slug-in-url' });
            log('warn', `skip ${row.id}: cannot derive slug from ${row.avatar_url}`);
            continue;
        }
        const newAvatarUrl = `/api/petdx/${slug}/avatar.webp`;
        const spriteKey = `petdx-sprites/${slug}/sprite.webp`;
        const avatarKey = `petdx-sprites/${slug}/avatar.webp`;

        if (dryRun) {
            summary.migrated++; // counted as "would migrate"
            summary.rows.push({ id: row.id, action: 'would-migrate', slug, newAvatarUrl });
            log('info', `[dry-run] ${row.id} → ${newAvatarUrl} (derive ${spriteKey} → ${avatarKey})`);
            continue;
        }

        try {
            const obj = await r2.send(new GetObjectCommand({ Bucket: bucket, Key: spriteKey }));
            const spriteBuf = await bodyToBuffer(obj.Body);
            const descriptor = typeof row.descriptor === 'string'
                ? JSON.parse(row.descriptor) : (row.descriptor || {});
            const { buffer: avatarBuf } = await extractFrameZero(spriteBuf, descriptor);

            await r2.send(new PutObjectCommand({
                Bucket: bucket,
                Key: avatarKey,
                Body: avatarBuf,
                ContentType: 'image/webp',
                CacheControl: 'public, max-age=31536000, immutable',
            }));
            await pool.query('UPDATE companions SET avatar_url = $1 WHERE id = $2', [newAvatarUrl, row.id]);

            summary.migrated++;
            summary.rows.push({ id: row.id, action: 'migrated', slug, newAvatarUrl, bytes: avatarBuf.length });
            log('info', `migrated ${row.id} → ${newAvatarUrl} (${avatarBuf.length}b webp)`);
        } catch (err) {
            summary.failed++;
            summary.rows.push({ id: row.id, action: 'failed', slug, error: err.message });
            log('error', `FAILED ${row.id} (${slug}): ${err.message}`);
        }
    }
    return summary;
}

async function main() {
    const args = process.argv.slice(2);
    const dryRun = !args.includes('--commit'); // default safe: dry-run unless --commit
    const asJson = args.includes('--json');

    const { Pool } = require('pg');
    const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
    const cs = process.env.DATABASE_URL;
    const pool = new Pool({
        connectionString: cs,
        ssl: cs && !/localhost|127\.0\.0\.1/.test(cs) ? { rejectUnauthorized: false } : false,
    });
    const r2 = new S3Client({
        region: 'auto',
        endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: {
            accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
            secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
        },
    });
    const bucket = process.env.R2_BUCKET_NAME || 'eclaw-files';

    const logger = (level, msg) => console.log(`[${level}] ${msg}`);
    console.log(`[backfill-avatar] mode=${dryRun ? 'DRY-RUN' : 'COMMIT'} bucket=${bucket}`);
    try {
        const summary = await runBackfill({ pool, r2, GetObjectCommand, PutObjectCommand, bucket, dryRun, logger });
        if (asJson) console.log(JSON.stringify(summary, null, 2));
        console.log(`[backfill-avatar] done: scanned=${summary.scanned} migrated=${summary.migrated} skipped=${summary.skipped} failed=${summary.failed} (dryRun=${summary.dryRun})`);
        process.exitCode = summary.failed > 0 ? 1 : 0;
    } finally {
        await pool.end().catch(() => {});
    }
}

if (require.main === module) {
    main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { runBackfill, slugFromUrl, bodyToBuffer, SELECT_SQL };
