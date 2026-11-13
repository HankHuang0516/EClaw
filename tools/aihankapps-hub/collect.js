#!/usr/bin/env node
'use strict';

// Collects daily counts from the back-ends that keep their own databases and hands them to the admin hub.
//
//   node tools/aihankapps-hub/collect.js                 read every back-end, show what would be sent, send nothing
//   node tools/aihankapps-hub/collect.js --commit        read, then import into the hub
//   node tools/aihankapps-hub/collect.js --only rebound  one back-end (ids: rebound, summit, wishlist, wishlist-users, railway, timehut, attention)
//
// `railway` is different: it runs on this Mac and reads every service's traffic, CPU, memory, space and deployment
// status from Railway's metrics API with this Mac's Railway CLI login (railway-metrics.js), read-only.
//
// `timehut` also runs on this Mac: 時光相簿 keeps its accounts in its own server's files, so the server answers the
// counts itself (GET /api/internal/account-stats, counts only) to one shared key. On this Mac the key lives only in
// ~/.config/aihankapps-hub/timehut-stats-key (mode 600, never in git, never printed); on the server it is the Railway
// variable TIMEHUT_STATS_KEY.
//
// `wishlist-users` is the per-account detail behind the Weesh page's 帳戶智慧數據庫 (Hank 2026-11-13). It runs in the
// Wishlist container like `wishlist`, read-only, and brings back one fact per account: counts and times, plus the
// account's display name and a masked sign-in address so the admin can tell accounts apart (backends.js says what
// it never reads).
//
// Reading runs inside each back-end's own container and is read-only. Importing runs the deployed
// backend/scripts/aihankapps-hub-import.js inside the EClaw container. Both go through `railway ssh`, so the
// operator's Railway login is the only credential involved and no secret passes through this tool.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runRailway, shellFor } = require('../aihankapps-gifts/lib/adapters/transport');
const { BACKENDS, DETAIL, remoteScript } = require('./backends');
const railway = require('./railway-metrics');
const { validateEnvelope, MAX_IMPORT_BYTES } = require('../../backend/aihankapps-hub-store');

const HUB = { project: 'Clawdbot', projectId: '844a6139-9b8f-43d6-a698-f97db1fa05c0', environment: 'production', service: 'eclaw' };
const HUB_APP_DIRS = ['/app/backend', '/app'];
// The envelope travels as one command-line argument (twice base64-encoded); Linux caps a single argument at 128 KiB.
const MAX_SHELL_ENVELOPE_BYTES = 60 * 1024;
const taipeiToday = (now = Date.now()) => new Date(now + 8 * 3600000).toISOString().slice(0, 10);

// 時光相簿 account counts (Hank 2026-11-11). The answer is { total, last7d, last30d, deleted, asOf }: counts only.
// total leaves out deleted accounts; last7d / last30d are null when the server cannot tell (then they are not sent).
const TIMEHUT_STATS_URL = 'https://just-healing-production.up.railway.app/api/internal/account-stats';
// 每個帳戶的明細（Hank 2026-11-13「每個用戶的辨識的詳細數據…相簿照片影片總數量／上傳or下載使用了多少流量」「要用成智慧互動UX」）：
// 時光相簿 1.0.118 起同一把金鑰可讀 /api/internal/admin-stats。舊版伺服器回 401／404 時只少了明細，帳號總數照常匯入。
const TIMEHUT_ADMIN_URL = 'https://just-healing-production.up.railway.app/api/internal/admin-stats';
const TIMEHUT_DETAIL_BUDGET = 45 * 1024; // 整包信封上限 60 KB，明細最多用這麼多，超過就先略過最不活躍的人
const TIMEHUT_KEY_FILE = path.join(os.homedir(), '.config', 'aihankapps-hub', 'timehut-stats-key');
function readTimehutKey(file = TIMEHUT_KEY_FILE) {
  let stat;
  try { stat = fs.lstatSync(file); } catch (_error) { return { error: 'key file missing (' + file + ')' }; }
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) return { error: 'key file must be a regular file only its owner can read (chmod 600)' };
  const key = fs.readFileSync(file, 'utf8').trim();
  return /^[A-Za-z0-9_-]{32,256}$/.test(key) ? { key } : { error: 'key file content is not a key' };
}
async function collectTimehut({ fetchImpl = fetch, readKey = readTimehutKey } = {}) {
  const found = readKey();
  if (found.error) return { value: null, detail: found.error };
  let res;
  try {
    res = await fetchImpl(TIMEHUT_STATS_URL, { headers: { Authorization: 'Bearer ' + found.key, Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(20000) });
  } catch (error) { return { value: null, detail: 'request failed (' + ((error && error.name) || 'error') + ')' }; }
  if (res.status !== 200) return { value: null, detail: 'HTTP ' + res.status };
  let body;
  try { body = await res.json(); } catch (_error) { return { value: null, detail: 'answer is not JSON' }; }
  const n = v => (Number.isSafeInteger(v) && v >= 0 ? v : null);
  if (!body || n(body.total) === null) return { value: null, detail: 'unexpected answer' };
  const facts = [], A = 'timehut';
  const fact = (key, label, value, order) => { if (value !== null) facts.push({ app: A, key, value: { label, value, unit: '個', order } }); };
  fact('accountsTotal', '註冊帳號總數（不含已刪除）', n(body.total), 10);
  fact('accountsNew7d', '近 7 天新註冊的帳號', n(body.last7d), 11);
  fact('accountsNew30d', '近 30 天新註冊的帳號', n(body.last30d), 12);
  fact('accountsDeleted', '已刪除的帳號（不計入總數）', n(body.deleted), 13);
  const notes = n(body.last7d) === null || n(body.last30d) === null ? ['時光相簿沒有回近 7／30 天的數字（帳號缺建立時間）'] : [];
  const detail = await collectTimehutDetail({ fetchImpl, key: found.key });
  facts.push(...detail.facts);
  notes.push(...detail.notes);
  return { value: { series: [], facts, notes } };
}
// 一位用戶一個事實（每個事實上限 8 KB）：thUser＋伺服器給的 10 碼代號；另有一個 thUsersMeta 放共同的資訊。
// 這些事實沒有 label，所以不會出現在一般的數字格裡，只給拾光頁的用戶明細用。不帶帳號 ID、照片編號、LINE 帳號或檔名。
function timehutUserFact(u) {
  const n = v => (Number.isSafeInteger(v) && v >= 0 ? v : null), t = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);
  const at = v => (Number.isSafeInteger(v) && v > 0 ? v : null), obj = v => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
  const counts = (o, keys, max) => Object.fromEntries(Object.entries(obj(o) || {}).filter(([k, v]) => /^[A-Za-z_]{2,40}$/.test(k) && n(v) && (!keys || keys.includes(k))).sort((a, b) => b[1] - a[1]).slice(0, max));
  const line = obj(u.line), media = obj(u.media) || {}, up = obj(u.uploads), ai = obj(u.ai), tr = obj(u.traffic), hist = obj(u.history) || {};
  return {
    v: 1, name: t(u.name, 40), login: t(u.login, 12), owner: u.owner === true, createdAt: at(u.createdAt), lastLoginAt: at(u.lastLoginAt),
    albums: (Array.isArray(u.albums) ? u.albums : []).slice(0, 30).map(a => [t(a && a.title, 24), a && a.kind === 'family' ? 'f' : 'a', n(a && a.photos), n(a && a.videos), a && a.archived ? 1 : 0]),
    media: { albums: n(media.albums), archived: n(media.archivedAlbums), photos: n(media.photos), videos: n(media.videos), familyPhotos: n(media.familyPhotos), familyVideos: n(media.familyVideos),
      accountPhotos: n(media.accountPhotos), accountVideos: n(media.accountVideos), storedBytes: n(media.storedBytes), deleted: n(media.deleted) },
    line: line ? { received: n(line.received), videos: n(line.videos), bytes: n(line.bytes), recognized: n(line.recognized), stages: counts(line.stages, null, 13), reasons: counts(line.reasons, null, 12),
      oldestWaitingAt: at(line.oldestWaitingAt), lastReceivedAt: at(line.lastReceivedAt),
      days: (Array.isArray(line.days) ? line.days : []).filter(d => d && /^\d{4}-\d{2}-\d{2}$/.test(d.day)).slice(-30).map(d => [d.day, n(d.received) || 0, n(d.uploaded) || 0, n(d.excluded) || 0, n(d.failed) || 0, n(d.waiting) || 0]) } : null,
    uploads: up ? { total: n(up.total), completed: n(up.completed), failed: n(up.failed), waiting: n(up.waiting), cancelled: n(up.cancelled), bytes: n(up.bytes) } : null,
    ai: ai ? { analyzed: n(ai.analyzed), pending: n(ai.pending), failed: n(ai.failed), unconfirmed: n(ai.unconfirmed), retrying: n(ai.retrying), enabled: ai.enabled === true } : null,
    history: { appUploadBytes: n(hist.appUploadBytes), lineReceivedBytes: n(hist.lineReceivedBytes) },
    traffic: tr ? { since: typeof tr.since === 'string' ? tr.since.slice(0, 30) : null, inBytes: n(tr.inBytes), outBytes: n(tr.outBytes), mediaOutBytes: n(tr.mediaOutBytes), uploadInBytes: n(tr.uploadInBytes), requests: n(tr.requests),
      days: (Array.isArray(tr.days) ? tr.days : []).filter(d => d && /^\d{4}-\d{2}-\d{2}$/.test(d.day)).slice(-30).map(d => [d.day, n(d.in) || 0, n(d.out) || 0, n(d.mediaOut) || 0]) } : null
  };
}
async function collectTimehutDetail({ fetchImpl, key }) {
  let res;
  try { res = await fetchImpl(TIMEHUT_ADMIN_URL, { headers: { Authorization: 'Bearer ' + key, Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(30000) }); } catch (error) { return { facts: [], notes: ['用戶明細讀取失敗（' + ((error && error.name) || 'error') + '）'] }; }
  if (res.status === 401 || res.status === 404) return { facts: [], notes: ['時光相簿伺服器還沒有用戶明細（後端 1.0.118 起才有）'] };
  if (res.status !== 200) return { facts: [], notes: ['用戶明細讀取失敗（HTTP ' + res.status + '）'] };
  let body;
  try { body = await res.json(); } catch (_error) { return { facts: [], notes: ['用戶明細不是 JSON'] }; }
  if (!body || body.schemaVersion !== 1 || !Array.isArray(body.users)) return { facts: [], notes: ['用戶明細格式不認得'] };
  const valid = body.users.filter(u => u && typeof u.ref === 'string' && /^[a-f0-9]{10}$/.test(u.ref));
  // 最活躍的人先放：最近收到 LINE、最近登入、流量多的排前面；超過預算的人只少了明細，畫面會標出來
  const score = u => Math.max((u.line && u.line.lastReceivedAt) || 0, u.lastLoginAt || 0) + ((u.traffic && u.traffic.outBytes) || 0) / 1e3;
  const facts = [], notes = [];let used = 0, dropped = 0;
  for (const u of valid.slice().sort((a, b) => score(b) - score(a))) {
    // 每個事實的上限是用字元數算的（8 KB），整包信封是用 UTF-8 位元組算的：中文一個字三個位元組，預算要用位元組
    const value = timehutUserFact(u), text = JSON.stringify(value), size = Buffer.byteLength(text);
    if (text.length > 8000 || used + size > TIMEHUT_DETAIL_BUDGET) { dropped += 1; continue; }
    used += size;facts.push({ app: 'timehut', key: 'thUser' + u.ref, value });
  }
  if (dropped) notes.push(`用戶明細太多，這次略過 ${dropped} 位最不活躍的人`);
  const n = v => (Number.isSafeInteger(v) && v >= 0 ? v : null), un = body.unattributed && typeof body.unattributed === 'object' ? body.unattributed : null;
  facts.push({ app: 'timehut', key: 'thUsersMeta', value: { v: 1, asOf: typeof body.asOf === 'string' ? body.asOf.slice(0, 30) : null, version: typeof body.version === 'string' ? body.version.slice(0, 16) : null,
    trafficSince: typeof body.trafficSince === 'string' ? body.trafficSince.slice(0, 30) : null, users: valid.length, shown: facts.length, dropped,
    unattributed: un ? { inBytes: n(un.inBytes), outBytes: n(un.outBytes), requests: n(un.requests) } : null,
    notes: (Array.isArray(body.notes) ? body.notes : []).filter(x => typeof x === 'string').slice(0, 6).map(x => x.slice(0, 120)) } });
  return { facts, notes };
}

// 上架警示板 (Hank 2026-11-12: "如果真的有任何上架需要我來介入處理 你可以直接打嚴重需要人為介入的警示"). The listing
// schedules on this Mac keep a board of what they cannot fix by themselves; their own tool writes a summary of it to
// ATTENTION_FILE. This source only carries that summary to the hub, where every entry that needs a person becomes a
// severe alert. Titles and details are written for Hank by the schedules (their tool refuses anything that looks
// like a key or a phone number); nothing else from the Mac is read.
const ATTENTION_FILE = process.env.AIHANKAPPS_HUB_ATTENTION_FILE || path.join(os.homedir(), '.local', 'share', 'aihankapps-hub', 'attention-summary.json');
const ATTENTION_MAX_ITEMS = 12;
function collectAttention({ file = ATTENTION_FILE, now = Date.now(), read = fs.readFileSync } = {}) {
  let body;
  try { body = JSON.parse(read(file, 'utf8')); } catch (_error) { return { value: null, detail: 'no readable summary (' + file + ')' }; }
  const at = body && Date.parse(body.observedAt);
  if (!body || body.schemaVersion !== 1 || !Array.isArray(body.items) || !Number.isFinite(at) || at > now + 5 * 60000) return { value: null, detail: 'unexpected summary' };
  const text = (v, max) => String(v === null || v === undefined ? '' : v).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);
  const valid = body.items.filter(x => x && typeof x.id === 'string' && /^[a-z0-9][a-z0-9-]{2,59}$/.test(x.id) && (x.kind === 'human' || x.kind === 'healing') && Number.isFinite(Date.parse(x.since)) && text(x.title, 80));
  // People first, oldest first: when the board is longer than the hub keeps, nothing that needs Hank is dropped for a healing entry.
  const items = valid.sort((a, b) => (a.kind === b.kind ? Date.parse(a.since) - Date.parse(b.since) : a.kind === 'human' ? -1 : 1)).slice(0, ATTENTION_MAX_ITEMS)
    .map(x => ({ id: x.id, kind: x.kind, platform: text(x.platform, 20), title: text(x.title, 80), detail: text(x.detail, 200), since: Date.parse(x.since), count: Number.isSafeInteger(x.count) && x.count > 0 ? x.count : 1 }));
  const human = valid.filter(x => x.kind === 'human').length;
  const notes = valid.length > items.length ? [`警示板有 ${valid.length} 項，只送前 ${items.length} 項`] : [];
  return { value: { series: [], facts: [{ app: 'weesh', key: 'attention', value: { label: '需要人為介入', value: human, unit: '件', order: 5, boardAt: at, healing: valid.length - human, items } }], notes } };
}

// Sources read on this Mac rather than inside a back-end's container.
const LOCAL = [{ id: 'railway', name: 'Railway 後台資源', apps: railway.RAILWAY_APPS,
  async collect(now) {
    const token = railway.readToken();
    if (!token) return { value: null, detail: 'Railway CLI login missing (run railway login)' };
    try { return { value: await railway.collectRailway({ now, gql: railway.client(token) }) }; } catch (error) { return { value: null, detail: String(error.message || error) }; }
  } },
  { id: 'timehut', name: '時光相簿伺服器', apps: ['timehut'], collect: () => collectTimehut() },
  { id: 'attention', name: '上架警示板', apps: ['weesh'], collect: now => collectAttention({ now }) }];
const SOURCES = BACKENDS.concat(DETAIL, LOCAL);

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
  if (Array.isArray(value.infra)) envelope.infra = value.infra;
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

async function main(argv, { run = runRailway, log = console.log, now = Date.now, sources = SOURCES } = {}) {
  const only = argv.includes('--only') ? String(argv[argv.indexOf('--only') + 1] || '').split(',').filter(Boolean) : null;
  const commit = argv.includes('--commit');
  const unknown = (only || []).filter(id => !sources.some(b => b.id === id));
  if (unknown.length) { log(`不認得的後台：${unknown.join(', ')}（可用：${sources.map(b => b.id).join(', ')}）`); return 2; }
  const today = taipeiToday(now()), appIds = catalogAppIds();
  let failures = 0;
  for (const backend of sources.filter(b => !only || only.includes(b.id))) {
    const result = backend.collect ? await backend.collect(now()) : run(backend.railway, remoteScript(backend, today), { timeoutMs: 240000 });
    const built = toEnvelope(backend, result, { now: now(), appIds });
    if (built.error) { failures += 1; log(`✗ ${backend.name}：讀取失敗（${built.error}${built.detail ? '：' + String(built.detail).slice(-300) : ''}）`); continue; }
    log(`✓ ${backend.name}：讀到 ${built.envelope.series.length} 條每日數列、${built.envelope.facts.length} 個目前數字` + (built.envelope.infra ? `、${built.envelope.infra.length} 個服務的資源數字` : ''));
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

if (require.main === module) main(process.argv.slice(2)).then(code => { process.exitCode = code; });

module.exports = { HUB, MAX_SHELL_ENVELOPE_BYTES, LOCAL, SOURCES, TIMEHUT_STATS_URL, TIMEHUT_ADMIN_URL, TIMEHUT_KEY_FILE, readTimehutKey, collectTimehut, collectTimehutDetail, timehutUserFact, toEnvelope, importShell, describe, main, taipeiToday, collectAttention, ATTENTION_FILE };
