// E-Claw Portal - Public Navigation Bar (no login required)

function renderPublicNav(activePage) {
    const pages = [
        { id: 'info', i18nKey: 'nav_info', label: 'Info', href: 'info.html' }
    ];

    const t = (key, fallback) => typeof i18n !== 'undefined' ? i18n.t(key) : fallback;

    const nav = document.createElement('nav');
    nav.className = 'nav';
    nav.innerHTML = `
        <a href="index.html" class="nav-brand">
            <span class="nav-logo">🦞</span>
            <span class="nav-logo-text">E-Claw</span>
        </a>
        <button class="nav-hamburger" id="navHamburger" onclick="togglePublicMobileNav()" aria-label="Menu">
            <span></span><span></span><span></span>
        </button>
        <div class="nav-links" id="navLinks">
            ${pages.map(p => `
                <a href="${p.href}" class="nav-link ${p.id === activePage ? 'active' : ''}"
                   ${p.external ? 'target="_blank" rel="noopener"' : ''}
                   data-i18n="${p.i18nKey}">
                    <span class="nav-link-text">${t(p.i18nKey, p.label)}</span>
                </a>
            `).join('')}
        </div>
        <div class="nav-user" id="navUser">
            <a href="index.html" class="btn btn-primary btn-sm" data-i18n="nav_login">${t('nav_login', 'Login')}</a>
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

function togglePublicMobileNav() {
    const nav = document.querySelector('.nav');
    nav.classList.toggle('nav-open');
}
