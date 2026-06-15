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

  test('marketplace portal keeps mobile metadata and sends renter device id', () => {
    const marketplacePath = path.join(__dirname, '../../public/portal/marketplace.html');
    const html = fs.readFileSync(marketplacePath, 'utf8');

    expect(html).toMatch(/<meta\s+name=["']viewport["']\s+content=["']width=device-width,\s*initial-scale=1\.0["']>/);
    expect(html).not.toContain("window.location.replace('community.html#rental')");
    expect(html).toContain('/api/rental/marketplace?');
    expect(html).toContain('/api/rental/contract');
    expect(html).toContain('renterDeviceId');
  });

  test('visible portal controls expose accessible names', () => {
    const communityPath = path.join(__dirname, '../../public/portal/community.html');
    const community = fs.readFileSync(communityPath, 'utf8');
    expect(community).toContain('id="sortSelect" onchange="handleSort()" data-i18n-aria-label="a11y_community_sort_bots" aria-label="Sort bots"');
    expect(community).toContain('id="rateMin" min="1" max="50" value="1" step="1" oninput="onRateSliderChange()" data-i18n-aria-label="a11y_community_rate_min" aria-label="Minimum rate"');
    expect(community).toContain('id="rateMax" min="1" max="50" value="50" step="1" oninput="onRateSliderChange()" data-i18n-aria-label="a11y_community_rate_max" aria-label="Maximum rate"');
    expect(community).toContain('id="searchClear" onclick="clearSearch()" data-i18n-aria-label="a11y_community_clear_search" aria-label="Clear search"');

    const kanbanPath = path.join(__dirname, '../../public/portal/kanban.html');
    const kanban = fs.readFileSync(kanbanPath, 'utf8');
    expect(kanban).toContain('class="kb-sort-select" onchange="sortCards(this.value)" data-i18n-aria-label="a11y_kanban_sort_cards" aria-label="Sort kanban cards"');

    const screenControlPath = path.join(__dirname, '../../public/portal/screen-control.html');
    const screenControl = fs.readFileSync(screenControlPath, 'utf8');
    expect(screenControl).toContain('<label for="commandType" data-i18n="screen_ctrl_label_command">Command</label>');
    expect(screenControl).toContain('<label for="paramNodeId" data-i18n="screen_ctrl_label_node_id">');
    expect(screenControl).toContain('<label for="paramText" data-i18n="screen_ctrl_label_text">');
    expect(screenControl).toContain('<label for="paramScrollDir" data-i18n="screen_ctrl_label_scroll_dir">');

    const settingsPath = path.join(__dirname, '../../public/portal/settings.html');
    const settings = fs.readFileSync(settingsPath, 'utf8');
    expect(settings.match(/class="roster-action" aria-label="\$\{rosterT\('settings_roster_col_action','Action'\)\}"/g)).toHaveLength(2);
  });

  test('publisher secret visibility toggles expose accessible names and tooltips', () => {
    const publisherPath = path.join(__dirname, '../../public/portal/publisher.html');
    const publisher = fs.readFileSync(publisherPath, 'utf8');
    expect(publisher).toContain('data-visibility-label="publisher API key"');
    expect(publisher).toContain('aria-label="Show publisher API key"');
    expect(publisher).toContain('title="Show publisher API key"');
    expect(publisher).toContain("btn.setAttribute('aria-label', label)");
    expect(publisher).toContain("btn.setAttribute('title', label)");

    const setupPath = path.join(__dirname, '../../public/portal/publisher-setup.html');
    const setup = fs.readFileSync(setupPath, 'utf8');
    [
      'consumer key',
      'consumer secret',
      'access token',
      'access token secret',
    ].forEach((label) => {
      expect(setup).toContain(`data-visibility-label="${label}"`);
      expect(setup).toContain(`aria-label="Show ${label}"`);
      expect(setup).toContain(`title="Show ${label}"`);
    });
    expect(setup).toContain("btn.setAttribute('aria-label', label)");
    expect(setup).toContain("btn.setAttribute('title', label)");
  });

});
