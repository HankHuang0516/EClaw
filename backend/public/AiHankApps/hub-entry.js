/* 管理中樞的入口：只有登入 EClaw 的管理者看得到。
   這支程式只問伺服器一件事「現在這個登入是不是管理者」，是的話才把連結加進頁面右下角的捷徑列；
   其他人（沒登入、或登入但不是管理者）頁面上不會多出任何東西。真正的把關在伺服器：
   /AiHankApps/hub/ 的頁面與資料，沒有管理者登入一律打不開。 */
(function () {
  'use strict';
  var row = document.querySelector('.portfolio-shortcuts');
  if (!row || typeof window.fetch !== 'function') return;
  window.fetch('/api/aihankapps/hub/access', { credentials: 'same-origin', cache: 'no-store' })
    .then(function (response) { return response.ok ? response.json() : null; })
    .then(function (body) {
      if (!body || body.admin !== true || row.querySelector('[data-hub-entry]')) return;
      var sample = row.querySelector('a');
      var link = document.createElement('a');
      link.href = 'hub/';
      link.setAttribute('data-hub-entry', '');
      link.setAttribute('aria-label', '開啟管理中樞（只有管理者看得到）');
      link.title = '只有管理者看得到';
      if (sample) link.style.cssText = sample.style.cssText;
      link.appendChild(document.createTextNode('管理中樞 '));
      var arrow = document.createElement('span');
      arrow.setAttribute('aria-hidden', 'true');
      arrow.textContent = '↗';
      link.appendChild(arrow);
      row.appendChild(link);
    })
    .catch(function () { /* 問不到就當作不是管理者 */ });
})();
