const fs = require('fs');
const path = require('path');

describe('compare page self-improvement UI', () => {
  const comparePath = path.join(__dirname, '../../public/portal/compare.html');
  const html = fs.readFileSync(comparePath, 'utf8');

  test('surfaces an answer-first verdict strip and section navigation', () => {
    expect(html).toContain('class="cmp-verdict"');
    expect(html.match(/class="cmp-verdict-card/g)).toHaveLength(3);
    expect(html).toContain('data-i18n="cmp_primary_takeaway"');
    expect(html).toContain('aria-label="Comparison sections"');

    ['cmp-setup', 'cmp-interaction', 'cmp-platform', 'cmp-operations'].forEach((id) => {
      expect(html).toContain(`href="#${id}"`);
      expect(html).toContain(`id="${id}"`);
    });
  });

  test('keeps comparison cells labeled for stacked mobile layout', () => {
    const eclawCells = html.match(/class="cmp-cell eclaw-cell" data-channel="EClawbot"/g) || [];
    const telegramCells = html.match(/class="cmp-cell telegram-cell" data-channel="Telegram"/g) || [];

    expect(eclawCells.length).toBeGreaterThanOrEqual(10);
    expect(eclawCells).toHaveLength(telegramCells.length);
    expect(html).toContain('content: attr(data-channel)');
    expect(html).toMatch(/@media \(max-width: 760px\)[\s\S]*\.cmp-row \{ grid-template-columns: 1fr; gap: 8px; \}/);
  });

  test('locks partial tag styling and conversion CTAs', () => {
    expect(html).toContain('.tag-partial');
    expect(html).toContain('href="index.html" class="btn btn-primary"');
    expect(html.match(/href="onboarding.html" class="btn btn-outline"/g)).toHaveLength(2);
  });
});
