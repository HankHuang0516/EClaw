'use strict';

// The portfolio gift sidebar renders whatever tools/aihankapps-gifts published in
// gift-campaigns.js. These tests drive the real controller against a small in-memory DOM with
// a campaign built by the real generator, at chosen moments of its life.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '../../public/AiHankApps');
const tool = path.resolve(__dirname, '../../../tools/aihankapps-gifts');
const source = fs.readFileSync(path.join(root, 'gift-sidebar.js'), 'utf8');
const records = fs.readFileSync(path.join(root, 'gift-campaigns.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'gift-sidebar.css'), 'utf8');
const sidebar = require(path.join(root, 'gift-sidebar.js'));
const store = require(path.join(tool, 'lib/store'));
const { draftCampaign } = require(path.join(tool, 'lib/campaign'));
const policy = require(path.join(tool, 'lib/policy'));
const build = require(path.join(tool, 'lib/build'));

const games = store.loadGames();
// A fixed occurrence and the two historical records only: real campaigns come and go, and
// must not change what these tests see.
const calendar = { ...store.loadCalendar(), occurrences: [{ holiday: 'christmas', date: '2026-12-25' }] };
const legacy = store.loadCampaigns().filter(campaign => campaign.kind === 'legacy');
const christmasId = 'christmas-2026';
const celebrationId = 'elemental-fighter350-paper-celebration-20261007';

function publishedData() {
  const window = {};
  vm.runInNewContext(records, { window });
  return window.AIHANK_GIFT_CAMPAIGNS;
}

// The Christmas campaign exactly as the generator would publish it, next to the past records.
function sampleData({ receipts = [] } = {}) {
  const { approved, campaign } = policy.decide(draftCampaign(calendar.occurrences[0], { calendar, games }),
    { calendar, games, campaigns: legacy, now: Date.parse('2026-12-11T02:30:00Z'), hold: null });
  expect(approved).toBe(true);
  return build.buildPublicData([...legacy, { ...campaign, receipts }]);
}

class FakeNode {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.attributes = {};
    this.textContent = '';
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  appendChild(child) { this.children.push(child); return child; }
  insertBefore(child, reference) {
    const index = this.children.indexOf(reference);
    if (index < 0) this.children.push(child); else this.children.splice(index, 0, child);
    return child;
  }
  replaceChild(next, previous) { this.children[this.children.indexOf(previous)] = next; return previous; }
  removeChild(child) { this.children = this.children.filter(item => item !== child); return child; }
  get firstChild() { return this.children[0] || null; }
  find(predicate) {
    if (predicate(this)) return this;
    for (const child of this.children) {
      const found = child.find(predicate);
      if (found) return found;
    }
    return null;
  }
  findAll(predicate, found = []) {
    if (predicate(this)) found.push(this);
    for (const child of this.children) child.findAll(predicate, found);
    return found;
  }
  get text() { return [this.textContent, ...this.children.map(child => child.text)].filter(Boolean).join('\n'); }
}

function page({ data, now, lang = 'zh-Hant', desktop = false, hash = '', withLayout = true } = {}) {
  const layout = new FakeNode('div');
  const apps = layout.appendChild(new FakeNode('div'));
  apps.className = 'portfolio-apps';
  const clock = { now: Date.parse(now) };
  const events = {};
  const media = { matches: desktop, listeners: [], addEventListener(_event, handler) { this.listeners.push(handler); } };
  const observers = [];
  const document = {
    documentElement: { lang },
    createElement: tag => new FakeNode(tag),
    querySelector: selector => (selector === '.portfolio-layout' && withLayout ? layout : null),
    getElementById: id => layout.find(node => node.id === id)
  };
  const window = {
    AIHANK_GIFT_CAMPAIGNS: data,
    location: { hash },
    matchMedia: () => media,
    setInterval: jest.fn(),
    addEventListener: (event, handler) => { events[event] = handler; },
    MutationObserver: class { constructor(callback) { observers.push(callback); } observe() {} }
  };
  const realNow = Date.now;
  Date.now = () => clock.now;
  try { sidebar.start(window, document); } finally { Date.now = realNow; }
  const at = (moment, action) => {
    clock.now = Date.parse(moment);
    Date.now = () => clock.now;
    try { return action(); } finally { Date.now = realNow; }
  };
  return {
    layout, apps, window, document, media, events, observers,
    get aside() { return layout.children.find(node => node.className === 'portfolio-gift-sidebar') || null; },
    get disclosure() { return this.aside && this.aside.firstChild; },
    card: id => layout.find(node => node.attributes['data-campaign-id'] === id),
    tick: moment => at(moment, () => window.setInterval.mock.calls[0][0]()),
    relang: (moment, next) => at(moment, () => { document.documentElement.lang = next; observers[0](); })
  };
}

describe('portfolio page markup', () => {
  test('index.html carries no hand-written campaign and loads the generated data with its content token', () => {
    expect(html).not.toContain('class="portfolio-gift-sidebar"');
    expect(html).not.toContain('data-campaign-countdown');
    expect(html).not.toContain('data-gift-i18n');
    expect(html).not.toContain('id="' + celebrationId + '"');
    expect(html).not.toContain('id="rebound-autumn-welcome-2026"');
    expect(html).toContain('<div class="portfolio-layout">');
    expect(html).toContain(`<script src="gift-campaigns.js?v=${store.sha256(records).slice(0, 12)}"></script>`);
    expect(html).toMatch(/<script src="gift-sidebar\.js\?v=[\w-]+"><\/script>/);
    expect(html.indexOf('gift-campaigns.js')).toBeLessThan(html.indexOf('gift-sidebar.js'));
    expect(html).not.toContain('../shared/i18n.js');
  });
  test('the controller only reads the data file: no network, storage or admin surface', () => {
    expect(source).not.toMatch(/fetch\(|XMLHttpRequest|sendBeacon|apiCall\(|postMessage|localStorage|sessionStorage|document\.cookie|\/admin|credentials/);
    expect(source).not.toMatch(/innerHTML|insertAdjacentHTML|document\.write/);
  });
  test('layout rules: full-width catalogue without a campaign, bounded sidebar, visible focus', () => {
    expect(css).toContain('.portfolio-layout > .portfolio-apps:only-child { grid-column: 1 / -1; }');
    expect(css).toContain('overflow-y: auto');
    expect(css).toContain(':focus-visible');
    expect(css).toContain('.portfolio-apps .portfolio-traffic-details { left: 0; right: auto; max-width: 100%; }');
    expect(html).toContain('name="viewport" content="width=device-width, initial-scale=1"');
  });
});

describe('published records and a page with nothing current', () => {
  test('the published records are frozen and hold the approved receipt, not player details', () => {
    const campaigns = publishedData();
    expect(Object.isFrozen(campaigns)).toBe(true);
    const celebration = campaigns.find(campaign => campaign.id === celebrationId);
    expect(Object.isFrozen(celebration.record)).toBe(true);
    expect(celebration.record).toEqual({ issuedCount: 146, verifiedAt: '2026-10-07T10:53:53.156Z', statusSource: 'verified-production-mailbox-receipt' });
    expect(celebration.startsAt).toBe('2026-10-07T10:53:52.797Z');
    expect(celebration.claimEndsAt).toBe('2026-11-07T10:53:52.797Z');
    expect(new Set(campaigns.map(campaign => campaign.id)).size).toBe(campaigns.length);
    expect(records + source).not.toMatch(/recipientIds|x-admin-secret|botSecret|deviceSecret|all_players/);
  });
  test('with nothing current the controller stays inert and the catalogue keeps the full width', () => {
    const view = page({ data: build.buildPublicData(legacy), now: '2026-11-10T02:00:00Z', desktop: true, hash: '#' + celebrationId });
    expect(view.aside).toBeNull();
    expect(view.layout.children).toEqual([view.apps]);
    expect(view.window.setInterval).not.toHaveBeenCalled();
    expect(view.events).toEqual({});
    expect(view.media.listeners).toHaveLength(0);
  });
  test('the data file that is actually published renders at any moment without errors', () => {
    for (const now of ['2026-10-01T00:00:00Z', '2026-11-10T02:00:00Z', '2026-12-25T02:00:00Z', '2030-01-01T00:00:00Z']) {
      for (const lang of ['zh-Hant', 'en']) {
        const view = page({ data: publishedData(), now, lang, desktop: true });
        if (view.aside) expect(view.aside.text).not.toMatch(/undefined|\{[dhms]\}/);
      }
    }
  });
  test('a missing layout or missing data exits safely', () => {
    expect(() => page({ data: sampleData(), now: '2026-12-26T02:00:00Z', withLayout: false })).not.toThrow();
    expect(page({ data: undefined, now: '2026-12-26T02:00:00Z' }).aside).toBeNull();
    expect(page({ data: [], now: '2026-12-26T02:00:00Z' }).aside).toBeNull();
  });
});

describe('a campaign through its life', () => {
  test('hidden until the announcement date, then shown as upcoming with a countdown to the start', () => {
    const view = page({ data: sampleData(), now: '2026-12-11T01:59:58Z' });
    expect(view.aside).toBeNull();
    expect(view.window.setInterval).toHaveBeenCalledTimes(1);

    view.tick('2026-12-11T02:00:00Z');
    expect(view.layout.children[0]).toBe(view.aside);
    expect(view.layout.children[1]).toBe(view.apps);
    const card = view.card(christmasId);
    expect(card.attributes['data-state']).toBe('upcoming');
    expect(card.text).toContain('聖誕節禮包');
    expect(card.text).toContain('即將開始');
    expect(card.text).toContain('《REBOUND：元素戰機》：火花 3,000 點、戰機復活卡 1 張、1H 戰利品加倍卡 1 張。商品標價換算約 NT$150，非現金價值。');
    expect(card.text).toContain('《活字戰紀：雙城烽火》：金幣 100。');
    expect(card.text).toContain('開始寄送：2026/12/25 10:00（台北時間）。');
    expect(card.text).toContain('距離開始 14 天 00 時 00 分 00 秒');
    expect(card.text).not.toContain('已寄出');
  });
  test('the countdown ticks in place without rebuilding the sidebar', () => {
    const view = page({ data: sampleData(), now: '2026-12-24T02:00:00Z' });
    const before = view.aside;
    view.tick('2026-12-25T01:59:59Z');
    expect(view.aside).toBe(before);
    expect(view.card(christmasId).text).toContain('距離開始 0 天 00 時 00 分 01 秒');
  });
  test('at the start it becomes live, counts down to the claim deadline and says the count is pending', () => {
    const view = page({ data: sampleData(), now: '2026-12-25T01:59:59Z' });
    const before = view.aside;
    view.tick('2026-12-25T02:00:00Z');
    expect(view.aside).not.toBe(before);
    const card = view.card(christmasId);
    expect(card.attributes['data-state']).toBe('active');
    expect(card.text).toContain('進行中');
    expect(card.text).toContain('領取倒數 31 天 00 時 00 分 00 秒');
    expect(card.text).toContain('寄送數量核對後會更新在這裡。');
    expect(card.text).not.toContain('開始寄送');
  });
  test('verified receipts are shown as delivery counts', () => {
    const receipts = [
      { gameId: 'rebound', verifiedAt: '2026-12-25T02:07:00.000Z', mails: 150, claimed: 3, final: false },
      { gameId: 'typeforge-twin-cities', verifiedAt: '2026-12-25T02:08:00.000Z', mails: 1234, claimed: 0, final: false }
    ];
    const card = page({ data: sampleData({ receipts }), now: '2026-12-26T02:00:00Z' }).card(christmasId);
    expect(card.text).toContain('《REBOUND：元素戰機》已寄出 150 封（2026/12/25 10:07 核對）；這是寄送數，不代表領取數。');
    expect(card.text).toContain('《活字戰紀：雙城烽火》已寄出 1,234 封');
    expect(card.text).not.toContain('寄送數量核對後會更新在這裡。');
  });
  test('at the claim deadline the sidebar disappears on its own', () => {
    const view = page({ data: sampleData(), now: '2027-01-25T01:59:59Z' });
    expect(view.card(christmasId).text).toContain('領取倒數 0 天 00 時 00 分 01 秒');
    view.tick('2027-01-25T02:00:00Z');
    expect(view.aside).toBeNull();
    expect(view.layout.children).toEqual([view.apps]);
  });
  test('earlier campaigns are listed as history while something is current, never as the promotion', () => {
    const view = page({ data: sampleData(), now: '2026-12-26T02:00:00Z' });
    const history = view.layout.find(node => node.className === 'gift-history');
    expect(history.text).toContain('過去的活動');
    expect(history.text).toContain('元素戰機350｜《紙上彈兵》普天同慶禮包');
    expect(history.text).toContain('2026/10/07 – 2026/11/07｜共寄出 146 封');
    expect(view.card(celebrationId)).toBeNull();
    // The record without public copy is never listed.
    expect(view.aside.text).not.toContain('rebound-autumn-welcome-2026');
    expect(view.layout.findAll(node => node.tagName === 'li')).toHaveLength(1);
  });
  test('two current campaigns get a jump list, live one first', () => {
    const [christmas] = sampleData().filter(campaign => campaign.id === christmasId);
    const later = { ...christmas, id: 'second-2026', announceAt: '2026-12-20T02:00:00.000Z', startsAt: '2027-01-10T02:00:00.000Z', claimEndsAt: '2027-02-10T02:00:00.000Z' };
    const view = page({ data: [later, christmas], now: '2026-12-26T02:00:00Z' });
    const links = view.layout.find(node => node.id === 'giftCampaignList').children;
    expect(links.map(link => link.attributes.href)).toEqual(['#' + christmasId, '#second-2026']);
    expect(view.layout.findAll(node => node.attributes['data-campaign-id']).map(node => node.attributes['data-state'])).toEqual(['active', 'upcoming']);
    for (const link of links) expect(view.document.getElementById(link.attributes.href.slice(1))).not.toBeNull();
    // A single campaign needs no list.
    expect(page({ data: sampleData(), now: '2026-12-26T02:00:00Z' }).layout.find(node => node.id === 'giftCampaignList')).toBeNull();
  });
});

describe('language and disclosure behaviour', () => {
  test.each([
    ['zh-Hant', '禮包公告', '聖誕節禮包', '進行中'],
    ['zh-TW', '禮包公告', '聖誕節禮包', '進行中'],
    ['zh-CN', '礼包公告', '圣诞节礼包', '进行中'],
    ['zh-Hans', '礼包公告', '圣诞节礼包', '进行中'],
    ['en', 'Gift announcements', 'Christmas gift', 'Live now'],
    ['ja', 'ギフトのお知らせ', 'クリスマスギフト', '開催中'],
    ['ko-KR', '선물 공지', '크리스마스 선물', '진행 중'],
    ['fr', 'Gift announcements', 'Christmas gift', 'Live now']
  ])('renders %s completely', (lang, entry, title, badge) => {
    const view = page({ data: sampleData(), now: '2026-12-26T02:00:00Z', lang });
    expect(view.aside.text).toContain(entry);
    const card = view.card(christmasId);
    expect(card.text).toContain(title);
    expect(card.text).toContain(badge);
    expect(card.findAll(node => node.tagName === 'p').every(node => node.textContent.length > 0)).toBe(true);
    expect(card.text).not.toMatch(/\{[dhms]\}|undefined/);
  });
  test('a language change rebuilds once without duplicating cards', () => {
    const view = page({ data: sampleData(), now: '2026-12-26T02:00:00Z' });
    view.relang('2026-12-26T02:00:05Z', 'en');
    view.relang('2026-12-26T02:00:06Z', 'en');
    expect(view.layout.findAll(node => node.className === 'portfolio-gift-sidebar')).toHaveLength(1);
    expect(view.layout.findAll(node => node.attributes['data-campaign-id'] === christmasId)).toHaveLength(1);
    expect(view.card(christmasId).text).toContain('Time left to claim: 29d 23h 59m 54s');
  });
  test('opens on desktop, collapses on mobile, and follows the breakpoint', () => {
    expect(page({ data: sampleData(), now: '2026-12-26T02:00:00Z', desktop: true }).disclosure.open).toBe(true);
    const mobile = page({ data: sampleData(), now: '2026-12-26T02:00:00Z' });
    expect(mobile.disclosure.open).toBe(false);
    expect(mobile.layout.children).toContain(mobile.apps);
    mobile.media.matches = true;
    mobile.media.listeners[0]();
    expect(mobile.disclosure.open).toBe(true);
    mobile.media.matches = false;
    mobile.media.listeners[0]();
    expect(mobile.disclosure.open).toBe(false);
  });
  test.each(['#game-gifts', '#' + christmasId])('a direct link to %s opens the mobile disclosure', hash => {
    expect(page({ data: sampleData(), now: '2026-12-26T02:00:00Z', hash }).disclosure.open).toBe(true);
  });
  test('a campaign link scrolls to its card once the sidebar exists', () => {
    const scrolled = [];
    const original = FakeNode.prototype.scrollIntoView;
    FakeNode.prototype.scrollIntoView = function () { scrolled.push(this.id); };
    try { page({ data: sampleData(), now: '2026-12-26T02:00:00Z', hash: '#' + christmasId }); } finally { FakeNode.prototype.scrollIntoView = original; }
    expect(scrolled).toEqual([christmasId]);
  });
  test('hash navigation reveals the sidebar again after the visitor collapsed it; unrelated anchors do not', () => {
    const view = page({ data: sampleData(), now: '2026-12-26T02:00:00Z', hash: '#unrelated' });
    expect(view.disclosure.open).toBe(false);
    view.window.location.hash = '#' + christmasId;
    view.events.hashchange();
    expect(view.disclosure.open).toBe(true);
    view.disclosure.open = false;
    view.window.location.hash = '#appGrid';
    view.events.hashchange();
    expect(view.disclosure.open).toBe(false);
  });
  test('the state the visitor chose survives a rebuild', () => {
    const view = page({ data: sampleData(), now: '2026-12-24T02:00:00Z', desktop: true });
    view.disclosure.open = false;
    view.tick('2026-12-25T02:00:00Z');
    expect(view.card(christmasId).attributes['data-state']).toBe('active');
    expect(view.disclosure.open).toBe(false);
  });
  test('countdown formatting pads everything except days and never goes negative', () => {
    expect(sidebar.countdown('{d}|{h}|{m}|{s}', 3 * 86400000 + 4 * 3600000 + 5 * 60000 + 6000)).toBe('3|04|05|06');
    expect(sidebar.countdown('{d}|{h}|{m}|{s}', -5000)).toBe('0|00|00|00');
  });
});
