// ============================================
// PostgreSQL Database Module
// Handles data persistence for Claw Backend
// ============================================

const { Pool } = require('pg');

// Database connection pool
let pool = null;

// Initialize database connection
async function initDatabase() {
    try {
        // Railway automatically provides DATABASE_URL environment variable
        // when you add a PostgreSQL service
        const connectionString = process.env.DATABASE_URL;

        if (!connectionString) {
            console.error('[DB] DATABASE_URL not found. PostgreSQL persistence disabled.');
            console.error('[DB] To enable: Add PostgreSQL service in Railway dashboard');
            return false;
        }

        // Create connection pool
        pool = new Pool({
            connectionString: connectionString,
            ssl: process.env.NODE_ENV === 'production' ? {
                rejectUnauthorized: false // Railway uses self-signed certificates
            } : false
        });

        // Test connection
        const client = await pool.connect();
        console.log('[DB] PostgreSQL connection established');
        client.release();

        // Create tables if they don't exist
        await createTables();

        return true;
    } catch (err) {
        console.error('[DB] Failed to initialize database:', err.message);
        return false;
    }
}

// Create database tables
async function createTables() {
    try {
        const client = await pool.connect();

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

        // Add paid_borrow_slots column to devices table (tracks how many personal bots a device has paid for)
        await client.query(`
            ALTER TABLE devices ADD COLUMN IF NOT EXISTS paid_borrow_slots INTEGER DEFAULT 0
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

        // Migration: copy cross_device_contacts → agent_card_holder (idempotent)
        await client.query(`
            INSERT INTO agent_card_holder (device_id, public_code, contact_name, contact_character, contact_avatar, added_at, exchange_type)
            SELECT device_id, contact_public_code, contact_name, contact_character, contact_avatar, added_at, 'manual'
            FROM cross_device_contacts
            ON CONFLICT (device_id, public_code) DO NOTHING
        `);

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
                encryption_status TEXT,
                deleted_at      TIMESTAMPTZ DEFAULT NOW(),
                expires_at      TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '7 days'),
                FOREIGN KEY (device_id) REFERENCES devices(device_id) ON DELETE CASCADE
            )
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_entity_trash_device ON entity_trash(device_id)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_entity_trash_expires ON entity_trash(expires_at)`);

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
                `INSERT INTO devices (device_id, device_secret, created_at, updated_at, next_entity_id)
                 VALUES ($1, $2, $3, $4, $5)
                 ON CONFLICT (device_id)
                 DO UPDATE SET updated_at = $4, next_entity_id = $5`,
                [deviceId, deviceData.deviceSecret, deviceData.createdAt, Date.now(), deviceData.nextEntityId || 1]
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
                    entity.encryptionStatus || null
                ];
                const entitySql = `INSERT INTO entities (
                        device_id, entity_id, bot_secret, is_bound, name,
                        character, state, message, parts,
                        last_updated, message_queue, webhook, app_version,
                        xp, level, avatar, public_code, binding_type, channel_account_id, agent_card,
                        encryption_status
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
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
                        encryption_status = $21`;

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
                encryptionStatus: row.encryption_status || null
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
            `INSERT INTO official_bots (bot_id, bot_type, webhook_url, token, bot_secret, session_key_template, status, assigned_device_id, assigned_entity_id, assigned_at, created_at, setup_username, setup_password)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
             ON CONFLICT (bot_id)
             DO UPDATE SET webhook_url = $3, token = $4, bot_secret = $5, session_key_template = $6, status = $7, assigned_device_id = $8, assigned_entity_id = $9, assigned_at = $10, setup_username = $12, setup_password = $13`,
            [bot.bot_id, bot.bot_type, bot.webhook_url, bot.token, bot.bot_secret || null, bot.session_key_template || null, bot.status || 'available', bot.assigned_device_id || null, bot.assigned_entity_id ?? null, bot.assigned_at || null, bot.created_at || Date.now(), bot.setup_username || null, bot.setup_password || null]
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
                setup_password: row.setup_password || null
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
                    blocked, last_interacted_at AS "lastInteractedAt"
                    FROM agent_card_holder WHERE device_id = $1`;
        const params = [deviceId];
        let idx = 2;
        if (!includeBlocked) { sql += ` AND (blocked = false OR blocked IS NULL)`; }
        if (pinned !== undefined) { sql += ` AND pinned = $${idx++}`; params.push(pinned); }
        if (category) { sql += ` AND category = $${idx++}`; params.push(category); }
        sql += ` ORDER BY pinned DESC, added_at DESC`;
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
            `INSERT INTO agent_card_holder (device_id, public_code, contact_name, contact_character, contact_avatar, added_at, card_snapshot, exchange_type, last_refreshed)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $6)
             ON CONFLICT (device_id, public_code) DO UPDATE SET
                contact_name = EXCLUDED.contact_name,
                contact_character = EXCLUDED.contact_character,
                contact_avatar = EXCLUDED.contact_avatar,
                card_snapshot = COALESCE(EXCLUDED.card_snapshot, agent_card_holder.card_snapshot),
                last_refreshed = EXCLUDED.last_refreshed,
                interaction_count = agent_card_holder.interaction_count + 1
             RETURNING id, public_code AS "publicCode", contact_name AS name, contact_character AS character,
                contact_avatar AS avatar, added_at AS "addedAt", card_snapshot AS "cardSnapshot",
                exchange_type AS "exchangeType", last_refreshed AS "lastRefreshed",
                notes, pinned, category, interaction_count AS "interactionCount",
                blocked, last_interacted_at AS "lastInteractedAt"`,
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
    const allowed = ['notes', 'pinned', 'category', 'blocked'];
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
             RETURNING public_code AS "publicCode", notes, pinned, category, blocked`,
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
                    blocked, last_interacted_at AS "lastInteractedAt"
             FROM agent_card_holder WHERE device_id = $1
             AND (blocked = false OR blocked IS NULL)
             AND (
                 public_code ILIKE $2
                 OR contact_name ILIKE $2
                 OR category ILIKE $2
                 OR notes ILIKE $2
                 OR card_snapshot::text ILIKE $2
             )
             ORDER BY pinned DESC, interaction_count DESC, added_at DESC`,
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
                    blocked, last_interacted_at AS "lastInteractedAt"
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
                    blocked, last_interacted_at AS "lastInteractedAt"
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
             RETURNING public_code AS "publicCode", blocked`,
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
        `INSERT INTO entity_trash (device_id, entity_id, character, name, state, message, webhook, bot_secret, public_code, xp, avatar, agent_card, encryption_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
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
    cleanupExpiredTrash
};
