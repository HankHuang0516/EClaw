/**
 * Gatekeeper Module - Free Bot Abuse Prevention
 *
 * Two-layer defense system:
 *   First Lock (client-side detection): Detects malicious user messages BEFORE they reach free bots
 *   Second Lock (backend detection): Detects token/info leaks in bot responses BEFORE they reach users
 *
 * Strike system: 3 violations = free bot usage blocked for the device
 */

let pool = null;
try {
    const { Pool } = require('pg');
    pool = new Pool({
        connectionString: process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/realbot'
    });
} catch (err) {
    console.warn('[Gatekeeper] pg module not available, DB features disabled');
}

// ============================================
// CONFIGURATION
// ============================================

const MAX_STRIKES = 3;
const FREE_BOT_TOS_VERSION = '1.0';

// ============================================
// FIRST LOCK: Malicious message detection
// ============================================

// 1. Token extraction patterns (including distillation / encoding tricks)
const TOKEN_EXTRACTION_PATTERNS = [
    // Direct token requests
    /(?:give|show|tell|reveal|share|send|print|output|display|return|leak|dump|extract)\s*(?:me\s+)?(?:your\s+)?(?:the\s+)?(?:bot\s*)?(?:secret|token|api\s*key|password|credential|key|auth)/i,
    /(?:botSecret|api[_\s]*key|access[_\s]*token|bearer[_\s]*token|deviceSecret|webhook[_\s]*token)/i,
    /what\s*(?:is|are)\s*(?:your\s+)?(?:the\s+)?(?:bot\s*)?(?:secret|token|key|password|credential|auth)/i,
    // Distillation / encoding tricks
    /(?:base64|hex|encode|decode|rot13|caesar|cipher|encrypt|decrypt|hash|md5|sha)\s*(?:of\s+)?(?:your\s+)?(?:the\s+)?(?:bot\s*)?(?:secret|token|key|password|credential)/i,
    /(?:spell|spell\s*out|one\s*char|character\s*by\s*character|letter\s*by\s*letter|reverse|backwards|每個字)\s*(?:your\s+)?(?:the\s+)?(?:bot\s*)?(?:secret|token|key|password|credential)/i,
    // Prompt injection to extract config
    /(?:ignore\s+(?:all\s+)?(?:previous|prior|above)\s+(?:instructions?|prompts?|rules?))/i,
    /(?:system\s*prompt|system\s*message|initial\s*prompt|original\s*instructions?|hidden\s*instructions?)/i,
    // Chinese: flexible patterns — allow up to 30 chars between request verb and keyword
    /(?:給我|告訴我|顯示|透露|洩漏|分享|提供).{0,30}(?:token|secret|api\s*key|密碼|金鑰|秘密|憑證|令牌|權杖)/i,
    /(?:你的|你們的|系統的|機器人的|bot的).{0,20}(?:token|secret|api\s*key|密碼|金鑰|秘密|憑證|令牌|權杖)/i,
    /(?:把|將).{0,20}(?:token|secret|api\s*key|密碼|金鑰|秘密|憑證|令牌|權杖).{0,15}(?:告訴|給|傳|送|顯示|分享)/i,
    /(?:可以|能不能|能否|請|幫我|我要|我想).{0,15}(?:給我|告訴我|分享|提供|看|取得|拿到).{0,30}(?:token|secret|api\s*key|密碼|金鑰|秘密|憑證|令牌|權杖)/i,
    // Chinese: gateway-specific
    /(?:gateway|閘道器?)\s*(?:的\s*)?(?:token|secret|key|密碼|金鑰|憑證)/i,
    // Encoded/obfuscated token requests
    /(?:dG9rZW4|c2VjcmV0|Ym90U2VjcmV0|cGFzc3dvcmQ)/i, // base64 of token, secret, botSecret, password
];

// 2. Heartbeat manipulation patterns
const HEARTBEAT_MANIPULATION_PATTERNS = [
    /(?:set|change|modify|update|configure)\s*(?:the\s+)?(?:heartbeat|heart\s*beat|polling|interval|frequency|check\s*interval)\s*(?:to\s+)?(?:\d{1,2}\s*(?:s(?:ec)?|m(?:in)?(?:ute)?))/i,
    /heartbeat\s*[:=]\s*\d{1,4}(?:\s*(?:ms|millisecond|sec|second|s))?/i,
    /(?:設定|設置|修改|調整|更改)\s*(?:heartbeat|心跳|輪詢|間隔)\s*(?:為|到|成)?\s*(?:\d+)/i,
];

// 3. Other malicious attack patterns
const MALICIOUS_ATTACK_PATTERNS = [
    // Command injection
    /(?:exec|eval|system|spawn|fork|require|import)\s*\(/i,
    /(?:curl|wget|fetch)\s+(?:https?:\/\/)?(?!eclaw\.up\.railway\.app)/i,
    /`[^`]*(?:rm|del|kill|shutdown|reboot|format|drop|delete|truncate)[^`]*`/i,
    // SQL injection
    /(?:;\s*(?:DROP|DELETE|UPDATE|INSERT|ALTER|CREATE|TRUNCATE)\s+)/i,
    /(?:UNION\s+(?:ALL\s+)?SELECT|OR\s+1\s*=\s*1|AND\s+1\s*=\s*1|'\s*OR\s*')/i,
    // Path traversal
    /(?:\.\.\/|\.\.\\|%2e%2e)/i,
    // Prompt injection (additional)
    /(?:DAN|jailbreak|bypass\s*(?:filter|safety|guard|restriction)|unlock\s*(?:mode|restriction))/i,
    /(?:越獄|解鎖|繞過|突破)\s*(?:限制|安全|過濾|防護)/i,
];

// 4. Personal information query patterns
const PERSONAL_INFO_PATTERNS = [
    /(?:what\s*(?:is|are)|tell\s*me|give\s*me|show\s*me)\s*(?:the\s+)?(?:user'?s?|owner'?s?|device\s*owner'?s?)\s*(?:email|phone|address|name|id|identity|location|ip)/i,
    /(?:who\s+(?:is|are)\s+(?:the\s+)?(?:user|owner|device\s*owner))/i,
    /(?:other\s+)?(?:user|device|people|person)'?s?\s+(?:info|information|data|detail|personal|private|secret)/i,
    /(?:告訴我|給我|查詢|查看)\s*(?:使用者|用戶|裝置\s*擁有者|其他人)\s*(?:的\s*)?(?:資料|資訊|信息|電話|地址|郵箱|email|姓名|身分)/i,
    /(?:使用者|用戶|擁有者)\s*(?:的\s*)?(?:個人|隱私|私人)\s*(?:資料|資訊|信息)/i,
];

/**
 * First Lock: Detect malicious patterns in user message
 * @param {string} text - The message text to check
 * @returns {{ blocked: boolean, reason: string|null, category: string|null }}
 */
function detectMaliciousMessage(text) {
    if (!text || typeof text !== 'string') return { blocked: false, reason: null, category: null };

    const trimmed = text.trim();
    if (trimmed.length === 0) return { blocked: false, reason: null, category: null };

    // Check token extraction
    for (const pattern of TOKEN_EXTRACTION_PATTERNS) {
        if (pattern.test(trimmed)) {
            return {
                blocked: true,
                reason: '偵測到疑似索取機器人憑證的行為。為了安全，此訊息已被攔截。',
                category: 'token_extraction'
            };
        }
    }

    // Check heartbeat manipulation
    for (const pattern of HEARTBEAT_MANIPULATION_PATTERNS) {
        if (pattern.test(trimmed)) {
            // Extract the time value to check if it's < 30 minutes
            const timeMatch = trimmed.match(/(\d+)\s*(?:ms|millisecond|sec(?:ond)?|s|min(?:ute)?|m|分鐘|秒)/i);
            if (timeMatch) {
                const value = parseInt(timeMatch[1]);
                const unit = timeMatch[0].replace(timeMatch[1], '').trim().toLowerCase();
                let minutes = value;
                if (unit.startsWith('s') || unit === '秒') minutes = value / 60;
                else if (unit.startsWith('ms') || unit === 'millisecond') minutes = value / 60000;
                // Only block if < 30 minutes
                if (minutes < 30) {
                    return {
                        blocked: true,
                        reason: '心跳間隔不可設定低於 30 分鐘，此訊息已被攔截。',
                        category: 'heartbeat_manipulation'
                    };
                }
            }
            // If no time value extracted but pattern matched, still flag it
            return {
                blocked: true,
                reason: '偵測到疑似操控心跳設定的行為，此訊息已被攔截。',
                category: 'heartbeat_manipulation'
            };
        }
    }

    // Check malicious attacks
    for (const pattern of MALICIOUS_ATTACK_PATTERNS) {
        if (pattern.test(trimmed)) {
            return {
                blocked: true,
                reason: '偵測到疑似惡意攻擊指令，此訊息已被攔截。',
                category: 'malicious_attack'
            };
        }
    }

    // Check personal info queries
    for (const pattern of PERSONAL_INFO_PATTERNS) {
        if (pattern.test(trimmed)) {
            return {
                blocked: true,
                reason: '禁止查詢使用者個人資訊，此訊息已被攔截。',
                category: 'personal_info_query'
            };
        }
    }

    return { blocked: false, reason: null, category: null };
}

// ============================================
// SECOND LOCK: Token / info leak detection in bot responses
// ============================================

// Helper: check if a string has high entropy (looks like a random token)
function looksLikeToken(str) {
    if (!str || str.length < 20) return false;
    const hasUpper = /[A-Z]/.test(str);
    const hasLower = /[a-z]/.test(str);
    const hasDigit = /[0-9]/.test(str);
    // Must have all 3 character classes (upper + lower + digit)
    if (!hasUpper || !hasLower || !hasDigit) return false;
    // Digits should make up at least 15% (random tokens have mixed chars)
    const digitCount = (str.match(/[0-9]/g) || []).length;
    return digitCount >= str.length * 0.15;
}

// Patterns that look like tokens or secrets
const TOKEN_LEAK_PATTERNS = [
    // Hex strings 32+ chars (typical token/secret length)
    /[0-9a-f]{32,}/gi,
    // UUID patterns
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
    // Base64 strings 32+ chars that look like tokens (lowered from 40)
    /[A-Za-z0-9+/]{32,}={0,2}/g,
    // Bearer tokens
    /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
    // JWT patterns
    /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
    // Mixed alphanumeric strings 20-48 chars (API tokens, gateway tokens, etc.)
    // Validated by looksLikeToken() to avoid false positives
    /[A-Za-z0-9]{20,48}/g,
];

// Device info patterns (deviceId, deviceSecret, webhook URLs with tokens)
const DEVICE_INFO_PATTERNS = [
    // deviceSecret (compound UUID: two UUIDs concatenated)
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
    // Webhook URLs with tokens
    /https?:\/\/[^\s]+\/tools\/invoke[^\s]*/gi,
];

/**
 * Second Lock: Detect and mask token/info leaks in bot response
 * @param {string} text - The bot response text
 * @param {string} deviceId - Current device ID (to avoid false positives on own deviceId)
 * @param {string} botSecret - Current entity's botSecret (to detect its leak)
 * @returns {{ leaked: boolean, maskedText: string, leakTypes: string[] }}
 */
function detectAndMaskLeaks(text, deviceId, botSecret) {
    if (!text || typeof text !== 'string') return { leaked: false, maskedText: text, leakTypes: [] };

    let maskedText = text;
    const leakTypes = [];

    // Check if botSecret is exposed in clear text
    if (botSecret && maskedText.includes(botSecret)) {
        maskedText = maskedText.split(botSecret).join('[REDACTED_SECRET]');
        leakTypes.push('bot_secret_leak');
    }

    // Check for device info patterns (compound UUID = deviceSecret)
    for (const pattern of DEVICE_INFO_PATTERNS) {
        const matches = maskedText.match(pattern);
        if (matches) {
            for (const match of matches) {
                // Don't mask if it's the deviceId itself in a normal context (like API URLs we provide)
                if (match.includes('/tools/invoke')) {
                    maskedText = maskedText.replace(match, '[REDACTED_WEBHOOK]');
                    leakTypes.push('webhook_leak');
                } else {
                    maskedText = maskedText.replace(match, '[REDACTED_DEVICE_INFO]');
                    leakTypes.push('device_info_leak');
                }
            }
        }
    }

    // Check for token-like patterns
    for (const pattern of TOKEN_LEAK_PATTERNS) {
        // Reset lastIndex for global patterns
        pattern.lastIndex = 0;
        const matches = maskedText.match(pattern);
        if (matches) {
            for (const match of matches) {
                // Skip if it's the deviceId itself (acceptable in normal responses)
                if (match === deviceId) continue;
                // Skip if it looks like a normal part of a URL we constructed
                if (maskedText.includes(`"deviceId":"${match}"`)) continue;

                // Classify the match
                const isPureHex = /^[0-9a-f]+$/i.test(match);
                const isUUID = /^[0-9a-f]{8}-/.test(match);
                const isJWT = match.startsWith('eyJ');
                const isBearer = /^Bearer\s/i.test(match);

                // For non-hex, non-special matches, require high entropy (avoids false positives on normal text)
                if (!isPureHex && !isUUID && !isJWT && !isBearer) {
                    if (!looksLikeToken(match)) continue;
                }
                // For pure hex, still require minimum length
                if (isPureHex && match.length < 32) continue;

                // This looks like a leaked token/secret
                const redacted = match.substring(0, 4) + '***' + match.substring(match.length - 4);
                maskedText = maskedText.split(match).join(`[REDACTED:${redacted}]`);
                if (!leakTypes.includes('token_pattern_leak')) {
                    leakTypes.push('token_pattern_leak');
                }
            }
        }
    }

    return {
        leaked: leakTypes.length > 0,
        maskedText: maskedText,
        leakTypes: leakTypes
    };
}

// ============================================
// STRIKE SYSTEM
// ============================================

// In-memory cache for fast lookups
const strikeCache = {}; // deviceId -> { count, blocked, lastViolation }
const tosAgreedCache = {}; // deviceId -> { version, agreedAt }

/**
 * Initialize gatekeeper DB table
 */
async function initGatekeeperTable() {
    if (!pool) return;
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS gatekeeper_violations (
                id SERIAL PRIMARY KEY,
                device_id VARCHAR(64) NOT NULL,
                category VARCHAR(64) NOT NULL,
                message_preview TEXT,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
            )
        `);
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_gatekeeper_device ON gatekeeper_violations(device_id)
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS gatekeeper_blocks (
                device_id VARCHAR(64) PRIMARY KEY,
                violation_count INTEGER DEFAULT 0,
                blocked_at TIMESTAMP WITH TIME ZONE,
                is_blocked BOOLEAN DEFAULT FALSE
            )
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS free_bot_tos_agreements (
                device_id VARCHAR(64) PRIMARY KEY,
                tos_version VARCHAR(16) NOT NULL,
                agreed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
            )
        `);
        console.log('[Gatekeeper] Database tables ready');
    } catch (err) {
        console.error('[Gatekeeper] Failed to create tables:', err.message);
    }
}

/**
 * Load blocked devices into memory cache
 */
async function loadBlockedDevices() {
    if (!pool) return;
    try {
        const result = await pool.query('SELECT * FROM gatekeeper_blocks');
        for (const row of result.rows) {
            strikeCache[row.device_id] = {
                count: row.violation_count,
                blocked: row.is_blocked,
                lastViolation: row.blocked_at
            };
        }
        const blockedCount = result.rows.filter(r => r.is_blocked).length;
        console.log(`[Gatekeeper] Loaded ${result.rows.length} device records, ${blockedCount} blocked`);

        // Load TOS agreements
        const tosResult = await pool.query('SELECT * FROM free_bot_tos_agreements');
        for (const row of tosResult.rows) {
            tosAgreedCache[row.device_id] = {
                version: row.tos_version,
                agreedAt: row.agreed_at
            };
        }
        console.log(`[Gatekeeper] Loaded ${tosResult.rows.length} TOS agreements`);
    } catch (err) {
        console.error('[Gatekeeper] Failed to load blocked devices:', err.message);
    }
}

/**
 * Record a violation and return updated strike info
 * @param {string} deviceId
 * @param {string} category - violation category
 * @param {string} messagePreview - first 100 chars of the message
 * @returns {{ count: number, blocked: boolean, justBlocked: boolean }}
 */
async function recordViolation(deviceId, category, messagePreview) {
    const preview = (messagePreview || '').substring(0, 100);

    // Log violation
    try {
        await pool.query(
            'INSERT INTO gatekeeper_violations (device_id, category, message_preview) VALUES ($1, $2, $3)',
            [deviceId, category, preview]
        );
    } catch (err) {
        console.error('[Gatekeeper] Failed to log violation:', err.message);
    }

    // Update strike count
    if (!strikeCache[deviceId]) {
        strikeCache[deviceId] = { count: 0, blocked: false, lastViolation: null };
    }

    strikeCache[deviceId].count++;
    strikeCache[deviceId].lastViolation = new Date();

    const justBlocked = !strikeCache[deviceId].blocked && strikeCache[deviceId].count >= MAX_STRIKES;
    if (justBlocked) {
        strikeCache[deviceId].blocked = true;
    }

    // Persist to DB
    try {
        await pool.query(
            `INSERT INTO gatekeeper_blocks (device_id, violation_count, blocked_at, is_blocked)
             VALUES ($1, $2, NOW(), $3)
             ON CONFLICT (device_id)
             DO UPDATE SET violation_count = $2, blocked_at = NOW(), is_blocked = $3`,
            [deviceId, strikeCache[deviceId].count, strikeCache[deviceId].blocked]
        );
    } catch (err) {
        console.error('[Gatekeeper] Failed to update block status:', err.message);
    }

    console.log(`[Gatekeeper] Strike ${strikeCache[deviceId].count}/${MAX_STRIKES} for device ${deviceId} (${category})${justBlocked ? ' → BLOCKED' : ''}`);

    return {
        count: strikeCache[deviceId].count,
        blocked: strikeCache[deviceId].blocked,
        justBlocked: justBlocked
    };
}

/**
 * Check if a device is blocked from using free bots
 * @param {string} deviceId
 * @returns {boolean}
 */
function isDeviceBlocked(deviceId) {
    return !!(strikeCache[deviceId] && strikeCache[deviceId].blocked);
}

/**
 * Get strike info for a device
 * @param {string} deviceId
 * @returns {{ count: number, blocked: boolean, remaining: number }}
 */
function getStrikeInfo(deviceId) {
    const info = strikeCache[deviceId] || { count: 0, blocked: false };
    return {
        count: info.count,
        blocked: info.blocked,
        remaining: Math.max(0, MAX_STRIKES - info.count)
    };
}

// ============================================
// FREE BOT TOS AGREEMENT
// ============================================

/**
 * Get TOS content (bilingual)
 * @param {string} lang - 'zh' or 'en'
 * @returns {{ version: string, content: object }}
 */
function getFreeBotTOS(lang = 'en') {
    const tos = {
        version: FREE_BOT_TOS_VERSION,
        title: lang === 'zh' ? '免費版機器人使用規範' : 'Free Bot Terms of Use',
        sections: lang === 'zh' ? [
            {
                heading: '一、服務說明',
                items: [
                    '免費版機器人為 E-Claw 官方提供的共享 AI 助手服務，每個裝置僅限綁定一個免費版機器人。',
                    '免費版機器人與所有免費用戶共享記憶，每日訊息上限為 15 則。'
                ]
            },
            {
                heading: '二、禁止行為',
                items: [
                    '禁止向機器人索取或嘗試取得系統憑證（Token、Secret、API Key 等），包括但不限於透過蒸餾、編碼、解碼、逆向工程等方式。',
                    '禁止設定低於 30 分鐘的心跳間隔（Heartbeat），亦不得透過任務面板或其他方式繞過此限制。',
                    '禁止對機器人發送惡意指令，包括但不限於：SQL 注入、指令注入、Prompt Injection、越獄攻擊等。',
                    '禁止透過機器人查詢任何使用者的個人資訊（包括 Email、電話、地址、裝置資訊等）。',
                    '禁止利用免費版機器人進行任何違法或濫用行為。'
                ]
            },
            {
                heading: '三、安全防護機制',
                items: [
                    '系統設有自動偵測守門員，會攔截疑似惡意訊息並記錄違規次數。',
                    '機器人回覆中若偵測到疑似憑證外洩，系統將自動遮蔽敏感資訊。',
                    '累計 3 次違規將永久封鎖該裝置的免費版機器人使用權。'
                ]
            },
            {
                heading: '四、免責聲明',
                items: [
                    '免費版機器人為共享資源，不保證即時可用性或回覆品質。',
                    'E-Claw 保留隨時修改本使用規範的權利，修改後繼續使用即視為同意新規範。',
                    '如有疑問或申訴，請透過應用程式內的意見回饋管道聯繫我們。'
                ]
            }
        ] : [
            {
                heading: '1. Service Description',
                items: [
                    'The Free Bot is a shared AI assistant service provided by E-Claw. Each device is limited to one free bot binding.',
                    'The Free Bot shares memory with all free users and has a daily limit of 15 messages.'
                ]
            },
            {
                heading: '2. Prohibited Conduct',
                items: [
                    'You must not attempt to obtain system credentials (Token, Secret, API Key, etc.) from the bot, including but not limited to distillation, encoding, decoding, or reverse engineering methods.',
                    'You must not set a heartbeat interval shorter than 30 minutes, nor bypass this restriction through task panels or other means.',
                    'You must not send malicious commands to the bot, including but not limited to: SQL injection, command injection, prompt injection, or jailbreak attacks.',
                    'You must not use the bot to query any user\'s personal information (including email, phone, address, device info, etc.).',
                    'You must not use the Free Bot for any illegal or abusive activities.'
                ]
            },
            {
                heading: '3. Security Measures',
                items: [
                    'An automated gatekeeper system will intercept suspected malicious messages and record violation counts.',
                    'If the bot\'s response contains suspected credential leaks, the system will automatically redact sensitive information.',
                    'Accumulating 3 violations will permanently block the device from using the Free Bot.'
                ]
            },
            {
                heading: '4. Disclaimer',
                items: [
                    'The Free Bot is a shared resource. Availability and response quality are not guaranteed.',
                    'E-Claw reserves the right to modify these terms at any time. Continued use after modification constitutes acceptance.',
                    'For questions or appeals, please contact us through the in-app feedback channel.'
                ]
            }
        ]
    };
    return tos;
}

/**
 * Check if device has agreed to the current TOS version
 * @param {string} deviceId
 * @returns {boolean}
 */
function hasAgreedToTOS(deviceId) {
    const agreement = tosAgreedCache[deviceId];
    if (!agreement) return false;
    return agreement.version === FREE_BOT_TOS_VERSION;
}

/**
 * Record TOS agreement for a device
 * @param {string} deviceId
 * @returns {Promise<boolean>}
 */
async function recordTOSAgreement(deviceId) {
    tosAgreedCache[deviceId] = {
        version: FREE_BOT_TOS_VERSION,
        agreedAt: new Date()
    };

    if (!pool) return true;
    try {
        await pool.query(
            `INSERT INTO free_bot_tos_agreements (device_id, tos_version, agreed_at)
             VALUES ($1, $2, NOW())
             ON CONFLICT (device_id)
             DO UPDATE SET tos_version = $2, agreed_at = NOW()`,
            [deviceId, FREE_BOT_TOS_VERSION]
        );
        console.log(`[Gatekeeper] TOS agreement recorded for device ${deviceId} (v${FREE_BOT_TOS_VERSION})`);
        return true;
    } catch (err) {
        console.error('[Gatekeeper] Failed to record TOS agreement:', err.message);
        return false;
    }
}

module.exports = {
    // First lock
    detectMaliciousMessage,
    // Second lock
    detectAndMaskLeaks,
    // Strike system
    initGatekeeperTable,
    loadBlockedDevices,
    recordViolation,
    isDeviceBlocked,
    getStrikeInfo,
    // TOS
    getFreeBotTOS,
    hasAgreedToTOS,
    recordTOSAgreement,
    // Config
    MAX_STRIKES,
    FREE_BOT_TOS_VERSION
};
