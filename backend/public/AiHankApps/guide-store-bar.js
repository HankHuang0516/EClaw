(() => {
  'use strict';
  const script = document.currentScript;
  if (!script || !script.dataset.portfolioDownloadBar) return;

  const app = script.dataset.app || 'APP';
  const google = script.dataset.google;
  const apple = script.dataset.apple;
  if (!google || !apple) return;

  const playMark = '<svg viewBox="0 0 512 512" aria-hidden="true"><path fill="#00d7ff" d="M80 50 280 256 80 462c-12-9-18-22-18-39V89c0-17 6-30 18-39Z"/><path fill="#00f076" d="m80 50 250 140-50 66Z"/><path fill="#ffdb3b" d="m280 256 50 66L80 462Z"/><path fill="#ff3b48" d="m330 190 103 58c13 7 13 9 0 16l-103 58-50-66Z"/></svg>';
  const appleMark = '<svg viewBox="0 0 384 512" aria-hidden="true"><path d="M318.7 268.7c-.2-36.7 16.4-64.4 50-84.8-18.8-26.9-47.2-41.7-84.7-44.6-35.5-2.8-74.3 20.7-88.5 20.7-15 0-49.4-19.7-76.4-19.7C63.3 140.2 4 184.8 4 275.5c0 26.3 4.8 53.5 14.4 81.7 12.9 36.7 59.4 126.7 107.8 125.2 25.3-.6 43.2-18 76.3-18 32.1 0 48.6 18 76.9 18 48.8-.7 91-82.5 103.3-119.3-65.2-30.7-61.8-90-64-94.4ZM260.5 104.5c35.5-42 32.3-80.2 31.3-94.5-31.4 1.8-67.7 21.4-88.4 45.5-22.8 25.8-36.2 57.8-33.3 93.8 34 2.6 65-14.9 90.4-44.8Z"/></svg>';

  const bar = document.createElement('aside');
  bar.className = 'portfolio-download-bar';
  bar.setAttribute('aria-label', app + '雙平台下載連結');
  bar.innerHTML = [
    '<div class="portfolio-download-bar__copy">',
    '<span class="portfolio-download-bar__kicker">AVAILABLE ON BOTH PLATFORMS</span>',
    '<strong></strong>',
    '</div>',
    '<div class="portfolio-download-bar__actions">',
    '<a class="portfolio-download-bar__google" target="_blank" rel="noopener noreferrer">' + playMark + '<span><small>GET IT ON</small>Google Play</span></a>',
    '<a class="portfolio-download-bar__apple" target="_blank" rel="noopener noreferrer">' + appleMark + '<span><small>Download on the</small>App Store</span></a>',
    '</div>'
  ].join('');

  bar.querySelector('strong').textContent = '喜歡' + app + '？立即下載完整 APP。';
  const googleLink = bar.querySelector('.portfolio-download-bar__google');
  googleLink.href = google;
  googleLink.setAttribute('aria-label', '在 Google Play 下載' + app);
  const appleLink = bar.querySelector('.portfolio-download-bar__apple');
  appleLink.href = apple;
  appleLink.setAttribute('aria-label', '在 App Store 下載' + app);
  document.body.prepend(bar);
})();
