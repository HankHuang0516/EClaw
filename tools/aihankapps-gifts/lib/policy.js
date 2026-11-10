'use strict';

// Automatic approval. Hank delegated campaign approval on 2026-11-10 ("你自動判斷核准 不需要由我
// 同意"), so a campaign is approved here, without asking him, when and only when every check
// below passes. Anything outside these bounds stays a draft and is reported to him instead.
const { campaignIdFor, timesFor, frozenHash, validateCampaign } = require('./campaign');
const { listedTwd } = require('./copy');
const { canonical } = require('./store');
const { DAY_MS, toMs } = require('./time');

const POLICY_VERSION = 1;
const AUTHORITY = 'Hank 2026-11-10：「你自動判斷核准 不需要由我同意」';
const MAX_DELIVERY_DAYS = 14;

function check(id, ok, detail) {
  return { id, ok: Boolean(ok), ...(detail ? { detail } : {}) };
}

function evaluate(campaign, { calendar, games, campaigns = [], now = Date.now(), hold = null }) {
  const checks = [];
  checks.push(check('not_on_hold', hold === null, hold || undefined));

  const structure = validateCampaign({ ...campaign, status: 'draft' }, { games });
  checks.push(check('structure', structure.length === 0, structure.join(', ') || undefined));
  if (campaign.kind !== 'holiday' || structure.length) return { approved: false, checks };

  // Only campaigns that come straight from the holiday calendar are approved automatically.
  const occurrence = calendar.occurrences.find(item => campaignIdFor(item) === campaign.id && item.holiday === campaign.holiday);
  const expectedTimes = occurrence ? timesFor(occurrence, calendar) : null;
  const expectedTier = occurrence ? (occurrence.tier || calendar.holidays[occurrence.holiday].tier) : null;
  checks.push(check('calendar_occurrence', Boolean(occurrence) && campaign.tier === expectedTier &&
    Object.keys(expectedTimes).every(field => campaign[field] === expectedTimes[field]),
  occurrence ? undefined : 'not in calendar.json'));

  checks.push(check('starts_in_future', toMs(campaign.startsAt) > now, 'a campaign is never approved after its start time'));
  checks.push(check('delivery_window', toMs(campaign.deliveryEndsAt) - toMs(campaign.startsAt) <= MAX_DELIVERY_DAYS * DAY_MS));

  for (const entry of campaign.games) {
    const game = games.games.find(candidate => candidate.id === entry.gameId);
    checks.push(check(`game_enabled:${entry.gameId}`, game.enabled === true));
    // The reward must be exactly the game's own tier table: the automation never invents one.
    checks.push(check(`reward_matches_tier:${entry.gameId}`, Boolean(game.tiers[campaign.tier]) &&
      canonical(entry.reward) === canonical(game.tiers[campaign.tier])));
    const overCap = Object.entries(entry.reward).filter(([key, amount]) => amount > game.rewardItems[key].max).map(([key]) => key);
    const twd = listedTwd(game, entry.reward);
    const overValue = typeof game.maxListedTwd === 'number' && (twd === null || twd > game.maxListedTwd);
    checks.push(check(`reward_within_caps:${entry.gameId}`, !overCap.length && !overValue,
      overCap.length ? `over cap: ${overCap.join(', ')}` : overValue ? `listed value ${twd} over ${game.maxListedTwd}` : undefined));
  }

  // Keep gifts scarce: no two campaigns for the same game closer than the calendar's minimum gap.
  const gap = calendar.minDaysBetweenCampaigns * DAY_MS;
  const gameIds = new Set(campaign.games.map(entry => entry.gameId));
  const tooClose = campaigns.filter(other => other.id !== campaign.id && other.status === 'approved' && other.startsAt &&
    (other.kind === 'holiday' ? other.games.some(entry => gameIds.has(entry.gameId)) : gameIds.has(other.appId)) &&
    Math.abs(toMs(other.startsAt) - toMs(campaign.startsAt)) < gap).map(other => other.id);
  checks.push(check('cooldown', tooClose.length === 0, tooClose.join(', ') || undefined));

  return { approved: checks.every(item => item.ok), checks };
}

// Returns the campaign with the verdict recorded. Approved campaigns are frozen by hash.
function decide(campaign, context) {
  const now = context.now === undefined ? Date.now() : context.now;
  const { approved, checks } = evaluate(campaign, { ...context, now });
  if (!approved) return { approved, checks, campaign: { ...campaign, status: 'draft' } };
  return {
    approved,
    checks,
    campaign: {
      ...campaign,
      status: 'approved',
      approval: {
        by: 'auto-policy',
        policyVersion: POLICY_VERSION,
        authority: AUTHORITY,
        at: new Date(now).toISOString(),
        frozenSha256: frozenHash(campaign),
        checks: checks.map(item => item.id)
      }
    }
  };
}

module.exports = { POLICY_VERSION, AUTHORITY, MAX_DELIVERY_DAYS, evaluate, decide };
