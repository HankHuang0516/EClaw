// Run only against an explicitly created disposable Unix-socket test cluster.
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const community = require('../../app-portfolio-community');
const { READ_SQL } = require('../../paper-beta-admin');
if (!/^\/tmp\/paper-beta-test-[A-Za-z0-9]+$/.test(process.env.PGHOST || '')) {
    throw new Error('Disposable paper-beta test Unix socket required; production connections forbidden');
}
const pool = new Pool({ host: process.env.PGHOST, port: 55439, database: 'postgres', user: 'paper_beta_test' });
(async () => {
    try {
        const payload = community.cleanBetaFeedback({ submissionId: 'ab'.repeat(18), rating: 4,
            continuation: 'yes', comment: 'Synthetic feedback only', version: 'synthetic-1', platform: 'Android' });
        const original = await community.addBetaFeedback(pool, 'paper-flick-soldiers', payload);
        const retry = await community.addBetaFeedback(pool, 'paper-flick-soldiers', { ...payload, rating: 1 });
        assert.equal(retry.receiptId, original.receiptId);
        assert.equal(retry.duplicate, true);
        await community.addBetaFeedback(pool, 'eclawbot', { ...payload, rating: 1, continuation: 'no' });
        const read = async cursor => (await pool.query(READ_SQL, ['paper-flick-soldiers', cursor || null, 51])).rows[0];
        const first = await read();
        assert.equal(first.total, '1'); assert.equal(Number(first.average), 4);
        assert.equal(first.items.length, 1); assert.equal(first.items[0].rating, 4);
        assert.equal(first.yes, '1'); assert.equal(first.no, '0');
        assert.deepEqual(await read(), first);
        await pool.query('UPDATE app_portfolio_beta_feedback SET rating = 5 WHERE app_id = $1', ['paper-flick-soldiers']);
        assert.equal((await read()).items[0].rating, 5);
        await pool.query(`INSERT INTO app_portfolio_beta_feedback
            (app_id, submission_id, rating, continuation, comment, app_version, platform)
            SELECT 'paper-flick-soldiers', lpad(i::text, 36, '0'), 3, 'maybe', '', 'synthetic-2', 'iOS'
            FROM generate_series(1, 52) AS i`);
        const page = await read(); assert.equal(page.total, '53'); assert.equal(page.items.length, 51);
        const next = await read(page.items[49].receiptId);
        assert.equal(next.items.length, 3); assert.equal(next.total, '53');
        const seen = new Set(page.items.slice(0, 50).map(item => item.receiptId));
        assert.ok(next.items.every(item => !seen.has(item.receiptId)));
        assert.deepEqual(Object.keys(next.items[0]).sort(), ['receiptId','rating','continuation','comment','version','platform','createdAt'].sort());
        assert.equal((await pool.query('SELECT COUNT(*)::text AS count FROM app_portfolio_beta_feedback')).rows[0].count, '54');
        console.log('PASS real PostgreSQL: original intake dedupe, same-source refresh/update, fixed app scope, aggregate counts and disjoint bigint paging; disposable synthetic data only');
    } finally { await pool.end(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
