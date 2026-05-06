const feedback = require('../../device-feedback');

describe('MiniGame admin submissions', () => {
    test('builds a MiniGame matcher across source, category, tags, and legacy message text', () => {
        const where = feedback.miniGameFeedbackWhereClause('$7');
        expect(where).toContain("LOWER(COALESCE(source, '')) = ANY($7::text[])");
        expect(where).toContain("LOWER(COALESCE(category, '')) = ANY($7::text[])");
        expect(where).toContain('unnest(COALESCE(tags');
        expect(where).toContain("message ILIKE '%minigame%'");
        expect(where).toContain("message ILIKE '%game factory%'");
    });

    test('returns empty summary when pool is unavailable', async () => {
        const result = await feedback.getMiniGameSubmissions(null);
        expect(result).toEqual({
            summary: { total: 0, open: 0, bugReports: 0, highPriority: 0 },
            submissions: []
        });
    });

    test('queries MiniGame feedback and caps admin page size', async () => {
        const calls = [];
        const pool = {
            query: jest.fn(async (sql, params) => {
                calls.push({ sql, params });
                if (/CAST\(COUNT\(\*\) AS int\) AS total/.test(sql)) {
                    return {
                        rows: [{ total: '3', open: '2', bug_reports: '2', high_priority: '1' }]
                    };
                }
                return {
                    rows: [{
                        id: 42,
                        device_id: 'dev-1',
                        message: 'MiniGame player got stuck',
                        category: 'bug',
                        severity: 'high',
                        status: 'open',
                        tags: ['minigame'],
                        app_version: 'web-minigame',
                        source: 'minigame',
                        github_issue_url: null,
                        created_at: 1710000000000
                    }]
                };
            })
        };

        const result = await feedback.getMiniGameSubmissions(pool, { limit: 999, offset: 5 });

        expect(result.summary).toEqual({ total: 3, open: 2, bugReports: 2, highPriority: 1 });
        expect(result.submissions).toHaveLength(1);
        expect(result.submissions[0].source).toBe('minigame');
        expect(calls).toHaveLength(2);
        expect(calls[0].params[0]).toEqual(expect.arrayContaining(['minigame', 'mini-game', 'game factory']));
        expect(calls[1].params).toEqual([
            expect.arrayContaining(['minigame', 'mini-game', 'game factory']),
            200,
            5
        ]);
    });

    test('returns empty MiniGame analytics when pool is unavailable', async () => {
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

    test('aggregates MiniGame error logs and play telemetry for admin analytics', async () => {
        const calls = [];
        const pool = {
            query: jest.fn(async (sql, params) => {
                calls.push({ sql, params });
                if (/server_error_events/.test(sql)) {
                    return {
                        rows: [{
                            total_events: '42',
                            page_views: '12',
                            play_actions: '8',
                            telemetry_error_events: '3',
                            server_error_events: '7',
                            unique_devices: '5',
                            affected_games: '2'
                        }]
                    };
                }
                if (/GROUP BY game_id, error_signature/.test(sql)) {
                    return {
                        rows: [{
                            game_id: 'GAME-076',
                            error_signature: 'Cannot set properties of null',
                            count: '10',
                            server_errors: '7',
                            telemetry_errors: '3',
                            unique_devices: '4',
                            first_seen_at: '2026-05-06T01:00:00.000Z',
                            last_seen_at: '2026-05-06T02:00:00.000Z'
                        }]
                    };
                }
                if (/GROUP BY game_id/.test(sql)) {
                    return {
                        rows: [{
                            game_id: 'GAME-076',
                            total_events: '30',
                            page_views: '12',
                            play_actions: '8',
                            errors: '3',
                            unique_devices: '5',
                            avg_duration_ms: '1234',
                            last_seen_at: '2026-05-06T02:10:00.000Z'
                        }]
                    };
                }
                return {
                    rows: [{
                        source: 'server_log',
                        game_id: 'GAME-076',
                        level: 'error',
                        message: 'Cannot set properties of null',
                        device_id: 'dev-1',
                        created_at: '2026-05-06T02:11:00.000Z'
                    }]
                };
            })
        };

        const result = await feedback.getMiniGameAnalytics(pool, { hours: 48, limit: 999 });

        expect(result.windowHours).toBe(48);
        expect(result.summary).toEqual({
            errorEvents: 10,
            serverErrorEvents: 7,
            telemetryErrorEvents: 3,
            totalEvents: 42,
            pageViews: 12,
            playActions: 8,
            uniqueDevices: 5,
            affectedGames: 2
        });
        expect(result.errorStats[0]).toMatchObject({
            gameId: 'GAME-076',
            errorSignature: 'Cannot set properties of null',
            count: 10,
            serverErrors: 7,
            telemetryErrors: 3,
            uniqueDevices: 4
        });
        expect(result.gameStats[0]).toMatchObject({
            gameId: 'GAME-076',
            totalEvents: 30,
            pageViews: 12,
            playActions: 8,
            errors: 3,
            avgDurationMs: 1234
        });
        expect(result.recentErrors[0]).toMatchObject({
            gameId: 'GAME-076',
            source: 'server_log',
            message: 'Cannot set properties of null'
        });
        expect(calls).toHaveLength(4);
        expect(calls[0].params).toEqual([48]);
        expect(calls[1].params).toEqual([48, 100]);
        expect(calls.map(c => c.sql.join?.('') || c.sql).join('\n')).toContain('device_telemetry');
        expect(calls.map(c => c.sql.join?.('') || c.sql).join('\n')).toContain('server_logs');
        expect(calls.map(c => c.sql.join?.('') || c.sql).join('\n')).toContain('GAME-[0-9]+');
    });
});
