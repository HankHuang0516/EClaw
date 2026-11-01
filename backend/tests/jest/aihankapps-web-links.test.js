const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '../../public/AiHankApps');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const expected = {
  eclawbot: 'https://eclawbot.com/',
  weesh: 'https://wishlist-app-production.up.railway.app/',
  timehut: 'https://just-healing-production.up.railway.app/app/index.html',
  'piggy-growth': 'https://hank-app01-save-money.netlify.app/',
};

function loadFunction(source, name, context = {}) {
  const start = source.lastIndexOf(`function ${name}(`);
  let depth = 0;
  for (let end = source.indexOf('{', start); end < source.length; end++) {
    if (source[end] === '{') depth++;
    if (source[end] === '}' && --depth === 0) {
      return vm.runInNewContext(`${source.slice(start, end + 1)}; ${name}`, context);
    }
  }
  throw new Error(`Missing function ${name}`);
}

function element(tag) {
  const node = {
    tagName: tag.toUpperCase(), children: [], attributes: {}, className: '',
    style: { setProperty() {} }, addEventListener() {},
    setAttribute(name, value) { this.attributes[name] = value; },
    appendChild(child) { this.children.push(child); return child; },
    querySelector(selector) {
      const descendants = parent => parent.children.flatMap(child => [child, ...descendants(child)]);
      const children = descendants(this);
      if (selector === '.card-head') return children.find(child => child.className === 'card-head') || null;
      if (selector === '.guide-actions') return children.find(child => child.className === 'guide-actions') || null;
      if (selector === '.guide-link:not(.web-link)') return children.find(child => child.className === 'guide-link') || null;
      return null;
    },
  };
  node.classList = { add() {}, contains(name) { return node.className.split(' ').includes(name); } };
  return node;
}

describe('public portfolio web-version actions', () => {
  const catalog = JSON.parse(read('app-catalog.json'));
  const html = read('index.html');
  const inline = vm.runInNewContext(`(${html.match(/const appList = (\[[\s\S]*?\n\s*\]);/)[1]})`);
  const document = { createElement: element };
  const createWebLink = loadFunction(html, 'createWebLink', { document, URL });

  test('the inline cards and both catalog formats agree on all public web versions', () => {
    const script = read('app-catalog.js');
    expect(JSON.parse(script.slice(script.indexOf('=') + 1).trim().replace(/;$/, ''))).toEqual(catalog);
    for (const [id, url] of Object.entries(expected)) {
      for (const apps of [catalog.apps, inline]) {
        expect(apps.find(app => app.communityId === id)).toMatchObject({ webUrl: url, publicWeb: true });
      }
    }
    expect(inline.filter(app => app.publicWeb).map(app => app.communityId).sort()).toEqual(Object.keys(expected).sort());
    expect(catalog.apps.find(app => app.communityId === 'weesh').name).toBe('Weesh');
  });

  test('launch links are named, localized, HTTPS, and isolated from the opener', () => {
    const link = createWebLink({ name: 'EClawbot', publicWeb: true, webUrl: expected.eclawbot });
    expect(link).toMatchObject({ tagName: 'A', href: expected.eclawbot, target: '_blank', rel: 'noopener noreferrer', textContent: '開啟網頁版' });
    expect(link.attributes).toMatchObject({ 'data-i18n': 'portfolio_web_version', 'aria-label': 'EClawbot：開啟網頁版' });
  });

  test.each([
    { publicWeb: false, webUrl: expected.eclawbot },
    { publicWeb: 'true', webUrl: expected.eclawbot },
    { publicWeb: true },
    { publicWeb: true, webUrl: 'not a url' },
    { publicWeb: true, webUrl: 'javascript:alert(1)' },
    { publicWeb: true, webUrl: 'http://example.com/' },
  ])('never exposes a draft, absent, or unsafe URL: %j', record => {
    expect(createWebLink(record)).toBeNull();
  });

  test('a web action does not suppress the original introduction or create a second action row', () => {
    const card = element('article');
    const head = element('div'); head.className = 'card-head'; card.appendChild(head);
    const actions = element('div'); actions.className = 'guide-actions'; head.appendChild(actions);
    actions.appendChild(createWebLink({ name: 'Weesh', publicWeb: true, webUrl: expected.weesh }));
    const addGuideLink = loadFunction(read('community-v6.js'), 'addGuideLink', { document, URL });
    const config = { guide: 'guides/weesh/' };
    addGuideLink(card, { textContent: 'Weesh' }, config);
    addGuideLink(card, { textContent: 'Weesh' }, config);
    expect(head.children).toHaveLength(1);
    expect(actions.children).toHaveLength(2);
    expect(actions.children[1]).toMatchObject({ href: 'https://eclawbot.com/AiHankApps/guides/weesh/', textContent: '查看 APP 介紹' });
  });

  test('web clicks do not inflate the existing APP introduction counter', () => {
    const record = { name: 'EClawbot', communityId: 'eclawbot' };
    const tracked = [];
    const card = element('article');
    const link = createWebLink({ ...record, publicWeb: true, webUrl: expected.eclawbot });
    link.matches = () => false; link.closest = () => card;
    const click = loadFunction(read('portfolio-analytics.js'), 'click', {
      URL, location: { href: 'https://eclawbot.com/AiHankApps/' }, recordForCard: () => record,
      track: (...args) => tracked.push(args),
    });
    const event = { isTrusted: true, type: 'click', target: { closest: () => link } };
    click(event); expect(tracked).toEqual([]);
    link.className = 'guide-link'; click(event);
    expect(tracked).toEqual([['eclawbot', 'intro']]);
  });

  test('Timehut reuses its accepted baked-watermark asset without a second H overlay', () => {
    const record = catalog.apps.find(app => app.communityId === 'timehut');
    const createIcon = loadFunction(html, 'createIcon', { document, H_WATERMARK_TIGHT: {} });
    const icon = createIcon(record);
    expect(icon.className).toBe('app-icon app-icon--watermarked');
    expect(icon.children[0].src).toBe(record.icon);
    expect(record).toMatchObject({ publicGoogle: true, publicApple: false });
    expect(record.iosUrl).toBeUndefined();
  });
});
