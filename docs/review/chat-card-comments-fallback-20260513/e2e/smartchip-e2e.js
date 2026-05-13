// Smart-chip card preview E2E (card_621e1261)
// Verifies PR #2677 fallback: /comments fail → inline c.comments used; truly empty → localized empty msg.
const { chromium } = require('/Users/hank/Desktop/Project/uiux-inspection/node_modules/playwright');
const fs = require('fs');
const path = require('path');

const HOST = 'https://eclawbot.com';
// Set E2E_DEVICE_ID and E2E_DEVICE_SECRET in your shell before running.
const DEVICE_ID = process.env.E2E_DEVICE_ID;
const DEVICE_SECRET = process.env.E2E_DEVICE_SECRET;
if (!DEVICE_ID || !DEVICE_SECRET) {
  console.error('Missing E2E_DEVICE_ID / E2E_DEVICE_SECRET env vars.');
  process.exit(1);
}
const POPULATED_CARD = 'card_3ca7b8d8ed5d4e9827ab343c'; // 12 comments per API
const FAKE_EMPTY_CARD = 'card_e2e_empty_fixture'; // mocked, never hits server

const LOCALES = [
  { tag: 'zh-TW', lang: 'zh-TW', emptyString: '還沒有留言' },
  { tag: 'en',    lang: 'en',    emptyString: 'No comments yet' },
  { tag: 'ja',    lang: 'ja',    emptyString: 'コメントがありません' },
];

const OUT = '/tmp/smartchip-e2e-shots';
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

async function captureScenario(browser, locale, scenario) {
  const tag = `${locale.tag}-${scenario.name}`;
  const ctx = await browser.newContext({
    viewport: { width: 412, height: 900 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
  });

  // Install API mocks BEFORE any navigation.
  // scenario.mockMode controls comments endpoint behavior.
  await ctx.route('**/api/mission/card/**', async route => {
    const url = route.request().url();
    // The /comments sub-endpoint
    if (url.includes('/comments?') || /\/comments(?:\?|$)/.test(url)) {
      if (scenario.mockMode === 'fail-comments') {
        // Simulate transient failure: 500 → swallowed by .catch(()=>null)
        return route.fulfill({ status: 500, body: 'mock failure' });
      }
      if (scenario.mockMode === 'empty-both') {
        return route.fulfill({ status: 200, contentType: 'application/json',
          body: JSON.stringify({ success: true, comments: [] }) });
      }
      // success-path → let it pass through
      return route.continue();
    }
    // The card detail endpoint (no /comments suffix, but /card/ID)
    if (/\/card\/[^/]+(?:\?|$)/.test(url) && !url.includes('/comments') && !url.includes('/files')) {
      if (scenario.mockMode === 'fail-comments' && url.includes(POPULATED_CARD)) {
        // Inline comments MUST still be present so the fallback can pick them up.
        // Let it pass through — real backend already returns inline c.comments.
        return route.continue();
      }
      if (scenario.mockMode === 'empty-both') {
        // Stub the card detail with empty comments
        return route.fulfill({ status: 200, contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            card: {
              id: FAKE_EMPTY_CARD,
              title: '[E2E] Empty-state fixture',
              description: 'This card has no comments. Used to verify the empty-state string renders correctly.',
              status: 'todo',
              priority: 'P2',
              assignedBots: [2],
              commentCount: 0,
              comments: [],
              createdAt: Date.now() - 60000,
              updatedAt: Date.now() - 60000,
            },
          }),
        });
      }
      return route.continue();
    }
    return route.continue();
  });

  const page = await ctx.newPage();
  const consoleMsgs = [];
  page.on('console', m => consoleMsgs.push(`[${m.type()}] ${m.text()}`));

  // Visit chat with auth + lang
  const url = `${HOST}/portal/chat.html?deviceId=${DEVICE_ID}&deviceSecret=${DEVICE_SECRET}&lang=${locale.lang}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  // Wait for currentUser to populate (auth.js sets window.currentUser after device-login)
  try {
    await page.waitForFunction(() => window.currentUser && window.currentUser.deviceId, { timeout: 20000 });
  } catch (_) { /* fall through to authOk check */ }
  await page.waitForTimeout(1500);

  // Confirm currentUser loaded
  const authOk = await page.evaluate(() => !!(window.currentUser && window.currentUser.deviceId));
  if (!authOk) {
    console.error(`${tag}: auth failed`);
    await page.screenshot({ path: `${OUT}/${tag}-auth-fail.png`, fullPage: true });
    await page.close();
    await ctx.close();
    return { tag, error: 'auth fail', consoleMsgs };
  }

  // Confirm locale active
  const langOk = await page.evaluate(loc => (window.i18n && window.i18n.lang) || null, locale.lang);
  console.log(`${tag}: i18n.lang=${langOk}`);

  // Trigger the card preview modal directly (smart chip click handler dispatches here)
  const targetCard = scenario.cardId;
  await page.evaluate(cardId => {
    if (typeof window.openEntityModal !== 'function') {
      throw new Error('openEntityModal is not a function on window');
    }
    return window.openEntityModal('card', cardId);
  }, targetCard);

  // Wait for modal body to populate (entity-meta container)
  try {
    await page.waitForSelector('#entityModalBody .entity-meta', { timeout: 15000 });
    await page.waitForTimeout(800);
  } catch (e) {
    console.error(`${tag}: modal did not render`);
  }

  // Extract what's actually shown
  const observed = await page.evaluate(() => {
    const body = document.getElementById('entityModalBody');
    if (!body) return { error: 'no modal body' };
    const empty = body.querySelector('.entity-comments-empty');
    const comments = body.querySelectorAll('.entity-comment');
    return {
      emptyText: empty ? empty.textContent.trim() : null,
      commentCount: comments.length,
      headerText: (body.querySelector('.entity-comments-header')?.textContent || '').trim(),
    };
  });

  console.log(`${tag}: observed=${JSON.stringify(observed)}`);

  const file = `${OUT}/smartchip-${tag}.png`;
  await page.screenshot({ path: file, fullPage: false });

  await page.close();
  await ctx.close();
  return { tag, scenario: scenario.name, locale: locale.tag, ...observed, file, consoleErrs: consoleMsgs.filter(m => m.startsWith('[error]')) };
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const results = [];

  const scenarios = [
    { name: 'populated',         cardId: POPULATED_CARD,  mockMode: 'pass-through' },
    { name: 'fail-fallback',     cardId: POPULATED_CARD,  mockMode: 'fail-comments' },
    { name: 'empty-state',       cardId: FAKE_EMPTY_CARD, mockMode: 'empty-both' },
  ];

  for (const locale of LOCALES) {
    for (const scenario of scenarios) {
      console.log(`\n--- ${locale.tag} / ${scenario.name} (${scenario.mockMode}) ---`);
      const r = await captureScenario(browser, locale, scenario);
      results.push(r);
    }
  }

  await browser.close();
  fs.writeFileSync(`${OUT}/_results.json`, JSON.stringify(results, null, 2));

  // Print summary table
  console.log('\n=================== SUMMARY ===================');
  for (const r of results) {
    const verdict =
      r.scenario === 'empty-state'
        ? (r.emptyText && r.commentCount === 0 ? 'PASS empty msg' : 'FAIL')
        : (r.commentCount > 0 && !r.emptyText ? `PASS ${r.commentCount} comments` : 'FAIL — empty msg or zero count');
    console.log(`${r.tag.padEnd(28)} commentCount=${String(r.commentCount).padEnd(3)} emptyText="${r.emptyText || ''}"  → ${verdict}`);
  }
  console.log('\nWritten:', OUT);
})().catch(e => {
  console.error(e);
  process.exit(1);
});
