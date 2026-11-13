#!/usr/bin/env node
'use strict';
// 警示處理排程的工具（Hank 2026-11-13：「確保排程可以自主處理判斷所有的警示問題 如果需要人為介入就讓排程發一個警示把詳情打上去
// 讓我看到需要我怎麼幫忙 我全程只盯管理中樞 不會盯排程的每次結果 所以不要pending在排程的每個session中」）。
//
// Runs on the operator's Mac. Every subcommand goes through the existing deployment channel (`railway ssh` into the EClaw
// container, the same as the hub collector); the only other request is the 拾光AI雲端相簿 feedback read, with the hub's own
// key file. The alert schedule (a Claude run started by ~/.local/bin/aihankapps-hub-triage) may only use this tool to act,
// so everything it can do is listed here:
//
//   node triage.js pending            alerts the schedule has not judged yet, or whose judgement is due again (JSON)
//   node triage.js show <ID>          one alert in full (JSON)
//   node triage.js note <ID> --state auto|done --note "…"                 what the schedule decided
//   node triage.js note <ID> --state human --note "…" --ask "…" [--title "…"]   only Hank can clear it: say what he must do
//   node triage.js raise <slug> --title "…" --ask "…" --note "…" [--app <id>]   a problem no rule shows (ID human-<slug>)
//   node triage.js resolve <ID> --note "…"                               close a note (e.g. the problem is gone)
//   node triage.js notes [--all]       the schedule's notes
//   node triage.js acks               what Hank confirmed on the page, and the countermeasures (對策) he wrote
//   node triage.js kick <job>          restart one of this Mac's own hub jobs (collector, collector-hourly, report-watchdog)
//   node triage.js pull                read 拾光AI雲端相簿's App and LINE problem reports and import them (no model needed)
//
// Output is one JSON line. Nothing here deletes data, deploys, pushes, sends messages or changes settings.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { runRailway, shellFor } = require('../aihankapps-gifts/lib/adapters/transport');

const HUB = { project: 'Clawdbot', projectId: '844a6139-9b8f-43d6-a698-f97db1fa05c0', environment: 'production', service: 'eclaw' };
const HUB_APP_DIRS = ['/app/backend', '/app'];
const MAX_ARG_BYTES = 60 * 1024;
const HOUR = 3600000;
// When a judgement is looked at again: "auto" after 6 hours (is it still clearing by itself?), "human" after 12 hours
// (did Hank fix it? then the schedule closes it).
const RECHECK = { auto: 6 * HOUR, human: 12 * HOUR };
// The Wishlist listing schedules' own board already says what Hank must do; it is managed by those schedules.
// A fold of alerts Hank chose to stop being reminded of (以後略過類似警告) needs no judgement either.
const SKIP_TYPES = [/^attention-/, /^muted$/];
// Hank 2026-11-13: 「排程可以讀取我是否按了該狀態以及讀取對策」. A countermeasure he wrote beside 確認 is an instruction: it is
// pending, whatever the alert's type, until the schedule has written a note on that ID after it. One that nobody answered
// in two weeks is left alone.
const PLAN_DAYS = 14;
const TIMEHUT_FEEDBACK_URL = 'https://just-healing-production.up.railway.app/api/internal/feedback';
const TIMEHUT_KEY_FILE = path.join(os.homedir(), '.config', 'aihankapps-hub', 'timehut-stats-key');
// Worker restarts and image mounts stay with hub-heal.cjs (the Wishlist tools' hourly job), which already does them safely.
const JOBS = { collector: 'tw.aihankapps.hub-collector', 'collector-hourly': 'tw.aihankapps.hub-collector-hourly', 'report-watchdog': 'tw.aihankapps.report-watchdog' };

function out(value) { process.stdout.write(JSON.stringify(value) + '\n'); }
function fail(code, detail) { const error = new Error(code); error.code = code; if (detail) error.detail = detail; throw error; }
function flag(argv, name) { const i = argv.indexOf('--' + name); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined; }

// Runs one of the hub's operator scripts inside the EClaw container; the request travels as one base64 argument.
function containerScript(script, request) {
    const arg = request === undefined ? '' : Buffer.from(JSON.stringify(request), 'utf8').toString('base64');
    if (arg.length > MAX_ARG_BYTES) fail('REQUEST_TOO_LARGE');
    const args = JSON.stringify(['scripts/' + script].concat(arg ? [arg] : []));
    return shellFor(`
const { spawnSync } = require('child_process');
const done = spawnSync(process.execPath, ${args}, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
const line = (done.stdout || '').trim().split('\\n').pop() || (done.stderr || '').trim().split('\\n').pop() || '{}';
let value; try { value = JSON.parse(line); } catch (_error) { value = { success: false, error: 'SCRIPT_OUTPUT' }; }
console.log('GIFT_RESULT ' + JSON.stringify(value));
process.exitCode = value.success ? 0 : 1;
`.trim(), HUB_APP_DIRS);
}
function remote(script, request, { run = runRailway } = {}) {
    const result = run(HUB, containerScript(script, request), { timeoutMs: 240000 });
    if (!result.value) fail('RAILWAY_NO_RESULT', result.detail);
    if (!result.value.success) fail(result.value.error || 'SCRIPT_FAILED');
    return result.value;
}

// The alerts as the hub shows them. Report text is cut so the answer stays small; `show` gives the whole alert.
function alerts(options) { return remote('aihankapps-hub-alerts.js', undefined, options); }

const planDue = (ack, triage) => !!(ack && ack.plan && !(triage && triage.at && ack.planAt && triage.at >= ack.planAt));
function due(alert, now) {
    if (planDue(alert.ack, alert.triage)) return 'plan';
    if (SKIP_TYPES.some(re => re.test(alert.type))) return null;
    const t = alert.triage;
    if (!t) return 'new';
    if (t.state === 'done') return null;
    const wait = RECHECK[t.state];
    return wait && t.at && now - t.at > wait ? 'recheck-' + t.state : null;
}
function brief(alert, reason) {
    const cut = (s, n) => (typeof s === 'string' && s.length > n ? s.slice(0, n) + '…' : s || null);
    return { id: alert.id, reason, type: alert.type, severity: alert.severity, title: alert.title, detail: cut(alert.detail, 400), quote: cut(alert.quote, 800),
        app: alert.app || (alert.apps || [])[0] || null, since: alert.sinceTaipei || null, rule: alert.rule, condition: alert.condition, source: alert.source,
        basis: alert.basis, triage: alert.triage || null,
        // null = Hank has not pressed 確認; otherwise when he did, and the countermeasure he wrote with it (plan), if any
        ack: alert.ack ? { at: alert.ack.atTaipei || null, plan: alert.ack.plan || null } : null };
}
function pending(answer, now = Date.now()) {
    const list = [];
    for (const a of answer.alerts) { const reason = due(a, now); if (reason) list.push(brief(a, reason)); }
    // A countermeasure whose alert has cleared since is still an instruction waiting for an answer.
    for (const k of answer.acks || []) {
        if (!k.plan || k.active || k.answered || !(now - (k.planAt || 0) < PLAN_DAYS * 24 * HOUR)) continue;
        list.push({ id: k.id, reason: 'plan', cleared: true, type: String(k.id).split(/[.@]/)[0], title: k.title || null, detail: '這則警示已經解除，但 Hank 留了對策。',
            triage: k.triage || null, ack: { at: k.atTaipei || null, plan: k.plan } });
    }
    list.sort((a, b) => (b.reason === 'plan') - (a.reason === 'plan'));   // his instructions first
    return { computedAt: answer.computedAtTaipei, total: answer.alerts.length, pending: list.length, alerts: list };
}

function noteRequest(ref, argv, state) {
    const request = { action: 'set', ref, state: state || flag(argv, 'state'), note: flag(argv, 'note'), by: 'alert-schedule' };
    for (const key of ['ask', 'title', 'app']) if (flag(argv, key) !== undefined) request[key] = flag(argv, key);
    return request;
}

function readKey(file = TIMEHUT_KEY_FILE) {
    let stat;
    try { stat = fs.lstatSync(file); } catch (_error) { return null; }
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) return null;
    const key = fs.readFileSync(file, 'utf8').trim();
    return /^[A-Za-z0-9_-]{32,256}$/.test(key) ? key : null;
}
// 拾光AI雲端相簿 1.0.119+: GET /api/internal/feedback (Bearer, the hub's key) → { schema: 1, app: [...], line: [...] }.
// An older server (404) simply has nothing to give yet.
async function pull({ fetchImpl = fetch, key = readKey(), now = Date.now(), options } = {}) {
    if (!key) return { pulled: false, reason: 'timehut key file missing or not chmod 600' };
    let res;
    try {
        res = await fetchImpl(TIMEHUT_FEEDBACK_URL + '?days=30', { headers: { Authorization: 'Bearer ' + key, Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(20000) });
    } catch (error) { return { pulled: false, reason: 'request failed (' + ((error && error.name) || 'error') + ')' }; }
    if (res.status === 404) return { pulled: false, reason: 'server has no feedback endpoint yet' };
    if (res.status !== 200) return { pulled: false, reason: 'HTTP ' + res.status };
    let body;
    try { body = await res.json(); } catch (_error) { return { pulled: false, reason: 'answer is not JSON' }; }
    if (!body || body.schema !== 1 || !Array.isArray(body.app) || !Array.isArray(body.line)) return { pulled: false, reason: 'unexpected answer' };
    const receipts = [];
    for (const [source, items] of [['timehut-app', body.app], ['timehut-line', body.line]]) {
        const feedback = items.slice(0, 200).map(i => ({ id: String(i.id), message: String(i.message || '').slice(0, 4000), createdAt: i.createdAt,
            ...(i.category ? { category: String(i.category) } : {}), ...(i.version ? { version: String(i.version) } : {}), ...(i.channel ? { channel: String(i.channel) } : {}),
            ...(i.reporter ? { reporter: String(i.reporter) } : {}), ...(typeof i.hasImage === 'boolean' ? { hasImage: i.hasImage } : {}) })).filter(i => i.message.trim());
        receipts.push(remote('aihankapps-hub-import.js', { schemaVersion: 1, source, collectedAt: now, feedback }, options));
    }
    return { pulled: true, receipts: receipts.map(r => ({ source: r.source, received: r.received, added: r.added })) };
}

function kick(name, { spawn = spawnSync } = {}) {
    if (!Object.prototype.hasOwnProperty.call(JOBS, name)) fail('UNKNOWN_JOB', Object.keys(JOBS).join(', '));
    const uid = typeof process.getuid === 'function' ? process.getuid() : 501;
    const r = spawn('launchctl', ['kickstart', 'gui/' + uid + '/' + JOBS[name]], { encoding: 'utf8', timeout: 20000 });
    if (r.status !== 0) fail('KICK_FAILED', String(r.stderr || '').trim().slice(-200));
    return { kicked: JOBS[name] };
}

async function main(argv = process.argv.slice(2), options = {}) {
    const [command, target] = argv;
    switch (command) {
        case 'pending': return pending(alerts(options));
        case 'show': {
            const answer = alerts(options), a = answer.alerts.find(x => x.id === target) || answer.alerts.find(x => x.type === String(target || '').split(/[.@]/)[0]);
            if (!a) fail('NO_SUCH_ALERT');
            return { alert: a };
        }
        case 'note': {
            if (!target) fail('ID_REQUIRED');
            return remote('aihankapps-hub-note.js', noteRequest(target, argv), options);
        }
        case 'raise': {
            if (!target || !/^[a-z0-9][a-z0-9-]{1,60}$/.test(target)) fail('SLUG_REQUIRED');
            return remote('aihankapps-hub-note.js', noteRequest('human-' + target, argv, 'human'), options);
        }
        case 'resolve': {
            if (!target) fail('ID_REQUIRED');
            return remote('aihankapps-hub-note.js', noteRequest(target, argv, 'done'), options);
        }
        case 'acks': return { acks: alerts(options).acks || [] };
        case 'notes': return remote('aihankapps-hub-note.js', { action: 'list', ...(argv.includes('--all') ? { all: true } : {}) }, options);
        case 'kick': return kick(target, options);
        case 'pull': return pull(options);
        default: fail('USAGE', 'pending | show <ID> | note <ID> --state … --note … [--ask …] | raise <slug> … | resolve <ID> --note … | notes | acks | kick <job> | pull');
    }
}

if (require.main === module) {
    main().then(value => out({ success: true, ...value })).catch(error => {
        out({ success: false, error: /^[A-Z0-9_]{1,64}$/.test(error.code || '') ? error.code : 'TRIAGE_FAILED', ...(error.detail ? { detail: String(error.detail).slice(-400) } : {}) });
        process.exitCode = 1;
    });
}

module.exports = { HUB, JOBS, RECHECK, PLAN_DAYS, TIMEHUT_FEEDBACK_URL, containerScript, due, brief, pending, noteRequest, pull, kick, main };
