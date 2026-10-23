const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '../../public/AiHankApps');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

// Only these itch.io pages are public. Anthill, Summit Battle and Vibe Empire are still drafts there.
const PUBLIC_ITCH_PAGES = {
  'paper-flick-soldiers': 'https://lolwarden0516.itch.io/paper-flick-soldiers',
  rebound: 'https://lolwarden0516.itch.io/rebound',
  'typeforge-twin-cities': 'https://lolwarden0516.itch.io/typeforge-twin-cities',
};
const DRAFT_ITCH_SLUGS = ['anthill', 'typeforge-summit-battle', 'vibe-empire'];

const itchUrls = apps => Object.fromEntries(apps.filter(app => app.itchUrl).map(app => [app.communityId, app.itchUrl]));

function inlineAppList() {
  const match = read('index.html').match(/const appList = (\[[\s\S]*?\n\s*\]);/);
  return vm.runInNewContext(`(${match[1]})`);
}

function fakeElement(tagName) {
  let markup = '';
  return {
    tagName: tagName.toUpperCase(),
    children: [],
    attributes: {},
    dataset: {},
    className: '',
    // Keep innerHTML and textContent coupled like the DOM, so a later innerHTML write is visible.
    get innerHTML() { return markup; },
    set innerHTML(value) { markup = String(value); },
    get textContent() { return markup.replace(/<[^>]*>/g, ''); },
    set textContent(value) { markup = String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;'); },
    classList: { add() {} },
    appendChild(child) { this.children.push(child); return child; },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    querySelector() { return {}; },
  };
}

function createStoreLinkFromPage() {
  const html = read('index.html');
  const start = html.indexOf('function createStoreLink(');
  let depth = 0;
  let end = -1;
  for (let i = html.indexOf('{', start); i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}' && --depth === 0) { end = i + 1; break; }
  }
  return vm.runInNewContext(`${html.slice(start, end)}; createStoreLink`, { document: { createElement: fakeElement } });
}

function toolbarDataset(guide) {
  const tag = read(`guides/${guide}/index.html`).match(/<script\b[^>]*\bdata-intro-toolbar\b[^>]*>/)[0];
  const dataset = {};
  for (const [, name, value = ''] of tag.matchAll(/\sdata-([a-z-]+)(?:="([^"]*)")?/g)) {
    dataset[name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
  }
  return dataset;
}

function renderToolbar(dataset, catalogApps) {
  const body = fakeElement('body');
  const prepended = [];
  body.prepend = node => prepended.push(node);
  const document = {
    currentScript: { dataset, src: 'https://eclawbot.com/AiHankApps/intro-toolbar-v2.js' },
    body,
    head: fakeElement('head'),
    createElement: fakeElement,
    querySelector: () => null,
  };
  const window = catalogApps ? { AIHANK_APP_CATALOG: { apps: catalogApps } } : {};
  vm.runInNewContext(read('intro-toolbar-v2.js'), { document, window, URL });
  return prepended[0].children.find(child => child.className === 'portfolio-intro-toolbar__stores').children;
}

describe('AiHankApps itch.io links', () => {
  const catalog = JSON.parse(read('app-catalog.json'));

  test('both catalog formats list exactly the three public itch.io pages', () => {
    const script = read('app-catalog.js');
    expect(JSON.parse(script.slice(script.indexOf('=') + 1).trim().replace(/;$/, ''))).toEqual(catalog);
    expect(itchUrls(catalog.apps)).toEqual(PUBLIC_ITCH_PAGES);
  });

  test('the rendered card list carries the same itch.io links and none for draft pages', () => {
    const apps = inlineAppList();
    expect(itchUrls(apps)).toEqual(PUBLIC_ITCH_PAGES);
    for (const id of ['anthill', 'summit-battle', 'vibe-empire']) {
      expect(apps.find(app => app.communityId === id).itchUrl).toBeUndefined();
    }
  });

  test('cards render itch.io as a new-tab store link and keep the existing store glyphs', () => {
    const createStoreLink = createStoreLinkFromPage();
    expect(createStoreLink(PUBLIC_ITCH_PAGES.rebound, 'itch', '正式版')).toMatchObject({
      tagName: 'A', className: 'store-link itch', href: PUBLIC_ITCH_PAGES.rebound,
      target: '_blank', rel: 'noreferrer', textContent: 'itch.io',
    });
    expect(createStoreLink('https://play.google.com/store/apps/details?id=x', 'google', '正式版').innerHTML).toBe('▶ Google Play');
    expect(createStoreLink(undefined, 'google', '開發中')).toMatchObject({ tagName: 'SPAN', className: 'store-link google unavailable' });

    const html = read('index.html');
    expect(html).toContain("createStoreLink(app.itchUrl, 'itch', '正式版')");
    expect(html).toContain('if (storeLinks.childElementCount) card.appendChild(storeLinks);');
  });

  test('card styles show the self-contained itch.io mark', () => {
    const svg = read('itch-icon.svg');
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 512 512" role="img" aria-label="itch\.io">/);
    expect(svg).not.toMatch(/<script|href=|url\(/i);
    expect(read('community-v5.css')).toMatch(/a\.store-link\.itch::before \{[^}]*background-image: url\("\.\/itch-icon\.svg"\);/);
    expect(read('index.html')).toContain('href="community-v5.css?v=itch-links-20261022"');
  });

  test('introduction toolbars add an itch.io action only for public itch.io pages', () => {
    const [google, apple, itch, extra] = renderToolbar(toolbarDataset('paper-flick-soldiers'), catalog.apps);
    expect(google.attributes['aria-label']).toBe('在Google Play下載紙上彈兵');
    expect(apple.attributes['aria-label']).toBe('在App Store下載紙上彈兵');
    expect(itch).toMatchObject({
      tagName: 'A', className: 'toolbar-itch', href: PUBLIC_ITCH_PAGES['paper-flick-soldiers'],
      target: '_blank', rel: 'noopener noreferrer',
    });
    expect(itch.attributes['aria-label']).toBe('在itch.io查看紙上彈兵');
    expect(extra).toBeUndefined();

    const typeforge = renderToolbar(toolbarDataset('typeforge'), catalog.apps);
    expect(typeforge.map(action => action.href)).toContain(PUBLIC_ITCH_PAGES['typeforge-twin-cities']);

    // Without the catalog the page's own data attributes are the fallback, as for the store links.
    const fallback = renderToolbar(toolbarDataset('paper-flick-soldiers'), null);
    expect(fallback[2].href).toBe(PUBLIC_ITCH_PAGES['paper-flick-soldiers']);

    const sleepPark = renderToolbar(toolbarDataset('sleep-park'), catalog.apps);
    expect(sleepPark.map(action => action.className)).toEqual(['toolbar-google', 'toolbar-apple']);
  });

  test('guide download rows link the public itch.io pages and no draft page is linked', () => {
    expect(read('guides/paper-flick-soldiers/index.html')).toContain(
      `<a class="paper-action" href="${PUBLIC_ITCH_PAGES['paper-flick-soldiers']}" target="_blank" rel="noopener noreferrer">itch.io</a>`
    );
    expect(read('guides/typeforge/index.html')).toContain('以及 itch.io 作品頁連結');

    const published = ['index.html', 'app-catalog.json', 'app-catalog.js', 'intro-toolbar-v2.js',
      'guides/paper-flick-soldiers/index.html', 'guides/typeforge/index.html'].map(read).join('\n');
    for (const slug of DRAFT_ITCH_SLUGS) {
      expect(published).not.toContain(`lolwarden0516.itch.io/${slug}`);
    }
  });
});
