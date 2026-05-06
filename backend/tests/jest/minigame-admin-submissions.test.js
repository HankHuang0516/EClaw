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
});
