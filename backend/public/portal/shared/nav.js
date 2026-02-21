// E-Claw Portal - Navigation Bar

function renderNav(activePage) {
    const pages = [
        { id: 'dashboard', i18nKey: 'nav_dashboard', label: 'Dashboard', href: 'dashboard.html', icon: '📊' },
        { id: 'chat', i18nKey: 'nav_chat', label: 'Chat', href: 'chat.html', icon: '💬' },
        { id: 'files', i18nKey: 'nav_files', label: 'Files', href: 'files.html', icon: '📁' },
        { id: 'mission', i18nKey: 'nav_mission', label: 'Mission', href: 'mission.html', icon: '🚀' },
        { id: 'settings', i18nKey: 'nav_settings', label: 'Settings', href: 'settings.html', icon: '⚙️' }
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
    window.location.href = 'index.html';
}

// Alias for pages that call doLogout()
function doLogout() { logout(); }
