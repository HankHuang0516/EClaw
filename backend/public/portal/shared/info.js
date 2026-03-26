// info.js — Info page logic (extracted from info.html)

let currentUser = null;

window.addEventListener('DOMContentLoaded', async () => {
    // Soft auth check: show authenticated nav if logged in, public nav otherwise
    try {
        const data = await apiCall('GET', '/api/auth/me');
        currentUser = data.user;
        window.currentUser = currentUser;
        renderNav('info');
        if (window._addAdminLink) window._addAdminLink();
        const emailEl = document.getElementById('navEmail');
        if (emailEl) emailEl.textContent = currentUser.email;
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
    const guideSidebarBtns = document.querySelectorAll('#guideSidebarQS .guide-sidebar-btn, #guideSidebarUG .guide-sidebar-btn, #guideSidebarAdv .guide-sidebar-btn');
    const guideSubBtns = document.querySelectorAll('.guide-sub-btn');
    const guidePanels = document.querySelectorAll('.guide-panel');
    const missionToggle = document.getElementById('missionToggle');
    const missionSubNav = document.getElementById('missionSubNav');
    const usecaseToggle = document.getElementById('usecaseToggle');
    const usecaseSubNav = document.getElementById('usecaseSubNav');

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
        if (panel) panel.classList.add('active');
        history.replaceState(null, '', '#guide/' + tabId);
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

function switchInfoTab(target) {
    const infoTabs = document.querySelectorAll('.info-tab');
    const infoPanels = document.querySelectorAll('.info-panel');
    infoTabs.forEach(t => t.classList.remove('active'));
    infoPanels.forEach(p => p.classList.remove('active'));
    const tab = document.querySelector(`.info-tab[data-info-tab="${target}"]`);
    const panel = document.getElementById('panel-' + target);
    if (tab) tab.classList.add('active');
    if (panel) panel.classList.add('active');
    history.replaceState(null, '', '#' + target);
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
        const tab = document.querySelector('.info-tab[data-info-tab="quickstart"]');
        const panel = document.getElementById('panel-guide');
        if (tab) tab.classList.add('active');
        if (panel) panel.classList.add('active');
        if (window._navigateToGuide) window._navigateToGuide(guideId);
        return;
    }
    const validTabs = ['guide', 'faq', 'release-notes', 'compare'];
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
        const data = await apiCall('GET', '/api/auth/me');
        if (data?.user?.deviceId) deviceId = data.user.deviceId;
        if (data?.user?.deviceSecret) deviceSecret = data.user.deviceSecret;
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
                return '<li><span class="rn-tag ' + tagClass + '">' + tag + '</span> ' + scope + escHtml(ch.description) + '</li>';
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
