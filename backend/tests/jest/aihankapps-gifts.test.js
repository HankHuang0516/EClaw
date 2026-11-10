'use strict';

// Holiday gift automation (tools/aihankapps-gifts): calendar, automatic approval, generated
// portfolio data, delivery payloads and the daily plan. No game server or database is touched.
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tool = path.resolve(__dirname, '../../../tools/aihankapps-gifts');
const time = require(path.join(tool, 'lib/time'));
const store = require(path.join(tool, 'lib/store'));
const copy = require(path.join(tool, 'lib/copy'));
const { draftCampaign, frozenHash, validateCampaign, campaignIdFor, timesFor } = require(path.join(tool, 'lib/campaign'));
const policy = require(path.join(tool, 'lib/policy'));
const build = require(path.join(tool, 'lib/build'));
const { plan } = require(path.join(tool, 'lib/plan'));
const transport = require(path.join(tool, 'lib/adapters/transport'));
const rebound = require(path.join(tool, 'lib/adapters/rebound'));
const typeforge = require(path.join(tool, 'lib/adapters/typeforge'));

const games = store.loadGames();
const calendar = store.loadCalendar();
const published = store.loadCampaigns();
const christmas = calendar.occurrences.find(item => item.holiday === 'christmas' && item.date === '2026-12-25');
const at = iso => Date.parse(iso);
const BEFORE_START = at('2026-12-11T02:30:00Z');
const clone = value => JSON.parse(JSON.stringify(value));

function decide(campaign, overrides = {}) {
  return policy.decide(campaign, { calendar, games, campaigns: published, now: BEFORE_START, hold: null, ...overrides });
}

function approvedChristmas() {
  const verdict = decide(draftCampaign(christmas, { calendar, games }));
  expect(verdict.checks.filter(item => !item.ok)).toEqual([]);
  return verdict.campaign;
}

function withReceipts(campaign, final = false) {
  return { ...campaign, receipts: [
    { gameId: 'rebound', verifiedAt: '2026-12-25T02:07:00.000Z', mails: 150, claimed: 3, final },
    { gameId: 'typeforge-twin-cities', verifiedAt: '2026-12-25T02:08:00.000Z', mails: 1234, claimed: 0, final }
  ] };
}

describe('time rules', () => {
  test('Taipei wall time converts to an exact instant', () => {
    expect(time.taipeiLocalToIso('2026-12-25', '10:00')).toBe('2026-12-25T02:00:00.000Z');
    expect(time.taipeiLocalToIso('2027-01-01', '00:00')).toBe('2026-12-31T16:00:00.000Z');
    expect(() => time.taipeiLocalToIso('2027-02-30', '10:00')).toThrow('invalid_local_time');
    expect(() => time.taipeiLocalToIso('2027-02-06', '24:00')).toThrow('invalid_local_time');
    expect(time.formatTaipei('2026-12-25T02:00:00.000Z')).toBe('2026/12/25 10:00');
    expect(time.formatTaipeiDate('2026-12-31T16:00:00.000Z')).toBe('2027/01/01');
  });
  test('the claim deadline is one Taipei calendar month, as the REBOUND server computes it', () => {
    // The 2026-10-07 campaign the server actually ran.
    expect(time.taipeiCalendarMonthLater('2026-10-07T10:53:52.797Z')).toBe('2026-11-07T10:53:52.797Z');
    expect(time.taipeiCalendarMonthLater('2026-12-25T02:00:00.000Z')).toBe('2027-01-25T02:00:00.000Z');
    // Month ends clamp instead of rolling into the following month.
    expect(time.taipeiCalendarMonthLater(time.taipeiLocalToIso('2027-01-31', '10:00'))).toBe(time.taipeiLocalToIso('2027-02-28', '10:00'));
    expect(time.taipeiCalendarMonthLater(time.taipeiLocalToIso('2028-01-31', '10:00'))).toBe(time.taipeiLocalToIso('2028-02-29', '10:00'));
    // 23:30 UTC is already the next day in Taipei; the month is counted in Taipei time.
    expect(time.taipeiCalendarMonthLater('2027-01-30T23:30:00.000Z')).toBe('2027-02-27T23:30:00.000Z');
  });
});

describe('calendar and game registry', () => {
  test('every occurrence is a known holiday with five-language names and a unique campaign id', () => {
    const ids = calendar.occurrences.map(campaignIdFor);
    expect(new Set(ids).size).toBe(ids.length);
    for (const occurrence of calendar.occurrences) {
      const holiday = calendar.holidays[occurrence.holiday];
      expect(holiday).toBeDefined();
      for (const locale of copy.LOCALES) expect(holiday.names[locale]).toEqual(expect.any(String));
      expect(['standard', 'major']).toContain(occurrence.tier || holiday.tier);
    }
  });
  test('lunar holidays use the looked-up dates, not a computed calendar', () => {
    const date = holiday => calendar.occurrences.find(item => item.holiday === holiday).date;
    expect(date('lunar-new-year')).toBe('2027-02-06');
    expect(date('dragon-boat')).toBe('2027-06-09');
    expect(date('mid-autumn')).toBe('2027-09-15');
  });
  test('occurrences are in order and never closer than the minimum gap', () => {
    const starts = calendar.occurrences.map(item => at(timesFor(item, calendar).startsAt));
    for (let index = 1; index < starts.length; index++) {
      expect(starts[index] - starts[index - 1]).toBeGreaterThanOrEqual(calendar.minDaysBetweenCampaigns * time.DAY_MS);
    }
  });
  test('only the two published, deliverable games are enabled and their tiers stay inside the caps', () => {
    expect(games.games.filter(game => game.enabled).map(game => game.id)).toEqual(['rebound', 'typeforge-twin-cities']);
    for (const game of games.games) {
      for (const locale of copy.LOCALES) expect(game.names[locale]).toEqual(expect.any(String));
      for (const item of Object.values(game.rewardItems)) for (const locale of copy.LOCALES) expect(item.labels[locale]).toContain('{n}');
      for (const reward of Object.values(game.tiers)) {
        for (const [key, amount] of Object.entries(reward)) expect(amount).toBeLessThanOrEqual(game.rewardItems[key].max);
      }
      expect(game.delivery.railway).toEqual(expect.objectContaining({ projectId: expect.any(String), environment: 'production', service: expect.any(String) }));
    }
    const [reboundGame, typeforgeGame] = games.games;
    // The largest REBOUND gift is the one Hank approved on 2026-10-07.
    expect(reboundGame.tiers.major).toEqual({ sparks: 6000, revive_card: 1, loot_boost_1h: 1, spark_boost_1h: 1, skill_tree_reset: 1 });
    expect(copy.listedTwd(reboundGame, reboundGame.tiers.major)).toBe(300);
    expect(copy.listedTwd(reboundGame, reboundGame.tiers.standard)).toBe(150);
    expect(reboundGame.rewardItems).not.toHaveProperty('auto_fire_license');
    // Gold has no listed price, so no value is ever claimed for it.
    expect(copy.listedTwd(typeforgeGame, typeforgeGame.tiers.standard)).toBeNull();
    expect(typeforgeGame.rewardItems.gold.max).toBeLessThanOrEqual(300);
    expect(Object.keys(typeforgeGame.rewardItems)).toEqual(['gold']);
  });
});

describe('drafting a campaign from the calendar', () => {
  const draft = draftCampaign(christmas, { calendar, games });
  test('times follow the calendar: two-week notice, seven delivery days, one calendar month to claim', () => {
    expect(draft).toEqual(expect.objectContaining({
      id: 'christmas-2026', kind: 'holiday', holiday: 'christmas', tier: 'standard', status: 'draft',
      announceAt: '2026-12-11T02:00:00.000Z', startsAt: '2026-12-25T02:00:00.000Z',
      deliveryEndsAt: '2027-01-01T02:00:00.000Z', claimEndsAt: '2027-01-25T02:00:00.000Z', receipts: []
    }));
    expect(validateCampaign(draft, { games })).toEqual([]);
  });
  test('rewards come from each game tier table and the mail fits both servers', () => {
    expect(draft.games.map(entry => [entry.gameId, entry.reward, entry.deliveryKey])).toEqual([
      ['rebound', { sparks: 3000, revive_card: 1, loot_boost_1h: 1 }, 'gift-christmas-2026-rebound'],
      ['typeforge-twin-cities', { gold: 100 }, 'gift-christmas-2026-typeforge-twin-cities']
    ]);
    for (const entry of draft.games) {
      expect(entry.mail.subject).toBe('聖誕節禮包｜Christmas gift');
      expect(entry.mail.subject.length).toBeLessThanOrEqual(120);
      expect(entry.mail.body.length).toBeLessThanOrEqual(2000);
      expect(entry.mail.body).toContain('2027/01/25 10:00');
      expect(entry.mail.body).toContain('Taipei time');
    }
    expect(draft.games[0].mail.body).toContain('火花 3,000 點、戰機復活卡 1 張、1H 戰利品加倍卡 1 張');
    expect(draft.games[0].mail.body).toContain('3,000 Sparks, fighter revive ×1, 1-hour double loot card ×1');
    expect(draft.games[1].mail.body).toContain('金幣 100');
  });
  test('public copy is complete in five languages and only REBOUND states a listed value', () => {
    for (const locale of copy.LOCALES) {
      const text = draft.copy[locale];
      expect(text.title.length).toBeGreaterThan(0);
      expect(text.games.map(game => game.gameId)).toEqual(['rebound', 'typeforge-twin-cities']);
      expect(text.games[0].value).toContain('NT$150');
      expect(text.games[1]).not.toHaveProperty('value');
      for (const field of ['eligibility', 'starts', 'deadline']) expect(text[field]).toMatch(/20\d\d\/\d\d\/\d\d 10:00/);
    }
    expect(draft.copy['zh-TW'].title).toBe('聖誕節禮包');
    expect(draft.copy['zh-TW'].games[0].line).toBe('《REBOUND：元素戰機》：火花 3,000 點、戰機復活卡 1 張、1H 戰利品加倍卡 1 張。');
    expect(draft.copy['zh-TW'].games[0].value).toBe('商品標價換算約 NT$150，非現金價值。');
    expect(draft.copy['zh-TW'].eligibility).toContain('每帳號一封');
    expect(draft.copy.en.games[1].line).toBe('Typeforge: Twin Cities: 100 gold.');
    expect(draft.copy.ja.games[1].name).toBe('タイプフォージ：双城戦記');
    expect(draft.copy.ko.games[1].name).toBe('타입포지: 두 도시의 전쟁');
  });
  test('a major holiday uses the major tier', () => {
    const newYear = draftCampaign(calendar.occurrences.find(item => item.holiday === 'lunar-new-year'), { calendar, games });
    expect(newYear.id).toBe('lunar-new-year-2027');
    expect(newYear.startsAt).toBe('2027-02-06T02:00:00.000Z');
    expect(newYear.games.map(entry => entry.reward)).toEqual([games.games[0].tiers.major, { gold: 200 }]);
    expect(newYear.copy['zh-TW'].games[0].value).toContain('NT$300');
  });
});

describe('automatic approval', () => {
  const draft = draftCampaign(christmas, { calendar, games });
  const failed = verdict => verdict.checks.filter(item => !item.ok).map(item => item.id);

  test('a calendar campaign inside the bounds is approved and frozen without asking anyone', () => {
    const { approved, campaign } = decide(draft);
    expect(approved).toBe(true);
    expect(campaign.status).toBe('approved');
    expect(campaign.approval).toEqual(expect.objectContaining({ by: 'auto-policy', policyVersion: policy.POLICY_VERSION,
      at: '2026-12-11T02:30:00.000Z', frozenSha256: frozenHash(draft) }));
    expect(campaign.approval.authority).toContain('2026-11-10');
    expect(validateCampaign(campaign, { games })).toEqual([]);
  });
  test('never approved at or after its start time', () => {
    const verdict = decide(draft, { now: at(draft.startsAt) });
    expect(verdict.approved).toBe(false);
    expect(verdict.campaign.status).toBe('draft');
    expect(failed(verdict)).toEqual(['starts_in_future']);
  });
  test('a HOLD stops approval', () => {
    expect(failed(decide(draft, { hold: 'paused by Hank' }))).toEqual(['not_on_hold']);
  });
  test('a reward that is not exactly the tier table is refused, even when it is smaller', () => {
    const smaller = clone(draft);
    smaller.games[0].reward.sparks = 1000;
    expect(failed(decide(smaller))).toEqual(['reward_matches_tier:rebound']);
    const bigger = clone(draft);
    bigger.games[1].reward.gold = 5000;
    expect(failed(decide(bigger))).toEqual(['reward_matches_tier:typeforge-twin-cities', 'reward_within_caps:typeforge-twin-cities']);
  });
  test('a permanent entitlement or unknown item never passes', () => {
    const permanent = clone(draft);
    permanent.games[0].reward.auto_fire_license = 1;
    const verdict = decide(permanent);
    expect(verdict.approved).toBe(false);
    expect(failed(verdict)).toEqual(['structure']);
    expect(verdict.checks.find(item => item.id === 'structure').detail).toContain('unknown_reward_item:rebound:auto_fire_license');
  });
  test('a date or holiday that is not in the calendar is refused', () => {
    const moved = clone(draft);
    moved.startsAt = time.addDays(draft.startsAt, 1);
    moved.deliveryEndsAt = time.addDays(draft.deliveryEndsAt, 1);
    moved.claimEndsAt = time.taipeiCalendarMonthLater(moved.startsAt);
    expect(failed(decide(moved))).toEqual(['calendar_occurrence']);
    const adHoc = { ...clone(draft), id: 'surprise-2026', holiday: 'surprise' };
    expect(failed(decide(adHoc))).toContain('calendar_occurrence');
  });
  test('a claim deadline other than one Taipei calendar month is a structural error', () => {
    const longer = { ...clone(draft), claimEndsAt: time.addDays(draft.claimEndsAt, 7) };
    expect(decide(longer).checks.find(item => item.id === 'structure').detail).toContain('claim_deadline_not_one_taipei_calendar_month');
  });
  test('two campaigns for the same game inside the minimum gap are refused', () => {
    const neighbour = { ...decide(draft).campaign, id: 'neighbour-2026', startsAt: time.addDays(draft.startsAt, -10) };
    expect(failed(decide(draft, { campaigns: [...published, neighbour] }))).toEqual(['cooldown']);
    const legacyNeighbour = { ...published.find(item => item.id.startsWith('elemental')), startsAt: time.addDays(draft.startsAt, 5) };
    expect(failed(decide(draft, { campaigns: [legacyNeighbour] }))).toEqual(['cooldown']);
  });
  test('a disabled game is refused', () => {
    const disabled = clone(games);
    disabled.games[1].enabled = false;
    expect(failed(decide(draft, { games: disabled }))).toEqual(['game_enabled:typeforge-twin-cities']);
  });
  test('an approved campaign cannot be edited, but receipts can be added', () => {
    const approved = decide(draft).campaign;
    for (const edit of [
      campaign => { campaign.games[0].reward.sparks = 6000; },
      campaign => { campaign.games[1].mail.body += '!'; },
      campaign => { campaign.copy.en.deadline = 'Claim whenever.'; },
      campaign => { campaign.deliveryEndsAt = time.addDays(campaign.deliveryEndsAt, 1); }
    ]) {
      const edited = clone(approved);
      edit(edited);
      expect(validateCampaign(edited, { games })).toContain('approved_campaign_was_modified');
    }
    expect(validateCampaign(withReceipts(approved), { games })).toEqual([]);
    expect(validateCampaign({ ...approved, receipts: [{ gameId: 'anthill', verifiedAt: '2026-12-25T02:07:00.000Z', mails: 1 }] }, { games }))
      .toContain('receipt_unknown_game:anthill');
  });
  test('the HOLD file is read from disk with its reason', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gift-hold-')), 'HOLD');
    expect(store.holdReason(file)).toBeNull();
    fs.writeFileSync(file, 'waiting for the new item catalogue\n');
    expect(store.holdReason(file)).toBe('waiting for the new item catalogue');
    expect(store.holdReason()).toBeNull();
  });
});

describe('published portfolio data', () => {
  test('the committed data file, page token and promo copy match the campaign files', () => {
    for (const campaign of published) expect(validateCampaign(campaign, { games })).toEqual([]);
    expect(build.stale(build.outputs(published, games))).toEqual([]);
  });
  test('drafts and cancelled campaigns are never published', () => {
    const draft = draftCampaign(christmas, { calendar, games });
    expect(build.buildPublicData([draft, { ...decide(draft).campaign, status: 'cancelled' }])).toEqual([]);
  });
  test('an approved campaign publishes complete upcoming and active copy without internal fields', () => {
    const [data] = build.buildPublicData([approvedChristmas()]);
    expect(Object.keys(data)).toEqual(['id', 'kind', 'apps', 'announceAt', 'startsAt', 'claimEndsAt', 'copy']);
    expect(data.apps).toEqual(['rebound', 'typeforge-twin-cities']);
    for (const locale of copy.LOCALES) {
      expect(data.copy[locale].upcoming).toHaveLength(6);
      expect(data.copy[locale].active).toHaveLength(6);
      expect(data.copy[locale].ended.length).toBeGreaterThan(0);
    }
    expect(data.copy['zh-TW'].upcoming).toEqual([
      '聖誕節禮包會寄進遊戲內信箱，打開信箱就能領取。',
      '《REBOUND：元素戰機》：火花 3,000 點、戰機復活卡 1 張、1H 戰利品加倍卡 1 張。商品標價換算約 NT$150，非現金價值。',
      '《活字戰紀：雙城烽火》：金幣 100。',
      '2026/12/25 10:00 至 2027/01/01 10:00（台北時間）之間已有帳號或新加入的玩家，每帳號一封；新帳號通常在加入後一天內收到。',
      '開始寄送：2026/12/25 10:00（台北時間）。',
      '領取截止：2027/01/25 10:00（台北時間），到期後無法領取。'
    ]);
    // Before any receipt the page says the count is pending instead of inventing one.
    expect(data.copy['zh-TW'].active[5]).toBe('寄送數量核對後會更新在這裡。');
    expect(data.copy['zh-TW'].ended).toBe('2026/12/25 – 2027/01/25');
    expect(data.copy.en.upcoming[1]).toBe('REBOUND：元素戰機: 3,000 Sparks, fighter revive ×1, 1-hour double loot card ×1. Approximate listed item value: NT$150. No cash value.');
    expect(JSON.stringify(data)).not.toMatch(/deliveryKey|gift-christmas|projectId|railway|approval|frozenSha256/);
  });
  test('verified receipts appear as delivery counts, never as claim counts', () => {
    const [data] = build.buildPublicData([withReceipts(approvedChristmas())]);
    expect(data.copy['zh-TW'].active.slice(4)).toEqual([
      '領取截止：2027/01/25 10:00（台北時間），到期後無法領取。',
      '《REBOUND：元素戰機》已寄出 150 封（2026/12/25 10:07 核對）；這是寄送數，不代表領取數。',
      '《活字戰紀：雙城烽火》已寄出 1,234 封（2026/12/25 10:08 核對）；這是寄送數，不代表領取數。'
    ]);
    expect(data.copy['zh-TW'].ended).toBe('2026/12/25 – 2027/01/25｜共寄出 1,384 封');
    expect(data.copy.en.active[5]).toBe('REBOUND：元素戰機: 150 mails delivered (verified 2026/12/25 10:07). This is a delivery count, not a claim count.');
  });
  test('a later receipt for the same game replaces the earlier one', () => {
    const campaign = withReceipts(approvedChristmas());
    campaign.receipts.push({ gameId: 'rebound', verifiedAt: '2027-01-01T02:10:00.000Z', mails: 163, claimed: 40, final: true });
    const [data] = build.buildPublicData([campaign]);
    expect(data.copy['zh-TW'].active[5]).toContain('已寄出 163 封（2027/01/01 10:10 核對）');
    expect(data.copy['zh-TW'].ended).toContain('共寄出 1,397 封');
  });
  test('the campaigns that ran before this tool keep their published record', () => {
    const data = build.buildPublicData(published);
    const celebration = data.find(item => item.id === 'elemental-fighter350-paper-celebration-20261007');
    expect(celebration).toEqual(expect.objectContaining({ kind: 'legacy', apps: ['rebound'],
      startsAt: '2026-10-07T10:53:52.797Z', claimEndsAt: '2026-11-07T10:53:52.797Z',
      record: { issuedCount: 146, verifiedAt: '2026-10-07T10:53:53.156Z', statusSource: 'verified-production-mailbox-receipt' } }));
    expect(celebration.copy['zh-TW'].title).toBe('元素戰機350｜《紙上彈兵》普天同慶禮包');
    for (const value of ['紙上彈兵', '6,000', 'NT$300', '不代表全部已領取', '失敗 0', '重複 0', '4 個 QA', '每帳號一封']) {
      expect(celebration.copy['zh-TW'].active.join('\n')).toContain(value);
    }
    expect(celebration.copy['zh-TW'].ended).toBe('2026/10/07 – 2026/11/07｜共寄出 146 封');
    const autumn = data.find(item => item.id === 'rebound-autumn-welcome-2026');
    expect(autumn).not.toHaveProperty('copy');
    expect(autumn).not.toHaveProperty('startsAt');
    expect(JSON.stringify(data)).not.toMatch(/recipientIds|x-admin-secret|ADMIN_SECRET|botSecret|deviceSecret|all_players|DATABASE_URL/);
  });
  test('the data file freezes every level and the page token follows its content', () => {
    const file = build.renderDataFile(build.buildPublicData([withReceipts(approvedChristmas())]));
    const window = {};
    require('vm').runInNewContext(file, { window });
    const [campaign] = window.AIHANK_GIFT_CAMPAIGNS;
    expect(Object.isFrozen(window.AIHANK_GIFT_CAMPAIGNS)).toBe(true);
    expect(Object.isFrozen(campaign.copy['zh-TW'].active)).toBe(true);
    const html = '<script src="gift-campaigns.js?v=old"></script>';
    expect(build.syncIndexHtml(html, file)).toBe(`<script src="gift-campaigns.js?v=${store.sha256(file).slice(0, 12)}"></script>`);
    expect(() => build.syncIndexHtml('<p>no script</p>', file)).toThrow('index_html_data_token_count:0');
  });
  test('cancelling a campaign takes it off the page, removes its promo copy and stops delivery', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gift-build-'));
    const dirs = { publicDir: path.join(dir, 'site'), promoDir: path.join(dir, 'promo') };
    fs.mkdirSync(dirs.publicDir);
    fs.writeFileSync(path.join(dirs.publicDir, 'index.html'), '<script src="gift-campaigns.js?v=0"></script>');
    const names = files => files.map(file => path.basename(file)).sort();
    const campaign = approvedChristmas();

    expect(names(build.write(build.outputs([campaign], games, dirs), dirs).written)).toEqual(['christmas-2026.md', 'gift-campaigns.js', 'index.html']);
    expect(build.stale(build.outputs([campaign], games, dirs), dirs)).toEqual([]);

    const cancelled = { ...campaign, status: 'cancelled' };
    expect(validateCampaign(cancelled, { games })).toEqual([]);
    const files = build.outputs([cancelled], games, dirs);
    expect(names(build.stale(files, dirs))).toEqual(['christmas-2026.md', 'gift-campaigns.js', 'index.html']);
    expect(names(build.write(files, dirs).removed)).toEqual(['christmas-2026.md']);
    expect(fs.readFileSync(path.join(dirs.publicDir, 'gift-campaigns.js'), 'utf8')).not.toContain('christmas-2026');
    expect(build.stale(files, dirs)).toEqual([]);
    // Neither delivered nor drafted again from the calendar.
    expect(plan({ calendar, games, campaigns: [cancelled], now: at('2026-12-25T02:00:00Z'), hold: null }).actions).toEqual([]);
  });
  test('promo copy carries the same sentences as the announcement and the frozen mail', () => {
    const campaign = approvedChristmas();
    const promo = build.promoMarkdown(campaign, games);
    expect(promo).toContain('https://eclawbot.com/AiHankApps/#christmas-2026');
    expect(promo).toContain('https://lolwarden0516.itch.io/rebound');
    expect(promo).toContain('https://lolwarden0516.itch.io/typeforge-twin-cities');
    for (const locale of copy.LOCALES) expect(promo).toContain(build.socialPost(campaign, locale));
    for (const entry of campaign.games) expect(promo).toContain(entry.mail.body);
    expect(build.socialPost(campaign, 'zh-TW').split('\n')[0]).toBe('【聖誕節禮包】');
  });
});

describe('daily plan', () => {
  const approved = approvedChristmas();
  const run = (campaigns, now) => plan({ calendar, games, campaigns, now: at(now), hold: null });
  const types = result => result.actions.map(action => [action.type, action.id, action.gameId, action.record].filter(Boolean).join(' '));

  test('nothing is due before the announcement date', () => {
    expect(run(published, '2026-11-10T02:00:00Z').actions).toEqual([]);
    expect(run(published, '2026-12-11T01:59:59Z').actions).toEqual([]);
  });
  test('the campaign is drafted from its announcement date until it starts', () => {
    expect(types(run(published, '2026-12-11T02:00:00Z'))).toEqual(['draft christmas-2026']);
    expect(types(run(published, '2026-12-25T01:59:59Z'))).toEqual(['draft christmas-2026']);
  });
  test('an occurrence that was never drafted is reported, not delivered late', () => {
    const result = run(published, '2026-12-25T02:00:00Z');
    expect(result.actions).toEqual([]);
    expect(result.warnings).toContainEqual({ type: 'missed_occurrence', id: 'christmas-2026', startsAt: '2026-12-25T02:00:00.000Z' });
  });
  test('an approved campaign waits for its start, then delivers each game once', () => {
    expect(run([approved], '2026-12-24T12:00:00Z').actions).toEqual([]);
    expect(types(run([approved], '2026-12-25T02:00:00Z'))).toEqual([
      'deliver christmas-2026 rebound first', 'deliver christmas-2026 typeforge-twin-cities first']);
  });
  test('after the first receipt the same key is re-sent daily for accounts that joined since', () => {
    const half = { ...approved, receipts: [withReceipts(approved).receipts[0]] };
    expect(types(run([half], '2026-12-26T02:05:00Z'))).toEqual([
      'redeliver christmas-2026 rebound none', 'deliver christmas-2026 typeforge-twin-cities first']);
    expect(types(run([withReceipts(approved)], '2026-12-31T02:05:00Z'))).toEqual([
      'redeliver christmas-2026 rebound none', 'redeliver christmas-2026 typeforge-twin-cities none']);
  });
  test('when the delivery window closes there is one final pass, then nothing', () => {
    expect(types(run([withReceipts(approved)], '2027-01-01T02:00:00Z'))).toEqual([
      'finalize christmas-2026 rebound final', 'finalize christmas-2026 typeforge-twin-cities final']);
    expect(run([withReceipts(approved, true)], '2027-01-02T02:00:00Z').actions).toEqual([]);
    // At the claim deadline nothing more is sent for it; by then the next holiday is being drafted.
    expect(types(run([withReceipts(approved)], '2027-01-25T02:00:00Z'))).toEqual(['draft lunar-new-year-2027']);
  });
  test('a first delivery that was missed during the window still goes out, marked late', () => {
    const [first] = run([approved], '2027-01-05T02:00:00Z').actions;
    expect(first).toEqual({ id: 'christmas-2026', gameId: 'rebound', type: 'deliver', record: 'final', late: true });
  });
  test('a draft that failed approval is reported for review instead of being delivered', () => {
    const draft = draftCampaign(christmas, { calendar, games });
    expect(types(run([draft], '2026-12-26T02:00:00Z'))).toEqual(['review_draft christmas-2026']);
  });
  test('the plan warns when the calendar is about to run out', () => {
    expect(run(published, '2026-11-10T02:00:00Z').warnings).toEqual([]);
    expect(run(published, '2027-09-01T02:00:00Z').warnings).toContainEqual(expect.objectContaining({ type: 'calendar_needs_extension' }));
  });
});

describe('delivery to the games', () => {
  const campaign = approvedChristmas();
  const [reboundEntry, typeforgeEntry] = campaign.games;
  const [reboundGame, typeforgeGame] = games.games;

  test('REBOUND receives a limited_campaign for all players with consumables only', () => {
    expect(rebound.payload(campaign, reboundEntry)).toEqual({
      kind: 'limited_campaign', subject: '聖誕節禮包｜Christmas gift', body: reboundEntry.mail.body,
      idempotency_key: 'gift-christmas-2026-rebound', all_players: true, campaign_starts_at: '2026-12-25T02:00:00.000Z',
      attachments: { sparks: 3000, items: { revive_card: 1, loot_boost_1h: 1 } }
    });
    expect(rebound.payload(campaign, reboundEntry)).not.toHaveProperty('expiry_days');
    expect(rebound.problems(campaign, reboundEntry)).toEqual([]);
  });
  test('REBOUND preflight catches what the server would reject', () => {
    const entitlement = { ...reboundEntry, reward: { sparks: 100, auto_fire_license: 1 } };
    expect(rebound.problems(campaign, entitlement)).toEqual(['campaign_requires_consumables']);
    expect(rebound.problems(campaign, { ...reboundEntry, deliveryKey: 'short' })).toEqual(['invalid_idempotency_key']);
    expect(rebound.problems(campaign, { ...reboundEntry, mail: { subject: 'x'.repeat(121), body: 'ok' } })).toEqual(['invalid_subject']);
    expect(rebound.problems({ ...campaign, claimEndsAt: time.addDays(campaign.claimEndsAt, 1) }, reboundEntry)).toEqual(['deadline_differs_from_server_rule']);
  });
  test('Typeforge receives one gold reward for Twin Cities accounts with the published deadline', () => {
    expect(typeforge.delivery(campaign, typeforgeEntry, typeforgeGame)).toEqual({
      dedupeKey: 'gift-christmas-2026-typeforge-twin-cities', kind: 'reward', title: '聖誕節禮包｜Christmas gift',
      body: typeforgeEntry.mail.body, gold: 100, product: 'dual-city', allAccounts: true, expiresAt: '2027-01-25T02:00:00.000Z'
    });
    expect(typeforge.problems(campaign, typeforgeEntry, typeforgeGame, at('2026-12-25T02:00:00Z'))).toEqual([]);
  });
  test('Typeforge preflight refuses cosmetics, oversized gold and an expired deadline', () => {
    const now = at('2026-12-25T02:00:00Z');
    expect(typeforge.problems(campaign, { ...typeforgeEntry, reward: { gold: 100, 'hero.guiguzi.flow.epic': 1 } }, typeforgeGame, now))
      .toEqual(['only_gold_is_delivered_automatically']);
    expect(typeforge.problems(campaign, { ...typeforgeEntry, reward: { gold: 10001 } }, typeforgeGame, now)).toEqual(['invalid_gold']);
    expect(typeforge.problems(campaign, typeforgeEntry, typeforgeGame, at(campaign.claimEndsAt))).toEqual(['expiry_must_be_in_the_future']);
  });
  test('the scripts run the game code in place and carry no secret', () => {
    const reboundScript = rebound.script('commit', campaign, reboundEntry);
    const typeforgeScript = typeforge.script('commit', campaign, typeforgeEntry, typeforgeGame);
    expect(reboundScript).toContain("'src', 'admin.mjs'");
    expect(reboundScript).toContain('dispatchOperationalMail(pool, payload)');
    expect(reboundScript).toContain('/app/server /app');
    expect(typeforgeScript).toContain("require(process.cwd() + '/mailbox.js')");
    expect(typeforgeScript).toContain('new PostgresMailbox(pool).deliver(delivery)');
    expect(typeforgeScript).toContain(typeforgeGame.delivery.toolSha256['mailbox.js']);
    for (const script of [reboundScript, typeforgeScript, rebound.script('status', campaign, reboundEntry)]) {
      expect(script).not.toMatch(/ADMIN_SECRET|x-admin-secret|postgres:\/\/|password/i);
      expect(script.split('\n')[0]).toBe('set -e');
    }
    // Status scripts never call the delivery function.
    expect(rebound.script('status', campaign, reboundEntry)).toContain('const mode = "status"');
    expect(typeforge.script('status', campaign, typeforgeEntry, typeforgeGame)).toContain('const mode = "status"');
  });
  test('REBOUND results are accepted only when every targeted player has exactly one mail with the published deadline', () => {
    const mailbox = { mails: 150, recipients: 150, claimed: 0, first_expiry: campaign.claimEndsAt, last_expiry: campaign.claimEndsAt };
    const ok = { mode: 'commit', dispatch: { ok: true, targeted: 150, delivered: 150, idempotent: false }, audience: 150, mailbox };
    expect(rebound.interpret(ok, campaign)).toEqual({ summary: { mode: 'commit', audience: 150, mails: 150, claimed: 0, targeted: 150, delivered: 150 }, issues: [] });
    // A player who registers between the dispatch and the count is not a failure.
    expect(rebound.interpret({ ...ok, audience: 151 }, campaign).issues).toEqual([]);
    expect(rebound.interpret({ ...ok, dispatch: { ok: false, errors: ['campaign_not_active'] } }, campaign).issues).toEqual(['dispatch_rejected:campaign_not_active']);
    expect(rebound.interpret({ ...ok, mailbox: { ...mailbox, mails: 148, recipients: 148 } }, campaign).issues).toEqual(['players_without_mail:2']);
    expect(rebound.interpret({ ...ok, mailbox: { ...mailbox, mails: 151 } }, campaign).issues).toEqual(['duplicate_mail_for_a_player']);
    expect(rebound.interpret({ ...ok, mailbox: { ...mailbox, last_expiry: '2027-01-26T02:00:00.000Z' } }, campaign).issues).toEqual(['expiry_differs_from_published_deadline']);
    expect(rebound.interpret({ mode: 'commit', error: 'connect ECONNREFUSED' }, campaign).issues).toEqual(['error:connect ECONNREFUSED', 'dispatch_rejected:no_response']);
  });
  test('Typeforge results are refused when the deployed mail tool changed or nothing came back', () => {
    const mailbox = { mails: 1234, recipients: 1234, claimed: 0, first_expiry: campaign.claimEndsAt, last_expiry: campaign.claimEndsAt };
    const ok = { mode: 'commit', toolMatches: true, deliver: { delivered: 1234, idempotent: false }, audience: 1234, mailbox };
    expect(typeforge.interpret(ok, campaign)).toEqual({ summary: { mode: 'commit', audience: 1234, mails: 1234, claimed: 0, delivered: 1234 }, issues: [] });
    expect(typeforge.interpret({ mode: 'commit', toolMatches: false }, campaign).issues).toEqual(['deployed_mail_tool_changed']);
    expect(typeforge.interpret({ mode: 'commit', toolMatches: true, error: 'mail_key_conflict' }, campaign).issues).toEqual(['error:mail_key_conflict']);
    expect(typeforge.interpret({ mode: 'commit', toolMatches: true }, campaign).issues).toEqual(['no_delivery_result']);
  });
  test('a changed mail tool stops the Typeforge script before it opens the database', () => {
    const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gift-typeforge-'));
    fs.writeFileSync(path.join(appDir, 'mailbox.js'), '// a newer mailbox\n');
    fs.writeFileSync(path.join(appDir, 'send-mail.js'), '// a newer tool\n');
    const result = transport.runLocal(typeforge.script('commit', campaign, typeforgeEntry, typeforgeGame),
      { env: { GIFT_APP_DIR: appDir, DATABASE_URL: 'postgres://127.0.0.1:9/never-opened' } });
    expect(result.value).toEqual(expect.objectContaining({ mode: 'commit', toolMatches: false }));
    expect(result.value).not.toHaveProperty('deliver');
    expect(typeforge.interpret(result.value, campaign).issues).toEqual(['deployed_mail_tool_changed']);
  });
  test('the transport sends an encoded script to the right Railway service and reads one result line', () => {
    const script = "echo 'quotes \" and $vars survive'";
    expect(Buffer.from(transport.encode(script).split(' ')[1], 'base64').toString('utf8')).toBe(script);
    const spawn = jest.fn(() => ({ status: 0, stdout: 'banner\r\nGIFT_RESULT {"mode":"status","audience":3}\r\n', stderr: '' }));
    const result = transport.runRailway(reboundGame.delivery.railway, script, { spawn });
    expect(result.value).toEqual({ mode: 'status', audience: 3 });
    expect(spawn.mock.calls[0][0]).toBe('railway');
    expect(spawn.mock.calls[0][1].slice(0, 7)).toEqual(['ssh', '-p', reboundGame.delivery.railway.projectId, '-e', 'production', '-s', 'rebound-api']);
    expect(spawn.mock.calls[0][1][7]).toBe(transport.encode(script));
    const silent = transport.finish({ status: 1, stdout: 'Project not found', stderr: '' });
    expect(silent.value).toBeNull();
    expect(silent.detail).toContain('Project not found');
  });
});

describe('command line', () => {
  const cli = path.join(tool, 'cli.js');
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });

  test('tick reports what is due for a given moment', () => {
    expect(run('tick', '--now', '2026-11-10T02:00:00Z').stdout).toContain('nothing due');
    const due = JSON.parse(run('tick', '--now', '2026-12-11T02:30:00Z', '--json').stdout);
    expect(due.actions).toEqual([{ type: 'draft', id: 'christmas-2026', holiday: 'christmas', startsAt: '2026-12-25T02:00:00.000Z' }]);
  });
  test('validate passes on the committed campaigns and generated files', () => {
    const result = run('validate');
    expect(JSON.parse(result.stdout)).toEqual({ campaigns: published.length, problems: {}, stale: [] });
    expect(result.status).toBe(0);
  });
  test('draft writes an approved campaign into a scratch directory, and delivery refuses to run early or on edited files', () => {
    // A far-future occurrence keeps this independent of the day the test runs.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gift-cli-'));
    const calendarFile = path.join(dir, 'calendar.json');
    fs.writeFileSync(calendarFile, JSON.stringify({ ...calendar, occurrences: [{ holiday: 'christmas', date: '2099-12-25' }] }));
    const campaignDir = path.join(dir, 'campaigns');
    const scratch = ['--campaign-dir', campaignDir, '--calendar', calendarFile];
    const drafted = run('draft', '--now', '2099-12-11T02:30:00Z', ...scratch);
    expect(JSON.parse(drafted.stdout).drafted).toEqual([expect.objectContaining({ id: 'christmas-2099', approved: true, failed: [] })]);
    const file = path.join(campaignDir, 'christmas-2099.json');
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).status).toBe('approved');

    const early = run('deliver', 'christmas-2099', 'rebound', '--commit', '--target', 'local', ...scratch);
    expect(early.status).toBe(1);
    expect(early.stderr).toContain('campaign_not_started');
    expect(run('deliver', 'christmas-2099', 'rebound', '--target', 'local', ...scratch).stderr).toContain('deliver_requires_--commit');
    expect(run('deliver', 'christmas-2099', 'anthill', '--commit', '--target', 'local', ...scratch).stderr).toContain('game_not_in_campaign:anthill');
    expect(run('deliver', 'christmas-2099', 'rebound', '--commit', '--record', 'first', '--target', 'test').stderr).toContain('unknown_campaign:christmas-2099');
    // A sample directory can never be built into the published files.
    expect(run('build', ...scratch).stderr).toContain('custom_campaign_dir_requires_--public-dir_and_--promo-dir');

    const edited = JSON.parse(fs.readFileSync(file, 'utf8'));
    edited.games[0].reward.sparks = 999999;
    fs.writeFileSync(file, JSON.stringify(edited));
    expect(run('status', 'christmas-2099', 'rebound', '--target', 'local', ...scratch).stderr).toContain('invalid_campaign:approved_campaign_was_modified');
  });
});
