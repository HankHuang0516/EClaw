/**
 * Trust & Risk Management Module — Phase 3 + 4
 *
 * Mounted at: /api/rental (extends existing rental routes)
 *
 * Subsystems covered:
 *   - Bot reviews (1–5★ rating + comment per completed contract)
 *   - Dispute pipeline (open → investigating → resolved/rejected)
 *   - User credit scores (aggregate trust metric)
 *   - Blacklist enforcement (temp bans)
 *   - Cooldown enforcement (24h repeat-rental prevention)
 *   - Age confirmation gate (rental-time backfill)
 *   - SLA tracking on disputes
 *
 * @brm-crossref: P3 Trust Layer + P4 Risk Management
 * Design doc: docs/plans/2026-04-10-bot-rental-marketplace-design.md
 * Roadmap:    /portal/roadmap.html
 * If this module is updated, also update the roadmap page status and the design doc §10 delivery tracker.
 */

const express = require('express');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/realbot'
});

// ============================================
// Constants
// ============================================

const DISPUTE_TYPES = Object.freeze(['bot_crash', 'bot_quality', 'capability_mismatch', 'financial']);
const DISPUTE_STATUSES = Object.freeze(['open', 'investigating', 'resolved', 'rejected']);
const COOLDOWN_HOURS = 24;
// Credit score bounds (MIN used in GREATEST() formula in recalculateCreditScore)
void 0; // score range: 0–10
const AUTO_DELIST_THRESHOLD = 3.0;

// SLA times in milliseconds (design decision #27)
const SLA_MS = Object.freeze({
    bot_crash: { firstResponse: 5 * 60 * 1000, resolve: 5 * 60 * 1000 },          // 5 min auto
    bot_quality: { firstResponse: 24 * 3600 * 1000, resolve: 72 * 3600 * 1000 },   // 24h / 72h
    capability_mismatch: { firstResponse: 24 * 3600 * 1000, resolve: 48 * 3600 * 1000 },
    financial: { firstResponse: 12 * 3600 * 1000, resolve: 48 * 3600 * 1000 },
});

const SLA_MISS_COMPENSATION_MLI = 50 * 1000; // 50 e幣 auto-compensation on SLA miss

// ============================================
// Schema init
// ============================================
async function initTrustDatabase() {
    try {
        const schemaPath = path.join(__dirname, 'trust_schema.sql');
        const schema = fs.readFileSync(schemaPath, 'utf8');
        const statements = [];
        let current = '';
        let inDollarBlock = false;
        for (const line of schema.split('\n')) {
            const trimmed = line.trim();
            if (trimmed.startsWith('--')) continue;
            current += line + '\n';
            const dollarCount = (line.match(/\$\$/g) || []).length;
            if (dollarCount % 2 === 1) inDollarBlock = !inDollarBlock;
            if (!inDollarBlock && trimmed.endsWith(';')) {
                const stmt = current.trim();
                if (stmt && stmt !== ';') statements.push(stmt);
                current = '';
            }
        }
        if (current.trim()) statements.push(current.trim());
        for (const statement of statements) {
            try { await pool.query(statement); } catch (err) {
                if (!err.message.includes('already exists') && !err.message.includes('duplicate key')) {
                    console.warn('[Trust] Schema warning:', err.message);
                }
            }
        }
        console.log('[Trust] Database initialized');
    } catch (error) {
        console.error('[Trust] Failed to init database:', error);
    }
}

// ============================================
// Reviews
// ============================================

async function submitReview({ contractId, reviewerUserId, rating, comment = null }) {
    if (!contractId || !reviewerUserId) throw new Error('contract_id_required');
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new Error('rating_invalid');
    if (comment && comment.length > 1000) throw new Error('comment_too_long');

    // Verify contract exists, is ended, and reviewer is the renter
    const cRes = await pool.query(
        `SELECT id, listing_id, renter_user_id, owner_user_id, status
         FROM rental_contracts WHERE id = $1`,
        [contractId]
    );
    if (cRes.rowCount === 0) throw new Error('contract_not_found');
    const contract = cRes.rows[0];
    if (!contract.status.startsWith('ended')) throw new Error('contract_not_ended');
    if (contract.renter_user_id !== reviewerUserId) throw new Error('review_forbidden');

    // Check 48h window
    const existingRes = await pool.query(
        'SELECT id FROM bot_reviews WHERE contract_id = $1', [contractId]
    );
    if (existingRes.rowCount > 0) throw new Error('review_already_exists');

    const res = await pool.query(
        `INSERT INTO bot_reviews (contract_id, listing_id, reviewer_user_id, owner_user_id, rating, comment)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, rating, created_at`,
        [contractId, contract.listing_id, reviewerUserId, contract.owner_user_id, rating, comment]
    );

    // Update listing avg_rating
    await pool.query(
        `UPDATE bot_listings SET
            avg_rating = (SELECT COALESCE(AVG(rating), 0) FROM bot_reviews WHERE listing_id = $1),
            total_rentals = (SELECT COUNT(*) FROM bot_reviews WHERE listing_id = $1)
         WHERE id = $1`,
        [contract.listing_id]
    );

    return res.rows[0];
}

async function getListingReviews(listingId, { limit = 20, offset = 0 } = {}) {
    const res = await pool.query(
        `SELECT id, rating, comment, created_at FROM bot_reviews
         WHERE listing_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
        [listingId, Math.min(limit, 50), Math.max(offset, 0)]
    );
    return res.rows;
}

// ============================================
// Disputes
// ============================================

async function openDispute({ contractId, raisedBy, type, evidence = null }) {
    if (!contractId || !raisedBy) throw new Error('contract_id_required');
    if (!DISPUTE_TYPES.includes(type)) throw new Error('dispute_type_invalid');

    const sla = SLA_MS[type] || SLA_MS.bot_quality;
    const now = new Date();

    const res = await pool.query(
        `INSERT INTO disputes
            (contract_id, raised_by, type, evidence, status,
             sla_first_response_by, sla_resolve_by)
         VALUES ($1, $2, $3, $4, 'open', $5, $6)
         RETURNING id, status, sla_resolve_by, created_at`,
        [contractId, raisedBy, type, evidence,
         new Date(now.getTime() + sla.firstResponse),
         new Date(now.getTime() + sla.resolve)]
    );
    return res.rows[0];
}

async function resolveDispute({ disputeId, resolution, resolvedBy, compensation = 0 }) {
    if (!disputeId) throw new Error('dispute_id_required');
    if (!resolution || typeof resolution !== 'string') throw new Error('resolution_required');

    const res = await pool.query(
        `UPDATE disputes SET
            status = 'resolved', resolution = $2, resolved_by = $3,
            resolved_at = NOW(), compensation_mli = $4
         WHERE id = $1 AND status IN ('open', 'investigating')
         RETURNING id, status, resolved_at`,
        [disputeId, resolution, resolvedBy, compensation]
    );
    if (res.rowCount === 0) throw new Error('dispute_not_found_or_closed');
    return res.rows[0];
}

async function rejectDispute({ disputeId, resolution, resolvedBy }) {
    const res = await pool.query(
        `UPDATE disputes SET
            status = 'rejected', resolution = $2, resolved_by = $3, resolved_at = NOW()
         WHERE id = $1 AND status IN ('open', 'investigating')
         RETURNING id, status`,
        [disputeId, resolution, resolvedBy]
    );
    if (res.rowCount === 0) throw new Error('dispute_not_found_or_closed');
    return res.rows[0];
}

async function getMyDisputes(userId, { limit = 20, offset = 0 } = {}) {
    const res = await pool.query(
        `SELECT id, contract_id, type, status, sla_resolve_by, resolved_at, created_at
         FROM disputes WHERE raised_by = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
        [userId, Math.min(limit, 50), Math.max(offset, 0)]
    );
    return res.rows;
}

async function getOpenDisputes({ limit = 50 } = {}) {
    const res = await pool.query(
        `SELECT d.id, d.contract_id, d.type, d.status, d.raised_by,
                d.sla_first_response_by, d.sla_resolve_by, d.created_at
         FROM disputes d
         WHERE d.status IN ('open', 'investigating')
         ORDER BY d.sla_resolve_by ASC
         LIMIT $1`,
        [Math.min(limit, 200)]
    );
    return res.rows;
}

// ============================================
// Credit scores
// ============================================

async function recalculateCreditScore(userId) {
    // Upsert credit score row
    await pool.query(
        `INSERT INTO user_credit_scores (user_id) VALUES ($1)
         ON CONFLICT (user_id) DO NOTHING`,
        [userId]
    );

    const res = await pool.query(
        `WITH stats AS (
            SELECT
                (SELECT COUNT(*) FROM rental_contracts WHERE owner_user_id = $1) AS owns,
                (SELECT COUNT(*) FROM rental_contracts WHERE renter_user_id = $1) AS rents,
                (SELECT COALESCE(AVG(r.rating), 5) FROM bot_reviews r
                 JOIN rental_contracts c ON c.id = r.contract_id
                 WHERE c.owner_user_id = $1) AS avg_rat,
                (SELECT COUNT(*) FROM disputes WHERE raised_by = $1 AND status = 'rejected') AS bad_disputes,
                (SELECT COUNT(*) FROM fraud_detection_log WHERE user_id = $1) AS frauds
        )
        UPDATE user_credit_scores SET
            total_rentals_as_owner = s.owns,
            total_rentals_as_renter = s.rents,
            avg_rating_received = s.avg_rat,
            dispute_count = s.bad_disputes,
            score = GREATEST(0, LEAST(10,
                s.avg_rat * 2                          -- base from ratings (0-10)
                - s.bad_disputes * 0.5                 -- penalty per rejected dispute
                - s.frauds * 2                         -- heavy penalty per fraud
            )),
            updated_at = NOW()
        FROM stats s
        WHERE user_credit_scores.user_id = $1
        RETURNING score, avg_rating_received`,
        [userId]
    );
    return res.rows[0] || { score: 5, avg_rating_received: 0 };
}

async function getCreditScore(userId) {
    const res = await pool.query(
        'SELECT * FROM user_credit_scores WHERE user_id = $1',
        [userId]
    );
    return res.rows[0] || null;
}

// ============================================
// Blacklist (P4)
// ============================================

async function isBlacklisted(userId) {
    const res = await pool.query(
        `SELECT id FROM user_blacklist
         WHERE user_id = $1 AND (expires_at IS NULL OR expires_at > NOW())
         LIMIT 1`,
        [userId]
    );
    return res.rowCount > 0;
}

async function addToBlacklist({ userId, reason, durationDays = 30, createdBy = null }) {
    const expiresAt = durationDays
        ? new Date(Date.now() + durationDays * 24 * 3600 * 1000)
        : null;
    const res = await pool.query(
        `INSERT INTO user_blacklist (user_id, reason, expires_at, created_by)
         VALUES ($1, $2, $3, $4)
         RETURNING id, expires_at`,
        [userId, reason, expiresAt, createdBy]
    );
    return res.rows[0];
}

async function removeFromBlacklist(userId) {
    await pool.query('DELETE FROM user_blacklist WHERE user_id = $1', [userId]);
}

// ============================================
// Cooldown (P4)
// ============================================

async function checkCooldown(userId, listingId) {
    const res = await pool.query(
        `SELECT cooldown_until FROM rental_cooldowns
         WHERE user_id = $1 AND listing_id = $2 AND cooldown_until > NOW()`,
        [userId, listingId]
    );
    if (res.rowCount > 0) {
        return { blocked: true, until: res.rows[0].cooldown_until };
    }
    return { blocked: false };
}

async function setCooldown(userId, listingId) {
    const until = new Date(Date.now() + COOLDOWN_HOURS * 3600 * 1000);
    await pool.query(
        `INSERT INTO rental_cooldowns (user_id, listing_id, cooldown_until)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, listing_id) DO UPDATE SET cooldown_until = $3`,
        [userId, listingId, until]
    );
}

// ============================================
// Age confirmation (P4)
// ============================================

async function checkAgeConfirmation(userId) {
    const res = await pool.query(
        'SELECT age_confirmed_at FROM user_accounts WHERE id = $1',
        [userId]
    );
    if (res.rowCount === 0) return { confirmed: false };
    return { confirmed: !!res.rows[0].age_confirmed_at };
}

async function confirmAge(userId, ip) {
    await pool.query(
        `UPDATE user_accounts SET age_confirmed_at = NOW() WHERE id = $1`,
        [userId]
    );
    // Log for legal evidence
    await pool.query(
        `INSERT INTO fraud_detection_log (user_id, rule_name, action, details)
         VALUES ($1, 'age_confirmation', 'confirm', $2)`,
        [userId, JSON.stringify({ ip, timestamp: new Date().toISOString() })]
    );
}

// ============================================
// Express factory
// ============================================

module.exports = function trustFactory({ authMiddleware, adminMiddleware, serverLog } = {}) {
    if (typeof authMiddleware !== 'function') {
        throw new Error('trust: authMiddleware is required');
    }
    const router = express.Router();
    const audit = serverLog || (() => {});

    const INPUT_ERROR_RE = /^(?:[a-z][a-z0-9_]*_(?:invalid|required|forbidden|not_found|not_ended|too_long|already_exists|or_closed)|review_forbidden)$/;

    function trustRoute(fn) {
        return async (req, res) => {
            try {
                if (!req.user || !req.user.userId) {
                    return res.status(401).json({ success: false, error: 'unauthenticated' });
                }
                await fn(req, res);
            } catch (err) {
                if (INPUT_ERROR_RE.test(err.message)) {
                    const code = /forbidden/.test(err.message) ? 403
                               : /not_found|or_closed/.test(err.message) ? 404
                               : 400;
                    return res.status(code).json({ success: false, error: err.message });
                }
                console.error('[Trust] handler error:', err);
                res.status(500).json({ success: false, error: 'internal_error' });
            }
        };
    }

    // ── Reviews ──
    router.post('/contract/:id/review', authMiddleware, trustRoute(async (req, res) => {
        const review = await submitReview({
            contractId: req.params.id,
            reviewerUserId: req.user.userId,
            rating: parseInt(req.body.rating, 10),
            comment: req.body.comment || null,
        });
        audit('info', 'trust', `review ${review.id} rating=${review.rating}`, {
            userId: req.user.userId, action: 'review_submit', resource: req.params.id,
        });
        res.json({ success: true, review });
    }));

    router.get('/listing/:id/reviews', async (req, res) => {
        try {
            const reviews = await getListingReviews(req.params.id, req.query);
            res.json({ success: true, reviews });
        } catch {
            res.status(500).json({ success: false, error: 'internal_error' });
        }
    });

    // ── Disputes ──
    router.post('/contract/:id/dispute', authMiddleware, trustRoute(async (req, res) => {
        const dispute = await openDispute({
            contractId: req.params.id,
            raisedBy: req.user.userId,
            type: req.body.type,
            evidence: req.body.evidence || null,
        });
        audit('warn', 'trust', `dispute ${dispute.id} type=${req.body.type}`, {
            userId: req.user.userId, action: 'dispute_open', resource: req.params.id,
        });
        res.json({ success: true, dispute });
    }));

    router.get('/my-disputes', authMiddleware, trustRoute(async (req, res) => {
        const disputes = await getMyDisputes(req.user.userId, req.query);
        res.json({ success: true, disputes });
    }));

    // ── Admin dispute management ──
    const adminGate = adminMiddleware || ((_req, _res, next) => next());

    router.get('/admin/disputes', authMiddleware, adminGate, trustRoute(async (req, res) => {
        const disputes = await getOpenDisputes(req.query);
        res.json({ success: true, disputes });
    }));

    router.post('/admin/disputes/:id/resolve', authMiddleware, adminGate, trustRoute(async (req, res) => {
        const result = await resolveDispute({
            disputeId: req.params.id,
            resolution: req.body.resolution,
            resolvedBy: req.user.userId,
            compensation: parseInt(req.body.compensation, 10) || 0,
        });
        audit('warn', 'trust', `dispute ${req.params.id} resolved`, {
            userId: req.user.userId, action: 'dispute_resolve', resource: req.params.id,
        });
        res.json({ success: true, result });
    }));

    router.post('/admin/disputes/:id/reject', authMiddleware, adminGate, trustRoute(async (req, res) => {
        const result = await rejectDispute({
            disputeId: req.params.id,
            resolution: req.body.resolution || 'rejected',
            resolvedBy: req.user.userId,
        });
        res.json({ success: true, result });
    }));

    // ── Credit score ──
    router.get('/credit-score', authMiddleware, trustRoute(async (req, res) => {
        const score = await getCreditScore(req.user.userId);
        res.json({ success: true, score });
    }));

    // ── Blacklist admin ──
    router.post('/admin/blacklist', authMiddleware, adminGate, trustRoute(async (req, res) => {
        const { userId, reason, durationDays } = req.body;
        if (!userId) throw new Error('user_id_required');
        if (!reason) throw new Error('reason_required');
        const entry = await addToBlacklist({
            userId, reason, durationDays: parseInt(durationDays, 10) || 30,
            createdBy: req.user.userId,
        });
        audit('warn', 'trust', `blacklist ${userId}: ${reason}`, {
            userId: req.user.userId, action: 'blacklist_add', resource: userId,
        });
        res.json({ success: true, entry });
    }));

    router.delete('/admin/blacklist/:userId', authMiddleware, adminGate, trustRoute(async (req, res) => {
        await removeFromBlacklist(req.params.userId);
        res.json({ success: true });
    }));

    // ── Age confirmation ──
    router.get('/age-check', authMiddleware, trustRoute(async (req, res) => {
        const result = await checkAgeConfirmation(req.user.userId);
        res.json({ success: true, ...result });
    }));

    router.post('/age-confirm', authMiddleware, trustRoute(async (req, res) => {
        const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
        await confirmAge(req.user.userId, ip);
        res.json({ success: true });
    }));

    return {
        router,
        initTrustDatabase,
        // Primitives
        submitReview,
        getListingReviews,
        openDispute,
        resolveDispute,
        rejectDispute,
        getMyDisputes,
        getOpenDisputes,
        recalculateCreditScore,
        getCreditScore,
        isBlacklisted,
        addToBlacklist,
        removeFromBlacklist,
        checkCooldown,
        setCooldown,
        checkAgeConfirmation,
        confirmAge,
        // Constants
        DISPUTE_TYPES,
        DISPUTE_STATUSES,
        SLA_MS,
        SLA_MISS_COMPENSATION_MLI,
        COOLDOWN_HOURS,
        AUTO_DELIST_THRESHOLD,
    };
};
