'use strict';

const fs = require('fs');
const path = require('path');

const {
    DEFAULT_CRON,
    DEFAULT_TIMEZONE,
    createSettingsHelpInvariantCron,
    loadConfig,
    openViolationCard,
} = require('../../settings-help-invariant-cron');

function execResponder(handler) {
    return jest.fn((file, args, options, cb) => {
        try {
            const result = handler({ file, args, options });
            if (result instanceof Error) {
                cb(result, result.stdout || '', result.stderr || result.message);
                return;
            }
            cb(null, result?.stdout || '', result?.stderr || '');
        } catch (err) {
            cb(err, err.stdout || '', err.stderr || err.message);
        }
    });
}

function invariantFailure(stderr) {
    const err = new Error('settings help invariant failed');
    err.code = 1;
    err.stderr = stderr;
    return err;
}

function makePool({ existing = [] } = {}) {
    const calls = [];
    return {
        calls,
        async query(sql, params = []) {
            const text = String(sql);
            calls.push({ sql: text, params });
            if (text.includes('FROM kanban_cards') && text.includes('description LIKE')) {
                return { rows: existing, rowCount: existing.length };
            }
            return { rows: [], rowCount: 1 };
        },
    };
}

describe('settings-help invariant cron wrapper', () => {
    test('defaults to hourly Asia/Taipei patrol and first admin device', () => {
        const config = loadConfig({
            ADMIN_DEVICE_IDS: 'dev-a,dev-b',
        });

        expect(config.configured).toBe(true);
        expect(config.cron).toBe(DEFAULT_CRON);
        expect(config.timezone).toBe(DEFAULT_TIMEZONE);
        expect(config.deviceId).toBe('dev-a');
        expect(config.assignedBots).toEqual([6]);
        expect(config.cardConfigured).toBe(true);
    });

    test('failed invariant run opens a kanban card with en + zh scope', async () => {
        const stderr = [
            'FAIL: settings help invariant violations:',
            '  - registry: missing en help key sample_help',
            '  - registry: missing zh help key sample_help',
        ].join('\n');
        const execFile = execResponder(() => invariantFailure(stderr));
        const pool = makePool();
        const audit = jest.fn();
        const monitor = createSettingsHelpInvariantCron({
            env: {
                SETTINGS_HELP_INVARIANT_REPO_DIR: '/repo',
                SETTINGS_HELP_INVARIANT_DEVICE_ID: 'dev-1',
                SETTINGS_HELP_INVARIANT_ASSIGNED_BOTS: '6,7',
            },
            execFile,
            getPool: () => pool,
            audit,
            now: () => Date.parse('2026-06-01T00:00:00.000Z'),
        });

        const result = await monitor.runOnce('test');

        expect(result.ok).toBe(false);
        expect(result.card).toEqual(expect.objectContaining({ created: true, cardId: expect.stringMatching(/^card_/) }));
        // scriptPath is anchored to the cron module's __dirname (always at
        // backend/scripts/check-settings-help-invariant.js, regardless of cwd
        // or repoDir env override). cwd still honors repoDir env so the
        // invoked script's relative paths inherit it.
        const path = require('path');
        const expectedScript = path.resolve(__dirname, '..', '..', 'scripts', 'check-settings-help-invariant.js');
        expect(execFile).toHaveBeenCalledWith(
            process.execPath,
            [expectedScript, '--all'],
            expect.objectContaining({ cwd: '/repo', timeout: 60000 }),
            expect.any(Function)
        );

        const insert = pool.calls.find(c => c.sql.includes('INSERT INTO kanban_cards'));
        expect(insert).toBeTruthy();
        expect(insert.params[1]).toBe('dev-1');
        expect(insert.params[2]).toContain('Settings help invariant');
        expect(insert.params[3]).toContain('canonical settings-help locales are `en` + `zh`');
        expect(insert.params[3]).not.toContain('zh-TW');
        expect(insert.params[6]).toBe(JSON.stringify([6, 7]));
        expect(audit).toHaveBeenCalledWith(
            'warn',
            'settings_help_invariant',
            expect.stringContaining('kanban card created'),
            expect.objectContaining({ result: 'card_created' })
        );
    });

    test('same violation fingerprint updates existing active card instead of duplicating', async () => {
        const pool = makePool({ existing: [{ id: 'card_existing', status: 'todo' }] });
        const config = loadConfig({
            SETTINGS_HELP_INVARIANT_DEVICE_ID: 'dev-1',
            SETTINGS_HELP_INVARIANT_ASSIGNED_BOTS: '6',
        });
        const result = {
            ok: false,
            output: [
                'FAIL: settings help invariant violations:',
                '  - registry: missing zh help key sample_help',
            ].join('\n'),
        };

        const card = await openViolationCard({
            pool,
            config,
            result,
            nowMs: Date.parse('2026-06-01T00:00:00.000Z'),
        });

        expect(card).toEqual(expect.objectContaining({ created: false, cardId: 'card_existing' }));
        expect(pool.calls.filter(c => c.sql.includes('INSERT INTO kanban_cards'))).toHaveLength(0);
        const update = pool.calls.find(c => c.sql.includes('description = $2'));
        expect(update.params[3]).toBe('card_existing');
    });

    test('startCron schedules the monitor and index wires it at startup', () => {
        const schedule = jest.fn(() => ({ stop: jest.fn() }));
        const audit = jest.fn();
        const monitor = createSettingsHelpInvariantCron({
            env: {
                SETTINGS_HELP_INVARIANT_REPO_DIR: '/repo',
                ADMIN_DEVICE_IDS: 'dev-1',
            },
            audit,
        });

        monitor.startCron({ nodeCron: { schedule } });

        expect(schedule).toHaveBeenCalledWith(
            DEFAULT_CRON,
            expect.any(Function),
            { timezone: DEFAULT_TIMEZONE }
        );
        expect(audit).toHaveBeenCalledWith(
            'info',
            'settings_help_invariant',
            expect.stringContaining('scheduled'),
            expect.objectContaining({ result: 'scheduled' })
        );

        const indexSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'index.js'), 'utf8');
        expect(indexSrc).toContain('createSettingsHelpInvariantCron');
        expect(indexSrc).toContain('settingsHelpInvariantCron.startCron({ nodeCron })');
    });
});
