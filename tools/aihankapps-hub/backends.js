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

// ---- Wishlist.ai：每個帳戶的明細 --------------------------------------------------------------------------------------------
// Hank 2026-11-13：管理中樞的 Weesh 頁「缺少帳戶智慧數據庫（可參考拾光）」。拾光的明細由它的伺服器自己回答；Wishlist 的資料都在
// 資料庫裡，所以在它自己的容器裡用同一條唯讀通道問，一個帳戶一筆事實（wlUser＋10 碼代號）加一筆 wlUsersMeta。
//
// 這支和上面三支不同：它會帶回「帳戶顯示名稱」與「遮蔽過的登入信箱」，好讓管理者認得是哪個帳戶。遮蔽在資料庫的查詢裡做
// （信箱只留 @ 前兩個字與網域、電話只留末三碼），完整的信箱與電話不會離開資料庫；代號是帳戶編號的雜湊前 10 碼，不帶編號本身。
// 不讀密碼、驗證碼、各種 token、API 金鑰本身、真實姓名、地址、生日，也不讀任何願望、刊登、訊息的文字或照片：只有數量與時間。
// 這個函式的原始碼會原封不動送進容器執行（下面用 toString 取出），所以裡面用到的 ask／out／day／DAY 是容器裡那份前置程式的。
/* global ask, out, day, DAY */
async function wishlistUsersBody() {
  const A = 'weesh', MAX_USERS = 190, BUDGET = 44 * 1024;
  const ms = column => '(EXTRACT(EPOCH FROM ' + column + ') * 1000)::float8';
  const since30 = new Date(Date.now() - 30 * DAY);
  const users = await ask('帳戶', `SELECT id AS uid, substr(md5('weesh-user:' || id::text), 1, 10) AS ref, left(btrim(name), 40) AS shown,
      CASE WHEN email IS NOT NULL THEN left(split_part(email, '@', 1), 2) || '***@' || split_part(email, '@', 2)
           WHEN "phoneNumber" IS NOT NULL THEN '***' || right("phoneNumber", 3) END AS login,
      "isEmailVerified" AS ev, "isPhoneVerified" AS pv, "isPremium" AS premium, "subscriptionStatus" AS sub, ${ms('"subscriptionExpiresAt"')} AS "subUntil",
      ("apiKey" IS NOT NULL) AS api, "aiUsageCount"::int AS ai, ${ms('"createdAt"')} AS created FROM "User"`);
  if (!users) return;
  const wishes = await ask('願望', `SELECT w."userId" AS uid, COUNT(*)::int AS n, (COUNT(*) FILTER (WHERE i."isPurchased"))::int AS bought,
      (COUNT(*) FILTER (WHERE i."isHidden"))::int AS hidden, (COUNT(*) FILTER (WHERE i."aiStatus" = 'FAILED'))::int AS "aiFailed",
      (COUNT(*) FILTER (WHERE i."createdAt" >= $1))::int AS d30, ${ms('MAX(i."createdAt")')} AS last
      FROM "Item" i JOIN "Wishlist" w ON w.id = i."wishlistId" GROUP BY 1`, [since30]);
  const lists = await ask('清單', 'SELECT "userId" AS uid, COUNT(*)::int AS n, (COUNT(*) FILTER (WHERE "isPublic"))::int AS pub FROM "Wishlist" GROUP BY 1');
  const linked = await ask('探索加入', 'SELECT "userId" AS uid, COUNT(*)::int AS n, ' + ms('MAX("createdAt")') + ' AS last FROM "ProductWishLink" GROUP BY 1');
  const watches = await ask('關注', 'SELECT "userId" AS uid, COUNT(*)::int AS n FROM "ItemWatch" GROUP BY 1');
  const listings = await ask('刊登', `SELECT "ownerUserId" AS uid, status::text AS status, COUNT(*)::int AS n, (COUNT(*) FILTER (WHERE "createdAt" >= $1))::int AS d30,
      ${ms('MAX("createdAt")')} AS last FROM "Listing" GROUP BY 1, 2`, [since30]);
  const talks = await ask('對話', `SELECT uid, (COUNT(*) FILTER (WHERE side = 'b'))::int AS buy, (COUNT(*) FILTER (WHERE side = 's'))::int AS sell, ${ms('MAX(t)')} AS last
      FROM (SELECT "buyerUserId" AS uid, 'b' AS side, "lastMessageAt" AS t FROM "Conversation" WHERE "buyerUserId" IS NOT NULL
            UNION ALL SELECT "sellerUserId", 's', "lastMessageAt" FROM "Conversation" WHERE "sellerUserId" IS NOT NULL) AS c GROUP BY 1`);
  // 未讀：對話裡最新一則不是自己傳的，而且還沒讀到那一則
  const unread = await ask('未讀', `SELECT p."userId" AS uid, COUNT(*)::int AS n, ${ms('MIN(c."lastMessageAt")')} AS oldest
      FROM "ConversationParticipant" p JOIN "Conversation" c ON c.id = p."conversationId"
      JOIN "Message" m ON m."conversationId" = c.id AND m.sequence = c."lastMessageSequence"
      WHERE c."archivedAt" IS NULL AND c."lastMessageSequence" > p."lastReadSequence" AND m."senderUserId" <> p."userId" GROUP BY 1`);
  const sent = await ask('訊息', `SELECT "senderUserId" AS uid, COUNT(*)::int AS n, (COUNT(*) FILTER (WHERE "createdAt" >= $1))::int AS d30, ${ms('MAX("createdAt")')} AS last
      FROM "Message" GROUP BY 1`, [since30]);
  const inquiries = await ask('來源詢問', 'SELECT "buyerUserId" AS uid, COUNT(*)::int AS n, ' + ms('MAX("updatedAt")') + ' AS last FROM "SourceLeadInquiry" GROUP BY 1');
  const meets = await ask('面交', `SELECT uid, COUNT(*)::int AS n, (COUNT(*) FILTER (WHERE status IN ('PROPOSED', 'CONFIRMED')))::int AS open, (COUNT(*) FILTER (WHERE status = 'COMPLETED'))::int AS done
      FROM (SELECT c."buyerUserId" AS uid, a.status::text AS status FROM "MeetupAppointment" a JOIN "Conversation" c ON c.id = a."conversationId" WHERE c."buyerUserId" IS NOT NULL
            UNION ALL SELECT c."sellerUserId", a.status::text FROM "MeetupAppointment" a JOIN "Conversation" c ON c.id = a."conversationId" WHERE c."sellerUserId" IS NOT NULL) AS x GROUP BY 1`);
  const paid = await ask('付費', `SELECT "userId" AS uid, COUNT(*)::int AS n, SUM(amount)::float8 AS twd, ${ms('MAX("createdAt")')} AS last
      FROM "Purchase" WHERE status = 'COMPLETED' AND currency = 'TWD' AND amount > 0 AND "userId" IS NOT NULL GROUP BY 1`);
  const follows = await ask('追蹤', `SELECT uid, SUM(a)::int AS following, SUM(b)::int AS followers
      FROM (SELECT "followerId" AS uid, 1 AS a, 0 AS b FROM "Follow" UNION ALL SELECT "followingId", 0, 1 FROM "Follow") AS f GROUP BY 1`);
  const devices = await ask('裝置', 'SELECT "userId" AS uid, lower(platform) AS platform, COUNT(*)::int AS n, ' + ms('MAX("registeredAt")') + ' AS last FROM "PushDevice" WHERE "expoPushToken" IS NOT NULL GROUP BY 1, 2');
  const feedback = await ask('回饋', 'SELECT "userId" AS uid, COUNT(*)::int AS n FROM "Feedback" WHERE "userId" IS NOT NULL GROUP BY 1');
  const days = await ask('每日活動', `SELECT uid, d AS day, SUM(w)::int AS w, SUM(l)::int AS l, SUM(m)::int AS m
      FROM (SELECT w."userId" AS uid, ${day('i."createdAt"')} AS d, 1 AS w, 0 AS l, 0 AS m FROM "Item" i JOIN "Wishlist" w ON w.id = i."wishlistId" WHERE i."createdAt" >= $1
            UNION ALL SELECT "ownerUserId", ${day('"createdAt"')}, 0, 1, 0 FROM "Listing" WHERE "createdAt" >= $1
            UNION ALL SELECT "senderUserId", ${day('"createdAt"')}, 0, 0, 1 FROM "Message" WHERE "createdAt" >= $1) AS act GROUP BY 1, 2`, [since30]);

  const one = rows => new Map((rows || []).map(r => [r.uid, r])), many = rows => { const m = new Map(); for (const r of rows || []) { if (!m.has(r.uid)) m.set(r.uid, []); m.get(r.uid).push(r); } return m; };
  const W = one(wishes), L = one(lists), K = one(linked), WA = one(watches), LS = many(listings), T = one(talks), U = one(unread), S = one(sent), Q = one(inquiries),
    ME = one(meets), P = one(paid), F = one(follows), D = many(devices), FB = one(feedback), DY = many(days);
  const n = v => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.round(Number(v)) : 0), at = v => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.round(Number(v)) : null);
  const text = (v, max) => String(v === null || v === undefined ? '' : v).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);
  const utf8 = s => { let b = 0; for (const ch of s) { const c = ch.codePointAt(0); b += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4; } return b; };
  // 送出前把 0、false、空值拿掉（頁面把缺的欄位當 0）：沒有動作的帳戶只剩幾十個位元組，一包才放得下夠多帳戶
  const slim = v => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return v;
    const o = {};
    for (const k of Object.keys(v)) {
      const x = slim(v[k]);
      if (x === 0 || x === false || x === null || x === undefined || x === '' || (Array.isArray(x) && !x.length) || (typeof x === 'object' && !Array.isArray(x) && !Object.keys(x).length)) continue;
      o[k] = x;
    }
    return o;
  };
  const STATUS = { ACTIVE: 'active', RESERVED: 'reserved', SOLD: 'sold', EXPIRED: 'expired', REMOVED: 'removed', DRAFT: 'draft', PENDING_CONFIRMATION: 'draft' };
  const built = users.map(u => {
    const w = W.get(u.uid) || {}, ls = LS.get(u.uid) || [], t = T.get(u.uid) || {}, s = S.get(u.uid) || {}, un = U.get(u.uid) || {}, dv = D.get(u.uid) || [];
    const sell = { n: 0, active: 0, reserved: 0, sold: 0, expired: 0, removed: 0, draft: 0, d30: 0 };
    for (const r of ls) { sell.n += n(r.n); sell[STATUS[r.status] || 'draft'] += n(r.n); sell.d30 += n(r.d30); }
    const dev = { ios: 0, android: 0, other: 0 };
    for (const r of dv) dev[r.platform === 'ios' || r.platform === 'android' ? r.platform : 'other'] += n(r.n);
    const lastAt = Math.max(0, at(w.last) || 0, ...ls.map(r => at(r.last) || 0), at(s.last) || 0, at((K.get(u.uid) || {}).last) || 0, at((Q.get(u.uid) || {}).last) || 0,
      at((P.get(u.uid) || {}).last) || 0, ...dv.map(r => at(r.last) || 0)) || null;
    const value = {
      v: 1, name: text(u.shown, 40), login: text(u.login, 40), ev: u.ev === true, pv: u.pv === true, premium: u.premium === true, api: u.api === true,
      sub: text(u.sub, 12) || null, subUntil: at(u.subUntil), createdAt: at(u.created), lastAt, talkAt: at(t.last),
      wish: { n: n(w.n), lists: n((L.get(u.uid) || {}).n), pub: n((L.get(u.uid) || {}).pub), bought: n(w.bought), hidden: n(w.hidden), aiFailed: n(w.aiFailed), d30: n(w.d30),
        linked: n((K.get(u.uid) || {}).n), watches: n((WA.get(u.uid) || {}).n) },
      sell,
      chat: { buy: n(t.buy), sell: n(t.sell), sent: n(s.n), d30: n(s.d30), unread: n(un.n), oldestUnreadAt: at(un.oldest), inquiries: n((Q.get(u.uid) || {}).n) },
      meet: { n: n((ME.get(u.uid) || {}).n), open: n((ME.get(u.uid) || {}).open), done: n((ME.get(u.uid) || {}).done) },
      pay: { n: n((P.get(u.uid) || {}).n), twd: n((P.get(u.uid) || {}).twd) },
      social: { following: n((F.get(u.uid) || {}).following), followers: n((F.get(u.uid) || {}).followers) },
      dev, ai: n(u.ai), feedback: n((FB.get(u.uid) || {}).n),
      days: (DY.get(u.uid) || []).filter(r => /^\d{4}-\d{2}-\d{2}$/.test(String(r.day))).sort((a, b) => (a.day < b.day ? -1 : 1)).slice(-31).map(r => [r.day, n(r.w), n(r.l), n(r.m)])
    };
    return { ref: String(u.ref || ''), value, score: Math.max(lastAt || 0, value.talkAt || 0, value.createdAt || 0) };
  }).filter(x => /^[a-f0-9]{10}$/.test(x.ref));
  // 整包信封有大小上限：最近有動作的帳戶先放，放不下的帳戶只少了明細，總數仍算在 totals 裡
  const sum = pick => built.reduce((a, x) => a + pick(x.value), 0), count = test => built.filter(x => test(x.value)).length;
  const totals = { users: built.length, withWish: count(v => v.wish.n > 0), withListing: count(v => v.sell.n > 0), withChat: count(v => v.chat.sent > 0), withMeetDone: count(v => v.meet.done > 0),
    active30: count(v => v.days.length > 0), wishes: sum(v => v.wish.n), listings: sum(v => v.sell.n), listingsActive: sum(v => v.sell.active), sent: sum(v => v.chat.sent),
    paidUsers: count(v => v.pay.n > 0), paidTwd: sum(v => v.pay.twd), appUsers: count(v => v.dev.ios + v.dev.android + v.dev.other > 0) };
  let used = 0, shown = 0, dropped = 0;
  for (const x of built.sort((a, b) => b.score - a.score)) {
    const value = slim(x.value), size = utf8(JSON.stringify(value));
    if (shown >= MAX_USERS || used + size > BUDGET) { dropped += 1; continue; }
    used += size; shown += 1;
    out.facts.push({ app: A, key: 'wlUser' + x.ref, value });
  }
  if (dropped) out.notes.push('帳戶明細太多，這次略過 ' + dropped + ' 個最久沒有動作的帳戶');
  out.facts.push({ app: A, key: 'wlUsersMeta', value: { v: 1, asOf: Date.now(), users: built.length, shown, dropped, totals, notes: out.notes.slice(0, 6) } });
}
const wishlistUsers = today => wrap(today, PRISMA, '    await (' + wishlistUsersBody.toString() + ')();');

const BACKENDS = [
  { id: 'rebound', name: 'REBOUND 遊戲伺服器', apps: ['rebound'], appDirs: ['/app/server', '/app'], script: rebound,
    railway: { project: 'rebound-live', projectId: '642452f8-405c-4d07-8565-bd409a136fe8', environment: 'production', service: 'rebound-api' } },
  { id: 'summit', name: '活字戰紀伺服器', apps: ['typeforge-twin-cities', 'summit-battle'], appDirs: ['/app'], script: summit,
    railway: { project: 'noble-fascination', projectId: '68db2b85-9ead-420e-abec-587eb84b41b1', environment: 'production', service: 'summit-battle-api' } },
  { id: 'wishlist', name: 'Wishlist.ai', apps: ['weesh'], appDirs: ['/app/server', '/app'], script: wishlist,
    railway: { project: 'thorough-presence', projectId: 'c4bb972e-46b8-4e54-a9d1-5d38f619879a', environment: 'production', service: 'wishlist-app' } },
];
// 帳戶明細：和 BACKENDS 分開列，因為它的保證不同（會帶回遮蔽過的帳戶名稱；見上面的說明與它自己的測試）。
const DETAIL = [
  { id: 'wishlist-users', name: 'Wishlist.ai 帳戶明細', apps: ['weesh'], appDirs: ['/app/server', '/app'], script: wishlistUsers,
    railway: { project: 'thorough-presence', projectId: 'c4bb972e-46b8-4e54-a9d1-5d38f619879a', environment: 'production', service: 'wishlist-app' } },
];

// The shell text that runs inside the back-end's container.
const remoteScript = (backend, today) => shellFor(backend.script(today), backend.appDirs);

module.exports = { BACKENDS, DETAIL, remoteScript };
