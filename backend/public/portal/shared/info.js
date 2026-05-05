// info.js — Info page logic (extracted from info.html)

let currentUser = null;

window.addEventListener('DOMContentLoaded', async () => {
    // Soft auth check: show authenticated nav if logged in, public nav otherwise
    try {
        const data = await apiCall('GET', '/api/auth/session', null, { skip401Redirect: true });
        if (data?.authenticated && data.user) {
            currentUser = data.user;
            window.currentUser = currentUser;
            renderNav('info');
            if (window._addAdminLink) window._addAdminLink();
            const emailEl = document.getElementById('navEmail');
            if (emailEl) emailEl.textContent = currentUser.email;
        } else {
            renderPublicNav('info');
        }
    } catch (e) {
        renderPublicNav('info');
    }
    if (typeof renderFooter === 'function') renderFooter();
    if (typeof i18n !== 'undefined') i18n.apply();

    // ── Info tab switching ──
    const infoTabs = document.querySelectorAll('.info-tab');
    const infoPanels = document.querySelectorAll('.info-panel');

    infoTabs.forEach(tab => {
        tab.addEventListener('click', () => {
            const target = tab.getAttribute('data-info-tab');
            switchInfoTab(target);
        });
    });

    // ── Guide sidebar ──
    const guideSidebarBtns = document.querySelectorAll('#guideSidebarQS .guide-sidebar-btn, #guideSidebarUG .guide-sidebar-btn, #guideSidebarAdv .guide-sidebar-btn, #guideSidebarChannelPlugins .guide-sidebar-btn');
    const guideSubBtns = document.querySelectorAll('.guide-sub-btn');
    const guidePanels = document.querySelectorAll('.guide-panel');
    const missionToggle = document.getElementById('missionToggle');
    const missionSubNav = document.getElementById('missionSubNav');
    const usecaseToggle = document.getElementById('usecaseToggle');
    const usecaseSubNav = document.getElementById('usecaseSubNav');
    const guideMobilePicker = buildGuideMobilePicker();

    // Expandable toggle groups: [toggle btn, sub nav, first sub item data-guide]
    const toggleGroups = [
        { toggle: missionToggle, subNav: missionSubNav, defaultGuide: 'mission-overview' },
        { toggle: usecaseToggle, subNav: usecaseSubNav, defaultGuide: 'usecase-claude-openclaw' }
    ];

    function clearGuideActive() {
        guideSidebarBtns.forEach(b => b.classList.remove('active'));
        guideSubBtns.forEach(b => b.classList.remove('active'));
        guidePanels.forEach(p => p.classList.remove('active'));
    }

    function activateGuide(tabId, btn) {
        clearGuideActive();
        btn.classList.add('active');
        const panel = document.getElementById('guide-' + tabId);
        if (panel) {
            panel.classList.add('active');
            renderMermaidIn(panel);
        }
        if (guideMobilePicker && btn.closest('#panel-guide')) {
            guideMobilePicker.value = tabId;
        }
        const section = btn.closest('#panel-channel-plugins') ? 'channel-plugins' : 'guide';
        history.replaceState(null, '', '#' + section + '/' + tabId);
        updateSeoMeta(tabId);
    }

    function buildGuideMobilePicker() {
        const sidebar = document.getElementById('guideSidebarUG');
        const layout = sidebar?.closest('.guide-layout');
        if (!sidebar || !layout || layout.querySelector('.guide-mobile-picker')) return null;

        const wrapper = document.createElement('label');
        wrapper.className = 'guide-mobile-picker';
        wrapper.setAttribute('aria-label', 'Guide section picker');

        const label = document.createElement('span');
        label.className = 'guide-mobile-picker-label';
        label.textContent = 'Guide section';

        const select = document.createElement('select');
        select.className = 'guide-mobile-select';
        const buttons = [...sidebar.querySelectorAll('[data-guide]')];
        buttons.forEach(btn => {
            const option = document.createElement('option');
            option.value = btn.getAttribute('data-guide');
            option.textContent = btn.textContent.replace('▶', '').trim();
            select.appendChild(option);
        });

        select.addEventListener('change', () => {
            const target = buttons.find(btn => btn.getAttribute('data-guide') === select.value);
            if (target) target.click();
        });

        wrapper.append(label, select);
        layout.insertBefore(wrapper, sidebar.nextSibling);
        return select;
    }

    // Expose guide navigation for deep link handling (used by global handleHash)
    window._navigateToGuide = function(guideId) {
        const allGuideBtns = document.querySelectorAll('[data-guide]');
        const btn = [...allGuideBtns].find(b => b.getAttribute('data-guide') === guideId);
        if (!btn) return;
        toggleGroups.forEach(g => {
            if (g.subNav.contains(btn)) {
                collapseAllToggles(g.toggle);
                g.subNav.classList.add('open');
                g.toggle.classList.add('expanded');
                g.toggle.classList.add('active');
            }
        });
        activateGuide(guideId, btn);
    };

    function collapseAllToggles(exceptToggle) {
        toggleGroups.forEach(g => {
            if (g.toggle !== exceptToggle) {
                g.subNav.classList.remove('open');
                g.toggle.classList.remove('expanded');
                g.toggle.classList.remove('active');
            }
        });
    }

    toggleGroups.forEach(g => {
        g.toggle.addEventListener('click', () => {
            const isOpen = g.subNav.classList.contains('open');
            collapseAllToggles(g.toggle);
            if (isOpen) {
                g.subNav.classList.remove('open');
                g.toggle.classList.remove('expanded');
            } else {
                g.subNav.classList.add('open');
                g.toggle.classList.add('expanded');
                const firstBtn = g.subNav.querySelector('[data-guide="' + g.defaultGuide + '"]');
                if (firstBtn) activateGuide(g.defaultGuide, firstBtn);
                g.toggle.classList.add('active');
            }
        });
    });

    guideSidebarBtns.forEach(btn => {
        if (toggleGroups.some(g => g.toggle === btn)) return;
        btn.addEventListener('click', () => {
            collapseAllToggles(null);
            activateGuide(btn.getAttribute('data-guide'), btn);
        });
    });

    guideSubBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const guideId = btn.getAttribute('data-guide');
            activateGuide(guideId, btn);
            // Mark parent toggle as active
            toggleGroups.forEach(g => {
                if (g.subNav.contains(btn)) g.toggle.classList.add('active');
            });
        });
    });

    // ── URL hash navigation ──
    handleHash();
    window.addEventListener('hashchange', handleHash);
});

function renderMermaidIn(root) {
    if (!root || typeof mermaid === 'undefined') return;
    const nodes = [...root.querySelectorAll('pre.mermaid:not([data-processed])')]
        .filter(n => n.offsetParent !== null && n.getBoundingClientRect().width > 0);
    if (nodes.length) mermaid.run({ nodes });
}

// Per-panel SEO metadata. Used by updateSeoMeta() to swap document.title +
// og:* / twitter:* tags when the user navigates to a panel or guide sub-page,
// so a copy-pasted URL with a hash deep-link previews the right card on
// social platforms.
const SEO_META = {
    'quickstart':       { title: 'Quick Start',       desc: 'Get started with EClawbot — create a device, bind a channel, rent or host AI agents.' },
    'guide':            { title: 'User Guide',        desc: 'EClawbot user guide: features, use cases, mission center, kanban, mind-map, vector search.' },
    'advanced':         { title: 'Advanced',          desc: 'Advanced EClawbot topics: mission center internals, broadcast, vault, debugging.' },
    'channel-plugins':  { title: 'Channel Plugins',   desc: 'EClawbot channel plugins: OpenClaw, Claude Code, Codex, Telegram, Discord, web chat bridges.' },
    'faq':              { title: 'FAQ',               desc: 'Frequently asked questions about EClawbot — billing, devices, rentals, plugins.' },
    'release-notes':    { title: 'Release Notes',     desc: 'EClawbot release notes and changelog.' },
    // Guide sub-pages (#guide/<id>)
    'usecase-ecommerce':           { title: 'E-commerce Bot',          desc: 'Use EClawbot to run an AI-powered storefront and customer-service agent.' },
    'usecase-kanban':              { title: 'Mission Center / Kanban', desc: 'Run AI agents against a shared kanban board with auto-cron tasks.' },
    'usecase-gps':                 { title: 'GPS / Location Bot',      desc: 'Build location-aware agents on EClawbot.' },
    'usecase-bot-plaza':           { title: 'Bot Plaza',               desc: 'Browse and rent community AI agents on the Bot Plaza.' },
    'usecase-live-wallpaper':      { title: 'Live Wallpaper',          desc: 'Turn your AI agent into an animated wallpaper companion.' },
    'usecase-gatekeeper':          { title: 'Gatekeeper Bot',          desc: 'Group access control and moderation via EClawbot agents.' },
    'usecase-multiplatform':       { title: 'Multi-platform Bridge',   desc: 'One agent, many channels — Telegram, Discord, web, native app.' },
    'usecase-minigame':            { title: 'Mini-game Bot',           desc: 'Build interactive mini-games served by EClawbot.' },
    'usecase-bridge':              { title: 'Channel Bridge',          desc: 'Connect EClawbot to an external chat platform.' },
    'usecase-proxy-window':        { title: 'Proxy Window',            desc: 'Embed an EClawbot agent into any web page via the proxy window.' },
    'usecase-claude-openclaw':     { title: 'Claude / OpenClaw Bot',   desc: 'Run Claude or OpenClaw-engine bots on EClawbot.' },
    'codex-channel':               { title: 'Codex Channel',           desc: 'Connect EClawbot to OpenAI Codex CLI through a persistent codex app-server bridge.' },
    'usecase-messaging-friends':   { title: 'Messaging Friends',       desc: 'Chat with other EClawbot users and their bots.' },
    'usecase-voice-tts':           { title: 'Voice / TTS',             desc: 'Voice and text-to-speech features for EClawbot agents.' },
    // Marketing hooks
    'vector-memory':               { title: 'Vector Memory',           desc: 'Semantic memory that breaks the context window, shares knowledge across bots, and cites its sources.' },
    'passive-income':              { title: 'Idle Bot, Earn e-Coin',   desc: 'Rent out your idle EClawbot agents and earn e-coins while you sleep.' },
    'rent-to-use':                 { title: 'Rent Big-Model Power',    desc: 'Rent powerful AI agents on EClawbot — no key, no setup, pay only for what you use.' },
    'credit-swap':                 { title: 'Time Bank',               desc: 'Trade idle bot time for active bot time — the EClawbot time-banking system.' },
    'arena-intro':                 { title: 'Interview Arena',         desc: 'Standardized 12-test, 147-point benchmark for AI agent capabilities — perception, interaction, reasoning, safety, memory, speed.' },
    // Mission sub-pages
    'mission-overview':            { title: 'Mission Overview',        desc: 'How EClawbot mission cards, kanban, and auto-crons fit together.' },
};

function updateSeoMeta(key) {
    const meta = SEO_META[key];
    if (!meta) return;
    const fullTitle = `${meta.title} · EClawbot`;
    document.title = fullTitle;
    const setMeta = (selector, value) => {
        const el = document.querySelector(selector);
        if (el) el.setAttribute('content', value);
    };
    setMeta('meta[name="description"]', meta.desc);
    setMeta('meta[property="og:title"]', fullTitle);
    setMeta('meta[property="og:description"]', meta.desc);
    setMeta('meta[name="twitter:title"]', fullTitle);
    setMeta('meta[name="twitter:description"]', meta.desc);
}

function switchInfoTab(target) {
    const infoTabs = document.querySelectorAll('.info-tab');
    const infoPanels = document.querySelectorAll('.info-panel');
    infoTabs.forEach(t => t.classList.remove('active'));
    infoPanels.forEach(p => p.classList.remove('active'));
    const tab = document.querySelector(`.info-tab[data-info-tab="${target}"]`);
    const panel = document.getElementById('panel-' + target);
    if (tab) tab.classList.add('active');
    if (panel) {
        panel.classList.add('active');
        renderMermaidIn(panel);
    }
    if (target === 'channel-plugins' && window._navigateToGuide) {
        window._navigateToGuide('codex-channel');
        return;
    }
    history.replaceState(null, '', '#' + target);
    updateSeoMeta(target);
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

function handleHash() {
    const hash = location.hash.replace('#', '');
    if (!hash) return;
    // Deep link: #guide/sub-item (e.g. #guide/usecase-claude-openclaw)
    if (hash.startsWith('guide/')) {
        const guideId = hash.slice('guide/'.length);
        const infoTabs = document.querySelectorAll('.info-tab');
        const infoPanels = document.querySelectorAll('.info-panel');
        infoTabs.forEach(t => t.classList.remove('active'));
        infoPanels.forEach(p => p.classList.remove('active'));
        const guideBtn = [...document.querySelectorAll('[data-guide]')].find(b => b.getAttribute('data-guide') === guideId);
        const isChannelPlugin = guideBtn && guideBtn.closest('#panel-channel-plugins');
        const tabName = isChannelPlugin ? 'channel-plugins' : 'quickstart';
        const panelId = isChannelPlugin ? 'panel-channel-plugins' : 'panel-guide';
        const tab = document.querySelector(`.info-tab[data-info-tab="${tabName}"]`);
        const panel = document.getElementById(panelId);
        if (tab) tab.classList.add('active');
        if (panel) panel.classList.add('active');
        if (window._navigateToGuide) window._navigateToGuide(guideId);
        return;
    }
    // Deep link: #channel-plugins/sub-item (e.g. #channel-plugins/claude-code-channel)
    if (hash.startsWith('channel-plugins/')) {
        const guideId = hash.slice('channel-plugins/'.length);
        const infoTabs = document.querySelectorAll('.info-tab');
        const infoPanels = document.querySelectorAll('.info-panel');
        infoTabs.forEach(t => t.classList.remove('active'));
        infoPanels.forEach(p => p.classList.remove('active'));
        const tab = document.querySelector('.info-tab[data-info-tab="channel-plugins"]');
        const panel = document.getElementById('panel-channel-plugins');
        if (tab) tab.classList.add('active');
        if (panel) panel.classList.add('active');
        if (window._navigateToGuide) window._navigateToGuide(guideId);
        return;
    }
    const validTabs = ['guide', 'faq', 'release-notes', 'compare', 'advanced', 'channel-plugins'];
    if (validTabs.includes(hash)) {
        switchInfoTab(hash);
    }
}

function toggleFaq(el) {
    el.parentElement.classList.toggle('open');
}

// FAQ search + filter
let _faqCat = 'all';
function setFaqCat(cat, el) {
    _faqCat = cat;
    document.querySelectorAll('.faq-chip').forEach(c => c.classList.remove('active'));
    el.classList.add('active');
    filterFaq();
}
function filterFaq() {
    const q = (document.getElementById('faqSearchInput').value || '').toLowerCase();
    const items = document.querySelectorAll('#panel-faq .faq-item');
    const sections = document.querySelectorAll('#panel-faq .faq-section-title');
    let visible = 0;
    const sectionVisible = {};

    items.forEach(item => {
        const cat = item.getAttribute('data-category') || '';
        const text = (item.textContent || '').toLowerCase();
        const catMatch = _faqCat === 'all' || cat === _faqCat;
        const searchMatch = !q || text.includes(q);
        const show = catMatch && searchMatch;
        item.classList.toggle('hidden', !show);
        if (show) { visible++; sectionVisible[cat] = true; }
    });

    sections.forEach(sec => {
        const cat = sec.getAttribute('data-faq-section') || '';
        const show = _faqCat === 'all' ? !!sectionVisible[cat] : cat === _faqCat && !!sectionVisible[cat];
        sec.classList.toggle('hidden', !show);
    });

    document.getElementById('faqNoResults').style.display = visible === 0 ? 'block' : 'none';
}

async function copyClaudeOpenclawExample() {
    const TEMPLATE = i18n.t('guide_usecase_copy_template');

    let deviceId = i18n.t('guide_usecase_copy_device_id_placeholder');
    let deviceSecret = i18n.t('guide_usecase_copy_device_secret_placeholder');

    try {
        const data = await apiCall('GET', '/api/auth/session', null, { skip401Redirect: true });
        if (data?.authenticated && data?.user?.deviceId) deviceId = data.user.deviceId;
        if (data?.authenticated && data?.user?.deviceSecret) deviceSecret = data.user.deviceSecret;
    } catch (e) {
        // Not logged in, use placeholder
    }

    const text = TEMPLATE
        .replace('{{DEVICE_ID}}', deviceId)
        .replace('{{DEVICE_SECRET}}', deviceSecret);

    try {
        await navigator.clipboard.writeText(text);
    } catch (e) {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
    }

    const feedback = document.getElementById('copyClaudeExampleFeedback');
    if (feedback) {
        feedback.style.display = 'inline';
        setTimeout(() => { feedback.style.display = 'none'; }, 3000);
    }
}

// ── Release Notes dynamic rendering ──
// ── Release Notes dynamic rendering ──
(function() {
    let rnData = [];
    const API = window.location.origin;

    async function loadReleaseNotes() {
        try {
            const res = await fetch(API + '/api/release-notes?limit=50');
            const data = await res.json();
            if (data.success) {
                rnData = data.releases;
                document.getElementById('rnCount').textContent = data.total + ' releases total';
                renderRN(rnData);
            }
        } catch(e) {
            document.getElementById('rnContainer').innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-secondary);">Failed to load release notes.</div>';
        }
    }

    function renderRN(releases) {
        const c = document.getElementById('rnContainer');
        if (!releases.length) { c.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-secondary);">No releases found.</div>'; return; }
        c.innerHTML = releases.map((r, i) => {
            const isLatest = i === 0;
            const badge = isLatest ? '<span class="rn-badge rn-badge-latest">Latest</span>' : '';
            const changesHtml = r.changes.map(ch => {
                const tag = ch.type === 'Features' ? 'feat' : ch.type === 'Bug Fixes' ? 'fix' : 'chore';
                const tagClass = tag === 'feat' ? 'rn-tag-feat' : tag === 'fix' ? 'rn-tag-fix' : 'rn-tag-chore';
                const scope = ch.scope ? '<strong>' + ch.scope + ':</strong> ' : '';
                const descriptionHtml = typeof window.renderSafeMarkdownInline === 'function'
                    ? window.renderSafeMarkdownInline(ch.description)
                    : escHtml(ch.description);
                return '<li><span class="rn-tag ' + tagClass + '">' + tag + '</span> ' + scope + descriptionHtml + '</li>';
            }).join('');
            const openAttr = isLatest ? 'open' : '';
            return '<details class="rn-entry' + (isLatest ? ' latest' : '') + '" ' + openAttr + '>' +
                '<summary class="rn-header"><span class="rn-version">v' + r.version + '</span>' + badge + '<span class="rn-date">' + r.date + '</span><span class="rn-change-count">' + r.changes.length + ' changes</span></summary>' +
                '<ul class="rn-changes">' + changesHtml + '</ul></details>';
        }).join('');
    }

    function escHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

    // Search + filter
    document.getElementById('rnSearch')?.addEventListener('input', applyFilters);
    document.getElementById('rnFilter')?.addEventListener('change', applyFilters);

    function applyFilters() {
        const q = (document.getElementById('rnSearch')?.value || '').toLowerCase();
        const f = document.getElementById('rnFilter')?.value || 'all';
        let filtered = rnData;
        if (q) filtered = filtered.filter(r => r.version.includes(q) || r.changes.some(c => c.description.toLowerCase().includes(q)));
        if (f !== 'all') filtered = filtered.map(r => ({...r, changes: r.changes.filter(c => c.type === f)})).filter(r => r.changes.length > 0);
        renderRN(filtered);
    }

    // Load when tab is shown
    const observer = new MutationObserver(() => {
        const panel = document.getElementById('panel-release-notes');
        if (panel && panel.classList.contains('active') && !rnData.length) loadReleaseNotes();
    });
    const panel = document.getElementById('panel-release-notes');
    if (panel) observer.observe(panel, { attributes: true, attributeFilter: ['class'] });
    // Also load if already active
    if (panel && panel.classList.contains('active')) loadReleaseNotes();
})();
