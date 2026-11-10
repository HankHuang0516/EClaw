#!/usr/bin/env node
'use strict';

// Collects daily counts from the back-ends that keep their own databases and hands them to the admin hub.
//
//   node tools/aihankapps-hub/collect.js                 read every back-end, show what would be sent, send nothing
//   node tools/aihankapps-hub/collect.js --commit        read, then import into the hub
//   node tools/aihankapps-hub/collect.js --only rebound  one back-end (ids: rebound, summit, wishlist)
//
// Reading runs inside each back-end's own container and is read-only. Importing runs the deployed
// backend/scripts/aihankapps-hub-import.js inside the EClaw container. Both go through `railway ssh`, so the
// operator's Railway login is the only credential involved and no secret passes through this tool.
const fs = require('fs');
const path = require('path');
const { runRailway, shellFor } = require('../aihankapps-gifts/lib/adapters/transport');
const { BACKENDS, remoteScript } = require('./backends');
const { validateEnvelope, MAX_IMPORT_BYTES } = require('../../backend/aihankapps-hub-store');

const HUB = { project: 'Clawdbot', projectId: '844a6139-9b8f-43d6-a698-f97db1fa05c0', environment: 'production', service: 'eclaw' };
const HUB_APP_DIRS = ['/app/backend', '/app'];
// The envelope travels as one command-line argument (twice base64-encoded); Linux caps a single argument at 128 KiB.
const MAX_SHELL_ENVELOPE_BYTES = 60 * 1024;
const taipeiToday = (now = Date.now()) => new Date(now + 8 * 3600000).toISOString().slice(0, 10);

function catalogAppIds() {
  const catalog = JSON.parse(fs.readFileSync(path.join(__dirname, '../../backend/public/AiHankApps/app-catalog.json'), 'utf8'));
  return new Set(catalog.apps.map(app => app.communityId).filter(Boolean));
}

// What a back-end's script printed → the envelope the hub accepts, or the reason it cannot be one.
function toEnvelope(backend, result, { now = Date.now(), appIds = catalogAppIds() } = {}) {
  const value = result && result.value;
  if (!value) return { error: 'no_result', detail: result && result.detail };
  if (value.error) return { error: 'script_failed', detail: value.error };
  const envelope = { schemaVersion: 1, source: backend.id, collectedAt: now, series: value.series || [], facts: value.facts || [], notes: value.notes || [] };
  const stray = envelope.series.map(s => s.app).concat(envelope.facts.map(f => f.app)).filter(app => !backend.apps.includes(app));
  if (stray.length) return { error: 'unexpected_app', detail: [...new Set(stray)].join(',') };
  try { validateEnvelope(envelope, appIds); } catch (error) { return { error: error.code || 'invalid_envelope', detail: error.message }; }
  if (Buffer.byteLength(JSON.stringify(envelope)) > Math.min(MAX_IMPORT_BYTES, MAX_SHELL_ENVELOPE_BYTES)) return { error: 'too_large' };
  return { envelope };
}

// Runs the deployed import script inside the EClaw container with the envelope as one base64 argument.
function importShell(envelope) {
  const encoded = Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64');
  return shellFor(`
const { spawnSync } = require('child_process');
const done = spawnSync(process.execPath, ['scripts/aihankapps-hub-import.js', '${encoded}'], { encoding: 'utf8' });
const line = (done.stdout || '').trim().split('\\n').pop() || (done.stderr || '').trim().split('\\n').pop() || '{}';
let value; try { value = JSON.parse(line); } catch (_error) { value = { success: false, error: 'IMPORT_OUTPUT' }; }
console.log('GIFT_RESULT ' + JSON.stringify(value));
process.exitCode = value.success ? 0 : 1;
`.trim(), HUB_APP_DIRS);
}

// Counts only: what is about to be sent, without the numbers themselves.
function describe(envelope) {
  const byApp = {};
  for (const s of envelope.series) (byApp[s.app] = byApp[s.app] || { series: [], facts: 0 }).series.push(`${s.metric}(${s.start}…${s.values.length} 天)`);
  for (const f of envelope.facts) (byApp[f.app] = byApp[f.app] || { series: [], facts: 0 }).facts += 1;
  return Object.entries(byApp).map(([app, v]) => `  ${app}: ${v.series.join(' ') || '沒有每日數列'}；${v.facts} 個目前數字`).join('\n');
}

function main(argv, { run = runRailway, log = console.log, now = Date.now } = {}) {
  const only = argv.includes('--only') ? String(argv[argv.indexOf('--only') + 1] || '').split(',').filter(Boolean) : null;
  const commit = argv.includes('--commit');
  const unknown = (only || []).filter(id => !BACKENDS.some(b => b.id === id));
  if (unknown.length) { log(`不認得的後台：${unknown.join(', ')}（可用：${BACKENDS.map(b => b.id).join(', ')}）`); return 2; }
  const today = taipeiToday(now()), appIds = catalogAppIds();
  let failures = 0;
  for (const backend of BACKENDS.filter(b => !only || only.includes(b.id))) {
    const built = toEnvelope(backend, run(backend.railway, remoteScript(backend, today), { timeoutMs: 240000 }), { now: now(), appIds });
    if (built.error) { failures += 1; log(`✗ ${backend.name}：讀取失敗（${built.error}${built.detail ? '：' + String(built.detail).slice(-300) : ''}）`); continue; }
    log(`✓ ${backend.name}：讀到 ${built.envelope.series.length} 條每日數列、${built.envelope.facts.length} 個目前數字`);
    log(describe(built.envelope));
    for (const note of built.envelope.notes) log(`  註：${note}`);
    if (!commit) continue;
    const sent = run(HUB, importShell(built.envelope), { timeoutMs: 120000 });
    if (sent.value && sent.value.success) log(`  已匯入管理中樞：${sent.value.values} 個每日數值、${sent.value.facts} 個目前數字`);
    else { failures += 1; log(`  ✗ 匯入失敗（${(sent.value && sent.value.error) || 'no_result'}${sent.detail ? '：' + String(sent.detail).slice(-300) : ''}）`); }
  }
  if (!commit) log('\n這次只讀取、沒有匯入。加上 --commit 才會寫進管理中樞。');
  return failures ? 1 : 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { HUB, MAX_SHELL_ENVELOPE_BYTES, toEnvelope, importShell, describe, main, taipeiToday };
