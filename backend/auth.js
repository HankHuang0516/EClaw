/**
 * User Account Authentication Module
 *
 * Mounted at: /api/auth
 *
 * Endpoints:
 * POST /register       - Register new account (email + password)
 * POST /login          - Login, returns JWT in httpOnly cookie
 * POST /logout         - Clear session cookie
 * GET  /verify-email   - Verify email with token
 * POST /forgot-password - Send reset email
 * POST /reset-password  - Reset password with token
 * GET  /me             - Get current user info
 */

const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { Pool } = require('pg');
const { Resend } = require('resend');
const fs = require('fs');
const path = require('path');

const { OAuth2Client } = require('google-auth-library');
const safeEqual = require('./safe-equal');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/realbot'
});

const resend = new Resend(process.env.RESEND_API_KEY || 'dummy');

// OAuth configuration
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;
const FACEBOOK_APP_ID = process.env.FACEBOOK_APP_ID;
const FACEBOOK_APP_SECRET = process.env.FACEBOOK_APP_SECRET;

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) throw new Error('JWT_SECRET environment variable is required');
const JWT_EXPIRY = '7d';
const BCRYPT_ROUNDS = 12;
const BASE_URL = process.env.BASE_URL || 'https://eclawbot.com';
const EMAIL_FROM = 'EClawbot <noreply@twopiggyhavefun.uk>';

// Password validation: min 6 chars, must contain letters AND numbers
function isValidPassword(password) {
    if (!password || password.length < 6) return false;
    return /[a-zA-Z]/.test(password) && /[0-9]/.test(password);
}

// Generate random token
function generateToken() {
    return crypto.randomBytes(48).toString('hex');
}

// Generate virtual device credentials (same format as Android app)
function generateDeviceCredentials() {
    const deviceId = crypto.randomUUID();
    const deviceSecret = crypto.randomUUID() + '-' + crypto.randomUUID();
    return { deviceId, deviceSecret };
}

// Initialize database tables from schema file
async function initAuthDatabase() {
    try {
        const schemaPath = path.join(__dirname, 'auth_schema.sql');
        const schema = fs.readFileSync(schemaPath, 'utf8');

        const statements = [];
        let current = '';
        let inDollarBlock = false;
        const lines = schema.split('\n');
        for (const line of lines) {
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
            try {
                await pool.query(statement);
            } catch (err) {
                if (!err.message.includes('already exists') &&
                    !err.message.includes('duplicate key')) {
                    console.warn('[Auth] Schema warning:', err.message);
                }
            }
        }
        console.log('[Auth] Database initialized');
    } catch (error) {
        console.error('[Auth] Failed to init database:', error);
    }
}

/**
 * Factory function - receives the in-memory devices object from index.js
 */
module.exports = function(devices, getOrCreateDevice, serverLog) {
    // Audit helper (no-op if serverLog not provided for backward compat)
    const audit = serverLog || (() => {});
    // Callback invoked after email verification (set by index.js to flush pending messages)
    let _onEmailVerified = null;
    const router = express.Router();

    // ============================================
    // JWT Helpers
    // ============================================

    function signToken(user) {
        return jwt.sign(
            { userId: user.id, deviceId: user.device_id },
            JWT_SECRET,
            { expiresIn: JWT_EXPIRY }
        );
    }

    function verifyToken(token) {
        try {
            return jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
        } catch {
            return null;
        }
    }

    // Middleware: extract user from cookie
    function authMiddleware(req, res, next) {
        const token = req.cookies && req.cookies.eclaw_session;
        if (!token) {
            return res.status(401).json({ success: false, error: 'Not authenticated' });
        }
        const decoded = verifyToken(token);
        if (!decoded) {
            return res.status(401).json({ success: false, error: 'Invalid or expired session' });
        }
        // Enrich with deviceSecret from in-memory devices map (no longer stored in JWT)
        if (decoded.deviceId && devices[decoded.deviceId]) {
            decoded.deviceSecret = devices[decoded.deviceId].deviceSecret;
        }
        req.user = decoded;
        next();
    }

    // Middleware: require admin role (must come after authMiddleware)
    function adminMiddleware(req, res, next) {
        if (!req.user || !req.user.userId) {
            return res.status(403).json({ success: false, error: 'Admin access required' });
        }
        pool.query('SELECT is_admin FROM user_accounts WHERE id = $1', [req.user.userId])
            .then(result => {
                if (result.rows.length === 0 || !result.rows[0].is_admin) {
                    return res.status(403).json({ success: false, error: 'Admin access required' });
                }
                req.isAdmin = true;
                next();
            })
            .catch(err => {
                console.error('[Auth] Admin check error:', err);
                res.status(500).json({ success: false, error: 'Server error' });
            });
    }

    // ── Auth rate limiter (in-memory, per IP) ──
    const authRateLimits = {};
    const AUTH_RATE_WINDOW = 15 * 60 * 1000; // 15 minutes
    const AUTH_RATE_MAX = 10; // max attempts per window
    function authRateLimit(req, res, next) {
        const ip = req.ip || req.connection.remoteAddress || 'unknown';
        const now = Date.now();
        if (!authRateLimits[ip] || now - authRateLimits[ip].start > AUTH_RATE_WINDOW) {
            authRateLimits[ip] = { start: now, count: 1 };
        } else {
            authRateLimits[ip].count++;
        }
        if (authRateLimits[ip].count > AUTH_RATE_MAX) {
            return res.status(429).json({ success: false, error: 'Too many attempts, please try again later' });
        }
        next();
    }
    // Clean up stale entries every 30 minutes
    setInterval(() => {
        const now = Date.now();
        for (const ip in authRateLimits) {
            if (now - authRateLimits[ip].start > AUTH_RATE_WINDOW) delete authRateLimits[ip];
        }
    }, 30 * 60 * 1000).unref();

    // ============================================
    // POST /register
    // ============================================
    router.post('/register', authRateLimit, async (req, res) => {
        try {
            const { email, password } = req.body;

            if (!email || !password) {
                return res.status(400).json({ success: false, error: 'Email and password required' });
            }

            const emailLower = email.toLowerCase().trim();
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailLower)) {
                return res.status(400).json({ success: false, error: 'Invalid email format' });
            }

            if (!isValidPassword(password)) {
                return res.status(400).json({
                    success: false,
                    error: 'Password must be at least 6 characters and contain both letters and numbers'
                });
            }

            // Check if email already exists
            const existing = await pool.query('SELECT id FROM user_accounts WHERE email = $1', [emailLower]);
            if (existing.rows.length > 0) {
                return res.status(409).json({ success: false, error: 'Email already registered' });
            }

            // Hash password
            const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

            // Generate virtual device credentials
            const { deviceId, deviceSecret } = generateDeviceCredentials();

            // Generate verification token
            const verifyToken = generateToken();
            const verifyExpires = Date.now() + 24 * 60 * 60 * 1000; // 24 hours

            // Insert user
            const result = await pool.query(
                `INSERT INTO user_accounts (email, password_hash, device_id, device_secret, verify_token, verify_token_expires)
                 VALUES ($1, $2, $3, $4, $5, $6)
                 RETURNING id, email, device_id, device_secret`,
                [emailLower, passwordHash, deviceId, deviceSecret, verifyToken, verifyExpires]
            );

            const user = result.rows[0];

            // Create the virtual device in the in-memory devices object
            getOrCreateDevice(deviceId, deviceSecret);

            // Auto-provision first channel API key if none exist yet (non-fatal if fails)
            try {
                const existingCh = await pool.query(
                    'SELECT 1 FROM channel_accounts WHERE device_id = $1 LIMIT 1',
                    [deviceId]
                );
                if (existingCh.rows.length === 0) {
                    const channelApiKey = 'eck_' + crypto.randomBytes(32).toString('hex');
                    const channelApiSecret = 'ecs_' + crypto.randomBytes(32).toString('hex');
                    await pool.query(
                        `INSERT INTO channel_accounts (device_id, channel_api_key, channel_api_secret, created_at, updated_at)
                         VALUES ($1, $2, $3, $4, $4)`,
                        [deviceId, channelApiKey, channelApiSecret, Date.now()]
                    );
                    console.log(`[Auth] Channel API key auto-provisioned for ${emailLower}`);
                }
            } catch (channelErr) {
                console.error('[Auth] Auto-provision channel key failed (non-fatal):', channelErr.message);
            }

            // Send verification email
            try {
                await resend.emails.send({
                    from: EMAIL_FROM,
                    to: emailLower,
                    subject: 'Verify your E-Claw account',
                    html: `
                        <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; background: #0D0D1A; color: #fff; padding: 32px; border-radius: 12px;">
                            <h2 style="color: #6C63FF;">Welcome to E-Claw!</h2>
                            <p>Click the button below to verify your email address:</p>
                            <a href="${BASE_URL}/api/auth/verify-email?token=${verifyToken}"
                               style="display: inline-block; background: #6C63FF; color: #fff; padding: 12px 24px; border-radius: 8px; text-decoration: none; margin: 16px 0;">
                                Verify Email
                            </a>
                            <p style="color: #888; font-size: 12px; margin-top: 24px;">
                                This link expires in 24 hours.<br>
                                If you didn't create an account, you can ignore this email.
                            </p>
                        </div>
                    `
                });
                console.log(`[Auth] Verification email sent to ${emailLower}`);
            } catch (emailErr) {
                console.error('[Auth] Failed to send verification email:', emailErr.message);
            }

            audit('info', 'auth', 'Account registered', { userId: user.id, deviceId, ipAddress: req.ip, action: 'register', resource: 'account', result: 'success' });

            // Set session cookie so client can queue pending messages before verification
            const token = signToken(user);
            res.cookie('eclaw_session', token, {
                httpOnly: true,
                secure: process.env.NODE_ENV === 'production',
                sameSite: 'lax',
                maxAge: 7 * 24 * 60 * 60 * 1000,
                path: '/'
            });
            console.log('[Auth] Register: session cookie set for unverified user', user.id);

            res.json({
                success: true,
                message: 'Account created. Please check your email to verify.',
                userId: user.id,
                user: {
                    id: user.id,
                    email: user.email,
                    deviceId: user.device_id,
                    emailVerified: false
                }
            });
        } catch (error) {
            console.error('[Auth] Register error:', error);
            res.status(500).json({ success: false, error: 'Registration failed' });
        }
    });

    // ============================================
    // POST /login
    // ============================================
    router.post('/login', authRateLimit, async (req, res) => {
        try {
            const { email, password } = req.body;

            if (!email || !password) {
                return res.status(400).json({ success: false, error: 'Email and password required' });
            }

            const emailLower = email.toLowerCase().trim();

            const result = await pool.query(
                'SELECT * FROM user_accounts WHERE email = $1',
                [emailLower]
            );

            if (result.rows.length === 0) {
                audit('warn', 'auth', 'Login failed: unknown email', { ipAddress: req.ip, action: 'login', resource: 'session', result: 'failure', metadata: { email: emailLower } });
                return res.status(401).json({ success: false, error: 'Invalid email or password' });
            }

            const user = result.rows[0];

            // Social-only account guard
            if (!user.password_hash) {
                audit('warn', 'auth', 'Login failed: social-only account', { userId: user.id, ipAddress: req.ip, action: 'login', resource: 'session', result: 'failure' });
                return res.status(401).json({
                    success: false,
                    error: 'This account uses social login. Please sign in with Google or Facebook.',
                    code: 'SOCIAL_ONLY_ACCOUNT'
                });
            }

            // Verify password
            const match = await bcrypt.compare(password, user.password_hash);
            if (!match) {
                audit('warn', 'auth', 'Login failed: wrong password', { userId: user.id, ipAddress: req.ip, action: 'login', resource: 'session', result: 'failure' });
                return res.status(401).json({ success: false, error: 'Invalid email or password' });
            }

            // Check email verified
            if (!user.email_verified) {
                return res.status(403).json({
                    success: false,
                    error: 'Email not verified. Please check your inbox.',
                    code: 'EMAIL_NOT_VERIFIED'
                });
            }

            // Ensure virtual device exists in memory
            getOrCreateDevice(user.device_id, user.device_secret);

            // Update last login
            await pool.query(
                'UPDATE user_accounts SET last_login_at = NOW() WHERE id = $1',
                [user.id]
            );

            // Sign JWT and set cookie
            const token = signToken(user);
            res.cookie('eclaw_session', token, {
                httpOnly: true,
                secure: process.env.NODE_ENV === 'production',
                sameSite: 'lax',
                maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
                path: '/'
            });

            audit('info', 'auth', 'Login success', { userId: user.id, deviceId: user.device_id, ipAddress: req.ip, action: 'login', resource: 'session', result: 'success' });

            res.json({
                success: true,
                user: {
                    id: user.id,
                    email: user.email,
                    deviceId: user.device_id,
                    language: user.language,
                    subscriptionStatus: user.subscription_status,
                    subscriptionExpiresAt: user.subscription_expires_at
                }
            });
        } catch (error) {
            console.error('[Auth] Login error:', error);
            res.status(500).json({ success: false, error: 'Login failed' });
        }
    });

    // ============================================
    // POST /device-login (for Android users with device credentials)
    // ============================================
    router.post('/device-login', async (req, res) => {
        try {
            const { deviceId, deviceSecret } = req.body;

            if (!deviceId || !deviceSecret) {
                return res.status(400).json({ success: false, error: 'Device ID and Secret required' });
            }

            // Verify device credentials
            const device = devices[deviceId];
            if (!device || !safeEqual(device.deviceSecret, deviceSecret)) {
                return res.status(401).json({ success: false, error: 'Invalid device credentials' });
            }

            // Check if there's a user account linked to this device
            const result = await pool.query(
                'SELECT * FROM user_accounts WHERE device_id = $1',
                [deviceId]
            );

            let tokenPayload;
            let userInfo;

            if (result.rows.length > 0) {
                // Existing user account
                const user = result.rows[0];
                tokenPayload = { userId: user.id, deviceId: user.device_id };
                userInfo = {
                    id: user.id,
                    email: user.email,
                    deviceId: user.device_id,
                    language: user.language,
                    subscriptionStatus: user.subscription_status
                };
            } else {
                // No user account — create a session with device credentials only
                tokenPayload = { userId: null, deviceId };
                userInfo = {
                    id: null,
                    email: null,
                    deviceId: deviceId,
                    language: 'en',
                    subscriptionStatus: 'free'
                };
            }

            const token = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: JWT_EXPIRY });
            res.cookie('eclaw_session', token, {
                httpOnly: true,
                secure: process.env.NODE_ENV === 'production',
                sameSite: 'lax',
                maxAge: 7 * 24 * 60 * 60 * 1000,
                path: '/'
            });

            res.json({ success: true, user: userInfo });
        } catch (error) {
            console.error('[Auth] Device login error:', error);
            res.status(500).json({ success: false, error: 'Device login failed' });
        }
    });

    // ============================================
    // POST /logout
    // ============================================
    router.post('/logout', (req, res) => {
        audit('info', 'auth', 'Logout', { ipAddress: req.ip, action: 'logout', resource: 'session', result: 'success' });
        res.clearCookie('eclaw_session', { path: '/' });
        res.json({ success: true });
    });

    // ============================================
    // GET /verify-email?token=xxx
    // ============================================
    router.get('/verify-email', async (req, res) => {
        try {
            const { token, returnTo } = req.query;
            console.log('[Auth] verify-email called', { hasToken: !!token, returnTo: returnTo || null });
            if (!token) {
                return res.status(400).send('Missing verification token');
            }

            const result = await pool.query(
                'SELECT * FROM user_accounts WHERE verify_token = $1',
                [token]
            );

            if (result.rows.length === 0) {
                console.log('[Auth] verify-email: invalid token (no matching user)');
                return res.status(400).send('Invalid verification token');
            }

            const user = result.rows[0];
            console.log('[Auth] verify-email: found user', { userId: user.id, email: user.email, deviceId: user.device_id });

            if (user.verify_token_expires && user.verify_token_expires < Date.now()) {
                console.log('[Auth] verify-email: token expired', { expires: user.verify_token_expires, now: Date.now() });
                return res.status(400).send('Verification token expired. Please register again.');
            }

            await pool.query(
                'UPDATE user_accounts SET email_verified = TRUE, verify_token = NULL, verify_token_expires = NULL WHERE id = $1',
                [user.id]
            );
            console.log('[Auth] verify-email: email_verified set to TRUE for user', user.id);

            // Flush pending cross-device messages (queued before verification)
            if (_onEmailVerified && user.device_id) {
                try {
                    console.log('[Auth] verify-email: calling _onEmailVerified for device', user.device_id);
                    await _onEmailVerified(user.device_id);
                    console.log('[Auth] verify-email: _onEmailVerified completed');
                } catch (flushErr) {
                    console.error('[Auth] Pending message flush error:', flushErr.message);
                }
            } else {
                console.log('[Auth] verify-email: no _onEmailVerified callback or no device_id', { hasCallback: !!_onEmailVerified, deviceId: user.device_id });
            }

            // Redirect back to share-chat page if returnTo is provided, otherwise portal login
            if (returnTo && returnTo.startsWith('/c/')) {
                console.log('[Auth] verify-email: redirecting to share-chat returnTo', returnTo);
                res.redirect(`${BASE_URL}${returnTo}?verified=true`);
            } else {
                res.redirect(`${BASE_URL}/portal/index.html?verified=true`);
            }
        } catch (error) {
            console.error('[Auth] Verify email error:', error);
            res.status(500).send('Verification failed');
        }
    });

    // ============================================
    // POST /forgot-password
    // ============================================
    router.post('/forgot-password', authRateLimit, async (req, res) => {
        try {
            const { email } = req.body;
            if (!email) {
                return res.status(400).json({ success: false, error: 'Email required' });
            }

            const emailLower = email.toLowerCase().trim();
            const result = await pool.query('SELECT * FROM user_accounts WHERE email = $1', [emailLower]);

            // Always return success to prevent email enumeration
            if (result.rows.length === 0) {
                return res.json({ success: true, message: 'If the email exists, a reset link has been sent.' });
            }

            const user = result.rows[0];
            const resetToken = generateToken();
            const resetExpires = Date.now() + 60 * 60 * 1000; // 1 hour

            await pool.query(
                'UPDATE user_accounts SET reset_token = $1, reset_token_expires = $2 WHERE id = $3',
                [resetToken, resetExpires, user.id]
            );

            try {
                await resend.emails.send({
                    from: EMAIL_FROM,
                    to: emailLower,
                    subject: 'Reset your E-Claw password',
                    html: `
                        <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; background: #0D0D1A; color: #fff; padding: 32px; border-radius: 12px;">
                            <h2 style="color: #6C63FF;">Password Reset</h2>
                            <p>Click the button below to reset your password:</p>
                            <a href="${BASE_URL}/portal/index.html?reset=${resetToken}"
                               style="display: inline-block; background: #6C63FF; color: #fff; padding: 12px 24px; border-radius: 8px; text-decoration: none; margin: 16px 0;">
                                Reset Password
                            </a>
                            <p style="color: #888; font-size: 12px; margin-top: 24px;">
                                This link expires in 1 hour.<br>
                                If you didn't request a reset, you can ignore this email.
                            </p>
                        </div>
                    `
                });
                console.log(`[Auth] Reset email sent to ${emailLower}`);
            } catch (emailErr) {
                console.error('[Auth] Failed to send reset email:', emailErr.message);
            }

            res.json({ success: true, message: 'If the email exists, a reset link has been sent.' });
        } catch (error) {
            console.error('[Auth] Forgot password error:', error);
            res.status(500).json({ success: false, error: 'Failed to process request' });
        }
    });

    // ============================================
    // POST /reset-password
    // ============================================
    router.post('/reset-password', async (req, res) => {
        try {
            const { token, newPassword } = req.body;

            if (!token || !newPassword) {
                return res.status(400).json({ success: false, error: 'Token and new password required' });
            }

            if (!isValidPassword(newPassword)) {
                return res.status(400).json({
                    success: false,
                    error: 'Password must be at least 6 characters and contain both letters and numbers'
                });
            }

            const result = await pool.query(
                'SELECT * FROM user_accounts WHERE reset_token = $1',
                [token]
            );

            if (result.rows.length === 0) {
                return res.status(400).json({ success: false, error: 'Invalid reset token' });
            }

            const user = result.rows[0];

            if (user.reset_token_expires && user.reset_token_expires < Date.now()) {
                return res.status(400).json({ success: false, error: 'Reset token expired' });
            }

            const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);

            await pool.query(
                'UPDATE user_accounts SET password_hash = $1, reset_token = NULL, reset_token_expires = NULL WHERE id = $2',
                [passwordHash, user.id]
            );

            res.json({ success: true, message: 'Password reset successfully' });
        } catch (error) {
            console.error('[Auth] Reset password error:', error);
            res.status(500).json({ success: false, error: 'Reset failed' });
        }
    });

    // ============================================
    // GET /me (requires auth)
    // ============================================
    router.get('/me', authMiddleware, async (req, res) => {
        try {
            // Device-only login (no user account)
            if (!req.user.userId) {
                const deviceId = req.user.deviceId;
                const usageResult = await pool.query(
                    'SELECT message_count FROM usage_tracking WHERE device_id = $1 AND date = CURRENT_DATE',
                    [deviceId]
                );
                const usageToday = usageResult.rows.length > 0 ? usageResult.rows[0].message_count : 0;
                const device = devices[deviceId];
                const isPremium = device && device.isPremium;

                return res.json({
                    success: true,
                    user: {
                        id: null,
                        email: null,
                        deviceId: deviceId,
                        deviceSecret: req.user.deviceSecret || null,
                        subscriptionStatus: isPremium ? 'premium' : 'free',
                        subscriptionExpiresAt: null,
                        language: 'en',
                        emailVerified: false,
                        createdAt: null,
                        usageToday: usageToday,
                        usageLimit: isPremium ? null : 15
                    }
                });
            }

            const result = await pool.query(
                'SELECT id, email, device_id, device_secret, subscription_status, subscription_expires_at, language, email_verified, is_admin, created_at, display_name, avatar_url, google_id, facebook_id FROM user_accounts WHERE id = $1',
                [req.user.userId]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({ success: false, error: 'User not found' });
            }

            const user = result.rows[0];

            // Check if subscription has expired
            if (user.subscription_status === 'premium' &&
                user.subscription_expires_at &&
                user.subscription_expires_at < Date.now()) {
                await pool.query(
                    "UPDATE user_accounts SET subscription_status = 'expired' WHERE id = $1",
                    [user.id]
                );
                user.subscription_status = 'expired';
            }

            // Get today's usage
            const usageResult = await pool.query(
                'SELECT message_count FROM usage_tracking WHERE device_id = $1 AND date = CURRENT_DATE',
                [user.device_id]
            );
            const usageToday = usageResult.rows.length > 0 ? usageResult.rows[0].message_count : 0;

            // Get all channel accounts for this device
            let channelAccounts = [];
            try {
                const channelResult = await pool.query(
                    `SELECT id, channel_api_key, channel_api_secret, callback_url, status, created_at
                     FROM channel_accounts WHERE device_id = $1 ORDER BY created_at ASC`,
                    [user.device_id]
                );
                // Build a map of channelAccountId → bound entities
                const device = devices[user.device_id];
                const boundEntitiesMap = {};
                if (device) {
                    for (const [eid, entity] of Object.entries(device.entities)) {
                        if (entity.channelAccountId) {
                            if (!boundEntitiesMap[entity.channelAccountId]) boundEntitiesMap[entity.channelAccountId] = [];
                            boundEntitiesMap[entity.channelAccountId].push({
                                entityId: parseInt(eid),
                                name: entity.name || null,
                                avatar: entity.avatar || null
                            });
                        }
                    }
                }

                channelAccounts = channelResult.rows.map(r => ({
                    id: r.id,
                    channel_api_key: r.channel_api_key,
                    channel_api_secret: r.channel_api_secret,
                    has_callback: !!r.callback_url,
                    status: r.status,
                    created_at: parseInt(r.created_at),
                    boundEntities: boundEntitiesMap[r.id] || []
                }));
            } catch (chErr) {
                console.error('[Auth] Failed to query channel accounts:', chErr.message);
            }

            res.json({
                success: true,
                user: {
                    id: user.id,
                    email: user.email,
                    deviceId: user.device_id,
                    deviceSecret: user.device_secret,
                    subscriptionStatus: user.subscription_status,
                    subscriptionExpiresAt: user.subscription_expires_at,
                    language: user.language,
                    emailVerified: user.email_verified,
                    createdAt: user.created_at,
                    isAdmin: user.is_admin || false,
                    displayName: user.display_name || null,
                    avatarUrl: user.avatar_url || null,
                    googleLinked: !!user.google_id,
                    facebookLinked: !!user.facebook_id,
                    usageToday: usageToday,
                    usageLimit: user.subscription_status === 'premium' ? null : 15,
                    channelAccounts
                }
            });
        } catch (error) {
            console.error('[Auth] Get me error:', error);
            res.status(500).json({ success: false, error: 'Failed to get user info' });
        }
    });

    // ============================================
    // PATCH /language (update user language preference)
    // ============================================
    router.patch('/language', async (req, res) => {
        try {
            const { language, deviceId, deviceSecret } = req.body;
            const validLangs = ['en', 'zh', 'zh-CN', 'ja', 'ko', 'th', 'vi', 'id'];
            if (!language || !validLangs.includes(language)) {
                return res.status(400).json({ success: false, error: 'Invalid language' });
            }

            // Support both cookie auth and deviceId/deviceSecret auth (for Android)
            let userId = null;
            if (deviceId && deviceSecret) {
                const device = devices[deviceId];
                if (!device || !safeEqual(device.deviceSecret, deviceSecret)) {
                    return res.status(401).json({ success: false, error: 'Invalid device credentials' });
                }
                const result = await pool.query(
                    'SELECT id FROM user_accounts WHERE device_id = $1',
                    [deviceId]
                );
                if (result.rows.length > 0) userId = result.rows[0].id;
            } else {
                // Try cookie auth
                try {
                    const token = req.cookies?.eclaw_session;
                    if (token) {
                        const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
                        userId = decoded.userId;
                    }
                } catch (_) { /* ignore */ }
            }

            if (userId) {
                await pool.query(
                    'UPDATE user_accounts SET language = $1 WHERE id = $2',
                    [language, userId]
                );
            }

            res.json({ success: true, language });
        } catch (error) {
            console.error('[Auth] Update language error:', error);
            res.status(500).json({ success: false, error: 'Failed to update language' });
        }
    });

    // ============================================
    // POST /resend-verification (requires email)
    // ============================================
    router.post('/resend-verification', async (req, res) => {
        try {
            const { email } = req.body;
            if (!email) {
                return res.status(400).json({ success: false, error: 'Email required' });
            }

            const emailLower = email.toLowerCase().trim();
            const result = await pool.query('SELECT * FROM user_accounts WHERE email = $1', [emailLower]);

            if (result.rows.length === 0 || result.rows[0].email_verified) {
                return res.json({ success: true, message: 'If the email needs verification, a new link has been sent.' });
            }

            const user = result.rows[0];
            const newToken = generateToken();
            const newExpires = Date.now() + 24 * 60 * 60 * 1000;

            await pool.query(
                'UPDATE user_accounts SET verify_token = $1, verify_token_expires = $2 WHERE id = $3',
                [newToken, newExpires, user.id]
            );

            try {
                await resend.emails.send({
                    from: EMAIL_FROM,
                    to: emailLower,
                    subject: 'Verify your E-Claw account',
                    html: `
                        <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; background: #0D0D1A; color: #fff; padding: 32px; border-radius: 12px;">
                            <h2 style="color: #6C63FF;">Verify Your Email</h2>
                            <p>Click the button below to verify your email address:</p>
                            <a href="${BASE_URL}/api/auth/verify-email?token=${newToken}"
                               style="display: inline-block; background: #6C63FF; color: #fff; padding: 12px 24px; border-radius: 8px; text-decoration: none; margin: 16px 0;">
                                Verify Email
                            </a>
                            <p style="color: #888; font-size: 12px; margin-top: 24px;">This link expires in 24 hours.</p>
                        </div>
                    `
                });
            } catch (emailErr) {
                console.error('[Auth] Failed to resend verification:', emailErr.message);
            }

            res.json({ success: true, message: 'If the email needs verification, a new link has been sent.' });
        } catch (error) {
            console.error('[Auth] Resend verification error:', error);
            res.status(500).json({ success: false, error: 'Failed to resend' });
        }
    });

    // ============================================
    // POST /bind-email (for Android users to link email/password to their device)
    // ============================================
    router.post('/bind-email', async (req, res) => {
        try {
            const { deviceId, deviceSecret, email, password } = req.body;

            if (!deviceId || !deviceSecret || !email || !password) {
                return res.status(400).json({ success: false, error: 'deviceId, deviceSecret, email, and password are required' });
            }

            // Verify device credentials
            const device = devices[deviceId];
            if (!device || !safeEqual(device.deviceSecret, deviceSecret)) {
                return res.status(401).json({ success: false, error: 'Invalid device credentials' });
            }

            const emailLower = email.toLowerCase().trim();
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailLower)) {
                return res.status(400).json({ success: false, error: 'Invalid email format' });
            }

            if (!isValidPassword(password)) {
                return res.status(400).json({
                    success: false,
                    error: 'Password must be at least 6 characters and contain both letters and numbers'
                });
            }

            // Check if this device already has an account
            const existingDevice = await pool.query(
                'SELECT id, email FROM user_accounts WHERE device_id = $1',
                [deviceId]
            );
            if (existingDevice.rows.length > 0) {
                return res.status(409).json({
                    success: false,
                    error: 'This device already has a linked account: ' + existingDevice.rows[0].email
                });
            }

            // Check if email is already taken
            const existingEmail = await pool.query(
                'SELECT id FROM user_accounts WHERE email = $1',
                [emailLower]
            );
            if (existingEmail.rows.length > 0) {
                return res.status(409).json({ success: false, error: 'Email already registered' });
            }

            // Hash password
            const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

            // Generate verification token
            const verifyTokenValue = generateToken();
            const verifyExpires = Date.now() + 24 * 60 * 60 * 1000; // 24 hours

            // Create user account linked to existing device
            const result = await pool.query(
                `INSERT INTO user_accounts (email, password_hash, device_id, device_secret, verify_token, verify_token_expires)
                 VALUES ($1, $2, $3, $4, $5, $6)
                 RETURNING id, email, device_id`,
                [emailLower, passwordHash, deviceId, deviceSecret, verifyTokenValue, verifyExpires]
            );

            const user = result.rows[0];

            // Send verification email
            try {
                await resend.emails.send({
                    from: EMAIL_FROM,
                    to: emailLower,
                    subject: 'Verify your E-Claw account',
                    html: `
                        <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; background: #0D0D1A; color: #fff; padding: 32px; border-radius: 12px;">
                            <h2 style="color: #6C63FF;">Welcome to E-Claw!</h2>
                            <p>Your device has been linked to this email. Click below to verify:</p>
                            <a href="${BASE_URL}/api/auth/verify-email?token=${verifyTokenValue}"
                               style="display: inline-block; background: #6C63FF; color: #fff; padding: 12px 24px; border-radius: 8px; text-decoration: none; margin: 16px 0;">
                                Verify Email
                            </a>
                            <p style="color: #888; font-size: 12px; margin-top: 24px;">
                                This link expires in 24 hours.<br>
                                After verification, you can log in to the Web Portal with this email and password.
                            </p>
                        </div>
                    `
                });
                console.log(`[Auth] Bind-email verification sent to ${emailLower} for device ${deviceId}`);
            } catch (emailErr) {
                console.error('[Auth] Failed to send bind-email verification:', emailErr.message);
            }

            res.json({
                success: true,
                message: 'Email bound! Please check your inbox to verify.',
                email: user.email
            });
        } catch (error) {
            console.error('[Auth] Bind-email error:', error);
            res.status(500).json({ success: false, error: 'Failed to bind email' });
        }
    });

    // ============================================
    // GET /bind-email/status (check if device has a linked email account)
    // ============================================
    router.get('/bind-email/status', async (req, res) => {
        try {
            const { deviceId, deviceSecret } = req.query;

            if (!deviceId || !deviceSecret) {
                return res.status(400).json({ success: false, error: 'deviceId and deviceSecret required' });
            }

            // Verify device credentials
            const device = devices[deviceId];
            if (!device || !safeEqual(device.deviceSecret, deviceSecret)) {
                return res.status(401).json({ success: false, error: 'Invalid device credentials' });
            }

            const result = await pool.query(
                'SELECT email, email_verified, google_id, facebook_id, display_name, language FROM user_accounts WHERE device_id = $1',
                [deviceId]
            );

            if (result.rows.length === 0) {
                return res.json({ success: true, bound: false, email: null, emailVerified: false, googleLinked: false, facebookLinked: false, displayName: null, language: null });
            }

            const user = result.rows[0];

            // Fetch channel API key (if provisioned) — non-fatal
            let channelApiKey = null;
            let channelApiSecret = null;
            try {
                const chResult = await pool.query(
                    'SELECT channel_api_key, channel_api_secret FROM channel_accounts WHERE device_id = $1',
                    [deviceId]
                );
                if (chResult.rows.length > 0) {
                    channelApiKey = chResult.rows[0].channel_api_key;
                    channelApiSecret = chResult.rows[0].channel_api_secret;
                }
            } catch (_) { /* non-fatal */ }

            // Fetch user roles — non-fatal
            let roles = [];
            try {
                const userIdResult = await pool.query(
                    'SELECT id FROM user_accounts WHERE device_id = $1',
                    [deviceId]
                );
                if (userIdResult.rows.length > 0) {
                    const rolesResult = await pool.query(
                        'SELECT r.id FROM user_roles ur JOIN roles r ON ur.role_id = r.id WHERE ur.user_id = $1',
                        [userIdResult.rows[0].id]
                    );
                    roles = rolesResult.rows.map(r => r.id);
                }
            } catch (_) { /* non-fatal */ }

            res.json({
                success: true,
                bound: true,
                email: user.email,
                emailVerified: user.email_verified,
                googleLinked: !!user.google_id,
                facebookLinked: !!user.facebook_id,
                displayName: user.display_name || null,
                language: user.language || 'en',
                channelApiKey,
                channelApiSecret,
                roles
            });
        } catch (error) {
            console.error('[Auth] Bind-email status error:', error);
            res.status(500).json({ success: false, error: 'Failed to check status' });
        }
    });

    // ============================================
    // POST /app-login (for Android app to recover device credentials via email/password)
    // ============================================
    router.post('/app-login', async (req, res) => {
        try {
            const { email, password } = req.body;

            if (!email || !password) {
                return res.status(400).json({ success: false, error: 'Email and password required' });
            }

            const emailLower = email.toLowerCase().trim();

            const result = await pool.query(
                'SELECT * FROM user_accounts WHERE email = $1',
                [emailLower]
            );

            if (result.rows.length === 0) {
                return res.status(401).json({ success: false, error: 'Invalid email or password' });
            }

            const user = result.rows[0];

            // OAuth-only accounts cannot use password login
            if (!user.password_hash) {
                return res.status(401).json({
                    success: false,
                    error: 'This account uses social login. Please sign in with Google or Facebook.',
                    code: 'SOCIAL_ONLY_ACCOUNT'
                });
            }

            // Verify password
            const match = await bcrypt.compare(password, user.password_hash);
            if (!match) {
                return res.status(401).json({ success: false, error: 'Invalid email or password' });
            }

            // Check email verified
            if (!user.email_verified) {
                return res.status(403).json({
                    success: false,
                    error: 'Email not verified. Please check your inbox.',
                    code: 'EMAIL_NOT_VERIFIED'
                });
            }

            // Ensure virtual device exists in memory
            getOrCreateDevice(user.device_id, user.device_secret);

            // Update last login
            await pool.query(
                'UPDATE user_accounts SET last_login_at = NOW() WHERE id = $1',
                [user.id]
            );

            console.log(`[Auth] App-login success for ${emailLower}, device ${user.device_id}`);

            // Return device credentials so the app can store them locally
            res.json({
                success: true,
                deviceId: user.device_id,
                deviceSecret: user.device_secret,
                email: user.email,
                language: user.language || 'en'
            });
        } catch (error) {
            console.error('[Auth] App-login error:', error);
            res.status(500).json({ success: false, error: 'Login failed' });
        }
    });

    // ============================================
    // OAuth: Shared account merge logic
    // ============================================
    async function handleOAuthLogin(provider, providerId, email, displayName, avatarUrl, deviceId, deviceSecret, req, res) {
        const providerCol = provider === 'google' ? 'google_id' : 'facebook_id';

        // Step 1: Lookup by provider ID
        const byProvider = await pool.query(
            `SELECT * FROM user_accounts WHERE ${providerCol} = $1`,
            [providerId]
        );

        if (byProvider.rows.length > 0) {
            const user = byProvider.rows[0];
            // Update display info and last login
            await pool.query(
                `UPDATE user_accounts SET display_name = COALESCE($1, display_name), avatar_url = COALESCE($2, avatar_url), last_login_at = NOW() WHERE id = $3`,
                [displayName, avatarUrl, user.id]
            );
            getOrCreateDevice(user.device_id, user.device_secret);
            audit('info', 'auth', `OAuth login (${provider})`, { userId: user.id, deviceId: user.device_id, ipAddress: req?.ip, action: 'oauth_login', resource: 'session', result: 'success', metadata: { provider } });
            const token = signToken(user);
            res.cookie('eclaw_session', token, {
                httpOnly: true, secure: process.env.NODE_ENV === 'production',
                sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000
            });
            return res.json({
                success: true,
                user: {
                    id: user.id, email: user.email,
                    deviceId: user.device_id,
                    displayName: displayName || user.display_name,
                    avatarUrl: avatarUrl || user.avatar_url,
                    isNewAccount: false,
                    subscriptionStatus: user.subscription_status,
                    googleLinked: !!user.google_id, facebookLinked: !!user.facebook_id
                }
            });
        }

        // Step 2: Lookup by email (if available)
        if (email) {
            const byEmail = await pool.query(
                'SELECT * FROM user_accounts WHERE email = $1',
                [email.toLowerCase()]
            );

            if (byEmail.rows.length > 0) {
                const user = byEmail.rows[0];
                // Merge: link this provider to existing account
                await pool.query(
                    `UPDATE user_accounts SET ${providerCol} = $1, display_name = COALESCE($2, display_name), avatar_url = COALESCE($3, avatar_url), email_verified = TRUE, last_login_at = NOW() WHERE id = $4`,
                    [providerId, displayName, avatarUrl, user.id]
                );
                user[providerCol] = providerId;
                getOrCreateDevice(user.device_id, user.device_secret);
                const token = signToken(user);
                res.cookie('eclaw_session', token, {
                    httpOnly: true, secure: process.env.NODE_ENV === 'production',
                    sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000
                });
                return res.json({
                    success: true,
                    user: {
                        id: user.id, email: user.email,
                        deviceId: user.device_id,
                        displayName: displayName || user.display_name,
                        avatarUrl: avatarUrl || user.avatar_url,
                        isNewAccount: false,
                        subscriptionStatus: user.subscription_status,
                        googleLinked: provider === 'google' ? true : !!user.google_id,
                        facebookLinked: provider === 'facebook' ? true : !!user.facebook_id
                    }
                });
            }
        }

        // Step 3: Check if deviceId+deviceSecret provided and has existing user row
        if (deviceId && deviceSecret) {
            const device = devices[deviceId];
            if (device && safeEqual(device.deviceSecret, deviceSecret)) {
                const byDevice = await pool.query(
                    'SELECT * FROM user_accounts WHERE device_id = $1',
                    [deviceId]
                );
                if (byDevice.rows.length > 0) {
                    const user = byDevice.rows[0];
                    // Link provider to existing device account
                    await pool.query(
                        `UPDATE user_accounts SET ${providerCol} = $1, display_name = COALESCE($2, display_name), avatar_url = COALESCE($3, avatar_url), email = COALESCE(email, $4), email_verified = COALESCE(NULLIF(email_verified, FALSE), $5), auth_provider = $6, last_login_at = NOW() WHERE id = $7`,
                        [providerId, displayName, avatarUrl, email ? email.toLowerCase() : null, !!email, provider, user.id]
                    );
                    getOrCreateDevice(user.device_id, user.device_secret);
                    const token = signToken(user);
                    res.cookie('eclaw_session', token, {
                        httpOnly: true, secure: process.env.NODE_ENV === 'production',
                        sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000
                    });
                    return res.json({
                        success: true,
                        user: {
                            id: user.id, email: email || user.email,
                            deviceId: user.device_id,
                            displayName: displayName || user.display_name,
                            avatarUrl: avatarUrl || user.avatar_url,
                            isNewAccount: false,
                            subscriptionStatus: user.subscription_status,
                            googleLinked: provider === 'google' ? true : !!user.google_id,
                            facebookLinked: provider === 'facebook' ? true : !!user.facebook_id
                        }
                    });
                }
            }
        }

        // Step 4: Create new account
        const creds = (deviceId && deviceSecret && devices[deviceId] && safeEqual(devices[deviceId].deviceSecret, deviceSecret))
            ? { deviceId, deviceSecret }
            : generateDeviceCredentials();

        const insertResult = await pool.query(
            `INSERT INTO user_accounts (email, ${providerCol}, display_name, avatar_url, email_verified, auth_provider, device_id, device_secret)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             RETURNING *`,
            [email ? email.toLowerCase() : null, providerId, displayName, avatarUrl, !!email, provider, creds.deviceId, creds.deviceSecret]
        );

        const newUser = insertResult.rows[0];
        getOrCreateDevice(newUser.device_id, newUser.device_secret);

        const token = signToken(newUser);
        res.cookie('eclaw_session', token, {
            httpOnly: true, secure: process.env.NODE_ENV === 'production',
            sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000
        });

        console.log(`[Auth] OAuth ${provider} new account created: ${email || providerId}, device ${newUser.device_id}`);

        return res.json({
            success: true,
            user: {
                id: newUser.id, email: newUser.email,
                deviceId: newUser.device_id,
                displayName, avatarUrl,
                isNewAccount: true,
                subscriptionStatus: 'free',
                googleLinked: provider === 'google',
                facebookLinked: provider === 'facebook'
            }
        });
    }

    // ============================================
    // GET /oauth/config — Public OAuth client IDs for frontend SDKs
    // ============================================
    router.get('/oauth/config', (req, res) => {
        res.json({
            googleClientId: GOOGLE_CLIENT_ID || null,
            facebookAppId: FACEBOOK_APP_ID || null
        });
    });

    // ============================================
    // POST /oauth/google — Verify Google ID token or access token
    // ============================================
    router.post('/oauth/google', async (req, res) => {
        try {
            if (!GOOGLE_CLIENT_ID) {
                return res.status(503).json({ success: false, error: 'Google Sign-In not configured' });
            }

            const { idToken, accessToken, deviceId, deviceSecret } = req.body;
            if (!idToken && !accessToken) {
                return res.status(400).json({ success: false, error: 'idToken or accessToken required' });
            }

            let googleId, email, displayName, avatarUrl;

            if (idToken) {
                // Android / server-side: verify ID token directly
                const ticket = await googleClient.verifyIdToken({
                    idToken,
                    audience: GOOGLE_CLIENT_ID
                });
                const payload = ticket.getPayload();
                googleId = payload.sub;
                email = payload.email_verified ? payload.email : null;
                displayName = payload.name || null;
                avatarUrl = payload.picture || null;
            } else {
                // Web: verify access token via Google userinfo API
                const userInfoRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
                    headers: { Authorization: `Bearer ${accessToken}` }
                });
                if (!userInfoRes.ok) {
                    return res.status(401).json({ success: false, error: 'Invalid Google access token' });
                }
                const userInfo = await userInfoRes.json();
                googleId = userInfo.sub;
                email = userInfo.email_verified ? userInfo.email : null;
                displayName = userInfo.name || null;
                avatarUrl = userInfo.picture || null;
            }

            await handleOAuthLogin('google', googleId, email, displayName, avatarUrl, deviceId, deviceSecret, req, res);
        } catch (error) {
            console.error('[Auth] Google OAuth error:', error);
            res.status(401).json({ success: false, error: 'Google sign-in failed: ' + (error.message || 'Invalid token') });
        }
    });

    // ============================================
    // POST /oauth/facebook — Verify Facebook access token
    // ============================================
    router.post('/oauth/facebook', async (req, res) => {
        try {
            if (!FACEBOOK_APP_ID || !FACEBOOK_APP_SECRET) {
                return res.status(503).json({ success: false, error: 'Facebook Login not configured' });
            }

            const { accessToken, deviceId, deviceSecret } = req.body;
            if (!accessToken) {
                return res.status(400).json({ success: false, error: 'accessToken required' });
            }

            // Verify token with Facebook Graph API
            const fbRes = await fetch(
                `https://graph.facebook.com/me?fields=id,name,email,picture.type(large)&access_token=${encodeURIComponent(accessToken)}`
            );

            if (!fbRes.ok) {
                const errBody = await fbRes.text();
                console.error('[Auth] Facebook token verification failed:', errBody);
                return res.status(401).json({ success: false, error: 'Invalid Facebook token' });
            }

            const fbUser = await fbRes.json();

            const facebookId = fbUser.id;
            const email = fbUser.email || null; // May not be provided
            const displayName = fbUser.name || null;
            const avatarUrl = fbUser.picture?.data?.url || null;

            await handleOAuthLogin('facebook', facebookId, email, displayName, avatarUrl, deviceId, deviceSecret, req, res);
        } catch (error) {
            console.error('[Auth] Facebook OAuth error:', error);
            res.status(401).json({ success: false, error: 'Facebook login failed: ' + (error.message || 'Invalid token') });
        }
    });

    // Facebook Data Deletion Callback (required by Facebook platform policy)
    router.post('/oauth/facebook/data-deletion', (req, res) => {
        const signedRequest = req.body.signed_request;
        if (!signedRequest || !FACEBOOK_APP_SECRET) {
            return res.json({ url: `${BASE_URL}/portal/index.html`, confirmation_code: 'no_data' });
        }

        try {
            const [encodedSig, payload] = signedRequest.split('.');
            const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'));
            const userId = data.user_id;

            // Delete user's Facebook link asynchronously
            pool.query(
                `UPDATE users SET facebook_id = NULL WHERE facebook_id = $1`,
                [userId]
            ).then(() => {
                console.log(`[Auth] Facebook data deletion for fb user ${userId}`);
            }).catch(err => {
                console.error('[Auth] Facebook data deletion error:', err.message);
            });

            res.json({
                url: `${BASE_URL}/portal/index.html`,
                confirmation_code: `fb_del_${userId}`
            });
        } catch (err) {
            console.error('[Auth] Facebook data deletion parse error:', err.message);
            res.json({ url: `${BASE_URL}/portal/index.html`, confirmation_code: 'parse_error' });
        }
    });

    // ============================================
    // Generic OIDC SSO (Issue #175)
    // ============================================

    // Parse OIDC provider config from environment variables
    // Format: OIDC_PROVIDER_<NAME>_ISSUER, _CLIENT_ID, _CLIENT_SECRET
    const OIDC_PROVIDERS = {};
    const oidcEnvKeys = Object.keys(process.env).filter(k => k.startsWith('OIDC_PROVIDER_'));
    const oidcProviderNames = new Set(oidcEnvKeys.map(k => k.split('_').slice(2, -1).join('_')));
    for (const name of oidcProviderNames) {
        const prefix = `OIDC_PROVIDER_${name}`;
        const issuer = process.env[`${prefix}_ISSUER`];
        const clientId = process.env[`${prefix}_CLIENT_ID`];
        const clientSecret = process.env[`${prefix}_CLIENT_SECRET`];
        if (issuer && clientId && clientSecret) {
            OIDC_PROVIDERS[name.toLowerCase()] = {
                name: name.toLowerCase(),
                issuer: issuer.replace(/\/$/, ''),
                clientId,
                clientSecret
            };
            console.log(`[Auth] OIDC provider configured: ${name.toLowerCase()}`);
        }
    }

    // OIDC discovery cache (1hr TTL)
    const oidcDiscoveryCache = {};
    async function discoverOIDC(issuer) {
        const cached = oidcDiscoveryCache[issuer];
        if (cached && Date.now() - cached.fetchedAt < 3600000) return cached.data;
        const url = issuer + '/.well-known/openid-configuration';
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`OIDC discovery failed for ${issuer}: ${resp.status}`);
        const data = await resp.json();
        oidcDiscoveryCache[issuer] = { data, fetchedAt: Date.now() };
        return data;
    }

    /**
     * GET /oauth/providers — List configured OIDC providers (public)
     */
    router.get('/oauth/providers', async (req, res) => {
        const providers = [];
        for (const [name, config] of Object.entries(OIDC_PROVIDERS)) {
            try {
                const discovery = await discoverOIDC(config.issuer);
                providers.push({
                    name,
                    authorizationUrl: discovery.authorization_endpoint,
                    clientId: config.clientId,
                    scopes: 'openid email profile'
                });
            } catch (err) {
                console.error(`[Auth] OIDC discovery failed for ${name}:`, err.message);
            }
        }
        providers.push(
            ...(GOOGLE_CLIENT_ID ? [{ name: 'google', type: 'built-in', clientId: GOOGLE_CLIENT_ID }] : []),
            ...(FACEBOOK_APP_ID ? [{ name: 'facebook', type: 'built-in', clientId: FACEBOOK_APP_ID }] : [])
        );
        res.json({ success: true, providers });
    });

    /**
     * POST /oauth/oidc — Exchange authorization code for tokens (Generic OIDC)
     * Body: { provider, code, redirectUri, deviceId?, deviceSecret? }
     */
    router.post('/oauth/oidc', async (req, res) => {
        try {
            const { provider: providerName, code, redirectUri, deviceId, deviceSecret } = req.body;

            if (!providerName || !code || !redirectUri) {
                return res.status(400).json({ success: false, error: 'provider, code, and redirectUri required' });
            }

            const config = OIDC_PROVIDERS[providerName.toLowerCase()];
            if (!config) {
                return res.status(400).json({ success: false, error: `Unknown OIDC provider: ${providerName}` });
            }

            // Discover endpoints
            const discovery = await discoverOIDC(config.issuer);

            // Exchange code for tokens
            const tokenResp = await fetch(discovery.token_endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    grant_type: 'authorization_code',
                    code,
                    redirect_uri: redirectUri,
                    client_id: config.clientId,
                    client_secret: config.clientSecret
                })
            });

            if (!tokenResp.ok) {
                const errBody = await tokenResp.text();
                audit('warn', 'auth', `OIDC token exchange failed (${providerName})`, { ipAddress: req.ip, action: 'oauth_login', resource: 'session', result: 'failure', metadata: { provider: providerName, error: errBody.substring(0, 200) } });
                return res.status(401).json({ success: false, error: 'Token exchange failed' });
            }

            const tokens = await tokenResp.json();
            const idToken = tokens.id_token;
            if (!idToken) {
                return res.status(401).json({ success: false, error: 'No id_token in response' });
            }

            // Decode ID token (verify claims — basic validation)
            const [, payloadB64] = idToken.split('.');
            const claims = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf-8'));

            // Validate issuer and audience
            if (claims.iss !== config.issuer && claims.iss !== config.issuer + '/') {
                return res.status(401).json({ success: false, error: 'Invalid token issuer' });
            }
            if (claims.aud !== config.clientId && !(Array.isArray(claims.aud) && claims.aud.includes(config.clientId))) {
                return res.status(401).json({ success: false, error: 'Invalid token audience' });
            }
            if (claims.exp && claims.exp < Math.floor(Date.now() / 1000)) {
                return res.status(401).json({ success: false, error: 'Token expired' });
            }

            const sub = claims.sub;
            const email = claims.email_verified !== false ? claims.email : null;
            const displayName = claims.name || claims.preferred_username || null;
            const avatarUrl = claims.picture || null;

            // Lookup by OIDC provider + subject
            const byOIDC = await pool.query(
                'SELECT * FROM user_accounts WHERE oidc_provider = $1 AND oidc_subject = $2',
                [providerName.toLowerCase(), sub]
            );

            let user;
            let isNewAccount = false;

            if (byOIDC.rows.length > 0) {
                // Existing OIDC-linked account
                user = byOIDC.rows[0];
                await pool.query(
                    `UPDATE user_accounts SET display_name = COALESCE($1, display_name), avatar_url = COALESCE($2, avatar_url), last_login_at = NOW() WHERE id = $3`,
                    [displayName, avatarUrl, user.id]
                );
            } else if (email) {
                // Try email merge
                const byEmail = await pool.query('SELECT * FROM user_accounts WHERE email = $1', [email.toLowerCase()]);
                if (byEmail.rows.length > 0) {
                    user = byEmail.rows[0];
                    await pool.query(
                        `UPDATE user_accounts SET oidc_provider = $1, oidc_subject = $2, display_name = COALESCE($3, display_name), avatar_url = COALESCE($4, avatar_url), email_verified = TRUE, last_login_at = NOW() WHERE id = $5`,
                        [providerName.toLowerCase(), sub, displayName, avatarUrl, user.id]
                    );
                }
            }

            if (!user) {
                // Create new account
                const { deviceId: newDeviceId, deviceSecret: newDeviceSecret } = generateDeviceCredentials();
                const result = await pool.query(
                    `INSERT INTO user_accounts (email, oidc_provider, oidc_subject, display_name, avatar_url, auth_provider, device_id, device_secret, email_verified)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE)
                     RETURNING *`,
                    [email, providerName.toLowerCase(), sub, displayName, avatarUrl, `oidc:${providerName.toLowerCase()}`, newDeviceId, newDeviceSecret]
                );
                user = result.rows[0];
                isNewAccount = true;
            }

            // Ensure device exists
            getOrCreateDevice(user.device_id, user.device_secret);

            // Link device credentials if provided
            if (deviceId && deviceSecret && deviceId !== user.device_id) {
                const existingDevice = devices[deviceId];
                if (existingDevice && safeEqual(existingDevice.deviceSecret, deviceSecret)) {
                    // Already has a device — keep the provided one if no data on account device
                    // (simplified: always use the account's virtual device)
                }
            }

            audit('info', 'auth', `OIDC login (${providerName})`, { userId: user.id, deviceId: user.device_id, ipAddress: req.ip, action: 'oauth_login', resource: 'session', result: 'success', metadata: { provider: providerName } });

            const token = signToken(user);
            res.cookie('eclaw_session', token, {
                httpOnly: true, secure: process.env.NODE_ENV === 'production',
                sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000
            });

            res.json({
                success: true,
                user: {
                    id: user.id, email: user.email,
                    deviceId: user.device_id,
                    displayName: displayName || user.display_name,
                    avatarUrl: avatarUrl || user.avatar_url,
                    isNewAccount,
                    subscriptionStatus: user.subscription_status,
                    oidcProvider: providerName.toLowerCase()
                }
            });
        } catch (error) {
            console.error('[Auth] OIDC login error:', error);
            res.status(500).json({ success: false, error: 'OIDC login failed' });
        }
    });

    // ============================================
    // DELETE /account — Permanently delete user account and all associated data
    // ============================================
    router.delete('/account', authMiddleware, async (req, res) => {
        const debugLog = [];
        const debug = (step, detail) => {
            const entry = `[DeleteAccount] ${step}: ${detail}`;
            console.log(entry);
            debugLog.push(entry);
        };

        debug('START', `userId=${req.user.userId} deviceId=${req.user.deviceId}`);

        if (!req.user.userId) {
            debug('REJECT', 'No userId in session — device-only session');
            return res.status(403).json({ success: false, error: 'Device-only sessions cannot delete accounts. Please sign in with Google or email.', debugLog });
        }

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            debug('TX', 'BEGIN');

            const userResult = await client.query(
                'SELECT device_id, email FROM user_accounts WHERE id = $1',
                [req.user.userId]
            );
            debug('LOOKUP', `user_accounts rows=${userResult.rows.length}`);
            if (!userResult.rows.length) {
                await client.query('ROLLBACK');
                debug('REJECT', 'Account not found in DB');
                return res.status(404).json({ success: false, error: 'Account not found', debugLog });
            }

            const deviceId = userResult.rows[0].device_id;
            const email = userResult.rows[0].email;
            debug('USER', `email=${email} deviceId=${deviceId}`);

            // Helper to delete from a table with debug logging
            // Uses SAVEPOINT so table-not-found (42P01) doesn't abort the transaction
            const safeDelete = async (table, whereClause, params, label) => {
                const stepLabel = label || `DELETE ${table}`;
                const sp = `sp_${table.replace(/[^a-z0-9_]/gi, '_')}`;
                try {
                    await client.query(`SAVEPOINT ${sp}`);
                    const r = await client.query(`DELETE FROM ${table} WHERE ${whereClause}`, params);
                    await client.query(`RELEASE SAVEPOINT ${sp}`);
                    debug(stepLabel, `deleted ${r.rowCount} rows`);
                } catch (e) {
                    await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
                    if (e.code === '42P01') {
                        debug(stepLabel, `SKIPPED (table does not exist)`);
                        return;
                    }
                    debug(`${stepLabel} ERROR`, `${e.code || 'UNKNOWN'}: ${e.message}`);
                    throw e;
                }
            };

            // Helper to update with debug logging
            // Uses SAVEPOINT so table-not-found (42P01) doesn't abort the transaction
            const safeUpdate = async (sql, params, label) => {
                const sp = `sp_upd_${Date.now()}`;
                try {
                    await client.query(`SAVEPOINT ${sp}`);
                    const r = await client.query(sql, params);
                    await client.query(`RELEASE SAVEPOINT ${sp}`);
                    debug(label, `affected ${r.rowCount} rows`);
                } catch (e) {
                    await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
                    if (e.code === '42P01') {
                        debug(label, `SKIPPED (table does not exist)`);
                        return;
                    }
                    debug(`${label} ERROR`, `${e.code || 'UNKNOWN'}: ${e.message}`);
                    throw e;
                }
            };

            if (deviceId) {
                debug('DEVICE_CLEANUP', `Starting device-scoped cleanup for ${deviceId}`);

                // --- Device-scoped tables (no FK CASCADE) ---
                await safeDelete('chat_messages', 'device_id = $1', [deviceId]);
                await safeDelete('chat_uploads', 'device_id = $1', [deviceId]);
                await safeDelete('message_reactions', 'device_id = $1', [deviceId]);
                await safeDelete('official_bot_bindings', 'device_id = $1', [deviceId]);
                await safeDelete('handshake_failures', 'device_id = $1', [deviceId]);
                await safeDelete('usage_tracking', 'device_id = $1', [deviceId]);
                await safeDelete('feedback', 'device_id = $1', [deviceId]);
                await safeDelete('server_logs', 'device_id = $1', [deviceId]);
                await safeDelete('pending_cross_messages', 'sender_device_id = $1', [deviceId]);

                // --- Device-scoped tables (have FK CASCADE to devices, but delete explicitly for safety) ---
                await safeDelete('mission_dashboard', 'device_id = $1', [deviceId], 'DELETE mission_dashboard (cascades mission_items/notes/rules)');
                await safeDelete('device_vars', 'device_id = $1', [deviceId]);
                await safeDelete('device_telemetry', 'device_id = $1', [deviceId]);
                await safeDelete('schedules', 'device_id = $1', [deviceId]);
                await safeDelete('agent_card_holder', 'device_id = $1', [deviceId]);
                await safeDelete('entity_trash', 'device_id = $1', [deviceId]);
                await safeDelete('channel_accounts', 'device_id = $1', [deviceId]);
                await safeDelete('bot_files', 'device_id = $1', [deviceId]);
                await safeDelete('push_subscriptions', 'device_id = $1', [deviceId]);
                await safeDelete('cross_device_contacts', 'device_id = $1', [deviceId]);

                // --- OAuth data owned by this device ---
                await safeDelete('oauth_tokens', 'device_id = $1', [deviceId]);
                await safeDelete('oauth_authorization_codes', 'device_id = $1', [deviceId]);
                await safeDelete('oauth_clients', 'owner_device_id = $1', [deviceId]);

                // --- Official bots: unassign if assigned to this device ---
                await safeUpdate(
                    `UPDATE official_bots SET assigned_device_id = NULL, assigned_entity_id = NULL, assigned_at = NULL, status = 'available' WHERE assigned_device_id = $1`,
                    [deviceId],
                    'UPDATE official_bots (unassign)'
                );

                // --- Entities: delete (not just unbind) since account is being destroyed ---
                await safeDelete('entities', 'device_id = $1', [deviceId]);

                // --- Device record itself ---
                await safeDelete('devices', 'device_id = $1', [deviceId]);

                debug('DEVICE_CLEANUP', 'Complete');
            } else {
                debug('DEVICE_CLEANUP', 'SKIPPED — no deviceId associated');
            }

            // --- User-scoped FK references ---
            debug('USER_CLEANUP', 'Starting user-scoped cleanup');
            await safeDelete('tappay_transactions', 'user_account_id = $1', [req.user.userId]);
            await safeUpdate(
                'UPDATE user_roles SET granted_by = NULL WHERE granted_by = $1',
                [req.user.userId],
                'UPDATE user_roles.granted_by NULL'
            );
            await safeDelete('user_roles', 'user_id = $1', [req.user.userId]);
            // Also clean server_logs by user_id (audit trail)
            await safeDelete('server_logs', 'user_id = $1::uuid', [req.user.userId], 'DELETE server_logs (by user_id)');
            await safeDelete('user_accounts', 'id = $1', [req.user.userId]);

            await client.query('COMMIT');
            debug('TX', 'COMMIT OK');

            res.clearCookie('eclaw_session', { path: '/' });
            console.log(`[Auth] Account deleted: userId=${req.user.userId} email=${email} deviceId=${deviceId}`);
            res.json({ success: true, debugLog });
        } catch (error) {
            await client.query('ROLLBACK').catch(() => {});
            debug('TX', `ROLLBACK due to error`);
            debug('ERROR', `${error.code || 'UNKNOWN'} | table=${error.table || '?'} | constraint=${error.constraint || '?'} | detail=${error.detail || error.message}`);
            console.error('[Auth] Account deletion error:', error);
            res.status(500).json({
                success: false,
                error: 'Failed to delete account. Please try again.',
                debugLog,
                errorDetail: {
                    code: error.code,
                    table: error.table,
                    constraint: error.constraint,
                    message: error.message
                }
            });
        } finally {
            client.release();
        }
    });

    // Soft auth: populate req.user from cookie if valid, but never reject
    function softAuthMiddleware(req, res, next) {
        const token = req.cookies && req.cookies.eclaw_session;
        if (token) {
            const decoded = verifyToken(token);
            if (decoded) {
                // Enrich with deviceSecret from in-memory devices map (no longer stored in JWT)
                if (decoded.deviceId && devices[decoded.deviceId]) {
                    decoded.deviceSecret = devices[decoded.deviceId].deviceSecret;
                }
                req.user = decoded;
            }
        }
        next();
    }

    // ============================================
    // RBAC: Permission Check Middleware (Issue #178)
    // ============================================

    /**
     * requirePermission(...perms) — Middleware factory that checks user has all specified permissions.
     * Permissions are loaded from user_roles + roles tables.
     * Admin role (permissions: ["*"]) bypasses all checks.
     */
    function requirePermission(...requiredPerms) {
        return async (req, res, next) => {
            if (!req.user || !req.user.userId) {
                return res.status(401).json({ success: false, error: 'Authentication required' });
            }
            try {
                const deviceId = req.query.deviceId || req.body?.deviceId || req.user.deviceId;
                const result = await pool.query(
                    `SELECT r.permissions FROM user_roles ur
                     JOIN roles r ON ur.role_id = r.id
                     WHERE ur.user_id = $1 AND (ur.device_id IS NULL OR ur.device_id = $2)`,
                    [req.user.userId, deviceId || null]
                );
                const allPerms = new Set();
                for (const row of result.rows) {
                    const perms = Array.isArray(row.permissions) ? row.permissions : JSON.parse(row.permissions || '[]');
                    perms.forEach(p => allPerms.add(p));
                }
                // Wildcard admin
                if (allPerms.has('*')) { req.permissions = allPerms; return next(); }
                // Check required permissions
                if (!requiredPerms.every(p => allPerms.has(p))) {
                    return res.status(403).json({ success: false, error: 'Insufficient permissions' });
                }
                req.permissions = allPerms;
                next();
            } catch (err) {
                console.error('[Auth] Permission check error:', err);
                res.status(500).json({ success: false, error: 'Permission check failed' });
            }
        };
    }

    // ── RBAC Management Endpoints ──

    /**
     * GET /roles — List all available roles (admin only)
     */
    router.get('/roles', authMiddleware, adminMiddleware, async (req, res) => {
        try {
            const result = await pool.query('SELECT * FROM roles ORDER BY id');
            res.json({ success: true, roles: result.rows });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    /**
     * GET /user-roles — Get roles for a user (admin or self)
     * Query: ?userId=<uuid>
     */
    router.get('/user-roles', authMiddleware, async (req, res) => {
        try {
            const targetUserId = req.query.userId || req.user.userId;
            // Non-admin can only view own roles
            if (targetUserId !== req.user.userId) {
                const adminResult = await pool.query('SELECT is_admin FROM user_accounts WHERE id = $1', [req.user.userId]);
                if (!adminResult.rows.length || !adminResult.rows[0].is_admin) {
                    return res.status(403).json({ success: false, error: 'Admin access required to view other users\' roles' });
                }
            }
            const result = await pool.query(
                `SELECT ur.role_id, ur.device_id, ur.created_at, r.description, r.permissions
                 FROM user_roles ur JOIN roles r ON ur.role_id = r.id
                 WHERE ur.user_id = $1 ORDER BY ur.created_at`,
                [targetUserId]
            );
            res.json({ success: true, roles: result.rows });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    /**
     * POST /user-roles — Assign role to user (admin only)
     * Body: { userId, roleId, deviceId? }
     */
    router.post('/user-roles', authMiddleware, adminMiddleware, async (req, res) => {
        try {
            const { userId, roleId, deviceId } = req.body;
            if (!userId || !roleId) {
                return res.status(400).json({ success: false, error: 'userId and roleId required' });
            }
            // Verify role exists
            const roleCheck = await pool.query('SELECT id FROM roles WHERE id = $1', [roleId]);
            if (!roleCheck.rows.length) {
                return res.status(404).json({ success: false, error: 'Role not found' });
            }
            // Verify user exists
            const userCheck = await pool.query('SELECT id FROM user_accounts WHERE id = $1', [userId]);
            if (!userCheck.rows.length) {
                return res.status(404).json({ success: false, error: 'User not found' });
            }
            await pool.query(
                `INSERT INTO user_roles (user_id, role_id, device_id, granted_by)
                 VALUES ($1, $2, $3, $4)
                 ON CONFLICT DO NOTHING`,
                [userId, roleId, deviceId || null, req.user.userId]
            );
            audit('info', 'auth', `Role assigned: ${roleId} to ${userId}`, { userId: req.user.userId, ipAddress: req.ip, action: 'role_assign', resource: 'user_role', result: 'success', metadata: { targetUserId: userId, roleId, deviceId } });
            res.json({ success: true, message: `Role ${roleId} assigned` });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    /**
     * DELETE /user-roles — Revoke role from user (admin only)
     * Body: { userId, roleId, deviceId? }
     */
    router.delete('/user-roles', authMiddleware, adminMiddleware, async (req, res) => {
        try {
            const { userId, roleId, deviceId } = req.body;
            if (!userId || !roleId) {
                return res.status(400).json({ success: false, error: 'userId and roleId required' });
            }
            const result = await pool.query(
                `DELETE FROM user_roles WHERE user_id = $1 AND role_id = $2 AND COALESCE(device_id, '__global__') = COALESCE($3, '__global__')`,
                [userId, roleId, deviceId || null]
            );
            if (result.rowCount === 0) {
                return res.status(404).json({ success: false, error: 'Role assignment not found' });
            }
            audit('info', 'auth', `Role revoked: ${roleId} from ${userId}`, { userId: req.user.userId, ipAddress: req.ip, action: 'role_revoke', resource: 'user_role', result: 'success', metadata: { targetUserId: userId, roleId, deviceId } });
            res.json({ success: true, message: `Role ${roleId} revoked` });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    function setOnEmailVerified(cb) { _onEmailVerified = cb; }

    return { router, authMiddleware, softAuthMiddleware, adminMiddleware, requirePermission, initAuthDatabase, pool: pool, setOnEmailVerified };
};
