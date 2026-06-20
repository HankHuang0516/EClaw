const fs = require('fs');
const path = require('path');

describe('invite QR generator UI state shell', () => {
  const htmlPath = path.join(__dirname, '../../public/portal/invite-qr-generator.html');
  let html;

  beforeAll(() => {
    html = fs.readFileSync(htmlPath, 'utf8');
  });

  test('renders a live status region tied to the invite code field', () => {
    expect(html).toContain('id="qrgStatus"');
    expect(html).toContain('role="status" aria-live="polite" aria-atomic="true"');
    expect(html).toContain('id="qrgStatusDetail"');
    expect(html).toContain('id="qrgCodeHelp"');
    expect(html).toContain('aria-describedby="qrgCodeHelp qrgStatusDetail"');
    expect(html).toContain('inputmode="latin"');
    expect(html).toContain("badge.dataset.state = state || 'empty'");
  });

  test('keeps image size controls as pressed-state buttons', () => {
    expect(html).toMatch(/class="qrg-size-btn active"[^>]+aria-pressed="true"/);
    expect(html.match(/class="qrg-size-btn"/g)).toHaveLength(2);
    expect(html.match(/aria-pressed="false"/g)).toHaveLength(2);
    expect(html).toContain("b.setAttribute('aria-pressed', active ? 'true' : 'false')");
  });

  test('does not redirect anonymous users while probing account invite code', () => {
    expect(html).toContain("apiCall('GET', '/api/invite/my-code', null, { skip401Redirect: true })");
    expect(html).toContain("tt('invite_qr_status_manual'");
  });

  test('falls back instead of rendering untranslated i18n keys', () => {
    expect(html).toContain('return value && value !== k ? value : fb;');
    expect(html).toContain("tt('invite_qr_status_rendering', 'Rendering preview')");
  });

  test('busy rendering disables actions and marks the preview stage', () => {
    expect(html).toContain("stage.setAttribute('aria-busy', renderBusy ? 'true' : 'false')");
    expect(html).toContain('btn.disabled = renderBusy');
    expect(html).toContain("btn.setAttribute('aria-disabled', renderBusy ? 'true' : 'false')");
    expect(html).toContain('qrg-preview-stage[aria-busy="true"] .qrg-preview-skeleton');
  });

  test('locks the responsive two-panel tool layout', () => {
    expect(html).toMatch(/\.qrg-shell\s*\{\s*display:\s*grid/);
    expect(html).toMatch(/grid-template-columns:\s*minmax\(280px,\s*360px\)\s*minmax\(0,\s*1fr\)/);
    expect(html).toMatch(/@media \(max-width:\s*820px\)[\s\S]*\.qrg-shell\s*\{\s*grid-template-columns:\s*1fr/);
  });
});
