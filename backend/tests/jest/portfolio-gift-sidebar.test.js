'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.resolve(__dirname, '../../public/AiHankApps');
const source = fs.readFileSync(path.join(root, 'gift-sidebar.js'), 'utf8');
const records = fs.readFileSync(path.join(root, 'gift-campaigns.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'gift-sidebar.css'), 'utf8');
const campaignId = 'elemental-fighter350-paper-celebration-20261007';

function start({ desktop = false, hash = '', lang = 'zh-Hant', now = '2026-10-08T10:53:52.797Z', missing = [], extra = [] } = {}) {
  const elements = {};
  for (const match of html.matchAll(/id="([^"]+)"/g)) elements[match[1]] = { textContent: '', dataset: {} };
  const labels = Array.from(html.matchAll(/data-gift-i18n="([^"]+)"[^>]*>([^<]*)/g), match => ({
    dataset: { giftI18n: match[1] }, textContent: match[2]
  }));
  const title = labels.find(label => label.dataset.giftI18n === 'celebrationTitle');
  elements.celebrationGiftTitle = title;
  elements.reboundGiftTitle.textContent = 'REBOUND：元素戰機｜中秋新人大禮包';
  const disclosure = elements['game-gifts'];
  disclosure.open = false;
  disclosure.querySelectorAll = () => labels;
  const list = elements.giftCampaignList;
  list.children = [];
  list.appendChild = child => list.children.push(child);
  list.replaceChildren = () => { list.children = []; };
  const events = {};
  const media = { matches: desktop, addEventListener: jest.fn() };
  const document = { documentElement: { lang }, getElementById: id => elements[id] || null,
    createElement: () => ({ dataset: {} }) };
  const window = { location: { hash }, matchMedia: () => media, setInterval: jest.fn(),
    addEventListener: (event, handler) => { events[event] = handler; } };
  let changeLanguage;
  class Observer { constructor(callback) { changeLanguage = callback; } observe() {} }
  class FixedDate extends Date { static now() { return Date.parse(now); } }
  const sandbox = { window, document, MutationObserver: Observer, Date: FixedDate };
  vm.runInNewContext(records, sandbox);
  if (extra.length) window.AIHANK_GIFT_CAMPAIGNS = [...window.AIHANK_GIFT_CAMPAIGNS, ...extra];
  for (const id of missing) delete elements[id];
  vm.runInNewContext(source, sandbox);
  return { window, document, disclosure, list, elements, labels, media, events, changeLanguage };
}

describe('portfolio gift sidebar', () => {
  test('opens on desktop and collapses on mobile without hiding the catalogue', () => {
    expect(start({ desktop: true }).disclosure.open).toBe(true);
    const mobile = start();
    expect(mobile.disclosure.open).toBe(false);
    mobile.media.matches = true;
    mobile.media.addEventListener.mock.calls[0][1]();
    expect(mobile.disclosure.open).toBe(true);
    mobile.media.matches = false;
    mobile.media.addEventListener.mock.calls[0][1]();
    expect(mobile.disclosure.open).toBe(false);
    expect(html).toContain('class="portfolio-apps"');
  });
  test.each(['#game-gifts', '#reboundGiftTitle', '#celebrationGiftTitle', '#' + campaignId])('opens direct mobile anchor %s', hash => {
    expect(start({ hash }).disclosure.open).toBe(true);
  });
  test('hash history reveals a campaign after the user collapses it', () => {
    const page = start();
    page.window.location.hash = '#' + campaignId;
    page.events.hashchange();
    expect(page.disclosure.open).toBe(true);
    page.disclosure.open = false;
    page.events.hashchange();
    expect(page.disclosure.open).toBe(true);
  });
  test('unrelated anchors do not open the mobile disclosure', () => {
    expect(start({ hash: '#unrelated' }).disclosure.open).toBe(false);
  });
  test('lists newest first and each detail link targets one real campaign', () => {
    const page = start();
    expect(page.list.children).toHaveLength(2);
    expect(page.list.children[0].href).toBe('#' + campaignId);
    for (const link of page.list.children) expect(page.elements[link.href.slice(1)]).toBeDefined();
    expect(html.indexOf('id="' + campaignId + '"')).toBeLessThan(html.indexOf('id="rebound-autumn-welcome-2026"'));
  });
  test('does not expose draft or missing campaign records', () => {
    const page = start({ extra: [{ id: 'game-gifts', publication: 'draft' }, { id: 'not-published-to-dom', publication: 'published' }] });
    expect(page.list.children).toHaveLength(2);
  });
  test('missing disclosure exits safely', () => {
    expect(() => start({ missing: ['game-gifts'] })).not.toThrow();
  });
  test('missing list, countdown or title does not break other cards', () => {
    expect(() => start({ missing: ['giftCampaignList', 'celebrationCountdown'] })).not.toThrow();
    expect(start({ missing: ['celebrationGiftTitle'] }).list.children).toHaveLength(1);
  });
  test('immutable published receipt holds the approved issue count and deadline, not player details', () => {
    const campaigns = start().window.AIHANK_GIFT_CAMPAIGNS;
    const celebration = campaigns.find(campaign => campaign.id === campaignId);
    expect(Object.isFrozen(campaigns)).toBe(true);
    expect(Object.isFrozen(celebration)).toBe(true);
    expect(celebration.issuedCount).toBe(146);
    expect(celebration.startsAt).toBe('2026-10-07T10:53:52.797Z');
    expect(celebration.endsAt).toBe('2026-11-07T10:53:52.797Z');
    expect(celebration.statusSource).toBe('verified-production-mailbox-receipt');
    expect(celebration).not.toHaveProperty('statusUrl');
    expect(new Set(campaigns.map(campaign => campaign.id)).size).toBe(2);
    for (const campaign of campaigns) expect(html.split('data-campaign-id="' + campaign.id + '"')).toHaveLength(2);
    expect(records + source).not.toMatch(/recipientIds|x-admin-secret|botSecret|deviceSecret|all_players/);
  });
  test('new copy has all approved items, value and delivery/claim distinction', () => {
    for (const value of ['紙上彈兵', '6,000', 'NT$300', '不代表全部已領取', '失敗 0', '重複 0', '4 個 QA', '每帳號一封']) expect(html).toContain(value);
    const giftMarkup = html.slice(html.indexOf('<aside'), html.indexOf('</aside>'));
    expect(giftMarkup).not.toContain('雙城烽火');
    expect(html).not.toContain('../shared/i18n.js');
    expect(source).not.toMatch(/fetch\(|apiCall\(|postMessage|localStorage|\/admin|credentials/);
  });
  test.each(['en', 'zh-Hant', 'zh-TW', 'zh-CN', 'ja', 'ko'])('renders all new labels in %s without a shared bundle', lang => {
    const page = start({ lang });
    expect(page.labels.every(label => label.textContent.length > 0)).toBe(true);
    expect(page.elements.celebrationCountdown.textContent).toContain('30');
    expect(page.list.children[0].textContent).toBe(page.elements.celebrationGiftTitle.textContent);
  });
  test('English explicitly promises both double effects', () => {
    const contents = start({ lang: 'en' }).labels.find(label => label.dataset.giftI18n === 'contents').textContent;
    expect(contents).toContain('double loot');
    expect(contents).toContain('double Sparks');
  });
  test('locale changes rebuild links without duplicates and unsupported locales fall back to English', () => {
    const page = start();
    page.document.documentElement.lang = 'fr';
    page.changeLanguage(); page.changeLanguage();
    expect(page.list.children).toHaveLength(2);
    expect(page.labels.find(label => label.dataset.giftI18n === 'entry').textContent).toBe('Gift announcements');
  });
  test.each(['2026-11-07T10:53:52.797Z', '2026-11-08T10:00:00Z'])('stops countdown at or after deadline %s', now => {
    expect(start({ now }).elements.celebrationCountdown.textContent).toBe('領取期限已截止');
  });
  test('keeps native mobile viewport, bounded desktop sidebar, and mobile traffic panel within card', () => {
    expect(html).toContain('name="viewport" content="width=device-width, initial-scale=1"');
    expect(css).toContain('overflow-y: auto');
    expect(css).toContain('.portfolio-apps .portfolio-traffic-details { left: 0; right: auto; max-width: 100%; }');
    expect(css).toContain(':focus-visible');
  });
});
