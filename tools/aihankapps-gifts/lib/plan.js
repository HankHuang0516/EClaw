'use strict';

// Decides what is due right now. The daily run calls this first; an empty action list means
// there is nothing to do today.
const { campaignIdFor, timesFor } = require('./campaign');
const { latestReceipts } = require('./build');
const { DAY_MS, toMs } = require('./time');

const CALENDAR_HORIZON_DAYS = 120;

function plan({ calendar, games, campaigns, now = Date.now(), hold = null }) {
  const actions = [];
  const warnings = [];
  const byId = new Map(campaigns.map(campaign => [campaign.id, campaign]));

  for (const occurrence of calendar.occurrences) {
    const id = campaignIdFor(occurrence);
    if (byId.has(id)) continue;
    const times = timesFor(occurrence, calendar);
    if (now >= toMs(times.announceAt) && now < toMs(times.startsAt)) {
      actions.push({ type: 'draft', id, holiday: occurrence.holiday, startsAt: times.startsAt });
    } else if (now >= toMs(times.startsAt) && now < toMs(times.claimEndsAt)) {
      // Never approved retroactively: the announcement lead time has already been missed.
      warnings.push({ type: 'missed_occurrence', id, startsAt: times.startsAt });
    }
  }

  for (const campaign of campaigns) {
    if (campaign.kind !== 'holiday') continue;
    if (campaign.status === 'draft') {
      if (now < toMs(campaign.claimEndsAt)) actions.push({ type: 'review_draft', id: campaign.id, startsAt: campaign.startsAt });
      continue;
    }
    if (campaign.status !== 'approved' || now < toMs(campaign.startsAt) || now >= toMs(campaign.claimEndsAt)) continue;
    const receipts = latestReceipts(campaign);
    const delivering = now < toMs(campaign.deliveryEndsAt);
    for (const entry of campaign.games) {
      const game = games.games.find(candidate => candidate.id === entry.gameId);
      if (!game || !game.enabled) {
        warnings.push({ type: 'game_disabled', id: campaign.id, gameId: entry.gameId });
        continue;
      }
      const receipt = receipts.get(entry.gameId);
      const base = { id: campaign.id, gameId: entry.gameId };
      // First delivery: record the receipt and publish it. A late first delivery still goes
      // out, because the announcement already promised it.
      if (!receipt) actions.push({ ...base, type: 'deliver', record: delivering ? 'first' : 'final', late: !delivering });
      // During the delivery window the same key is sent again each day; only accounts that
      // joined since the last run receive anything.
      else if (delivering) actions.push({ ...base, type: 'redeliver', record: 'none' });
      // One last pass after the window closes, then the final count is published.
      else if (!receipt.final) actions.push({ ...base, type: 'finalize', record: 'final' });
    }
  }

  const horizon = now + CALENDAR_HORIZON_DAYS * DAY_MS;
  if (!calendar.occurrences.some(occurrence => toMs(timesFor(occurrence, calendar).startsAt) > horizon)) {
    warnings.push({ type: 'calendar_needs_extension', detail: `no occurrence later than ${CALENDAR_HORIZON_DAYS} days from now` });
  }

  return { now: new Date(now).toISOString(), hold, actions, warnings };
}

module.exports = { CALENDAR_HORIZON_DAYS, plan };
