// E-Claw Portal - Site Footer (public + authenticated)

function renderFooter() {
    const t = (key, fallback) => typeof i18n !== 'undefined' ? i18n.t(key) : fallback;

    const footer = document.createElement('footer');
    footer.className = 'site-footer';
    footer.innerHTML = `
        <div class="footer-inner">
            <div class="footer-grid">
                <div class="footer-col">
                    <div class="footer-brand">
                        <span class="footer-logo">🦞</span>
                        <span class="footer-brand-text">E-Claw</span>
                    </div>
                    <p class="footer-desc" data-i18n="footer_desc">${t('footer_desc', 'AI-dedicated platform for Android live wallpaper.')}</p>
                </div>
                <div class="footer-col">
                    <div class="footer-col-title" data-i18n="footer_info">${t('footer_info', 'Info')}</div>
                    <a href="info.html#guide" class="footer-link" data-i18n="info_tab_guide">${t('info_tab_guide', 'User Guide')}</a>
                    <a href="info.html#faq" class="footer-link" data-i18n="info_tab_faq">${t('info_tab_faq', 'FAQ')}</a>
                    <a href="info.html#release-notes" class="footer-link" data-i18n="info_tab_release_notes">${t('info_tab_release_notes', 'Release Notes')}</a>
                    <a href="info.html#compare" class="footer-link" data-i18n="info_tab_compare">${t('info_tab_compare', 'Compare')}</a>
                </div>
                <div class="footer-col">
                    <div class="footer-col-title" data-i18n="footer_resources">${t('footer_resources', 'Resources')}</div>
                    <a href="https://play.google.com/store/apps/details?id=com.hank.clawlive" target="_blank" rel="noopener" class="footer-link">Google Play</a>
                    <a href="https://github.com/HankHuang0516/realbot" target="_blank" rel="noopener" class="footer-link">GitHub</a>
                    <a href="https://github.com/HankHuang0516/realbot/blob/main/PRIVACY_POLICY.md" target="_blank" rel="noopener" class="footer-link" data-i18n="footer_privacy">${t('footer_privacy', 'Privacy Policy')}</a>
                </div>
            </div>
            <div class="footer-bottom">
                &copy; ${new Date().getFullYear()} E-Claw &middot; HankHuang0516
            </div>
        </div>
    `;

    document.body.appendChild(footer);
}
