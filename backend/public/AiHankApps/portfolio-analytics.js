(() => {
  'use strict';
  if (window.AIHANK_TRAFFIC_READY) return;
  window.AIHANK_TRAFFIC_READY = true;
  const origin = 'https://eclawbot.com';
  const endpoint = origin + '/api/app-portfolio/traffic';
  const ownScript = document.currentScript;
  const introScript = document.querySelector('script[data-intro-toolbar]');
  const introId = ownScript?.dataset.portfolioApp;
  const isIntro = Boolean(introScript || introId);
  const production = ['eclawbot.com', 'www.eclawbot.com', 'eclw.twopiggyhavefun.chatgpt.site',
    'rebound-tactical-archive.twopiggyhavefun.chatgpt.site'].includes(location.hostname) && location.protocol === 'https:';
  const format = new Intl.NumberFormat('zh-TW');
  let catalog = window.AIHANK_APP_CATALOG?.apps || (typeof appList !== 'undefined' ? appList : []);
  let data = null;
  let fetching = false;
  let refreshTimer;
  const pending = new Map();
  const displays = new Map();
  const eye = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>';
  const style = document.createElement('style');
  style.textContent = `
    .portfolio-traffic-summary{display:flex;flex-wrap:wrap;gap:8px 20px;align-items:center;margin-top:18px;color:#425849;font-size:14px}
    .portfolio-traffic-summary small{color:#6d716a;font-size:12px}
    .card.has-traffic::after{display:none!important}
    .card.has-traffic .card-head{position:relative;min-height:100px;padding-right:172px}
    .card.has-traffic .guide-actions{position:absolute;right:0;top:0;display:flex;flex-direction:column;align-items:flex-end;gap:7px;z-index:6}
    .portfolio-traffic{position:relative;font:13px/1.5 inherit;color:#344d3e}
    .portfolio-traffic-button{display:flex;align-items:center;gap:6px;border:1px solid #aab9ac;border-radius:18px;background:#f6f8f1;color:inherit;padding:6px 10px;cursor:pointer;font:inherit;white-space:nowrap}
    .portfolio-traffic-button:focus-visible{outline:2px solid #376345;outline-offset:3px}
    .portfolio-traffic-details{position:absolute;right:0;bottom:calc(100% + 9px);width:260px;max-width:calc(100vw - 40px);padding:14px;background:#fffef9;border:1px solid #b9c6b9;border-radius:14px;box-shadow:0 12px 35px #173e2926;z-index:40;color:#344d3e;font-size:13px}
    .portfolio-traffic-details[hidden]{display:none}
    .portfolio-traffic-details table{width:100%;border-collapse:collapse;text-align:right;font-size:13px}
    .portfolio-traffic-details th:first-child{text-align:left}
    .portfolio-traffic-details th,.portfolio-traffic-details td{padding:5px 3px}
    .portfolio-traffic-details p{margin:7px 0 0!important;font-size:11px;color:#727970}
    .card.has-traffic{overflow:visible!important}
  `;
  document.head.appendChild(style);

  const count = value => Number.isSafeInteger(value) ? format.format(value) : '--';
  function render() {
    const summary = document.getElementById('portfolio-traffic-summary');
    if (summary) {
      summary.querySelector('[data-today]').textContent = count(data?.site.today);
      summary.querySelector('[data-total]').textContent = count(data?.site.total);
      summary.querySelector('small').textContent = data
        ? `台灣時間 ${data.day} · 瀏覽次數，非不重複人數${production ? '' : ' · 本機預覽不計數'}`
        : '統計暫不可用，稍後重試';
    }
    for (const [id, entries] of displays) {
      const value = data?.apps[id];
      for (const entry of entries) {
        if (!entry.box.isConnected) { entries.delete(entry); continue; }
        entry.label.textContent = `今日 ${count(value?.today)} / 累計 ${count(value?.total)}`;
        entry.button.setAttribute('aria-label', `點擊統計：${entry.label.textContent}；展開三項明細`);
        for (const cell of entry.panel.querySelectorAll('[data-metric]')) {
          cell.textContent = count(value?.[cell.dataset.metric]?.[cell.dataset.period]);
        }
      }
    }
  }
  async function refresh() {
    if (fetching || document.hidden) return;
    fetching = true;
    try {
      const response = await fetch(endpoint, { credentials: 'omit', cache: 'no-store' });
      const value = await response.json();
      if (!response.ok || value.success !== true || value.schemaVersion !== 1) throw new Error('Unavailable');
      data = value;
    } catch { data = null; }
    finally { fetching = false; render(); }
  }
  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, 350);
  }
  async function send(event, attempt = 0) {
    try {
      const response = await fetch(endpoint + '/events', {
        method: 'POST', credentials: 'omit', keepalive: true,
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body: JSON.stringify(event),
      });
      if (!response.ok) {
        if (response.status < 500) { pending.delete(event.eventId); return; }
        throw new Error('Unavailable');
      }
      pending.delete(event.eventId);
      scheduleRefresh();
    } catch {
      if (attempt < 2) setTimeout(() => send(event, attempt + 1), 1500 * (attempt + 1));
      else pending.delete(event.eventId);
    }
  }
  function track(appId, action) {
    if (!production || !crypto.randomUUID || pending.size >= 20) return;
    const event = { eventId: crypto.randomUUID(), appId, action };
    pending.set(event.eventId, event);
    send(event);
  }
  function recordForCard(card) {
    const id = card.querySelector('.app-community[data-app-id]')?.dataset.appId;
    const name = card.querySelector('h3')?.textContent.trim();
    return catalog.find(app => app.communityId === id || app.name === name);
  }
  function enhance() {
    if (isIntro) return;
    const title = document.querySelector('h1');
    if (title && !document.getElementById('portfolio-traffic-summary')) {
      const summary = document.createElement('div');
      summary.id = 'portfolio-traffic-summary';
      summary.className = 'portfolio-traffic-summary';
      summary.innerHTML = '<span>今日瀏覽 <strong data-today>--</strong></span><span>累計瀏覽 <strong data-total>--</strong></span><small>統計載入中</small>';
      title.parentElement.appendChild(summary);
    }
    for (const card of document.querySelectorAll('.card, .app-card')) {
      if (card.querySelector('.portfolio-traffic')) continue;
      const record = recordForCard(card);
      if (!record?.communityId) continue;
      const head = card.querySelector('.card-head');
      if (!head) continue;
      card.classList.add('has-traffic');
      let actions = head.querySelector('.guide-actions');
      if (!actions) { actions = document.createElement('div'); actions.className = 'guide-actions'; head.appendChild(actions); }
      const box = document.createElement('div');
      box.className = 'portfolio-traffic';
      const button = document.createElement('button');
      button.className = 'portfolio-traffic-button';
      button.type = 'button';
      button.innerHTML = eye + '<span></span>';
      button.setAttribute('aria-expanded', 'false');
      const label = button.querySelector('span');
      const panel = document.createElement('div');
      panel.className = 'portfolio-traffic-details';
      panel.id = `traffic-${record.communityId}`;
      panel.hidden = true;
      button.setAttribute('aria-controls', panel.id);
      panel.innerHTML = '<table><caption>點擊次數明細</caption><thead><tr><th>入口</th><th>今日</th><th>累計</th></tr></thead><tbody>' +
        [['intro', 'APP 介紹'], ['google', 'Google Play'], ['apple', 'App Store']].map(([key, name]) =>
          `<tr><th scope="row">${name}</th><td data-metric="${key}" data-period="today">--</td><td data-metric="${key}" data-period="total">--</td></tr>`).join('') +
        '</tbody></table><p>包含介紹頁內的商店點擊。台灣時間每日 00:00 換日；不是下載量或不重複人數。</p>';
      let pinned = false;
      let timeout;
      function show(open) { panel.hidden = !open; button.setAttribute('aria-expanded', String(open)); }
      button.addEventListener('click', () => {
        pinned = !pinned; clearTimeout(timeout); show(pinned); refresh();
        if (pinned) timeout = setTimeout(() => { pinned = false; show(false); }, 10000);
      });
      box.addEventListener('pointerenter', event => { if (event.pointerType === 'mouse') show(true); });
      box.addEventListener('pointerleave', () => { if (!pinned) show(false); });
      box.addEventListener('focusin', () => show(true));
      box.addEventListener('focusout', event => { if (!box.contains(event.relatedTarget)) { pinned = false; show(false); } });
      box.addEventListener('keydown', event => { if (event.key === 'Escape') { pinned = false; show(false); } });
      box.addEventListener('traffic-dismiss', () => { pinned = false; clearTimeout(timeout); show(false); });
      box.append(button, panel); actions.appendChild(box);
      if (!displays.has(record.communityId)) displays.set(record.communityId, new Set());
      displays.get(record.communityId).add({ box, button, label, panel });
    }
    render();
  }
  function click(event) {
    if (!event.isTrusted || (event.type === 'auxclick' && event.button !== 1)) return;
    const link = event.target.closest?.('a[href]');
    if (!link || link.matches('[aria-disabled="true"], .is-disabled')) return;
    const card = link.closest('.card, .app-card');
    const record = card ? recordForCard(card) : catalog.find(app => app.communityId === introId || app.name === introScript?.dataset.app);
    if (!record?.communityId) return;
    const url = new URL(link.href, location.href);
    let action = null;
    if (card && link.classList.contains('guide-link')) action = 'intro';
    else if (url.hostname === 'play.google.com' && url.searchParams.get('id') === record.googlePackage && record.publicGoogle) action = 'google';
    else if (url.hostname === 'apps.apple.com' && url.pathname.split('/').includes(`id${record.iosId}`) && record.publicApple) action = 'apple';
    if (action) track(record.communityId, action);
  }
  async function start() {
    if (!catalog.length) {
      try {
        const response = await fetch(endpoint + '/catalog', { credentials: 'omit' });
        if (response.ok) catalog = (await response.json()).apps || [];
      } catch { /* Never guess an APP identity when the catalog is unavailable. */ }
    }
    enhance();
    document.addEventListener('click', click, true);
    document.addEventListener('auxclick', click, true);
    if (!isIntro && document.querySelector('h1')) track('__site__', 'view');
    refresh();
    let queued = false;
    new MutationObserver(mutations => {
      if (queued || !mutations.some(m => [...m.addedNodes].some(n => n.nodeType === 1 &&
        (n.matches?.('.card, .app-card') || n.querySelector?.('.card, .app-card'))))) return;
      queued = true; queueMicrotask(() => { queued = false; enhance(); });
    }).observe(document.body, { childList: true, subtree: true });
    setInterval(() => { if (!document.hidden) refresh(); }, 60000);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
    document.addEventListener('pointerdown', event => {
      for (const entry of document.querySelectorAll('.portfolio-traffic')) {
        if (!entry.contains(event.target)) {
          entry.dispatchEvent(new Event('traffic-dismiss'));
        }
      }
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
