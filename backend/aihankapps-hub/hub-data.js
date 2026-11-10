/* global window */
/* AiHankApps 管理中樞：資料層。
   數字只有兩個來處：管理者 API /api/aihankapps/hub/data（商店報表、作品集流量、EClaw 主站、夢話夥伴後台的每日彙總），
   以及公開的 /api/aihankapps/ops（AI worker 與 Wishlist 營運數據）。這裡不產生任何數字：
   來源不知道的日子是 null，畫面留空；即時計數器有涵蓋但沒有紀錄的日子才是 0。
   日期一律以台北時間的「日」為單位，用「自 1970-01-01 起第幾天」的整數表示。 */
(function (global) {
  'use strict';

  const MIN = 60000, HOUR = 3600000, DAY = 86400000, TZ = 8 * HOUR;
  const API = '/api/aihankapps/hub', OPS = '/api/aihankapps/ops';
  const CAT_ORDER = ['遊戲', '工具', '社交', '生活', 'AI', '金融', '公益'];
  const PLATS = [['android', 'Android'], ['ios', 'iOS']];
  // 兩款「活字戰」的名字前半段幾乎一樣，簡稱取後半段才分得出來
  const SHORT = { 'typeforge-twin-cities': '雙城烽火', 'summit-battle': '巔峰之戰' };
  const STORE_PARTS = { googleInstalls: 1, appleDownloads: 1, admobRevenue: 1, crashes: 1, anrs: 1 };
  const OPS_PARTS = { opsListed: 1, opsWork: 1 };
  const WISHLIST = 'weesh';

  // 指標定義。parts 是組成這個指標的原始數列；type：count 加總、level 取每日平均、ratio 由兩個指標相除。
  // good：1 越高越好、-1 越低越好。plat：可以依平台拆開的原始數列。
  const METRICS = {
    installs: { name: '新安裝', group: '商店', type: 'count', fmt: 'full', good: 1, src: 'store',
      parts: ['googleInstalls', 'appleDownloads'], plat: { android: 'googleInstalls', ios: 'appleDownloads' },
      note: 'Google Play 每日安裝數，加上 App Store 首次下載數' },
    revenue: { name: '廣告收入', group: '商店', type: 'count', fmt: 'money', good: 1, src: 'store', frac: true,
      parts: ['admobRevenue'], note: 'AdMob 預估收入，新台幣' },
    crashes: { name: '當機與無回應', group: '商店', type: 'count', fmt: 'full', good: -1, src: 'store',
      parts: ['crashes', 'anrs'], note: 'Google Play 回報的當機與無回應事件；用戶太少的日子 Google 不提供' },
    intro: { name: '介紹頁瀏覽', group: '作品集', type: 'count', fmt: 'full', good: 1, src: 'traffic',
      parts: ['introViews'], note: '作品集上這款 APP 的介紹被打開的次數' },
    clicks: { name: '商店點擊', group: '作品集', type: 'count', fmt: 'full', good: 1, src: 'traffic',
      parts: ['googleClicks', 'appleClicks'], plat: { android: 'googleClicks', ios: 'appleClicks' },
      note: '從作品集點去 Google Play 或 App Store 的次數' },
    ctr: { name: '商店點擊率', group: '作品集', type: 'ratio', fmt: 'pct1', pct: true, good: 1, src: 'traffic',
      num: 'clicks', den: 'intro', note: '商店點擊次數除以介紹頁瀏覽次數' },
    active: { name: '活躍裝置', group: '使用', type: 'level', fmt: 'num', good: 1, src: 'usage',
      parts: ['eclawActiveDevices', 'dreamActiveDevices'], note: '當天有對話的裝置數，目前有 EClawbot 與夢話夥伴' },
    messages: { name: '對話則數', group: '使用', type: 'count', fmt: 'full', good: 1, src: 'usage',
      parts: ['eclawMessages', 'dreamTurns'], note: 'EClawbot 的訊息數，加上夢話夥伴的對話回合' },
    signups: { name: 'EClaw 新註冊', group: '使用', type: 'count', fmt: 'full', good: 1, src: 'usage',
      parts: ['eclawSignups'], note: 'EClaw 新建立的帳號數' },
    listed: { name: 'Wishlist 上架', group: '產出', type: 'count', fmt: 'full', good: 1, src: 'ops',
      parts: ['opsListed'], note: 'Wishlist.ai 每筆紀錄第一次公開的次數' },
    aiwork: { name: 'AI 完成工作', group: '產出', type: 'count', fmt: 'full', good: 1, src: 'ops',
      parts: ['opsWork'], note: '各個 AI worker 完成的件數：照片、商品、對話回合' }
  };
  const GROUPS = ['商店', '作品集', '使用', '產出'];

  const idxOfIso = iso => Math.floor(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / DAY);
  const idxOf = t => Math.floor((t + TZ) / DAY);
  const dayT = idx => idx * DAY - TZ;
  const workerApp = id => (/^dream-buddy/.test(id) ? 'dreambuddy' : /^timehut-/.test(id) ? 'timehut' : /^wishlist-/.test(id) ? WISHLIST : null);

  const D = {
    MIN: MIN, HOUR: HOUR, DAY: DAY, TZ: TZ, METRICS: METRICS, GROUPS: GROUPS, PLATS: PLATS, WISHLIST: WISHLIST, idxOf: idxOf, dayT: dayT,
    T0: 0, today: 0, APPS: [], APP: {}, BYKEY: {}, CATS: [], sources: {}, latest: {}, eclaw: {},
    RAW: {}, opsDaily: {}, ALERTS: [],
    ops: { ok: false, at: 0, series: [], workers: [], status: null, listing: null, chat: null, workTotals: {}, cpuFreshness: null, updatedAt: {}, recent: null }
  };
  let ends = {};

  async function getJson(url) {
    const res = await fetch(url, { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } });
    if (!res.ok) { const e = new Error('HTTP ' + res.status); e.status = res.status; throw e; }
    return res.json();
  }

  // ---- 套用伺服器的回答 -------------------------------------------------------
  function normApp(a) {
    const name = a.name || a.id, pub = (a.platforms || []).some(p => p.public);
    return {
      id: a.slug || a.id, key: a.id, name: name, short: SHORT[a.id] || name.split(/[：｜]/)[0].trim() || name, mono: a.mono || name.slice(0, 2),
      cat: a.category || '其他', desc: a.desc || '', aliases: a.aliases || '', icon: a.icon || null,
      platforms: a.platforms || [], links: a.links || {}, stage: pub ? 'live' : 'dev'
    };
  }
  function applyHub(hub) {
    if (!hub || !hub.success || !hub.daily) throw new Error('HUB_SHAPE');
    D.T0 = hub.generatedAt;
    D.today = idxOfIso(hub.today);
    D.sources = hub.sources || {};
    D.latest = hub.latest || {};
    D.eclaw = hub.eclaw || {};
    const start = idxOfIso(hub.daily.start);
    Object.keys(D.RAW).forEach(part => { if (!OPS_PARTS[part]) delete D.RAW[part]; });
    Object.keys(hub.daily.series || {}).forEach(part => {
      const byApp = hub.daily.series[part];
      D.RAW[part] = {};
      Object.keys(byApp).forEach(app => { D.RAW[part][app] = { o: start + byApp[app].o, v: byApp[app].v }; });
    });
    D.APPS = (hub.apps || []).map(normApp);
    D.APP = {}; D.BYKEY = {};
    D.APPS.forEach(a => { D.APP[a.id] = a; D.BYKEY[a.key] = a; });
    const cats = new Set(D.APPS.map(a => a.cat));
    D.CATS = CAT_ORDER.filter(c => cats.has(c)).concat(Array.from(cats).filter(c => CAT_ORDER.indexOf(c) < 0));
    ends = {};
  }
  function applyOps(catalog, latest) {
    const o = D.ops;
    if (catalog && catalog.success) o.series = catalog.series || [];
    if (latest && latest.success) {
      o.ok = true; o.at = Date.now();
      o.status = latest.status || null;
      o.listing = latest.listing || null;
      o.chat = latest.chatPending || null;
      o.workTotals = (latest.workTotals && latest.workTotals.totals) || {};
      o.cpuFreshness = latest.cpuFreshness || null;
      o.updatedAt = latest.updatedAt || {};
      o.workers = ((o.status && o.status.workers) || []).map(w => Object.assign({}, w, { app: workerApp(w.id) }));
    } else if (latest === null) o.ok = false;
  }
  const workIds = () => D.ops.series.filter(s => s.group === 'work').map(s => s.id);

  // 把營運數據 API 的點放進固定間距的格子；count 加總，gauge 取平均
  function bucketize(points, from, step, n, kind) {
    const sum = new Array(n).fill(0), cnt = new Array(n).fill(0);
    (points || []).forEach(p => {
      const i = Math.floor((p[0] - from) / step);
      if (i < 0 || i >= n || p[1] == null) return;
      sum[i] += p[1]; cnt[i]++;
    });
    return sum.map((s, i) => (cnt[i] ? (kind === 'count' ? s : s / cnt[i]) : null));
  }
  async function opsSeries(ids, step, from, to) {
    if (!ids.length) return {};
    const res = await getJson(OPS + '/series?ids=' + ids.map(encodeURIComponent).join(',') + '&step=' + step + '&from=' + Math.floor(from) + '&to=' + Math.ceil(to));
    return res.series || {};
  }

  // 每日的上架數與 AI 完成件數：併進每日數列，績效指標才能跟其他指標用同一套算法
  async function loadOpsDaily() {
    const ids = ['wishlist.listed'].concat(workIds()).slice(0, 24);
    const series = await opsSeries(ids, 'day', dayT(D.today - 399), Date.now());
    D.opsDaily = {};
    Object.keys(series).forEach(id => {
      const pts = series[id].points || [];
      if (!pts.length) return;
      let lo = Infinity, hi = -Infinity;
      pts.forEach(p => { const i = idxOf(p[0]); if (i < lo) lo = i; if (i > hi) hi = i; });
      const v = new Array(hi - lo + 1).fill(null);
      pts.forEach(p => { if (p[1] != null) v[idxOf(p[0]) - lo] = p[1]; });
      D.opsDaily[id] = { o: lo, v: v };
    });
    D.RAW.opsListed = {};
    if (D.opsDaily['wishlist.listed']) D.RAW.opsListed[WISHLIST] = D.opsDaily['wishlist.listed'];
    D.RAW.opsWork = {};
    const byApp = {};
    Object.keys(D.opsDaily).forEach(id => {
      if (id.indexOf('work.') !== 0) return;
      const app = workerApp(id.split('.')[1]);
      if (app) (byApp[app] = byApp[app] || []).push(D.opsDaily[id]);
    });
    Object.keys(byApp).forEach(app => {
      const list = byApp[app], lo = Math.min.apply(null, list.map(s => s.o)), hi = Math.max.apply(null, list.map(s => s.o + s.v.length - 1));
      const v = new Array(hi - lo + 1).fill(null);
      list.forEach(s => s.v.forEach((x, i) => { if (x != null) v[s.o - lo + i] = (v[s.o - lo + i] || 0) + x; }));
      D.RAW.opsWork[app] = { o: lo, v: v };
    });
    ends = {};
  }
  // 最近 24 小時、每小時一格：總覽「現在」那一列的小圖
  async function loadOpsRecent() {
    const to = Math.floor(Date.now() / HOUR) * HOUR + HOUR, from = to - 24 * HOUR, wids = workIds();
    const series = await opsSeries(['wishlist.listed', 'cpu.total.core'].concat(wids).slice(0, 24), 'hour', from, to);
    const pts = id => (series[id] && series[id].points) || [];
    const work = new Array(24).fill(null), perWork = {};
    wids.forEach(id => {
      const v = perWork[id] = bucketize(pts(id), from, HOUR, 24, 'count');
      v.forEach((x, i) => { if (x != null) work[i] = (work[i] || 0) + x; });
    });
    D.ops.recent = {
      from: from, x: Array.from({ length: 24 }, (_, i) => from + i * HOUR),
      listed: bucketize(pts('wishlist.listed'), from, HOUR, 24, 'count'),
      cpu: bucketize(pts('cpu.total.core'), from, HOUR, 24, 'gauge'),
      work: work, perWork: perWork
    };
  }

  D.load = async function () {
    const got = await Promise.all([getJson(API + '/data'), getJson(OPS + '/catalog').catch(() => null), getJson(OPS + '/latest').catch(() => null)]);
    applyHub(got[0]);
    applyOps(got[1], got[2]);
    await Promise.all([loadOpsDaily().catch(() => {}), loadOpsRecent().catch(() => {})]);
    computeAlerts(Date.now());
  };
  // 每分鐘：worker 狀態與 Wishlist 現況
  D.refreshLive = async function () {
    applyOps(null, await getJson(OPS + '/latest').catch(() => null));
    computeAlerts(Date.now());
  };
  // 每五分鐘：每日數列、最近 24 小時的小圖。fresh：使用者按了「重新讀取」，請伺服器不要拿兩分鐘內的舊答案
  D.refreshData = async function (fresh) {
    const got = await Promise.all([getJson(API + '/data' + (fresh ? '?fresh=1' : '')), fresh ? getJson(OPS + '/latest').catch(() => null) : undefined]);
    applyHub(got[0]);
    if (fresh) applyOps(null, got[1]);
    await Promise.all([loadOpsDaily().catch(() => {}), loadOpsRecent().catch(() => {})]);
    computeAlerts(Date.now());
  };
  D.opsSeries = opsSeries;
  D.bucketize = bucketize;
  D.workIds = workIds;

  // ---- 每日數列 ---------------------------------------------------------------
  function rawAt(part, appKey, idx) {
    const s = D.RAW[part] && D.RAW[part][appKey];
    if (!s) return null;
    const i = idx - s.o;
    return i < 0 || i >= s.v.length ? null : s.v[i];
  }
  // n 格、每格 step 天、從第 from 天開始；apps 加總。整格都沒有已知的值就是 null。
  // level（例如活躍裝置）每個來源先各自算「有紀錄那幾天」的日均再相加，
  // 來源開始記錄的時間不一樣時，才不會被還沒開始的那一段拉低。
  function partsSeries(def, apps, from, step, n, parts) {
    const list = parts || def.parts, out = new Array(n).fill(null), level = def.type === 'level';
    for (let a = 0; a < apps.length; a++) for (let p = 0; p < list.length; p++) {
      const s = D.RAW[list[p]] && D.RAW[list[p]][apps[a].key];
      if (!s) continue;
      for (let b = 0; b < n; b++) {
        const lo = Math.max(from + b * step, s.o), hi = Math.min(from + (b + 1) * step, s.o + s.v.length);
        let sum = 0, days = 0;
        for (let i = lo; i < hi; i++) { const v = s.v[i - s.o]; if (v != null) { sum += v; days++; } }
        if (days) out[b] = (out[b] || 0) + (level ? sum / days : sum);
      }
    }
    return out;
  }
  D.series = function (key, apps, from, step, n) {
    const def = METRICS[key];
    if (def.type === 'ratio') {
      const num = D.series(def.num, apps, from, step, n), den = D.series(def.den, apps, from, step, n);
      return num.map((v, i) => (den[i] ? (v || 0) / den[i] * 100 : null));
    }
    return partsSeries(def, apps, from, step, n);
  };
  D.appSeries = (app, key, from, step, n) => D.series(key, [app], from, step, n);
  D.platSeries = function (key, apps, plat, from, step, n) {
    const def = METRICS[key];
    return def.plat && def.plat[plat] ? partsSeries(def, apps, from, step, n, [def.plat[plat]]) : new Array(n).fill(null);
  };
  // 一段期間的總計（count）、每日平均（level）或比率（ratio）
  D.total = function (key, apps, from, to) {
    const def = METRICS[key];
    if (def.type === 'ratio') { const den = D.total(def.den, apps, from, to); return den ? (D.total(def.num, apps, from, to) || 0) / den * 100 : null; }
    return to > from ? partsSeries(def, apps, from, to - from, 1)[0] : null;
  };
  // 這段期間有幾天是已知的
  D.coverage = function (key, apps, from, to) {
    const def = METRICS[key], k = def.type === 'ratio' ? def.den : key;
    const v = partsSeries(METRICS[k], apps, from, 1, Math.max(0, to - from));
    return { known: v.filter(x => x != null).length, days: Math.max(0, to - from) };
  };
  function partEnd(part) {
    const st = D.sources.store;
    if (STORE_PARTS[part] && st && st.ok && st.ends && st.ends[part]) return idxOfIso(st.ends[part]);
    const byApp = D.RAW[part];
    let end = null;
    if (byApp) Object.keys(byApp).forEach(k => { const e = byApp[k].o + byApp[k].v.length - 1; if (end == null || e > end) end = e; });
    return end;
  }
  function partStart(part) {
    const byApp = D.RAW[part];
    let start = null;
    if (byApp) Object.keys(byApp).forEach(k => { if (start == null || byApp[k].o < start) start = byApp[k].o; });
    return start;
  }
  // 這個指標「最後一個完整的日子」。商店報表每週才更新，所以每個指標的期間各自對齊到自己的最後一天；
  // 即時來源只算到昨天，今天還沒過完。
  D.metricEnd = function (key) {
    if (ends[key] != null) return ends[key];
    const def = METRICS[key];
    let end = null;
    if (def.type === 'ratio') end = Math.min(D.metricEnd(def.num), D.metricEnd(def.den));
    else {
      def.parts.forEach(p => { const e = partEnd(p); if (e != null) end = end == null ? e : Math.min(end, e); });
      end = end == null ? D.today - 1 : Math.min(end, D.today - 1);
    }
    return (ends[key] = end);
  };
  // 這個指標從哪一天起「每個來源都已經在記錄」。前一期要整段落在這一天之後才拿來比，
  // 否則會把「還沒開始記錄」誤當成 0，算出假的成長。
  D.compareStart = function (key) {
    const def = METRICS[key];
    if (def.type === 'ratio') { const a = D.compareStart(def.num), b = D.compareStart(def.den); return a == null || b == null ? null : Math.max(a, b); }
    let start = null;
    def.parts.forEach(p => { const s = partStart(p); if (s != null) start = start == null ? s : Math.max(start, s); });
    return start;
  };
  D.comparable = function (key, from) { const s = D.compareStart(key); return s != null && from >= s; };
  D.hasData = function (key, app) {
    const def = METRICS[key];
    if (def.type === 'ratio') return D.hasData(def.den, app);
    return def.parts.some(p => D.RAW[p] && D.RAW[p][app.key]);
  };
  D.metricsFor = app => Object.keys(METRICS).filter(k => D.hasData(k, app));
  D.anyData = key => D.APPS.some(a => D.hasData(key, a));
  // 目前只有 Wishlist 上架有明訂的目標（每小時幾件），其他指標沒有設定
  D.target = function (key, apps, from, to) {
    const l = D.ops.listing;
    if (key !== 'listed' || !l || l.targetPerHour == null || !apps.some(a => a.key === WISHLIST)) return null;
    return l.targetPerHour * 24 * (to - from);
  };
  // 今天到目前為止（未過完的一天）
  D.todayValue = function (part, appKey) { return rawAt(part, appKey, D.today); };
  // 單一原始數列在一段期間的加總；整段都不知道就是 null
  D.rawSum = function (part, appKey, from, to) {
    let sum = null;
    for (let i = from; i < to; i++) { const v = rawAt(part, appKey, i); if (v != null) sum = (sum || 0) + v; }
    return sum;
  };
  D.siteViews = (from, to) => D.rawSum('siteViews', '__site__', from, to);

  // ---- 警示：全部由目前的數字算出來，條件解除就消失 ------------------------------
  const RULES = [
    ['資料來源讀不到', '每一個資料來源', '後端讀取失敗', 'crit'],
    ['worker 沒有在執行', '每一個 AI worker', '監控回報程序不在線上', 'crit'],
    ['worker 狀態異常', '每一個 AI worker', '監控回報「異常」或「部分異常」', 'warn'],
    ['監控資料沒有更新', '營運數據', '超過 20 分鐘沒有新的讀數', 'warn'],
    ['Wishlist 上架低於目標', 'Wishlist.ai', '近 24 小時平均每小時上架數低於目標', 'warn'],
    ['買家詢問等待處理', 'Wishlist.ai', '聊聊待問大於 0', 'info'],
    ['商店報表超過一週沒更新', '商店報表', '報表產生時間距今超過 8 天', 'warn'],
    ['評分低於 4.0', '每一款 APP', 'Google Play 評分低於 4.0', 'warn']
  ];
  const SOURCE_LABEL = { catalog: 'APP 目錄', store: '商店報表', traffic: '作品集流量', community: '作品集互動', feedback: '問題回饋', eclaw: 'EClaw 帳號', eclawChat: 'EClaw 對話', dreambuddy: '夢話夥伴後台' };
  function computeAlerts(now) {
    const out = [], o = D.ops;
    const add = (id, sev, title, detail, more) => out.push(Object.assign({ id: id, sev: sev, title: title, detail: detail, app: null, since: null }, more));
    Object.keys(D.sources).forEach(id => {
      if (!D.sources[id].ok) add('src-' + id, 'crit', (SOURCE_LABEL[id] || id) + '讀不到', '這個來源的數字目前是空的；其他來源不受影響。', { rule: RULES[0][0], go: 'sources' });
    });
    if (!o.ok) add('ops-down', 'crit', '營運數據讀不到', 'AI worker 與 Wishlist 的即時數字目前是空的。', { rule: RULES[0][0], go: 'sources' });
    o.workers.forEach(w => {
      if (w.processOnline === false) add('worker-off-' + w.id, 'crit', w.name + ' 沒有在執行', '監控回報這個 worker 的程序不在線上。', { rule: RULES[1][0], app: w.app, go: 'live' });
      else if (w.health === 'unhealthy' || w.health === 'degraded') add('worker-bad-' + w.id, 'warn', w.name + (w.health === 'unhealthy' ? ' 狀態異常' : ' 部分異常'), '程序還在，但監控的健康檢查沒有通過。', { rule: RULES[2][0], app: w.app, go: 'live' });
    });
    const seen = Date.parse(o.updatedAt.latestStatus || '') || 0;
    if (o.ok && ((seen && now - seen > 20 * MIN) || (o.cpuFreshness && o.cpuFreshness.dataFresh === false))) {
      add('ops-stale', 'warn', '監控資料沒有更新', '上一次收到 worker 讀數是 ' + (seen ? Math.round((now - seen) / MIN) + ' 分鐘前' : '很久以前') + '。', { rule: RULES[3][0], since: seen || null, go: 'live' });
    }
    const l = o.listing;
    if (l && l.targetPerHour != null && l.perHour24h != null && l.perHour24h < l.targetPerHour) {
      add('listing-rate', 'warn', 'Wishlist 上架低於目標', '近 24 小時平均每小時 ' + Math.round(l.perHour24h) + ' 件，目標是每小時 ' + l.targetPerHour + ' 件。', { rule: RULES[4][0], app: WISHLIST, go: 'live' });
    }
    if (o.chat && o.chat.pendingCount > 0) add('chat-pending', 'info', '有 ' + o.chat.pendingCount + ' 則買家詢問等待處理', 'Wishlist.ai 的聊聊待問；這個數字最多延遲約 2 小時。', { rule: RULES[5][0], app: WISHLIST, since: o.chat.observedAt || null });
    const st = D.sources.store, gen = st && st.ok ? Date.parse(st.generatedAt || '') : 0;
    if (gen && now - gen > 8 * DAY) add('store-stale', 'warn', '商店報表超過一週沒更新', '安裝、下載、收入這幾項停在上一次產生報表的時候（' + Math.floor((now - gen) / DAY) + ' 天前）。', { rule: RULES[6][0], since: gen, go: 'sources' });
    Object.keys(D.latest.rating || {}).forEach(k => {
      const r = D.latest.rating[k], a = D.BYKEY[k];
      if (a && r && r.value < 4) add('rating-' + a.id, 'warn', a.short + ' 的評分是 ' + r.value.toFixed(1), 'Google Play 評分低於 4.0。', { rule: RULES[7][0], app: k });
    });
    D.ALERTS = out;
  }
  D.RULES = RULES;
  D.computeAlerts = computeAlerts;
  // 側欄與列表上的狀態：有警示就顯示警示的等級，否則看有沒有公開上架
  D.appState = function (a) {
    let st = a.stage === 'dev' ? 'dev' : 'live';
    D.ALERTS.forEach(x => { if (x.app === a.key && (x.sev === 'crit' || (x.sev === 'warn' && st !== 'crit'))) st = x.sev; });
    return st;
  };

  // ---- 資料來源一覽 --------------------------------------------------------------
  D.sourceRows = function () {
    const s = D.sources, o = D.ops, iso = i => { const d = new Date(dayT(i) + TZ); return (d.getUTCMonth() + 1) + '/' + d.getUTCDate(); };
    const state = id => (s[id] ? (s[id].ok ? 'ok' : 'crit') : 'crit');
    const st = s.store || {}, storeEnds = st.ends ? [['Google', st.ends.googleInstalls], ['Apple', st.ends.appleDownloads], ['AdMob', st.ends.admobRevenue]].filter(e => e[1]).map(e => e[0] + ' 到 ' + iso(idxOfIso(e[1]))).join('、') : '';
    const opsSeen = Date.parse(o.updatedAt.latestStatus || '') || null;
    return [
      { name: '商店報表', gives: 'Google Play 安裝、App Store 首次下載、AdMob 收入、當機事件、評分', cover: '有上架的 APP', freq: '每週產生一次', last: Date.parse(st.generatedAt || '') || null, state: state('store'), note: storeEnds || '—' },
      { name: '作品集流量', gives: '作品集瀏覽、介紹頁瀏覽、商店點擊', cover: '全部 APP', freq: '即時累計', last: s.traffic && s.traffic.ok ? D.T0 : null, state: state('traffic'), note: s.traffic && s.traffic.startedAt ? '自 ' + iso(idxOfIso(s.traffic.startedAt)) + ' 起' : '—' },
      { name: '作品集互動', gives: '按讚、留言、內測回饋', cover: '全部 APP', freq: '即時累計', last: s.community && s.community.ok ? D.T0 : null, state: state('community'), note: '只統計數量，不含內容' },
      { name: 'EClaw 帳號', gives: '帳號數、每日新註冊、裝置與實體數', cover: 'EClawbot', freq: '即時', last: s.eclaw && s.eclaw.ok ? D.T0 : null, state: state('eclaw'), note: '裝置與實體數不含測試裝置' },
      { name: 'EClaw 對話', gives: '每日訊息數、活躍裝置', cover: 'EClawbot', freq: '每 10 分鐘重新統計', last: s.eclawChat && s.eclawChat.ok ? s.eclawChat.readAt : null, state: state('eclawChat'), note: s.eclawChat && s.eclawChat.since ? '自 ' + iso(idxOfIso(s.eclawChat.since)) + ' 起' : '—' },
      { name: '夢話夥伴後台', gives: '對話回合、活躍裝置、廣告獎勵次數', cover: '夢話夥伴', freq: '即時', last: s.dreambuddy && s.dreambuddy.ok ? D.T0 : null, state: state('dreambuddy'), note: s.dreambuddy && s.dreambuddy.startedAt ? '自 ' + iso(idxOfIso(s.dreambuddy.startedAt)) + ' 起' : '還沒有紀錄' },
      { name: '問題回饋', gives: 'APP 內送出的問題回饋件數', cover: '詐騙帝國', freq: '即時', last: s.feedback && s.feedback.ok ? D.T0 : null, state: state('feedback'), note: '只統計數量，不含內容' },
      { name: '營運數據', gives: 'AI worker 的 CPU、記憶體、完成件數；Wishlist 上架數、公開可見數、聊聊待問', cover: 'Wishlist.ai、時光相簿、夢話夥伴', freq: '每 5 到 30 分鐘', last: opsSeen, state: o.ok ? 'ok' : 'crit', note: '與公開的「營運數據」頁同一份資料' },
      { name: '遊戲伺服器', gives: '玩家數、信箱、排行榜', cover: 'REBOUND、雙城烽火、巔峰之戰', freq: '—', last: null, state: 'none', note: '各自在別的專案上，還沒有彙總的讀取方式' },
      { name: '時光相簿伺服器', gives: '帳號、照片、排隊狀況', cover: '時光相簿', freq: '—', last: null, state: 'none', note: '還沒有彙總的讀取方式' },
      { name: '服務狀態', gives: '部署紀錄、可用率、回應時間', cover: '每一個後台服務', freq: '—', last: null, state: 'none', note: '需要新增定時檢查' },
      { name: 'APP 內事件', gives: '活躍用戶、留存、轉換漏斗', cover: '大多數 APP', freq: '—', last: null, state: 'none', note: '多數 APP 沒有記錄使用事件，要先在 APP 裡加' },
      { name: '內購與訂閱', gives: 'Google Play 與 App Store 的銷售金額', cover: '有內購的 APP', freq: '—', last: null, state: 'none', note: '商店報表目前只收廣告收入' }
    ];
  };

  global.HubData = D;
})(window);
