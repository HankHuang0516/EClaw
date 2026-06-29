// ============================================
// PostgreSQL Database Module
// Handles data persistence for Claw Backend
// ============================================

const { Pool } = require('pg');

// Database connection pool
let pool = null;

function isProductionRuntime() {
    return process.env.NODE_ENV === 'production' || Boolean(process.env.RAILWAY_ENVIRONMENT);
}

function shouldUseSsl(connectionString) {
    const sslMode = (process.env.PGSSLMODE || '').toLowerCase();
    if (sslMode === 'disable') return false;
    if (sslMode === 'require' || sslMode === 'verify-ca' || sslMode === 'verify-full') {
        return { rejectUnauthorized: sslMode !== 'require' };
    }

    try {
        const host = new URL(connectionString).hostname;
        if (host === 'localhost' || host === '127.0.0.1' || host.endsWith('.railway.internal')) {
            return false;
        }
    } catch (_) {
        // Fall through to the production default for non-URL connection strings.
    }

    return isProductionRuntime()
        ? { rejectUnauthorized: false }
        : false;
}

// Initialize database connection
async function initDatabase() {
    const connectionString = process.env.DATABASE_URL;

    if (!connectionString) {
        console.error('[DB] DATABASE_URL not found. PostgreSQL persistence disabled.');
        console.error('[DB] To enable: Add PostgreSQL service in Railway dashboard');
        return false;
    }

    // Retry up to 5 times with exponential back-off (1s → 2s → 4s → 8s → 16s)
    // Railway may restart PG and Node concurrently; the DB might not be ready
    // on the first attempt, causing a silent fallback to file storage that
    // wipes all in-memory entities (see 2026-04-20 incident).
    const MAX_RETRIES = 5;
    let ssl = shouldUseSsl(connectionString);
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            // Create / recreate connection pool on each attempt
            pool = new Pool({
                connectionString: connectionString,
                ssl
            });

            // Test connection
            const client = await pool.connect();
            console.log(`[DB] PostgreSQL connection established (attempt ${attempt}/${MAX_RETRIES})`);
            client.release();

            // Create tables if they don't exist
            await createTables();

            return true;
        } catch (err) {
            console.error(`[DB] Init attempt ${attempt}/${MAX_RETRIES} failed: ${err.message}`);
            // Clean up the failed pool before retrying
            if (pool) { try { await pool.end(); } catch (_) {} pool = null; }
            if (ssl && /does not support SSL connections/i.test(err.message)) {
                console.warn('[DB] Server rejected SSL; retrying without SSL for this DATABASE_URL');
                ssl = false;
            }
            if (attempt < MAX_RETRIES) {
                const delay = Math.pow(2, attempt - 1) * 1000;
                console.log(`[DB] Retrying in ${delay / 1000}s...`);
                await new Promise(r => setTimeout(r, delay));
            }
        }
    }

    console.error('[DB] All connection attempts exhausted. PostgreSQL persistence disabled.');
    return false;
}

// Create database tables
async function createTables() {
    try {
        const client = await pool.connect();

        // pgcrypto provides gen_random_bytes(int) which is used as the DEFAULT for
        // every id column in kanban / mission / rental / arena schemas (e.g.
        // `card_' || encode(gen_random_bytes(12), 'hex')`). On some PG installs
        // the extension is not enabled by default; bootstrap-time CREATE EXTENSION
        // IF NOT EXISTS makes the missing-function error self-healing.
        // Card source: card_c2612cb2 (Railway log monitor 06-16 17:35 TW fire —
        // `[Kanban] Error: function gen_random_bytes(integer) does not exist`).
        // Mirrors the pgvector pattern in chat-embedding.js: soft-fail since
        // EXTENSION may be privileged-only on hosted PG; the row inserts that
        // depend on it will then fail loudly with their own error rather than
        // silently breaking the whole table create.
        try {
            await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
        } catch (err) {
            console.warn('[DB] pgcrypto CREATE EXTENSION failed (id DEFAULTs that use gen_random_bytes will fail until enabled by DB admin):', err.message);
        }

        // Create devices table
        await client.query(`
            CREATE TABLE IF NOT EXISTS devices (
                device_id TEXT PRIMARY KEY,
                device_secret TEXT NOT NULL,
                created_at BIGINT NOT NULL,
                updated_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW()) * 1000
            )
        `);

        // Create entities table
        await client.query(`
            CREATE TABLE IF NOT EXISTS entities (
                device_id TEXT NOT NULL,
                entity_id INTEGER NOT NULL,
                bot_secret TEXT,
                is_bound BOOLEAN DEFAULT FALSE,
                name TEXT,
                character TEXT NOT NULL,
                state TEXT NOT NULL,
                message TEXT NOT NULL,
                parts JSONB DEFAULT '{}',
                battery_level INTEGER DEFAULT 100,
                last_updated BIGINT NOT NULL,
                message_queue JSONB DEFAULT '[]',
                webhook JSONB,
                app_version TEXT,
                PRIMARY KEY (device_id, entity_id),
                FOREIGN KEY (device_id) REFERENCES devices(device_id) ON DELETE CASCADE
            )
        `);

        // Create index for faster queries
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_entities_bound
            ON entities(is_bound)
            WHERE is_bound = TRUE
        `);

        // Official bot pool table
        await client.query(`
            CREATE TABLE IF NOT EXISTS official_bots (
                bot_id TEXT PRIMARY KEY,
                bot_type TEXT NOT NULL,
                webhook_url TEXT NOT NULL,
                token TEXT NOT NULL,
                bot_secret TEXT,
                session_key_template TEXT,
                status TEXT DEFAULT 'available',
                assigned_device_id TEXT,
                assigned_entity_id INTEGER,
                assigned_at BIGINT,
                created_at BIGINT NOT NULL
            )
        `);

        // XP/Level system columns (migration for existing deployments)
        await client.query(`ALTER TABLE entities ADD COLUMN IF NOT EXISTS xp INTEGER DEFAULT 0`);
        await client.query(`ALTER TABLE entities ADD COLUMN IF NOT EXISTS level INTEGER DEFAULT 1`);

        // Avatar sync column (migration for existing deployments)
        await client.query(`ALTER TABLE entities ADD COLUMN IF NOT EXISTS avatar TEXT`);

        // Public code for cross-device communication (migration for existing deployments)
        await client.query(`ALTER TABLE entities ADD COLUMN IF NOT EXISTS public_code VARCHAR(8)`);
        await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_entities_public_code ON entities(public_code) WHERE public_code IS NOT NULL`);

        // Channel binding persistence — store bindingType and per-entity channel account reference
        await client.query(`ALTER TABLE entities ADD COLUMN IF NOT EXISTS binding_type TEXT`);
        await client.query(`ALTER TABLE entities ADD COLUMN IF NOT EXISTS channel_account_id INTEGER`);

        // Agent Card for A2A capability discovery (Issue #174)
        await client.query(`ALTER TABLE entities ADD COLUMN IF NOT EXISTS agent_card JSONB`);

        // E2EE awareness (Issue #212): per-entity encryption status derived from channel
        await client.query(`ALTER TABLE entities ADD COLUMN IF NOT EXISTS encryption_status TEXT`);

        // Bot Identity Layer: unified identity JSONB (role, instructions, boundaries, public profile)
        await client.query(`ALTER TABLE entities ADD COLUMN IF NOT EXISTS identity JSONB`);

        // Rental status persistence: track leased_in/leased_out and contract reference
        await client.query(`ALTER TABLE entities ADD COLUMN IF NOT EXISTS rental_status TEXT`);
        await client.query(`ALTER TABLE entities ADD COLUMN IF NOT EXISTS rental_contract_id TEXT`);
        // Migrate existing agent_card data into identity.public
        await client.query(`
            UPDATE entities SET identity = jsonb_build_object('public', agent_card)
            WHERE agent_card IS NOT NULL AND identity IS NULL
        `);

        // Allow multiple channel accounts per device (each plugin gets its own account)
        // Drop the UNIQUE(device_id) constraint if it still exists from the original schema
        await client.query(`
            DO $$ BEGIN
                IF EXISTS (
                    SELECT 1 FROM information_schema.table_constraints
                    WHERE table_name = 'channel_accounts'
                      AND constraint_type = 'UNIQUE'
                      AND constraint_name = 'channel_accounts_device_id_key'
                ) THEN
                    ALTER TABLE channel_accounts DROP CONSTRAINT channel_accounts_device_id_key;
                END IF;
            END $$
        `);

        // Add bot_secret column if it doesn't exist (migration for existing deployments)
        await client.query(`
            ALTER TABLE official_bots ADD COLUMN IF NOT EXISTS bot_secret TEXT
        `);

        // Add setup auth columns for gateways with SETUP_PASSWORD (e.g. Railway)
        await client.query(`ALTER TABLE official_bots ADD COLUMN IF NOT EXISTS setup_username TEXT`);
        await client.query(`ALTER TABLE official_bots ADD COLUMN IF NOT EXISTS setup_password TEXT`);

        // Add display_name column for user-facing bot selection
        await client.query(`ALTER TABLE official_bots ADD COLUMN IF NOT EXISTS display_name TEXT`);

        // Add model_name column — canonical model identifier separate from bot_id slug
        // (bot_id is immutable PK; model_name is editable and authoritative for what the bot actually runs)
        await client.query(`ALTER TABLE official_bots ADD COLUMN IF NOT EXISTS model_name TEXT`);

        // Backfill model_name for the 3 existing free bots whose bot_id PKs were
        // mislabeled at create time (see closed card_c23a03b4). display_name is
        // truthful (matches actual wiring); bot_id is the immutable slug. Key the
        // backfill on display_name + WHERE model_name IS NULL so it's idempotent
        // and won't clobber any admin-portal edits.
        await client.query(`UPDATE official_bots SET model_name = 'minimax-2.5' WHERE display_name = 'Cloud_Zeabur_MiniMax2.5' AND model_name IS NULL`);
        await client.query(`UPDATE official_bots SET model_name = 'minimax-2.7' WHERE display_name = 'Local_Mac_MiniMax2.7' AND model_name IS NULL`);
        await client.query(`UPDATE official_bots SET model_name = 'openai-codex/gpt-5.5-xhigh' WHERE display_name = 'Local_Mac_CodexGPT5.5_xhight' AND model_name IS NULL`);

        // Retirement reason: sticky flag for bots retired due to chronic delivery
        // failures. Once set, the bot stays disabled across deploys; admin can
        // re-enable by clearing retirement_reason via PUT /api/admin/official-bot/:botId.
        await client.query(`ALTER TABLE official_bots ADD COLUMN IF NOT EXISTS retirement_reason TEXT`);

        // GH#2956: Local_Mac_CodexGPT5.5_xhight (botId Mac本地版_MiniMax2.7) stalled
        // 2 consecutive 6h free-bot health cycles on 2026-05-26 (cycle 1 welcome-stub
        // greeting only, cycle 2 no first_token within 60s, speak2 push_timeout).
        // Local Mac listener is unreachable; retire from the free pool until the
        // listener is restored. Guard on retirement_reason IS NULL so admin can
        // re-enable later by clearing the column without it being reverted at boot.
        await client.query(`
            UPDATE official_bots
            SET status = 'disabled',
                retirement_reason = 'GH#2956: push_timeout x2 cycles on 2026-05-26 — local Mac listener unreachable'
            WHERE display_name = 'Local_Mac_CodexGPT5.5_xhight'
              AND retirement_reason IS NULL
        `);

        // Add paid_borrow_slots column to devices table (tracks how many personal bots a device has paid for)
        await client.query(`
            ALTER TABLE devices ADD COLUMN IF NOT EXISTS paid_borrow_slots INTEGER DEFAULT 0
        `);

        // Prompt Policy: device-level system prompt orchestration, merged with entity identity/policy at runtime
        await client.query(`
            ALTER TABLE devices ADD COLUMN IF NOT EXISTS prompt_policy JSONB
        `);

        // User display name (card_900db3bf): owner-set human name shown in chat/UI
        // headers in place of generic "Device Owner" / "裝置主人". Plain TEXT (nullable);
        // backend caps length to 64 chars at write time (matches devicePrefs validation
        // pattern). No backfill — existing devices stay NULL until owner sets a value.
        await client.query(`
            ALTER TABLE devices ADD COLUMN IF NOT EXISTS user_display_name TEXT
        `);

        // Dynamic entity system: per-device counter for unique entity ID assignment
        await client.query(`
            ALTER TABLE devices ADD COLUMN IF NOT EXISTS next_entity_id INTEGER DEFAULT 1
        `);
        // Migration: existing devices with entities should have next_entity_id = max(entity_id) + 1
        await client.query(`
            UPDATE devices SET next_entity_id = sub.next_id
            FROM (
                SELECT device_id, MAX(entity_id) + 1 AS next_id
                FROM entities GROUP BY device_id
            ) sub
            WHERE devices.device_id = sub.device_id
              AND (devices.next_entity_id IS NULL OR devices.next_entity_id < sub.next_id)
        `);
        console.log('[DynamicEntity] DB migration: next_entity_id column ensured on devices table');

        // Push tokens (card_caa6307 follow-up): fcm_token (Android) + apns_token (iOS).
        // Previously these were created lazily at runtime in index.js only when the FIRST
        // token of each platform was registered (ALTER ... ADD COLUMN IF NOT EXISTS with a
        // swallowed .catch). On a fresh DB (e.g. the 2026-04 pgvector migration) any query
        // referencing apns_token before an iOS device ever registered errored with
        // "column apns_token does not exist". Ensure both columns exist at startup so the
        // schema never drifts regardless of registration traffic.
        await client.query(`
            ALTER TABLE devices ADD COLUMN IF NOT EXISTS fcm_token TEXT
        `);
        await client.query(`
            ALTER TABLE devices ADD COLUMN IF NOT EXISTS apns_token TEXT
        `);
        console.log('[Push] DB migration: fcm_token + apns_token columns ensured on devices table');

        // Multi-device FCM tokens (push notification clobber fix, 2026-06-29).
        // The legacy single devices.fcm_token column means MULTIPLE physical devices
        // sharing one deviceId (e.g. owner's phone + a desktop emulator) each register
        // their token under the same deviceId and OVERWRITE each other — only the
        // last-registered device receives pushes. Mirror the multi-row push_subscriptions
        // design: one row per (device_id, token) so notifyDevice can fan out to ALL of a
        // device's tokens. Backfill the current single-column token so no device regresses.
        await client.query(`
            CREATE TABLE IF NOT EXISTS device_fcm_tokens (
                device_id   TEXT   NOT NULL,
                token       TEXT   NOT NULL,
                platform    TEXT   NOT NULL DEFAULT 'fcm',
                updated_at  BIGINT,
                PRIMARY KEY (device_id, token)
            )
        `);
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_device_fcm_tokens_device ON device_fcm_tokens(device_id)
        `);
        await client.query(`
            INSERT INTO device_fcm_tokens (device_id, token, platform, updated_at)
            SELECT device_id, fcm_token, 'fcm', $1 FROM devices WHERE fcm_token IS NOT NULL
            ON CONFLICT (device_id, token) DO NOTHING
        `, [Date.now()]);
        console.log('[Push] DB migration: device_fcm_tokens multi-token table ensured + backfilled');

        // Multi-device APNs tokens (push clobber fix — sibling of device_fcm_tokens, 2026-06-29).
        // `devices.apns_token` has the identical single-column clobber as fcm_token had: a
        // user with an iPhone AND an iPad sharing one deviceId would have the second device's
        // APNs token OVERWRITE the first, so only the last-registered iOS device could ever
        // receive a native push. Mirror the FCM fix with one row per (device_id, token).
        // NOTE: there is currently NO APNs SEND path in the backend (apns_token is write-only:
        // registered + read by the diagnostic status endpoint, never sent to). This table +
        // upsert is preventive parity so that WHENEVER a native APNs sender is built it is
        // already clobber-safe — it MUST read getDeviceApnsTokens() and delete only single
        // dead-token rows, never the whole device. Backfill the legacy column so nothing regresses.
        await client.query(`
            CREATE TABLE IF NOT EXISTS device_apns_tokens (
                device_id   TEXT   NOT NULL,
                token       TEXT   NOT NULL,
                platform    TEXT   NOT NULL DEFAULT 'apns',
                updated_at  BIGINT,
                PRIMARY KEY (device_id, token)
            )
        `);
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_device_apns_tokens_device ON device_apns_tokens(device_id)
        `);
        await client.query(`
            INSERT INTO device_apns_tokens (device_id, token, platform, updated_at)
            SELECT device_id, apns_token, 'apns', $1 FROM devices WHERE apns_token IS NOT NULL
            ON CONFLICT (device_id, token) DO NOTHING
        `, [Date.now()]);
        console.log('[Push] DB migration: device_apns_tokens multi-token table ensured + backfilled');

        // Official bot bindings (free bot multi-device tracking)
        await client.query(`
            CREATE TABLE IF NOT EXISTS official_bot_bindings (
                bot_id TEXT NOT NULL,
                device_id TEXT NOT NULL,
                entity_id INTEGER NOT NULL,
                session_key TEXT NOT NULL,
                bound_at BIGINT NOT NULL,
                subscription_verified_at BIGINT,
                PRIMARY KEY (device_id, entity_id)
            )
        `);

        // Feedback table
        await client.query(`
            CREATE TABLE IF NOT EXISTS feedback (
                id SERIAL PRIMARY KEY,
                device_id TEXT NOT NULL,
                message TEXT NOT NULL,
                app_version TEXT DEFAULT '',
                created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW()) * 1000
            )
        `);

        // Cross-device contacts (friends system) — legacy table kept for migration
        await client.query(`
            CREATE TABLE IF NOT EXISTS cross_device_contacts (
                id SERIAL PRIMARY KEY,
                device_id TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
                contact_public_code VARCHAR(8) NOT NULL,
                contact_name TEXT,
                contact_character TEXT,
                contact_avatar TEXT,
                added_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW()) * 1000,
                UNIQUE(device_id, contact_public_code)
            )
        `);
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_contacts_device ON cross_device_contacts(device_id)
        `);

        // Agent Card Holder (replaces cross_device_contacts — no upper limit)
        await client.query(`
            CREATE TABLE IF NOT EXISTS agent_card_holder (
                id SERIAL PRIMARY KEY,
                device_id TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
                public_code VARCHAR(8) NOT NULL,
                contact_name TEXT,
                contact_character TEXT,
                contact_avatar TEXT,
                added_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW()) * 1000,
                card_snapshot JSONB,
                exchange_type VARCHAR(20) DEFAULT 'manual',
                last_refreshed BIGINT,
                notes TEXT,
                pinned BOOLEAN DEFAULT false,
                category VARCHAR(50),
                interaction_count INT DEFAULT 0,
                UNIQUE(device_id, public_code)
            )
        `);
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_card_holder_device ON agent_card_holder(device_id)
        `);
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_card_holder_pinned ON agent_card_holder(device_id, pinned)
        `);
        // Migration: add blocked + last_interacted_at columns (Card Holder redesign)
        await client.query(`ALTER TABLE agent_card_holder ADD COLUMN IF NOT EXISTS blocked BOOLEAN DEFAULT false`);
        await client.query(`ALTER TABLE agent_card_holder ADD COLUMN IF NOT EXISTS last_interacted_at BIGINT DEFAULT NULL`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_card_holder_recent ON agent_card_holder(device_id, last_interacted_at DESC NULLS LAST)`);
        // Migration: add is_friend column (Friend System)
        await client.query(`ALTER TABLE agent_card_holder ADD COLUMN IF NOT EXISTS is_friend BOOLEAN DEFAULT false`);

        // Friend Requests table
        await client.query(`
            CREATE TABLE IF NOT EXISTS friend_requests (
                id SERIAL PRIMARY KEY,
                from_device_id TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
                from_public_code VARCHAR(8) NOT NULL,
                to_public_code VARCHAR(8) NOT NULL,
                to_device_id TEXT NOT NULL,
                status VARCHAR(20) DEFAULT 'pending',
                message TEXT,
                created_at BIGINT NOT NULL,
                responded_at BIGINT,
                UNIQUE(from_device_id, to_public_code)
            )
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_friend_req_to ON friend_requests(to_device_id, status)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_friend_req_from ON friend_requests(from_device_id, status)`);

        // Migration: copy cross_device_contacts → agent_card_holder (idempotent)
        await client.query(`
            INSERT INTO agent_card_holder (device_id, public_code, contact_name, contact_character, contact_avatar, added_at, exchange_type)
            SELECT device_id, contact_public_code, contact_name, contact_character, contact_avatar, added_at, 'manual'
            FROM cross_device_contacts
            ON CONFLICT (device_id, public_code) DO NOTHING
        `);

        // ── Bot Plaza: Community tables ──
        // Agent card visibility (public listing)
        await client.query(`ALTER TABLE entities ADD COLUMN IF NOT EXISTS is_public BOOLEAN DEFAULT false`);
        await client.query(`ALTER TABLE entities ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ`);
        await client.query(`ALTER TABLE entities ADD COLUMN IF NOT EXISTS avg_rating NUMERIC(2,1) DEFAULT 0`);
        await client.query(`ALTER TABLE entities ADD COLUMN IF NOT EXISTS rating_count INTEGER DEFAULT 0`);
        await client.query(`ALTER TABLE entities ADD COLUMN IF NOT EXISTS community_message_count INTEGER DEFAULT 0`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_entities_public ON entities(is_public) WHERE is_public = true`);

        // Community messages (comments on public agent cards)
        await client.query(`
            CREATE TABLE IF NOT EXISTS community_messages (
                id              SERIAL PRIMARY KEY,
                card_public_code VARCHAR(8) NOT NULL,
                author_type     VARCHAR(10) NOT NULL CHECK (author_type IN ('bot', 'user')),
                author_id       TEXT NOT NULL,
                author_name     TEXT,
                text            TEXT NOT NULL,
                reply_to        INTEGER REFERENCES community_messages(id) ON DELETE SET NULL,
                created_at      TIMESTAMPTZ DEFAULT NOW()
            )
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_community_msg_card ON community_messages(card_public_code, created_at DESC)`);

        // Community ratings (one per device per card)
        await client.query(`
            CREATE TABLE IF NOT EXISTS community_ratings (
                id              SERIAL PRIMARY KEY,
                card_public_code VARCHAR(8) NOT NULL,
                device_id       TEXT NOT NULL,
                stars           INTEGER NOT NULL CHECK (stars >= 1 AND stars <= 5),
                created_at      TIMESTAMPTZ DEFAULT NOW(),
                updated_at      TIMESTAMPTZ DEFAULT NOW(),
                UNIQUE(card_public_code, device_id)
            )
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_community_rating_card ON community_ratings(card_public_code)`);

        // Encrypted device variables (env vars vault)
        await client.query(`
            CREATE TABLE IF NOT EXISTS device_vars (
                device_id       TEXT PRIMARY KEY REFERENCES devices(device_id) ON DELETE CASCADE,
                encrypted_vars  TEXT NOT NULL,
                iv              TEXT NOT NULL,
                auth_tag        TEXT NOT NULL,
                var_keys        TEXT[] DEFAULT '{}',
                var_sources     JSONB DEFAULT '{}',
                is_locked       BOOLEAN DEFAULT FALSE,
                updated_at      BIGINT NOT NULL
            )
        `);

        // Migration: add var_sources column if missing
        await client.query(`
            ALTER TABLE device_vars ADD COLUMN IF NOT EXISTS var_sources JSONB DEFAULT '{}'
        `);

        // 2026-04-23: audit trail for every vault mutation. Rows deliberately
        // store only the key name + action shape — NEVER the value — so a
        // compromised audit table still can't leak secrets. Added after two
        // same-day wipes (11:36 TW + 13:25 TW) that we couldn't trace to a
        // specific caller because the write path had no durable history.
        await client.query(`
            CREATE TABLE IF NOT EXISTS device_vars_audit (
                id              BIGSERIAL PRIMARY KEY,
                device_id       TEXT NOT NULL,
                action          TEXT NOT NULL,
                key_name        TEXT,
                source          TEXT,
                caller_ip       TEXT,
                caller_ua       TEXT,
                before_count    INTEGER,
                after_count     INTEGER,
                created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);
        await client.query(`
            CREATE INDEX IF NOT EXISTS device_vars_audit_device_created_idx
                ON device_vars_audit (device_id, created_at DESC)
        `);

        // Channel accounts (OpenClaw channel plugin integration)
        await client.query(`
            CREATE TABLE IF NOT EXISTS channel_accounts (
                id SERIAL PRIMARY KEY,
                device_id TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
                channel_api_key TEXT NOT NULL UNIQUE,
                channel_api_secret TEXT NOT NULL,
                callback_url TEXT,
                callback_token TEXT,
                status TEXT DEFAULT 'active',
                created_at BIGINT NOT NULL,
                updated_at BIGINT NOT NULL,
                UNIQUE(device_id)
            )
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_channel_api_key ON channel_accounts(channel_api_key)`);

        // v2: Add Basic Auth columns for Railway WEB_PASSWORD support
        await client.query(`ALTER TABLE channel_accounts ADD COLUMN IF NOT EXISTS callback_username TEXT`);
        await client.query(`ALTER TABLE channel_accounts ADD COLUMN IF NOT EXISTS callback_password TEXT`);

        // E2EE awareness (Issue #212): channel declares encryption capability
        await client.query(`ALTER TABLE channel_accounts ADD COLUMN IF NOT EXISTS e2ee_capable BOOLEAN DEFAULT FALSE`);

        await client.query(`
            CREATE TABLE IF NOT EXISTS skill_contributions (
                id SERIAL PRIMARY KEY,
                pending_id TEXT NOT NULL UNIQUE,
                skill_id TEXT NOT NULL,
                label TEXT,
                icon TEXT,
                title TEXT NOT NULL,
                url TEXT NOT NULL,
                author TEXT,
                required_vars JSONB DEFAULT '[]',
                steps TEXT,
                submitted_by JSONB NOT NULL,
                submitted_at TIMESTAMPTZ DEFAULT NOW(),
                status TEXT NOT NULL DEFAULT 'verifying',
                verified_at TIMESTAMPTZ,
                verification_result JSONB,
                rejected_reason TEXT
            )
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_skill_contrib_status ON skill_contributions(status)`);

        await client.query(`
            CREATE TABLE IF NOT EXISTS soul_contributions (
                id              SERIAL PRIMARY KEY,
                pending_id      TEXT NOT NULL UNIQUE,
                soul_id         TEXT NOT NULL,
                label           TEXT,
                icon            TEXT,
                name            TEXT NOT NULL,
                description     TEXT NOT NULL,
                author          TEXT,
                submitted_by    JSONB NOT NULL,
                submitted_at    TIMESTAMPTZ DEFAULT NOW(),
                status          TEXT NOT NULL DEFAULT 'approved',
                verified_at     TIMESTAMPTZ
            )
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_soul_contrib_status ON soul_contributions(status)`);

        await client.query(`
            CREATE TABLE IF NOT EXISTS rule_contributions (
                id              SERIAL PRIMARY KEY,
                pending_id      TEXT NOT NULL UNIQUE,
                rule_id         TEXT NOT NULL,
                label           TEXT,
                icon            TEXT,
                rule_type       TEXT NOT NULL,
                name            TEXT NOT NULL,
                description     TEXT NOT NULL,
                author          TEXT,
                submitted_by    JSONB NOT NULL,
                submitted_at    TIMESTAMPTZ DEFAULT NOW(),
                status          TEXT NOT NULL DEFAULT 'approved',
                verified_at     TIMESTAMPTZ
            )
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_rule_contrib_status ON rule_contributions(status)`);

        // Entity trash (soft-delete recovery, 7-day retention)
        await client.query(`
            CREATE TABLE IF NOT EXISTS entity_trash (
                id              SERIAL PRIMARY KEY,
                device_id       TEXT NOT NULL,
                entity_id       INTEGER NOT NULL,
                character       TEXT,
                name            TEXT,
                state           TEXT,
                message         TEXT,
                webhook         JSONB,
                bot_secret      TEXT,
                public_code     TEXT,
                xp              INTEGER DEFAULT 0,
                avatar          TEXT,
                agent_card      JSONB,
                identity        JSONB,
                encryption_status TEXT,
                deleted_at      TIMESTAMPTZ DEFAULT NOW(),
                expires_at      TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '7 days'),
                FOREIGN KEY (device_id) REFERENCES devices(device_id) ON DELETE CASCADE
            )
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_entity_trash_device ON entity_trash(device_id)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_entity_trash_expires ON entity_trash(expires_at)`);
        // Migration: add identity column to entity_trash for existing deployments
        await client.query(`ALTER TABLE entity_trash ADD COLUMN IF NOT EXISTS identity JSONB`);

        // Pending cross-device messages (queued until email verification)
        await client.query(`
            CREATE TABLE IF NOT EXISTS pending_cross_messages (
                id SERIAL PRIMARY KEY,
                sender_device_id TEXT NOT NULL,
                sender_entity_id INTEGER DEFAULT -1,
                target_code VARCHAR(8) NOT NULL,
                text TEXT NOT NULL,
                media_type TEXT,
                media_url TEXT,
                created_at BIGINT NOT NULL
            )
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_pending_cross_sender ON pending_cross_messages(sender_device_id)`);

        // Note Pages table (webview static pages for mission notes)
        await client.query(`
            CREATE TABLE IF NOT EXISTS note_pages (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                device_id VARCHAR(64) NOT NULL,
                note_id VARCHAR(128) NOT NULL,
                html_content TEXT NOT NULL DEFAULT '',
                drawing_data TEXT DEFAULT NULL,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                updated_at TIMESTAMPTZ DEFAULT NOW(),
                UNIQUE(device_id, note_id)
            )
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_note_pages_device ON note_pages(device_id)`);

        // Discord bot integrations per entity
        await client.query(`
            CREATE TABLE IF NOT EXISTS discord_bots (
                id SERIAL PRIMARY KEY,
                device_id VARCHAR(64) NOT NULL,
                entity_id INTEGER NOT NULL,
                application_id VARCHAR(64) NOT NULL,
                public_key VARCHAR(128) NOT NULL,
                bot_token TEXT NOT NULL,
                guild_id VARCHAR(64) DEFAULT NULL,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                UNIQUE(device_id, entity_id)
            )
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_discord_bots_app ON discord_bots(application_id)`);

        // Scheduled messages (Phase 1) — consolidated from scheduled_messages_schema.sql
        // to ensure migration runs under db.js retry loop (not module-level init)
        await client.query(`
            CREATE TABLE IF NOT EXISTS scheduled_messages (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                device_id TEXT NOT NULL,
                chat_entity_id INTEGER NOT NULL,
                user_entity_id INTEGER NOT NULL,
                target_entity_ids JSONB NOT NULL,
                content TEXT NOT NULL,
                scheduled_at TIMESTAMPTZ NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                sent_at TIMESTAMPTZ,
                cancelled_at TIMESTAMPTZ,
                last_error TEXT,
                CONSTRAINT scheduled_messages_content_len CHECK (char_length(content) BETWEEN 1 AND 10000)
            )
        `);
        // Idempotent column adds for legacy tables predating Phase 1
        await client.query(`ALTER TABLE scheduled_messages ADD COLUMN IF NOT EXISTS chat_entity_id INTEGER`);
        await client.query(`ALTER TABLE scheduled_messages ADD COLUMN IF NOT EXISTS user_entity_id INTEGER`);
        await client.query(`ALTER TABLE scheduled_messages ADD COLUMN IF NOT EXISTS target_entity_ids JSONB`);
        await client.query(`ALTER TABLE scheduled_messages ADD COLUMN IF NOT EXISTS content TEXT`);
        await client.query(`ALTER TABLE scheduled_messages ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMPTZ`);
        await client.query(`ALTER TABLE scheduled_messages ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()`);
        await client.query(`ALTER TABLE scheduled_messages ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ`);
        await client.query(`ALTER TABLE scheduled_messages ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ`);
        await client.query(`ALTER TABLE scheduled_messages ADD COLUMN IF NOT EXISTS last_error TEXT`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_scheduled_messages_pending ON scheduled_messages (scheduled_at) WHERE sent_at IS NULL AND cancelled_at IS NULL`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_scheduled_messages_device ON scheduled_messages (device_id, chat_entity_id)`);

        console.log('[DB] Database tables ready');
        client.release();
    } catch (err) {
        console.error('[DB] Failed to create tables:', err.message);
        throw err;
    }
}

// Save device and all entities to database
async function saveDeviceData(deviceId, deviceData) {
    if (!pool) {
        console.warn('[DB] Database not initialized, skipping save');
        return false;
    }

    try {
        const client = await pool.connect();

        try {
            await client.query('BEGIN');

            // Upsert device
            await client.query(
                `INSERT INTO devices (device_id, device_secret, created_at, updated_at, next_entity_id, prompt_policy)
                 VALUES ($1, $2, $3, $4, $5, $6)
                 ON CONFLICT (device_id)
                 DO UPDATE SET updated_at = $4, next_entity_id = $5, prompt_policy = $6`,
                [
                    deviceId,
                    deviceData.deviceSecret,
                    deviceData.createdAt,
                    Date.now(),
                    deviceData.nextEntityId || 1,
                    deviceData.promptPolicy ? JSON.stringify(deviceData.promptPolicy) : null
                ]
            );

            // Clear all public_code for this device first to avoid unique constraint
            // violations when entities swap publicCodes during reorder
            await client.query(
                'UPDATE entities SET public_code = NULL WHERE device_id = $1',
                [deviceId]
            );

            // Save all entities (supports up to 8 slots for premium devices)
            for (const i of Object.keys(deviceData.entities).map(Number)) {
                const entity = deviceData.entities[i];
                if (!entity) continue;

                const entityParams = [
                    deviceId,
                    i,
                    entity.botSecret,
                    entity.isBound,
                    entity.name,
                    entity.character,
                    entity.state,
                    entity.message,
                    JSON.stringify(entity.parts),
                    entity.lastUpdated,
                    JSON.stringify(entity.messageQueue || []),
                    entity.webhook ? JSON.stringify(entity.webhook) : null,
                    entity.appVersion,
                    entity.xp || 0,
                    entity.level || 1,
                    entity.avatar || null,
                    entity.publicCode || null,
                    entity.bindingType || null,
                    entity.channelAccountId || null,
                    entity.agentCard ? JSON.stringify(entity.agentCard) : null,
                    entity.encryptionStatus || null,
                    entity.identity ? JSON.stringify(entity.identity) : null,
                    entity.rental_status || null,
                    entity.rental_contract_id || null
                ];
                const entitySql = `INSERT INTO entities (
                        device_id, entity_id, bot_secret, is_bound, name,
                        character, state, message, parts,
                        last_updated, message_queue, webhook, app_version,
                        xp, level, avatar, public_code, binding_type, channel_account_id, agent_card,
                        encryption_status, identity, rental_status, rental_contract_id
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24)
                    ON CONFLICT (device_id, entity_id)
                    DO UPDATE SET
                        bot_secret = $3,
                        is_bound = $4,
                        name = $5,
                        character = $6,
                        state = $7,
                        message = $8,
                        parts = $9,
                        last_updated = $10,
                        message_queue = $11,
                        webhook = $12,
                        app_version = $13,
                        xp = $14,
                        level = $15,
                        avatar = $16,
                        public_code = $17,
                        binding_type = $18,
                        channel_account_id = $19,
                        agent_card = $20,
                        encryption_status = $21,
                        identity = $22,
                        rental_status = $23,
                        rental_contract_id = $24`;

                await client.query(`SAVEPOINT entity_${i}`);
                try {
                    await client.query(entitySql, entityParams);
                    await client.query(`RELEASE SAVEPOINT entity_${i}`);
                } catch (entityErr) {
                    await client.query(`ROLLBACK TO SAVEPOINT entity_${i}`);
                    if (entityErr.message.includes('idx_entities_public_code')) {
                        // Duplicate public_code — clear it and save without code
                        console.warn(`[DB] Duplicate public_code for device ${deviceId} entity ${i}, clearing code`);
                        entity.publicCode = null;
                        entityParams[16] = null;
                        await client.query(entitySql, entityParams);
                    } else {
                        throw entityErr;
                    }
                }
            }

            await client.query('COMMIT');
            return true;
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    } catch (err) {
        console.error(`[DB] Failed to save device ${deviceId}:`, err.message);
        // Log to server_logs for AI visibility
        pool.query(
            `INSERT INTO server_logs (level, category, message, device_id, metadata) VALUES ($1, $2, $3, $4, $5)`,
            ['error', 'db_save', `Failed to save device: ${err.message}`, deviceId, JSON.stringify({ error: err.message })]
        ).catch(() => {});
        return false;
    }
}

// Save all devices to database
async function saveAllDevices(devicesObject) {
    if (!pool) {
        console.warn('[DB] Database not initialized, skipping save');
        return false;
    }

    try {
        let savedCount = 0;
        for (const deviceId in devicesObject) {
            const success = await saveDeviceData(deviceId, devicesObject[deviceId]);
            if (success) savedCount++;
        }

        if (savedCount > 0) {
            console.log(`[DB] Saved ${savedCount} devices to PostgreSQL`);
        }
        return true;
    } catch (err) {
        console.error('[DB] Failed to save devices:', err.message);
        return false;
    }
}

// Load all devices from database
async function loadAllDevices() {
    if (!pool) {
        console.warn('[DB] Database not initialized, skipping load');
        return {};
    }

    try {
        const client = await pool.connect();

        // Load all devices
        const devicesResult = await client.query(
            'SELECT * FROM devices ORDER BY created_at ASC'
        );

        // Load all entities
        const entitiesResult = await client.query(
            'SELECT * FROM entities ORDER BY device_id, entity_id ASC'
        );

        client.release();

        // Reconstruct devices object
        const devices = {};

        for (const row of devicesResult.rows) {
            devices[row.device_id] = {
                deviceId: row.device_id,
                deviceSecret: row.device_secret,
                createdAt: parseInt(row.created_at),
                nextEntityId: parseInt(row.next_entity_id) || 1,
                promptPolicy: row.prompt_policy
                    ? (typeof row.prompt_policy === 'string' ? JSON.parse(row.prompt_policy) : row.prompt_policy)
                    : null,
                userDisplayName: row.user_display_name || null,
                fcmToken: row.fcm_token || null,
                apnsToken: row.apns_token || null,
                entities: {}
            };
        }

        // Add entities to devices
        for (const row of entitiesResult.rows) {
            const deviceId = row.device_id;
            const entityId = parseInt(row.entity_id);

            if (!devices[deviceId]) continue;

            devices[deviceId].entities[entityId] = {
                entityId: entityId,
                botSecret: row.bot_secret,
                isBound: row.is_bound,
                name: row.name,
                character: row.character,
                state: row.state,
                message: row.message,
                parts: typeof row.parts === 'string' ? JSON.parse(row.parts) : row.parts,
                lastUpdated: parseInt(row.last_updated),
                messageQueue: typeof row.message_queue === 'string'
                    ? JSON.parse(row.message_queue)
                    : (row.message_queue || []),
                webhook: row.webhook
                    ? (typeof row.webhook === 'string' ? JSON.parse(row.webhook) : row.webhook)
                    : null,
                appVersion: row.app_version,
                avatar: row.avatar || null,
                xp: parseInt(row.xp) || 0,
                level: parseInt(row.level) || 1,
                publicCode: row.public_code || null,
                bindingType: row.binding_type || null,
                channelAccountId: row.channel_account_id ? parseInt(row.channel_account_id) : null,
                agentCard: row.agent_card ? (typeof row.agent_card === 'string' ? JSON.parse(row.agent_card) : row.agent_card) : null,
                encryptionStatus: row.encryption_status || null,
                identity: row.identity ? (typeof row.identity === 'string' ? JSON.parse(row.identity) : row.identity) : null,
                isPublic: !!row.is_public,
                publishedAt: row.published_at ? new Date(row.published_at).getTime() : null,
                rental_status: row.rental_status || null,
                rental_contract_id: row.rental_contract_id || null
            };
        }

        const deviceCount = Object.keys(devices).length;
        let boundCount = 0;
        for (const deviceId in devices) {
            for (const i of Object.keys(devices[deviceId].entities).map(Number)) {
                if (devices[deviceId].entities[i]?.isBound) boundCount++;
            }
        }

        if (deviceCount > 0) {
            console.log(`[DB] Loaded ${deviceCount} devices, ${boundCount} bound entities from PostgreSQL`);
        }

        return devices;
    } catch (err) {
        console.error('[DB] Failed to load devices:', err.message);
        return {};
    }
}

// Delete device from database
async function deleteDevice(deviceId) {
    if (!pool) return false;

    try {
        const client = await pool.connect();
        // CASCADE will automatically delete associated entities
        await client.query('DELETE FROM devices WHERE device_id = $1', [deviceId]);
        client.release();
        console.log(`[DB] Deleted device ${deviceId} from PostgreSQL`);
        return true;
    } catch (err) {
        console.error(`[DB] Failed to delete device ${deviceId}:`, err.message);
        return false;
    }
}

// Delete a single entity from database (permanent removal)
async function deleteEntity(deviceId, entityId) {
    if (!pool) return false;

    try {
        const result = await pool.query(
            'DELETE FROM entities WHERE device_id = $1 AND entity_id = $2',
            [deviceId, entityId]
        );
        console.log(`[DynamicEntity] DB deleteEntity: deviceId=${deviceId}, entityId=${entityId}, rowsDeleted=${result.rowCount}`);
        return result.rowCount > 0;
    } catch (err) {
        console.error(`[DynamicEntity] Failed to delete entity ${entityId} from device ${deviceId}:`, err.message);
        return false;
    }
}

// Get database statistics
async function getStats() {
    if (!pool) return null;

    try {
        const client = await pool.connect();

        const devicesResult = await client.query('SELECT COUNT(*) FROM devices');
        const entitiesResult = await client.query('SELECT COUNT(*) FROM entities WHERE is_bound = TRUE');

        client.release();

        return {
            devices: parseInt(devicesResult.rows[0].count),
            boundEntities: parseInt(entitiesResult.rows[0].count)
        };
    } catch (err) {
        console.error('[DB] Failed to get stats:', err.message);
        return null;
    }
}

// ============================================
// Official Bot Pool Functions
// ============================================

async function saveOfficialBot(bot) {
    if (!pool) return false;
    try {
        const client = await pool.connect();
        await client.query(
            `INSERT INTO official_bots (bot_id, bot_type, webhook_url, token, bot_secret, session_key_template, status, assigned_device_id, assigned_entity_id, assigned_at, created_at, setup_username, setup_password, display_name, model_name, retirement_reason)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
             ON CONFLICT (bot_id)
             DO UPDATE SET webhook_url = $3, token = $4, bot_secret = $5, session_key_template = $6, status = $7, assigned_device_id = $8, assigned_entity_id = $9, assigned_at = $10, setup_username = $12, setup_password = $13, display_name = $14, model_name = $15, retirement_reason = $16`,
            [bot.bot_id, bot.bot_type, bot.webhook_url, bot.token, bot.bot_secret || null, bot.session_key_template || null, bot.status || 'available', bot.assigned_device_id || null, bot.assigned_entity_id ?? null, bot.assigned_at || null, bot.created_at || Date.now(), bot.setup_username || null, bot.setup_password || null, bot.display_name || null, bot.model_name || null, bot.retirement_reason || null]
        );
        client.release();
        return true;
    } catch (err) {
        console.error(`[DB] Failed to save official bot ${bot.bot_id}:`, err.message);
        return false;
    }
}

async function loadOfficialBots() {
    if (!pool) return {};
    try {
        const client = await pool.connect();
        const result = await client.query('SELECT * FROM official_bots ORDER BY created_at ASC');
        client.release();
        const bots = {};
        for (const row of result.rows) {
            bots[row.bot_id] = {
                bot_id: row.bot_id,
                bot_type: row.bot_type,
                webhook_url: row.webhook_url,
                token: row.token,
                bot_secret: row.bot_secret || null,
                session_key_template: row.session_key_template,
                status: row.status,
                assigned_device_id: row.assigned_device_id,
                assigned_entity_id: row.assigned_entity_id != null ? parseInt(row.assigned_entity_id) : null,
                assigned_at: row.assigned_at ? parseInt(row.assigned_at) : null,
                created_at: parseInt(row.created_at),
                setup_username: row.setup_username || null,
                setup_password: row.setup_password || null,
                display_name: row.display_name || null,
                model_name: row.model_name || null,
                retirement_reason: row.retirement_reason || null
            };
        }
        console.log(`[DB] Loaded ${Object.keys(bots).length} official bots`);
        return bots;
    } catch (err) {
        console.error('[DB] Failed to load official bots:', err.message);
        return {};
    }
}

async function deleteOfficialBot(botId) {
    if (!pool) return false;
    try {
        const client = await pool.connect();
        await client.query('DELETE FROM official_bot_bindings WHERE bot_id = $1', [botId]);
        await client.query('DELETE FROM official_bots WHERE bot_id = $1', [botId]);
        client.release();
        return true;
    } catch (err) {
        console.error(`[DB] Failed to delete official bot ${botId}:`, err.message);
        return false;
    }
}

async function saveOfficialBinding(binding) {
    if (!pool) return false;
    try {
        const client = await pool.connect();
        await client.query(
            `INSERT INTO official_bot_bindings (bot_id, device_id, entity_id, session_key, bound_at, subscription_verified_at)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (device_id, entity_id)
             DO UPDATE SET bot_id = $1, session_key = $4, bound_at = $5, subscription_verified_at = $6`,
            [binding.bot_id, binding.device_id, binding.entity_id, binding.session_key, binding.bound_at || Date.now(), binding.subscription_verified_at || Date.now()]
        );
        client.release();
        return true;
    } catch (err) {
        console.error(`[DB] Failed to save official binding:`, err.message);
        return false;
    }
}

async function removeOfficialBinding(deviceId, entityId) {
    if (!pool) return false;
    try {
        const client = await pool.connect();
        const result = await client.query(
            'DELETE FROM official_bot_bindings WHERE device_id = $1 AND entity_id = $2 RETURNING bot_id',
            [deviceId, entityId]
        );
        client.release();
        return result.rows.length > 0 ? result.rows[0].bot_id : null;
    } catch (err) {
        console.error(`[DB] Failed to remove official binding:`, err.message);
        return null;
    }
}

async function getOfficialBinding(deviceId, entityId) {
    if (!pool) return null;
    try {
        const client = await pool.connect();
        const result = await client.query(
            'SELECT * FROM official_bot_bindings WHERE device_id = $1 AND entity_id = $2',
            [deviceId, entityId]
        );
        client.release();
        if (result.rows.length === 0) return null;
        const row = result.rows[0];
        return {
            bot_id: row.bot_id,
            device_id: row.device_id,
            entity_id: parseInt(row.entity_id),
            session_key: row.session_key,
            bound_at: parseInt(row.bound_at),
            subscription_verified_at: row.subscription_verified_at ? parseInt(row.subscription_verified_at) : null
        };
    } catch (err) {
        console.error(`[DB] Failed to get official binding:`, err.message);
        return null;
    }
}

async function getDeviceOfficialBindings(deviceId) {
    if (!pool) return [];
    try {
        const client = await pool.connect();
        const result = await client.query(
            `SELECT b.*, o.bot_type FROM official_bot_bindings b
             JOIN official_bots o ON b.bot_id = o.bot_id
             WHERE b.device_id = $1`,
            [deviceId]
        );
        client.release();
        return result.rows.map(row => ({
            bot_id: row.bot_id,
            device_id: row.device_id,
            entity_id: parseInt(row.entity_id),
            session_key: row.session_key,
            bound_at: parseInt(row.bound_at),
            bot_type: row.bot_type
        }));
    } catch (err) {
        console.error(`[DB] Failed to get device bindings:`, err.message);
        return [];
    }
}

async function updateSubscriptionVerified(deviceId, entityId) {
    if (!pool) return false;
    try {
        const client = await pool.connect();
        await client.query(
            'UPDATE official_bot_bindings SET subscription_verified_at = $1 WHERE device_id = $2 AND entity_id = $3',
            [Date.now(), deviceId, entityId]
        );
        client.release();
        return true;
    } catch (err) {
        console.error(`[DB] Failed to update subscription verified:`, err.message);
        return false;
    }
}

async function loadAllOfficialBindings() {
    if (!pool) return [];
    try {
        const client = await pool.connect();
        const result = await client.query(
            `SELECT b.*, o.bot_type FROM official_bot_bindings b
             JOIN official_bots o ON b.bot_id = o.bot_id`
        );
        client.release();
        return result.rows.map(row => ({
            bot_id: row.bot_id,
            device_id: row.device_id,
            entity_id: parseInt(row.entity_id),
            session_key: row.session_key,
            bound_at: row.bound_at ? parseInt(row.bound_at) : null,
            bot_type: row.bot_type
        }));
    } catch (err) {
        console.error('[DB] Failed to load all official bindings:', err.message);
        return [];
    }
}

async function getExpiredPersonalBindings(maxAgeMs) {
    if (!pool) return [];
    try {
        const client = await pool.connect();
        const cutoff = Date.now() - maxAgeMs;
        const result = await client.query(
            `SELECT b.*, o.bot_type FROM official_bot_bindings b
             JOIN official_bots o ON b.bot_id = o.bot_id
             WHERE o.bot_type = 'personal'
             AND (b.subscription_verified_at IS NULL OR b.subscription_verified_at < $1)`,
            [cutoff]
        );
        client.release();
        return result.rows.map(row => ({
            bot_id: row.bot_id,
            device_id: row.device_id,
            entity_id: parseInt(row.entity_id),
            session_key: row.session_key,
            bound_at: parseInt(row.bound_at),
            subscription_verified_at: row.subscription_verified_at ? parseInt(row.subscription_verified_at) : null
        }));
    } catch (err) {
        console.error(`[DB] Failed to get expired bindings:`, err.message);
        return [];
    }
}

// ============================================
// Paid Borrow Slots Functions
// ============================================

async function getPaidBorrowSlots(deviceId) {
    if (!pool) return 0;
    try {
        const client = await pool.connect();
        const result = await client.query(
            'SELECT paid_borrow_slots FROM devices WHERE device_id = $1',
            [deviceId]
        );
        client.release();
        return result.rows.length > 0 ? (result.rows[0].paid_borrow_slots || 0) : 0;
    } catch (err) {
        console.error(`[DB] Failed to get paid_borrow_slots for ${deviceId}:`, err.message);
        return 0;
    }
}

async function incrementPaidBorrowSlots(deviceId) {
    if (!pool) return 0;
    try {
        const client = await pool.connect();
        const result = await client.query(
            `UPDATE devices SET paid_borrow_slots = COALESCE(paid_borrow_slots, 0) + 1
             WHERE device_id = $1 RETURNING paid_borrow_slots`,
            [deviceId]
        );
        client.release();
        return result.rows.length > 0 ? result.rows[0].paid_borrow_slots : 0;
    } catch (err) {
        console.error(`[DB] Failed to increment paid_borrow_slots for ${deviceId}:`, err.message);
        return 0;
    }
}

// Save user feedback
async function saveFeedback(deviceId, message, appVersion) {
    try {
        await pool.query(
            `INSERT INTO feedback (device_id, message, app_version, created_at) VALUES ($1, $2, $3, $4)`,
            [deviceId, message, appVersion || '', Date.now()]
        );
    } catch (err) {
        console.error(`[DB] Failed to save feedback:`, err.message);
    }
}

// ── Agent Card Holder (replaces Cross-Device Contacts) ──
async function getCardHolder(deviceId, { pinned, category, limit, offset, includeBlocked } = {}) {
    if (!pool) return [];
    try {
        let sql = `SELECT public_code AS "publicCode", contact_name AS name, contact_character AS character,
                    contact_avatar AS avatar, added_at AS "addedAt", card_snapshot AS "cardSnapshot",
                    exchange_type AS "exchangeType", last_refreshed AS "lastRefreshed",
                    notes, pinned, category, interaction_count AS "interactionCount",
                    blocked, last_interacted_at AS "lastInteractedAt",
                    is_friend AS "isFriend"
                    FROM agent_card_holder WHERE device_id = $1`;
        const params = [deviceId];
        let idx = 2;
        if (!includeBlocked) { sql += ` AND (blocked = false OR blocked IS NULL)`; }
        if (pinned !== undefined) { sql += ` AND pinned = $${idx++}`; params.push(pinned); }
        if (category) { sql += ` AND category = $${idx++}`; params.push(category); }
        sql += ` ORDER BY is_friend DESC, pinned DESC, added_at DESC`;
        if (limit) { sql += ` LIMIT $${idx++}`; params.push(limit); }
        if (offset) { sql += ` OFFSET $${idx++}`; params.push(offset); }
        const result = await pool.query(sql, params);
        return result.rows;
    } catch (err) {
        console.error('[DB] Failed to get card holder:', err.message);
        return [];
    }
}

async function addCard(deviceId, publicCode, { name, character, avatar, cardSnapshot, exchangeType } = {}) {
    if (!pool) return null;
    try {
        const result = await pool.query(
            `INSERT INTO agent_card_holder (device_id, public_code, contact_name, contact_character, contact_avatar, added_at, card_snapshot, exchange_type, last_refreshed, last_interacted_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $6, $6)
             ON CONFLICT (device_id, public_code) DO UPDATE SET
                contact_name = EXCLUDED.contact_name,
                contact_character = EXCLUDED.contact_character,
                contact_avatar = EXCLUDED.contact_avatar,
                card_snapshot = COALESCE(EXCLUDED.card_snapshot, agent_card_holder.card_snapshot),
                last_refreshed = EXCLUDED.last_refreshed,
                last_interacted_at = EXCLUDED.last_interacted_at,
                interaction_count = agent_card_holder.interaction_count + 1
             RETURNING id, public_code AS "publicCode", contact_name AS name, contact_character AS character,
                contact_avatar AS avatar, added_at AS "addedAt", card_snapshot AS "cardSnapshot",
                exchange_type AS "exchangeType", last_refreshed AS "lastRefreshed",
                notes, pinned, category, interaction_count AS "interactionCount",
                blocked, last_interacted_at AS "lastInteractedAt",
                is_friend AS "isFriend"`,
            [deviceId, publicCode, name || null, character || null, avatar || null, Date.now(),
             cardSnapshot ? JSON.stringify(cardSnapshot) : null, exchangeType || 'manual']
        );
        return result.rows[0];
    } catch (err) {
        console.error('[DB] Failed to add card:', err.message);
        return null;
    }
}

async function updateCard(deviceId, publicCode, updates) {
    if (!pool) return null;
    const allowed = ['notes', 'pinned', 'category', 'blocked', 'is_friend'];
    const sets = [];
    const params = [deviceId, publicCode];
    let idx = 3;
    for (const key of allowed) {
        if (updates[key] !== undefined) {
            sets.push(`${key} = $${idx++}`);
            params.push(updates[key]);
        }
    }
    if (sets.length === 0) return null;
    try {
        const result = await pool.query(
            `UPDATE agent_card_holder SET ${sets.join(', ')}
             WHERE device_id = $1 AND public_code = $2
             RETURNING public_code AS "publicCode", notes, pinned, category, blocked, is_friend AS "isFriend"`,
            params
        );
        return result.rows[0] || null;
    } catch (err) {
        console.error('[DB] Failed to update card:', err.message);
        return null;
    }
}

async function refreshCardSnapshot(deviceId, publicCode, cardSnapshot, name, character, avatar) {
    if (!pool) return null;
    try {
        const result = await pool.query(
            `UPDATE agent_card_holder
             SET card_snapshot = $3, last_refreshed = $4,
                 contact_name = COALESCE($5, contact_name),
                 contact_character = COALESCE($6, contact_character),
                 contact_avatar = COALESCE($7, contact_avatar)
             WHERE device_id = $1 AND public_code = $2
             RETURNING public_code AS "publicCode", card_snapshot AS "cardSnapshot", last_refreshed AS "lastRefreshed"`,
            [deviceId, publicCode, cardSnapshot ? JSON.stringify(cardSnapshot) : null, Date.now(),
             name || null, character || null, avatar || null]
        );
        return result.rows[0] || null;
    } catch (err) {
        console.error('[DB] Failed to refresh card:', err.message);
        return null;
    }
}

async function searchCards(deviceId, query) {
    if (!pool) return [];
    try {
        const pattern = `%${query}%`;
        const result = await pool.query(
            `SELECT public_code AS "publicCode", contact_name AS name, contact_character AS character,
                    contact_avatar AS avatar, added_at AS "addedAt", card_snapshot AS "cardSnapshot",
                    exchange_type AS "exchangeType", last_refreshed AS "lastRefreshed",
                    notes, pinned, category, interaction_count AS "interactionCount",
                    blocked, last_interacted_at AS "lastInteractedAt",
                    is_friend AS "isFriend"
             FROM agent_card_holder WHERE device_id = $1
             AND (blocked = false OR blocked IS NULL)
             AND (
                 public_code ILIKE $2
                 OR contact_name ILIKE $2
                 OR category ILIKE $2
                 OR notes ILIKE $2
                 OR card_snapshot::text ILIKE $2
             )
             ORDER BY is_friend DESC, pinned DESC, interaction_count DESC, added_at DESC`,
            [deviceId, pattern]
        );
        return result.rows;
    } catch (err) {
        console.error('[DB] Failed to search cards:', err.message);
        return [];
    }
}

async function getCardByCode(deviceId, publicCode) {
    if (!pool) return null;
    try {
        const result = await pool.query(
            `SELECT public_code AS "publicCode", contact_name AS name, contact_character AS character,
                    contact_avatar AS avatar, added_at AS "addedAt", card_snapshot AS "cardSnapshot",
                    exchange_type AS "exchangeType", last_refreshed AS "lastRefreshed",
                    notes, pinned, category, interaction_count AS "interactionCount",
                    blocked, last_interacted_at AS "lastInteractedAt",
                    is_friend AS "isFriend"
             FROM agent_card_holder WHERE device_id = $1 AND public_code = $2`,
            [deviceId, publicCode]
        );
        return result.rows[0] || null;
    } catch (err) {
        console.error('[DB] Failed to get card:', err.message);
        return null;
    }
}

async function removeCard(deviceId, publicCode) {
    if (!pool) return false;
    try {
        await pool.query(
            `DELETE FROM agent_card_holder WHERE device_id = $1 AND public_code = $2`,
            [deviceId, publicCode]
        );
        return true;
    } catch (err) {
        console.error('[DB] Failed to remove card:', err.message);
        return false;
    }
}

async function getCardCount(deviceId) {
    if (!pool) return 0;
    try {
        const result = await pool.query(
            `SELECT COUNT(*) AS count FROM agent_card_holder WHERE device_id = $1`,
            [deviceId]
        );
        return parseInt(result.rows[0].count);
    } catch (err) {
        console.error('[DB] Failed to get card count:', err.message);
        return 0;
    }
}

async function incrementInteraction(deviceId, publicCode) {
    if (!pool) return;
    try {
        await pool.query(
            `UPDATE agent_card_holder SET interaction_count = interaction_count + 1
             WHERE device_id = $1 AND public_code = $2`,
            [deviceId, publicCode]
        );
    } catch (err) {
        // Non-critical, just log
        console.error('[DB] Failed to increment interaction:', err.message);
    }
}

async function getRecentInteractions(deviceId, limit = 20) {
    if (!pool) return [];
    try {
        const result = await pool.query(
            `SELECT public_code AS "publicCode", contact_name AS name, contact_character AS character,
                    contact_avatar AS avatar, added_at AS "addedAt", card_snapshot AS "cardSnapshot",
                    exchange_type AS "exchangeType", last_refreshed AS "lastRefreshed",
                    notes, pinned, category, interaction_count AS "interactionCount",
                    blocked, last_interacted_at AS "lastInteractedAt",
                    is_friend AS "isFriend"
             FROM agent_card_holder WHERE device_id = $1
             AND last_interacted_at IS NOT NULL
             AND (blocked = false OR blocked IS NULL)
             ORDER BY last_interacted_at DESC LIMIT $2`,
            [deviceId, limit]
        );
        return result.rows;
    } catch (err) {
        console.error('[DB] Failed to get recent interactions:', err.message);
        return [];
    }
}

async function upsertRecentInteraction(deviceId, publicCode, { name, character, avatar, cardSnapshot } = {}) {
    if (!pool) return null;
    try {
        const now = Date.now();
        const result = await pool.query(
            `INSERT INTO agent_card_holder (device_id, public_code, contact_name, contact_character, contact_avatar, added_at, card_snapshot, exchange_type, last_refreshed, last_interacted_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'incoming', $6, $6)
             ON CONFLICT (device_id, public_code) DO UPDATE SET
                contact_name = COALESCE(EXCLUDED.contact_name, agent_card_holder.contact_name),
                contact_character = COALESCE(EXCLUDED.contact_character, agent_card_holder.contact_character),
                contact_avatar = COALESCE(EXCLUDED.contact_avatar, agent_card_holder.contact_avatar),
                card_snapshot = COALESCE(EXCLUDED.card_snapshot, agent_card_holder.card_snapshot),
                last_interacted_at = EXCLUDED.last_interacted_at,
                interaction_count = agent_card_holder.interaction_count + 1
             RETURNING public_code AS "publicCode", blocked, is_friend AS "isFriend"`,
            [deviceId, publicCode, name || null, character || null, avatar || null, now,
             cardSnapshot ? JSON.stringify(cardSnapshot) : null]
        );
        return result.rows[0] || null;
    } catch (err) {
        console.error('[DB] Failed to upsert recent interaction:', err.message);
        return null;
    }
}

async function isBlocked(deviceId, publicCode) {
    if (!pool) return false;
    try {
        const result = await pool.query(
            `SELECT blocked FROM agent_card_holder WHERE device_id = $1 AND public_code = $2`,
            [deviceId, publicCode]
        );
        return result.rows.length > 0 && result.rows[0].blocked === true;
    } catch (err) {
        console.error('[DB] Failed to check blocked status:', err.message);
        return false;
    }
}

async function isFriend(deviceId, publicCode) {
    if (!pool) return false;
    try {
        const result = await pool.query(
            `SELECT is_friend FROM agent_card_holder WHERE device_id = $1 AND public_code = $2`,
            [deviceId, publicCode]
        );
        return result.rows.length > 0 && result.rows[0].is_friend === true;
    } catch (err) {
        console.error('[DB] Failed to check friend status:', err.message);
        return false;
    }
}

async function setFriendStatus(deviceId, publicCode, isFriendVal) {
    if (!pool) return false;
    try {
        await pool.query(
            `UPDATE agent_card_holder SET is_friend = $3 WHERE device_id = $1 AND public_code = $2`,
            [deviceId, publicCode, isFriendVal]
        );
        return true;
    } catch (err) {
        console.error('[DB] Failed to set friend status:', err.message);
        return false;
    }
}

// ── Friend Requests ──

async function createFriendRequest(fromDeviceId, fromPublicCode, toPublicCode, toDeviceId, message) {
    if (!pool) return null;
    try {
        const result = await pool.query(
            `INSERT INTO friend_requests (from_device_id, from_public_code, to_public_code, to_device_id, status, message, created_at)
             VALUES ($1, $2, $3, $4, 'pending', $5, $6)
             ON CONFLICT (from_device_id, to_public_code) DO UPDATE SET
                status = 'pending', message = EXCLUDED.message, created_at = EXCLUDED.created_at, responded_at = NULL
             RETURNING id, from_device_id AS "fromDeviceId", from_public_code AS "fromPublicCode",
                to_public_code AS "toPublicCode", to_device_id AS "toDeviceId",
                status, message, created_at AS "createdAt"`,
            [fromDeviceId, fromPublicCode, toPublicCode, toDeviceId, message || null, Date.now()]
        );
        return result.rows[0] || null;
    } catch (err) {
        if (err.code === '23505') return null; // duplicate
        console.error('[DB] Failed to create friend request:', err.message);
        return null;
    }
}

async function getFriendRequests(deviceId, direction, status) {
    if (!pool) return [];
    try {
        let sql, params;
        if (direction === 'received') {
            sql = `SELECT id, from_device_id AS "fromDeviceId", from_public_code AS "fromPublicCode",
                    to_public_code AS "toPublicCode", to_device_id AS "toDeviceId",
                    status, message, created_at AS "createdAt", responded_at AS "respondedAt"
                   FROM friend_requests WHERE to_device_id = $1`;
            params = [deviceId];
        } else {
            sql = `SELECT id, from_device_id AS "fromDeviceId", from_public_code AS "fromPublicCode",
                    to_public_code AS "toPublicCode", to_device_id AS "toDeviceId",
                    status, message, created_at AS "createdAt", responded_at AS "respondedAt"
                   FROM friend_requests WHERE from_device_id = $1`;
            params = [deviceId];
        }
        if (status) {
            sql += ` AND status = $2`;
            params.push(status);
        }
        sql += ` ORDER BY created_at DESC LIMIT 100`;
        const result = await pool.query(sql, params);
        return result.rows;
    } catch (err) {
        console.error('[DB] Failed to get friend requests:', err.message);
        return [];
    }
}

async function getFriendRequestById(requestId) {
    if (!pool) return null;
    try {
        const result = await pool.query(
            `SELECT id, from_device_id AS "fromDeviceId", from_public_code AS "fromPublicCode",
                    to_public_code AS "toPublicCode", to_device_id AS "toDeviceId",
                    status, message, created_at AS "createdAt", responded_at AS "respondedAt"
             FROM friend_requests WHERE id = $1`,
            [requestId]
        );
        return result.rows[0] || null;
    } catch (err) {
        console.error('[DB] Failed to get friend request:', err.message);
        return null;
    }
}

async function updateFriendRequestStatus(requestId, newStatus) {
    if (!pool) return null;
    try {
        const result = await pool.query(
            `UPDATE friend_requests SET status = $2, responded_at = $3 WHERE id = $1
             RETURNING id, from_device_id AS "fromDeviceId", from_public_code AS "fromPublicCode",
                to_public_code AS "toPublicCode", to_device_id AS "toDeviceId",
                status, message, created_at AS "createdAt", responded_at AS "respondedAt"`,
            [requestId, newStatus, Date.now()]
        );
        return result.rows[0] || null;
    } catch (err) {
        console.error('[DB] Failed to update friend request:', err.message);
        return null;
    }
}

async function deleteFriendRequest(requestId) {
    if (!pool) return false;
    try {
        await pool.query(`DELETE FROM friend_requests WHERE id = $1`, [requestId]);
        return true;
    } catch (err) {
        console.error('[DB] Failed to delete friend request:', err.message);
        return false;
    }
}

async function getFriends(deviceId) {
    if (!pool) return [];
    try {
        const result = await pool.query(
            `SELECT public_code AS "publicCode", contact_name AS name, contact_character AS character,
                    contact_avatar AS avatar, added_at AS "addedAt", card_snapshot AS "cardSnapshot",
                    exchange_type AS "exchangeType", last_refreshed AS "lastRefreshed",
                    notes, pinned, category, interaction_count AS "interactionCount",
                    blocked, last_interacted_at AS "lastInteractedAt",
                    is_friend AS "isFriend"
             FROM agent_card_holder WHERE device_id = $1 AND is_friend = true
             AND (blocked = false OR blocked IS NULL)
             ORDER BY last_interacted_at DESC NULLS LAST, contact_name ASC`,
            [deviceId]
        );
        return result.rows;
    } catch (err) {
        console.error('[DB] Failed to get friends:', err.message);
        return [];
    }
}

async function getPendingFriendRequestCount(deviceId) {
    if (!pool) return 0;
    try {
        const result = await pool.query(
            `SELECT COUNT(*) AS count FROM friend_requests WHERE to_device_id = $1 AND status = 'pending'`,
            [deviceId]
        );
        return parseInt(result.rows[0].count);
    } catch (err) {
        console.error('[DB] Failed to count pending friend requests:', err.message);
        return 0;
    }
}

// Legacy aliases for backward compatibility during migration
const getContacts = async (deviceId) => getCardHolder(deviceId);
const addContact = async (deviceId, publicCode, name, character, avatar) =>
    addCard(deviceId, publicCode, { name, character, avatar, exchangeType: 'manual' });
const removeContact = async (deviceId, publicCode) => removeCard(deviceId, publicCode);
const getContactCount = async (deviceId) => getCardCount(deviceId);

// Close database connection
async function closeDatabase() {
    if (pool) {
        await pool.end();
        console.log('[DB] PostgreSQL connection closed');
    }
}

// ============================================
// Device Vars (Encrypted Vault)
// ============================================

async function upsertDeviceVars(deviceId, encryptedVars, iv, authTag, varKeys, isLocked, varSources = {}) {
    if (!pool) return false;
    try {
        await pool.query(
            `INSERT INTO device_vars (device_id, encrypted_vars, iv, auth_tag, var_keys, var_sources, is_locked, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (device_id)
             DO UPDATE SET encrypted_vars = $2, iv = $3, auth_tag = $4, var_keys = $5, var_sources = $6, is_locked = $7, updated_at = $8`,
            [deviceId, encryptedVars, iv, authTag, varKeys, JSON.stringify(varSources), isLocked, Date.now()]
        );
        return true;
    } catch (err) {
        console.error(`[DB] Failed to upsert device_vars for ${deviceId}:`, err.message);
        return false;
    }
}

async function getDeviceVars(deviceId) {
    if (!pool) return null;
    try {
        const result = await pool.query(
            'SELECT encrypted_vars, iv, auth_tag, var_keys, var_sources, is_locked, updated_at FROM device_vars WHERE device_id = $1',
            [deviceId]
        );
        return result.rows[0] || null;
    } catch (err) {
        console.error(`[DB] Failed to get device_vars for ${deviceId}:`, err.message);
        return null;
    }
}

async function getDeviceVarsMeta(deviceId) {
    if (!pool) return null;
    try {
        const result = await pool.query(
            'SELECT var_keys, is_locked FROM device_vars WHERE device_id = $1',
            [deviceId]
        );
        return result.rows[0] || null;
    } catch (err) {
        console.error(`[DB] Failed to get device_vars meta for ${deviceId}:`, err.message);
        return null;
    }
}

async function deleteDeviceVars(deviceId) {
    if (!pool) return false;
    try {
        await pool.query('DELETE FROM device_vars WHERE device_id = $1', [deviceId]);
        return true;
    } catch (err) {
        console.error(`[DB] Failed to delete device_vars for ${deviceId}:`, err.message);
        return false;
    }
}

// device_vars_audit — one row per mutation. Never stores the value.
// action ∈ { 'replace', 'merge', 'delete_one', 'wipe', 'refuse_wipe', 'refuse_delete' }
// key_name: the specific key for single-key ops, null for bulk/wipe/refuse
async function logDeviceVarsAudit({ deviceId, action, keyName = null, source = null, callerIp = null, callerUa = null, beforeCount = null, afterCount = null }) {
    if (!pool) return false;
    try {
        await pool.query(
            `INSERT INTO device_vars_audit
               (device_id, action, key_name, source, caller_ip, caller_ua, before_count, after_count)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [deviceId, action, keyName, source, callerIp, callerUa, beforeCount, afterCount]
        );
        return true;
    } catch (err) {
        // Audit failure must never break the main request.
        console.error(`[DB] Failed to log device_vars_audit for ${deviceId}:`, err.message);
        return false;
    }
}

async function getDeviceVarsAudit(deviceId, { since = null, limit = 200 } = {}) {
    if (!pool) return [];
    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 0, 1), 500);
    try {
        let rows;
        if (since) {
            const r = await pool.query(
                `SELECT id, action, key_name, source, caller_ip, caller_ua, before_count, after_count, created_at
                 FROM device_vars_audit
                 WHERE device_id = $1 AND created_at >= $2
                 ORDER BY created_at DESC
                 LIMIT $3`,
                [deviceId, since, safeLimit]
            );
            rows = r.rows;
        } else {
            const r = await pool.query(
                `SELECT id, action, key_name, source, caller_ip, caller_ua, before_count, after_count, created_at
                 FROM device_vars_audit
                 WHERE device_id = $1
                 ORDER BY created_at DESC
                 LIMIT $2`,
                [deviceId, safeLimit]
            );
            rows = r.rows;
        }
        return rows;
    } catch (err) {
        console.error(`[DB] Failed to query device_vars_audit for ${deviceId}:`, err.message);
        return [];
    }
}

// ============================================
// Channel Accounts (OpenClaw Channel Plugin)
// ============================================

async function createChannelAccount(deviceId, apiKey, apiSecret) {
    if (!pool) return null;
    try {
        const result = await pool.query(
            `INSERT INTO channel_accounts (device_id, channel_api_key, channel_api_secret, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $4)
             RETURNING *`,
            [deviceId, apiKey, apiSecret, Date.now()]
        );
        return result.rows[0] || null;
    } catch (err) {
        console.error(`[DB] Failed to create channel account for ${deviceId}:`, err.message);
        return null;
    }
}

async function getChannelAccountById(id) {
    if (!pool) return null;
    try {
        const result = await pool.query(
            'SELECT * FROM channel_accounts WHERE id = $1',
            [id]
        );
        return result.rows[0] || null;
    } catch (err) {
        console.error('[DB] Failed to get channel account by id:', err.message);
        return null;
    }
}

async function getChannelAccountsByDevice(deviceId) {
    if (!pool) return [];
    try {
        const result = await pool.query(
            'SELECT * FROM channel_accounts WHERE device_id = $1 ORDER BY created_at ASC',
            [deviceId]
        );
        return result.rows;
    } catch (err) {
        console.error('[DB] Failed to get channel accounts by device:', err.message);
        return [];
    }
}

async function getChannelAccountByKey(apiKey) {
    if (!pool) return null;
    try {
        const result = await pool.query(
            'SELECT * FROM channel_accounts WHERE channel_api_key = $1 AND status = $2',
            [apiKey, 'active']
        );
        return result.rows[0] || null;
    } catch (err) {
        console.error('[DB] Failed to get channel account:', err.message);
        return null;
    }
}

async function getChannelAccountByDevice(deviceId) {
    if (!pool) return null;
    try {
        const result = await pool.query(
            'SELECT * FROM channel_accounts WHERE device_id = $1',
            [deviceId]
        );
        return result.rows[0] || null;
    } catch (err) {
        console.error('[DB] Failed to get channel account by device:', err.message);
        return null;
    }
}

async function updateChannelCallback(apiKey, callbackUrl, callbackToken, callbackUsername, callbackPassword) {
    if (!pool) return false;
    try {
        await pool.query(
            `UPDATE channel_accounts SET callback_url = $1, callback_token = $2, callback_username = $3, callback_password = $4, updated_at = $5
             WHERE channel_api_key = $6`,
            [callbackUrl, callbackToken, callbackUsername || null, callbackPassword || null, Date.now(), apiKey]
        );
        return true;
    } catch (err) {
        console.error('[DB] Failed to update channel callback:', err.message);
        return false;
    }
}

// E2EE awareness (Issue #212): update channel encryption capability flag
async function updateChannelE2eeCapable(accountId, e2eeCapable) {
    if (!pool) return false;
    try {
        await pool.query(
            `UPDATE channel_accounts SET e2ee_capable = $1, updated_at = $2 WHERE id = $3`,
            [e2eeCapable, Date.now(), accountId]
        );
        return true;
    } catch (err) {
        console.error('[DB] Failed to update channel e2ee_capable:', err.message);
        return false;
    }
}

async function deleteChannelAccount(id) {
    if (!pool) return false;
    try {
        await pool.query('DELETE FROM channel_accounts WHERE id = $1', [id]);
        return true;
    } catch (err) {
        console.error(`[DB] Failed to delete channel account ${id}:`, err.message);
        return false;
    }
}

async function clearChannelCallback(apiKey) {
    if (!pool) return false;
    try {
        await pool.query(
            `UPDATE channel_accounts SET callback_url = NULL, callback_token = NULL, callback_username = NULL, callback_password = NULL, updated_at = $1
             WHERE channel_api_key = $2`,
            [Date.now(), apiKey]
        );
        return true;
    } catch (err) {
        console.error('[DB] Failed to clear channel callback:', err.message);
        return false;
    }
}

// --- Skill Contributions ---
async function insertSkillContribution(entry) {
    await pool.query(
        `INSERT INTO skill_contributions
         (pending_id, skill_id, label, icon, title, url, author, required_vars, steps, submitted_by, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'verifying')`,
        [entry.pendingId, entry.id, entry.label, entry.icon, entry.title,
         entry.url, entry.author, JSON.stringify(entry.requiredVars || []),
         entry.steps, JSON.stringify(entry.submittedBy)]
    );
}

async function updateSkillContribution(pendingId, updates) {
    const sets = [];
    const vals = [];
    let i = 1;
    if (updates.status)              { sets.push(`status=$${i++}`);              vals.push(updates.status); }
    if (updates.verifiedAt)          { sets.push(`verified_at=$${i++}`);         vals.push(updates.verifiedAt); }
    if (updates.verificationResult)  { sets.push(`verification_result=$${i++}`); vals.push(JSON.stringify(updates.verificationResult)); }
    if (updates.rejectedReason)      { sets.push(`rejected_reason=$${i++}`);     vals.push(updates.rejectedReason); }
    vals.push(pendingId);
    await pool.query(`UPDATE skill_contributions SET ${sets.join(',')} WHERE pending_id=$${i}`, vals);
}

async function getSkillContributions() {
    const result = await pool.query(
        `SELECT * FROM skill_contributions ORDER BY submitted_at DESC`
    );
    return result.rows;
}

async function getSkillContributionByPendingId(pendingId) {
    const result = await pool.query(
        `SELECT * FROM skill_contributions WHERE pending_id=$1 LIMIT 1`,
        [pendingId]
    );
    return result.rows[0] || null;
}

async function getApprovedSkillContributions() {
    const result = await pool.query(
        `SELECT * FROM skill_contributions WHERE status='approved' ORDER BY verified_at ASC`
    );
    return result.rows;
}

// --- Soul Contributions ---
async function insertSoulContribution(entry) {
    await pool.query(
        `INSERT INTO soul_contributions
         (pending_id, soul_id, label, icon, name, description, author, submitted_by, status, verified_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'approved',NOW())`,
        [entry.pendingId, entry.id, entry.label, entry.icon,
         entry.name, entry.description, entry.author,
         JSON.stringify(entry.submittedBy)]
    );
}

async function getSoulContributions() {
    const result = await pool.query(
        `SELECT * FROM soul_contributions ORDER BY submitted_at DESC`
    );
    return result.rows;
}

async function getApprovedSoulContributions() {
    const result = await pool.query(
        `SELECT * FROM soul_contributions WHERE status='approved' ORDER BY verified_at ASC`
    );
    return result.rows;
}

// --- Rule Contributions ---
async function insertRuleContribution(entry) {
    await pool.query(
        `INSERT INTO rule_contributions
         (pending_id, rule_id, label, icon, rule_type, name, description, author, submitted_by, status, verified_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'approved',NOW())`,
        [entry.pendingId, entry.id, entry.label, entry.icon,
         entry.ruleType, entry.name, entry.description, entry.author,
         JSON.stringify(entry.submittedBy)]
    );
}

async function getRuleContributions() {
    const result = await pool.query(
        `SELECT * FROM rule_contributions ORDER BY submitted_at DESC`
    );
    return result.rows;
}

async function getApprovedRuleContributions() {
    const result = await pool.query(
        `SELECT * FROM rule_contributions WHERE status='approved' ORDER BY verified_at ASC`
    );
    return result.rows;
}

// ── Entity Trash (soft-delete recovery) ──────────────────────────────────

async function saveEntityToTrash(deviceId, entityId, entityData) {
    if (!pool) return;
    await pool.query(
        `INSERT INTO entity_trash (device_id, entity_id, character, name, state, message, webhook, bot_secret, public_code, xp, avatar, agent_card, identity, encryption_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [deviceId, entityId,
         entityData.character || null,
         entityData.name || null,
         entityData.state || null,
         entityData.message || null,
         entityData.webhook ? JSON.stringify(entityData.webhook) : null,
         entityData.botSecret || null,
         entityData.publicCode || null,
         entityData.xp || 0,
         entityData.avatar || null,
         entityData.agentCard ? JSON.stringify(entityData.agentCard) : null,
         entityData.identity ? JSON.stringify(entityData.identity) : null,
         entityData.encryptionStatus || null]
    );
}

async function getEntityTrash(deviceId) {
    if (!pool) return [];
    const result = await pool.query(
        `SELECT * FROM entity_trash WHERE device_id = $1 AND expires_at > NOW() ORDER BY deleted_at DESC`,
        [deviceId]
    );
    return result.rows;
}

async function getEntityTrashItem(trashId) {
    if (!pool) return null;
    const result = await pool.query(
        `SELECT * FROM entity_trash WHERE id = $1 AND expires_at > NOW()`,
        [trashId]
    );
    return result.rows[0] || null;
}

async function deleteEntityTrashItem(trashId) {
    if (!pool) return;
    await pool.query(`DELETE FROM entity_trash WHERE id = $1`, [trashId]);
}

async function cleanupExpiredTrash() {
    if (!pool) return 0;
    const result = await pool.query(`DELETE FROM entity_trash WHERE expires_at <= NOW()`);
    return result.rowCount;
}

// ── Pending Cross-Device Messages ──────────────────────────────────

async function savePendingCrossMessage(senderDeviceId, senderEntityId, targetCode, text, mediaType, mediaUrl) {
    if (!pool) return null;
    try {
        const result = await pool.query(
            `INSERT INTO pending_cross_messages (sender_device_id, sender_entity_id, target_code, text, media_type, media_url, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
            [senderDeviceId, senderEntityId, targetCode, text, mediaType || null, mediaUrl || null, Date.now()]
        );
        return result.rows[0].id;
    } catch (err) {
        console.error('[DB] Failed to save pending cross message:', err.message);
        return null;
    }
}

async function getPendingCrossMessages(senderDeviceId) {
    if (!pool) return [];
    try {
        const result = await pool.query(
            `SELECT * FROM pending_cross_messages WHERE sender_device_id = $1 ORDER BY created_at ASC`,
            [senderDeviceId]
        );
        return result.rows;
    } catch (err) {
        console.error('[DB] Failed to get pending cross messages:', err.message);
        return [];
    }
}

async function deletePendingCrossMessages(senderDeviceId) {
    if (!pool) return 0;
    try {
        const result = await pool.query(
            `DELETE FROM pending_cross_messages WHERE sender_device_id = $1`,
            [senderDeviceId]
        );
        return result.rowCount;
    } catch (err) {
        console.error('[DB] Failed to delete pending cross messages:', err.message);
        return 0;
    }
}

async function cleanupExpiredPendingMessages(cutoffTimestamp) {
    if (!pool) return 0;
    try {
        const result = await pool.query(
            `DELETE FROM pending_cross_messages WHERE created_at < $1`,
            [cutoffTimestamp]
        );
        if (result.rowCount > 0) {
            console.log(`[DB] Cleaned up ${result.rowCount} expired pending cross messages`);
        }
        return result.rowCount;
    } catch (err) {
        console.error('[DB] Failed to cleanup pending messages:', err.message);
        return 0;
    }
}

// ── Bot Plaza: Community functions ──

async function setEntityPublic(deviceId, entityId, isPublic) {
    try {
        const now = isPublic ? new Date().toISOString() : null;
        const result = await pool.query(
            `UPDATE entities SET is_public = $1, published_at = CASE WHEN $1 THEN COALESCE(published_at, $2::timestamptz) ELSE published_at END
             WHERE device_id = $3 AND entity_id = $4`,
            [isPublic, now, deviceId, entityId]
        );
        // If entity row doesn't exist yet, INSERT it (saveDeviceData may not have run)
        if (result.rowCount === 0) {
            console.warn(`[DB] setEntityPublic: entity ${deviceId}:${entityId} not in DB yet, inserting`);
            await pool.query(
                `INSERT INTO entities (device_id, entity_id, is_public, published_at, is_bound)
                 VALUES ($1, $2, $3, $4, true)
                 ON CONFLICT (device_id, entity_id) DO UPDATE SET is_public = $3, published_at = COALESCE(EXCLUDED.published_at, entities.published_at)`,
                [deviceId, entityId, isPublic, now]
            );
        }
        return true;
    } catch (err) {
        console.error('[DB] setEntityPublic error:', err.message);
        return false;
    }
}

// Extract Arena interview fields from the entity's identity JSONB blob.
// Returns nulls when no interview has been recorded — UI uses these to
// render the "尚未面試 / No interview yet" placeholder + ? icon UX.
function extractArenaFieldsFromIdentity(identity) {
    if (!identity || typeof identity !== 'object') {
        return { arenaScore: null, arenaMaxScore: null, arenaNormalized: null, arenaPassed: null, lastInterviewAt: null };
    }
    const ic = identity.interviewCapabilities;
    if (!ic || typeof ic !== 'object') {
        return { arenaScore: null, arenaMaxScore: null, arenaNormalized: null, arenaPassed: null, lastInterviewAt: identity.lastInterviewAt || null };
    }
    const score = Number.isFinite(Number(ic.score)) ? Number(ic.score) : null;
    const max = Number.isFinite(Number(ic.maxScore)) ? Number(ic.maxScore) : null;
    const normalized = Number.isFinite(Number(ic.normalized)) ? Number(ic.normalized) : null;
    const passed = typeof ic.passed === 'boolean' ? ic.passed : null;
    const completedAt = Number.isFinite(Number(ic.completedAt)) ? Number(ic.completedAt) : null;
    return {
        arenaScore: score,
        arenaMaxScore: max,
        arenaNormalized: normalized,
        arenaPassed: passed,
        lastInterviewAt: completedAt || identity.lastInterviewAt || null,
    };
}

async function searchPublicCards({ q, tag, capability, minArenaScore, limit = 20, offset = 0, sort = 'newest' }) {
    try {
        const conditions = [`e.is_public = true`, `e.bot_secret IS NOT NULL`];
        const params = [];
        let paramIdx = 1;

        if (q) {
            conditions.push(`(e.name ILIKE $${paramIdx} OR e.agent_card->>'description' ILIKE $${paramIdx})`);
            params.push(`%${q}%`);
            paramIdx++;
        }
        if (tag) {
            conditions.push(`e.agent_card->'tags' ? $${paramIdx}`);
            params.push(tag);
            paramIdx++;
        }
        if (capability) {
            conditions.push(`EXISTS (SELECT 1 FROM jsonb_array_elements(e.agent_card->'capabilities') cap WHERE cap->>'id' ILIKE $${paramIdx} OR cap->>'name' ILIKE $${paramIdx})`);
            params.push(`%${capability}%`);
            paramIdx++;
        }
        // minArenaScore: 0–100 normalized percentage. Read from
        // identity.interviewCapabilities.normalized. Filters out
        // entities with no recorded interview.
        const minScoreNum = parseInt(minArenaScore, 10);
        if (Number.isFinite(minScoreNum) && minScoreNum > 0 && minScoreNum <= 100) {
            conditions.push(`((e.identity->'interviewCapabilities'->>'normalized')::int >= $${paramIdx})`);
            params.push(minScoreNum);
            paramIdx++;
        }

        let orderBy;
        if (sort === 'rating') {
            orderBy = 'e.avg_rating DESC, e.rating_count DESC';
        } else if (sort === 'arena_score') {
            // Sort highest-scoring entities first; entities with no recorded
            // interview (NULL normalized) sort last via NULLS LAST.
            orderBy = `(e.identity->'interviewCapabilities'->>'normalized')::int DESC NULLS LAST, e.published_at DESC NULLS LAST`;
        } else {
            orderBy = 'e.published_at DESC NULLS LAST';
        }
        const safeLimit = Math.min(Math.max(parseInt(limit) || 20, 1), 50);
        const safeOffset = Math.max(parseInt(offset) || 0, 0);

        params.push(safeLimit, safeOffset);
        // LEFT JOIN LATERAL surfaces the owner's currently selected
        // companion avatar (PETDX dressing system). Without it, the
        // plaza shows e.avatar — the static emoji/upload set on first
        // bind — even after the owner picked a sprite companion.
        const sql = `
            SELECT e.public_code, e.name, e.character, e.avatar, e.agent_card, e.identity,
                   e.avg_rating, e.rating_count, e.community_message_count,
                   e.published_at, e.level, e.xp,
                   petdx.avatar_url AS petdx_avatar_url
            FROM entities e
            LEFT JOIN LATERAL (
                SELECT c.avatar_url
                FROM companion_select_log s
                LEFT JOIN companions c ON c.id = s.companion_id
                WHERE s.device_id = e.device_id
                  AND s.entity_id IS NOT DISTINCT FROM e.entity_id
                ORDER BY s.selected_at DESC
                LIMIT 1
            ) petdx ON true
            WHERE ${conditions.join(' AND ')}
            ORDER BY ${orderBy}
            LIMIT $${paramIdx} OFFSET $${paramIdx + 1}
        `;

        const result = await pool.query(sql, params);
        return result.rows.map(r => {
            const arena = extractArenaFieldsFromIdentity(r.identity);
            return {
                publicCode: r.public_code,
                name: r.name,
                character: r.character,
                avatar: r.avatar,
                petdxAvatarUrl: r.petdx_avatar_url || null,
                description: r.agent_card?.description || null,
                capabilities: r.agent_card?.capabilities || [],
                tags: r.agent_card?.tags || [],
                avgRating: parseFloat(r.avg_rating) || 0,
                ratingCount: parseInt(r.rating_count) || 0,
                messageCount: parseInt(r.community_message_count) || 0,
                publishedAt: r.published_at,
                level: r.level || 1,
                xp: r.xp || 0,
                ...arena,
            };
        });
    } catch (err) {
        console.error('[DB] searchPublicCards error:', err.message);
        return [];
    }
}

async function getPublicCardDetail(publicCode) {
    try {
        const result = await pool.query(
            `SELECT e.public_code, e.name, e.character, e.avatar, e.agent_card, e.identity,
                    e.avg_rating, e.rating_count, e.community_message_count,
                    e.published_at, e.level, e.xp, e.state,
                    petdx.avatar_url AS petdx_avatar_url
             FROM entities e
             LEFT JOIN LATERAL (
                 SELECT c.avatar_url
                 FROM companion_select_log s
                 LEFT JOIN companions c ON c.id = s.companion_id
                 WHERE s.device_id = e.device_id
                   AND s.entity_id IS NOT DISTINCT FROM e.entity_id
                 ORDER BY s.selected_at DESC
                 LIMIT 1
             ) petdx ON true
             WHERE e.public_code = $1 AND e.is_public = true`,
            [publicCode]
        );
        if (result.rows.length === 0) return null;
        const r = result.rows[0];
        const arena = extractArenaFieldsFromIdentity(r.identity);
        return {
            publicCode: r.public_code,
            name: r.name,
            character: r.character,
            avatar: r.avatar,
            petdxAvatarUrl: r.petdx_avatar_url || null,
            agentCard: r.agent_card || null,
            avgRating: parseFloat(r.avg_rating) || 0,
            ratingCount: parseInt(r.rating_count) || 0,
            messageCount: parseInt(r.community_message_count) || 0,
            publishedAt: r.published_at,
            level: r.level || 1,
            xp: r.xp || 0,
            state: r.state || 'IDLE',
            ...arena,
        };
    } catch (err) {
        console.error('[DB] getPublicCardDetail error:', err.message);
        return null;
    }
}

async function getCommunityMessages(publicCode, limit = 50, offset = 0) {
    try {
        const result = await pool.query(
            `SELECT id, card_public_code, author_type, author_id, author_name, text, reply_to, created_at
             FROM community_messages
             WHERE card_public_code = $1
             ORDER BY created_at DESC
             LIMIT $2 OFFSET $3`,
            [publicCode, Math.min(limit, 100), Math.max(offset, 0)]
        );
        return result.rows;
    } catch (err) {
        console.error('[DB] getCommunityMessages error:', err.message);
        return [];
    }
}

async function addCommunityMessage(publicCode, authorType, authorId, authorName, text, replyTo) {
    try {
        const result = await pool.query(
            `INSERT INTO community_messages (card_public_code, author_type, author_id, author_name, text, reply_to)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
            [publicCode, authorType, authorId, authorName, text, replyTo || null]
        );
        // Increment message count on entity
        await pool.query(
            `UPDATE entities SET community_message_count = community_message_count + 1
             WHERE public_code = $1`,
            [publicCode]
        );
        return result.rows[0];
    } catch (err) {
        console.error('[DB] addCommunityMessage error:', err.message);
        return null;
    }
}

async function getCommunityStats(poolArg) {
    const p = poolArg || pool;
    try {
        const [totals, categories] = await Promise.all([
            p.query(
                `WITH public_set AS (
                   SELECT public_code, published_at FROM entities
                   WHERE is_public = true AND bot_secret IS NOT NULL
                 )
                 SELECT
                   (SELECT COUNT(*)::int FROM public_set) AS total_bots,
                   (SELECT COUNT(*)::int FROM public_set
                    WHERE published_at >= ((NOW() AT TIME ZONE 'Asia/Taipei')::date::timestamp) AT TIME ZONE 'Asia/Taipei'
                   ) AS new_today,
                   (SELECT COUNT(DISTINCT p.public_code)::int FROM public_set p
                    WHERE EXISTS (
                      SELECT 1 FROM community_messages m
                      WHERE m.card_public_code = p.public_code
                        AND m.created_at >= NOW() - INTERVAL '7 days'
                    ) OR EXISTS (
                      SELECT 1 FROM community_ratings r
                      WHERE r.card_public_code = p.public_code
                        AND r.updated_at >= NOW() - INTERVAL '7 days'
                    )
                   ) AS active_7d`
            ),
            p.query(
                `SELECT tag, COUNT(*)::int AS count
                 FROM entities e,
                      jsonb_array_elements_text(COALESCE(e.agent_card->'tags','[]'::jsonb)) AS tag
                 WHERE e.is_public = true AND e.bot_secret IS NOT NULL
                 GROUP BY tag
                 ORDER BY count DESC
                 LIMIT 5`
            ),
        ]);
        const row = totals.rows[0] || {};
        return {
            total_bots: row.total_bots || 0,
            new_today: row.new_today || 0,
            active_7d: row.active_7d || 0,
            top_categories: categories.rows.map(r => ({ tag: r.tag, count: r.count })),
        };
    } catch (err) {
        console.error('[DB] getCommunityStats error:', err.message);
        return { total_bots: 0, new_today: 0, active_7d: 0, top_categories: [], error: 'query_failed' };
    }
}

async function logInviteClick({ code, ipHash, userAgent, referer, source }, poolArg) {
    const p = poolArg || pool;
    if (!p) return false;
    try {
        await p.query(
            `INSERT INTO invite_clicks (code, ip_hash, user_agent, referer, source)
             VALUES ($1, $2, $3, $4, $5)`,
            [code, ipHash || null, userAgent || null, referer || null, source || 'direct']
        );
        return true;
    } catch (err) {
        console.error('[DB] logInviteClick error:', err.message);
        return false;
    }
}

async function getInviteClickStats(poolArg) {
    const p = poolArg || pool;
    try {
        const r = await p.query(
            `SELECT c.code,
                    COUNT(*)::int AS clicks,
                    COUNT(DISTINCT c.ip_hash)::int AS unique_clicks,
                    MAX(c.clicked_at) AS last_clicked_at,
                    (SELECT used_by_device_id FROM invite_codes WHERE code = c.code) IS NOT NULL AS redeemed
             FROM invite_clicks c
             GROUP BY c.code
             ORDER BY last_clicked_at DESC
             LIMIT 100`
        );
        return r.rows.map(row => ({
            code: row.code,
            clicks: row.clicks,
            unique_clicks: row.unique_clicks,
            last_clicked_at: row.last_clicked_at,
            redeemed: row.redeemed === true,
        }));
    } catch (err) {
        console.error('[DB] getInviteClickStats error:', err.message);
        return [];
    }
}

async function getInviteClickStatsForOwner(ownerDeviceId, poolArg) {
    const p = poolArg || pool;
    try {
        const r = await p.query(
            `SELECT ic.code,
                    ic.created_at,
                    ic.used_by_device_id,
                    ic.used_at,
                    COALESCE(click_agg.clicks, 0)::int AS clicks,
                    COALESCE(click_agg.unique_clicks, 0)::int AS unique_clicks,
                    click_agg.last_clicked_at
             FROM invite_codes ic
             LEFT JOIN (
                 SELECT code,
                        COUNT(*)::int AS clicks,
                        COUNT(DISTINCT ip_hash)::int AS unique_clicks,
                        MAX(clicked_at) AS last_clicked_at
                 FROM invite_clicks
                 GROUP BY code
             ) click_agg ON click_agg.code = ic.code
             WHERE ic.owner_device_id = $1
             ORDER BY ic.created_at ASC`,
            [ownerDeviceId]
        );
        return r.rows.map(row => ({
            code: row.code,
            clicks: row.clicks,
            unique_clicks: row.unique_clicks,
            last_clicked_at: row.last_clicked_at,
            redeemed: row.used_by_device_id != null,
            redeemed_at: row.used_at,
            created_at: row.created_at,
        }));
    } catch (err) {
        console.error('[DB] getInviteClickStatsForOwner error:', err.message);
        return [];
    }
}

async function upsertCommunityRating(publicCode, deviceId, stars) {
    try {
        await pool.query(
            `INSERT INTO community_ratings (card_public_code, device_id, stars)
             VALUES ($1, $2, $3)
             ON CONFLICT (card_public_code, device_id)
             DO UPDATE SET stars = $3, updated_at = NOW()`,
            [publicCode, deviceId, stars]
        );
        // Recalculate average
        const result = await pool.query(
            `SELECT AVG(stars)::numeric(2,1) AS avg, COUNT(*)::integer AS cnt
             FROM community_ratings WHERE card_public_code = $1`,
            [publicCode]
        );
        const avg = parseFloat(result.rows[0].avg) || 0;
        const cnt = parseInt(result.rows[0].cnt) || 0;
        await pool.query(
            `UPDATE entities SET avg_rating = $1, rating_count = $2 WHERE public_code = $3`,
            [avg, cnt, publicCode]
        );
        return { avgRating: avg, ratingCount: cnt };
    } catch (err) {
        console.error('[DB] upsertCommunityRating error:', err.message);
        return null;
    }
}

module.exports = {
    initDatabase,
    saveDeviceData,
    saveAllDevices,
    loadAllDevices,
    deleteDevice,
    deleteEntity,
    getStats,
    closeDatabase,
    // Official bot pool
    saveOfficialBot,
    loadOfficialBots,
    deleteOfficialBot,
    saveOfficialBinding,
    removeOfficialBinding,
    getOfficialBinding,
    getDeviceOfficialBindings,
    updateSubscriptionVerified,
    loadAllOfficialBindings,
    getExpiredPersonalBindings,
    // Paid borrow slots
    getPaidBorrowSlots,
    incrementPaidBorrowSlots,
    // Feedback
    saveFeedback,
    // Agent Card Holder (replaces cross-device contacts)
    getCardHolder,
    addCard,
    updateCard,
    refreshCardSnapshot,
    searchCards,
    getCardByCode,
    removeCard,
    getCardCount,
    incrementInteraction,
    getRecentInteractions,
    upsertRecentInteraction,
    isBlocked,
    isFriend,
    setFriendStatus,
    // Friend Requests
    createFriendRequest,
    getFriendRequests,
    getFriendRequestById,
    updateFriendRequestStatus,
    deleteFriendRequest,
    getFriends,
    getPendingFriendRequestCount,
    // Legacy aliases (backward compat)
    getContacts,
    addContact,
    removeContact,
    getContactCount,
    // Device vars (encrypted vault)
    upsertDeviceVars,
    getDeviceVars,
    getDeviceVarsMeta,
    deleteDeviceVars,
    logDeviceVarsAudit,
    getDeviceVarsAudit,
    // Channel accounts (OpenClaw plugin)
    createChannelAccount,
    getChannelAccountById,
    getChannelAccountsByDevice,
    getChannelAccountByKey,
    getChannelAccountByDevice,
    deleteChannelAccount,
    updateChannelCallback,
    updateChannelE2eeCapable,
    clearChannelCallback,
    // Skill contributions
    insertSkillContribution,
    updateSkillContribution,
    getSkillContributions,
    getSkillContributionByPendingId,
    getApprovedSkillContributions,
    // Soul contributions
    insertSoulContribution,
    getSoulContributions,
    getApprovedSoulContributions,
    // Rule contributions
    insertRuleContribution,
    getRuleContributions,
    getApprovedRuleContributions,
    // Entity trash (soft-delete recovery)
    saveEntityToTrash,
    getEntityTrash,
    getEntityTrashItem,
    deleteEntityTrashItem,
    cleanupExpiredTrash,
    // Pending cross-device messages
    savePendingCrossMessage,
    getPendingCrossMessages,
    deletePendingCrossMessages,
    cleanupExpiredPendingMessages,
    // Debug helper
    _getPool: () => pool,
    _shouldUseSsl: shouldUseSsl,
    // Bot Plaza: Community
    setEntityPublic,
    searchPublicCards,
    getPublicCardDetail,
    extractArenaFieldsFromIdentity,
    getCommunityMessages,
    addCommunityMessage,
    upsertCommunityRating,
    getCommunityStats,
    logInviteClick,
    getInviteClickStats,
    getInviteClickStatsForOwner,
};
