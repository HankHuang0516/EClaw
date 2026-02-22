/**
 * Subscription Management Module
 *
 * Mounted at: /api/subscription
 *
 * Endpoints:
 * GET  /status         - Get subscription status
 * POST /tappay/pay     - Process TapPay payment
 * POST /cancel         - Cancel subscription
 * POST /verify-google  - Verify Google Play purchase (from Android APP)
 */

const express = require('express');
const { Pool } = require('pg');
const crypto = require('crypto');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/realbot'
});

const TAPPAY_PARTNER_KEY = process.env.TAPPAY_PARTNER_KEY || 'partner_gi6Ckw8YOU3BMJP3d9CBywKvzWjfWMWoN9sBeOMP19GZKA6ZgbWdxBlZ';
const TAPPAY_MERCHANT_ID = process.env.TAPPAY_MERCHANT_ID || 'tppf_hankhuang0516_GP_POS_1';
const TAPPAY_SANDBOX = true;
const TAPPAY_API_URL = TAPPAY_SANDBOX
    ? 'https://sandbox.tappaysdk.com/tpc/payment/pay-by-prime'
    : 'https://prod.tappaysdk.com/tpc/payment/pay-by-prime';
const TAPPAY_CARD_TOKEN_URL = TAPPAY_SANDBOX
    ? 'https://sandbox.tappaysdk.com/tpc/payment/pay-by-card-token'
    : 'https://prod.tappaysdk.com/tpc/payment/pay-by-card-token';

const SUBSCRIPTION_AMOUNT = 99; // NT$99/month (general premium)
const BORROW_AMOUNT = 288; // NT$288/month (official bot rental)
const SUBSCRIPTION_CURRENCY = 'TWD';
const SUBSCRIPTION_PERIOD_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

module.exports = function (devices, authMiddleware, ensureEntitySlots) {
    const router = express.Router();

    // ============================================
    // GET /status
    // ============================================
    router.get('/status', authMiddleware, async (req, res) => {
        try {
            const result = await pool.query(
                'SELECT subscription_status, subscription_provider, subscription_expires_at FROM user_accounts WHERE device_id = $1',
                [req.user.deviceId]
            );

            if (result.rows.length === 0) {
                return res.json({
                    success: true,
                    status: 'free',
                    provider: null,
                    expiresAt: null
                });
            }

            const user = result.rows[0];

            // Check expiration
            if (user.subscription_status === 'premium' &&
                user.subscription_expires_at &&
                user.subscription_expires_at < Date.now()) {
                await pool.query(
                    "UPDATE user_accounts SET subscription_status = 'expired' WHERE device_id = $1",
                    [req.user.deviceId]
                );
                user.subscription_status = 'expired';
            }

            // Get usage
            const usageResult = await pool.query(
                'SELECT message_count FROM usage_tracking WHERE device_id = $1 AND date = CURRENT_DATE',
                [req.user.deviceId]
            );

            res.json({
                success: true,
                status: user.subscription_status,
                provider: user.subscription_provider,
                expiresAt: user.subscription_expires_at,
                usageToday: usageResult.rows.length > 0 ? usageResult.rows[0].message_count : 0,
                usageLimit: user.subscription_status === 'premium' ? null : 15
            });
        } catch (error) {
            console.error('[Subscription] Status error:', error);
            res.status(500).json({ success: false, error: 'Failed to get status' });
        }
    });

    // ============================================
    // POST /tappay/pay
    // ============================================
    router.post('/tappay/pay', authMiddleware, async (req, res) => {
        try {
            const { prime, type } = req.body;

            if (!prime) {
                return res.status(400).json({ success: false, error: 'Missing prime token' });
            }

            if (!TAPPAY_PARTNER_KEY) {
                return res.status(500).json({ success: false, error: 'TapPay not configured' });
            }

            // Determine amount based on type
            const isBorrow = type === 'borrow';
            const amount = isBorrow ? BORROW_AMOUNT : SUBSCRIPTION_AMOUNT;
            const details = isBorrow ? 'E-Claw Official Bot Rental' : 'E-Claw Premium Subscription';

            // Get user info
            const userResult = await pool.query(
                'SELECT * FROM user_accounts WHERE id = $1',
                [req.user.userId]
            );

            if (userResult.rows.length === 0) {
                return res.status(404).json({ success: false, error: 'User not found' });
            }

            const user = userResult.rows[0];

            // Call TapPay Pay by Prime API
            const tappayResponse = await fetch(TAPPAY_API_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': TAPPAY_PARTNER_KEY
                },
                body: JSON.stringify({
                    prime: prime,
                    partner_key: TAPPAY_PARTNER_KEY,
                    merchant_id: TAPPAY_MERCHANT_ID,
                    amount: amount,
                    currency: SUBSCRIPTION_CURRENCY,
                    details: details,
                    cardholder: {
                        email: user.email,
                        name: user.email.split('@')[0],
                        phone_number: ''
                    },
                    remember: true // Store card for recurring
                })
            });

            const tappayData = await tappayResponse.json();
            console.log(`[TapPay] Response status: ${tappayData.status}, msg: ${tappayData.msg}`);

            // Log transaction (non-blocking, don't let DB errors break payment)
            try {
                await pool.query(
                    `INSERT INTO tappay_transactions (user_account_id, rec_trade_id, amount, currency, status, tappay_response)
                     VALUES ($1, $2, $3, $4, $5, $6)`,
                    [
                        user.id,
                        tappayData.rec_trade_id || null,
                        amount,
                        SUBSCRIPTION_CURRENCY,
                        tappayData.status === 0 ? 'success' : 'failed',
                        JSON.stringify(tappayData)
                    ]
                );
            } catch (dbErr) {
                console.error('[TapPay] Failed to log transaction (non-fatal):', dbErr.message);
            }

            if (tappayData.status !== 0) {
                const errMsg = tappayData.msg || 'Unknown error';
                console.error(`[TapPay] Payment failed: status=${tappayData.status}, msg=${errMsg}`);

                // IP mismatch (code 4) - include server IP for easy whitelist update
                if (tappayData.status === 4 && global.serverOutboundIP) {
                    console.error(`[TapPay] IP mismatch! Server IP: ${global.serverOutboundIP} - add this to TapPay portal`);
                    return res.status(400).json({
                        success: false,
                        error: `IP mismatch - please add ${global.serverOutboundIP}/32 to TapPay IP whitelist`
                    });
                }

                return res.status(400).json({
                    success: false,
                    error: `Payment failed: ${errMsg} (code: ${tappayData.status})`
                });
            }

            // Payment successful - update subscription
            const expiresAt = Date.now() + SUBSCRIPTION_PERIOD_MS;

            await pool.query(
                `UPDATE user_accounts SET
                    subscription_status = 'premium',
                    subscription_provider = 'tappay',
                    subscription_expires_at = $1,
                    tappay_card_key = $2,
                    tappay_card_token = $3,
                    updated_at = NOW()
                 WHERE id = $4`,
                [
                    expiresAt,
                    tappayData.card_secret ? tappayData.card_secret.card_key : null,
                    tappayData.card_secret ? tappayData.card_secret.card_token : null,
                    user.id
                ]
            );

            // Update in-memory device premium status
            if (devices[user.device_id]) {
                devices[user.device_id].isPremium = true;
                ensureEntitySlots(devices[user.device_id]);
            }

            console.log(`[Subscription] Premium activated for ${user.email} via TapPay`);

            res.json({
                success: true,
                message: 'Premium subscription activated!',
                expiresAt: expiresAt
            });
        } catch (error) {
            console.error('[Subscription] TapPay payment error:', error.message, error.stack);
            res.status(500).json({ success: false, error: `Payment processing failed: ${error.message}` });
        }
    });

    // ============================================
    // POST /cancel
    // ============================================
    router.post('/cancel', authMiddleware, async (req, res) => {
        try {
            // Don't immediately revoke - let current period expire
            await pool.query(
                `UPDATE user_accounts SET
                    tappay_card_key = NULL,
                    tappay_card_token = NULL,
                    updated_at = NOW()
                 WHERE id = $1`,
                [req.user.userId]
            );

            console.log(`[Subscription] Subscription cancelled for user ${req.user.userId}`);

            res.json({
                success: true,
                message: 'Subscription will end at the current period expiry.'
            });
        } catch (error) {
            console.error('[Subscription] Cancel error:', error);
            res.status(500).json({ success: false, error: 'Failed to cancel' });
        }
    });

    // ============================================
    // POST /verify-google (from Android APP)
    // ============================================
    router.post('/verify-google', async (req, res) => {
        try {
            const { deviceId, deviceSecret, purchaseToken, productId } = req.body;

            if (!deviceId || !deviceSecret) {
                return res.status(400).json({ success: false, error: 'Missing credentials' });
            }

            // Verify device credentials
            const device = devices[deviceId];
            if (!device || device.deviceSecret !== deviceSecret) {
                return res.status(401).json({ success: false, error: 'Invalid credentials' });
            }

            // Mark device as premium in memory
            device.isPremium = true;
            ensureEntitySlots(device);

            // Check if there's a user account linked to this device
            const userResult = await pool.query(
                'SELECT id FROM user_accounts WHERE device_id = $1',
                [deviceId]
            );

            if (userResult.rows.length > 0) {
                const expiresAt = Date.now() + SUBSCRIPTION_PERIOD_MS;
                await pool.query(
                    `UPDATE user_accounts SET
                        subscription_status = 'premium',
                        subscription_provider = 'google_play',
                        subscription_expires_at = $1,
                        updated_at = NOW()
                     WHERE device_id = $2`,
                    [expiresAt, deviceId]
                );
            }

            console.log(`[Subscription] Google Play premium verified for device ${deviceId}`);

            res.json({ success: true, message: 'Premium status synced' });
        } catch (error) {
            console.error('[Subscription] Google verify error:', error);
            res.status(500).json({ success: false, error: 'Verification failed' });
        }
    });

    // ============================================
    // POST /usage (device-auth, for Android APP)
    // ============================================
    router.post('/usage', async (req, res) => {
        try {
            const { deviceId, deviceSecret } = req.body;

            if (!deviceId || !deviceSecret) {
                return res.status(400).json({ success: false, error: 'Missing credentials' });
            }

            const device = devices[deviceId];
            if (!device || device.deviceSecret !== deviceSecret) {
                return res.status(401).json({ success: false, error: 'Invalid credentials' });
            }

            // Check subscription status
            let isPremium = !!device.isPremium;
            if (!isPremium) {
                const userResult = await pool.query(
                    "SELECT subscription_status, subscription_expires_at FROM user_accounts WHERE device_id = $1",
                    [deviceId]
                );
                if (userResult.rows.length > 0) {
                    const user = userResult.rows[0];
                    const expiresAt = user.subscription_expires_at ? parseInt(user.subscription_expires_at) : null;
                    isPremium = user.subscription_status === 'premium' && (!expiresAt || expiresAt > Date.now());
                }
            }

            // Get usage count
            const usageResult = await pool.query(
                'SELECT message_count FROM usage_tracking WHERE device_id = $1 AND date = CURRENT_DATE',
                [deviceId]
            );
            const usageToday = usageResult.rows.length > 0 ? usageResult.rows[0].message_count : 0;

            res.json({
                success: true,
                isPremium: isPremium,
                usageToday: usageToday,
                usageLimit: isPremium ? null : 15
            });
        } catch (error) {
            console.error('[Subscription] Usage check error:', error);
            res.status(500).json({ success: false, error: 'Failed to get usage' });
        }
    });

    // ============================================
    // Recurring charge cron (runs daily)
    // ============================================
    async function processRecurringCharges() {
        try {
            // Find users whose subscription expires in the next 3 days and have card tokens
            const threeDaysFromNow = Date.now() + 3 * 24 * 60 * 60 * 1000;
            const result = await pool.query(
                `SELECT * FROM user_accounts
                 WHERE subscription_status = 'premium'
                   AND subscription_provider = 'tappay'
                   AND tappay_card_key IS NOT NULL
                   AND tappay_card_token IS NOT NULL
                   AND subscription_expires_at < $1
                   AND subscription_expires_at > $2`,
                [threeDaysFromNow, Date.now() - 7 * 24 * 60 * 60 * 1000] // Not more than 7 days expired
            );

            for (const user of result.rows) {
                try {
                    const chargeResponse = await fetch(TAPPAY_CARD_TOKEN_URL, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'x-api-key': TAPPAY_PARTNER_KEY
                        },
                        body: JSON.stringify({
                            card_key: user.tappay_card_key,
                            card_token: user.tappay_card_token,
                            partner_key: TAPPAY_PARTNER_KEY,
                            merchant_id: TAPPAY_MERCHANT_ID,
                            amount: SUBSCRIPTION_AMOUNT,
                            currency: SUBSCRIPTION_CURRENCY,
                            details: 'E-Claw Premium Renewal'
                        })
                    });

                    const chargeData = await chargeResponse.json();

                    // Log transaction
                    await pool.query(
                        `INSERT INTO tappay_transactions (user_account_id, rec_trade_id, amount, currency, status, tappay_response)
                         VALUES ($1, $2, $3, $4, $5, $6)`,
                        [user.id, chargeData.rec_trade_id || null, SUBSCRIPTION_AMOUNT, SUBSCRIPTION_CURRENCY,
                        chargeData.status === 0 ? 'success' : 'failed', JSON.stringify(chargeData)]
                    );

                    if (chargeData.status === 0) {
                        const newExpiry = Date.now() + SUBSCRIPTION_PERIOD_MS;
                        await pool.query(
                            'UPDATE user_accounts SET subscription_expires_at = $1, updated_at = NOW() WHERE id = $2',
                            [newExpiry, user.id]
                        );
                        console.log(`[Subscription] Recurring charge success for ${user.email}`);
                    } else {
                        await pool.query(
                            "UPDATE user_accounts SET subscription_status = 'expired', tappay_card_key = NULL, tappay_card_token = NULL WHERE id = $1",
                            [user.id]
                        );
                        if (devices[user.device_id]) {
                            devices[user.device_id].isPremium = false;
                        }
                        console.log(`[Subscription] Recurring charge failed for ${user.email}: ${chargeData.msg}`);
                    }
                } catch (chargeErr) {
                    console.error(`[Subscription] Recurring charge error for ${user.email}:`, chargeErr.message);
                }
            }
        } catch (error) {
            console.error('[Subscription] Recurring cron error:', error);
        }
    }

    // Run recurring charges every 24 hours
    setInterval(processRecurringCharges, 24 * 60 * 60 * 1000);
    // Also run once 60 seconds after startup
    setTimeout(processRecurringCharges, 60 * 1000);

    // ============================================
    // Usage enforcement helper (exported for index.js)
    // ============================================
    async function enforceUsageLimit(deviceId) {
        // Check if premium (in-memory cache)
        const device = devices[deviceId];
        if (device && device.isPremium) return { allowed: true, remaining: null };

        // Check user account for premium status
        const userResult = await pool.query(
            "SELECT subscription_status, subscription_expires_at FROM user_accounts WHERE device_id = $1",
            [deviceId]
        );

        if (userResult.rows.length > 0) {
            const user = userResult.rows[0];
            const expiresAt = user.subscription_expires_at ? parseInt(user.subscription_expires_at) : null;
            const now = Date.now();

            if (user.subscription_status === 'premium' && (!expiresAt || expiresAt > now)) {
                if (device) device.isPremium = true;
                console.log(`[Usage] Premium user ${deviceId} - bypassing limit`);
                return { allowed: true, remaining: null };
            }

            if (user.subscription_status === 'premium' && expiresAt && expiresAt <= now) {
                console.log(`[Usage] Premium EXPIRED for ${deviceId}: expiresAt=${expiresAt}, now=${now}`);
            }
        }

        // Check usage count for free-tier users
        // First check current count WITHOUT incrementing to avoid inflating the counter on denied requests
        const checkResult = await pool.query(
            'SELECT message_count FROM usage_tracking WHERE device_id = $1 AND date = CURRENT_DATE',
            [deviceId]
        );

        const currentCount = checkResult.rows.length > 0 ? checkResult.rows[0].message_count : 0;
        const limit = 15;

        if (currentCount >= limit) {
            console.log(`[Usage] LIMIT HIT for ${deviceId}: ${currentCount}/${limit}`);
            return { allowed: false, remaining: 0, limit: limit, used: currentCount };
        }

        // Only increment if within limit
        const usageResult = await pool.query(
            `INSERT INTO usage_tracking (device_id, date, message_count)
             VALUES ($1, CURRENT_DATE, 1)
             ON CONFLICT (device_id, date)
             DO UPDATE SET message_count = usage_tracking.message_count + 1
             RETURNING message_count`,
            [deviceId]
        );

        const count = usageResult.rows[0].message_count;

        return { allowed: true, remaining: limit - count, limit: limit, used: count };
    }

    // Load premium status for all known users on startup
    async function loadPremiumStatus() {
        try {
            const result = await pool.query(
                "SELECT device_id FROM user_accounts WHERE subscription_status = 'premium' AND (subscription_expires_at IS NULL OR subscription_expires_at > $1)",
                [Date.now()]
            );
            for (const row of result.rows) {
                if (devices[row.device_id]) {
                    devices[row.device_id].isPremium = true;
                    ensureEntitySlots(devices[row.device_id]);
                }
            }
            console.log(`[Subscription] Loaded ${result.rows.length} premium users`);
        } catch (error) {
            console.error('[Subscription] Failed to load premium status:', error);
        }
    }

    return { router, enforceUsageLimit, loadPremiumStatus };
};
