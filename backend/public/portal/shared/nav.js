// E-Claw Portal - Navigation Bar

function renderNav(activePage) {
    // Skip nav rendering when embedded in workspace iframe
    if (new URLSearchParams(window.location.search).get('embed') === '1') return;
    // Also skip if inside any iframe (fallback for CDN-cached pages without ?embed=1)
    if (window.self !== window.top) return;

    const pages = [
        { id: 'dashboard', i18nKey: 'nav_dashboard', label: 'Dashboard', href: 'dashboard.html', icon: '📊' },
        { id: 'chat', i18nKey: 'nav_chat', label: 'Chat', href: 'chat.html', icon: '💬' },
        { id: 'mission', i18nKey: 'nav_mission', label: 'Mission', href: 'mission.html', icon: '🚀' },
        { id: 'kanban', i18nKey: 'nav_kanban', label: 'Kanban', href: 'kanban.html', icon: '📋' },
        { id: 'card-holder', i18nKey: 'nav_card_holder', label: 'Cards', href: 'card-holder.html', icon: '🗂️' },
        { id: 'invite', i18nKey: 'nav_invite', label: 'Invite Friends', href: 'invite.html', icon: '🎁' },
        { id: 'community', i18nKey: 'nav_community', label: 'Community', href: 'community.html', icon: '🤝' },
        { id: 'marketplace', i18nKey: 'nav_marketplace', label: 'Marketplace', href: 'marketplace.html', icon: '🏪' },
        { id: 'settings', i18nKey: 'nav_settings', label: 'Settings', href: 'settings.html', icon: '⚙️' },
        { id: 'info', i18nKey: 'nav_info', label: 'Info', href: 'info.html', icon: '📖' }
    ];

    // If split view mode is enabled, show a subtle indicator on nav (no auto-redirect)
    // Users enter workspace via Settings > Display > Split View, which navigates to workspace.html

    // Deferred: add admin link after auth check completes
    // Use window._addAdminLink so pages can also call it directly after auth
    window._addAdminLink = function() {
        const user = window.currentUser || (typeof currentUser !== 'undefined' ? currentUser : null);
        if (user && user.isAdmin) {
            const navLinks = document.getElementById('navLinks');
            if (navLinks && !navLinks.querySelector('[data-admin-link]')) {
                const link = document.createElement('a');
                link.href = 'admin.html';
                link.className = 'nav-link' + (activePage === 'admin' ? ' active' : '');
                link.setAttribute('data-admin-link', '1');
                link.innerHTML = '<span class="nav-link-icon">🔒</span><span class="nav-link-text">' + (typeof i18n !== 'undefined' ? i18n.t('nav_admin') : 'Admin') + '</span>';
                navLinks.appendChild(link);
            }
        }
    };
    // _addAdminLink is called by checkAuth() after user data is available,
    // or manually by pages with custom auth flows (e.g., info.html).

    const t = (key, fallback) => typeof i18n !== 'undefined' ? i18n.t(key) : fallback;

    const nav = document.createElement('nav');
    nav.className = 'nav';
    nav.setAttribute('role', 'navigation');
    nav.setAttribute('aria-label', 'Main navigation');
    nav.innerHTML = `
        <a href="dashboard.html" class="nav-brand">
            <img class="nav-logo" src="assets/ic_launcher.png" alt="EClawbot" style="width:28px;height:28px;border-radius:6px;">
            <span class="nav-logo-text">EClawbot</span>
        </a>
        <button class="nav-hamburger" id="navHamburger" onclick="toggleMobileNav()" aria-label="Menu">
            <span></span><span></span><span></span>
        </button>
        <div class="nav-links" id="navLinks">
            ${pages.map(p => `
                <a href="${p.href}" class="nav-link ${p.id === activePage ? 'active' : ''}"
                   data-i18n="${p.i18nKey}">
                    <span class="nav-link-icon">${p.icon}</span>
                    <span class="nav-link-text">${t(p.i18nKey, p.label)}</span>
                </a>
            `).join('')}
        </div>
        <div class="nav-user" id="navUser">
            <a href="wallet.html" class="ecoin-badge" id="ecoinBadge" title="${t('nav_wallet', 'My Wallet')}" style="display:none;">
                <svg class="ecoin-icon" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <hexagon cx="12" cy="12" r="10"/>
                    <path d="M12 2l10 5.5v11L12 22 2 18.5v-11z"/>
                    <path d="M12 8v8M9 12h6"/>
                </svg>
                <span class="ecoin-amount" id="ecoinAmount">0</span>
            </a>
            <div class="notif-bell" id="notifBell" onclick="toggleNotifDropdown(event)" role="button" tabindex="0" aria-label="${t('notif_title', 'Notifications')}" title="${t('notif_title', 'Notifications')}" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();toggleNotifDropdown(event)}">
                <svg class="bell-icon" xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path>
                    <path d="M13.73 21a2 2 0 0 1-3.46 0"></path>
                </svg>
                <span class="notif-badge" id="notifBadge" style="display:none;">0</span>
            </div>
            <div class="notif-dropdown" id="notifDropdown" style="display:none;">
                <div class="notif-header">
                    <span data-i18n="notif_title">${t('notif_title', 'Notifications')}</span>
                    <button class="notif-mark-all" onclick="markAllNotifsRead()" data-i18n="notif_mark_all">${t('notif_mark_all', 'Mark all read')}</button>
                </div>
                <div class="notif-list" id="notifList">
                    <div class="notif-empty" data-i18n="notif_empty">${t('notif_empty', 'No notifications')}</div>
                </div>
            </div>
            <span class="email" id="navEmail"></span>
            <button class="btn btn-outline btn-sm" onclick="doLogout()" data-i18n="nav_logout">${t('nav_logout', 'Logout')}</button>
        </div>
    `;

    document.body.insertBefore(nav, document.body.firstChild);

    // Close mobile nav when clicking a link
    nav.querySelectorAll('.nav-link').forEach(link => {
        link.addEventListener('click', () => {
            nav.classList.remove('nav-open');
        });
    });

    // Close mobile nav when clicking outside
    document.addEventListener('click', (e) => {
        if (!nav.contains(e.target) && nav.classList.contains('nav-open')) {
            nav.classList.remove('nav-open');
        }
    });
}

function toggleMobileNav() {
    const nav = document.querySelector('.nav');
    nav.classList.toggle('nav-open');
}

async function logout() {
    try {
        await apiCall('POST', '/api/auth/logout');
    } catch (e) { }
    // Disconnect socket before leaving
    if (typeof portalSocket !== 'undefined' && portalSocket) portalSocket.disconnect();
    window.location.href = 'index.html';
}

// Alias for pages that call doLogout()
function doLogout() { logout(); }

// ── e-coin balance loader (for nav badge) ──
// Called after auth check succeeds. Fetches wallet balance and shows
// the ecoin-badge in the nav bar. Silently skips if wallet API fails
// (e.g. user has no wallet yet).
async function _loadNavEcoinBadge() {
    try {
        // Guard: only fetch the wallet balance when there is a real user
        // ACCOUNT. auth.js populates window.currentUser after /me succeeds, but a
        // device-only session (bound device, no email account) still resolves to
        // a truthy currentUser with `id: null`. /api/wallet/balance requires a
        // userId (walletRoute → 401 'unauthenticated' when absent), so gating on
        // currentUser alone still 401s for device-only / globe-user sessions.
        // Require currentUser.id to avoid a 401 console error. See #3513 + card_01417648.
        if (!window.currentUser || !window.currentUser.id) return;
        const badge = document.getElementById('ecoinBadge');
        const amountEl = document.getElementById('ecoinAmount');
        if (!badge || !amountEl) return;
        const data = await apiCall('GET', '/api/wallet/balance', null, { skip401Redirect: true });
        if (!data || !data.success) return;
        amountEl.textContent = (data.wallet.balance_ecoin || 0).toLocaleString();
        badge.style.display = '';
    } catch { /* wallet not available yet — hide badge */ }
}
// Auto-load after a short delay (auth must complete first)
setTimeout(() => _loadNavEcoinBadge(), 1500);
