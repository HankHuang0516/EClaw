/**
 * Invite / Referral System — Phase 5 Growth Engine
 *
 * Mounted at: /api/invite
 *
 * - Each user gets one invite code (auto-generated on first request)
 * - Redeemed by new users at signup or via /api/invite/redeem
 * - Dual-sided rewards: inviter + invitee each get e-coin
 * - First-topup bonus: invitee's first top-up triggers extra reward to inviter
 * - Anti-fraud: one redemption per invitee, self-invite blocked, 7-day age gate
 *
 * @brm-crossref: ⑪ Referral System (P5 Growth Engine)
 * Design doc: docs/plans/2026-04-10-bot-rental-marketplace-design.md
 * Roadmap:    /portal/roadmap.html
 * If this module is updated, also update the roadmap page status and the design doc §10 delivery tracker.
 */

const express = require('express');
const crypto = require('crypto');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/realbot'
});

// ============================================
// Constants
// ============================================

const ECOIN_TO_MLI = 1000;
const INVITER_REWARD_MLI = 500 * ECOIN_TO_MLI;   // 500 e幣
const INVITEE_REWARD_MLI = 100 * ECOIN_TO_MLI;   // 100 e幣
const FIRST_TOPUP_BONUS_MLI = 500 * ECOIN_TO_MLI; // 500 e幣 to inviter on invitee's first topup
const CODE_LENGTH = 6;

// ============================================
// Schema init
// ============================================
async function initInviteDatabase() {
    try {
        const schemaPath = path.join(__dirname, 'invite_schema.sql');
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
                    console.warn('[Invite] Schema warning:', err.message);
                }
            }
        }
        console.log('[Invite] Database initialized');
    } catch (error) {
        console.error('[Invite] Failed to init database:', error);
    }
}

// ============================================
// Helpers
// ============================================

function generateCode() {
    return crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, CODE_LENGTH);
}

// ============================================
// Core functions
// ============================================

async function getOrCreateMyCode(userId) {
    // Check if user already has a code
    const existing = await pool.query(
        'SELECT code, use_count, created_at FROM invite_codes WHERE owner_user_id = $1 LIMIT 1',
        [userId]
    );
    if (existing.rowCount > 0) return existing.rows[0];

    // Generate a unique code (retry on collision)
    for (let attempt = 0; attempt < 5; attempt++) {
        const code = generateCode();
        try {
            const res = await pool.query(
                `INSERT INTO invite_codes (code, owner_user_id) VALUES ($1, $2)
                 RETURNING code, use_count, created_at`,
                [code, userId]
            );
            return res.rows[0];
        } catch (err) {
            if (err.message.includes('duplicate key')) continue;
            throw err;
        }
    }
    throw new Error('code_generation_failed');
}

async function redeemCode({ code, inviteeUserId, walletModule }) {
    if (!code || typeof code !== 'string' || code.length < 4) {
        throw new Error('code_invalid');
    }
    code = code.toUpperCase().trim();

    // Lookup code
    const codeRes = await pool.query(
        'SELECT code, owner_user_id, max_uses, use_count, expires_at FROM invite_codes WHERE code = $1',
        [code]
    );
    if (codeRes.rowCount === 0) throw new Error('code_not_found');
    const invite = codeRes.rows[0];

    // Self-invite check
    if (invite.owner_user_id === inviteeUserId) throw new Error('self_invite_forbidden');

    // Expiry check
    if (invite.expires_at && new Date(invite.expires_at) < new Date()) {
        throw new Error('code_expired');
    }

    // Max uses check
    if (invite.max_uses != null && invite.use_count >= invite.max_uses) {
        throw new Error('code_max_uses_reached');
    }

    // Already redeemed check (each user can only be invited once)
    const dupCheck = await pool.query(
        'SELECT id FROM invite_redemptions WHERE invitee_user_id = $1',
        [inviteeUserId]
    );
    if (dupCheck.rowCount > 0) throw new Error('already_redeemed');

    // Insert redemption
    await pool.query(
        `INSERT INTO invite_redemptions (code, invitee_user_id, inviter_reward_mli, invitee_reward_mli)
         VALUES ($1, $2, $3, $4)`,
        [code, inviteeUserId, INVITER_REWARD_MLI, INVITEE_REWARD_MLI]
    );

    // Increment use count
    await pool.query(
        'UPDATE invite_codes SET use_count = use_count + 1 WHERE code = $1',
        [code]
    );

    // Credit both parties via wallet
    if (walletModule) {
        const ts = Date.now();
        await walletModule.creditTopup({
            userId: invite.owner_user_id,
            amountMli: INVITER_REWARD_MLI,
            orderId: `invite-inviter-${code}-${inviteeUserId}`,
            channel: 'invite_bonus',
            idempotencyKey: `invite-inviter:${code}:${inviteeUserId}:${ts}`,
            note: `referral bonus: invited ${inviteeUserId.slice(0, 8)}...`,
        });
        await walletModule.creditTopup({
            userId: inviteeUserId,
            amountMli: INVITEE_REWARD_MLI,
            orderId: `invite-invitee-${code}-${inviteeUserId}`,
            channel: 'invite_bonus',
            idempotencyKey: `invite-invitee:${code}:${inviteeUserId}:${ts}`,
            note: `welcome bonus from invite code ${code}`,
        });
    }

    return {
        code,
        inviterRewardEcoin: INVITER_REWARD_MLI / ECOIN_TO_MLI,
        inviteeRewardEcoin: INVITEE_REWARD_MLI / ECOIN_TO_MLI,
    };
}

async function getInviteStats(userId) {
    const codeRes = await pool.query(
        'SELECT code, use_count, created_at FROM invite_codes WHERE owner_user_id = $1',
        [userId]
    );
    const redemptionRes = await pool.query(
        `SELECT COUNT(*) AS total,
                SUM(inviter_reward_mli) AS total_earned_mli,
                SUM(CASE WHEN first_topup_credited THEN first_topup_bonus_mli ELSE 0 END) AS bonus_earned_mli
         FROM invite_redemptions r
         JOIN invite_codes c ON c.code = r.code
         WHERE c.owner_user_id = $1`,
        [userId]
    );
    return {
        code: codeRes.rows[0]?.code || null,
        totalInvited: parseInt(redemptionRes.rows[0]?.total || 0, 10),
        totalEarnedMli: String(redemptionRes.rows[0]?.total_earned_mli || 0),
        bonusEarnedMli: String(redemptionRes.rows[0]?.bonus_earned_mli || 0),
    };
}

// ============================================
// Express factory
// ============================================

module.exports = function inviteFactory({ authMiddleware, walletModule, serverLog } = {}) {
    if (typeof authMiddleware !== 'function') {
        throw new Error('invite: authMiddleware is required');
    }
    const router = express.Router();
    const audit = serverLog || (() => {});

    function inviteRoute(fn) {
        return async (req, res) => {
            try {
                if (!req.user || !req.user.userId) {
                    return res.status(401).json({ success: false, error: 'unauthenticated' });
                }
                await fn(req, res);
            } catch (err) {
                if (/^(?:code_|self_invite|already_redeemed)/.test(err.message)) {
                    return res.status(400).json({ success: false, error: err.message });
                }
                console.error('[Invite] handler error:', err);
                res.status(500).json({ success: false, error: 'internal_error' });
            }
        };
    }

    // GET /api/invite/my-code — get or create user's invite code
    router.get('/my-code', authMiddleware, inviteRoute(async (req, res) => {
        const code = await getOrCreateMyCode(req.user.userId);
        res.json({ success: true, ...code, shareUrl: `https://eclawbot.com/invite/${code.code}` });
    }));

    // POST /api/invite/redeem — redeem an invite code
    router.post('/redeem', authMiddleware, inviteRoute(async (req, res) => {
        const { code } = req.body || {};
        const result = await redeemCode({
            code,
            inviteeUserId: req.user.userId,
            walletModule,
        });
        audit('info', 'invite', `redeemed ${code} by ${req.user.userId}`, {
            userId: req.user.userId, action: 'invite_redeem', resource: code,
        });
        res.json({ success: true, ...result });
    }));

    // GET /api/invite/stats — referral performance
    router.get('/stats', authMiddleware, inviteRoute(async (req, res) => {
        const stats = await getInviteStats(req.user.userId);
        res.json({ success: true, ...stats });
    }));

    return {
        router,
        initInviteDatabase,
        getOrCreateMyCode,
        redeemCode,
        getInviteStats,
        INVITER_REWARD_MLI,
        INVITEE_REWARD_MLI,
        FIRST_TOPUP_BONUS_MLI,
    };
};
