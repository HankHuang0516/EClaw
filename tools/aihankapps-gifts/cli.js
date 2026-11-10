#!/usr/bin/env node
'use strict';

// Holiday gift campaigns for the published games. See README.md for the daily procedure.
//
//   tick                     what is due now (draft / deliver / redeliver / finalize)
//   draft                    draft every campaign that is due and decide approval by policy
//   build [--check]          regenerate the portfolio data file and promo copy (or verify them)
//   validate                 validate every campaign file and that generated files are current
//   status  <id> <game>      read the delivery state from the game (no writes)
//   deliver <id> <game> --commit [--record first|final|none]
//
// Options: --now <ISO> (tick, draft), --json (tick),
//          --target production|test|local (status, deliver; default production),
//          --campaign-dir <dir> --calendar <file> --public-dir <dir> --promo-dir <dir>
//          (rehearsals and previews: keep sample campaigns away from the published files)
const path = require('path');
const { campaignIdFor, draftCampaign, validateCampaign } = require('./lib/campaign');
const build = require('./lib/build');
const { plan } = require('./lib/plan');
const policy = require('./lib/policy');
const store = require('./lib/store');
const { toMs } = require('./lib/time');
const transport = require('./lib/adapters/transport');

const ADAPTERS = { rebound: require('./lib/adapters/rebound'), typeforge: require('./lib/adapters/typeforge') };

function parseArgs(argv) {
  const positional = [];
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    const name = arg.slice(2);
    if (['check', 'commit', 'json'].includes(name)) options[name] = true;
    else options[name] = argv[++index];
  }
  return { command: positional[0], args: positional.slice(1), options };
}

function context(options) {
  const campaignDir = options['campaign-dir'] ? path.resolve(options['campaign-dir']) : store.CAMPAIGN_DIR;
  return {
    campaignDir,
    games: store.loadGames(),
    calendar: options.calendar ? store.readJson(path.resolve(options.calendar)) : store.loadCalendar(),
    campaigns: store.loadCampaigns(campaignDir),
    now: options.now ? toMs(options.now) : Date.now(),
    hold: store.holdReason()
  };
}

function print(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

function commandTick(options) {
  const result = plan(context(options));
  if (options.json) return print(result);
  const lines = [`now ${result.now}`];
  if (result.hold) lines.push(`HOLD: ${result.hold}`);
  if (!result.actions.length) lines.push('nothing due');
  for (const action of result.actions) {
    lines.push(`due: ${action.type} ${action.id}${action.gameId ? ' ' + action.gameId : ''}` +
      `${action.record && action.record !== 'none' ? ` (record ${action.record})` : ''}${action.late ? ' LATE' : ''}`);
  }
  for (const warning of result.warnings) lines.push(`warning: ${warning.type}${warning.id ? ' ' + warning.id : ''}${warning.detail ? ' — ' + warning.detail : ''}`);
  process.stdout.write(lines.join('\n') + '\n');
}

// Drafts every occurrence that has reached its announcement date, re-evaluates drafts that
// were held back earlier, and records the verdict in each campaign file.
function commandDraft(options) {
  const ctx = context(options);
  const due = plan(ctx).actions;
  const results = [];
  for (const action of due) {
    let campaign;
    if (action.type === 'draft') {
      campaign = draftCampaign(ctx.calendar.occurrences.find(item => campaignIdFor(item) === action.id), ctx);
    } else if (action.type === 'review_draft') {
      campaign = ctx.campaigns.find(item => item.id === action.id);
    } else continue;
    const verdict = policy.decide(campaign, ctx);
    const file = store.saveCampaign(verdict.campaign, ctx.campaignDir);
    ctx.campaigns = ctx.campaigns.filter(item => item.id !== campaign.id).concat(verdict.campaign);
    results.push({ id: campaign.id, approved: verdict.approved, file,
      failed: verdict.checks.filter(item => !item.ok).map(item => `${item.id}${item.detail ? ': ' + item.detail : ''}`) });
  }
  print({ drafted: results });
  if (results.some(result => !result.approved)) process.exitCode = 2;
}

// Sample campaigns from a custom directory may only be built into a custom output directory.
function generated(ctx, options) {
  if (options['campaign-dir'] && !(options['public-dir'] && options['promo-dir'])) {
    throw new Error('custom_campaign_dir_requires_--public-dir_and_--promo-dir');
  }
  const dirs = {
    ...(options['public-dir'] ? { publicDir: path.resolve(options['public-dir']) } : {}),
    ...(options['promo-dir'] ? { promoDir: path.resolve(options['promo-dir']) } : {})
  };
  return { files: build.outputs(ctx.campaigns, ctx.games, dirs), dirs };
}

function commandBuild(options) {
  const { files, dirs } = generated(context(options), options);
  if (options.check) {
    const stale = build.stale(files, dirs);
    print({ current: stale.length === 0, stale });
    if (stale.length) process.exitCode = 1;
    return;
  }
  print(build.write(files, dirs));
}

function commandValidate(options) {
  const ctx = context(options);
  const problems = {};
  for (const campaign of ctx.campaigns) {
    const errors = validateCampaign(campaign, ctx);
    if (errors.length) problems[campaign.id] = errors;
  }
  const { files, dirs } = generated(ctx, options);
  const stale = build.stale(files, dirs);
  print({ campaigns: ctx.campaigns.length, problems, stale });
  if (Object.keys(problems).length || stale.length) process.exitCode = 1;
}

function resolveDelivery(ctx, campaignId, gameId) {
  const campaign = ctx.campaigns.find(item => item.id === campaignId);
  if (!campaign) throw new Error(`unknown_campaign:${campaignId}`);
  if (campaign.kind !== 'holiday' || campaign.status !== 'approved') throw new Error('campaign_not_approved');
  const errors = validateCampaign(campaign, ctx);
  if (errors.length) throw new Error(`invalid_campaign:${errors.join(',')}`);
  const entry = campaign.games.find(item => item.gameId === gameId);
  const game = ctx.games.games.find(item => item.id === gameId);
  if (!entry || !game) throw new Error(`game_not_in_campaign:${gameId}`);
  if (!game.enabled) throw new Error(`game_disabled:${gameId}`);
  return { campaign, entry, game, adapter: ADAPTERS[game.delivery.adapter] };
}

function run(game, script, target) {
  if (target === 'local') return transport.runLocal(script);
  const railway = target === 'test' ? game.delivery.testRailway : game.delivery.railway;
  if (!railway) throw new Error(`no_${target}_environment:${game.id}`);
  return transport.runRailway(railway, script);
}

function commandDeliver(mode, args, options) {
  const ctx = context(options);
  const target = options.target || 'production';
  if (!['production', 'test', 'local'].includes(target)) throw new Error(`invalid_target:${target}`);
  const record = options.record || 'none';
  if (!['first', 'final', 'none'].includes(record)) throw new Error(`invalid_record:${record}`);
  const { campaign, entry, game, adapter } = resolveDelivery(ctx, args[0], args[1]);
  const base = { campaign: campaign.id, game: game.id, target, mode };
  if (mode === 'commit') {
    if (!options.commit) throw new Error('deliver_requires_--commit');
    if (ctx.hold) throw new Error(`on_hold:${ctx.hold}`);
    // Only real production results may be written into the real campaign files.
    if (record !== 'none' && target !== 'production' && !options['campaign-dir']) throw new Error('record_requires_production_target');
    const now = Date.now();
    if (now < toMs(campaign.startsAt)) throw new Error('campaign_not_started');
    if (now >= toMs(campaign.claimEndsAt)) throw new Error('campaign_ended');
  }
  const problems = adapter.problems(campaign, entry, game);
  if (problems.length) {
    print({ ...base, issues: problems.map(problem => `preflight:${problem}`) });
    process.exitCode = 1;
    return;
  }
  const result = run(game, adapter.script(mode, campaign, entry, game), target);
  if (!result.value) {
    print({ ...base, issues: ['no_result_from_game'], detail: result.detail });
    process.exitCode = 1;
    return;
  }
  const { summary, issues } = adapter.interpret(result.value, campaign);
  const output = { ...base, summary, issues };
  if (mode === 'commit' && !issues.length && record !== 'none') {
    const receipt = { gameId: game.id, verifiedAt: new Date().toISOString(), mails: summary.mails, claimed: summary.claimed, final: record === 'final' };
    campaign.receipts = [...(campaign.receipts || []), receipt];
    output.recorded = { receipt, file: store.saveCampaign(campaign, ctx.campaignDir) };
  }
  print(output);
  if (issues.length) process.exitCode = 1;
}

function main() {
  const { command, args, options } = parseArgs(process.argv.slice(2));
  switch (command) {
    case 'tick': return commandTick(options);
    case 'draft': return commandDraft(options);
    case 'build': return commandBuild(options);
    case 'validate': return commandValidate(options);
    case 'status': return commandDeliver('status', args, options);
    case 'deliver': return commandDeliver('commit', args, options);
    default:
      process.stderr.write('usage: cli.js tick|draft|build|validate|status|deliver (see the header of this file)\n');
      process.exitCode = 64;
  }
}

if (require.main === module) {
  try { main(); } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { parseArgs, ADAPTERS };
