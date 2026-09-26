const crypto = require('crypto');
const express = require('express');

const APP_IDS = new Set([
    ...require('./public/AiHankApps/app-catalog.json').apps.map(app => app.communityId),
    'eclawbot',
    'typeforge-twin-cities',
    'weesh',
    'doomsday-index',
    'dreambuddy',
    'property-roi',
    'summit-battle',
    'stray-map',
    'sleep-park',
    'chumen',
    'echoes-of-names',
]);
const BETA_CONTINUATION = new Set(['yes', 'maybe', 'no']);

let readyPool = null;
let readyPromise = null;

function isValidAppId(value) {
    return typeof value === 'string' && APP_IDS.has(value);
}

function visitorHash(value) {
    if (typeof value !== 'string' || value.length < 12 || value.length > 128) return null;
    return crypto.createHash('sha256').update(value).digest('hex');
}

function cleanText(value, maxLength) {
    if (typeof value !== 'string') return '';
    return value.replace(/\r\n?/g, '\n').trim().slice(0, maxLength);
}

function cleanBetaFeedback(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const submissionId = typeof value.submissionId === 'string' ? value.submissionId.trim().toLowerCase() : '';
    const rating = Number(value.rating);
    const continuation = typeof value.continuation === 'string' ? value.continuation.trim() : '';
    const version = cleanText(value.version, 32);
    const platform = cleanText(value.platform, 32);
    const comment = cleanText(value.comment, 500);
    if (!/^[a-f0-9]{32,64}$/.test(submissionId)) return null;
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) return null;
    if (!BETA_CONTINUATION.has(continuation) || !version || !platform) return null;
    return { submissionId, rating, continuation, comment, version, platform };
}

function ensureTables(pool) {
    if (!pool) return Promise.reject(new Error('Database unavailable'));
    if (readyPool === pool && readyPromise) return readyPromise;
    readyPool = pool;
    readyPromise = (async () => {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS app_portfolio_likes (
                app_id        TEXT        NOT NULL,
                visitor_hash  TEXT        NOT NULL,
                created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                PRIMARY KEY (app_id, visitor_hash)
            )
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS app_portfolio_comments (
                id            BIGSERIAL   PRIMARY KEY,
                app_id        TEXT        NOT NULL,
                visitor_hash  TEXT        NOT NULL,
                nickname      VARCHAR(30) NOT NULL,
                content       VARCHAR(500) NOT NULL,
                created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);
        await pool.query('CREATE INDEX IF NOT EXISTS idx_app_portfolio_comments_app_time ON app_portfolio_comments (app_id, created_at DESC)');
        await pool.query(`
            CREATE TABLE IF NOT EXISTS app_portfolio_beta_feedback (
                id                BIGSERIAL   PRIMARY KEY,
                app_id            TEXT        NOT NULL,
                submission_id     VARCHAR(64) NOT NULL,
                rating            SMALLINT    NOT NULL CHECK (rating BETWEEN 1 AND 5),
                continuation      VARCHAR(8)  NOT NULL CHECK (continuation IN ('yes', 'maybe', 'no')),
                comment           VARCHAR(500) NOT NULL DEFAULT '',
                app_version       VARCHAR(32) NOT NULL,
                platform          VARCHAR(32) NOT NULL,
                created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                UNIQUE (app_id, submission_id)
            )
        `);
        await pool.query('CREATE INDEX IF NOT EXISTS idx_app_portfolio_beta_feedback_app_time ON app_portfolio_beta_feedback (app_id, created_at DESC)');
    })().catch((error) => {
        readyPromise = null;
        throw error;
    });
    return readyPromise;
}

async function getCommunity(pool, appId, hash) {
    await ensureTables(pool);
    const [likes, liked, comments] = await Promise.all([
        pool.query('SELECT COUNT(*)::int AS count FROM app_portfolio_likes WHERE app_id = $1', [appId]),
        hash
            ? pool.query('SELECT EXISTS(SELECT 1 FROM app_portfolio_likes WHERE app_id = $1 AND visitor_hash = $2) AS liked', [appId, hash])
            : Promise.resolve({ rows: [{ liked: false }] }),
        pool.query(`
            SELECT id::text, nickname, content, created_at AS "createdAt"
            FROM app_portfolio_comments
            WHERE app_id = $1
            ORDER BY created_at DESC
            LIMIT 50
        `, [appId]),
    ]);
    return {
        likeCount: Number(likes.rows[0]?.count || 0),
        liked: Boolean(liked.rows[0]?.liked),
        commentCount: comments.rows.length,
        comments: comments.rows,
    };
}

async function toggleLike(pool, appId, hash) {
    await ensureTables(pool);
    const toggled = await pool.query(`
        WITH deleted AS (
            DELETE FROM app_portfolio_likes
            WHERE app_id = $1 AND visitor_hash = $2
            RETURNING 1
        ), inserted AS (
            INSERT INTO app_portfolio_likes (app_id, visitor_hash)
            SELECT $1, $2
            WHERE NOT EXISTS (SELECT 1 FROM deleted)
            ON CONFLICT DO NOTHING
            RETURNING 1
        )
        SELECT EXISTS(SELECT 1 FROM inserted) AS liked
    `, [appId, hash]);
    const count = await pool.query('SELECT COUNT(*)::int AS count FROM app_portfolio_likes WHERE app_id = $1', [appId]);
    return { liked: Boolean(toggled.rows[0]?.liked), likeCount: Number(count.rows[0]?.count || 0) };
}

async function addComment(pool, appId, hash, nickname, content) {
    await ensureTables(pool);
    const recent = await pool.query(`
        SELECT 1 FROM app_portfolio_comments
        WHERE app_id = $1 AND visitor_hash = $2
          AND created_at > NOW() - INTERVAL '30 seconds'
        LIMIT 1
    `, [appId, hash]);
    if (recent.rowCount) {
        const error = new Error('留言速度太快，請稍候 30 秒再試。');
        error.status = 429;
        throw error;
    }
    const inserted = await pool.query(`
        INSERT INTO app_portfolio_comments (app_id, visitor_hash, nickname, content)
        VALUES ($1, $2, $3, $4)
        RETURNING id::text, nickname, content, created_at AS "createdAt"
    `, [appId, hash, nickname, content]);
    return inserted.rows[0];
}

async function addBetaFeedback(pool, appId, feedback) {
    await ensureTables(pool);
    const inserted = await pool.query(`
        INSERT INTO app_portfolio_beta_feedback
            (app_id, submission_id, rating, continuation, comment, app_version, platform)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (app_id, submission_id) DO NOTHING
        RETURNING id::text AS "receiptId"
    `, [appId, feedback.submissionId, feedback.rating, feedback.continuation,
        feedback.comment, feedback.version, feedback.platform]);
    if (inserted.rowCount) return { receiptId: inserted.rows[0].receiptId, duplicate: false };
    const existing = await pool.query(`
        SELECT id::text AS "receiptId"
        FROM app_portfolio_beta_feedback
        WHERE app_id = $1 AND submission_id = $2
    `, [appId, feedback.submissionId]);
    if (!existing.rowCount) throw new Error('feedback_receipt_missing');
    return { receiptId: existing.rows[0].receiptId, duplicate: true };
}

function createRouter(getPool) {
    const router = express.Router();
    router.use('/traffic', require('./app-portfolio-analytics').createRouter(getPool));
    router.use(express.json({ limit: '8kb' }));

    router.use('/apps/:appId', (req, res, next) => {
        if (!isValidAppId(req.params.appId)) return res.status(404).json({ success: false, error: '找不到這款 APP。' });
        next();
    });

    router.get('/apps/:appId/community', async (req, res) => {
        try {
            const data = await getCommunity(getPool(), req.params.appId, visitorHash(req.query.visitorId));
            res.json({ success: true, ...data });
        } catch (error) {
            console.error('[AppPortfolio] community read failed:', error.message);
            res.status(503).json({ success: false, error: '討論區暫時無法使用，請稍後再試。' });
        }
    });

    router.post('/apps/:appId/like', async (req, res) => {
        const hash = visitorHash(req.body?.visitorId);
        if (!hash) return res.status(400).json({ success: false, error: '無法識別訪客。' });
        try {
            const data = await toggleLike(getPool(), req.params.appId, hash);
            res.json({ success: true, ...data });
        } catch (error) {
            console.error('[AppPortfolio] like failed:', error.message);
            res.status(503).json({ success: false, error: '目前無法按讚，請稍後再試。' });
        }
    });

    router.post('/apps/:appId/comments', async (req, res) => {
        const hash = visitorHash(req.body?.visitorId);
        const nickname = cleanText(req.body?.nickname, 30);
        const content = cleanText(req.body?.content, 500);
        if (!hash || !nickname || !content) {
            return res.status(400).json({ success: false, error: '請填寫暱稱與留言內容。' });
        }
        try {
            const comment = await addComment(getPool(), req.params.appId, hash, nickname, content);
            res.status(201).json({ success: true, comment });
        } catch (error) {
            const status = error.status || 503;
            if (status !== 429) console.error('[AppPortfolio] comment failed:', error.message);
            res.status(status).json({ success: false, error: status === 429 ? error.message : '目前無法留言，請稍後再試。' });
        }
    });

    router.post('/apps/:appId/beta-feedback', async (req, res) => {
        const feedback = cleanBetaFeedback(req.body);
        if (!feedback) {
            return res.status(400).json({ success: false, error: '回饋格式不完整。' });
        }
        try {
            const receipt = await addBetaFeedback(getPool(), req.params.appId, feedback);
            res.status(receipt.duplicate ? 200 : 201).json({ success: true, ...receipt });
        } catch (error) {
            console.error('[AppPortfolio] beta feedback failed:', error.message);
            res.status(503).json({ success: false, error: '目前無法接收回饋，請稍後再試。' });
        }
    });

    return router;
}

module.exports = {
    APP_IDS,
    isValidAppId,
    visitorHash,
    cleanText,
    cleanBetaFeedback,
    ensureTables,
    getCommunity,
    toggleLike,
    addComment,
    addBetaFeedback,
    createRouter,
};
