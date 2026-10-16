const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.join(__dirname, '../../public/AiHankApps');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const icon = 'anthill/icon-180-game-h-90e14cf7d5ac.png';

describe('Anthill portfolio icon and card regression', () => {
  test('both unchanged catalog formats retain the report-signed Anthill identity', () => {
    const json = JSON.parse(read('app-catalog.json'));
    const script = read('app-catalog.js');
    const js = JSON.parse(script.slice(script.indexOf('=') + 1).trim().replace(/;$/, ''));
    expect(js).toEqual(json);
    expect(json.apps.find(app => app.communityId === 'anthill')).toMatchObject({
      category: '遊戲', icon: 'icons/anthill.png'
    });
  });

  test('the rendered card uses the same icon without a second CSS watermark', () => {
    const html = read('index.html');
    expect(html).toContain("const hasBakedGameH = app.communityId === 'anthill' && app.icon === 'icons/anthill.png';");
    expect(html).toContain("img.src = hasBakedGameH ? '" + icon + "' : app.icon;");
    expect(html).toContain("? 'app-icon app-icon--watermarked'");
    expect(html).toContain('.app-icon--watermarked::after { content: none; }');
  });

  test('the selected existing icon bytes are unchanged', () => {
    const bytes = fs.readFileSync(path.join(root, icon));
    expect(fs.readFileSync(path.join(root, 'icons/anthill.png'))).toEqual(bytes);
    expect(crypto.createHash('sha256').update(bytes).digest('hex'))
      .toBe('90e14cf7d5acf5bb21e8431f3b82648ebe92ab4ef2cead1a38c2dfd04de1c24b');
  });

  test('card width, not a fixed right reservation, controls action placement', () => {
    const script = read('portfolio-analytics.js');
    expect(script).toContain('container-type:inline-size');
    expect(script).toContain('grid-template-columns:104px minmax(0,1fr)');
    expect(script).toContain('@container (min-width:540px)');
    expect(script).toContain('grid-column:1/-1');
    expect(script).not.toContain('padding-right:172px');
  });

  test('the hotfix does not change event collection or traffic data behavior', () => {
    const withoutStyles = read('portfolio-analytics.js').replace(/ {2}style\.textContent = `[\s\S]*?`;/, '');
    expect(crypto.createHash('sha256').update(withoutStyles).digest('hex'))
      .toBe('54f415bce42aa24f59ebafb06ee640a983568c61ed2cc5a13309aef6fe40b3c7');
  });
});
