const fs = require('fs');
const path = require('path');

const serverSrc = fs.readFileSync(path.join(__dirname, '../../index.js'), 'utf8');

function expectRedirect(routes, target) {
  const routeList = routes.map(r => `'${r}'`).join(', ');
  const handlerRegex = new RegExp(
    `app\\.get\\(\\s*(?:\\[\\s*${routeList}\\s*\\]|${routes.length === 1 ? `'${routes[0]}'` : ''})\\s*,[\\s\\S]{1,200}res\\.redirect\\(\\s*301\\s*,\\s*['"]${target.replace(/\//g, '\\/')}['"]\\s*\\)`,
    'm'
  );
  expect(serverSrc).toMatch(handlerRegex);
}

describe('portal legacy redirects (Bug/SEO old /*.html paths)', () => {
  test('/info and /info.html → /portal/info.html', () => {
    expectRedirect(['/info', '/info.html'], '/portal/info.html');
  });

  test('/kanban and /kanban.html → /portal/kanban.html', () => {
    expectRedirect(['/kanban', '/kanban.html'], '/portal/kanban.html');
  });

  test('/settings and /settings.html → /portal/settings.html', () => {
    expectRedirect(['/settings', '/settings.html'], '/portal/settings.html');
  });

  test('/index.html → /portal/index.html', () => {
    expectRedirect(['/index.html'], '/portal/index.html');
  });
});
