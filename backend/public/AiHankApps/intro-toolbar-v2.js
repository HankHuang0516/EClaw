(() => {
  'use strict';
  const script = document.currentScript;
  if (!script || !Object.prototype.hasOwnProperty.call(script.dataset, 'introToolbar')) return;

  const app = script.dataset.app || 'APP';
  const catalog = window.AIHANK_APP_CATALOG?.apps || [];
  const record = catalog.find(item => item.name === app || (item.googleUrl && item.googleUrl === script.dataset.google));
  const google = record ? record.googleUrl : script.dataset.google;
  const apple = record ? record.iosUrl : script.dataset.apple;
  const googleStatus = record ? (record.publicGoogle ? '正式版' : '開發中') : (script.dataset.googleStatus || '開發中');
  const appleStatus = record ? (record.publicApple ? '已上架' : '開發中') : (script.dataset.appleStatus || '開發中');
  const shortcuts = (script.dataset.shortcuts || '').split('|').map((entry) => {
    const splitAt = entry.lastIndexOf(':');
    return splitAt > 0 ? { label: entry.slice(0, splitAt), href: entry.slice(splitAt + 1) } : null;
  }).filter(Boolean);
  const playMark = '<svg viewBox="0 0 512 512" aria-hidden="true"><path fill="#00d7ff" d="M80 50 280 256 80 462c-12-9-18-22-18-39V89c0-17 6-30 18-39Z"/><path fill="#00f076" d="m80 50 250 140-50 66Z"/><path fill="#ffdb3b" d="m280 256 50 66L80 462Z"/><path fill="#ff3b48" d="m330 190 103 58c13 7 13 9 0 16l-103 58-50-66Z"/></svg>';
  const appleMark = '<svg viewBox="0 0 384 512" aria-hidden="true"><path d="M318.7 268.7c-.2-36.7 16.4-64.4 50-84.8-18.8-26.9-47.2-41.7-84.7-44.6-35.5-2.8-74.3 20.7-88.5 20.7-15 0-49.4-19.7-76.4-19.7C63.3 140.2 4 184.8 4 275.5c0 26.3 4.8 53.5 14.4 81.7 12.9 36.7 59.4 126.7 107.8 125.2 25.3-.6 43.2-18 76.3-18 32.1 0 48.6 18 76.9 18 48.8-.7 91-82.5 103.3-119.3-65.2-30.7-61.8-90-64-94.4ZM260.5 104.5c35.5-42 32.3-80.2 31.3-94.5-31.4 1.8-67.7 21.4-88.4 45.5-22.8 25.8-36.2 57.8-33.3 93.8 34 2.6 65-14.9 90.4-44.8Z"/></svg>';

  const toolbar = document.createElement('aside');
  toolbar.className = 'portfolio-intro-toolbar';
  toolbar.setAttribute('aria-label', app + '介紹頁工具列');

  const brand = document.createElement('a');
  brand.className = 'portfolio-intro-toolbar__brand';
  brand.href = '#top';
  brand.innerHTML = '<small>APP INTRODUCTION</small><strong></strong>';
  brand.querySelector('strong').textContent = app;
  toolbar.appendChild(brand);

  const nav = document.createElement('nav');
  nav.className = 'portfolio-intro-toolbar__nav';
  nav.setAttribute('aria-label', '介紹頁快捷導覽');
  shortcuts.forEach(({ label, href }) => {
    const link = document.createElement('a');
    link.href = href;
    link.textContent = label;
    nav.appendChild(link);
  });
  toolbar.appendChild(nav);

  const stores = document.createElement('div');
  stores.className = 'portfolio-intro-toolbar__stores';
  const isReleased = (status, url) => Boolean(url && ['正式版', '已上架', '已可發佈', '已可發布', '已發佈', '已發布'].includes(status));
  const storeAction = (platform, url, status, mark, caption, label) => {
    const available = isReleased(status, url);
    const action = document.createElement(available ? 'a' : 'span');
    action.className = 'toolbar-' + platform + (available ? '' : ' is-disabled');
    action.innerHTML = mark + '<span><small>' + (available ? caption : status) + '</small>' + label + '</span>';
    if (available) {
      action.href = url;
      action.target = '_blank';
      action.rel = 'noopener noreferrer';
      action.setAttribute('aria-label', '在' + label + '下載' + app);
    } else {
      action.setAttribute('aria-disabled', 'true');
      action.setAttribute('title', label + '：' + status);
    }
    return action;
  };
  stores.appendChild(storeAction('google', google, googleStatus, playMark, 'GET IT ON', 'Google Play'));
  stores.appendChild(storeAction('apple', apple, appleStatus, appleMark, 'Download on the', 'App Store'));
  toolbar.appendChild(stores);

  document.body.classList.add('has-portfolio-intro-toolbar');
  document.body.prepend(toolbar);
})();
