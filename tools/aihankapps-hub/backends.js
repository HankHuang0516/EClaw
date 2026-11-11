'use strict';

// One entry per back-end that keeps its own database, outside the EClaw server's reach. Each has a small
// read-only script that runs inside that back-end's own container (`railway ssh`), where the database connection
// already exists. The script never prints a connection string or a row: only daily counts and totals come back.
//
// Every question is asked in its own READ ONLY transaction with a statement timeout, so nothing can be written and
// a slow table cannot hold the game's database. A question that fails is noted and the rest continue.
const { shellFor } = require('../aihankapps-gifts/lib/adapters/transport');

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

// Shared by every script. TODAY is the Taipei date the collector runs on; series stop at yesterday because today
// is not over, and start at the first day the table has (earlier days are not "zero", the table did not exist).
function prelude(today) {
  if (!ISO_DAY.test(today)) throw new Error('invalid_today');
  return `
const out = { series: [], facts: [], notes: [] };
const print = () => console.log('GIFT_RESULT ' + JSON.stringify(out));
const TODAY = ${JSON.stringify(today)}, DAYS = 400, DAY = 86400000;
const idx = iso => Math.floor(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / DAY);
const iso = i => new Date(i * DAY).toISOString().slice(0, 10);
const midnight = i => new Date(i * DAY - 8 * 3600000);
const START = idx(TODAY) - DAYS + 1, SINCE = midnight(START);
const day = column => "(" + column + " AT TIME ZONE 'Asia/Taipei')::date::text";
let query;
async function ask(name, sql, params) {
  try { return await query(sql, params || []); } catch (error) { out.notes.push(name + '：讀不到'); return null; }
}
function series(app, metric, rows, firstDay, column) {
  if (!rows || !firstDay) return;
  const from = Math.max(START, idx(firstDay)), to = idx(TODAY) - 1;
  if (to < from) return;
  const values = new Array(to - from + 1).fill(0);
  for (const row of rows) { const i = idx(row.day) - from; if (i >= 0 && i < values.length) values[i] = Number(row[column || 'n']) || 0; }
  out.series.push({ app, metric, start: iso(from), values });
}
function fact(app, key, label, value, unit, order) {
  if (value !== null && value !== undefined) out.facts.push({ app, key, value: { label, value: Number(value), unit, order } });
}
// Weekly sign-up cohorts for the last eight full weeks. A cell is left out until every member of that week has
// reached that day, so a young week is not shown as a poor one.
const COHORT_WEEKS = 8, COHORT_DAYS = [1, 3, 7, 14, 30];
const thisMonday = idx(TODAY) - ((new Date(idx(TODAY) * DAY).getUTCDay() + 6) % 7);
const COHORT_SINCE = midnight(thisMonday - COHORT_WEEKS * 7), COHORT_UNTIL = midnight(thisMonday);
function retention(app, rows, basis) {
  if (!rows || !rows.length) return;
  const cohorts = rows.map(row => {
    const start = idx(row.week), cell = { start: row.week, size: row.size };
    for (const n of COHORT_DAYS) cell['d' + n] = start + 6 + n <= idx(TODAY) - 1 ? row['d' + n] : null;
    return cell;
  });
  out.facts.push({ app, key: 'retention', value: { label: '留存', basis, cohorts } });
}
const cohortSql = (people, personId, born, active, activeId, activeAt) => \`
  WITH cohort AS (SELECT \${personId} AS id, (\${born} AT TIME ZONE 'Asia/Taipei')::date AS d0 FROM \${people} WHERE \${born} >= $1 AND \${born} < $2),
       seen AS (SELECT DISTINCT \${activeId} AS id, (\${activeAt} AT TIME ZONE 'Asia/Taipei')::date AS d FROM \${active} WHERE \${activeAt} >= $1)
  SELECT date_trunc('week', c.d0::timestamp)::date::text AS week, COUNT(*)::int AS size,
    \${COHORT_DAYS.map(n => "(COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM seen s WHERE s.id = c.id AND s.d = c.d0 + " + n + ")))::int AS d" + n).join(', ')}
  FROM cohort c GROUP BY 1 ORDER BY 1\`;
`;
}

// The container's own pg client and DATABASE_URL (REBOUND, the 活字戰紀 server).
const PG = `
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined });
  query = async (sql, params) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN READ ONLY');
      await client.query('SET LOCAL statement_timeout = 20000');
      const result = await client.query(sql, params);
      await client.query('COMMIT');
      return result.rows;
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; } finally { client.release(); }
  };
  const close = () => pool.end();
`;
// Wishlist ships Prisma only.
const PRISMA = `
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient();
  query = (sql, params) => prisma.$transaction(async tx => {
    await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
    await tx.$executeRawUnsafe('SET LOCAL statement_timeout = 20000');
    return tx.$queryRawUnsafe(sql, ...params);
  }, { timeout: 30000 });
  const close = () => prisma.$disconnect();
`;
const wrap = (today, client, body) => `${prelude(today)}
(async () => {
${client}
  try {
${body}
  } finally { await close(); }
  print();
})().catch(error => { out.error = String((error && error.message) || error).slice(0, 200); print(); process.exitCode = 1; });
`.trim();

// ---- REBOUND：元素戰機 ---------------------------------------------------------------------------------------------------
// players (one per installed copy), runs (finished games), mailbox, play_purchases / app_store_purchases.
const rebound = today => wrap(today, PG, `
    const A = 'rebound';
    const born = await ask('玩家', "SELECT " + day('MIN(created_at)') + " AS first, COUNT(*)::int AS total FROM players");
    const first = born && born[0].first;
    fact(A, 'playersTotal', '玩家總數', born && born[0].total, '人', 10);
    series(A, 'newUsers', await ask('新玩家', "SELECT " + day('created_at') + " AS day, COUNT(*)::int AS n FROM players WHERE created_at >= $1 GROUP BY 1", [SINCE]), first);
    const runs = await ask('對局', "SELECT " + day('created_at') + " AS day, COUNT(*)::int AS n, COUNT(DISTINCT player_id)::int AS players FROM runs WHERE created_at >= $1 GROUP BY 1", [SINCE]);
    series(A, 'plays', runs, first);
    series(A, 'activeUsers', runs, first, 'players');
    const recent = await ask('近期活躍', "SELECT (COUNT(DISTINCT player_id) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days'))::int AS d7, COUNT(DISTINCT player_id)::int AS d30, COUNT(*)::int AS runs30 FROM runs WHERE created_at >= NOW() - INTERVAL '30 days'");
    fact(A, 'active7d', '近 7 天有玩的玩家', recent && recent[0].d7, '人', 20);
    fact(A, 'active30d', '近 30 天有玩的玩家', recent && recent[0].d30, '人', 21);
    fact(A, 'runs30d', '近 30 天完成的對局', recent && recent[0].runs30, '局', 22);
    // Google: purchase state 0 is "purchased". Apple: sandbox receipts are left out.
    const bought = "(SELECT player_id, created_at FROM play_purchases WHERE google_purchase_state = 0 UNION ALL SELECT player_id, created_at FROM app_store_purchases WHERE lower(environment) <> 'sandbox') AS bought";
    series(A, 'purchases', await ask('內購', "SELECT " + day('created_at') + " AS day, COUNT(*)::int AS n FROM " + bought + " WHERE created_at >= $1 GROUP BY 1", [SINCE]), first);
    const paying = await ask('付費玩家', "SELECT COUNT(*)::int AS n, COUNT(DISTINCT player_id)::int AS players FROM " + bought);
    fact(A, 'purchasesTotal', '內購筆數（累計）', paying && paying[0].n, '筆', 30);
    fact(A, 'payingPlayers', '付費過的玩家', paying && paying[0].players, '人', 31);
    series(A, 'mailSent', await ask('信件', "SELECT " + day('created_at') + " AS day, COUNT(*)::int AS n FROM mailbox WHERE created_at >= $1 GROUP BY 1", [SINCE]), first);
    series(A, 'mailClaimed', await ask('領取', "SELECT " + day('claimed_at') + " AS day, COUNT(*)::int AS n FROM mailbox WHERE claimed_at >= $1 GROUP BY 1", [SINCE]), first);
    const waiting = await ask('待領信件', "SELECT COUNT(*)::int AS n FROM mailbox WHERE claimed_at IS NULL AND attachments <> '{}'::jsonb AND (expires_at IS NULL OR expires_at > NOW())");
    fact(A, 'mailWaiting', '還沒領取的禮物信', waiting && waiting[0].n, '封', 40);
    retention(A, await ask('留存', cohortSql('players', 'id', 'created_at', 'runs', 'player_id', 'created_at'), [COHORT_SINCE, COHORT_UNTIL]), '註冊後第 N 天當天有完成一局');
`);

// ---- 活字戰紀：雙城烽火 and 巔峰之戰 (one server, one database) ------------------------------------------------------------
// 雙城烽火: players + score_submissions (its leaderboard), the shared mailbox. 巔峰之戰: summit_battle_history.
// Sign-in sessions keep only the latest per device, so they can say who signed in lately but not a daily history.
const summit = today => wrap(today, PG, `
    const D = 'typeforge-twin-cities', S = 'summit-battle';
    const born = await ask('雙城玩家', "SELECT " + day('MIN(created_at)') + " AS first, COUNT(*)::int AS total FROM players");
    const first = born && born[0].first;
    fact(D, 'playersTotal', '排行榜玩家總數', born && born[0].total, '人', 10);
    series(D, 'newUsers', await ask('雙城新玩家', "SELECT " + day('created_at') + " AS day, COUNT(*)::int AS n FROM players WHERE created_at >= $1 GROUP BY 1", [SINCE]), first);
    const scores = await ask('雙城成績', "SELECT " + day('submitted_at') + " AS day, COUNT(*)::int AS n, COUNT(DISTINCT player_id)::int AS players FROM score_submissions WHERE submitted_at >= $1 GROUP BY 1", [SINCE]);
    series(D, 'plays', scores, first);
    series(D, 'activeUsers', scores, first, 'players');
    const recent = await ask('雙城近期', "SELECT (COUNT(DISTINCT player_id) FILTER (WHERE submitted_at >= NOW() - INTERVAL '7 days'))::int AS d7, COUNT(DISTINCT player_id)::int AS d30 FROM score_submissions WHERE submitted_at >= NOW() - INTERVAL '30 days'");
    fact(D, 'active7d', '近 7 天有送出成績的玩家', recent && recent[0].d7, '人', 20);
    fact(D, 'active30d', '近 30 天有送出成績的玩家', recent && recent[0].d30, '人', 21);
    retention(D, await ask('雙城留存', cohortSql('players', 'id', 'created_at', 'score_submissions', 'player_id', 'submitted_at'), [COHORT_SINCE, COHORT_UNTIL]), '第一次上榜後第 N 天當天有送出成績');

    const accounts = await ask('帳號', "SELECT product, COUNT(DISTINCT account_id)::int AS n FROM summit_device_bindings GROUP BY 1");
    const signedIn = await ask('登入', "SELECT product, (COUNT(DISTINCT account_id) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days'))::int AS d7, (COUNT(DISTINCT account_id) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days'))::int AS d30 FROM summit_auth_sessions GROUP BY 1");
    for (const [app, product] of [[D, 'dual-city'], [S, 'summit-battle']]) {
      const a = (accounts || []).find(row => row.product === product), s = (signedIn || []).find(row => row.product === product);
      fact(app, 'accountsTotal', '綁定帳號的裝置帳號數', accounts ? (a ? a.n : 0) : null, '個', 12);
      fact(app, 'signedIn7d', '近 7 天登入過的帳號', signedIn ? (s ? s.d7 : 0) : null, '個', 24);
      fact(app, 'signedIn30d', '近 30 天登入過的帳號', signedIn ? (s ? s.d30 : 0) : null, '個', 25);
    }
    // 帳號註冊人數（Hank 2026-11-11）：綁定到這款遊戲的帳號，依帳號建立時間算近 7／30 天新增；只有數量
    const fresh = await ask('新帳號', "SELECT b.product, (COUNT(DISTINCT a.account_id) FILTER (WHERE a.created_at >= NOW() - INTERVAL '7 days'))::int AS d7, (COUNT(DISTINCT a.account_id) FILTER (WHERE a.created_at >= NOW() - INTERVAL '30 days'))::int AS d30 FROM summit_accounts a JOIN summit_device_bindings b ON b.account_id = a.account_id GROUP BY 1");
    for (const [app, product] of [[D, 'dual-city'], [S, 'summit-battle']]) {
      const f = (fresh || []).find(row => row.product === product);
      fact(app, 'accountsNew7d', '近 7 天新註冊的帳號', fresh ? (f ? f.d7 : 0) : null, '個', 13);
      fact(app, 'accountsNew30d', '近 30 天新註冊的帳號', fresh ? (f ? f.d30 : 0) : null, '個', 14);
    }
    const at = "to_timestamp(received_at_ms / 1000.0)";
    const battleFirst = await ask('巔峰對戰', "SELECT " + day('MIN(' + at + ')') + " AS first FROM summit_battle_history WHERE product = 'summit-battle'");
    const battles = await ask('巔峰對戰', "SELECT " + day(at) + " AS day, COUNT(DISTINCT match_id)::int AS n, COUNT(DISTINCT account_id)::int AS players FROM summit_battle_history WHERE product = 'summit-battle' AND received_at_ms >= $1 GROUP BY 1", [SINCE.getTime()]);
    series(S, 'plays', battles, battleFirst && battleFirst[0].first);
    series(S, 'activeUsers', battles, battleFirst && battleFirst[0].first, 'players');
    const newAccounts = await ask('巔峰新帳號', "SELECT " + day('a.created_at') + " AS day, COUNT(DISTINCT a.account_id)::int AS n FROM summit_accounts a JOIN summit_device_bindings b ON b.account_id = a.account_id AND b.product = 'summit-battle' WHERE a.created_at >= $1 GROUP BY 1", [SINCE]);
    const accountFirst = await ask('巔峰新帳號', "SELECT " + day('MIN(a.created_at)') + " AS first FROM summit_accounts a JOIN summit_device_bindings b ON b.account_id = a.account_id AND b.product = 'summit-battle'");
    series(S, 'newUsers', newAccounts, accountFirst && accountFirst[0].first);

    // Real purchases only: completed, not a test purchase.
    const bought = await ask('外觀購買', "SELECT product, " + day('COALESCE(completed_at, created_at)') + " AS day, COUNT(*)::int AS n FROM summit_cosmetic_purchases WHERE status = 'purchased' AND NOT is_test AND COALESCE(completed_at, created_at) >= $1 GROUP BY 1, 2", [SINCE]);
    const boughtAll = await ask('外觀購買', "SELECT product, COUNT(*)::int AS n, COUNT(DISTINCT account_id)::int AS accounts, " + day('MIN(COALESCE(completed_at, created_at))') + " AS first FROM summit_cosmetic_purchases WHERE status = 'purchased' AND NOT is_test GROUP BY 1");
    for (const [app, product] of [[D, 'dual-city'], [S, 'summit-battle']]) {
      const all = (boughtAll || []).find(row => row.product === product);
      if (bought && all) series(app, 'purchases', bought.filter(row => row.product === product), all.first);
      fact(app, 'purchasesTotal', '外觀購買筆數（累計）', boughtAll ? (all ? all.n : 0) : null, '筆', 30);
      fact(app, 'payingPlayers', '付費過的帳號', boughtAll ? (all ? all.accounts : 0) : null, '個', 31);
    }
    const mailFirst = await ask('信箱', "SELECT " + day('MIN(created_at)') + " AS first FROM summit_mailbox");
    series(D, 'mailSent', await ask('信箱', "SELECT " + day('created_at') + " AS day, COUNT(*)::int AS n FROM summit_mailbox WHERE created_at >= $1 GROUP BY 1", [SINCE]), mailFirst && mailFirst[0].first);
    series(D, 'mailClaimed', await ask('信箱領取', "SELECT " + day('claimed_at') + " AS day, COUNT(*)::int AS n FROM summit_mailbox WHERE claimed_at >= $1 GROUP BY 1", [SINCE]), mailFirst && mailFirst[0].first);
    const waiting = await ask('待領信件', "SELECT COUNT(*)::int AS n FROM summit_mailbox WHERE claimed_at IS NULL AND deleted_at IS NULL AND kind <> 'notice' AND (expires_at IS NULL OR expires_at > NOW())");
    fact(D, 'mailWaiting', '還沒領取的禮物信', waiting && waiting[0].n, '封', 40);
    out.notes.push('雙城烽火與巔峰之戰的登入紀錄每台裝置只留最後一次，所以只有「近 7 天／30 天登入過」，沒有每天的登入人數；每日活躍用的是送出成績或完成對戰的人數。');
`);

// ---- Wishlist.ai ---------------------------------------------------------------------------------------------------------
// Prisma tables keep their model names. "Active" is someone who sent a message or put up a listing that day.
const wishlist = today => wrap(today, PRISMA, `
    const A = 'weesh';
    const born = await ask('帳號', 'SELECT ' + day('MIN("createdAt")') + ' AS first, COUNT(*)::int AS total FROM "User"');
    const first = born && born[0].first;
    fact(A, 'usersTotal', '註冊帳號總數', born && born[0].total, '個', 10);
    const fresh = await ask('新帳號', 'SELECT (COUNT(*) FILTER (WHERE "createdAt" >= NOW() - INTERVAL \\'7 days\\'))::int AS d7, (COUNT(*) FILTER (WHERE "createdAt" >= NOW() - INTERVAL \\'30 days\\'))::int AS d30 FROM "User"');
    fact(A, 'accountsNew7d', '近 7 天新註冊的帳號', fresh && fresh[0].d7, '個', 11);
    fact(A, 'accountsNew30d', '近 30 天新註冊的帳號', fresh && fresh[0].d30, '個', 12);
    series(A, 'newUsers', await ask('新帳號', 'SELECT ' + day('"createdAt"') + ' AS day, COUNT(*)::int AS n FROM "User" WHERE "createdAt" >= $1 GROUP BY 1', [SINCE]), first);
    series(A, 'messages', await ask('訊息', 'SELECT ' + day('"createdAt"') + ' AS day, COUNT(*)::int AS n FROM "Message" WHERE "createdAt" >= $1 GROUP BY 1', [SINCE]), first);
    const doing = '(SELECT "senderUserId" AS uid, "createdAt" AS t FROM "Message" WHERE "createdAt" >= $1 UNION ALL SELECT "ownerUserId", "createdAt" FROM "Listing" WHERE "createdAt" >= $1) AS doing';
    series(A, 'activeUsers', await ask('活躍', 'SELECT ' + day('t') + ' AS day, COUNT(DISTINCT uid)::int AS n FROM ' + doing + ' GROUP BY 1', [SINCE]), first);
    const recent = await ask('近期活躍', 'SELECT (COUNT(DISTINCT uid) FILTER (WHERE t >= NOW() - INTERVAL \\'7 days\\'))::int AS d7, COUNT(DISTINCT uid)::int AS d30 FROM ' + doing, [new Date(Date.now() - 30 * DAY)]);
    fact(A, 'active7d', '近 7 天傳訊息或刊登的帳號', recent && recent[0].d7, '個', 20);
    fact(A, 'active30d', '近 30 天傳訊息或刊登的帳號', recent && recent[0].d30, '個', 21);
    const talks = await ask('對話', 'SELECT COUNT(*)::int AS n FROM "Conversation"');
    fact(A, 'conversationsTotal', '買賣對話（累計）', talks && talks[0].n, '個', 26);
    const paid = 'FROM "Purchase" WHERE status = \\'COMPLETED\\' AND currency = \\'TWD\\' AND amount > 0';
    const paidRows = await ask('付費', 'SELECT ' + day('"createdAt"') + ' AS day, COUNT(*)::int AS n, SUM(amount)::float8 AS twd ' + paid + ' AND "createdAt" >= $1 GROUP BY 1', [SINCE]);
    series(A, 'purchases', paidRows, first);
    series(A, 'purchaseTwd', paidRows, first, 'twd');
    const paidAll = await ask('付費', 'SELECT COUNT(*)::int AS n, COUNT(DISTINCT "userId")::int AS users ' + paid);
    fact(A, 'purchasesTotal', '付費筆數（累計）', paidAll && paidAll[0].n, '筆', 30);
    fact(A, 'payingPlayers', '付費過的帳號', paidAll && paidAll[0].users, '個', 31);
    retention(A, await ask('留存', cohortSql('"User"', 'id', '"createdAt"', doing.replace(' AS doing', ' AS did'), 'uid', 't'), [COHORT_SINCE, COHORT_UNTIL]), '註冊後第 N 天當天有傳訊息或刊登');
`);

const BACKENDS = [
  { id: 'rebound', name: 'REBOUND 遊戲伺服器', apps: ['rebound'], appDirs: ['/app/server', '/app'], script: rebound,
    railway: { project: 'rebound-live', projectId: '642452f8-405c-4d07-8565-bd409a136fe8', environment: 'production', service: 'rebound-api' } },
  { id: 'summit', name: '活字戰紀伺服器', apps: ['typeforge-twin-cities', 'summit-battle'], appDirs: ['/app'], script: summit,
    railway: { project: 'noble-fascination', projectId: '68db2b85-9ead-420e-abec-587eb84b41b1', environment: 'production', service: 'summit-battle-api' } },
  { id: 'wishlist', name: 'Wishlist.ai', apps: ['weesh'], appDirs: ['/app/server', '/app'], script: wishlist,
    railway: { project: 'thorough-presence', projectId: 'c4bb972e-46b8-4e54-a9d1-5d38f619879a', environment: 'production', service: 'wishlist-app' } },
];

// The shell text that runs inside the back-end's container.
const remoteScript = (backend, today) => shellFor(backend.script(today), backend.appDirs);

module.exports = { BACKENDS, remoteScript };
