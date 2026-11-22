/**
 * The alert schedule's runner (tools/aihankapps-hub/triage-runner.zsh) when this machine's Claude CLI is signed out.
 *
 * Regression: on 2026-11-20 the CLI's sign-in expired ("OAuth session expired and could not be refreshed"). Every
 * hourly model run failed in two seconds, nothing judged new alerts for two days, and the only notice was a vague
 * "the alert schedule is stuck". A signed-out CLI is now its own case: the run leaves handoff.json for a schedule that
 * runs inside the desktop app, the "stuck" notice is not raised (and is taken back if it was), and after a day one
 * notice asks for the sign-in. Everything is undone by the first model run that works.
 *
 * The behaviour tests run the real script against a stand-in CLI and a stand-in hub tool; they need zsh (macOS, where
 * the schedule runs). Without zsh only the script's text is checked.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const RUNNER = path.resolve(__dirname, '../../../tools/aihankapps-hub/triage-runner.zsh');
const source = fs.readFileSync(RUNNER, 'utf8');
const hasZsh = spawnSync('zsh', ['-c', 'exit 0']).status === 0 && process.platform === 'darwin';
const onMac = hasZsh ? test : test.skip;

describe('alert schedule runner: the script itself', () => {
    test('a sign-in failure is recognised from the model run\'s own output, not guessed from the exit code', () => {
        expect(source).toMatch(/Failed to authenticate\|OAuth session expired/);
        expect(source).toMatch(/2>&1 \| tail -5 > "\$WORK\/run\/last-output\.txt"/);
        expect(source).toMatch(/code=\$\{pipestatus\[1\]\}/);
    });

    test('signed out is handled before the "stuck" counter, and never raises the stuck notice', () => {
        const signedOut = source.indexOf('if [[ $signed_out = 1 ]]; then'), stuck = source.indexOf('raise alert-schedule-stuck');
        expect(signedOut).toBeGreaterThan(0);
        expect(stuck).toBeGreaterThan(signedOut);
        const block = source.slice(signedOut, source.indexOf('\nfi\n', signedOut));
        expect(block).toContain('handoff.json');
        expect(block).toContain('echo 0 > "$STATE/model-failures"');
        expect(block).toContain('resolve human-alert-schedule-stuck');
        expect(block).toMatch(/-mmin \+1440/);
        expect(block).toContain('raise claude-cli-login');
        expect(block).toMatch(/exit 0\s*$/);
    });

    test('the request names the one step and nothing secret', () => {
        const ask = source.slice(source.indexOf('raise claude-cli-login'), source.indexOf('touch "$STATE/raised-login"'));
        expect(ask).toContain('/login');
        expect(ask).not.toMatch(/token|password|sk-ant|eck_|ecs_/i);
    });

    onMac('zsh accepts the script', () => {
        expect(spawnSync('zsh', ['-n', RUNNER]).status).toBe(0);
    });
});

describe('alert schedule runner: a signed-out CLI', () => {
    // A home with a stand-in `claude`, a stand-in hub tool and its pending list; node is the real one.
    function world() {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-runner-')), code = path.join(home, 'code'), hubDir = path.join(code, 'tools', 'aihankapps-hub');
        fs.mkdirSync(hubDir, { recursive: true });
        fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
        fs.writeFileSync(path.join(hubDir, 'TRIAGE.md'), '# rules\nnode TRIAGE_TOOL note <id>\n');
        fs.writeFileSync(path.join(hubDir, 'triage.js'), `
const fs = require('fs'), path = require('path'), dir = ${JSON.stringify(home)};
fs.appendFileSync(path.join(dir, 'hub-calls.log'), process.argv.slice(2).join(' ') + '\\n');
const cmd = process.argv[2];
if (cmd === 'pending') { const alerts = JSON.parse(fs.readFileSync(path.join(dir, 'pending.json'), 'utf8')); console.log(JSON.stringify({ success: true, pending: alerts.length, alerts })); }
else console.log(JSON.stringify({ success: true, pulled: true }));
`);
        const claude = path.join(home, '.local', 'bin', 'claude');
        fs.writeFileSync(claude, `#!/bin/sh
if [ "$1" = auth ]; then if [ "$(cat "${home}/claude-mode" 2>/dev/null)" = ok ]; then echo '{ "loggedIn": true }'; else echo '{ "loggedIn": false }'; fi; exit 0; fi
if [ "$(cat "${home}/claude-mode" 2>/dev/null)" = ok ]; then echo '[]' > "${home}/pending.json"; echo judged; exit 0; fi
echo "Failed to authenticate: OAuth session expired and could not be refreshed"; exit 1
`);
        fs.chmodSync(claude, 0o755);
        const w = {
            home, work: path.join(home, '.local', 'share', 'aihankapps-hub-triage'),
            pending: alerts => fs.writeFileSync(path.join(home, 'pending.json'), JSON.stringify(alerts)),
            mode: m => fs.writeFileSync(path.join(home, 'claude-mode'), m),
            run: () => spawnSync('zsh', [RUNNER], { encoding: 'utf8', env: { HOME: home, PATH: process.env.PATH, AIHANKAPPS_TRIAGE_CODE: code }, timeout: 60000 }),
            calls: () => { try { return fs.readFileSync(path.join(home, 'hub-calls.log'), 'utf8').trim().split('\n'); } catch (_e) { return []; } },
            log: () => { const d = path.join(home, 'Library', 'Logs', 'aihankapps-hub-triage'); return fs.readdirSync(d).map(f => fs.readFileSync(path.join(d, f), 'utf8')).join(''); },
            handoff: () => { try { return JSON.parse(fs.readFileSync(path.join(w.work, 'handoff.json'), 'utf8')); } catch (_e) { return null; } },
            state: name => path.join(w.work, 'state', name),
            // The same pending list within the hour is not retried: age the fingerprint so the next run tries the model again.
            nextHour: () => { const old = new Date(Date.now() - 2 * 3600000); try { fs.utimesSync(w.state('last-fp'), old, old); } catch (_e) { /* no run yet */ } },
        };
        return w;
    }
    const NEW = [{ id: 'fb-example-1', reason: 'new' }, { id: 'fb-example-2', reason: 'new' }];

    onMac('leaves a handoff for the app-side schedule, exits cleanly, and does not count toward "stuck"', () => {
        const w = world(); w.pending(NEW);
        for (let i = 0; i < 4; i++) { expect(w.run().status).toBe(0); w.nextHour(); }
        expect(w.handoff()).toMatchObject({ reason: 'CLI_SIGNED_OUT', pending: 2 });
        expect(w.handoff().fp).toMatch(/^[0-9a-f]{64}$/);
        expect(Date.parse(w.handoff().since)).toBeLessThanOrEqual(Date.parse(w.handoff().at));
        expect(fs.readFileSync(w.state('model-failures'), 'utf8').trim()).toBe('0');
        expect(w.calls().some(c => /^raise /.test(c))).toBe(false);          // four failed hours: still no notice
        expect(w.log()).toMatch(/signed out .*2 alerts handed to the app-side schedule/);
    });

    onMac('after a day it asks once for the sign-in, and takes an earlier "stuck" notice back', () => {
        const w = world(); w.pending(NEW);
        w.run();
        fs.mkdirSync(path.dirname(w.state('x')), { recursive: true });
        fs.writeFileSync(w.state('raised-stuck'), '');                       // raised by the old script for this very cause
        const dayAgo = new Date(Date.now() - 25 * 3600000); fs.utimesSync(w.state('signed-out-since'), dayAgo, dayAgo);
        w.nextHour(); w.run(); w.nextHour(); w.run();
        const raised = w.calls().filter(c => /^raise claude-cli-login /.test(c));
        expect(raised.length).toBe(1);
        expect(raised[0]).toContain('/login');
        expect(w.calls().filter(c => /^resolve human-alert-schedule-stuck /.test(c)).length).toBe(1);
        expect(fs.existsSync(w.state('raised-stuck'))).toBe(false);
        expect(w.calls().some(c => /^raise alert-schedule-stuck/.test(c))).toBe(false);
    });

    onMac('the first model run that works releases the handoff and takes the request back', () => {
        const w = world(); w.pending(NEW);
        w.run();
        const dayAgo = new Date(Date.now() - 25 * 3600000); fs.utimesSync(w.state('signed-out-since'), dayAgo, dayAgo);
        w.nextHour(); w.run();
        expect(fs.existsSync(w.state('raised-login'))).toBe(true);
        w.mode('ok'); w.nextHour();
        expect(w.run().status).toBe(0);
        expect(w.handoff()).toBeNull();
        expect(fs.existsSync(w.state('signed-out-since'))).toBe(false);
        expect(fs.existsSync(w.state('raised-login'))).toBe(false);
        expect(w.calls().filter(c => /^resolve human-claude-cli-login /.test(c)).length).toBe(1);
    });

    onMac('a sign-in is noticed on the next tick even when no alert is waiting for a model run', () => {
        const w = world(); w.pending(NEW);
        w.run();
        const dayAgo = new Date(Date.now() - 25 * 3600000); fs.utimesSync(w.state('signed-out-since'), dayAgo, dayAgo);
        w.nextHour(); w.run();
        expect(fs.existsSync(w.state('raised-login'))).toBe(true);
        w.pending([]);                                      // the stand-in schedule judged everything meanwhile
        w.run();
        expect(fs.existsSync(w.state('raised-login'))).toBe(true);   // still signed out: the request stays
        w.mode('ok');
        expect(w.run().status).toBe(0);
        expect(fs.existsSync(w.state('raised-login'))).toBe(false);
        expect(fs.existsSync(w.state('signed-out-since'))).toBe(false);
        expect(w.calls().filter(c => /^resolve human-claude-cli-login /.test(c)).length).toBe(1);
        expect(w.log()).toMatch(/signed in again: handoff released/);
    });

    onMac('a model run that fails for another reason still counts toward "stuck" as before', () => {
        const w = world(); w.pending(NEW);
        fs.writeFileSync(path.join(w.home, '.local', 'bin', 'claude'), '#!/bin/sh\necho "API Error: 529 overloaded"; exit 1\n');
        for (let i = 0; i < 3; i++) { expect(w.run().status).toBe(1); w.nextHour(); }
        expect(w.handoff()).toBeNull();
        expect(w.calls().filter(c => /^raise alert-schedule-stuck /.test(c)).length).toBe(1);
    });

    onMac('nothing pending clears a handoff nobody needs any more', () => {
        const w = world(); w.pending(NEW);
        w.run();
        expect(w.handoff()).not.toBeNull();
        w.pending([]);
        expect(w.run().status).toBe(0);
        expect(w.handoff()).toBeNull();
    });
});
