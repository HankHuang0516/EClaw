/* global window, document */
/* Shared ops waveforms inside the authenticated Wishlist dashboard. */
(function () {
  'use strict';
  const t = window.HubWishlistText.t;
  const HOUR = 3600000, DAY = 24 * HOUR;
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const finiteCount = n => Number.isSafeInteger(n) && n >= 0;
  const labels = { retail_cp_evaluated: 'CP 評估', retail_lookups_completed: '原價查找', retail_prices_verified: '覆核後寫入原價', retail_prices_auto_verified: '自動寫入原價', retail_prices_proposed: '原價提案', retail_proposals_rejected: '原價退回', images_recognized: '商品圖片辨識', marketing_sets_generated: '行銷素材', photos_tagged: '照片標籤', photos_matched: '照片人物比對', videos_matched: '影片人物比對', chat_turns_inferred: '對話回合' };

  // Only source-issued rolling windows qualify. Closed hourly buckets are not a rolling hour.
  function recentValue(total, now) {
    const w = total && total.last60Minutes;
    if (!w || !Number.isFinite(w.from) || !Number.isFinite(w.to) || w.to - w.from !== HOUR) return { value: null, note: t('等待最近 60 分鐘的完整觀測') };
    if (w.fresh !== true || now - w.to > 10 * 60000 || w.to > now + 60000) return { value: null, note: t('觀測已延遲，等待更新') };
    const time = new Date(w.to).toLocaleTimeString(window.HubWishlistText.locale, { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hour12: false });
    if (w.coverage === 'complete' && finiteCount(w.count)) return { value: w.count, note: t('截至 {time}，最近 60 分鐘', { time }), exact: true };
    if (w.coverage !== 'complete' && finiteCount(w.lowerBound) && w.lowerBound > 0) return { value: w.lowerBound, note: t('截至 {time}，部分時段尚未完成觀測', { time }), exact: false };
    return { value: null, note: t('觀測不足，尚無可確認件數') };
  }
  function recentCells(ops, now = Date.now()) {
    return [['retail_lookups_completed', '原價查找 · 60 分鐘'], ['retail_cp_evaluated', 'CP 評估 · 60 分鐘']].map(([metric, label]) => {
      const result = recentValue(ops.ok ? ops.workTotals['work.wishlist-retail.' + metric] : null, now);
      const text = result.value == null ? '—' : t(result.exact ? '{n} 件' : '至少 {n} 件', { n: result.value.toLocaleString(window.HubWishlistText.locale) });
      return '<div class="dm-c ws-recent" data-tip="' + esc(result.note) + '" tabindex="0"><span>' + esc(t(label)) + '</span><b>' + text + '</b><small>' + esc(result.note) + '</small></div>';
    }).join('');
  }
  function chartHtml(id, title, sub, cpu) {
    const titleText = t(title);
    title = esc(titleText); sub = esc(t(sub));
    return '<section class="card ws-wave" data-wave="' + id + '"><div class="chart-toolbar"><div><h2>' + title + '</h2><p class="sub">' + sub + '</p></div>' +
      (id === 'work' ? '<label class="ws-worker-label">' + esc(t('工作來源')) + ' <select class="control" data-role="worker" aria-label="' + esc(t('AI 工作來源')) + '"></select></label>' : '') +
      '<div class="ws-wave-controls">' + (cpu ? '' : '<div class="segmented" data-role="mode" aria-label="' + title + esc(t('顯示方式')) + '"><button type="button" class="seg" data-mode="rate">' + esc(t('每段件數')) + '</button><button type="button" class="seg" data-mode="cumulative">' + esc(t('區間累計')) + '</button></div>') +
      '<div class="segmented" data-role="steps" aria-label="' + title + esc(t('時間刻度')) + '"></div><button type="button" class="ghost" data-role="reset">' + esc(t('重設範圍')) + '</button></div></div>' +
      '<div class="legend" data-role="legend"></div><div class="chart-wrap"><svg data-role="svg" role="img" tabindex="0" aria-label="' + esc(t('{title}波形；方向鍵查看、加減號縮放、Home 重設、Escape 關閉', { title: titleText })) + '"></svg><div class="tooltip" data-role="tooltip" hidden></div><div class="empty-note" data-role="empty" hidden></div></div>' +
      '<div class="detail" data-role="detail" hidden></div><div class="chart-foot"><span data-role="range"></span><span data-role="help"></span></div></section>';
  }
  function mount(host, data) {
    const charts = new Map(), events = [], catalog = data.ops.series || [], byId = Object.fromEntries(catalog.map(s => [s.id, s]));
    let disposed = false, refreshed = 0;
    const wishlistIds = ['wishlist.listed', 'work.wishlist-retail.retail_cp_evaluated', 'work.wishlist-retail.retail_lookups_completed', 'work.wishlist-retail.retail_prices_verified', 'wishlist.republished', 'wishlist.visible', 'wishlist.waiting', 'wishlist.chatPending'];
    const wish = wishlistIds.filter(id => byId[id]).map(id => Object.assign({}, byId[id], { label: t(labels[byId[id].metric] || byId[id].label), hiddenByDefault: !wishlistIds.slice(0, 3).includes(id) }));
    const work = catalog.filter(s => s.group === 'work'), workers = [...new Set(work.map(s => s.worker))];
    const cpu = catalog.filter(s => s.id === 'cpu.total.core' || (s.group === 'cpu' && s.worker && s.id.endsWith('.core'))).map(s => Object.assign({}, s, { hiddenByDefault: !!s.worker && !s.worker.startsWith('wishlist-') }));
    const select = host.querySelector('[data-role=worker]');
    workers.forEach(id => { const option = document.createElement('option'); option.value = id; option.textContent = work.find(s => s.worker === id).workerName || id; select.appendChild(option); });
    if (workers.includes('wishlist-vision')) select.value = 'wishlist-vision';
    const workSeries = () => work.filter(s => s.worker === select.value).map(s => Object.assign({}, s, { label: t(labels[s.metric] || s.label) }));
    const start = id => {
      if (disposed || charts.has(id)) return;
      const section = host.querySelector('[data-wave="' + id + '"]');
      const chart = new window.AiHankOpsCharts.WaveChart(section, { minStep: id === 'cpu' ? 'minute' : 'hour', defaultSpan: id === 'cpu' ? 6 * HOUR : 30 * DAY, zeroBased: true, dualAxis: id === 'wishlist', mode: id === 'wishlist' ? 'cumulative' : 'rate', help: t('點選圖表後滾輪縮放、拖曳平移；點選或長按查看該時段。未知留空。') });
      charts.set(id, chart);
      chart.setSeries(id === 'wishlist' ? wish : id === 'cpu' ? cpu : workSeries());
      if (id === 'wishlist') {
        const secondary = [...chart.legend.children].filter((_, i) => wish[i].hiddenByDefault);
        if (secondary.length) {
          const more = document.createElement('details'), summary = document.createElement('summary'), items = document.createElement('div');
          more.className = 'ws-more-series'; summary.textContent = t('其他數列'); items.className = 'legend';
          secondary.forEach(button => items.appendChild(button)); more.appendChild(summary); more.appendChild(items); chart.legend.appendChild(more);
        }
      }
    };
    start('wishlist');
    for (const fold of host.querySelectorAll('details[data-wave-fold]')) {
      const toggle = () => { if (fold.open) start(fold.dataset.waveFold); };
      fold.addEventListener('toggle', toggle); events.push(() => fold.removeEventListener('toggle', toggle)); toggle();
    }
    const change = () => { const chart = charts.get('work'); if (chart) chart.setSeries(workSeries()); };
    select.addEventListener('change', change); events.push(() => select.removeEventListener('change', change));
    return {
      refresh() { if (disposed || Date.now() - refreshed < 5 * 60000) return; refreshed = Date.now(); charts.forEach(c => { c.cache.clear(); c.load(); }); },
      destroy() { disposed = true; events.forEach(f => f()); charts.forEach(c => c.destroy()); charts.clear(); }
    };
  }
  window.HubWishlistOps = { recentValue, recentCells, chartHtml, mount };
})();
