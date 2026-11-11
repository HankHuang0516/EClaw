/* global window, document, localStorage, navigator, location, MutationObserver */
/* AiHankApps 管理中樞：畫面與互動。數字全部來自 hub-data.js 讀到的實際紀錄；
   每個指標的期間各自對齊到它最新的資料（商店報表每週才更新，即時來源算到昨天），畫面上都會標出來。 */
(function () {
  'use strict';

  const D = window.HubData, V = window.Viz, M = D.METRICS;
  const MIN = D.MIN, HOUR = D.HOUR, DAY = D.DAY;
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ico = (id, cls) => '<svg class="ico' + (cls ? ' ' + cls : '') + '" aria-hidden="true"><use href="#i-' + id + '"/></svg>';
  const store = {
    get(k, d) { try { const v = localStorage.getItem('hub.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('hub.' + k, JSON.stringify(v)); } catch (e) { /* 存不了就不存 */ } }
  };
  const MOD = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '') ? '⌘' : 'Ctrl';
  const LOGIN = '/portal/?return_to=%2FAiHankApps%2Fhub%2F';

  const RANGES = [['7d', 7, '過去 7 天', '7 天'], ['30d', 30, '過去 30 天', '30 天'], ['90d', 90, '過去 90 天', '90 天'], ['1y', 364, '過去 1 年', '1 年']];
  const VIEWS = [['overview', '總覽'], ['live', '即時監控'], ['kpi', '績效指標'], ['apps', 'APP'], ['alerts', '警示'], ['sources', '資料來源']];
  const TILE_KEYS = ['installs', 'active', 'newUsers', 'revenue', 'intro', 'listed'];
  // 單一 APP 頁的指標磚：有資料的前六項，照這個順序
  const APP_TILE_ORDER = ['installs', 'active', 'newUsers', 'plays', 'revenue', 'iap', 'purchases', 'intro', 'clicks', 'listed', 'aiwork', 'messages', 'mailClaimed', 'mailSent', 'ctr', 'crashes'];
  const KPI_KEYS = ['installs', 'newUsers', 'active', 'plays', 'messages', 'revenue', 'iap', 'purchases', 'intro', 'clicks', 'ctr', 'listed', 'aiwork', 'mailSent', 'mailClaimed', 'crashes'];
  const STATE = { ok: ['正常', 'ok'], warn: ['警告', 'warn'], crit: ['異常', 'crit'], dev: ['開發中', 'dev'], live: ['上架中', 'dot'], info: ['資訊', 'info'], none: ['還沒接', 'dot'] };
  const ATT = { ok: ['達標', 'ok'], near: ['接近', 'warn'], behind: ['落後', 'crit'] };
  const SEV = { crit: '嚴重', warn: '警告', info: '提醒' };
  const HEALTH = { healthy: ['ok', '正常'], degraded: ['warn', '部分異常'], unhealthy: ['crit', '異常'], unknown: ['info', '未知'], '': ['info', '未知'] };
  // 排程型 worker 在兩輪之間沒有程式在跑是正常的，不算停擺
  const workerState = w => {
    if (D.betweenRounds(w)) return ['info', '排程中，兩輪之間'];
    if (w.processOnline === false) return ['crit', '沒有在執行'];
    const issue = (w.health === 'degraded' || w.health === 'unhealthy') ? D.workerIssue(w) : null;
    return issue ? [w.health === 'unhealthy' ? 'crit' : 'warn', issue.label, issue.detail] : HEALTH[w.health] || HEALTH[''];
  };
  const LIVE_WIN = {
    '24h': { name: '24 小時', span: 24 * HOUR, cpuStep: 'minute', cpuBucket: 10 * MIN, cntStep: 'hour', cntBucket: HOUR },
    '7d': { name: '7 天', span: 7 * DAY, cpuStep: 'hour', cpuBucket: HOUR, cntStep: 'hour', cntBucket: HOUR },
    '30d': { name: '30 天', span: 30 * DAY, cpuStep: 'day', cpuBucket: DAY, cntStep: 'day', cntBucket: DAY }
  };
  const COLS = [
    { k: 'state', t: '狀態', sort: true, fixed: true }, { k: 'name', t: 'APP', sort: true, fixed: true }, { k: 'plat', t: '平台' },
    { k: 'installs', t: '新安裝', m: true }, { k: 'revenue', t: '廣告收入', m: true }, { k: 'intro', t: '介紹頁瀏覽', m: true }, { k: 'clicks', t: '商店點擊', m: true },
    { k: 'ctr', t: '點擊率', m: true, off: true }, { k: 'active', t: '活躍裝置', m: true, off: true }, { k: 'crashes', t: '當機', m: true, off: true },
    { k: 'rating', t: '評分', x: true }, { k: 'likes', t: '按讚', x: true, off: true }, { k: 'trend', t: '新安裝走勢' }
  ];

  const S = {
    view: 'overview', app: null,
    range: store.get('range', '30d'), custom: null, compare: store.get('compare', true) !== false,
    apps: new Set(), metric: 'installs', breakdown: 'total', exView: 'chart', rankAll: false, smScale: 'own',
    kpi: 'installs', kpiView: 'chart', revView: 'chart',
    live: true, win: store.get('win', '24h'),
    sort: { key: 'installs', dir: -1 }, q: '', cat: 'all', stage: 'all', cols: store.get('cols', {}) || {}, density: store.get('density', 'cozy'),
    alertFilter: 'all', acks: store.get('acks', {}) || {}, theme: store.get('theme', 'auto'), retApp: null
  };
  if (!RANGES.some(r => r[0] === S.range)) S.range = '30d';
  if (!LIVE_WIN[S.win]) S.win = '24h';
  const CH = {};          // 有名字的圖表（複製 CSV 用）
  const liveHooks = [];   // 每分鐘讀到新的營運數據之後要更新的東西
  let lastInput = 0, liveSeq = 0;

  // ---- 小工具 ---------------------------------------------------------------
  // 每個指標的期間對齊到它自己最後一個完整的日子
  function win(key) {
    if (S.custom) {
      const days = S.custom.to - S.custom.from, step = days > 120 ? 7 : 1, n = Math.max(2, Math.floor(days / step)), to = S.custom.to, from = to - n * step;
      return { from: from, to: to, step: step, n: n, days: n * step, custom: true, label: V.fDate(D.dayT(from)) + ' – ' + V.fDate(D.dayT(to - 1)), short: '這一段' };
    }
    const r = RANGES.find(x => x[0] === S.range), step = r[1] > 120 ? 7 : 1, to = D.metricEnd(key) + 1;
    return { from: to - r[1], to: to, step: step, n: r[1] / step, days: r[1], label: r[2], short: r[3] };
  }
  const prevOf = R => ({ from: R.from - R.days, to: R.from, step: R.step, n: R.n, days: R.days });
  // 前一期只有在整段都落在「每個來源都已經在記錄」之後才比；否則留空，不把還沒開始記錄當成 0
  const canCompare = (key, P) => D.comparable(key, P.from);
  const prevTotal = (key, apps, P) => (canCompare(key, P) ? D.total(key, apps, P.from, P.to) : null);
  const xs = R => Array.from({ length: R.n }, (_, i) => D.dayT(R.from + i * R.step));
  // 期間的起訖日；跨年的時候才寫年份
  const ymd = idx => { const d = new Date(D.dayT(idx) + D.TZ); return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()]; };
  const spanText = R => { const a = ymd(R.from), b = ymd(R.to - 1), y = a[0] !== b[0]; return (y ? a[0] + '/' : '') + a[1] + '/' + a[2] + '–' + (y ? b[0] + '/' : '') + b[1] + '/' + b[2]; };
  const selApps = () => (S.apps.size ? D.APPS.filter(a => S.apps.has(a.id)) : D.APPS);
  const stepName = R => (R.step >= 7 ? '每週' : '每日');
  const fv = (key, v) => V.fmt(M[key].fmt, v);
  const fmtOf = def => v => V.fmt(def.fmt, v);
  const cmpLabel = R => (R.custom ? '對比前一段' : '對比前 ' + R.short);
  const anyKnown = arr => arr.some(v => v != null);
  // 這個指標的資料停在哪一天：即時來源寫「到昨天」，落後的寫出日期與原因
  function endNote(key, brief) {
    const end = D.metricEnd(key), lag = D.today - 1 - end;
    if (lag <= 0) return '到昨天';
    return '資料到 ' + V.fDate(D.dayT(end)) + (!brief && M[key].src === 'store' ? '・商店報表每週更新' : '');
  }

  function delta(key, cur, prev) {
    if (cur == null || prev == null) return null;
    const def = M[key];
    if (def.pct) {
      const d = cur - prev;
      return { v: d, dir: Math.abs(d) < 0.05 ? 0 : d > 0 ? 1 : -1, text: Math.abs(d).toFixed(1) + ' 百分點' };
    }
    if (!prev) return cur ? { v: Infinity, dir: 1, text: '前期是 0' } : { v: 0, dir: 0, text: '0%' };
    const p = (cur - prev) / Math.abs(prev) * 100;
    return { v: p, dir: Math.abs(p) < 0.05 ? 0 : p > 0 ? 1 : -1, text: Math.abs(p).toFixed(1) + '%' };
  }
  function deltaHtml(key, d) {
    if (!d) return '<span class="dl is-flat" title="前一期沒有資料可以比">—</span>';
    const good = M[key].good, tone = d.dir === 0 || good === 0 ? 'flat' : d.dir * good > 0 ? 'good' : 'bad';
    const word = d.dir > 0 ? '增加' : d.dir < 0 ? '減少' : '持平';
    return '<span class="dl is-' + tone + '">' + ico(d.dir > 0 ? 'up' : d.dir < 0 ? 'down' : 'flat') + '<span class="sr-only">' + word + ' </span>' + esc(d.text) + '</span>';
  }
  const deltaText = d => (d ? (d.dir > 0 ? '▲ ' : d.dir < 0 ? '▼ ' : '') + d.text : '');
  function attain(cur, tgt) {
    if (cur == null || tgt == null || !tgt) return null;
    const ratio = cur / tgt;
    return { ratio: ratio, state: ratio >= 1 ? 'ok' : ratio >= 0.9 ? 'near' : 'behind' };
  }
  function meterHtml(a, label) {
    const w = Math.min(a.ratio, 1.25) / 1.25 * 100;
    return '<span class="meter" style="--mc:var(--' + ATT[a.state][1] + ')" role="img" aria-label="' + esc(label + ' ' + Math.round(a.ratio * 100) + '%') + '"><i style="width:' + w.toFixed(1) + '%"></i><b></b></span>';
  }
  function pill(state, text) {
    const s = STATE[state] || STATE.live;
    return '<span class="st st-' + state + '">' + ico(s[1]) + esc(text || s[0]) + '</span>';
  }
  const appIco = (a, cls) => '<span class="app-ico' + (cls ? ' ' + cls : '') + '">' + (a.icon ? '<img src="' + esc(a.icon) + '" alt="" width="72" height="72" loading="lazy">' : '<span>' + esc(a.mono) + '</span>') + '</span>';
  function seg(act, cur, items, off) {
    return '<div class="seg" role="group">' + items.map(it => '<button type="button" data-act="' + act + '" data-v="' + it[0] + '" aria-pressed="' + (cur === it[0]) + '"' + (off && off.indexOf(it[0]) >= 0 ? ' disabled' : '') + '>' + it[1] + '</button>').join('') + '</div>';
  }
  const head = (title, sub, tools) => '<header class="vh"><div><h1>' + esc(title) + '</h1>' + (sub ? '<p>' + sub + '</p>' : '') + '</div>' + (tools ? '<div class="vh-tools">' + tools + '</div>' : '') + '</header>';
  const cardHead = (title, sub, tools, subId) => '<header class="card-h"><div class="card-t"><h2>' + title + '</h2>' + (sub != null ? '<p class="sub"' + (subId ? ' id="' + subId + '"' : '') + '>' + sub + '</p>' : '') + '</div>' + (tools ? '<div class="card-tools">' + tools + '</div>' : '') + '</header>';
  const dmCell = (label, value, tip) => '<div class="dm-c"' + (tip ? ' data-tip="' + esc(tip) + '"' : '') + '><span>' + esc(label) + '</span><b>' + esc(value) + '</b></div>';
  const num = v => (v == null ? '—' : V.fmtInt(v));

  function toast(msg) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    $('#toasts').appendChild(t);
    setTimeout(() => t.classList.add('is-out'), 2600);
    setTimeout(() => t.remove(), 3000);
  }
  function copyText(text, okMsg) {
    const fail = () => toast('這裡沒辦法自動複製，請切到「表格」再選取');
    const fallback = () => {
      try {
        const ta = document.createElement('textarea');
        ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;left:-9999px;top:0';
        document.body.appendChild(ta); ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        if (ok) toast(okMsg); else fail();
      } catch (e) { fail(); }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(() => toast(okMsg), fallback); else fallback();
  }

  // ---- 警示（由資料層算出來；「確認」只記在這個瀏覽器）--------------------------
  const isAcked = a => S.acks[a.id] != null;
  const firing = () => D.ALERTS.filter(a => !isAcked(a));
  function pruneAcks() {
    const ids = new Set(D.ALERTS.map(a => a.id));
    let changed = false;
    Object.keys(S.acks).forEach(id => { if (!ids.has(id)) { delete S.acks[id]; changed = true; } });
    if (changed) store.set('acks', S.acks);
  }

  // ---- 外框：導覽、篩選列 -----------------------------------------------------
  function navHtml() {
    const n = firing().length;
    return VIEWS.map(v => {
      const on = S.view === v[0] || (S.view === 'app' && v[0] === 'apps');
      const badge = v[0] === 'alerts' && n ? '<em class="nav-c" aria-label="' + n + ' 件觸發中">' + n + '</em>' : v[0] === 'apps' ? '<em class="nav-c is-quiet">' + D.APPS.length + '</em>' : '';
      return '<a class="nav-i' + (on ? ' is-on' : '') + '" href="#' + v[0] + '"' + (S.view === v[0] ? ' aria-current="page"' : '') + '>' + ico(v[0]) + '<span>' + v[1] + '</span>' + badge + '</a>';
    }).join('');
  }
  function sideAppsHtml() {
    return '<h2>APP</h2>' + D.APPS.map(a => {
      const st = D.appState(a), on = S.view === 'app' && S.app === a.id;
      return '<a class="sa' + (on ? ' is-on' : '') + '" href="#app-' + a.id + '" title="' + esc(a.name + '・' + STATE[st][0]) + '"><i class="sd sd-' + st + '"></i><span>' + esc(a.short) + '</span>' + (st === 'crit' || st === 'warn' ? ico(st, 'sa-i st-' + st) : '') + '</a>';
    }).join('');
  }
  function filtersHtml() {
    const r = RANGES.find(x => x[0] === S.range);
    let h = '<button type="button" class="fbtn" id="f-range" data-act="pop-range" data-pop aria-haspopup="listbox">' + ico('cal') + '<span>' + (S.custom ? '自訂範圍' : r[2]) + '</span>' + ico('chev') + '</button>';
    if (S.custom) h += '<span class="chip">' + esc(win('intro').label) + '<button type="button" data-act="clear-custom" aria-label="取消自訂範圍">' + ico('x') + '</button></span>';
    h += '<label class="fcheck" for="f-compare"><input type="checkbox" id="f-compare" data-bind="compare"' + (S.compare ? ' checked' : '') + '><span>對比前一期</span></label>';
    if (S.view !== 'app') {
      h += '<span class="fsep"></span><button type="button" class="fbtn" id="f-apps" data-act="pop-apps" data-pop aria-haspopup="dialog">' + ico('filter') + '<span>' + (S.apps.size ? '已選 ' + S.apps.size + ' 款 APP' : '全部 APP') + '</span>' + ico('chev') + '</button>';
      if (S.apps.size && S.apps.size <= 3) S.apps.forEach(id => { h += '<span class="chip">' + esc(D.APP[id].short) + '<button type="button" data-act="remove-app" data-v="' + id + '" aria-label="移除 ' + esc(D.APP[id].short) + '">' + ico('x') + '</button></span>'; });
      if (S.apps.size) h += '<button type="button" class="btn-ghost" data-act="clear-filters">清除</button>';
    }
    return h + '<span class="f-r muted">' + (S.custom ? '所有指標都看這一段' : '每一項的期間對齊到它最新的資料') + '・讀取於 ' + V.fStamp(D.T0) + '</span>';
  }
  function syncChrome() {
    $('#nav').innerHTML = navHtml();
    $('#side-apps').innerHTML = sideAppsHtml();
    const f = $('#filters'), show = S.view === 'overview' || S.view === 'kpi' || S.view === 'apps' || S.view === 'app';
    f.hidden = !show;
    if (show) f.innerHTML = filtersHtml();
    syncLiveUi();
  }
  function syncLiveUi() {
    const p = $('#live-pill');
    p.classList.toggle('is-paused', !S.live);
    p.setAttribute('aria-pressed', String(S.live));
    $('#live-text').textContent = S.live ? '自動更新' : '已暫停';
    const b = $('#live-btn');
    if (b) b.innerHTML = S.live ? ico('pause') + '暫停' : ico('play') + '繼續';
  }

  // ---- 總覽 ------------------------------------------------------------------
  const lastKnown = arr => { for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return arr[i]; return null; };
  const sumKnown = arr => { let s = null; arr.forEach(v => { if (v != null) s = (s || 0) + v; }); return s; };
  function nowValues() {
    const o = D.ops, l = o.listing, rec = o.recent, ws = o.workers;
    const cpu = ws.filter(w => w.cpuCorePercent != null);
    const okN = ws.filter(w => (w.processOnline !== false || D.betweenRounds(w)) && w.health !== 'unhealthy' && w.health !== 'degraded').length;
    return {
      listed: l && l.today ? l.today.count : null,
      work: rec ? sumKnown(rec.work) : null,
      cpu: cpu.length ? cpu.reduce((s, w) => s + w.cpuCorePercent, 0) : rec ? lastKnown(rec.cpu) : null,
      msgs: D.todayValue('eclawMessages', 'eclawbot'), msgsPrev: D.RAW.eclawMessages ? D.total('messages', [D.BYKEY.eclawbot].filter(Boolean), D.today - 1, D.today) : null,
      okN: okN, total: ws.length,
      svcOk: D.services.filter(x => x.now && x.now.ok === true).length, svcKnown: D.services.filter(x => x.now && x.now.ok != null).length
    };
  }
  const svcState = x => (!x.now || x.now.ok == null ? ['live', '還沒檢查'] : x.now.ok ? ['ok', '正常・' + x.now.ms + ' ms'] : ['crit', x.now.status ? '回了 ' + x.now.status : '沒有回應']);
  function nowStripHtml() {
    const cell = (k, label, unit) => '<div class="now-c"><span class="now-l">' + label + '</span><span class="now-v"><b id="now-' + k + '">—</b>' + (unit ? '<em>' + unit + '</em>' : '') + '</span><span class="tc now-s" data-now="' + k + '" aria-hidden="true"></span></div>';
    return '<section class="now" aria-label="現在的狀況"><div class="now-h"><span class="now-t"><i class="pulse"></i>現在</span><span class="muted" id="now-clock"></span></div><div class="now-g">' +
      cell('listed', 'Wishlist 今日上架', '件') + cell('work', 'AI 完成工作・24 小時', '件') +
      '<div class="now-c"><span class="now-l">EClaw 今日訊息</span><span class="now-v"><b id="now-msgs">—</b><em>則</em></span><span class="now-x muted" id="now-msgs-x"></span></div>' +
      '<a class="now-c is-link" href="#live"><span class="now-l">後台服務</span><span class="now-v"><b id="now-svc">—</b><em id="now-svc-x"></em></span><span class="svc-dots" id="now-svc-dots"></span></a>' +
      '<a class="now-c is-link" href="#live"><span class="now-l">AI worker</span><span class="now-v"><b id="now-ok">—</b><em id="now-ok-x"></em></span><span class="svc-dots" id="now-dots"></span></a>' +
      '<a class="now-c is-link" href="#alerts"><span class="now-l">觸發中的警示</span><span class="now-v"><b id="now-al">—</b><em>件</em></span><span class="now-x" id="now-al-x"></span></a></div></section>';
  }
  function mountNow(el) {
    const charts = {}, SER = { listed: 'listed', work: 'work' };
    const paint = () => {
      const clock = $('#now-clock');
      if (!clock) return;
      const o = D.ops, n = nowValues(), rec = o.recent, seen = Date.parse(o.updatedAt.latestStatus || '') || 0;
      clock.textContent = o.ok ? '營運數據更新於 ' + (seen ? V.fAgo(Date.now() - seen) : '—') : '營運數據讀不到';
      $('#now-listed').textContent = num(n.listed);
      $('#now-work').textContent = num(n.work);
      $('#now-svc').textContent = n.svcKnown ? n.svcOk : '—';
      $('#now-svc-x').textContent = n.svcKnown ? '／' + n.svcKnown + ' 正常' : '';
      $('#now-svc-dots').innerHTML = D.services.map(x => { const st = svcState(x); return '<i class="sd sd-' + st[0] + '" data-tip="' + esc(x.name + '\n' + st[1]) + '"></i>'; }).join('');
      $('#now-msgs').textContent = num(n.msgs);
      $('#now-msgs-x').textContent = n.msgsPrev == null ? '' : '昨天 ' + V.fmtInt(n.msgsPrev) + ' 則';
      $('#now-ok').textContent = n.total ? n.okN : '—';
      $('#now-ok-x').textContent = n.total ? '／' + n.total + ' 正常' : '';
      $('#now-dots').innerHTML = o.workers.map(w => { const h = workerState(w); return '<i class="sd sd-' + (h[0] === 'info' ? 'live' : h[0]) + '" data-tip="' + esc(w.name + '\n' + h[1] + (h[2] ? '\n' + h[2] : '')) + '"></i>'; }).join('');
      const f = firing(), crit = f.filter(a => a.sev === 'crit').length, warn = f.filter(a => a.sev === 'warn').length;
      $('#now-al').textContent = f.length;
      $('#now-al-x').innerHTML = f.length ? (crit ? pill('crit', '嚴重 ' + crit) : '') + (warn ? pill('warn', '警告 ' + warn) : '') + (f.length - crit - warn ? pill('info', '提醒 ' + (f.length - crit - warn)) : '') : pill('ok', '沒有異常');
      $$('[data-now]', el).forEach(host => {
        const k = host.dataset.now, vals = rec ? rec[SER[k]] : null;
        if (!vals || !anyKnown(vals)) { if (charts[k]) { charts[k].destroy(); delete charts[k]; } host.textContent = ''; return; }
        const cfg = { compact: true, x: rec.x, step: HOUR, series: [{ key: k, name: k, color: 'var(--s1)', style: 'area', values: vals }], zero: true, fmt: String };
        if (charts[k]) charts[k].update(cfg); else charts[k] = V.timeChart(host, cfg);
      });
    };
    paint();
    liveHooks.push(paint);
  }
  function kpiCalc(key, apps) {
    const R = win(key), P = prevOf(R);
    const cur = D.total(key, apps, R.from, R.to), prev = prevTotal(key, apps, P), tgt = D.target(key, apps, R.from, R.to);
    return { key: key, R: R, P: P, cur: cur, prev: prev, tgt: tgt, d: delta(key, cur, prev), a: attain(cur, tgt), cov: D.coverage(key, apps, R.from, R.to) };
  }
  function tilesHtml(keys, apps) {
    return '<section class="tiles" aria-label="績效指標">' + keys.map(k => {
      const c = kpiCalc(k, apps), def = M[k], sel = S.metric === k;
      const span = spanText(c.R) + '・' + endNote(k, true) + (c.cov.known && c.cov.known < c.cov.days ? '・' + c.cov.known + ' 天有資料' : '');
      return '<button type="button" class="tile' + (sel ? ' is-sel' : '') + '" data-act="pick-metric" data-v="' + k + '" aria-pressed="' + sel + '" title="' + esc(def.note + '。點一下，下面的走勢圖換成這一項') + '">' +
        '<span class="tile-l">' + esc(def.name) + (def.type === 'level' ? '<em>日均</em>' : '') + '</span>' +
        '<span class="tile-v">' + fv(k, c.cur) + '</span>' +
        '<span class="tile-d">' + deltaHtml(k, c.d) + '<em>' + cmpLabel(c.R) + '</em></span>' +
        '<span class="tc tile-s" data-spark="' + k + '" aria-hidden="true"></span>' +
        '<span class="tile-m">' + (c.a ? meterHtml(c.a, '達成率') + '<em>目標 ' + fv(k, c.tgt) + '・達成 ' + Math.round(c.a.ratio * 100) + '%（' + ATT[c.a.state][0] + '）</em>' : '') + '<em>' + esc(span) + '</em></span></button>';
    }).join('') + '</section>';
  }
  function mountTiles(el, apps) {
    $$('[data-spark]', el).forEach(host => {
      const k = host.dataset.spark, R = win(k), P = prevOf(R), cur = D.series(k, apps, R.from, R.step, R.n);
      if (!anyKnown(cur)) return;
      const series = [{ key: 'cur', name: '本期', color: 'var(--s1)', style: 'area', values: cur }];
      if (S.compare && canCompare(k, P)) series.push({ key: 'prev', name: '前一期', color: 'var(--deemph)', style: 'dash', values: D.series(k, apps, P.from, R.step, R.n) });
      V.timeChart(host, { compact: true, x: cur.map((_, i) => i), step: 1, series: series, zero: M[k].type === 'count', fmt: String });
    });
  }
  function metricOptions(keys) {
    return D.GROUPS.map(g => {
      const list = keys.filter(k => M[k].group === g);
      return list.length ? '<optgroup label="' + g + '">' + list.map(k => '<option value="' + k + '"' + (k === S.metric ? ' selected' : '') + '>' + esc(M[k].name) + '</option>').join('') + '</optgroup>' : '';
    }).join('');
  }
  function explorerHtml(cls, keys, appMode) {
    const def = M[S.metric], canPlat = !!def.plat;
    if (S.breakdown === 'plat' && !canPlat) S.breakdown = 'total';
    if (S.breakdown === 'cat' && appMode) S.breakdown = 'total';
    const bd = appMode ? [['total', '總計'], ['plat', '依平台']] : [['total', '總計'], ['plat', '依平台'], ['cat', '依類別']];
    return '<section class="card ' + cls + '" id="explorer">' + cardHead('走勢', '', '<label class="sr-only" for="ex-metric">指標</label><select class="sel" id="ex-metric" data-bind="metric">' + metricOptions(keys) + '</select>' +
      seg('breakdown', S.breakdown, bd, canPlat ? null : ['plat']) + seg('ex-view', S.exView, [['chart', '圖表'], ['table', '表格']]) +
      '<button type="button" class="btn-ghost" data-act="copy-csv" data-v="explorer">' + ico('copy') + '複製 CSV</button>', 'ex-sub') +
      '<div class="legend" id="ex-legend" hidden></div><div class="tc ex-chart" id="ex-chart"></div><div id="ex-table" hidden></div>' +
      '<p class="hint">' + ico('info') + '<span>在圖上拖曳一段時間可以放大，點一下釘住數值。沒有長條或線的日子，是來源沒有那一天的資料。</span></p></section>';
  }
  function explorerCfg(apps, R, P) {
    const key = S.metric, def = M[key], cnt = def.type === 'count';
    let series, stacked = false;
    if (S.breakdown === 'plat') {
      series = D.PLATS.filter(p => def.plat && def.plat[p[0]]).map((p, i) => ({ key: p[0], name: p[1], color: 'var(--s' + (i + 1) + ')', style: cnt ? 'bar' : 'line', values: D.platSeries(key, apps, p[0], R.from, R.step, R.n) })).filter(s => anyKnown(s.values));
      stacked = cnt;
    } else if (S.breakdown === 'cat') {
      series = D.CATS.map((c, i) => ({ key: c, name: c, color: 'var(--s' + (i % 8 + 1) + ')', style: cnt ? 'bar' : 'line', values: D.series(key, apps.filter(a => a.cat === c), R.from, R.step, R.n) })).filter(s => anyKnown(s.values));
      stacked = cnt;
    } else {
      series = [{ key: 'cur', name: R.custom ? '選取的範圍' : '本期', color: 'var(--s1)', style: cnt ? 'bar' : 'line', values: D.series(key, apps, R.from, R.step, R.n) }];
      if (S.compare && canCompare(key, P)) series.push({ key: 'prev', name: '前一期', color: 'var(--deemph)', style: 'dash', values: D.series(key, apps, P.from, R.step, R.n) });
    }
    const total = S.breakdown === 'total', tgt = total ? D.target(key, apps, R.from, R.from + R.step) : null;
    return {
      x: xs(R), step: R.step * DAY, series: series, stacked: stacked, fmt: fmtOf(def), axisFmt: V.axisFmt(def.fmt), zero: def.type !== 'ratio', integer: def.type === 'count' && !def.frac,
      group: 'main', label: def.name + '，' + R.label + '，' + stepName(R) + '一格。用左右方向鍵逐格讀數值。',
      threshold: tgt == null ? null : { value: tgt, kind: 'target', label: '目標 ' + fv(key, tgt) + (R.step >= 7 ? '／週' : '／天') },
      tipExtra: total && series.length > 1 ? i => { const d = delta(key, series[0].values[i], series[1].values[i]); return d ? '對比前一期 ' + deltaText(d) : ''; } : null,
      onBrush: setCustom
    };
  }
  function mountExplorer(el, apps) {
    const host = $('#ex-chart', el);
    if (!host) return;
    const key = S.metric, def = M[key], R = win(key), P = prevOf(R), tableEl = $('#ex-table', el), cfg = explorerCfg(apps, R, P);
    $('#ex-sub', el).textContent = def.name + '・' + spanText(R) + '・' + stepName(R) + '・' + endNote(key) + (S.compare && S.breakdown === 'total' && !canCompare(key, P) ? '・前一期還沒有完整的紀錄，不比較' : '') + '・' + def.note;
    if (!cfg.series.some(s => anyKnown(s.values))) {
      host.outerHTML = '<p class="empty">' + (apps.length === D.APPS.length ? '這段期間沒有「' + esc(def.name) + '」的資料。' : '選取的 APP 在這段期間沒有「' + esc(def.name) + '」的資料。') + '</p>';
      tableEl.hidden = true;
      delete CH.explorer;
      return;
    }
    host.hidden = S.exView === 'table';
    tableEl.hidden = S.exView !== 'table';
    const chart = CH.explorer = V.timeChart(host, cfg);
    const refresh = () => { if (S.exView === 'table') tableEl.replaceChildren(V.dataTable(chart.cfg, chart.hidden)); };
    V.legend($('#ex-legend', el), chart, refresh);
    refresh();
  }
  function rankHtml(key, cls) {
    const def = M[key], R = win(key), P = prevOf(R);
    const rows = D.APPS.filter(a => D.hasData(key, a)).map(a => { const cur = D.total(key, [a], R.from, R.to); return { a: a, cur: cur, d: delta(key, cur, prevTotal(key, [a], P)) }; }).filter(r => r.cur != null).sort((x, y) => y.cur - x.cur);
    const max = rows.length ? rows[0].cur : 0, sum = def.type === 'count' ? rows.reduce((s, r) => s + r.cur, 0) : 0;
    const list = S.rankAll ? rows : rows.slice(0, 9);
    return '<section class="card ' + cls + '" id="rank">' + cardHead('各 APP 排行', esc(def.name) + '・' + spanText(R) + '・點一列，整頁只看那一款') + (rows.length ? '<div class="rank">' + list.map(r => {
      const on = S.apps.has(r.a.id), share = sum ? r.cur / sum * 100 : null;
      const tip = r.a.name + '\n' + def.name + ' ' + fv(key, r.cur) + (share != null ? '，佔全部的 ' + share.toFixed(1) + '%' : '') + '\n' + (on ? '點一下：取消只看這一款' : '點一下：整頁只看這一款');
      return '<div class="rank-r' + (on ? ' is-on' : '') + (S.apps.size && !on ? ' is-dim' : '') + '" role="button" tabindex="0" aria-pressed="' + on + '" data-act="toggle-app" data-v="' + r.a.id + '" data-tip="' + esc(tip) + '">' + appIco(r.a) + '<span class="rank-n">' + esc(r.a.short) + '</span><span class="rank-b"><i style="width:' + (max > 0 ? Math.max(r.cur > 0 ? 1.5 : 0, r.cur / max * 100) : 0).toFixed(1) + '%"></i></span><b class="rank-v">' + fv(key, r.cur) + '</b>' + deltaHtml(key, r.d) + '<a class="rank-go" href="#app-' + r.a.id + '" aria-label="開啟 ' + esc(r.a.name) + '" data-stop>' + ico('next') + '</a></div>';
    }).join('') + '</div>' + (rows.length > 9 ? '<button type="button" class="btn-ghost more" data-act="rank-all">' + (S.rankAll ? '只看前 9 名' : '顯示全部 ' + rows.length + ' 款') + '</button>' : '') : '<p class="empty">這段期間沒有任何 APP 有這一項的資料。</p>') + '</section>';
  }
  function multiplesHtml(apps) {
    const key = S.metric, def = M[key], R = win(key), list = apps.filter(a => D.hasData(key, a) && anyKnown(D.appSeries(a, key, R.from, R.step, R.n))), skipped = apps.length - list.length;
    if (!list.length) return '';
    return '<section class="card" id="multiples">' + cardHead('各 APP 走勢', esc(def.name) + '・' + spanText(R) + '・游標會同步到每一格' + (skipped ? '・另有 ' + skipped + ' 款沒有這項數據' : ''), seg('sm-scale', S.smScale, [['own', '各自刻度'], ['same', '同一刻度']])) +
      '<div class="sm-g">' + list.map(a => { const st = D.appState(a); return '<div class="sm"><div class="sm-h">' + appIco(a) + '<a class="sm-n" href="#app-' + a.id + '">' + esc(a.short) + '</a>' + (st === 'crit' || st === 'warn' ? '<span class="sr-only">' + STATE[st][0] + '</span>' + ico(st, 'sa-i st-' + st) : '') + '</div><div class="sm-v"><b data-smv></b><span class="muted" data-smt></span></div><div class="tc sm-c" data-sm="' + a.id + '"></div></div>'; }).join('') + '</div></section>';
  }
  function mountMultiples(el) {
    const key = S.metric, def = M[key], R = win(key), x = xs(R), f = fmtOf(def);
    let lo = Infinity, hi = -Infinity;
    const data = {};
    $$('[data-sm]', el).forEach(host => {
      const v = data[host.dataset.sm] = D.appSeries(D.APP[host.dataset.sm], key, R.from, R.step, R.n);
      for (const y of v) if (y != null) { if (y < lo) lo = y; if (y > hi) hi = y; }
    });
    $$('[data-sm]', el).forEach(host => {
      const id = host.dataset.sm, v = data[id], card = host.parentNode, vEl = $('[data-smv]', card), tEl = $('[data-smt]', card);
      const rest = () => { vEl.textContent = fv(key, D.total(key, [D.APP[id]], R.from, R.to)); tEl.textContent = def.type === 'count' ? '合計' : def.type === 'level' ? '日均' : '整段'; };
      rest();
      V.timeChart(host, {
        compact: true, hover: true, tooltip: false, group: 'main', x: x, step: R.step * DAY, zero: def.type !== 'ratio',
        domain: S.smScale === 'same' ? [def.type === 'ratio' ? lo : 0, hi > 0 ? hi : 1] : null,
        series: [{ key: id, name: D.APP[id].short, color: 'var(--s1)', style: 'area', values: v }], fmt: f,
        onHover: i => { if (i < 0) return rest(); vEl.textContent = v[i] == null ? '—' : f(v[i]); tEl.textContent = R.step >= 7 ? V.fDate(x[i]) + ' 那一週' : V.fDate(x[i]); },
        onClick: () => { location.hash = 'app-' + id; }
      });
    });
  }
  function alertsCardHtml() {
    const list = D.ALERTS;
    return '<section class="card c-6">' + cardHead('需要注意', '由目前的數字算出來，條件解除就會消失', '<a class="btn-ghost" href="#alerts">全部警示' + ico('next') + '</a>') + '<div class="al-mini">' +
      (list.length ? list.slice(0, 6).map(a => '<a class="alm" href="#alerts">' + pill(a.sev, SEV[a.sev]) + '<span class="alm-t"><b>' + esc(a.title) + '</b><em>' + (isAcked(a) ? '已確認・' : '') + esc(a.detail) + '</em></span></a>').join('') : '<p class="empty">目前沒有需要處理的警示。</p>') + '</div></section>';
  }
  // 每一個來源多久以前更新
  function freshCardHtml(cls) {
    const rows = D.sourceRows().filter(r => r.state !== 'none');
    return '<section class="card ' + (cls || 'c-6') + '">' + cardHead('資料新鮮度', '每一個來源最後一次更新的時間', '<a class="btn-ghost" href="#sources">全部來源' + ico('next') + '</a>') + '<ol class="feed">' +
      rows.map(r => '<li><span class="feed-k' + (r.state === 'crit' ? ' fk-incident' : '') + '">' + (r.state === 'ok' ? '正常' : r.state === 'warn' ? '沒更新' : '讀不到') + '</span><span class="feed-t"><b>' + esc(r.name) + '</b>　' + esc(r.note) + '</span><time class="muted"' + (r.last ? ' data-ago="' + r.last + '"' : '') + '>' + (r.last ? '' : '—') + '</time></li>').join('') + '</ol></section>';
  }
  function viewOverview(el) {
    const apps = selApps(), keys = Object.keys(M).filter(D.anyData);
    if (keys.indexOf(S.metric) < 0) S.metric = keys[0] || 'installs';
    el.innerHTML = head('總覽', '所有 APP 現在的狀況，以及這段期間的表現。') + nowStripHtml() + tilesHtml(TILE_KEYS, apps) +
      '<div class="grid">' + explorerHtml('c-8', keys) + rankHtml(S.metric, 'c-4') + '</div>' + multiplesHtml(apps) + '<div class="grid">' + alertsCardHtml() + freshCardHtml() + '</div>';
    mountNow(el); mountTiles(el, apps); mountExplorer(el, apps); mountMultiples(el);
  }

  // ---- 後台服務：有沒有回應、多快、可用率 --------------------------------------
  const pct = v => (v == null ? '—' : (v >= 99.995 || v === 0 ? v.toFixed(0) : v.toFixed(2)) + '%');
  function serviceRowsHtml(list) {
    return list.map(x => {
      const st = svcState(x), apps = x.apps.map(k => D.BYKEY[k]).filter(Boolean), n = Math.min(30, x.daily.up.length), off = x.daily.up.length - n, first = D.idxOfIso(x.daily.start) + off;
      const strip = x.daily.up.slice(off).map((v, i) => '<i class="' + (v == null ? 'up-na' : v >= 99.5 ? 'up-ok' : v >= 95 ? 'up-warn' : 'up-crit') + '" data-tip="' +
        esc(V.fDateDow(D.dayT(first + i)) + '\n' + (v == null ? '那天沒有檢查紀錄' : '可用率 ' + pct(v) + (x.daily.ms[off + i] != null ? '\n平均回應 ' + x.daily.ms[off + i] + ' ms' : ''))) + '"></i>').join('');
      // 版本放在服務名稱下面那一行，表格才放得進 1024 寬的畫面
      const version = x.now && x.now.info ? '<span class="muted"> · ' + esc(x.now.info) + '</span>' : '';
      return '<tr><td>' + pill(st[0] === 'live' ? 'info' : st[0], st[0] === 'ok' ? '正常' : st[0] === 'crit' ? '沒有回應' : '還沒檢查') + '</td><td><b>' + esc(x.name) + '</b><span class="sub-link">' +
        (apps.length ? apps.map(a => '<a href="#app-' + a.id + '">' + esc(a.short) + '</a>').join('、') : '共用') + version + '</span></td><td class="num">' + (x.now && x.now.ok ? V.fmtInt(x.now.ms) + ' ms' : '—') + '</td><td>' + V.spark(x.recent.ms, { w: 96, h: 24 }) + '</td>' +
        '<td class="num">' + pct(x.uptime24h) + '</td><td><span class="up">' + strip + '</span><span class="up-n">' + pct(x.uptime30d) + '</span></td></tr>';
    }).join('');
  }
  function serviceTableHtml(list, title, sub) {
    return '<section class="card">' + cardHead(title, sub) + (list.length ? '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>狀態</th><th>服務</th><th class="num">回應時間</th><th>近 24 小時回應</th><th class="num">24 小時可用率</th><th>近 30 天可用率</th></tr></thead><tbody data-services="' + esc(list.map(x => x.id).join(',')) + '">' + serviceRowsHtml(list) + '</tbody></table></div>' +
      '<p class="hint">' + ico('info') + '<span>近 30 天那一排每一格是一天，灰色是那天還沒有檢查紀錄。可用率從開始檢查那天算起，不是從服務上線那天。</span></p>' : '<p class="empty">還沒有服務檢查的紀錄；伺服器啟動後一分鐘內會有第一筆。</p>') + '</section>';
  }
  function drawResponse(el) {
    const host = $('#lv-resp', el), list = D.services;
    if (!host) return;
    let x, step, pick;
    if (S.win === '24h') {
      const r = (list[0] || {}).recent;
      if (r) { x = Array.from({ length: r.up.length }, (_, i) => r.from + i * r.step); step = r.step; pick = svc => svc.recent.ms; }
    } else {
      const d = (list[0] || {}).daily, n = S.win === '7d' ? 7 : 30;
      if (d) { const first = D.idxOfIso(d.start) + d.up.length - n; x = Array.from({ length: n }, (_, i) => D.dayT(first + i)); step = DAY; pick = svc => svc.daily.ms.slice(-n); }
    }
    const series = x ? list.map((svc, i) => ({ key: svc.id, name: svc.name, color: 'var(--s' + (i % 8 + 1) + ')', style: 'line', values: pick(svc) })).filter(q => anyKnown(q.values)) : [];
    if (!series.length) { host.innerHTML = '<p class="empty">這段時間還沒有檢查紀錄。</p>'; $('#lv-lg-resp', el).hidden = true; return; }
    V.legend($('#lv-lg-resp', el), V.timeChart(host, { group: 'live', pin: false, x: x, step: step, series: series, direct: false, fmt: v => V.fmtInt(v) + ' ms', axisFmt: V.axisFmt('int'), zero: true, integer: true, label: '後台回應時間' }));
  }
  // 留存：每一列是同一週加入的人，之後第 N 天還有多少比例回來
  function retentionHtml(a, cls, tools) {
    const r = D.retention(a), N = [1, 3, 7, 14, 30];
    if (!r) return '';
    const rows = r.cohorts.map(c => ({ c: c, cells: N.map(n => (c['d' + n] == null || !c.size ? null : c['d' + n] / c.size * 100)) }));
    let max = 0;
    rows.forEach(x => x.cells.forEach(v => { if (v != null && v > max) max = v; }));
    const wk = c => V.fDate(D.dayT(D.idxOfIso(c.start)));
    return '<section class="card ' + cls + '">' + cardHead(esc(a.short) + '的留存', '每一列是同一週加入的人，往右看之後第幾天還有多少比例回來・' + esc(r.basis || ''), tools) +
      '<div class="tbl-wrap"><table class="hm"><thead><tr><th>加入的那一週</th><th class="num">人數</th>' + N.map(n => '<th>第 ' + n + ' 天</th>').join('') + '</tr></thead><tbody>' +
      rows.map(x => '<tr><th scope="row">' + wk(x.c) + ' 起</th><td class="num">' + V.fmtInt(x.c.size) + '</td>' + x.cells.map((v, i) => (v == null
        ? '<td class="hm-c is-na" data-tip="' + esc(wk(x.c) + ' 那一週\n' + (x.c.size ? '還沒全部到第 ' + N[i] + ' 天' : '沒有人加入')) + '">·</td>'
        : '<td class="hm-c hm-' + (max ? Math.min(6, Math.floor(v / max * 7)) : 0) + '" tabindex="0" data-tip="' + esc(wk(x.c) + ' 那一週加入的 ' + V.fmtInt(x.c.size) + ' 人\n第 ' + N[i] + ' 天有 ' + V.fmtInt(x.c['d' + N[i]]) + ' 人回來（' + v.toFixed(1) + '%）') + '">' + v.toFixed(0) + '%</td>')).join('') + '</tr>').join('') +
      '</tbody></table></div><div class="scale"><span>低</span>' + [0, 1, 2, 3, 4, 5, 6].map(k => '<i class="hm-' + k + '"></i>').join('') + '<span>高</span><em>灰色的點是還沒到那一天</em></div>' +
      '<p class="hint">' + ico('info') + '<span>人數少的那幾週，一兩個人就會讓比例差很多，看趨勢就好。</span></p></section>';
  }

  // ---- 即時監控 ----------------------------------------------------------------
  function workerRowsHtml(workers) {
    const rec = D.ops.recent, cpuMax = Math.max(100, Math.max.apply(null, workers.map(w => w.cpuCorePercent || 0)));
    return workers.map(w => {
      const st = workerState(w), app = w.app ? D.BYKEY[w.app] : null, defs = D.ops.series.filter(s => s.group === 'work' && s.worker === w.id);
      let done = null, last = null;
      const lines = ['近 24 小時完成的工作'];
      defs.forEach(s => {
        const v = rec && rec.perWork[s.id] ? sumKnown(rec.perWork[s.id]) : null;
        if (v != null) done = (done || 0) + v;
        lines.push(s.label + '　' + (v == null ? '—' : V.fmtInt(v) + ' 件'));
        const t = D.ops.workTotals[s.id];
        if (t && t.lastCompletedAt && (!last || t.lastCompletedAt > last)) last = t.lastCompletedAt;
      });
      const off = w.processOnline === false, cpu = off ? null : w.cpuCorePercent;
      return '<tr><td' + (st[2] ? ' tabindex="0" data-tip="' + esc(st[2]) + '"' : '') + '>' + pill(st[0], st[1]) + '</td><td><b>' + esc(w.name) + '</b>' + (app ? '<a class="sub-link" href="#app-' + app.id + '">' + esc(app.short) + '</a>' : '<span class="sub-link">共用</span>') + '</td>' +
        '<td>' + (cpu == null ? '<span class="muted">—</span>' : '<span class="meter sm" style="--mc:var(--' + (cpu >= 300 ? 'crit' : cpu >= 150 ? 'warn' : 'accent') + ')"><i style="width:' + Math.min(100, cpu / cpuMax * 100).toFixed(0) + '%"></i></span><span class="lm-n">' + (cpu / 100).toFixed(2) + ' 核心</span>') + '</td>' +
        '<td class="num">' + (off || w.memoryBytes == null ? '—' : V.fmt('mem', w.memoryBytes)) + '</td>' +
        '<td class="num"' + (defs.length ? ' tabindex="0" data-tip="' + esc(lines.join('\n')) + '"' : '') + '>' + (defs.length ? (done == null ? '—' : V.fmtInt(done) + ' 件') : '<span class="muted">不計件</span>') + '</td>' +
        '<td class="muted">' + (last ? '<span data-ago="' + last + '"></span>' : '—') + '</td></tr>';
    }).join('');
  }
  function workerTableHtml(workers, title, sub) {
    return '<section class="card">' + cardHead(title, sub) + (workers.length ? '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>狀態</th><th>Worker</th><th>CPU</th><th class="num">記憶體</th><th class="num">近 24 小時完成</th><th>最後一次完成</th></tr></thead><tbody data-workers="' + esc(workers.map(w => w.id).join(',')) + '">' + workerRowsHtml(workers) + '</tbody></table></div><p class="hint">' + ico('info') + '<span>游標移到「近 24 小時完成」的數字上，可以看每一種工作各完成幾件。</span></p>' : '<p class="empty">監控目前沒有回報任何 worker。</p>') + '</section>';
  }
  function listingCells() {
    const l = D.ops.listing, c = D.ops.chat;
    if (!l) return '';
    return dmCell('今日上架', num(l.today && l.today.count) + ' 件', '今天還沒過完') + dmCell('昨日上架', num(l.yesterday && l.yesterday.count) + ' 件') + dmCell('近 60 分鐘', num(l.last60Minutes) + ' 件') +
      dmCell('近 24 小時平均', l.perHour24h == null ? '—' : Math.round(l.perHour24h) + ' 件／小時', l.targetPerHour == null ? '' : '目標是每小時 ' + l.targetPerHour + ' 件') +
      dmCell('近 7 天平均', l.perHour168h == null ? '—' : Math.round(l.perHour168h) + ' 件／小時') + dmCell('累計上架', num(l.cumulative && l.cumulative.count) + ' 件', l.cumulative && l.cumulative.from ? '自 ' + V.fStamp(l.cumulative.from) + ' 起' : '') +
      dmCell('公開可見', num(l.publiclyVisible) + ' 件') + dmCell('待公開', num(l.waitingToPublish) + ' 件') + dmCell('已下架', num(l.records && l.records.withdrawn) + ' 筆') +
      dmCell('聊聊待問', c && c.pendingCount != null ? c.pendingCount + ' 則' : '—', '買家詢問等待核准或轉達；最多延遲約 2 小時');
  }
  const liveCard = (k, title, sub) => '<section class="card c-6"><header class="card-h"><div class="card-t"><h2>' + title + '</h2><p class="sub">' + sub + '</p></div><b class="card-n" id="lv-n-' + k + '">—</b></header><div class="legend" id="lv-lg-' + k + '" hidden></div><div class="tc lv-chart" id="lv-' + k + '"></div></section>';
  async function loadLive(el) {
    const seq = ++liveSeq, w = LIVE_WIN[S.win], o = D.ops, now = Date.now();
    const cpuTo = S.win === '30d' ? D.dayT(D.today + 1) : Math.ceil(now / w.cpuBucket) * w.cpuBucket, cpuFrom = cpuTo - w.span, cpuN = Math.round(w.span / w.cpuBucket);
    const cntTo = S.win === '30d' ? cpuTo : Math.ceil(now / w.cntBucket) * w.cntBucket, cntFrom = cntTo - w.span, cntN = Math.round(w.span / w.cntBucket);
    const workers = o.workers, wids = D.workIds();
    const got = await Promise.all([
      D.opsSeries(workers.map(x => 'cpu.' + x.id + '.core').slice(0, 24), w.cpuStep, cpuFrom, cpuTo).catch(() => null),
      D.opsSeries(['wishlist.listed', 'wishlist.visible'].concat(wids).slice(0, 24), w.cntStep, cntFrom, cntTo).catch(() => null)
    ]);
    if (seq !== liveSeq || !$('#lv-cpu', el)) return;
    const pts = (res, id) => (res && res[id] && res[id].points) || [];
    const xOf = (from, step, n) => Array.from({ length: n }, (_, i) => from + i * step);
    const draw = (k, cfg, legend) => {
      const host = $('#lv-' + k, el);
      if (!cfg.series.some(s => anyKnown(s.values))) { host.innerHTML = '<p class="empty">這段時間沒有讀數。</p>'; $('#lv-lg-' + k, el).hidden = true; return; }
      const chart = V.timeChart(host, Object.assign({ group: 'live', pin: false }, cfg));
      if (legend) V.legend($('#lv-lg-' + k, el), chart);
    };
    // CPU：每個 worker 一條線，單位是核心數
    const cpuSeries = workers.map((x, i) => ({ key: x.id, name: x.name, short: x.name.slice(0, 10), color: 'var(--s' + (i % 8 + 1) + ')', style: 'line', values: D.bucketize(pts(got[0], 'cpu.' + x.id + '.core'), cpuFrom, w.cpuBucket, cpuN, 'gauge').map(v => (v == null ? null : v / 100)) })).filter(s => anyKnown(s.values));
    draw('cpu', { x: xOf(cpuFrom, w.cpuBucket, cpuN), step: w.cpuBucket, series: cpuSeries, direct: false, fmt: v => v.toFixed(2) + ' 核心', axisFmt: V.axisFmt('fix2'), zero: true, label: 'AI worker CPU' }, true);
    // 完成件數：每個 worker 疊在一起
    const workSeries = workers.map((x, i) => {
      const ids = wids.filter(id => id.split('.')[1] === x.id), vals = new Array(cntN).fill(null);
      ids.forEach(id => D.bucketize(pts(got[1], id), cntFrom, w.cntBucket, cntN, 'count').forEach((v, j) => { if (v != null) vals[j] = (vals[j] || 0) + v; }));
      return { key: x.id, name: x.name, color: 'var(--s' + (i % 8 + 1) + ')', style: 'bar', values: vals };
    }).filter(s => anyKnown(s.values));
    draw('work', { x: xOf(cntFrom, w.cntBucket, cntN), step: w.cntBucket, series: workSeries, stacked: true, fmt: v => V.fmtInt(v) + ' 件', axisFmt: V.axisFmt('int'), integer: true, label: 'AI 完成工作' }, true);
    const l = o.listing, perBucket = l && l.targetPerHour != null ? l.targetPerHour * w.cntBucket / HOUR : null;
    draw('listed', { x: xOf(cntFrom, w.cntBucket, cntN), step: w.cntBucket, series: [{ key: 'listed', name: '成功上架', color: 'var(--s1)', style: 'bar', values: D.bucketize(pts(got[1], 'wishlist.listed'), cntFrom, w.cntBucket, cntN, 'count') }], fmt: v => V.fmtInt(v) + ' 件', axisFmt: V.axisFmt('int'), integer: true,
      threshold: perBucket == null ? null : { value: perBucket, kind: 'target', label: '目標 ' + V.fmtInt(perBucket) + (w.cntBucket >= DAY ? '／天' : '／小時') }, label: 'Wishlist 上架' });
    draw('visible', { x: xOf(cntFrom, w.cntBucket, cntN), step: w.cntBucket, series: [{ key: 'visible', name: '公開可見商品', color: 'var(--s1)', style: 'line', values: D.bucketize(pts(got[1], 'wishlist.visible'), cntFrom, w.cntBucket, cntN, 'gauge') }], fmt: v => V.fmtInt(v) + ' 件', axisFmt: V.axisFmt('int'), zero: false, integer: true, label: '公開可見商品' });
  }
  function paintLiveNumbers() {
    const n = nowValues(), l = D.ops.listing, set = (id, t) => { const e = $(id); if (e) e.textContent = t; };
    set('#lv-n-cpu', n.cpu == null ? '—' : (n.cpu / 100).toFixed(2) + ' 核心');
    set('#lv-n-work', n.work == null ? '—' : '24 小時 ' + V.fmtInt(n.work) + ' 件');
    set('#lv-n-listed', l && l.today ? '今日 ' + num(l.today.count) + ' 件' : '—');
    set('#lv-n-visible', l && l.publiclyVisible != null ? V.fmtInt(l.publiclyVisible) + ' 件' : '—');
    set('#lv-n-resp', n.svcKnown ? n.svcOk + '／' + n.svcKnown + ' 正常' : '—');
    $$('[data-services]').forEach(tb => { const ids = tb.dataset.services.split(','); tb.innerHTML = serviceRowsHtml(D.services.filter(x => ids.indexOf(x.id) >= 0)); });
    $$('[data-workers]').forEach(tb => { const ids = tb.dataset.workers.split(','); tb.innerHTML = workerRowsHtml(D.ops.workers.filter(w => ids.indexOf(w.id) >= 0)); });
    const dm = $('#lv-listing');
    if (dm) dm.innerHTML = listingCells();
  }
  function viewLive(el) {
    const o = D.ops, w = LIVE_WIN[S.win];
    el.innerHTML = head('即時監控', '後台服務每分鐘檢查一次；AI worker 與 Wishlist 的讀數每 5 分鐘送來一批。這一頁每分鐘更新。', seg('win', S.win, Object.keys(LIVE_WIN).map(k => [k, LIVE_WIN[k].name])) + '<button type="button" class="btn" data-act="live-toggle" id="live-btn"></button>') +
      (o.ok ? '' : '<p class="note">' + ico('warn') + '營運數據目前讀不到，下面的圖表與表格會是空的。其他頁面不受影響。</p>') +
      serviceTableHtml(D.services, '後台服務', 'EClaw 主站每分鐘問一次各後台的健康檢查網址，記下有沒有回應、花了多久') +
      '<div class="grid">' + liveCard('resp', '後台回應時間', (S.win === '24h' ? '每 5 分鐘' : '每天') + '的平均回應時間，一個服務一條線') + liveCard('cpu', 'AI worker CPU', '每個 worker 用了幾顆核心・' + (w.cpuBucket >= DAY ? '每日平均' : w.cpuBucket >= HOUR ? '每小時平均' : '每 10 分鐘平均')) + liveCard('work', 'AI 完成工作', (w.cntBucket >= DAY ? '每天' : '每小時') + '完成的件數，依 worker 疊在一起') +
      liveCard('listed', 'Wishlist 上架', (w.cntBucket >= DAY ? '每天' : '每小時') + '第一次公開的紀錄數・虛線是目標') + liveCard('visible', '公開可見商品', 'Wishlist.ai 上現在看得到的商品數') + '</div>' +
      workerTableHtml(o.workers, 'AI worker', '每個 worker 現在的狀態與最近完成的工作') +
      '<section class="card">' + cardHead('Wishlist.ai 現況', '上架與公開的最新數字') + (o.listing ? '<div class="dm" id="lv-listing">' + listingCells() + '</div>' : '<p class="empty">目前讀不到 Wishlist 的上架報表。</p>') + '</section>';
    syncLiveUi();
    paintLiveNumbers();
    drawResponse(el);
    loadLive(el);
    liveHooks.push(paintLiveNumbers);
  }

  // ---- 績效指標 ----------------------------------------------------------------
  function scorecardHtml(rows, apps) {
    return '<section class="card">' + cardHead('計分卡', '每一項和它自己的前一期比。有明訂目標的才有達成率。') + '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>指標</th><th class="num">本期</th><th class="num">前期</th><th>變化</th><th class="num">目標</th><th>達成率</th><th>走勢</th><th>期間</th></tr></thead><tbody>' +
      rows.map(r => {
        const def = M[r.key], sel = S.kpi === r.key, R = r.R, P = r.P;
        return '<tr class="is-click' + (sel ? ' is-sel' : '') + '" tabindex="0" role="button" aria-pressed="' + sel + '" data-act="pick-kpi" data-v="' + r.key + '"><td><b>' + esc(def.name) + (def.type === 'level' ? '（日均）' : '') + '</b><span class="sub-link">' + esc(def.note) + '</span></td><td class="num strong">' + fv(r.key, r.cur) + '</td><td class="num muted">' + fv(r.key, r.prev) + '</td><td>' + deltaHtml(r.key, r.d) + '</td><td class="num">' + (r.tgt == null ? '<span class="muted">沒有設定</span>' : fv(r.key, r.tgt)) + '</td><td class="att">' + (r.a ? meterHtml(r.a, '達成率') + '<em>' + Math.round(r.a.ratio * 100) + '%</em>' : '—') + '</td><td>' +
          V.spark(D.series(r.key, apps, R.from, R.step, R.n), { cmp: S.compare && canCompare(r.key, P) ? D.series(r.key, apps, P.from, R.step, R.n) : null, w: 104, h: 26 }) + '</td><td class="muted">' + spanText(R) + '<span class="sub-link">' + esc(endNote(r.key)) + '</span></td></tr>';
      }).join('') + '</tbody></table></div></section>';
  }
  function funnelHtml(apps) {
    const R = win('intro'), all = apps.length === D.APPS.length;
    const steps = [];
    if (all) steps.push({ name: '打開作品集', value: D.siteViews(R.from, R.to) });
    steps.push({ name: '打開 APP 介紹', value: D.total('intro', apps, R.from, R.to) }, { name: '點去商店', value: D.total('clicks', apps, R.from, R.to) });
    const f = steps.filter(s => s.value != null), top = f.length ? Math.max.apply(null, f.map(s => s.value)) : 0;
    const body = f.length >= 2 && top > 0 ? '<div class="fn">' + f.map((s, i) => (i ? '<div class="fn-step">' + ico('down') + '<span>' + (f[i - 1].value ? (s.value / f[i - 1].value * 100).toFixed(1) + '% 走到下一步' : '—') + '</span></div>' : '') + '<div class="fn-r" tabindex="0" data-tip="' + esc(s.name + '\n' + V.fmtInt(s.value) + ' 次') + '"><span class="fn-n">' + esc(s.name) + '</span><span class="fn-b"><i class="ord-' + (i + 1) + '" style="width:' + Math.max(s.value ? 1.5 : 0, s.value / top * 100).toFixed(1) + '%"></i></span><b class="fn-v">' + V.fmtInt(s.value) + '</b></div>').join('') + '</div><p class="hint">' + ico('info') + '<span>這是「次數」不是「人數」：同一個人看兩次算兩次。安裝數來自商店報表，更新時間不同，所以不放在同一張圖。</span></p>' : '<p class="empty">這段期間沒有作品集的流量紀錄。</p>';
    return '<section class="card c-5">' + cardHead('作品集漏斗', spanText(R) + '・從打開作品集，到點去商店' + (all ? '' : '・只看選取的 APP')) + body + '</section>';
  }
  function moversHtml(apps) {
    const key = S.kpi, def = M[key], R = win(key), P = prevOf(R);
    const rows = apps.filter(a => D.hasData(key, a)).map(a => ({ a: a, d: delta(key, D.total(key, [a], R.from, R.to), prevTotal(key, [a], P)) })).filter(r => r.d && isFinite(r.d.v) && r.d.dir !== 0).sort((x, y) => y.d.v - x.d.v);
    const pick = rows.length > 8 ? rows.slice(0, 4).concat(rows.slice(-4)) : rows, max = pick.reduce((m, r) => Math.max(m, Math.abs(r.d.v)), 0) || 1;
    return '<section class="card c-5">' + cardHead('成長與下滑', esc(def.name) + '・' + cmpLabel(R) + (rows.length > 8 ? '・前 4 名與後 4 名' : '')) + (pick.length ? '<div class="dv">' + pick.map(r => '<a class="dv-r" href="#app-' + r.a.id + '" data-tip="' + esc(r.a.name + '\n' + def.name + ' ' + deltaText(r.d)) + '"><span class="dv-n">' + esc(r.a.short) + '</span><span class="dv-b"><i class="' + (r.d.v >= 0 ? 'is-pos' : 'is-neg') + '" style="width:' + (Math.abs(r.d.v) / max * 50).toFixed(1) + '%"></i></span><span class="dv-v">' + deltaHtml(key, r.d) + '</span></a>').join('') + '</div><p class="hint">' + ico('info') + '<span>長條往右是增加、往左是減少；是好是壞看右邊箭頭的顏色。</span></p>' : '<p class="empty">沒有哪一款的「' + esc(def.name) + '」和前一期不同。</p>') + '</section>';
  }
  function revenueSeries(apps, R) {
    const step = R.days > 45 ? 7 : 1, n = Math.floor(R.days / step), from = R.to - n * step;
    const rows = apps.filter(a => D.hasData('revenue', a)).map(a => ({ a: a, v: D.appSeries(a, 'revenue', from, step, n), t: D.total('revenue', [a], from, R.to) || 0 })).filter(r => r.t > 0).sort((x, y) => y.t - x.t);
    const top = rows.slice(0, 7), rest = rows.slice(7);
    const series = top.map((r, i) => ({ key: r.a.id, name: r.a.short, color: 'var(--s' + (i + 1) + ')', style: 'bar', values: r.v }));
    if (rest.length) series.push({ key: 'other', name: '其他 ' + rest.length + ' 款', color: 'var(--deemph)', style: 'bar', values: Array.from({ length: n }, (_, i) => { let s = null; rest.forEach(r => { if (r.v[i] != null) s = (s || 0) + r.v[i]; }); return s; }) });
    return { series: series, x: Array.from({ length: n }, (_, i) => D.dayT(from + i * step)), step: step };
  }
  // 績效頁的留存：有留存數據的 APP 選一款看
  function retentionPickHtml(apps) {
    const have = apps.filter(a => D.retention(a));
    if (!have.length) return '<section class="card c-7">' + cardHead('留存', '每週加入的人之後還有多少比例回來') + '<p class="empty">選取的 APP 沒有留存數據。目前有的是 REBOUND、雙城烽火與 Wishlist.ai，由收集工具從各自的後台算出來。</p></section>';
    const cur = have.find(a => a.id === S.retApp) || have[0];
    return retentionHtml(cur, 'c-7', have.length > 1 ? '<label class="sr-only" for="ret-app">看哪一款 APP 的留存</label><select class="sel" id="ret-app" data-bind="ret-app">' + have.map(a => '<option value="' + a.id + '"' + (a === cur ? ' selected' : '') + '>' + esc(a.short) + '</option>').join('') + '</select>' : '');
  }
  function viewKpi(el) {
    const apps = selApps(), keys = KPI_KEYS.filter(D.anyData);
    if (keys.indexOf(S.kpi) < 0) S.kpi = keys[0] || 'installs';
    const rows = keys.map(k => kpiCalc(k, apps)), key = S.kpi, def = M[key], R = win(key), P = prevOf(R), RR = win('revenue');
    el.innerHTML = head('績效指標', '每一項都和前一期比。點計分卡的一列，下面的圖會換成那一項。') + scorecardHtml(rows, apps) +
      '<div class="grid"><section class="card c-7">' + cardHead(esc(def.name) + '的走勢', spanText(R) + '・' + stepName(R) + '・' + endNote(key), seg('kpi-view', S.kpiView, [['chart', '圖表'], ['table', '表格']])) + '<div class="legend" id="kpi-legend" hidden></div><div class="tc ex-chart" id="kpi-chart"></div><div id="kpi-table" hidden></div></section>' + rankHtml(key, 'c-5') + '</div>' +
      '<div class="grid">' + funnelHtml(apps) + '<section class="card c-7">' + cardHead('廣告收入組成', '', seg('rev-view', S.revView, [['chart', '圖表'], ['table', '表格']]), 'rev-sub') + '<div class="legend" id="rev-legend" hidden></div><div class="tc ex-chart" id="rev-chart"></div><div id="rev-table" hidden></div></section></div>' +
      '<div class="grid">' + moversHtml(apps) + retentionPickHtml(apps) + '</div>' + feedbackCardHtml(apps, '');
    // 走勢＋目標線
    const cnt = def.type === 'count', series = [{ key: 'cur', name: '本期', color: 'var(--s1)', style: cnt ? 'bar' : 'line', values: D.series(key, apps, R.from, R.step, R.n) }];
    if (S.compare && canCompare(key, P)) series.push({ key: 'prev', name: '前一期', color: 'var(--deemph)', style: 'dash', values: D.series(key, apps, P.from, R.step, R.n) });
    const per = D.target(key, apps, R.from, R.from + R.step), host = $('#kpi-chart', el), tableEl = $('#kpi-table', el);
    if (anyKnown(series[0].values)) {
      host.hidden = S.kpiView === 'table';
      tableEl.hidden = S.kpiView !== 'table';
      const chart = CH.kpi = V.timeChart(host, {
        x: xs(R), step: R.step * DAY, series: series, fmt: fmtOf(def), axisFmt: V.axisFmt(def.fmt), zero: def.type !== 'ratio', integer: cnt && !def.frac, group: 'kpi',
        threshold: per == null ? null : { value: per, kind: 'target', label: '目標 ' + fv(key, per) + (R.step >= 7 ? '／週' : '／天') },
        label: def.name + '，' + R.label, onBrush: setCustom,
        tipExtra: series.length > 1 ? i => { const d = delta(key, series[0].values[i], series[1].values[i]); return d ? '對比前一期 ' + deltaText(d) : ''; } : null
      });
      const refresh = () => { if (S.kpiView === 'table') tableEl.replaceChildren(V.dataTable(chart.cfg, chart.hidden)); };
      V.legend($('#kpi-legend', el), chart, refresh);
      refresh();
    } else host.outerHTML = '<p class="empty">這段期間沒有「' + esc(def.name) + '」的資料。</p>';
    // 廣告收入組成
    const rev = revenueSeries(apps, RR), revHost = $('#rev-chart', el), revTable = $('#rev-table', el);
    $('#rev-sub', el).textContent = spanText(RR) + '・' + (rev.step >= 7 ? '每週' : '每日') + '一根・每款 APP 一種顏色・' + endNote('revenue');
    if (rev.series.length) {
      revHost.hidden = S.revView === 'table';
      revTable.hidden = S.revView !== 'table';
      const rc = V.timeChart(revHost, { x: rev.x, step: rev.step * DAY, stacked: true, series: rev.series, fmt: v => V.fmt('money', v), axisFmt: V.axisFmt('money'), label: '廣告收入組成，' + RR.label });
      const revRefresh = () => { if (S.revView === 'table') revTable.replaceChildren(V.dataTable(rc.cfg, rc.hidden)); };
      V.legend($('#rev-legend', el), rc, revRefresh);
      revRefresh();
    } else revHost.outerHTML = '<p class="empty">這段期間沒有廣告收入的紀錄。</p>';
  }
  // 評分與回饋：商店評分、評論數，作品集上的按讚、留言、內測回饋
  function feedbackCardHtml(apps, cls) {
    const L = D.latest, rows = apps.map(a => {
      const r = (L.rating || {})[a.key], rv = (L.reviews || {})[a.key], b = (L.betaFeedback || {})[a.key], fb = (L.feedback || {})[a.key];
      return { a: a, rating: r ? r.value : null, reviews: rv ? (rv.google || 0) + (rv.apple || 0) : null, likes: (L.likes || {})[a.key] || 0, comments: (L.comments || {})[a.key] || 0, beta: b || null, fb: fb || null };
    }).filter(r => r.rating != null || r.reviews || r.likes || r.comments || r.beta || r.fb).sort((x, y) => (y.likes + y.comments) - (x.likes + x.comments));
    return '<section class="card ' + cls + '">' + cardHead('評分與回饋', '商店評分與評論，加上作品集上的按讚、留言與內測回饋・累計到現在') + (rows.length ? '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>APP</th><th class="num">商店評分</th><th class="num">商店評論</th><th class="num">按讚</th><th class="num">留言</th><th class="num">內測回饋</th><th class="num">問題回饋</th></tr></thead><tbody>' +
      rows.slice(0, 12).map(r => '<tr class="is-click" tabindex="0" data-act="open-app" data-v="' + r.a.id + '"><td><div class="cell-app">' + appIco(r.a) + '<b>' + esc(r.a.short) + '</b></div></td><td class="num">' + (r.rating == null ? '—' : r.rating.toFixed(1)) + '</td><td class="num">' + (r.reviews == null ? '—' : V.fmtInt(r.reviews)) + '</td><td class="num">' + V.fmtInt(r.likes) + '</td><td class="num">' + V.fmtInt(r.comments) + '</td><td class="num">' + (r.beta ? V.fmtInt(r.beta.count) + (r.beta.rating != null ? '（平均 ' + r.beta.rating.toFixed(1) + '）' : '') : '—') + '</td><td class="num">' + (r.fb ? V.fmtInt(r.fb.count) : '—') + '</td></tr>').join('') + '</tbody></table></div>' : '<p class="empty">選取的 APP 還沒有評分或回饋。</p>') + '</section>';
  }

  // ---- APP 列表 ------------------------------------------------------------------
  const colOn = c => c.fixed || (S.cols[c.k] != null ? S.cols[c.k] : !c.off);
  function appsData() {
    const q = S.q.trim().toLowerCase(), ORDER = { crit: 0, warn: 1, ok: 2, live: 3, dev: 4 }, L = D.latest;
    const list = selApps().filter(a => (S.cat === 'all' || a.cat === S.cat) && (S.stage === 'all' || (S.stage === 'dev') === (a.stage === 'dev')) && (!q || (a.name + ' ' + a.short + ' ' + a.aliases + ' ' + a.id).toLowerCase().indexOf(q) >= 0));
    const wins = {};
    COLS.forEach(c => { if (c.m) wins[c.k] = win(c.k); });
    const rows = list.map(a => {
      const r = { a: a, state: D.appState(a) };
      COLS.forEach(c => { if (c.m) r[c.k] = D.hasData(c.k, a) ? D.total(c.k, [a], wins[c.k].from, wins[c.k].to) : null; });
      r.rating = (L.rating || {})[a.key] ? L.rating[a.key].value : null;
      r.likes = (L.likes || {})[a.key] != null ? L.likes[a.key] : null;
      const P = prevOf(wins.installs);
      r.d = D.hasData('installs', a) ? delta('installs', r.installs, prevTotal('installs', [a], P)) : null;
      return r;
    });
    const k = S.sort.key, dir = S.sort.dir;
    rows.sort((x, y) => {
      if (k === 'name') return dir * x.a.name.localeCompare(y.a.name, 'zh-Hant');
      if (k === 'state') return dir * (ORDER[x.state] - ORDER[y.state]);
      if (x[k] == null || y[k] == null) return (x[k] == null) - (y[k] == null);
      return dir * (x[k] - y[k]);
    });
    return { rows: rows, list: list, wins: wins };
  }
  function renderAppsTable() {
    const el = $('#apps-table');
    if (!el) return;
    const d = appsData(), cols = COLS.filter(colOn), RI = d.wins.installs, PI = prevOf(RI);
    const th = c => {
      const sortable = c.sort || c.m || c.x, on = S.sort.key === c.k;
      return '<th' + (c.m || c.x ? ' class="num"' : '') + (on ? ' aria-sort="' + (S.sort.dir > 0 ? 'ascending' : 'descending') + '"' : '') + (c.m ? ' data-tip="' + esc(M[c.k].note + '\n' + spanText(d.wins[c.k]) + '・' + endNote(c.k)) + '"' : '') + '>' + (sortable ? '<button type="button" class="th-b" data-act="sort" data-v="' + c.k + '">' + c.t + ico('down') + '</button>' : c.t) + '</th>';
    };
    const td = (c, r) => {
      const a = r.a;
      if (c.k === 'state') return '<td>' + pill(r.state) + '</td>';
      if (c.k === 'name') return '<td class="cell-name"><div class="cell-app">' + appIco(a) + '<div><b>' + esc(a.name) + '</b><span class="sub-link">' + esc(a.cat) + '</span></div></div></td>';
      if (c.k === 'plat') return '<td>' + a.platforms.map(p => '<span class="pl' + (p.public ? '' : ' is-off') + '" data-tip="' + esc(p.label + '\n' + (p.status || (p.public ? '已公開' : '尚未公開')) + (p.version ? '\n版本 ' + p.version : '')) + '">' + esc(p.label) + '</span>').join('') + '</td>';
      if (c.k === 'trend') return '<td><div class="cell-app">' + (D.hasData('installs', a) ? V.spark(D.appSeries(a, 'installs', RI.from, RI.step, RI.n), { cmp: S.compare && canCompare('installs', PI) ? D.appSeries(a, 'installs', PI.from, RI.step, RI.n) : null, w: 84 }) + deltaHtml('installs', r.d) : '<span class="muted">—</span>') + '</div></td>';
      if (c.k === 'rating') return '<td class="num">' + (r.rating == null ? '—' : r.rating.toFixed(1)) + '</td>';
      if (c.k === 'likes') return '<td class="num">' + (r.likes == null ? '—' : V.fmtInt(r.likes)) + '</td>';
      return '<td class="num">' + fv(c.k, r[c.k]) + '</td>';
    };
    const foot = c => (c.k === 'name' ? '<td>' + d.rows.length + ' 款的合計</td>' : c.m ? '<td class="num">' + fv(c.k, D.total(c.k, d.list, d.wins[c.k].from, d.wins[c.k].to)) + '</td>' : '<td></td>');
    el.innerHTML = d.rows.length ? '<div class="tbl-wrap"><table class="tbl"><thead><tr>' + cols.map(th).join('') + '</tr></thead><tbody>' + d.rows.map(r => '<tr class="is-click" tabindex="0" data-act="open-app" data-v="' + r.a.id + '">' + cols.map(c => td(c, r)).join('') + '</tr>').join('') + '</tbody><tfoot><tr>' + cols.map(foot).join('') + '</tr></tfoot></table></div>' : '<p class="empty">沒有符合條件的 APP。把搜尋字或篩選放寬一點試試。</p>';
    CH.apps = { csv: () => [cols.filter(c => c.k !== 'trend').map(c => c.t).join(',')].concat(d.rows.map(r => cols.filter(c => c.k !== 'trend').map(c => (c.k === 'state' ? STATE[r.state][0] : c.k === 'name' ? r.a.name : c.k === 'plat' ? r.a.platforms.map(p => p.label).join('/') : r[c.k] == null ? '' : Math.round(r[c.k] * 100) / 100)).join(','))).join('\n') };
  }
  function viewApps(el) {
    const r = RANGES.find(x => x[0] === S.range);
    el.innerHTML = head('APP', '一共 ' + D.APPS.length + ' 款。點欄位名稱排序，點一列看那一款的完整數據。') +
      '<section class="card"><div class="tb"><label class="field"><span class="sr-only">搜尋 APP</span>' + ico('search') + '<input type="search" id="apps-q" data-bind="q" placeholder="搜尋 APP 名稱" autocomplete="off" value="' + esc(S.q) + '"></label>' +
      '<label class="sr-only" for="apps-cat">類別</label><select class="sel" id="apps-cat" data-bind="cat"><option value="all">全部類別</option>' + D.CATS.map(c => '<option' + (S.cat === c ? ' selected' : '') + '>' + esc(c) + '</option>').join('') + '</select>' +
      '<label class="sr-only" for="apps-stage">階段</label><select class="sel" id="apps-stage" data-bind="stage"><option value="all">全部階段</option><option value="live"' + (S.stage === 'live' ? ' selected' : '') + '>已上架</option><option value="dev"' + (S.stage === 'dev' ? ' selected' : '') + '>開發中</option></select>' +
      '<div class="tb-r"><button type="button" class="btn" id="cols-btn" data-act="pop-cols" data-pop aria-haspopup="dialog">' + ico('cols') + '欄位</button>' + seg('density', S.density, [['cozy', '寬鬆'], ['compact', '緊湊']]) + '<button type="button" class="btn-ghost" data-act="copy-csv" data-v="apps">' + ico('copy') + '複製 CSV</button></div></div>' +
      '<p class="sub">' + (S.custom ? esc(win('intro').label) : r[2]) + '・每一欄的期間對齊到它最新的資料，游標移到欄位名稱上可以看・沒有數據的欄位留空，不補零・虛線框的平台還沒公開上架</p><div id="apps-table"></div></section>';
    renderAppsTable();
  }

  // ---- 單一 APP ------------------------------------------------------------------
  function platCardHtml(a) {
    const key = M[S.metric].plat ? S.metric : D.hasData('installs', a) ? 'installs' : 'clicks', def = M[key], R = win(key);
    const parts = D.PLATS.map((p, i) => ({ p: p, i: i, v: sumKnown(D.platSeries(key, [a], p[0], R.from, R.days, 1)) })).filter(x => x.v != null);
    const sum = parts.reduce((s, x) => s + x.v, 0);
    const body = parts.length && sum ? '<div class="segbar" role="img" aria-label="' + esc(parts.map(x => x.p[1] + ' ' + (x.v / sum * 100).toFixed(0) + '%').join('、')) + '">' + parts.map(x => '<i style="width:' + (x.v / sum * 100).toFixed(2) + '%;background:var(--s' + (x.i + 1) + ')"></i>').join('') + '</div><ul class="kv">' + parts.map(x => '<li><i class="sw" style="background:var(--s' + (x.i + 1) + ')"></i><span>' + x.p[1] + '</span><b>' + fv(key, x.v) + '</b><em>' + (x.v / sum * 100).toFixed(1) + '%</em></li>').join('') + '</ul>' : '<p class="empty">這段期間沒有可以拆平台的數字。</p>';
    return '<section class="card c-4">' + cardHead('平台分布', esc(def.name) + '・' + spanText(R)) + body + '</section>';
  }
  // 每款 APP 自己的後台回報的數字：有接上的才有
  function backendHtml(a) {
    const e = D.eclaw, workers = D.ops.workers.filter(w => w.app === a.key);
    let cells = '', sub = '', extra = '';
    if (a.key === 'eclawbot') {
      const u = e.users, dv = e.devices;
      sub = '帳號、裝置與今天的用量';
      cells = (u ? dmCell('帳號', num(u.total) + ' 個') + dmCell('已驗證信箱', num(u.verified) + ' 個') + dmCell('付費訂閱', num(u.premium) + ' 個') : '') +
        (dv ? dmCell('裝置', num(dv.total) + ' 台', '不含測試裝置') + dmCell('實體', num(dv.entities) + ' 個') + dmCell('已綁定的實體', num(dv.boundEntities) + ' 個') : '') +
        dmCell('今日訊息', num(D.todayValue('eclawMessages', a.key)) + ' 則', '今天還沒過完') + dmCell('今日活躍裝置', num(D.todayValue('eclawActiveDevices', a.key)) + ' 台', '今天還沒過完') + dmCell('今日新註冊', num(D.todayValue('eclawSignups', a.key)) + ' 個', '今天還沒過完');
    } else if (a.key === D.WISHLIST) {
      sub = '上架與公開的最新數字';
      cells = listingCells();
    } else if (a.key === 'dreambuddy' && D.RAW.dreamTurns) {
      const R = win('messages'), t = p => D.rawSum(p, a.key, R.from, R.to);
      sub = spanText(R) + ' 的對話與廣告';
      cells = dmCell('對話回合', num(t('dreamTurns')) + ' 次') + dmCell('成功回覆', num(t('dreamCompleted')) + ' 次') + dmCell('回覆失敗', num(t('dreamFailed')) + ' 次') + dmCell('廣告獎勵', num(t('dreamAds')) + ' 次', '看完廣告換到額度的次數') + dmCell('今日對話回合', num(D.todayValue('dreamTurns', a.key)) + ' 次', '今天還沒過完');
    } else if (a.key === 'com.hankhuang.fraudempire' && (D.latest.feedback || {})[a.key]) {
      const f = D.latest.feedback[a.key];
      sub = 'APP 內送出的問題回饋';
      cells = dmCell('累計回饋', num(f.count) + ' 件') + dmCell('近 30 天', num(f.recent) + ' 件') + dmCell('最近一件', f.latestAt ? V.fAgo(Date.now() - f.latestAt) : '—');
    }
    const facts = D.facts(a);
    if (facts.length) {
      if (!sub) sub = '後台自己記錄的目前數字';
      cells += facts.map(f => dmCell(f.label, (typeof f.value === 'number' ? V.fmtInt(f.value) : String(f.value)) + (f.unit ? ' ' + f.unit : ''), f.observedAt ? '收集於 ' + V.fStamp(f.observedAt) : '')).join('');
    }
    const svcs = D.serviceFor(a);
    if (svcs.length) extra += serviceTableHtml(svcs, '這款 APP 的後台服務', '每分鐘檢查一次');
    if (workers.length) extra += workerTableHtml(workers, '這款 APP 的 AI worker', '每分鐘檢查一次');
    if (!cells && !extra) return '<section class="card">' + cardHead('後台數據') + '<p class="empty">' + (a.stage === 'dev' ? '這款還沒有接上後台數據。' : '這款 APP 的後台還沒有接進管理中樞，目前只有商店與作品集的數據。可以到「資料來源」看還缺哪些。') + '</p></section>';
    return (cells ? '<section class="card">' + cardHead('後台數據', sub) + '<div class="dm"' + (a.key === D.WISHLIST ? ' id="lv-listing"' : '') + '>' + cells + '</div></section>' : '') + extra;
  }
  function appFreshHtml(a, keys) {
    return '<section class="card c-5">' + cardHead('這款 APP 有哪些數據', '每一項資料到哪一天') + '<ol class="feed">' + keys.map(k => '<li><span class="feed-k">' + esc(M[k].group) + '</span><span class="feed-t"><b>' + esc(M[k].name) + '</b>　' + esc(M[k].note) + '</span><time class="muted">' + esc(endNote(k, true)) + '</time></li>').join('') + (keys.length ? '' : '<li class="empty">這款 APP 目前沒有任何數據來源。</li>') + '</ol></section>';
  }
  function viewApp(el) {
    const a = D.APP[S.app], list = [a], idx = D.APPS.indexOf(a), n = D.APPS.length, keys = D.metricsFor(a);
    const prev = D.APPS[(idx + n - 1) % n], next = D.APPS[(idx + 1) % n], L = a.links;
    if (keys.indexOf(S.metric) < 0) S.metric = keys[0] || 'installs';
    const links = [['guide', '介紹頁'], ['official', '官方網站'], ['itch', 'itch.io'], ['release', '下載頁'], ['project', '專案頁']].filter(x => L[x[0]]).map(x => '<a class="pl" href="' + esc(L[x[0]]) + '" target="_blank" rel="noopener">' + x[1] + ico('ext') + '</a>').join('');
    el.innerHTML = '<nav class="crumb" aria-label="目前位置"><a href="#apps">' + ico('back') + 'APP</a><span>／</span><b>' + esc(a.name) + '</b><span class="crumb-n"><a href="#app-' + prev.id + '" title="上一款（快速鍵 [）">' + ico('back') + esc(prev.short) + '</a><a href="#app-' + next.id + '" title="下一款（快速鍵 ]）">' + esc(next.short) + ico('next') + '</a></span></nav>' +
      '<header class="ah">' + appIco(a, 'lg') + '<div class="ah-t"><h1>' + esc(a.name) + '</h1><p>' + esc(a.cat) + (a.desc ? '・' + esc(a.desc) : '') + '</p><div class="pls">' + a.platforms.map(p => {
        const label = esc(p.label) + (p.status ? '・' + esc(p.status) : '') + (p.version ? '・' + esc(p.version) : '');
        return p.url && p.public ? '<a class="pl" href="' + esc(p.url) + '" target="_blank" rel="noopener">' + label + ico('ext') + '</a>' : '<span class="pl' + (p.public ? '' : ' is-off') + '">' + label + '</span>';
      }).join('') + links + '</div></div>' + pill(D.appState(a)) + '</header>' +
      (a.stage === 'dev' ? '<p class="note">' + ico('info') + '這款還沒有公開上架，商店相關的指標會是空的。</p>' : '') +
      (keys.length ? tilesHtml(APP_TILE_ORDER.filter(k => keys.indexOf(k) >= 0).slice(0, 6), list) + '<div class="grid">' + explorerHtml('c-8', keys, true) + platCardHtml(a) + '</div>' : '<p class="note">' + ico('info') + '這款 APP 目前沒有任何數據來源。</p>') +
      backendHtml(a) + retentionHtml(a, '') + '<div class="grid">' + feedbackCardHtml(list, 'c-7') + appFreshHtml(a, keys) + '</div>';
    if (keys.length) { mountTiles(el, list); mountExplorer(el, list); }
    liveHooks.push(paintLiveNumbers);
  }

  // ---- 警示 ----------------------------------------------------------------------
  function alertHtml(a) {
    const app = D.BYKEY[a.app || (a.apps || [])[0]] || null, acked = isAcked(a);
    return '<article class="al al-' + (acked ? 'acked' : 'firing') + '"><div class="al-m">' + pill(a.sev, SEV[a.sev]) + '<div class="al-t"><h3>' + esc(a.title) + '</h3><p>' + esc(a.detail) + '</p></div></div>' +
      '<div class="al-w"><span class="al-s as-' + (acked ? 'acked' : 'firing') + '">' + (acked ? '已確認' : '觸發中') + '</span><span class="muted">規則：' + esc(a.rule) + '</span>' + (a.since ? '<span class="muted">開始於 <span data-ago="' + a.since + '"></span></span>' : '') + '</div><div class="al-a">' +
      (acked ? '<button type="button" class="btn" data-act="al-unack" data-v="' + esc(a.id) + '">取消確認</button>' : '<button type="button" class="btn is-primary" data-act="al-ack" data-v="' + esc(a.id) + '">確認，我知道了</button>') +
      (a.go ? '<a class="btn" href="#' + a.go + '">' + (a.go === 'live' ? '看即時監控' : '看資料來源') + '</a>' : '') + (app ? '<a class="btn" href="#app-' + app.id + '">開啟 ' + esc(app.short) + '</a>' : '') + '</div></article>';
  }
  function viewAlerts(el) {
    const all = D.ALERTS, cnt = { all: all.length, firing: all.filter(a => !isAcked(a)).length };
    cnt.acked = cnt.all - cnt.firing;
    const list = all.filter(a => S.alertFilter === 'all' || (S.alertFilter === 'acked') === isAcked(a));
    el.innerHTML = head('警示', '由目前的數字算出來：條件成立就出現，解除就消失。「確認」只記在這個瀏覽器，代表我看過了。', seg('al-filter', S.alertFilter, [['all', '全部 ' + cnt.all], ['firing', '觸發中 ' + cnt.firing], ['acked', '已確認 ' + cnt.acked]])) +
      '<section class="card"><div class="al-list">' + (list.length ? list.map(alertHtml).join('') : '<p class="empty">' + (all.length ? '這個分類目前沒有警示。' : '目前沒有任何警示，所有檢查都通過。') + '</p>') + '</div></section>' +
      '<section class="card">' + cardHead('檢查的規則', '這一版的規則是固定的，還不能在這裡調整') + '<div class="tbl-wrap"><table class="tbl is-wrap"><thead><tr><th>規則</th><th>範圍</th><th>條件</th><th>等級</th></tr></thead><tbody>' +
      D.RULES.map(r => '<tr><td><b>' + esc(r[0]) + '</b></td><td>' + esc(r[1]) + '</td><td>' + esc(r[2]) + '</td><td>' + pill(r[3], SEV[r[3]]) + '</td></tr>').join('') + '</tbody></table></div></section>';
  }

  // ---- 資料來源 ------------------------------------------------------------------
  function viewSources(el) {
    const READY = { ok: ['ok', '已接上'], warn: ['warn', '沒更新'], crit: ['crit', '讀不到'], none: ['none', '還沒接'] }, st = D.sources.store || {};
    el.innerHTML = head('資料來源', '畫面上每一個數字的來處。標「還沒接」的是這一版沒有的數據，畫面上不會出現猜測或補上的數字。') +
      '<section class="card"><div class="tbl-wrap"><table class="tbl is-wrap"><thead><tr><th>來源</th><th>提供的數據</th><th>涵蓋的 APP</th><th>更新頻率</th><th>最後更新</th><th>狀態</th><th>說明</th></tr></thead><tbody>' +
      D.sourceRows().map(s => '<tr><td><b>' + esc(s.name) + '</b></td><td>' + esc(s.gives) + '</td><td>' + esc(s.cover) + '</td><td>' + esc(s.freq) + '</td><td class="muted">' + (s.last ? '<span data-ago="' + s.last + '"></span>' : '—') + '</td><td>' + pill(READY[s.state][0], READY[s.state][1]) + '</td><td class="muted">' + esc(s.note) + '</td></tr>').join('') + '</tbody></table></div>' +
      '<p class="hint">' + ico('info') + '<span>商店報表和公開的「APP 趨勢」頁是同一份；營運數據和公開的「營運數據」頁是同一份。其餘的數字只有登入的管理者讀得到。' + (st.ok && st.unallocatedRevenue ? '另有 NT$' + esc(V.fmt('fix2', st.unallocatedRevenue)) + ' 的舊廣告收入對不到任何一款 APP，沒有算進各 APP 的數字。' : '') + '</span></p></section>';
  }

  // ---- 繪製 ----------------------------------------------------------------------
  const VIEW = { overview: viewOverview, live: viewLive, kpi: viewKpi, apps: viewApps, app: viewApp, alerts: viewAlerts, sources: viewSources };
  function focusKey() {
    const a = document.activeElement;
    if (!a || !(a.closest('#view') || a.closest('#filters'))) return null;
    if (a.id) return '#' + a.id;
    if (a.dataset && a.dataset.act) return '[data-act="' + a.dataset.act + '"]' + (a.dataset.v != null ? '[data-v="' + a.dataset.v + '"]' : '');
    return null;
  }
  function render(soft) {
    const el = $('#view'), fk = focusKey();
    const go = () => {
      V.destroyAll();
      liveHooks.length = 0;
      liveSeq++;
      Object.keys(CH).forEach(k => delete CH[k]);
      syncChrome();
      el.classList.remove('is-stale');
      VIEW[S.view](el);
      tickAgo();
      if (fk) { const f = $(fk); if (f) f.focus({ preventScroll: true }); }
    };
    clearTimeout(render.t);
    if (soft) { el.classList.add('is-stale'); render.t = setTimeout(go, 130); } else go();
  }
  function tickAgo() {
    const t = Date.now();
    $$('[data-ago]').forEach(el => { el.textContent = V.fAgo(t - +el.dataset.ago); });
  }
  // 讀到新的營運數據：只更新會變的數字，不重畫整頁
  function liveTick() {
    pruneAcks();
    $('#nav').innerHTML = navHtml();
    $('#side-apps').innerHTML = sideAppsHtml();
    liveHooks.forEach(fn => fn());
    tickAgo();
  }
  const idle = () => Date.now() - lastInput > 20000 && $('#overlay').hidden && $('#pop').hidden && !$('.tc.is-pinned');

  // ---- 狀態變更 ------------------------------------------------------------------
  function setRange(v) { S.range = v; S.custom = null; store.set('range', v); closePop(); render(true); }
  function setCustom(a, b) {
    const from = D.idxOf(a), to = D.idxOf(b - 1) + 1;
    if (to - from < 3) { toast('最少選 3 天'); return; }
    S.custom = { from: from, to: to };
    render(true);
  }
  function setCompare(v) { S.compare = v; store.set('compare', v); render(true); }
  function toggleLive() {
    S.live = !S.live;
    syncLiveUi();
    toast(S.live ? '繼續自動更新' : '已暫停自動更新，畫面停在現在的數字');
    if (S.live) refreshLive();
  }
  function clearFilters() { S.apps.clear(); S.custom = null; render(true); }
  const isDark = () => { const t = document.documentElement.getAttribute('data-theme'); return t ? t === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches; };
  function applyTheme() {
    if (S.theme !== 'auto') document.documentElement.setAttribute('data-theme', S.theme);
    $('#theme-ico').setAttribute('href', isDark() ? '#i-sun' : '#i-moon');
  }
  function toggleTheme() { S.theme = isDark() ? 'light' : 'dark'; store.set('theme', S.theme); applyTheme(); }
  function go(name) { if (location.hash === '#' + name) { parseHash(); render(); } else location.hash = name; }
  function parseHash() {
    const h = (location.hash || '').replace(/^#/, '');
    if (h.indexOf('app-') === 0 && D.APP[h.slice(4)]) { S.view = 'app'; S.app = h.slice(4); } else if (VIEWS.some(v => v[0] === h)) { S.view = h; S.app = null; } else { S.view = 'overview'; S.app = null; }
  }

  // ---- 浮層：選單、搜尋、說明 ---------------------------------------------------
  function openPop(anchor, html, focus) {
    const p = $('#pop');
    if (!p.hidden && p.dataset.owner === anchor.id) { closePop(); return; }
    p.innerHTML = html;
    p.dataset.owner = anchor.id;
    p.hidden = false;
    const r = anchor.getBoundingClientRect(), vw = document.documentElement.clientWidth;
    p.style.maxHeight = Math.max(180, window.innerHeight - r.bottom - 16) + 'px';
    p.style.left = Math.max(8, Math.min(r.left, vw - p.offsetWidth - 8)) + 'px';
    p.style.top = r.bottom + 6 + 'px';
    if (focus) { const f = p.querySelector('input'); if (f) f.focus(); }
  }
  function closePop() { const p = $('#pop'); if (p.hidden) return false; p.hidden = true; p.innerHTML = ''; p.dataset.owner = ''; return true; }
  let lastFocus = null;
  function openOverlay(html) {
    const o = $('#overlay');
    lastFocus = document.activeElement;
    closePop();
    o.innerHTML = html;
    o.hidden = false;
    const f = o.querySelector('input,button');
    if (f) f.focus();
  }
  function closeOverlay() {
    const o = $('#overlay');
    if (o.hidden) return false;
    o.hidden = true;
    o.innerHTML = '';
    if (lastFocus && document.contains(lastFocus)) lastFocus.focus({ preventScroll: true });
    return true;
  }
  const PAL = { items: [], shown: [], idx: 0 };
  function paletteItems() {
    const items = [];
    VIEWS.forEach(v => items.push({ g: '前往', t: v[1], k: v[0], ic: v[0], run: () => go(v[0]) }));
    D.APPS.forEach(a => items.push({ g: 'APP', t: a.name, k: a.id + ' ' + a.short + ' ' + a.aliases + ' ' + a.cat, app: a, hint: a.cat, run: () => go('app-' + a.id) }));
    Object.keys(M).filter(D.anyData).forEach(k => items.push({ g: '指標', t: '在總覽看「' + M[k].name + '」', k: k + ' ' + M[k].note, ic: 'kpi', run: () => { S.metric = k; S.breakdown = 'total'; go('overview'); } }));
    RANGES.forEach((r, i) => items.push({ g: '操作', t: '時間範圍：' + r[2], k: 'range ' + r[0], ic: 'cal', hint: String(i + 1), run: () => setRange(r[0]) }));
    items.push({ g: '操作', t: isDark() ? '切換成淺色' : '切換成深色', k: 'theme dark light 主題 深色 淺色', ic: isDark() ? 'sun' : 'moon', hint: 't', run: toggleTheme });
    items.push({ g: '操作', t: S.compare ? '關閉「對比前一期」' : '開啟「對比前一期」', k: 'compare 比較', ic: 'flat', hint: 'c', run: () => setCompare(!S.compare) });
    items.push({ g: '操作', t: S.live ? '暫停自動更新' : '繼續自動更新', k: 'pause live 即時 自動', ic: S.live ? 'pause' : 'play', hint: 'p', run: toggleLive });
    items.push({ g: '操作', t: '現在就重新讀取資料', k: 'refresh reload 重新整理 更新', ic: 'live', hint: 'r', run: refreshAll });
    items.push({ g: '操作', t: '清除所有篩選', k: 'clear reset filter 篩選', ic: 'x', run: clearFilters });
    items.push({ g: '操作', t: '顯示鍵盤快速鍵', k: 'help shortcut keyboard 快速鍵', ic: 'key', hint: '?', run: openHelp });
    items.push({ g: '操作', t: '回到公開的 APP 作品集', k: 'portfolio 作品集 首頁', ic: 'ext', run: () => { location.href = '/AiHankApps/'; } });
    items.forEach(it => { it.s = (it.t + ' ' + it.k).toLowerCase(); });
    return items;
  }
  function palRender(q) {
    const toks = q.trim().toLowerCase().split(/\s+/).filter(Boolean), el = $('#pal-list');
    let list = PAL.items.filter(it => toks.every(t => it.s.indexOf(t) >= 0));
    if (toks.length) { const rk = it => { const p = it.t.toLowerCase().indexOf(toks[0]); return p === 0 ? 0 : p > 0 ? 1 : 2; }; list = list.map((it, i) => [rk(it), i, it]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map(x => x[2]); }
    PAL.shown = list.slice(0, 40);
    PAL.idx = 0;
    if (!PAL.shown.length) { el.innerHTML = '<p class="empty">找不到符合的項目。試試 APP 名稱，或「安裝」「收入」這類指標。</p>'; return; }
    let g = null, h = '';
    PAL.shown.forEach((it, i) => {
      if (!toks.length && it.g !== g) { g = it.g; h += '<div class="pal-g">' + g + '</div>'; }
      h += '<div class="pal-i' + (i === 0 ? ' is-on' : '') + '" role="option" aria-selected="' + (i === 0) + '" data-act="pal-run" data-v="' + i + '">' + (it.app ? appIco(it.app) : ico(it.ic || 'next')) + '<span>' + esc(it.t) + '</span><em>' + (it.hint && it.g === '操作' ? '<kbd>' + esc(it.hint) + '</kbd>' : esc(toks.length ? it.g : it.hint || '')) + '</em></div>';
    });
    el.innerHTML = h;
  }
  function palMove(d) {
    const n = PAL.shown.length;
    if (!n) return;
    PAL.idx = (PAL.idx + d + n) % n;
    $$('.pal-i').forEach((el, i) => { el.classList.toggle('is-on', i === PAL.idx); el.setAttribute('aria-selected', String(i === PAL.idx)); if (i === PAL.idx) el.scrollIntoView({ block: 'nearest' }); });
  }
  function palRun(i) { const it = PAL.shown[i]; if (!it) return; closeOverlay(); it.run(); }
  function openPalette() {
    PAL.items = paletteItems();
    openOverlay('<div class="pal" role="dialog" aria-modal="true" aria-label="搜尋與指令"><div class="pal-in">' + ico('search') + '<input type="text" id="pal-q" data-bind="pal-q" placeholder="輸入 APP 名稱、指標或功能" autocomplete="off" spellcheck="false" aria-label="搜尋 APP、指標、功能"></div><div class="pal-list" id="pal-list" role="listbox" aria-label="結果"></div><div class="pal-foot"><span><kbd>↑</kbd> <kbd>↓</kbd> 選擇</span><span><kbd>Enter</kbd> 執行</span><span><kbd>Esc</kbd> 關閉</span></div></div>');
    palRender('');
  }
  function openHelp() {
    const rows = [
      ['<kbd>' + MOD + '</kbd> <kbd>K</kbd> 或 <kbd>/</kbd>', '搜尋 APP、指標、功能'],
      ['<kbd>g</kbd> 再按 <kbd>o</kbd> <kbd>l</kbd> <kbd>k</kbd> <kbd>a</kbd> <kbd>w</kbd> <kbd>s</kbd>', '前往總覽、即時監控、績效指標、APP、警示、資料來源'],
      ['<kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> <kbd>4</kbd>', '時間範圍：7 天、30 天、90 天、1 年'],
      ['<kbd>c</kbd>', '開關「對比前一期」'], ['<kbd>p</kbd>', '暫停或繼續自動更新'], ['<kbd>r</kbd>', '現在就重新讀取資料'], ['<kbd>t</kbd>', '切換深色與淺色'],
      ['<kbd>[</kbd> <kbd>]</kbd>', '在 APP 頁面換上一款、下一款'],
      ['<kbd>←</kbd> <kbd>→</kbd>', '圖表取得焦點後逐格移動游標；<kbd>Enter</kbd> 釘住，<kbd>Esc</kbd> 取消'],
      ['拖曳', '在走勢圖上選一段時間放大']
    ];
    openOverlay('<div class="pal help" role="dialog" aria-modal="true" aria-label="鍵盤快速鍵"><h2>鍵盤快速鍵</h2><dl>' + rows.map(r => '<dt>' + r[0] + '</dt><dd>' + r[1] + '</dd>').join('') + '</dl><div><button type="button" class="btn" data-act="overlay-close">關閉</button></div></div>');
  }

  // ---- 事件 ----------------------------------------------------------------------
  const soft = fn => v => { fn(v); render(true); };
  const ACT = {
    'palette': openPalette, 'help': openHelp, 'theme': toggleTheme, 'live-toggle': toggleLive, 'overlay-close': closeOverlay, 'pop-close': closePop, 'retry': () => boot(),
    'admin-info': (v, el) => openPop(el, '<div class="menu"><h3>只有管理者看得到</h3><p>這一頁和它讀的數字，都要用 EClaw 的管理者帳號登入才打得開；公開的作品集上，沒登入的人看不到入口。</p><p class="muted">數字是每次開啟時從後台讀出來的，不會存成檔案。</p><div class="menu-foot"><a class="btn-ghost" href="/AiHankApps/">回到作品集</a><a class="btn-ghost" href="/portal/dashboard.html">EClaw 控制台</a></div></div>'),
    'pop-range': (v, el) => openPop(el, '<div class="menu" role="listbox" aria-label="時間範圍">' + RANGES.map((r, i) => '<button type="button" class="menu-row" role="option" aria-selected="' + (!S.custom && S.range === r[0]) + '" data-act="set-range" data-v="' + r[0] + '">' + ico('check', 'ck') + '<span>' + r[2] + '</span><em><kbd>' + (i + 1) + '</kbd></em></button>').join('') + '<div class="menu-foot">自訂範圍：在任何一張走勢圖上拖曳選取</div></div>'),
    'pop-apps': (v, el) => openPop(el, '<div class="menu"><label class="field"><span class="sr-only">搜尋 APP</span>' + ico('search') + '<input type="search" id="f-apps-q" data-bind="apps-q" placeholder="搜尋 APP" autocomplete="off"></label><div class="menu-cats">' + D.CATS.map(c => '<button type="button" data-act="cat-pick" data-v="' + esc(c) + '">' + esc(c) + '</button>').join('') + '</div><div class="menu-list">' +
      D.APPS.map(a => '<label class="menu-row" data-k="' + esc((a.name + ' ' + a.short + ' ' + a.aliases + ' ' + a.cat).toLowerCase()) + '"><input type="checkbox" id="fa-' + a.id + '" data-bind="app-check" value="' + a.id + '"' + (S.apps.has(a.id) ? ' checked' : '') + '>' + appIco(a) + '<span>' + esc(a.short) + '</span><em>' + esc(a.cat) + '</em></label>').join('') + '</div><div class="menu-foot"><button type="button" class="btn-ghost" data-act="apps-all">改回全部 APP</button><button type="button" class="btn is-primary" data-act="pop-close">完成</button></div></div>', true),
    'pop-cols': (v, el) => openPop(el, '<div class="menu"><h3>顯示的欄位</h3>' + COLS.filter(c => !c.fixed).map(c => '<label class="menu-row"><input type="checkbox" id="col-' + c.k + '" data-bind="col" value="' + c.k + '"' + (colOn(c) ? ' checked' : '') + '><span>' + c.t + '</span></label>').join('') + '</div>'),
    'set-range': setRange,
    'clear-custom': soft(() => { S.custom = null; }),
    'clear-filters': clearFilters,
    'remove-app': soft(v => { S.apps.delete(v); }),
    'toggle-app': soft(v => { if (S.apps.has(v)) S.apps.delete(v); else S.apps.add(v); V.tipHide(); }),
    'apps-all': () => { S.apps.clear(); $$('#pop [data-bind="app-check"]').forEach(c => { c.checked = false; }); render(true); },
    'cat-pick': v => { S.apps = new Set(D.APPS.filter(a => a.cat === v).map(a => a.id)); $$('#pop [data-bind="app-check"]').forEach(c => { c.checked = S.apps.has(c.value); }); render(true); },
    'pick-metric': soft(v => { S.metric = v; }),
    'breakdown': soft(v => { S.breakdown = v; }),
    'ex-view': soft(v => { S.exView = v; }),
    'rank-all': soft(() => { S.rankAll = !S.rankAll; }),
    'sm-scale': soft(v => { S.smScale = v; }),
    'copy-csv': v => { const c = CH[v]; if (c) copyText(c.csv ? c.csv() : V.csv(c.cfg), '已複製 CSV，可以直接貼到試算表'); else toast('這張圖目前沒有資料可以複製'); },
    'win': v => { S.win = v; store.set('win', v); render(); },
    'pick-kpi': soft(v => { S.kpi = v; }),
    'kpi-view': soft(v => { S.kpiView = v; }),
    'rev-view': soft(v => { S.revView = v; }),
    'sort': v => { const c = COLS.find(x => x.k === v); S.sort = S.sort.key === v ? { key: v, dir: -S.sort.dir } : { key: v, dir: c.m || c.x ? -1 : 1 }; renderAppsTable(); const b = $('[data-act="sort"][data-v="' + v + '"]'); if (b) b.focus(); },
    'density': v => { S.density = v; store.set('density', v); document.documentElement.setAttribute('data-density', v); $$('[data-act="density"]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === v))); },
    'open-app': v => go('app-' + v),
    'al-filter': v => { S.alertFilter = v; render(); },
    'al-ack': v => { S.acks[v] = Date.now(); store.set('acks', S.acks); render(); },
    'al-unack': v => { delete S.acks[v]; store.set('acks', S.acks); render(); },
    'pal-run': v => palRun(+v)
  };
  document.addEventListener('click', e => {
    if (e.target.closest('[data-stop]')) return;
    const el = e.target.closest('[data-act]');
    if (el && ACT[el.dataset.act]) ACT[el.dataset.act](el.dataset.v, el, e);
  });
  document.addEventListener('pointerdown', e => {
    lastInput = Date.now();
    if (!e.target.closest('#pop') && !e.target.closest('[data-pop]')) closePop();
    if (e.target.id === 'overlay') closeOverlay();
  });
  const BIND = {
    'metric': el => { S.metric = el.value; render(true); },
    'ret-app': el => { S.retApp = el.value; render(true); },
    'compare': el => setCompare(el.checked),
    'q': el => { S.q = el.value; renderAppsTable(); },
    'cat': el => { S.cat = el.value; renderAppsTable(); },
    'stage': el => { S.stage = el.value; renderAppsTable(); },
    'col': el => { S.cols[el.value] = el.checked; store.set('cols', S.cols); renderAppsTable(); },
    'app-check': el => { if (el.checked) S.apps.add(el.value); else S.apps.delete(el.value); render(true); },
    'apps-q': el => { const q = el.value.trim().toLowerCase(); $$('#pop .menu-row[data-k]').forEach(r => { r.hidden = !!q && r.dataset.k.indexOf(q) < 0; }); },
    'pal-q': el => palRender(el.value)
  };
  const onBind = e => { const el = e.target.closest('[data-bind]'); if (!el) return; const fn = BIND[el.dataset.bind]; if (!fn) return; const text = el.type === 'search' || el.type === 'text'; if ((e.type === 'input') === text) fn(el); };
  document.addEventListener('input', onBind);
  document.addEventListener('change', onBind);

  let tipOwner = null;
  const showTipFor = t => { tipOwner = t; V.tipLines(t.dataset.tip.split('\n'), t.getBoundingClientRect()); };
  document.addEventListener('pointerover', e => { const t = e.target.closest && e.target.closest('[data-tip]'); if (t && t !== tipOwner) showTipFor(t); });
  document.addEventListener('pointerout', e => { if (tipOwner && !(e.relatedTarget && tipOwner.contains(e.relatedTarget))) { V.tipHide(); tipOwner = null; } });
  document.addEventListener('focusin', e => { const t = e.target.closest && e.target.closest('[data-tip]'); if (t && t.matches(':focus-visible')) showTipFor(t); });
  document.addEventListener('focusout', () => { if (tipOwner) { V.tipHide(); tipOwner = null; } });

  let gWait = 0, started = false;
  document.addEventListener('keydown', e => {
    lastInput = Date.now();
    if (!started) return;
    const t = e.target, tag = (t.tagName || '').toLowerCase(), typing = tag === 'input' || tag === 'select' || tag === 'textarea';
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); if (!closeOverlay()) openPalette(); return; }
    if (e.key === 'Escape') { if (closeOverlay() || closePop()) return; V.unpinAll(); return; }
    if (t.id === 'pal-q') {
      if (e.key === 'ArrowDown') { e.preventDefault(); palMove(1); } else if (e.key === 'ArrowUp') { e.preventDefault(); palMove(-1); } else if (e.key === 'Enter') { e.preventDefault(); palRun(PAL.idx); }
      return;
    }
    if ((e.key === 'Enter' || e.key === ' ') && t.dataset && t.dataset.act && tag !== 'button' && tag !== 'a' && !typing) { e.preventDefault(); t.click(); return; }
    if (typing || e.metaKey || e.ctrlKey || e.altKey || !$('#overlay').hidden) return;
    if (Date.now() < gWait) {
      gWait = 0;
      const to = { o: 'overview', l: 'live', k: 'kpi', a: 'apps', w: 'alerts', s: 'sources' }[e.key];
      if (to) { e.preventDefault(); go(to); }
      return;
    }
    switch (e.key) {
      case '/': e.preventDefault(); openPalette(); break;
      case 'g': gWait = Date.now() + 1200; break;
      case '?': openHelp(); break;
      case 't': toggleTheme(); break;
      case 'c': setCompare(!S.compare); break;
      case 'p': toggleLive(); break;
      case 'r': refreshAll(); break;
      case '1': case '2': case '3': case '4': setRange(RANGES[+e.key - 1][0]); break;
      case '[': case ']':
        if (S.view === 'app') { const n = D.APPS.length, i = D.APPS.indexOf(D.APP[S.app]); go('app-' + D.APPS[(i + (e.key === ']' ? 1 : n - 1)) % n].id); }
        break;
    }
  });
  window.addEventListener('hashchange', () => { if (!started) return; parseHash(); closePop(); closeOverlay(); render(); window.scrollTo(0, 0); });
  window.addEventListener('resize', closePop);
  window.addEventListener('scroll', () => { lastInput = Date.now(); }, { passive: true });
  if (window.matchMedia) { const mq = window.matchMedia('(prefers-color-scheme: dark)'); if (mq.addEventListener) mq.addEventListener('change', applyTheme); }
  if (window.MutationObserver) new MutationObserver(() => { $('#theme-ico').setAttribute('href', isDark() ? '#i-sun' : '#i-moon'); }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  // ---- 讀取與自動更新 --------------------------------------------------------------
  // 登入過期或權限被收回：不留著舊數字，直接說明並給登入的連結
  function stop(error) {
    started = false;
    V.destroyAll();
    $('#filters').hidden = true;
    $('#nav').innerHTML = '';
    $('#side-apps').innerHTML = '';
    const st = error && error.status;
    $('#view').innerHTML = '<section class="card boot">' + (st === 401 ? '<h1>登入已經過期</h1><p>請重新登入 EClaw 的管理者帳號，登入後會回到這一頁。</p><p><a class="btn is-primary" href="' + LOGIN + '">重新登入</a></p>'
      : st === 403 ? '<h1>這個帳號沒有管理者權限</h1><p>管理中樞只開放給 EClaw 管理者。</p><p><a class="btn" href="/AiHankApps/">回到 APP 作品集</a></p>'
        : '<h1>資料暫時讀不到</h1><p>後台沒有回應，可能正在重新啟動。稍等一下再試。</p><p><button type="button" class="btn is-primary" data-act="retry">再試一次</button></p>') + '</section>';
  }
  async function refreshLive() {
    if (!started) return;
    await D.refreshLive();
    liveTick();
  }
  let refreshing = false;
  async function refreshData(force) {
    if (!started || refreshing) return;
    refreshing = true;
    try {
      await D.refreshData(!!force);
      if (force || idle()) render(true); else liveTick();
    } catch (error) {
      if (error.status === 401 || error.status === 403) stop(error); else if (force) toast('重新讀取失敗，畫面上是上一次的數字');
    } finally { refreshing = false; }
  }
  function refreshAll() { toast('重新讀取資料…'); refreshData(true); }
  setInterval(() => { if (S.live && !document.hidden) refreshLive().catch(() => {}); }, 60000);
  setInterval(() => { if (S.live && !document.hidden) refreshData(false); }, 5 * 60000);
  setInterval(tickAgo, 30000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && started && S.live && Date.now() - D.ops.at > 90000) refreshLive().catch(() => {}); });

  async function boot() {
    $('#view').innerHTML = '<section class="card boot" aria-busy="true"><h1>正在讀取各個後台的數字…</h1><p>商店報表、作品集流量、EClaw 主站與營運數據。</p></section>';
    try {
      await D.load();
    } catch (error) { stop(error); return; }
    started = true;
    pruneAcks();
    parseHash();
    render();
  }
  document.documentElement.setAttribute('data-density', S.density);
  $('#kbd-hint').textContent = MOD === '⌘' ? '⌘K' : 'Ctrl K';
  applyTheme();
  boot();
})();
