const fs = require('fs');
const path = require('path');

describe('about-founder share controls', () => {
  const htmlPath = path.join(__dirname, '../../public/portal/about-founder.html');
  let html;

  beforeAll(() => {
    html = fs.readFileSync(htmlPath, 'utf8');
  });

  test('adds native share and copy-link actions with an accessible status region', () => {
    expect(html).toContain('id="aboutFounderShareLabel"');
    expect(html).toContain('onclick="shareFounderStory()" aria-describedby="shareStatus"');
    expect(html).toContain('onclick="copyFounderLink()" aria-describedby="shareStatus"');
    expect(html).toContain('id="shareStatus" class="share-status" role="status" aria-live="polite" aria-atomic="true"');
    expect(html).toContain('const FOUNDER_CANONICAL_URL = \'https://eclawbot.com/portal/about-founder.html\'');
  });

  test('keeps a browser-safe copy fallback and never leaks credentials', () => {
    expect(html).toContain('navigator.clipboard.writeText(FOUNDER_CANONICAL_URL)');
    expect(html).toContain("document.execCommand('copy')");
    expect(html).toContain('navigator.share');
    expect(html).not.toMatch(/botSecret|deviceSecret|DATABASE_URL|CLOUDFLARE_API_TOKEN/);
  });

  test('keeps mobile share controls full-width to avoid clipped labels', () => {
    expect(html).toMatch(/@media \(max-width:\s*560px\)[\s\S]*\.share-row\s*\{[\s\S]*grid-template-columns:\s*1fr/);
    expect(html).toMatch(/@media \(max-width:\s*560px\)[\s\S]*\.share-btn,\s*\n\s*\.share-action\s*\{[\s\S]*width:\s*100%/);
    expect(html).toMatch(/\.share-btn,\s*\n\s*\.share-action\s*\{[\s\S]*min-height:\s*36px/);
  });
});
