const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '../../public/AiHankApps');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

// Hank's portfolio H rule (2026-10-07): lower right, 16% wide with an 8% inset; where that still touches
// a title or a figure, shrink and nudge it further into the corner instead of using another corner.
const TITLE_SAFE = {
  weesh: ['13%', '5%', '4%'],
  'stray-map': ['13%', '5%', '4%'],
  'property-roi': ['13%', '5%', '4%'],
  chumen: ['11%', '4%', '3%'],
  'paper-flick-soldiers': ['11%', '4%', '3%'],
  rebound: ['9%', '5%', '2.5%'],
  'typeforge-twin-cities': ['11%', '4%', '3%'],
  'summit-battle': ['11%', '4%', '3%'],
  'vibe-empire': ['11%', '4%', '3%'],
};

function fakeElement(tagName) {
  const properties = {};
  return {
    tagName: tagName.toUpperCase(),
    children: [],
    attributes: {},
    className: '',
    textContent: '',
    classes: [],
    classList: { add(name) { this.owner.classes.push(name); } },
    style: { setProperty(name, value) { properties[name] = value; }, properties },
    appendChild(child) { this.children.push(child); return child; },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    addEventListener() {},
  };
}

function createIconFromPage() {
  const html = read('index.html');
  const start = html.indexOf('const H_WATERMARK_TIGHT');
  const fn = html.indexOf('function createIcon(', start);
  let depth = 0;
  let end = -1;
  for (let i = html.indexOf('{', fn); i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}' && --depth === 0) { end = i + 1; break; }
  }
  const document = {
    createElement(tag) {
      const element = fakeElement(tag);
      element.classList.owner = element;
      return element;
    },
  };
  return vm.runInNewContext(`${html.slice(start, end)}; createIcon`, { document });
}

function inlineAppList() {
  const match = read('index.html').match(/const appList = (\[[\s\S]*?\n\s*\]);/);
  return vm.runInNewContext(`(${match[1]})`);
}

describe('AiHankApps H watermark placement', () => {
  test('the card overlay defaults to the approved lower-right 16% / 8% placement', () => {
    const rule = read('index.html').match(/\.app-icon::after \{([^}]*)\}/)[1];
    expect(rule).toContain('right: var(--h-right, 8%);');
    expect(rule).toContain('bottom: var(--h-bottom, 8%);');
    expect(rule).toContain('width: var(--h-size, 16%);');
    expect(rule).toContain('height: var(--h-size, 16%);');
    expect(rule).not.toMatch(/\b(top|left):/);
  });

  test('title-safe icons only shrink and stay in the lower-right corner', () => {
    const createIcon = createIconFromPage();
    for (const app of inlineAppList()) {
      const icon = createIcon(app);
      const tight = TITLE_SAFE[app.communityId];
      const props = icon.style.properties;
      if (!tight) {
        expect(props).toEqual({});
        continue;
      }
      expect([props['--h-size'], props['--h-right'], props['--h-bottom']]).toEqual(tight);
      expect(parseFloat(tight[0])).toBeLessThan(16);
      expect(parseFloat(tight[1])).toBeLessThanOrEqual(8);
      expect(parseFloat(tight[2])).toBeLessThanOrEqual(8);
    }
  });

  test('the baked Anthill icon still gets no second H', () => {
    const createIcon = createIconFromPage();
    const anthill = inlineAppList().find(app => app.communityId === 'anthill');
    const icon = createIcon(anthill);
    expect(icon.className).toBe('app-icon app-icon--watermarked');
    expect(icon.style.properties).toEqual({});
  });

  test('both edited introduction pages show their app icon with the game H in the lower right', () => {
    const paper = read('guides/paper-flick-soldiers/index.html');
    expect(paper).toContain('<span class="hero-icon"><img src="../../icons/store-paper-flick-soldiers-9af88bf1827f.jpg"');
    expect(paper).toMatch(/\.hero-icon:after\{[^}]*right:6%;bottom:4%;width:8%;height:8%;background:url\("\.\.\/\.\.\/brand\/h-watermark-game-italic\.png"\)/);

    const typeforge = read('guides/typeforge/index.html');
    expect(typeforge).toContain('<span class="app-icon-h"><img src="./assets/app-icon.png"');
    expect(typeforge).toMatch(/\.app-icon-h::after \{[^}]*right: 6%; bottom: 5%; width: 11%; height: 11%; background: url\("\.\.\/\.\.\/brand\/h-watermark-game-italic\.png"\)/);
  });
});
