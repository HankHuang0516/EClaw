// E-Claw Portal - Navigation Bar

function renderNav(activePage) {
    const pages = [
        { id: 'dashboard', i18nKey: 'nav_dashboard', label: 'Dashboard', href: 'dashboard.html', icon: '📊' },
        { id: 'chat', i18nKey: 'nav_chat', label: 'Chat', href: 'chat.html', icon: '💬' },
        { id: 'files', i18nKey: 'nav_files', label: 'Files', href: 'files.html', icon: '📁' },
        { id: 'mission', i18nKey: 'nav_mission', label: 'Mission', href: 'mission.html', icon: '🚀' },
        { id: 'settings', i18nKey: 'nav_settings', label: 'Settings', href: 'settings.html', icon: '⚙️' },
        { id: 'info', i18nKey: 'nav_info', label: 'Info', href: 'info.html', icon: '📖' }
    ];

    // Deferred: add admin link after auth check completes
    setTimeout(() => {
        if (typeof currentUser !== 'undefined' && currentUser && currentUser.isAdmin) {
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
    }, 600);

    const t = (key, fallback) => typeof i18n !== 'undefined' ? i18n.t(key) : fallback;

    const nav = document.createElement('nav');
    nav.className = 'nav';
    nav.innerHTML = `
        <a href="dashboard.html" class="nav-brand">
            <span class="nav-logo">🦞</span>
            <span class="nav-logo-text">E-Claw</span>
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
            <div class="notif-bell" id="notifBell" onclick="toggleNotifDropdown(event)" title="${t('notif_title', 'Notifications')}">
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
