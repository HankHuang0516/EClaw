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

  test('settings has a single invite entry that routes to the invite page', () => {
    const settingsPath = path.join(__dirname, '../../public/portal/settings.html');
    const html = fs.readFileSync(settingsPath, 'utf8');

    expect(html).not.toContain('id="inviteCard"');
    expect(html).not.toContain('id="inviteCode"');
    expect(html).not.toContain('function loadInviteStats');
    expect(html).not.toContain('function redeemInviteCode');
    expect(html.match(/window\.location\.href='invite\.html'/g)).toHaveLength(1);
    expect(html).toContain('data-i18n="nav_invite"');
    expect(html).toContain('data-i18n="settings_invite_desc"');
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

  test('authenticated QA/UIUX sweep regressions stay fixed', () => {
    const dashboard = fs.readFileSync(path.join(__dirname, '../../public/portal/dashboard.html'), 'utf8');
    const settings = fs.readFileSync(path.join(__dirname, '../../public/portal/settings.html'), 'utf8');
    const sharedStyle = fs.readFileSync(path.join(__dirname, '../../public/portal/shared/style.css'), 'utf8');
    const infoStyle = fs.readFileSync(path.join(__dirname, '../../public/portal/shared/info.css'), 'utf8');
    const refsStyle = fs.readFileSync(path.join(__dirname, '../../public/shared/refs-popover.css'), 'utf8');
    const kanban = fs.readFileSync(path.join(__dirname, '../../public/portal/kanban.html'), 'utf8');
    const community = fs.readFileSync(path.join(__dirname, '../../public/portal/community.html'), 'utf8');
    const envVars = fs.readFileSync(path.join(__dirname, '../../public/portal/env-vars.html'), 'utf8');
    const chat = fs.readFileSync(path.join(__dirname, '../../public/portal/chat.html'), 'utf8');
    const mission = fs.readFileSync(path.join(__dirname, '../../public/portal/mission.html'), 'utf8');
    const petdxBrowser = fs.readFileSync(path.join(__dirname, '../../public/portal/petdx-browser.html'), 'utf8');
    const telemetry = fs.readFileSync(path.join(__dirname, '../../public/portal/telemetry.html'), 'utf8');
    // The k-Value Tracker widget originally lived on dashboard.html but moved
    // to invite.html (card_8ff516c15600aa1b55c7cabe) — it is invite-funnel
    // analytics, not an entity-binding metric. Lock the deviceSecret auth
    // shape on its new home.
    const invite = fs.readFileSync(path.join(__dirname, '../../public/portal/invite.html'), 'utf8');

    expect(invite).toContain("deviceSecret: user.deviceSecret");
    expect(invite).not.toContain("botSecret: user.deviceSecret");
    expect(dashboard).not.toContain("botSecret: user.deviceSecret");

    expect(settings).toContain("const qs = new URLSearchParams({");
    expect(settings).toContain("deviceSecret: user.deviceSecret");
    expect(settings).toContain("'/api/usage/snapshot?' + qs.toString()");

    expect(sharedStyle).toMatch(/\.ecoin-badge\s*\{[\s\S]*min-height:\s*28px/);
    expect(sharedStyle).toMatch(/\.btn-sm\s*\{[^}]*min-height:\s*28px/);
    expect(sharedStyle).toMatch(/\.chip\s*\{[\s\S]*min-height:\s*28px/);
    expect(sharedStyle).toMatch(/\.footer-link\s*\{[\s\S]*min-width:\s*28px;[\s\S]*min-height:\s*28px/);
    expect(sharedStyle).toMatch(/\.help-icon\s*\{[\s\S]*width:\s*28px;[\s\S]*height:\s*28px/);
    expect(infoStyle).toMatch(/\.qs-promo-link\s*\{[\s\S]*min-height:\s*28px/);
    expect(infoStyle).toMatch(/\.ped-agent-action\s*\{[\s\S]*min-width:\s*28px;[\s\S]*min-height:\s*28px/);
    expect(refsStyle).toMatch(/\.eclaw-refs-icon\s*\{[\s\S]*width:\s*28px;[\s\S]*height:\s*28px/);
    expect(kanban).toMatch(/\.kb-chip\s*\{[^}]*min-height:28px/);
    expect(chat).toMatch(/\.density-switcher button\s*\{[\s\S]*min-width:\s*28px;[\s\S]*min-height:\s*28px/);
    expect(chat).toMatch(/\.btn-add-contact\s*\{[\s\S]*min-height:\s*28px/);
    expect(community).toMatch(/\.invite-cta-copy-btn\s*\{[\s\S]*min-width:\s*28px;[\s\S]*min-height:\s*28px/);
    expect(community).toMatch(/\.plaza-view-btn\s*\{[\s\S]*min-width:\s*28px;[\s\S]*min-height:\s*28px/);
    expect(community).toMatch(/\.cap-filter-chip\s*\{[\s\S]*min-height:\s*28px/);
    expect(mission).toMatch(/\.add-cat-btn\s*\{[\s\S]*min-height:\s*28px/);
    expect(envVars).toMatch(/id="btnRevealCurlId"[\s\S]*min-width:28px;min-height:28px/);
    expect(envVars).toMatch(/\.lock-btn\s*\{[\s\S]*min-height:\s*28px/);
    expect(settings).toMatch(/\.feedback-history-link\s*\{[\s\S]*min-height:\s*28px/);
    expect(settings).toMatch(/\.btn-ask-ai\s*\{[\s\S]*min-height:\s*28px/);
    expect(petdxBrowser).toMatch(/\.login-warn a\s*\{[\s\S]*min-height:\s*28px/);
    expect(telemetry).toMatch(/\.tel-btn\s*\{[\s\S]*min-height:\s*28px/);
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

  test('community plaza wires the AvatarPetdx companion system (card_3144142e)', () => {
    // Locks the integration shipped with the card_3144142e fix so the Bot
    // Plaza can never silently regress back to "miss AvatarPetdx" again.
    // Mirrors the chat / dashboard / marketplace / mission / files /
    // card-holder pages that all wire the shared companion system.
    const communityPath = path.join(__dirname, '../../public/portal/community.html');
    const community = fs.readFileSync(communityPath, 'utf8');

    // 1. The shared AvatarPetdx renderer is loaded on the page.
    expect(community).toContain('<script src="../shared/avatar-petdx.js"></script>');

    // 2. Plaza no longer ships its private isPetdxSprite/petdxFrame0Html
    //    fork — those duplicated the shared renderAvatarHtml() sprite branch
    //    in entity-utils.js. The shared path is the only sprite-crop today.
    expect(community).not.toMatch(/function\s+isPetdxSprite\s*\(/);
    expect(community).not.toMatch(/function\s+petdxFrame0Html\s*\(/);

    // 3. botAvatarHtml threads entityId into the shared renderAvatarHtml so
    //    own-device rows can hit the AvatarPetdx canvas branch instead of
    //    the static <img>.
    expect(community).toMatch(
      /function\s+botAvatarHtml\s*\(\s*avatar\s*,\s*size\s*,\s*entityId\s*\)/
    );
    expect(community).toContain('renderAvatarHtml(avatar, size || 48, entityId)');

    // 4. The viewer's bound entities are preloaded so descriptor lookups
    //    succeed before the cards render. The publicCode → entityId map
    //    feeds the call sites.
    expect(community).toContain('async function preloadOwnEntityAvatars()');
    expect(community).toContain('window.AvatarPetdx.preload({');
    expect(community).toContain('window.AvatarPetdx.autoMount();');
    expect(community).toContain('_ownPublicCodeToEntityId');
    expect(community).toContain('function entityIdForPublicCode(publicCode)');

    // 5. renderGrid mounts any AvatarPetdx canvas placeholders just emitted
    //    so the companion animates.
    expect(community).toMatch(/window\.AvatarPetdx\.mount\s*\(\s*grid\s*\)/);

    // 6. Card render call sites pass entityId so own-device rows can win
    //    the canvas branch in shared renderAvatarHtml. Each list of three
    //    locks the community card, rental card, community detail modal,
    //    and rental detail modal.
    expect(community).toContain('botAvatarHtml(bot.avatar, 56, eid)');
    expect(community).toContain(
      'botAvatarHtml(bot.avatar, 40, entityIdForPublicCode(bot.publicCode))'
    );
    expect(community).toContain(
      'botAvatarHtml(resolveBotAvatar(bot), 72, entityIdForPublicCode(bot.publicCode))'
    );
    expect(community).toContain(
      "botAvatarHtml(resolveBotAvatar({ petdxAvatarUrl: l.petdx_avatar_url, avatar: l.avatar_url }), 72, l.owner_entity_id)"
    );

    // 7. preloadOwnEntityAvatars is actually invoked on page init.
    expect(community).toMatch(/^\s*preloadOwnEntityAvatars\(\);\s*$/m);
  });

  test('about founder page keeps public nav, product visual, and share status shell', () => {
    const aboutFounderPath = path.join(__dirname, '../../public/portal/about-founder.html');
    const aboutFounder = fs.readFileSync(aboutFounderPath, 'utf8');

    expect(aboutFounder).toContain('<script src="shared/public-nav.js"></script>');
    expect(aboutFounder).toContain('<script src="shared/footer.js"></script>');
    expect(aboutFounder).toContain("renderPublicNav('info')");
    expect(aboutFounder).toContain("if (typeof renderFooter === 'function') renderFooter();");
    expect(aboutFounder).toContain('src="/assets/eclaw-kanban-demo.png"');
    expect(aboutFounder).toContain('class="af-content"');
    expect(aboutFounder).toMatch(/\.af-content\s*\{[\s\S]*grid-template-columns:\s*220px minmax\(0,\s*760px\)/);
    expect(aboutFounder).toMatch(/@media \(max-width:\s*920px\)[\s\S]*\.af-content\s*\{[\s\S]*grid-template-columns:\s*1fr/);
    expect(aboutFounder).toContain('id="afCopyLink" aria-describedby="afShareStatus"');
    expect(aboutFounder).toContain('id="afShareStatus" data-state="idle" role="status" aria-live="polite"');
    expect(aboutFounder).toContain("status.dataset.state = state || 'idle'");
  });

});
