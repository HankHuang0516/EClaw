const fs = require('fs');
const path = require('path');

describe('portal static HTML IDs', () => {
  test('dashboard invite banners have unique IDs and onboarding JS targets the onboarding banner', () => {
    const dashboardPath = path.join(__dirname, '../../public/portal/dashboard.html');
    const html = fs.readFileSync(dashboardPath, 'utf8');

    const ids = [...html.matchAll(/\bid=["']([^"']+)["']/g)]
      .map((match) => match[1])
      // Ignore JavaScript template-string selectors embedded in inline scripts.
      .filter((id) => !id.includes('${'));
    const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);

    expect(duplicates).not.toContain('inviteBanner');
    expect(new Set(ids).size).toBe(ids.length);
    expect(html).toContain('id="inviteOnboardingBanner"');
    expect(html).toContain('id="inviteFriendsBanner"');
    expect(html).toContain("document.getElementById('inviteOnboardingBanner')");
    expect(html).not.toContain("document.getElementById('inviteBanner')");
  });
});
