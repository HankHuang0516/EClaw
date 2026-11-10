'use strict';

const { LOCALES, publicCopy, mailText } = require('./copy');
const { canonical, sha256 } = require('./store');
const { toMs, taipeiLocalToIso, taipeiCalendarMonthLater, addDays } = require('./time');

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,60}$/;
// Accepted by both mail systems: REBOUND wants 8-96 chars, Typeforge 1-120, same character set.
const DELIVERY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,96}$/;
const STATUSES = ['draft', 'approved', 'cancelled'];
const FROZEN_FIELDS = ['id', 'kind', 'holiday', 'tier', 'announceAt', 'startsAt', 'deliveryEndsAt', 'claimEndsAt', 'games', 'copy'];

function campaignIdFor(occurrence) {
  return `${occurrence.holiday}-${occurrence.date.slice(0, 4)}`;
}

function timesFor(occurrence, calendar) {
  const startsAt = taipeiLocalToIso(occurrence.date, calendar.startTime);
  return {
    announceAt: addDays(startsAt, -calendar.leadDays),
    startsAt,
    deliveryEndsAt: addDays(startsAt, calendar.deliveryDays),
    claimEndsAt: taipeiCalendarMonthLater(startsAt)
  };
}

// Builds the complete campaign from one calendar occurrence: rewards come from each game's
// tier table, and every public sentence and in-game mail is written out in full.
function draftCampaign(occurrence, { calendar, games }) {
  const holiday = calendar.holidays[occurrence.holiday];
  if (!holiday) throw new Error(`unknown_holiday:${occurrence.holiday}`);
  const tier = occurrence.tier || holiday.tier;
  const times = timesFor(occurrence, calendar);
  const id = campaignIdFor(occurrence);
  const entries = games.games.filter(game => game.enabled && game.tiers[tier])
    .map(game => ({ game, reward: { ...game.tiers[tier] } }));
  if (!entries.length) throw new Error(`no_enabled_game_for_tier:${tier}`);
  const copy = {};
  for (const locale of LOCALES) copy[locale] = publicCopy(locale, holiday.names[locale], entries, times);
  return {
    schemaVersion: 1,
    id,
    kind: 'holiday',
    holiday: occurrence.holiday,
    tier,
    status: 'draft',
    ...times,
    games: entries.map(({ game, reward }) => ({
      gameId: game.id,
      reward,
      deliveryKey: `gift-${id}-${game.id}`,
      mail: mailText(holiday.names, game, reward, times)
    })),
    copy,
    receipts: []
  };
}

// The part of a campaign that may never change once it is approved.
function frozenHash(campaign) {
  const subset = {};
  for (const field of FROZEN_FIELDS) subset[field] = campaign[field];
  return sha256(canonical(subset));
}

function isIso(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function validateHoliday(campaign, { games }, errors) {
  const times = ['announceAt', 'startsAt', 'deliveryEndsAt', 'claimEndsAt'];
  for (const field of times) if (!isIso(campaign[field])) errors.push(`invalid_${field}`);
  if (times.every(field => isIso(campaign[field]))) {
    if (!(toMs(campaign.announceAt) <= toMs(campaign.startsAt) && toMs(campaign.startsAt) < toMs(campaign.deliveryEndsAt) &&
        toMs(campaign.deliveryEndsAt) <= toMs(campaign.claimEndsAt))) errors.push('times_out_of_order');
    if (campaign.claimEndsAt !== taipeiCalendarMonthLater(campaign.startsAt)) errors.push('claim_deadline_not_one_taipei_calendar_month');
  }
  if (!Array.isArray(campaign.games) || !campaign.games.length) {
    errors.push('no_games');
    return;
  }
  const keys = new Set();
  for (const entry of campaign.games) {
    const game = games.games.find(candidate => candidate.id === entry.gameId);
    if (!game) { errors.push(`unknown_game:${entry.gameId}`); continue; }
    const reward = entry.reward && typeof entry.reward === 'object' ? entry.reward : {};
    if (!Object.keys(reward).length) errors.push(`empty_reward:${entry.gameId}`);
    for (const [key, amount] of Object.entries(reward)) {
      if (!game.rewardItems[key]) errors.push(`unknown_reward_item:${entry.gameId}:${key}`);
      if (!positiveInteger(amount)) errors.push(`invalid_reward_amount:${entry.gameId}:${key}`);
    }
    if (!DELIVERY_KEY_PATTERN.test(String(entry.deliveryKey)) || keys.has(entry.deliveryKey)) errors.push(`invalid_delivery_key:${entry.gameId}`);
    keys.add(entry.deliveryKey);
    const limits = game.delivery.mailLimits;
    const mail = entry.mail || {};
    if (typeof mail.subject !== 'string' || !mail.subject.trim() || mail.subject.length > limits.subject) errors.push(`invalid_mail_subject:${entry.gameId}`);
    if (typeof mail.body !== 'string' || !mail.body.trim() || mail.body.length > limits.body) errors.push(`invalid_mail_body:${entry.gameId}`);
  }
  for (const locale of LOCALES) {
    const copy = campaign.copy && campaign.copy[locale];
    if (!copy) { errors.push(`missing_copy:${locale}`); continue; }
    for (const field of ['title', 'intro', 'eligibility', 'starts', 'deadline']) {
      if (typeof copy[field] !== 'string' || !copy[field].trim()) errors.push(`missing_copy:${locale}:${field}`);
    }
    const copyGames = Array.isArray(copy.games) ? copy.games : [];
    if (copyGames.map(game => game.gameId).join(',') !== campaign.games.map(game => game.gameId).join(',')) errors.push(`copy_games_mismatch:${locale}`);
    for (const game of copyGames) {
      if (typeof game.name !== 'string' || !game.name || typeof game.line !== 'string' || !game.line) errors.push(`missing_copy:${locale}:${game.gameId}`);
    }
  }
  if (!Array.isArray(campaign.receipts)) errors.push('receipts_not_array');
  else for (const receipt of campaign.receipts) {
    if (!campaign.games.some(game => game.gameId === receipt.gameId)) errors.push(`receipt_unknown_game:${receipt.gameId}`);
    if (!Number.isSafeInteger(receipt.mails) || receipt.mails < 0) errors.push(`receipt_invalid_mails:${receipt.gameId}`);
    if (!isIso(receipt.verifiedAt)) errors.push(`receipt_invalid_time:${receipt.gameId}`);
  }
  if (campaign.status === 'approved') {
    if (!campaign.approval || campaign.approval.frozenSha256 !== frozenHash(campaign)) errors.push('approved_campaign_was_modified');
  }
}

// Campaigns that ran before this tool existed keep their original, already public record.
function validateLegacy(campaign, errors) {
  if (!isIso(campaign.claimEndsAt)) errors.push('invalid_claimEndsAt');
  if (campaign.startsAt !== undefined && !isIso(campaign.startsAt)) errors.push('invalid_startsAt');
  if (typeof campaign.appId !== 'string' || !campaign.appId) errors.push('missing_appId');
  if (campaign.copy) {
    for (const locale of LOCALES) {
      const copy = campaign.copy[locale];
      if (!copy || typeof copy.title !== 'string' || !Array.isArray(copy.lines) || !copy.lines.length) errors.push(`missing_copy:${locale}`);
    }
  }
}

function validateCampaign(campaign, context) {
  const errors = [];
  if (!campaign || typeof campaign !== 'object') return ['not_an_object'];
  if (!ID_PATTERN.test(String(campaign.id))) errors.push('invalid_id');
  if (!STATUSES.includes(campaign.status)) errors.push('invalid_status');
  if (campaign.kind === 'holiday') validateHoliday(campaign, context, errors);
  else if (campaign.kind === 'legacy') validateLegacy(campaign, errors);
  else errors.push('invalid_kind');
  return errors;
}

module.exports = {
  ID_PATTERN, DELIVERY_KEY_PATTERN, FROZEN_FIELDS, campaignIdFor, timesFor, draftCampaign, frozenHash, validateCampaign
};
