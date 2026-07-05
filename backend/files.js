/**
 * Bot File Upload System — Cloudflare R2 Storage
 *
 * Mounted at: /api/files
 *
 * Endpoints:
 * POST /upload              - Upload a file (multipart/form-data)
 * GET  /:fileId             - Get signed download URL (15-day TTL, 10-min signed URL)
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
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
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
const SIGNED_URL_EXPIRES = 600; // 10 minutes — shorter window reduces leak blast radius if URL ends up in a log or screenshot before chat.html's R2LinkRender strips it.
const MAX_EDIT_SIZE = 512 * 1024; // 512KB cap for online text editing

// File extensions allowed for online text editing (Monaco). Server is the
// source of truth; the frontend mirrors this list but cannot widen it.
const TEXT_EDIT_EXTENSIONS = new Set([
    'txt', 'md', 'markdown', 'json', 'jsonc', 'js', 'mjs', 'cjs', 'ts', 'tsx',
    'jsx', 'py', 'yaml', 'yml', 'csv', 'tsv', 'html', 'htm', 'css', 'scss',
    'less', 'xml', 'svg', 'sh', 'bash', 'zsh', 'go', 'rs', 'java', 'cpp', 'cc',
    'cxx', 'hpp', 'h', 'c', 'kt', 'kts', 'swift', 'rb', 'php', 'sql', 'toml',
    'ini', 'env', 'conf', 'log', 'gitignore', 'dockerfile', 'makefile'
]);

function getExtension(filename) {
    if (!filename || typeof filename !== 'string') return '';
    const base = filename.split(/[/\\]/).pop();
    if (!base) return '';
    // Special handling for files like "Dockerfile" / "Makefile" with no dot.
    if (!base.includes('.')) return base.toLowerCase();
    return base.split('.').pop().toLowerCase();
}

function isTextEditable(filename) {
    return TEXT_EDIT_EXTENSIONS.has(getExtension(filename));
}

// Multer/curl frequently report "application/octet-stream" for media files
// (curl's default for .mp4 from `-F file=@...`), which makes chat.html's
// `mimeType.startsWith('video/')` branch fall through to a plain download
// chip. Sniff a better mime from the filename extension when the supplied
// type is missing or generic; otherwise pass through unchanged.
const EXTENSION_MIME_MAP = {
    mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime',
    webm: 'video/webm', mkv: 'video/x-matroska', ogv: 'video/ogg',
    mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac',
    wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg',
    flac: 'audio/flac', opus: 'audio/opus', weba: 'audio/webm',
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
    webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml',
    pdf: 'application/pdf',
};

function sniffMimeFromExtension(filename, fallback) {
    const supplied = String(fallback || '').toLowerCase();
    if (supplied && supplied !== 'application/octet-stream' && supplied !== 'application/binary') {
        return fallback;
    }
    const ext = getExtension(filename);
    return EXTENSION_MIME_MAP[ext] || fallback || 'application/octet-stream';
}

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
            const { size, buffer } = req.file;
            const mimetype = sniffMimeFromExtension(req.file.originalname, req.file.mimetype);
            // Multer decodes multipart filenames as latin-1 by default; browsers send
            // them as UTF-8, so non-ASCII names (e.g. Chinese) arrive as mojibake
            // (é­ç¿ä¹...). Re-interpret the latin-1 string as UTF-8 bytes to recover.
            const rawName = req.file.originalname || 'file';
            const originalname = /[-ÿ]/.test(rawName)
                ? Buffer.from(rawName, 'latin1').toString('utf8')
                : rawName;

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
                    // URI-encode originalName to avoid S3 signature errors with non-ASCII chars
                    originalName: encodeURIComponent(originalname),
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

    // ─── GET /api/files/:fileId/content ──────────────────────────────────────
    // Streams raw file bytes for the online editor. Refuses non-text files
    // (extension whitelist, server-side enforced) and files >512KB.
    router.get('/:fileId/content', async (req, res) => {
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
            if (!isTextEditable(file.filename)) {
                return res.status(415).json({ success: false, error: 'binary_file', message: 'File type is not editable as text' });
            }
            if (parseInt(file.size) > MAX_EDIT_SIZE) {
                return res.status(413).json({
                    success: false,
                    error: 'too_large',
                    message: `File is too large to edit online (limit: ${Math.round(MAX_EDIT_SIZE / 1024)}KB)`,
                    sizeBytes: parseInt(file.size),
                    limitBytes: MAX_EDIT_SIZE,
                });
            }

            const obj = await r2.send(new GetObjectCommand({ Bucket: BUCKET, Key: file.r2_key }));
            const chunks = [];
            for await (const chunk of obj.Body) chunks.push(chunk);
            const buffer = Buffer.concat(chunks);

            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.setHeader('Cache-Control', 'no-store');
            res.setHeader('X-Eclaw-Filename', encodeURIComponent(file.filename));
            return res.send(buffer);
        } catch (err) {
            console.error('[Files] Content read error:', err.message);
            return res.status(500).json({ success: false, error: 'Read failed: ' + err.message });
        }
    });

    // ─── PUT /api/files/:fileId ──────────────────────────────────────────────
    // Overwrites the R2 object with new text content. Preserves fileId,
    // ownerDeviceId, originalFilename, mime_type, and r2_key. Server-enforced
    // text-extension whitelist and 512KB cap.
    const putBodyParser = express.text({ type: 'text/*', limit: MAX_EDIT_SIZE + 4096 });
    router.put('/:fileId', putBodyParser, async (req, res) => {
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
            if (!isTextEditable(file.filename)) {
                return res.status(415).json({ success: false, error: 'binary_file', message: 'File type is not editable as text' });
            }

            // Accept either text/plain raw body or JSON {content: "..."}
            let content;
            const ctype = String(req.headers['content-type'] || '').toLowerCase();
            if (ctype.startsWith('application/json')) {
                if (!req.body || typeof req.body.content !== 'string') {
                    return res.status(400).json({ success: false, error: 'Missing content field' });
                }
                content = req.body.content;
            } else if (ctype.startsWith('text/')) {
                content = typeof req.body === 'string' ? req.body : '';
            } else {
                return res.status(415).json({ success: false, error: 'Unsupported Content-Type; use text/plain or application/json' });
            }

            const buffer = Buffer.from(content, 'utf8');
            if (buffer.length > MAX_EDIT_SIZE) {
                return res.status(413).json({
                    success: false,
                    error: 'too_large',
                    message: `Content exceeds ${Math.round(MAX_EDIT_SIZE / 1024)}KB limit`,
                    sizeBytes: buffer.length,
                    limitBytes: MAX_EDIT_SIZE,
                });
            }

            await r2.send(new PutObjectCommand({
                Bucket: BUCKET,
                Key: file.r2_key,
                Body: buffer,
                ContentType: file.mime_type,
                ContentLength: buffer.length,
            }));

            const updatedAt = new Date();
            await pool.query(
                'UPDATE r2_files SET size = $1 WHERE file_id = $2',
                [buffer.length, fileId]
            );

            return res.json({
                success: true,
                fileId,
                size: buffer.length,
                updatedAt: updatedAt.toISOString(),
            });
        } catch (err) {
            console.error('[Files] PUT error:', err.message);
            return res.status(500).json({ success: false, error: 'Save failed: ' + err.message });
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

// Shared helper used by POST /api/transform multipart path so file delivery
// can be done in a single request. Throws Error with .httpStatus and .code.
module.exports.uploadBufferToR2 = async function uploadBufferToR2({
    deviceId, entityId, buffer, originalname, mimetype, size, testQuotaBytes,
}) {
    if (!deviceId) {
        const e = new Error('deviceId required'); e.httpStatus = 400; e.code = 'bad_request'; throw e;
    }
    if (!buffer || !size) {
        const e = new Error('No file provided'); e.httpStatus = 400; e.code = 'no_file'; throw e;
    }
    if (size > MAX_FILE_SIZE) {
        const e = new Error(`File exceeds ${MAX_FILE_SIZE / 1024 / 1024}MB limit`);
        e.httpStatus = 413; e.code = 'too_large'; throw e;
    }

    mimetype = sniffMimeFromExtension(originalname, mimetype);

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
        const e = new Error(`Storage quota exceeded (${Math.round(currentUsage / 1024 / 1024)}MB / ${Math.round(effectiveQuota / 1024 / 1024)}MB). Please remove some old files first.`);
        e.httpStatus = 507;
        e.code = 'quota_exceeded';
        e.details = {
            currentUsageMB: Math.round(currentUsage / 1024 / 1024),
            quotaMB: Math.round(effectiveQuota / 1024 / 1024),
            oldestFiles: oldestFiles.rows.map(f => ({
                fileId: f.file_id,
                filename: f.filename,
                sizeMB: Math.round(f.size / 1024 / 1024 * 10) / 10,
                createdAt: f.created_at,
            })),
        };
        throw e;
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
            originalName: encodeURIComponent(originalname),
        },
    }));

    await pool.query(
        `INSERT INTO r2_files (file_id, device_id, entity_id, filename, size, mime_type, r2_key, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [fileId, deviceId, entityId, originalname, size, mimetype, r2Key, expiresAt]
    );

    return {
        fileId,
        filename: originalname,
        size,
        mimeType: mimetype,
        expiresAt: expiresAt.toISOString(),
    };
};

module.exports.sniffMimeFromExtension = sniffMimeFromExtension;

// Resolve a file's metadata SCOPED TO THE OWNER DEVICE. Returns { fileId, filename,
// size, mimeType, r2Key } for a file this device owns (and not yet expired), or null
// otherwise. The device scope is enforced in SQL (`AND device_id = $2`) exactly like
// the GET /:fileId route, so a caller can NEVER reference another device's file
// (no IDOR / cross-device read). Used by the wishlist P3 photo path to verify a
// referenced listing photo without ever fetching the bytes for server-side vision
// (官方不介入 — the platform runs no vision; storage is device-scoped).
module.exports.getOwnedFileMeta = async function getOwnedFileMeta({ fileId, deviceId } = {}) {
    if (!fileId || !deviceId) return null;
    const result = await pool.query(
        'SELECT file_id, filename, size, mime_type, r2_key FROM r2_files WHERE file_id = $1 AND device_id = $2 AND expires_at > NOW()',
        [fileId, deviceId]
    );
    if (!result.rows.length) return null;
    const f = result.rows[0];
    return {
        fileId: f.file_id,
        filename: f.filename,
        size: f.size,
        mimeType: f.mime_type,
        r2Key: f.r2_key,
    };
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
