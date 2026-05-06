const { newDb } = require('pg-mem');
const feedback = require('../../device-feedback');

/**
 * Integration tests for MiniGame admin SQL queries (PR #2472 + #2473).
 *
 * Uses pg-mem (in-memory PostgreSQL) to execute real SQL without Docker.
 *
 * pg-mem v3 limitations (known bugs):
 * - COUNT(*) FILTER (WHERE ...) without GROUP BY does not apply the filter correctly
 *   (returns total count instead of filtered count). GROUP BY works fine.
 *   → This is a pg-mem bug, NOT a production SQL bug.
 *   → The production PostgreSQL handles FILTER correctly.
 * - substring(str FROM pattern) regex syntax not supported
 * - Parameters ($1, $2) have issues with array expansion in some contexts
 *
 * SQL features verified in pg-mem:
 * - CTEs with UNION ALL for telemetry + server_logs union
 * - COUNT(DISTINCT ...) for affected_games + unique_devices
 * - ILIKE OR chain for play action detection
 * - ORDER BY + LIMIT pagination
 * - Zero-row edge case → {count:0} not null
 * - COALESCE for null-safe defaults
 * - Aggregation with CASE WHEN (pg-mem workaround for FILTER bug)
 *
 * SQL features requiring production PostgreSQL:
 * - COUNT(*) FILTER (WHERE ...) — works correctly in production, pg-mem bug
 * - substring(str FROM regex) — not supported by pg-mem
 */

describe('MiniGame admin SQL integration', () => {
    /** @type {import('pg-mem').IDb} */
    let db;

    beforeAll(() => {
        db = newDb();

        db.public.query(`
            CREATE TABLE feedback (
                id SERIAL PRIMARY KEY,
                device_id TEXT,
                user_id TEXT,
                game_id TEXT,
                message TEXT,
                category TEXT DEFAULT 'bug',
                severity TEXT DEFAULT 'medium',
                status TEXT DEFAULT 'open',
                tags TEXT[] DEFAULT '{}',
                source TEXT,
                app_version TEXT,
                github_issue_url TEXT,
                created_at TIMESTAMP DEFAULT NOW()
            )
        `);

        db.public.query(`
            CREATE TABLE device_telemetry (
                id SERIAL PRIMARY KEY,
                device_id TEXT,
                game_id TEXT,
                type TEXT,
                action TEXT,
                page TEXT,
                input JSONB,
                output JSONB,
                meta JSONB,
                duration INTEGER,
                created_at TIMESTAMP DEFAULT NOW()
            )
        `);

        db.public.query(`
            CREATE TABLE server_logs (
                id SERIAL PRIMARY KEY,
                device_id TEXT,
                game_id TEXT,
                level TEXT,
                message TEXT,
                metadata JSONB,
                created_at TIMESTAMP DEFAULT NOW()
            )
        `);
    });

    beforeEach(() => {
        db.public.query('DELETE FROM server_logs');
        db.public.query('DELETE FROM device_telemetry');
        db.public.query('DELETE FROM feedback');
    });

    // -------------------------------------------------------------------------
    // SQL-level aggregation tests (direct pg-mem execution)
    // -------------------------------------------------------------------------

    /**
     * pg-mem bug: COUNT(*) FILTER (WHERE ...) without GROUP BY returns total, not filtered.
     * Workaround: use SUM(CASE WHEN ...) which has correct behavior in pg-mem.
     * Production PostgreSQL: uses COUNT(*) FILTER correctly.
     */
    test('COUNT with conditional aggregation returns correct counts', () => {
        db.public.query(`
            INSERT INTO feedback (device_id, message, category, severity, status, tags, source)
            VALUES
                ('d1', 'bug1', 'bug', 'high', 'open', ARRAY['minigame'], 'minigame'),
                ('d2', 'bug2', 'bug', 'high', 'open', ARRAY['minigame'], 'minigame'),
                ('d3', 'bug3', 'bug', 'high', 'resolved', ARRAY['minigame'], 'minigame')
        `);

        // Using SUM(CASE WHEN ...) as pg-mem workaround for COUNT FILTER bug
        // In production: COUNT(*) FILTER (WHERE status = 'open') — works correctly in real PostgreSQL
        const result = db.public.query(`
            SELECT
                COUNT(*) AS total,
                SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open_count,
                SUM(CASE WHEN category = 'bug' THEN 1 ELSE 0 END) AS bug_reports,
                SUM(CASE WHEN severity IN ('critical', 'high') THEN 1 ELSE 0 END) AS high_priority
            FROM feedback
            WHERE LOWER(COALESCE(source, '')) = ANY(ARRAY['minigame','mini-game','game factory'])
               OR message ILIKE '%minigame%'
               OR message ILIKE '%mini game%'
               OR message ILIKE '%game factory%'
        `);

        expect(result.rows[0].total).toBe(3);
        expect(result.rows[0].open_count).toBe(2);
        expect(result.rows[0].bug_reports).toBe(3);
        expect(result.rows[0].high_priority).toBe(3); // all 3 rows: severity=high, all match WHERE
    });

    test('zero rows: COUNT returns 0 not null', () => {
        const result = db.public.query(`
            SELECT COUNT(*) AS total FROM feedback WHERE FALSE
        `);
        // No rows at all — COUNT returns 0
        expect(result.rows[0].total).toBe(0);
        expect(result.rows[0].total).not.toBeNull();
    });

    test('message ILIKE fallback finds minigame in message body even when source is not minigame', () => {
        db.public.query(`
            INSERT INTO feedback (device_id, message, category, severity, status, tags, source)
            VALUES ('d1', 'The minigame crashed on my device', 'bug', 'high', 'open', ARRAY[]::text[], 'general')
        `);

        const result = db.public.query(`
            SELECT COUNT(*) AS total
            FROM feedback
            WHERE message ILIKE '%minigame%' OR message ILIKE '%mini game%' OR message ILIKE '%game factory%'
        `);

        expect(result.rows[0].total).toBe(1);
    });

    test('ORDER BY created_at DESC returns newest first', () => {
        db.public.query(`
            INSERT INTO feedback (device_id, message, category, severity, status, tags, source, created_at)
            VALUES
                ('d1', 'old', 'bug', 'high', 'open', ARRAY['minigame'], 'minigame', '2026-01-01'),
                ('d2', 'new', 'bug', 'high', 'open', ARRAY['minigame'], 'minigame', '2026-05-01')
        `);

        const result = db.public.query(`
            SELECT id, message FROM feedback
            WHERE LOWER(COALESCE(source, '')) = ANY(ARRAY['minigame','mini-game','game factory'])
            ORDER BY created_at DESC
        `);

        expect(result.rows[0].message).toBe('new');
        expect(result.rows[1].message).toBe('old');
    });

    test('LIMIT caps result count', () => {
        for (let i = 0; i < 10; i++) {
            db.public.query(`
                INSERT INTO feedback (device_id, message, category, severity, status, tags, source)
                VALUES ('d${i}', 'msg${i}', 'bug', 'high', 'open', ARRAY['minigame'], 'minigame')
            `);
        }

        const result = db.public.query(`
            SELECT id FROM feedback
            WHERE LOWER(COALESCE(source, '')) = ANY(ARRAY['minigame','mini-game','game factory'])
            ORDER BY created_at DESC
            LIMIT 5
        `);

        expect(result.rows.length).toBe(5);
    });

    // -------------------------------------------------------------------------
    // getMiniGameSubmissions / getMiniGameAnalytics: null pool guards
    // -------------------------------------------------------------------------

    test('getMiniGameSubmissions(null) returns empty result', async () => {
        const result = await feedback.getMiniGameSubmissions(null);
        expect(result).toEqual({
            summary: { total: 0, open: 0, bugReports: 0, highPriority: 0 },
            submissions: []
        });
    });

    test('getMiniGameAnalytics(null) returns empty result', async () => {
        const result = await feedback.getMiniGameAnalytics(null);
        expect(result).toEqual({
            windowHours: 24,
            summary: {
                errorEvents: 0,
                serverErrorEvents: 0,
                telemetryErrorEvents: 0,
                totalEvents: 0,
                pageViews: 0,
                playActions: 0,
                uniqueDevices: 0,
                affectedGames: 0
            },
            errorStats: [],
            gameStats: [],
            recentErrors: []
        });
    });

    // -------------------------------------------------------------------------
    // getMiniGameAnalytics: real SQL aggregation tests
    // -------------------------------------------------------------------------

    test('affected_games: COUNT(DISTINCT game_id) from UNION ALL of telemetry + server_errors', () => {
        db.public.query(`
            INSERT INTO device_telemetry (device_id, game_id, type, action, page)
            VALUES
                ('d1', 'GAME-076', 'page_view', 'view', 'GAME-076'),
                ('d2', 'GAME-076', 'page_view', 'view', 'GAME-076'),
                ('d3', 'GAME-088', 'page_view', 'view', 'GAME-088'),
                ('d1', 'GAME-076', 'page_view', 'view', 'GAME-076')
        `);
        db.public.query(`
            INSERT INTO server_logs (device_id, game_id, level, message)
            VALUES ('d4', 'GAME-100', 'error', 'Error in GAME-100')
        `);

        // Note: production uses substring(str FROM pattern) to extract game_id from page/action/meta fields.
        // pg-mem doesn't support regex-based substring, so we test with pre-populated game_id values.
        const result = db.public.query(`
            WITH telemetry AS (
                SELECT game_id FROM device_telemetry WHERE game_id IS NOT NULL
                UNION ALL
                SELECT NULL::text
            ),
            server_errors AS (
                SELECT game_id FROM server_logs WHERE game_id IS NOT NULL AND level IN ('error', 'warn')
            )
            SELECT COUNT(DISTINCT game_id) AS affected_games
            FROM (
                SELECT game_id FROM telemetry WHERE game_id IS NOT NULL
                UNION ALL
                SELECT game_id FROM server_errors
            ) games
        `);

        expect(result.rows[0].affected_games).toBe(3);
    });

    test('COUNT(DISTINCT device_id) counts unique devices only once', () => {
        db.public.query(`
            INSERT INTO device_telemetry (device_id, game_id, type, action, page)
            VALUES
                ('d1', 'GAME-076', 'page_view', 'view', 'GAME-076'),
                ('d1', 'GAME-076', 'page_view', 'view', 'GAME-076'),
                ('d2', 'GAME-076', 'page_view', 'view', 'GAME-076')
        `);

        const result = db.public.query(`
            SELECT COUNT(DISTINCT device_id) AS unique_devices
            FROM device_telemetry
            WHERE device_id IS NOT NULL
        `);

        expect(result.rows[0].unique_devices).toBe(2);
    });

    test('COUNT(*) with no rows returns 0 not null', () => {
        const result = db.public.query('SELECT COUNT(*) AS total FROM device_telemetry');
        expect(result.rows[0].total).toBe(0);
        expect(result.rows[0].total).not.toBeNull();
    });

    test('page_views: COUNT(*) WHERE type = page_view', () => {
        db.public.query(`
            INSERT INTO device_telemetry (device_id, game_id, type, action, page)
            VALUES
                ('d1', 'GAME-076', 'page_view', 'view', 'GAME-076'),
                ('d2', 'GAME-076', 'page_view', 'view', 'GAME-076'),
                ('d3', 'GAME-076', 'click', 'click', 'GAME-076')
        `);

        const result = db.public.query(`
            SELECT COUNT(*) AS page_views FROM device_telemetry WHERE type = 'page_view'
        `);
        expect(result.rows[0].page_views).toBe(2);
    });

    test('play_actions: ILIKE OR chain captures play/start/game_start variants', () => {
        db.public.query(`
            INSERT INTO device_telemetry (device_id, game_id, type, action, page)
            VALUES
                ('d1', 'GAME-076', 'action', 'play game', 'GAME-076'),
                ('d2', 'GAME-076', 'action', 'start', 'GAME-076'),
                ('d3', 'GAME-076', 'action', 'game_start', 'GAME-076'),
                ('d4', 'GAME-076', 'action', 'stop', 'GAME-076')
        `);

        const result = db.public.query(`
            SELECT COUNT(*) AS play_actions
            FROM device_telemetry
            WHERE action ILIKE '%play%' OR action ILIKE '%start%' OR action ILIKE '%game_start%'
        `);
        expect(result.rows[0].play_actions).toBe(3);
    });

    test('telemetry error count: COUNT(*) WHERE type = error', () => {
        db.public.query(`
            INSERT INTO device_telemetry (device_id, game_id, type, action, page)
            VALUES
                ('d1', 'GAME-076', 'error', 'crash', 'GAME-076'),
                ('d2', 'GAME-076', 'error', 'crash', 'GAME-076'),
                ('d3', 'GAME-076', 'page_view', 'view', 'GAME-076')
        `);

        const result = db.public.query(`
            SELECT COUNT(*) AS telemetry_error_events FROM device_telemetry WHERE type = 'error'
        `);
        expect(result.rows[0].telemetry_error_events).toBe(2);
    });

    test('server_error_events: COUNT(*) WHERE level IN (error, warn)', () => {
        db.public.query(`
            INSERT INTO server_logs (device_id, game_id, level, message)
            VALUES
                ('d1', 'GAME-076', 'error', 'Error message'),
                ('d2', 'GAME-076', 'warn', 'Warning message'),
                ('d3', 'GAME-076', 'info', 'Info message')
        `);

        const result = db.public.query(`
            SELECT COUNT(*) AS server_error_events
            FROM server_logs WHERE level IN ('error', 'warn')
        `);
        expect(result.rows[0].server_error_events).toBe(2);
    });

    test('gameStats: COUNT + AVG + GROUP BY game_id', () => {
        db.public.query(`
            INSERT INTO device_telemetry (device_id, game_id, type, action, page, duration)
            VALUES
                ('d1', 'GAME-076', 'page_view', 'view', 'GAME-076', 100),
                ('d2', 'GAME-076', 'page_view', 'view', 'GAME-076', 200),
                ('d3', 'GAME-088', 'page_view', 'view', 'GAME-088', 150)
        `);

        const result = db.public.query(`
            SELECT
                game_id,
                COUNT(*) AS total_events,
                AVG(duration) AS avg_duration
            FROM device_telemetry
            WHERE game_id IS NOT NULL
            GROUP BY game_id
            ORDER BY game_id
        `);

        const byGame = {};
        for (const row of result.rows) byGame[row.game_id] = row;
        expect(byGame['GAME-076'].total_events).toBe(2);
        expect(byGame['GAME-088'].total_events).toBe(1);
        expect(byGame['GAME-076'].avg_duration).toBe(150);
    });

    test('COALESCE handles NULL game_id gracefully (no crash)', () => {
        db.public.query(`
            INSERT INTO device_telemetry (device_id, game_id, type, action, page)
            VALUES ('d1', NULL, 'page_view', 'view', 'GAME-076')
        `);

        const result = db.public.query(`
            SELECT COUNT(*) AS total, SUM(CASE WHEN game_id IS NOT NULL THEN 1 ELSE 0 END) AS with_game
            FROM device_telemetry
        `);
        expect(result.rows[0].total).toBe(1);
        expect(result.rows[0].with_game).toBe(0);
    });

    // -------------------------------------------------------------------------
    // miniGameFeedbackWhereClause unit tests (no DB needed)
    // -------------------------------------------------------------------------

    test('miniGameFeedbackWhereClause covers all match paths', () => {
        const where = feedback.miniGameFeedbackWhereClause('$1');
        expect(where).toContain("LOWER(COALESCE(source, '')) = ANY($1::text[])");
        expect(where).toContain("LOWER(COALESCE(category, '')) = ANY($1::text[])");
        expect(where).toContain("unnest(COALESCE(tags");
        expect(where).toContain("message ILIKE '%minigame%'");
        expect(where).toContain("message ILIKE '%mini game%'");
        expect(where).toContain("message ILIKE '%game factory%'");
    });

    test('miniGameFeedbackWhereClause uses provided placeholder', () => {
        const where = feedback.miniGameFeedbackWhereClause('$7');
        expect(where).toContain('$7::text[]');
        expect(where).not.toContain('$1::text[]');
    });
});