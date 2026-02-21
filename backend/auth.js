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

const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/realbot'
});

const resend = new Resend(process.env.RESEND_API_KEY || 'dummy');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';
const JWT_EXPIRY = '7d';
const BCRYPT_ROUNDS = 12;
const BASE_URL = process.env.BASE_URL || 'https://eclaw.up.railway.app';
const EMAIL_FROM = 'E-Claw <noreply@twopiggyhavefun.uk>';

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
module.exports = function(devices, getOrCreateDevice) {
    const router = express.Router();

    // ============================================
    // JWT Helpers
    // ============================================

    function signToken(user) {
        return jwt.sign(
            { userId: user.id, deviceId: user.device_id, deviceSecret: user.device_secret },
            JWT_SECRET,
            { expiresIn: JWT_EXPIRY }
        );
    }

    function verifyToken(token) {
        try {
            return jwt.verify(token, JWT_SECRET);
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

    // ============================================
    // POST /register
    // ============================================
    router.post('/register', async (req, res) => {
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

            res.json({
                success: true,
                message: 'Account created. Please check your email to verify.',
                userId: user.id
            });
        } catch (error) {
            console.error('[Auth] Register error:', error);
            res.status(500).json({ success: false, error: 'Registration failed' });
        }
    });

    // ============================================
    // POST /login
    // ============================================
    router.post('/login', async (req, res) => {
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

            // Sign JWT and set cookie
            const token = signToken(user);
            res.cookie('eclaw_session', token, {
                httpOnly: true,
                secure: process.env.NODE_ENV === 'production',
                sameSite: 'lax',
                maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
                path: '/'
            });

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
            if (!device || device.deviceSecret !== deviceSecret) {
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
                tokenPayload = { userId: user.id, deviceId: user.device_id, deviceSecret: user.device_secret };
                userInfo = {
                    id: user.id,
                    email: user.email,
                    deviceId: user.device_id,
                    subscriptionStatus: user.subscription_status
                };
            } else {
                // No user account — create a session with device credentials only
                tokenPayload = { userId: null, deviceId, deviceSecret };
                userInfo = {
                    id: null,
                    email: null,
                    deviceId: deviceId,
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
        res.clearCookie('eclaw_session', { path: '/' });
        res.json({ success: true });
    });

    // ============================================
    // GET /verify-email?token=xxx
    // ============================================
    router.get('/verify-email', async (req, res) => {
        try {
            const { token } = req.query;
            if (!token) {
                return res.status(400).send('Missing verification token');
            }

            const result = await pool.query(
                'SELECT * FROM user_accounts WHERE verify_token = $1',
                [token]
            );

            if (result.rows.length === 0) {
                return res.status(400).send('Invalid verification token');
            }

            const user = result.rows[0];

            if (user.verify_token_expires && user.verify_token_expires < Date.now()) {
                return res.status(400).send('Verification token expired. Please register again.');
            }

            await pool.query(
                'UPDATE user_accounts SET email_verified = TRUE, verify_token = NULL, verify_token_expires = NULL WHERE id = $1',
                [user.id]
            );

            // Redirect to portal login page
            res.redirect(`${BASE_URL}/portal/index.html?verified=true`);
        } catch (error) {
            console.error('[Auth] Verify email error:', error);
            res.status(500).send('Verification failed');
        }
    });

    // ============================================
    // POST /forgot-password
    // ============================================
    router.post('/forgot-password', async (req, res) => {
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
                        deviceSecret: req.user.deviceSecret,
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
                'SELECT id, email, device_id, device_secret, subscription_status, subscription_expires_at, language, email_verified, is_admin, created_at FROM user_accounts WHERE id = $1',
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
                    usageToday: usageToday,
                    usageLimit: user.subscription_status === 'premium' ? null : 15
                }
            });
        } catch (error) {
            console.error('[Auth] Get me error:', error);
            res.status(500).json({ success: false, error: 'Failed to get user info' });
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
            if (!device || device.deviceSecret !== deviceSecret) {
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
            if (!device || device.deviceSecret !== deviceSecret) {
                return res.status(401).json({ success: false, error: 'Invalid device credentials' });
            }

            const result = await pool.query(
                'SELECT email, email_verified FROM user_accounts WHERE device_id = $1',
                [deviceId]
            );

            if (result.rows.length === 0) {
                return res.json({ success: true, bound: false, email: null, emailVerified: false });
            }

            const user = result.rows[0];
            res.json({
                success: true,
                bound: true,
                email: user.email,
                emailVerified: user.email_verified
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
                email: user.email
            });
        } catch (error) {
            console.error('[Auth] App-login error:', error);
            res.status(500).json({ success: false, error: 'Login failed' });
        }
    });

    return { router, authMiddleware, adminMiddleware, initAuthDatabase, pool: pool };
};
