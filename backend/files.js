/**
 * Bot File Upload System — Cloudflare R2 Storage
 *
 * Mounted at: /api/files
 *
 * Endpoints:
 * POST /upload              - Upload a file (multipart/form-data)
 * GET  /:fileId             - Get signed download URL (15-day TTL, 1h signed URL)
 * DELETE /:fileId           - Delete a file
 * GET  /list                - List files for a device (with usage stats)
 *
 * Storage: Cloudflare R2 (S3-compatible)
 * Key format: files/{deviceId}/{fileId}/{filename}
 * TTL: 15 days (enforced by daily cron in index.js)
 * Per-device quota: 500MB soft cap (prompts user to clean up oldest files)
 */

const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const { Pool } = require('pg');
const { S3Client, PutObjectCommand, DeleteObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { GetObjectCommand } = require('@aws-sdk/client-s3');
const safeEqual = require('./safe-equal');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/realbot'
});

// R2 S3-compatible client
const r2 = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
    },
});

const BUCKET = process.env.R2_BUCKET_NAME || 'eclaw-files';
const FILE_TTL_DAYS = 15;
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB per file
const QUOTA_SOFT_BYTES = 500 * 1024 * 1024; // 500MB per device (soft cap)
const SIGNED_URL_EXPIRES = 3600; // 1 hour

// Multer — memory storage (stream directly to R2)
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_FILE_SIZE },
});

// Initialize files table
async function initFilesTable() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS r2_files (
            file_id     TEXT PRIMARY KEY,
            device_id   TEXT NOT NULL,
            entity_id   INTEGER,
            filename    TEXT NOT NULL,
            size        BIGINT NOT NULL,
            mime_type   TEXT NOT NULL DEFAULT 'application/octet-stream',
            r2_key      TEXT NOT NULL,
            created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            expires_at  TIMESTAMPTZ NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_r2_files_device ON r2_files(device_id);
        CREATE INDEX IF NOT EXISTS idx_r2_files_expires ON r2_files(expires_at);
    `);
}

// Authenticate request (deviceSecret or botSecret)
function resolveDevice(req) {
    // req.body may be {} (truthy) from Express JSON middleware even on GET requests;
    // use query params as fallback when body has no deviceId.
    const src = (req.body && req.body.deviceId) ? req.body : req.query;
    const { deviceId, deviceSecret, botSecret, entityId } = src;
    if (!deviceId) return null;
    return { deviceId, deviceSecret, botSecret, entityId: entityId ? parseInt(entityId) : null };
}

async function authenticateDevice(pool, creds, devices) {
    if (!creds || !creds.deviceId) return false;
    try {
        // Try in-memory device store first (fast path)
        const dev = devices && devices[creds.deviceId];
        if (dev) {
            if (creds.deviceSecret && safeEqual(dev.deviceSecret, creds.deviceSecret)) return true;
            if (creds.botSecret && creds.entityId != null) {
                const entity = dev.entities && dev.entities[creds.entityId];
                return !!(entity && safeEqual(entity.botSecret, creds.botSecret));
            }
            return false;
        }
        // Fallback: DB check (device not yet loaded in memory after restart)
        const [devRow, entRow] = await Promise.all([
            pool.query('SELECT device_secret FROM devices WHERE device_id = $1', [creds.deviceId]),
            creds.botSecret && creds.entityId != null
                ? pool.query('SELECT bot_secret FROM entities WHERE device_id = $1 AND entity_id = $2', [creds.deviceId, creds.entityId])
                : Promise.resolve({ rows: [] })
        ]);
        if (!devRow.rows.length) return false;
        if (creds.deviceSecret) return safeEqual(devRow.rows[0].device_secret, creds.deviceSecret);
        if (creds.botSecret && entRow.rows.length) return safeEqual(entRow.rows[0].bot_secret, creds.botSecret);
        return false;
    } catch (err) {
        console.error('[Files] Auth error:', err.message);
        return false;
    }
}

module.exports = function filesModule(devices) {
    const router = express.Router();

    initFilesTable().catch(err => console.error('[Files] DB init error:', err));

    // ─── POST /api/files/upload ──────────────────────────────────────────────
    router.post('/upload', upload.single('file'), async (req, res) => {
        try {
            const creds = resolveDevice(req);
            if (!await authenticateDevice(pool, creds, devices)) {
                return res.status(401).json({ success: false, error: 'Invalid credentials' });
            }

            if (!req.file) {
                return res.status(400).json({ success: false, error: 'No file provided' });
            }

            const { deviceId, entityId } = creds;
            const { originalname, mimetype, size, buffer } = req.file;

            // testQuotaBytes: deviceSecret-only param for integration tests to simulate quota exceeded
            const testQuotaBytes = creds.deviceSecret && req.body.testQuotaBytes
                ? parseInt(req.body.testQuotaBytes) : null;

            // Check current device usage
            const usageResult = await pool.query(
                'SELECT COALESCE(SUM(size), 0) AS total FROM r2_files WHERE device_id = $1 AND expires_at > NOW()',
                [deviceId]
            );
            const currentUsage = parseInt(usageResult.rows[0].total);
            const effectiveQuota = testQuotaBytes != null ? testQuotaBytes : QUOTA_SOFT_BYTES;

            if (currentUsage + size > effectiveQuota) {
                const oldestFiles = await pool.query(
                    `SELECT file_id, filename, size, created_at
                     FROM r2_files WHERE device_id = $1 AND expires_at > NOW()
                     ORDER BY created_at ASC LIMIT 5`,
                    [deviceId]
                );
                return res.status(507).json({
                    success: false,
                    error: 'quota_exceeded',
                    message: `Storage quota exceeded (${Math.round(currentUsage / 1024 / 1024)}MB / ${Math.round(effectiveQuota / 1024 / 1024)}MB). Please remove some old files first.`,
                    currentUsageMB: Math.round(currentUsage / 1024 / 1024),
                    quotaMB: Math.round(effectiveQuota / 1024 / 1024),
                    oldestFiles: oldestFiles.rows.map(f => ({
                        fileId: f.file_id,
                        filename: f.filename,
                        sizeMB: Math.round(f.size / 1024 / 1024 * 10) / 10,
                        createdAt: f.created_at,
                    })),
                });
            }

            const fileId = crypto.randomUUID();
            const safeName = originalname.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
            const r2Key = `files/${deviceId}/${fileId}/${safeName}`;
            const expiresAt = new Date(Date.now() + FILE_TTL_DAYS * 24 * 60 * 60 * 1000);

            await r2.send(new PutObjectCommand({
                Bucket: BUCKET,
                Key: r2Key,
                Body: buffer,
                ContentType: mimetype,
                ContentLength: size,
                Metadata: {
                    deviceId,
                    entityId: entityId != null ? String(entityId) : '',
                    originalName: originalname,
                },
            }));

            await pool.query(
                `INSERT INTO r2_files (file_id, device_id, entity_id, filename, size, mime_type, r2_key, expires_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                [fileId, deviceId, entityId, originalname, size, mimetype, r2Key, expiresAt]
            );

            return res.json({
                success: true,
                fileId,
                filename: originalname,
                size,
                mimeType: mimetype,
                expiresAt: expiresAt.toISOString(),
            });
        } catch (err) {
            console.error('[Files] Upload error:', err.message);
            return res.status(500).json({ success: false, error: 'Upload failed: ' + err.message });
        }
    });

    // ─── GET /api/files/list ─────────────────────────────────────────────────
    // NOTE: must be registered BEFORE /:fileId to avoid shadowing
    router.get('/list', async (req, res) => {
        try {
            const creds = resolveDevice(req);
            if (!await authenticateDevice(pool, creds, devices)) {
                return res.status(401).json({ success: false, error: 'Invalid credentials' });
            }

            const result = await pool.query(
                `SELECT file_id, filename, size, mime_type, created_at, expires_at, entity_id
                 FROM r2_files WHERE device_id = $1 AND expires_at > NOW()
                 ORDER BY created_at DESC`,
                [creds.deviceId]
            );

            const totalBytes = result.rows.reduce((sum, f) => sum + parseInt(f.size), 0);

            return res.json({
                success: true,
                files: result.rows.map(f => ({
                    fileId: f.file_id,
                    filename: f.filename,
                    size: f.size,
                    mimeType: f.mime_type,
                    createdAt: f.created_at,
                    expiresAt: f.expires_at,
                    entityId: f.entity_id,
                })),
                usage: {
                    totalBytes,
                    totalMB: Math.round(totalBytes / 1024 / 1024 * 10) / 10,
                    quotaMB: Math.round(QUOTA_SOFT_BYTES / 1024 / 1024),
                    count: result.rows.length,
                },
            });
        } catch (err) {
            console.error('[Files] List error:', err.message);
            return res.status(500).json({ success: false, error: 'List failed: ' + err.message });
        }
    });

    // ─── GET /api/files/:fileId ──────────────────────────────────────────────
    router.get('/:fileId', async (req, res) => {
        try {
            const creds = resolveDevice(req);
            if (!await authenticateDevice(pool, creds, devices)) {
                return res.status(401).json({ success: false, error: 'Invalid credentials' });
            }

            const { fileId } = req.params;
            const result = await pool.query(
                'SELECT * FROM r2_files WHERE file_id = $1 AND device_id = $2 AND expires_at > NOW()',
                [fileId, creds.deviceId]
            );

            if (!result.rows.length) {
                return res.status(404).json({ success: false, error: 'File not found or expired' });
            }

            const file = result.rows[0];
            const dl = req.query.dl === '1';
            const cmdParams = { Bucket: BUCKET, Key: file.r2_key };
            if (dl) cmdParams.ResponseContentDisposition = `attachment; filename="${encodeURIComponent(file.filename)}"`;
            const command = new GetObjectCommand(cmdParams);
            const url = await getSignedUrl(r2, command, { expiresIn: SIGNED_URL_EXPIRES });

            return res.json({
                success: true,
                fileId: file.file_id,
                filename: file.filename,
                size: file.size,
                mimeType: file.mime_type,
                url,
                urlExpiresIn: SIGNED_URL_EXPIRES,
                expiresAt: file.expires_at,
            });
        } catch (err) {
            console.error('[Files] Get error:', err.message);
            return res.status(500).json({ success: false, error: 'Get failed: ' + err.message });
        }
    });

    // ─── DELETE /api/files/:fileId ───────────────────────────────────────────
    router.delete('/:fileId', async (req, res) => {
        try {
            const creds = resolveDevice(req);
            if (!await authenticateDevice(pool, creds, devices)) {
                return res.status(401).json({ success: false, error: 'Invalid credentials' });
            }

            const { fileId } = req.params;
            const result = await pool.query(
                'SELECT r2_key FROM r2_files WHERE file_id = $1 AND device_id = $2',
                [fileId, creds.deviceId]
            );

            if (!result.rows.length) {
                return res.status(404).json({ success: false, error: 'File not found' });
            }

            const { r2_key } = result.rows[0];

            await r2.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: r2_key }));
            await pool.query('DELETE FROM r2_files WHERE file_id = $1', [fileId]);

            return res.json({ success: true, fileId, deleted: true });
        } catch (err) {
            console.error('[Files] Delete error:', err.message);
            return res.status(500).json({ success: false, error: 'Delete failed: ' + err.message });
        }
    });

    return { router };
};

// Export cleanup function for daily cron
module.exports.cleanupExpiredFiles = async function () {
    const expired = await pool.query(
        'SELECT file_id, r2_key FROM r2_files WHERE expires_at < NOW()'
    );

    let deleted = 0;
    for (const file of expired.rows) {
        try {
            await r2.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: file.r2_key }));
            await pool.query('DELETE FROM r2_files WHERE file_id = $1', [file.file_id]);
            deleted++;
        } catch (err) {
            console.error('[Files] Cleanup error for', file.file_id, err.message);
        }
    }

    console.log(`[Files] Cleanup: deleted ${deleted}/${expired.rows.length} expired files`);
    return deleted;
};
