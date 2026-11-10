'use strict';

// 活字戰紀：雙城烽火 (shared Summit mailbox). Delivery calls the server's own
// PostgresMailbox.deliver() from /app/mailbox.js, the function /app/send-mail.js --commit uses:
//   - one mail per account, unique on (account_id, dedupe_key), so sending the same key again
//     only reaches accounts created since;
//   - the same key with different text or reward is rejected (409), which is why the mail is
//     frozen in the campaign file;
//   - product=dual-city limits it to accounts that have opened Twin Cities;
//   - claims after expiresAt are refused by the server.
// The script first compares the deployed mail code with the hashes recorded in games.json and
// stops if they differ: a changed tool means this contract has to be re-read first.
const { shellFor } = require('./transport');

const KEY_PATTERN = /^[a-zA-Z0-9._:-]{1,120}$/;
const SERVER_GOLD_LIMIT = 10000;

function delivery(campaign, entry, game) {
  return {
    dedupeKey: entry.deliveryKey,
    kind: 'reward',
    title: entry.mail.subject,
    body: entry.mail.body,
    gold: entry.reward.gold,
    product: game.delivery.product,
    allAccounts: true,
    expiresAt: campaign.claimEndsAt
  };
}

function problems(campaign, entry, game, now = Date.now()) {
  const mail = delivery(campaign, entry, game);
  const errors = [];
  if (!KEY_PATTERN.test(mail.dedupeKey)) errors.push('invalid_mail_key');
  if (!mail.title.trim() || mail.title.length > 120) errors.push('invalid_title');
  if (!mail.body.trim() || mail.body.length > 4000) errors.push('invalid_body');
  if (Object.keys(entry.reward).some(key => key !== 'gold')) errors.push('only_gold_is_delivered_automatically');
  if (!Number.isSafeInteger(mail.gold) || mail.gold < 1 || mail.gold > SERVER_GOLD_LIMIT) errors.push('invalid_gold');
  if (!(Date.parse(mail.expiresAt) > now)) errors.push('expiry_must_be_in_the_future');
  return errors;
}

// mode: "status" only reads; "commit" delivers, then reads back.
function script(mode, campaign, entry, game) {
  const encoded = Buffer.from(JSON.stringify(delivery(campaign, entry, game)), 'utf8').toString('base64');
  return shellFor(`
const crypto = require('crypto');
const fs = require('fs');
const mode = ${JSON.stringify(mode)};
const expected = ${JSON.stringify(game.delivery.toolSha256)};
const delivery = JSON.parse(Buffer.from('${encoded}', 'base64').toString('utf8'));
const out = { mode, key: delivery.dedupeKey };
const print = () => console.log('GIFT_RESULT ' + JSON.stringify(out));
(async () => {
  out.tool = {};
  for (const file of Object.keys(expected)) out.tool[file] = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  out.toolMatches = Object.keys(expected).every(file => out.tool[file] === expected[file]);
  if (!out.toolMatches) { print(); process.exitCode = 1; return; }
  const { Pool } = require('pg');
  const { PostgresMailbox, validateDelivery } = require(process.cwd() + '/mailbox.js');
  validateDelivery(delivery);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSLMODE === 'disable' ? false : undefined });
  try {
    if (mode === 'commit') out.deliver = await new PostgresMailbox(pool).deliver(delivery);
    const audience = await pool.query(\`SELECT COUNT(*)::int AS n FROM summit_accounts AS account
      WHERE EXISTS (SELECT 1 FROM summit_device_bindings AS device
        WHERE device.account_id=account.account_id AND device.product=$1)\`, [delivery.product]);
    const mail = await pool.query(\`SELECT COUNT(*)::int AS mails, COUNT(DISTINCT account_id)::int AS recipients,
      COUNT(claimed_at)::int AS claimed, MIN(expires_at) AS first_expiry, MAX(expires_at) AS last_expiry
      FROM summit_mailbox WHERE dedupe_key=$1\`, [delivery.dedupeKey]);
    out.audience = audience.rows[0].n;
    out.mailbox = mail.rows[0];
  } finally { await pool.end(); }
  print();
})().catch(error => { out.error = String((error && (error.code || error.message)) || error); print(); process.exitCode = 1; });
`.trim(), [game.delivery.appDir]);
}

function interpret(result, campaign) {
  const value = result || {};
  const mailbox = value.mailbox || {};
  const summary = {
    mode: value.mode,
    audience: value.audience ?? null,
    mails: mailbox.mails ?? null,
    claimed: mailbox.claimed ?? null,
    ...(value.deliver ? { delivered: value.deliver.delivered ?? null } : {})
  };
  const issues = [];
  if (value.toolMatches === false) issues.push('deployed_mail_tool_changed');
  if (value.error) issues.push(`error:${value.error}`);
  if (value.mode === 'commit' && !value.deliver && value.toolMatches !== false && !value.error) issues.push('no_delivery_result');
  if (mailbox.mails !== undefined && mailbox.mails !== mailbox.recipients) issues.push('duplicate_mail_for_an_account');
  if (mailbox.mails > 0 && (new Date(mailbox.first_expiry).toISOString() !== campaign.claimEndsAt ||
      new Date(mailbox.last_expiry).toISOString() !== campaign.claimEndsAt)) issues.push('expiry_differs_from_published_deadline');
  return { summary, issues };
}

module.exports = { delivery, problems, script, interpret };
