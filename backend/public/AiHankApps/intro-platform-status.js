(() => {
  'use strict';
  const apps = window.AIHANK_APP_CATALOG?.apps || [];
  document.querySelectorAll('[data-portfolio-platform-status]').forEach(node => {
    const app = apps.find(item => item.communityId === node.dataset.portfolioPlatformStatus);
    if (!app) return; // Preserve the reviewed static text if the catalogue is unavailable.
    const google = app.publicGoogle === true ? 'Google Play 已提供正式版下載' : 'Google Play 尚未公開';
    const apple = app.publicApple === true ? 'App Store 已提供正式版下載' : 'App Store 尚未公開';
    node.textContent = google + '；' + apple + '。';
  });
})();
