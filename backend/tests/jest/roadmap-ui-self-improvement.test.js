'use strict';

const fs = require('fs');
const path = require('path');

describe('roadmap UI self-improvement pass', () => {
  const htmlPath = path.join(__dirname, '../../public/portal/roadmap.html');
  let html;

  beforeAll(() => {
    html = fs.readFileSync(htmlPath, 'utf8');
  });

  test('adds a compact jump strip for the long roadmap page', () => {
    expect(html).toContain('<nav class="rm-jump-strip" aria-label="Roadmap sections">');
    [
      '#ai-agent-self-improvement',
      '#rental-marketplace-roadmap',
      '#hermes-channel-roadmap',
      '#desktop-configuration-roadmap',
    ].forEach((href) => {
      expect(html).toContain(`href="${href}"`);
    });
    expect(html).toContain('id="rental-marketplace-roadmap"');
    expect(html).toContain('id="hermes-channel-roadmap"');
    expect(html).toContain('id="desktop-configuration-roadmap"');
  });

  test('keeps roadmap flows and tables mobile-safe', () => {
    expect(html).toMatch(/\.rm-table-wrap\s*\{[\s\S]*overflow-x:\s*auto/);
    expect(html.match(/class="rm-table-wrap" tabindex="0"/g)).toHaveLength(2);
    expect(html).toMatch(/@media \(max-width:\s*560px\)[\s\S]*\.rm-flow-step\s*\{[\s\S]*flex:\s*1 1 100%/);
    expect(html).toMatch(/@media \(max-width:\s*560px\)[\s\S]*\.rm-flow-arrow\s*\{[\s\S]*transform:\s*rotate\(90deg\)/);
    expect(html).toContain('role="list" aria-label="Owner listing flow"');
    expect(html).toContain('role="listitem" data-i18n="rm_step_bind"');
    expect(html).toContain('class="rm-flow-arrow" aria-hidden="true"');
  });

  test('live tracker rows expose status metadata without secret values', () => {
    expect(html).toContain("row.setAttribute('data-status', status)");
    expect(html).toContain("row.setAttribute('aria-label', `${it.num}. ${it.title}: ${statusLabel}${it.live ? ' from kanban' : ' fallback status'}`)");
    expect(html).toMatch(/@media \(max-width:\s*560px\)[\s\S]*\.rm-oodar-row\s*\{[\s\S]*flex-wrap:wrap/);
    expect(html).not.toMatch(/DATABASE_URL|CLOUDFLARE_API_TOKEN|Bearer\s+[A-Za-z0-9._-]+|ghp_[A-Za-z0-9_]+/);
  });
});
