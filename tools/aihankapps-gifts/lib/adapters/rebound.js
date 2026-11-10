'use strict';

// REBOUND：元素戰機. Delivery calls the server's own dispatchOperationalMail() (the function
// behind POST /internal/mail/dispatch) with kind=limited_campaign:
//   - one mail per player, deduplicated on (player_id, "ops:" + key), so sending the same key
//     again only reaches players who joined since;
//   - every mail expires one Asia/Taipei calendar month after campaign_starts_at, and the
//     server refuses claims after that;
//   - only Sparks and the four consumable cards are accepted, never a permanent entitlement.
// The script first compares the deployed dispatch code with the hashes recorded in games.json
// and stops if they differ: a changed server means this contract has to be re-read first.
const { shellFor } = require('./transport');
const { taipeiCalendarMonthLater } = require('../time');

const APP_DIRS = ['/app/server', '/app'];
const CONSUMABLES = ['revive_card', 'skill_tree_reset', 'spark_boost_1h', 'loot_boost_1h'];
const KEY_PATTERN = /^[A-Za-z0-9._:-]{8,96}$/;
const START_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

function payload(campaign, entry) {
  const { sparks = 0, ...items } = entry.reward;
  return {
    kind: 'limited_campaign',
    subject: entry.mail.subject,
    body: entry.mail.body,
    idempotency_key: entry.deliveryKey,
    all_players: true,
    campaign_starts_at: campaign.startsAt,
    attachments: { ...(sparks ? { sparks } : {}), ...(Object.keys(items).length ? { items } : {}) }
  };
}

// The same rules the server enforces, checked before anything is sent.
function problems(campaign, entry) {
  const body = payload(campaign, entry);
  const errors = [];
  if (!body.subject.trim() || body.subject.length > 120) errors.push('invalid_subject');
  if (!body.body.trim() || body.body.length > 2000) errors.push('invalid_body');
  if (!KEY_PATTERN.test(body.idempotency_key)) errors.push('invalid_idempotency_key');
  if (!START_PATTERN.test(body.campaign_starts_at)) errors.push('invalid_campaign_starts_at');
  if (!Object.keys(body.attachments).length) errors.push('empty_attachments');
  if (Object.keys(body.attachments.items || {}).some(item => !CONSUMABLES.includes(item))) errors.push('campaign_requires_consumables');
  if (campaign.claimEndsAt !== taipeiCalendarMonthLater(campaign.startsAt)) errors.push('deadline_differs_from_server_rule');
  return errors;
}

// mode: "status" only reads; "commit" delivers, then reads back.
function script(mode, campaign, entry, game) {
  const encoded = Buffer.from(JSON.stringify(payload(campaign, entry)), 'utf8').toString('base64');
  return shellFor(`
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const mode = ${JSON.stringify(mode)};
const expected = ${JSON.stringify(game.delivery.toolSha256)};
const payload = JSON.parse(Buffer.from('${encoded}', 'base64').toString('utf8'));
const out = { mode, key: payload.idempotency_key };
const print = () => console.log('GIFT_RESULT ' + JSON.stringify(out));
(async () => {
  out.tool = {};
  for (const file of Object.keys(expected)) out.tool[file] = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  out.toolMatches = Object.keys(expected).every(file => out.tool[file] === expected[file]);
  if (!out.toolMatches) { print(); process.exitCode = 1; return; }
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined });
  try {
    if (mode === 'commit') {
      const admin = await import(pathToFileURL(path.join(process.cwd(), 'src', 'admin.mjs')).href);
      out.dispatch = await admin.dispatchOperationalMail(pool, payload);
    }
    const players = await pool.query('SELECT count(*)::int AS n FROM players');
    const mail = await pool.query(\`SELECT count(*)::int AS mails, count(DISTINCT player_id)::int AS recipients,
      count(claimed_at)::int AS claimed, min(expires_at) AS first_expiry, max(expires_at) AS last_expiry
      FROM mailbox WHERE dedupe_key=$1\`, ['ops:' + payload.idempotency_key]);
    out.audience = players.rows[0].n;
    out.mailbox = mail.rows[0];
  } finally { await pool.end(); }
  print();
})().catch(error => { out.error = String((error && error.message) || error); print(); process.exitCode = 1; });
`.trim(), APP_DIRS);
}

// Normalised result plus the reasons, if any, it must not be recorded as a successful delivery.
function interpret(result, campaign) {
  const value = result || {};
  const mailbox = value.mailbox || {};
  const summary = {
    mode: value.mode,
    audience: value.audience ?? null,
    mails: mailbox.mails ?? null,
    claimed: mailbox.claimed ?? null,
    ...(value.dispatch ? { targeted: value.dispatch.targeted ?? null, delivered: value.dispatch.delivered ?? null } : {})
  };
  const issues = [];
  if (value.toolMatches === false) issues.push('deployed_mail_tool_changed');
  if (value.error) issues.push(`error:${value.error}`);
  if (value.mode === 'commit' && value.toolMatches !== false && !(value.dispatch && value.dispatch.ok)) {
    issues.push(`dispatch_rejected:${((value.dispatch && value.dispatch.errors) || ['no_response']).join(',')}`);
  }
  if (mailbox.mails !== undefined && mailbox.mails !== mailbox.recipients) issues.push('duplicate_mail_for_a_player');
  // Compared with the player count the dispatch itself saw, so a player who registers a moment
  // later is not reported as a failure; they are picked up by the next run.
  if (value.dispatch && value.dispatch.ok && summary.mails < value.dispatch.targeted) {
    issues.push(`players_without_mail:${value.dispatch.targeted - summary.mails}`);
  }
  if (mailbox.mails > 0 && (new Date(mailbox.first_expiry).toISOString() !== campaign.claimEndsAt ||
      new Date(mailbox.last_expiry).toISOString() !== campaign.claimEndsAt)) issues.push('expiry_differs_from_published_deadline');
  return { summary, issues };
}

module.exports = { APP_DIRS, payload, problems, script, interpret };
