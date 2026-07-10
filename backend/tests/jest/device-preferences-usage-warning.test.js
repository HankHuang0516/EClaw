/**
 * Unit test: device-preferences coerces the new usage_warning_config key
 * (card_9cd84ee7d830b2f76c595f6c). We exercise the pure coerceValue path
 * via updatePrefs against an in-memory pool stub so we never touch real PG.
 */

const devicePrefs = require('../../device-preferences');

describe('device-preferences usage_warning_config', () => {
    test('DEFAULTS carry the spec default values', () => {
        expect(devicePrefs.DEFAULTS.usage_warning_config).toEqual({
            enabled: true,
            threshold_5h_pct: 15,
            threshold_7d_pct: 5,
            entity_engines: {},
        });
    });

    test('coerce via updatePrefs: clamps thresholds 0..100, rounds, defaults missing fields', async () => {
        const calls = [];
        const stubPool = {
            query: jest.fn().mockImplementation((sql, params) => {
                calls.push({ sql, params });
                return Promise.resolve({ rows: [], rowCount: 0 });
            })
        };
        await devicePrefs.initTable(stubPool);

        const cases = [
            { in: { enabled: false, threshold_5h_pct: 200, threshold_7d_pct: -3 },
              out: { enabled: false, threshold_5h_pct: 100, threshold_7d_pct: 0, entity_engines: {} } },
            { in: { enabled: true, threshold_5h_pct: 25.6 },
              out: { enabled: true, threshold_5h_pct: 26, threshold_7d_pct: 5 /* keep default */, entity_engines: {} } },
            { in: { threshold_7d_pct: 'oops' },
              out: { enabled: true /* keep default */, threshold_5h_pct: 15, threshold_7d_pct: 5, entity_engines: {} } },
            { in: 'not-an-object',
              out: { enabled: true, threshold_5h_pct: 15, threshold_7d_pct: 5, entity_engines: {} } },
            { in: { entity_engines: { '6': 'codex', '2': 'claude', '-1': 'codex', bad: 'codex', '7': 'openclaw' } },
              out: { enabled: true, threshold_5h_pct: 15, threshold_7d_pct: 5, entity_engines: { '2': 'claude', '6': 'codex' } } },
        ];

        for (const c of cases) {
            calls.length = 0;
            await devicePrefs.updatePrefs('dev-test', { usage_warning_config: c.in });
            expect(calls.length).toBeGreaterThanOrEqual(1);
            const insert = calls.find(c => /INSERT INTO device_preferences/i.test(c.sql));
            expect(insert).toBeTruthy();
            const stored = JSON.parse(insert.params[1]);
            expect(stored.usage_warning_config).toEqual(c.out);
        }
    });
});
