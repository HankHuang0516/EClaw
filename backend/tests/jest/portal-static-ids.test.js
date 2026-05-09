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

  test('mission note page public toggle has a stable accessible label before state hydration', () => {
    const missionPath = path.join(__dirname, '../../public/portal/mission.html');
    const html = fs.readFileSync(missionPath, 'utf8');

    const buttonMatch = html.match(/<button\s+[^>]*id=["']wvPublicToggle["'][^>]*>([\s\S]*?)<\/button>/);
    expect(buttonMatch).not.toBeNull();
    const buttonMarkup = buttonMatch[0];
    const initialText = buttonMatch[1].replace(/<[^>]*>/g, '').trim();

    expect(buttonMarkup).toMatch(/aria-label=["'][^"']+["']/);
    expect(initialText.length).toBeGreaterThan(0);
    expect(html).toContain("btn.setAttribute('aria-label', toggleLabel)");
  });

  test('marketplace redirect shim keeps mobile viewport metadata', () => {
    const marketplacePath = path.join(__dirname, '../../public/portal/marketplace.html');
    const html = fs.readFileSync(marketplacePath, 'utf8');

    expect(html).toMatch(/<meta\s+name=["']viewport["']\s+content=["']width=device-width,\s*initial-scale=1\.0["']>/);
  });

});
