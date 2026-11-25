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
    active: { name: '活躍用戶', group: '使用', type: 'level', fmt: 'num', good: 1, src: 'usage',
      parts: ['eclawActiveDevices', 'dreamActiveDevices', 'x.activeUsers'],
      note: '當天有實際使用的人數：EClawbot 與夢話夥伴算有對話的裝置，遊戲算有玩的玩家，Wishlist 算有傳訊息或刊登的帳號' },
    newUsers: { name: '新用戶', group: '使用', type: 'count', fmt: 'full', good: 1, src: 'usage',
      parts: ['eclawSignups', 'x.newUsers'], note: '各後台新建立的帳號或玩家；和商店的安裝數是兩回事' },
    plays: { name: '對局與成績', group: '使用', type: 'count', fmt: 'full', good: 1, src: 'usage',
      parts: ['x.plays'], note: 'REBOUND 完成的對局、雙城烽火送出的成績、巔峰之戰的對戰場數' },
    messages: { name: '對話則數', group: '使用', type: 'count', fmt: 'full', good: 1, src: 'usage',
      parts: ['eclawMessages', 'dreamTurns', 'x.messages'], note: 'EClawbot 的訊息、夢話夥伴的對話回合、Wishlist 的買賣訊息' },
    iap: { name: '內購與訂閱收入', group: '收入', type: 'count', fmt: 'money', good: 1, src: 'usage', frac: true,
      parts: ['eclawPaidTwd', 'x.purchaseTwd'], note: '後台有記錄金額的部分：EClawbot 的刷卡與儲值、Wishlist 的付費。遊戲的內購後台只記筆數，金額在商店後台' },
    purchases: { name: '內購筆數', group: '收入', type: 'count', fmt: 'full', good: 1, src: 'usage',
      parts: ['eclawPurchases', 'x.purchases'], note: '各後台驗證成功的購買筆數，不含測試與沙盒' },
    mailSent: { name: '寄出的信', group: '產出', type: 'count', fmt: 'full', good: 0, src: 'usage',
      parts: ['x.mailSent'], note: '遊戲內信箱寄出的信，節日禮包也算在裡面' },
    mailClaimed: { name: '領取的信', group: '產出', type: 'count', fmt: 'full', good: 1, src: 'usage',
      parts: ['x.mailClaimed'], note: '玩家在遊戲內信箱按下領取的次數' },
    listed: { name: 'Wishlist 上架', group: '產出', type: 'count', fmt: 'full', good: 1, src: 'ops',
      parts: ['opsListed'], note: 'Wishlist.ai 每筆紀錄第一次公開的次數' },
    aiwork: { name: 'AI 完成工作', group: '產出', type: 'count', fmt: 'full', good: 1, src: 'ops',
      parts: ['opsWork'], note: '各個 AI worker 完成的件數：照片、商品、對話回合' },
    netIn: { name: '後台傳入（上傳）', group: '後台', type: 'count', fmt: 'mb', good: 0, src: 'usage', frac: true,
      parts: ['x.netInMb'], note: '各後台伺服器每天收到的資料量：使用者上傳照片、刊登圖片、送出資料；Railway 量測' },
    netOut: { name: '後台傳出（下載）', group: '後台', type: 'count', fmt: 'mb', good: 0, src: 'usage', frac: true,
      parts: ['x.netOutMb'], note: '各後台伺服器每天送出的資料量：使用者下載照片、看刊登圖片、載入頁面；Railway 量測' }
  };
  const GROUPS = ['商店', '作品集', '使用', '收入', '產出', '後台'];

  const idxOfIso = iso => Math.floor(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / DAY);
  const idxOf = t => Math.floor((t + TZ) / DAY);
  const dayT = idx => idx * DAY - TZ;
  const workerApp = id => (/^dream-buddy/.test(id) ? 'dreambuddy' : /^timehut-/.test(id) ? 'timehut' : /^wishlist-/.test(id) ? WISHLIST : null);

  const D = {
    MIN: MIN, HOUR: HOUR, DAY: DAY, TZ: TZ, METRICS: METRICS, GROUPS: GROUPS, PLATS: PLATS, WISHLIST: WISHLIST, idxOf: idxOf, idxOfIso: idxOfIso, dayT: dayT,
    T0: 0, today: 0, APPS: [], APP: {}, BYKEY: {}, CATS: [], sources: {}, latest: {}, eclaw: {},
    RAW: {}, opsDaily: {}, ALERTS: [], services: [], infra: [], accounts: [],
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
    D.services = (hub.services || []).map(svc => Object.assign({ now: (D.services.find(old => old.id === svc.id) || {}).now || null }, svc));
    D.infra = Array.isArray(hub.infra) ? hub.infra : [];
    D.accounts = Array.isArray(hub.accounts) ? hub.accounts : [];
    D.inbox = hub.inbox && Array.isArray(hub.inbox.feedback) ? hub.inbox : { feedback: [], notes: [], mutes: [], acks: [], days: 30 };
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

  // 每個後台服務最近一次健康檢查的結果
  function applyServices(answer) {
    if (!answer || !answer.success) return;
    const byId = {};
    (answer.services || []).forEach(svc => { byId[svc.id] = svc; });
    D.services.forEach(svc => { if (byId[svc.id]) svc.now = byId[svc.id]; });
  }
  D.load = async function () {
    const got = await Promise.all([getJson(API + '/data'), getJson(OPS + '/catalog').catch(() => null), getJson(OPS + '/latest').catch(() => null), getJson(API + '/services').catch(() => null)]);
    applyHub(got[0]);
    applyOps(got[1], got[2]);
    applyServices(got[3]);
    await Promise.all([loadOpsDaily().catch(() => {}), loadOpsRecent().catch(() => {})]);
    computeAlerts(Date.now());
  };
  // 每分鐘：worker 狀態與 Wishlist 現況
  D.refreshLive = async function () {
    const got = await Promise.all([getJson(OPS + '/latest').catch(() => null), getJson(API + '/services').catch(() => null)]);
    applyOps(null, got[0]);
    applyServices(got[1]);
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
    ['評分低於 4.0', '每一款 APP', 'Google Play 評分低於 4.0', 'warn'],
    ['後台服務沒有回應', '每一個後台服務', '最近一次健康檢查失敗', 'crit'],
    ['後台數據超過一天沒更新', '遊戲伺服器、Wishlist 後台、Railway 後台資源', '上一次匯入距今超過 36 小時', 'warn'],
    ['後台空間快滿', '每一個有空間的後台服務', '用量超過 80%（95% 以上算嚴重）', 'warn'],
    ['後台部署失敗', '每一個後台服務', '最新一次部署失敗或執行中當掉', 'crit'],
    ['需要人為介入', 'Wishlist.ai 上架排程', '排程回報它自己解不了的問題（要重新登入、手動通過驗證、金鑰失效、需要決定）', 'crit'],
    ['新的問題回饋', '每一款 APP 的問題回饋（APP 內、LINE、作品集內測回饋）', '近 30 天收到、排程還沒結案的回報；排程看過後會寫下判斷', 'warn'],
    ['排程請你處理', '警示處理排程（每 15 分鐘看一次所有警示）', '排程判斷這件事只有你能處理，會寫明要你做什麼', 'crit'],
    ['已略過的類似警告', '你按過「以後略過類似警告」的那一類警示', '同一類的警示合併成這一則、等級是資訊，不再個別提醒；可以取消略過', 'info'],
    ['拾光帳號空間快滿', '拾光AI雲端相簿的每個帳號', '已存原檔加等待中的照片超過每帳號上限的 90%（滿了算嚴重）', 'warn'],
    ['拾光上傳被伺服器拒收', '拾光AI雲端相簿的每個帳號', '近 2 小時有上傳被拒收：帳號滿了算嚴重；重送也不會過的原因算警告；伺服器忙這類暫時原因今天超過 20 次才算警告；只有手機傳到一半斷線的不發警示', 'warn'],
    ['拾光 LINE 收件卡住', '拾光AI雲端相簿每個帳號的 LINE 收件', '有照片還在下載、辨識或匯入，最久的一張超過 1 小時沒往下走（6 小時以上算嚴重）；以收集工具最後一次讀數的時間算', 'warn'],
    ['拾光 LINE 收件無法處理', '拾光AI雲端相簿每個帳號的 LINE 收件', '有照片停在「卡住」階段，不會自己往下走，例如收件相簿沒有參考對象也沒開直接上傳；每個原因一則', 'warn']
  ];
  const COLLECTORS = { rebound: ['REBOUND 遊戲伺服器', 'REBOUND'], summit: ['活字戰紀伺服器', '雙城烽火、巔峰之戰'], wishlist: ['Wishlist.ai 後台', 'Wishlist.ai'],
    // 第四項是「沒有其他備註時」顯示的說明；帳戶明細不是只有彙總數字，要照實寫
    'wishlist-users': ['Wishlist.ai 帳戶明細', 'Wishlist.ai', '帳戶智慧數據庫：每個帳戶的願望、刊登、對話、面交、付費與近 30 天活動', '每個帳戶的數量與時間，加上顯示名稱與遮蔽過的登入信箱；不含密碼、訊息或任何內容'],
    railway: ['Railway 後台資源', '所有放在 Railway 的後台服務', '每個服務的上傳／下載流量、CPU、記憶體、空間、部署狀態'],
    timehut: ['時光相簿伺服器', '時光相簿', '帳號總數、近 7／30 天新註冊、已刪除帳號；每位用戶的 LINE 辨識各階段、相簿與照片／影片數、上傳與下載流量（伺服器 1.0.118 起）；上傳額度與被伺服器拒收的次數和原因（1.0.126 起）；每小時更新'],
    attention: ['上架警示板', 'Wishlist.ai', '上架排程回報的問題：需要人為介入的、自動處理中的'],
    'claude-usage': ['Claude 用量', '所有 Claude 排程與工作階段', 'Claude 訂閱方案的每週用量百分比與重置時間（右上角的電池）', '由這台 Mac 的 Claude CLI 本機指令讀出，不呼叫模型、不耗 token'],
    'feedback-timehut-app': ['拾光 APP 內問題回饋', '拾光AI雲端相簿', 'APP 內送出的問題回報（文字、版本、有沒有附圖），由警示處理排程每 15 分鐘讀一次'],
    'feedback-timehut-line': ['拾光 LINE 問題回饋', '拾光AI雲端相簿', 'LINE 官方帳號選單「問題回饋」收到的回報，由警示處理排程每 15 分鐘讀一次'],
    'feedback-discord': ['Discord 問題回報', '每一款 APP', 'AiHank 作品集 Discord 伺服器「問題回報」論壇的新貼文，由機器人每 2 分鐘讀一次'] };
  const mbText = v => (v >= 1024 ? (v / 1024).toFixed(v >= 10240 ? 1 : 2) + ' GB' : Math.round(v) + ' MB');
  // 拾光上傳被伺服器拒收的原因（伺服器 1.0.126 起的固定代碼）→［白話, 類別］。類別：full 帳號滿了（等待也不會解除）、
  // stuck 這一筆要人看（同一筆重送也不會過）、wait 伺服器忙或暫時性（稍後再傳就會過）、net 手機傳到一半斷線、done 本來就不該再傳（照片已刪、收據已取消）
  D.UPLOAD_REFUSAL = {
    ACCOUNT_STORAGE_FULL: ['帳號雲端空間已滿', 'full'], ACCOUNT_ITEM_LIMIT: ['帳號照片數量已達上限', 'full'],
    ACCOUNT_PENDING_ITEMS: ['等 Flickr 的照片太多（每帳號上限）', 'wait'], ACCOUNT_PENDING_BYTES: ['等 Flickr 的檔案太大（每帳號上限）', 'wait'],
    SERVER_PENDING_BYTES: ['伺服器整體等待中的檔案太多', 'wait'], SERVER_DISK_LOW: ['伺服器硬碟剩餘空間不足', 'wait'], SERVER_RECONCILIATION_PENDING: ['伺服器在確認先前的收件', 'wait'],
    PROVIDER_DISCONNECTED: ['相簿服務（Flickr）沒有連線', 'wait'], RECEIPT_UNCONFIRMED: ['既有收據尚未確認', 'wait'], RECEIVE_FAILED: ['收件失敗，可以重送', 'wait'], CONTENT_MISMATCH: ['收到的內容與宣告不符，可以重送', 'wait'],
    CLIENT_ABORTED: ['手機傳到一半斷線', 'net'], PHOTO_DELETED: ['原照片已刪除', 'done'], RECEIPT_CANCELLED: ['收據已取消', 'done'],
    FILE_TOO_LARGE: ['檔案超過 500 MB', 'stuck'], FILE_SIZE_INVALID: ['檔案大小無法確認', 'stuck'], FORMAT_UNSUPPORTED: ['不支援的檔案格式', 'stuck'], ALBUM_UNAVAILABLE: ['相簿不存在或無法使用', 'stuck'],
    UPLOAD_IDENTITY_CHANGED: ['同一筆上傳換了內容', 'stuck'], UPLOAD_IDENTITY_REQUIRED: ['缺少原檔識別', 'stuck'], PREVIOUS_UPLOAD_UNCONFIRMED: ['同一筆的先前收件仍待確認', 'stuck'],
    RECEIPT_RECONCILIATION_PENDING: ['既有收據待核對', 'stuck'], RECEIVE_UNCONFIRMED: ['收件結果尚未確認', 'stuck'], STORED_SIZE_UNCONFIRMED: ['已存照片的大小待確認', 'stuck'],
    REQUEST_INVALID: ['上傳請求格式不對', 'stuck'], UPLOAD_NOT_ADMITTED: ['上傳未被受理（其他原因）', 'stuck']
  };
  D.refusalText = c => (D.UPLOAD_REFUSAL[c] || [c])[0];
  D.refusalKind = c => (D.UPLOAD_REFUSAL[c] || [c, 'stuck'])[1];
  // 拾光 LINE 收件（伺服器 1.0.118 起每帳號的 line.stages／reasons／oldestWaitingAt）。等待中的階段跟伺服器 admin-stats 的 WAITING 相同；
  // blocked 不算等待：那些照片不會自己往下走，原因看 reasons。一張照片只有一個原因，所以 blocked 的照片用「只會跟 blocked 一起出現的原因」認。
  const LINE_WAITING = { download_queued: '等待從 LINE 下載', downloading: '從 LINE 下載中', downloaded: '已收到、等待處理', recognition_queued: '排隊辨識',
    recognizing: '辨識中', recognized: '已辨識、等待匯入', uploading: '匯入相簿中' };
  // 卡住的原因 →［白話, 類別］。類別：setup 用戶可能還沒設定完（也可能是流程壞了）、review 要有人確認、media 檔案本身不處理、system 伺服器或流程沒準備好
  D.LINE_BLOCKED = {
    MATCH_NOT_CONFIGURED: ['收件相簿沒有參考對象，也沒開直接上傳', 'setup'], COLLECTION_NOT_CONFIGURED: ['收件相簿沒有設定', 'setup'], REFERENCES_NOT_READY: ['參考照片還沒設定好', 'setup'],
    RECOGNITION_UNCERTAIN: ['辨識結果不確定，等人確認', 'review'], UNSUPPORTED_MEDIA: ['不支援的檔案類型', 'media'], ITEM_NOT_ENGAGED: ['照片資訊不完整', 'system'],
    AUTOMATION_DISABLED: ['伺服器的自動辨識已關閉', 'system'], AUTOMATION_NOT_READY: ['自動辨識還沒準備好', 'system'], RELEVANCE_SOURCE_NOT_READY: ['辨識來源還沒準備好', 'system'],
    TRANSPORT_NOT_READY: ['辨識連線還沒準備好', 'system'], PROVIDER_NOT_CONNECTED: ['相簿服務（Flickr）沒有連線', 'system'], UPLOAD_ADMISSION_CLOSED: ['伺服器暫停收件', 'system'],
    PROCESSING_STATUS_UNAVAILABLE: ['處理狀態讀不到', 'system']
  };
  D.lineBlockedText = c => (D.LINE_BLOCKED[c] || ['原因中樞還不認得'])[0];
  D.lineBlockedKind = c => (D.LINE_BLOCKED[c] || [c, 'unknown'])[1];
  const LINE_BLOCKED_WHY = {
    setup: '可能是用戶還沒設定完（要幫他設定），也可能是流程壞了（用戶其實設定好了）：請查這個帳號收件相簿的參考對象與直接上傳設定。',
    review: '要有人確認才會往下走；現行流程沒有確認的地方，不會自己進相簿。',
    media: '這種檔案伺服器不處理，不會進相簿。',
    system: '是伺服器的辨識或相簿連線沒準備好，跟用戶的設定無關，多半每個帳號都受影響。',
    unknown: '伺服器標成卡住，但沒有中樞認得的原因；這個帳號的原因代碼在判斷依據的 reasons。'
  };
  // 一個帳號的 LINE 收件狀態；伺服器沒有給階段（舊版）就是 null，不判斷。asOf 是這次讀數的時間
  const lineState = (u, asOf) => {
    const l = u && u.line, s = l && l.stages;
    if (!s || typeof s !== 'object') return null;
    const num = v => (Number.isFinite(v) && v > 0 ? v : 0), r = l.reasons && typeof l.reasons === 'object' ? l.reasons : {};
    const waitingStages = Object.keys(LINE_WAITING).filter(k => num(s[k])).map(k => [k, s[k]]), waiting = waitingStages.reduce((a, x) => a + x[1], 0);
    const oldest = num(l.oldestWaitingAt) || null, age = waiting && oldest ? asOf - oldest : null;
    let blocked = [];
    if (num(s.blocked)) {
      blocked = Object.keys(r).filter(c => D.LINE_BLOCKED[c] && num(r[c])).map(c => [c, r[c]]).sort((a, b) => b[1] - a[1]);
      if (!blocked.length) blocked = [['BLOCKED', s.blocked]];
    }
    return { waiting, waitingStages, oldest, age, stuck: age !== null && age >= HOUR, blocked, blockedTotal: num(s.blocked), reasons: r,
      received: num(l.received), processed: num(s.uploaded) + num(s.excluded), lastReceivedAt: num(l.lastReceivedAt) || null };
  };
  const durText = ms => (ms >= HOUR ? Math.floor(ms / HOUR) + ' 小時' + (ms % HOUR >= MIN ? ' ' + Math.floor(ms % HOUR / MIN) + ' 分' : '') : Math.floor(ms / MIN) + ' 分鐘');
  const TIMEHUT = 'timehut', gbText = v => (v >= 1024 ** 4 ? (v / 1024 ** 4).toFixed(2) + ' TB' : v >= 1024 ** 3 ? (v / 1024 ** 3).toFixed(2) + ' GB' : Math.round(v / 1024 ** 2) + ' MB');
  const SOURCE_LABEL = { catalog: 'APP 目錄', store: '商店報表', traffic: '作品集流量', community: '作品集互動', feedback: '問題回饋', eclaw: 'EClaw 帳號', eclawChat: 'EClaw 對話', dreambuddy: '夢話夥伴後台', eclawPayments: 'EClaw 付款', imports: '匯入的後台數據', services: '後台服務檢查', inbox: '問題回饋與排程判斷' };
  // 排程型 worker（例如每小時跑一輪）兩輪之間本來就沒有程式在跑；監控會把它標成 scheduled_between_rounds
  D.betweenRounds = w => w.processOnline === false && w.coverage === 'scheduled_between_rounds';
  // 監控回報的問題代碼（監控 1.7.0 起有時間）→ 白話。越前面越具體；監控只給代碼和時間，不給錯誤原文
  const at = t => { const d = new Date(t + TZ); return (d.getUTCMonth() + 1) + '/' + d.getUTCDate() + ' ' + String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0'); };
  const since = d => (d.since ? '（' + at(d.since) + ' 起）' : '');
  const ISSUES = [
    ['minimax_quota_exhausted', 'MiniMax 額度用完', d => 'MiniMax 回覆方案額度已用完' + since(d) + '。排隊的工作留在伺服器上，' + (d.nextAttemptAt ? 'worker 會在 ' + at(d.nextAttemptAt) + ' 自己再試，' : '') + '額度恢復後會自動補跑，不用重啟。'],
    ['worker_auth_problem', '金鑰或登入被拒', d => 'worker 的金鑰或登入被拒' + since(d) + '，要重新設定才會恢復。'],
    ['server_poll_failed', '伺服器回錯誤', d => '向工作伺服器取件時回了 ' + (d.httpStatus || '錯誤') + since(d) + '；伺服器恢復後會自動繼續。'],
    ['model_timeout', '模型逾時', d => '最近一次呼叫模型逾時' + since(d) + '，下一輪會自動重試。'],
    ['media_download_failed', '下載照片失敗', d => '從工作伺服器下載照片或影片失敗' + since(d) + '，下一輪會自動重試。'],
    ['model_bad_answer', '模型回應看不懂', d => '模型或上傳工具回了看不懂的內容' + since(d) + '，下一輪會自動重試。'],
    ['item_processing_failed', '處理失敗', d => '最近一次處理工作失敗' + since(d) + '，之後還沒有成功的結果；下一輪會自動重試。'],
    ['heartbeat_unavailable', '讀不到心跳', () => '監控讀不到這個 worker 的心跳檔。'],
    ['heartbeat_or_poll_not_current', '心跳沒有更新', d => '超過時限沒有新的心跳' + (d.since ? '，上一次取件是 ' + at(d.since) : '') + '；看門狗會在卡住 10 分鐘後自動重啟。'],
    ['recorded_error_without_later_result', '處理失敗後還沒成功', d => '記錄到錯誤' + since(d) + '，之後還沒有成功的結果。']
  ];
  // 一個 worker 最具體的那個問題：{ code, label, detail, since }，沒有就是 null
  D.workerIssue = function (w) {
    const details = Array.isArray(w.issueDetails) ? w.issueDetails : [], codes = Array.isArray(w.issues) ? w.issues : [];
    for (let i = 0; i < ISSUES.length; i++) {
      const code = ISSUES[i][0];
      if (codes.indexOf(code) < 0) continue;
      const d = details.find(x => x && x.code === code) || { code: code };
      return { code: code, label: ISSUES[i][1], detail: ISSUES[i][2](d), since: d.since || null };
    }
    return null;
  };
  // 通知 ID（Hank 2026-11-11「每則通知加上複製通知 ID，讓 AI 能用這個 ID 快速查到問題」）：
  // 類型與對象（例如 worker-bad-timehut-mcode），worker 問題再加問題代碼，有固定開始時間的再加「@台北時間」。
  // 同一件事每次重新整理、換瀏覽器都是同一個 ID；同一個對象換了問題或重新發生（開始時間不同）就是新的 ID。
  // 管理者可用 GET /api/aihankapps/hub/alerts/<ID> 查這則通知的來源、判斷依據與原始數值。
  const refStamp = t => { const d = new Date(t + TZ), p = n => String(n).padStart(2, '0'); return d.getUTCFullYear() + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) + '-' + p(d.getUTCHours()) + p(d.getUTCMinutes()); };
  D.alertRef = (id, code, start) => (id + (code ? '.' + code : '') + (start ? '@' + refStamp(start) : '')).replace(/[^A-Za-z0-9._@-]/g, '_');
  // 判斷依據裡的時間一律是 epoch 毫秒；workerBasis 只挑監控回報的欄位（監控不回錯誤原文）
  const WORKER_FIELDS = ['health', 'processOnline', 'coverage', 'issues', 'issueDetails', 'lastPollAt', 'lastPollStatus', 'lastErrorAt', 'lastResultAt', 'hasRecordedError', 'recordedErrorKind', 'heartbeatFresh', 'observedAt'];
  const workerBasis = w => { const b = { workerId: w.id }; WORKER_FIELDS.forEach(k => { if (w[k] !== undefined) b[k] = w[k]; }); return b; };
  function computeAlerts(now) {
    const out = [], o = D.ops;
    // more：rule、app／apps、since、go，以及 ref 用的 code／start、來源 source、原始數值 basis
    const add = (id, sev, title, detail, more) => {
      const m = more || {}, a = Object.assign({ id: id, sev: sev, title: title, detail: detail, app: null, apps: null, since: null, source: null, basis: null }, m);
      a.ref = D.alertRef(id, m.code, m.start);
      delete a.code; delete a.start;
      out.push(a);
    };
    Object.keys(D.sources).forEach(id => {
      if (!D.sources[id].ok) add('src-' + id, 'crit', (SOURCE_LABEL[id] || id) + '讀不到', '這個來源的數字目前是空的；其他來源不受影響。', { rule: RULES[0][0], go: 'sources',
        source: '管理中樞資料 /api/aihankapps/hub/data（' + id + '）', basis: { sourceId: id, ok: false } });
    });
    if (!o.ok) add('ops-down', 'crit', '營運數據讀不到', 'AI worker 與 Wishlist 的即時數字目前是空的。', { rule: RULES[0][0], go: 'sources', source: '營運數據 /api/aihankapps/ops/latest', basis: { opsOk: false } });
    o.workers.forEach(w => {
      if (w.processOnline === false && !D.betweenRounds(w)) add('worker-off-' + w.id, 'crit', w.name + ' 沒有在執行', '監控回報這個 worker 的程序不在線上。', { rule: RULES[1][0], app: w.app, go: 'live',
        source: 'MiniMax worker 監控（營運數據 /api/aihankapps/ops/latest）', basis: workerBasis(w) });
      else if (w.health === 'unhealthy' || w.health === 'degraded') {
        const issue = D.workerIssue(w);
        add('worker-bad-' + w.id, 'warn', w.name + (issue ? '：' + issue.label : w.health === 'unhealthy' ? ' 狀態異常' : ' 部分異常'), issue ? issue.detail : '程序還在，但監控的健康檢查沒有通過。',
          { rule: RULES[2][0], app: w.app, go: 'live', since: issue ? issue.since : null, code: issue ? issue.code : w.health,
            source: 'MiniMax worker 監控（營運數據 /api/aihankapps/ops/latest）', basis: workerBasis(w) });
      }
    });
    const seen = Date.parse(o.updatedAt.latestStatus || '') || 0;
    if (o.ok && ((seen && now - seen > 20 * MIN) || (o.cpuFreshness && o.cpuFreshness.dataFresh === false))) {
      add('ops-stale', 'warn', '監控資料沒有更新', '上一次收到 worker 讀數是 ' + (seen ? Math.round((now - seen) / MIN) + ' 分鐘前' : '很久以前') + '。', { rule: RULES[3][0], since: seen || null, go: 'live', start: seen || null,
        source: '營運數據 /api/aihankapps/ops/latest', basis: { latestStatusAt: seen || null, minutesAgo: seen ? Math.round((now - seen) / MIN) : null, cpuDataFresh: o.cpuFreshness ? o.cpuFreshness.dataFresh : null } });
    }
    const l = o.listing;
    if (l && l.targetPerHour != null && l.perHour24h != null && l.perHour24h < l.targetPerHour) {
      add('listing-rate', 'warn', 'Wishlist 上架低於目標', '近 24 小時平均每小時 ' + Math.round(l.perHour24h) + ' 件，目標是每小時 ' + l.targetPerHour + ' 件。', { rule: RULES[4][0], app: WISHLIST, go: 'live',
        source: '營運數據 /api/aihankapps/ops/latest（listing）', basis: { perHour24h: l.perHour24h, targetPerHour: l.targetPerHour } });
    }
    // 需要人為介入 (Hank, 2026-11-12): the listing schedules report what only a person can clear, one alert per problem.
    // What a schedule is still expected to clear by itself (kind "healing") raises nothing here.
    const board = ((D.latest.facts || {})[WISHLIST] || {}).attention || null;
    ((board && board.items) || []).forEach(x => {
      if (!x || x.kind !== 'human') return;
      add('attention-' + x.id, 'crit', '需要人為介入：' + x.title, (x.detail || '上架排程回報這個問題它自己解不了。') + (x.count > 1 ? '（已回報 ' + x.count + ' 次）' : ''), { rule: RULES[12][0], app: WISHLIST, since: x.since || null, start: x.since || null,
        source: '上架警示板（這台 Mac 的上架排程回報，經收集工具匯入）', basis: { id: x.id, platform: x.platform || null, since: x.since || null, count: x.count || 1, boardAt: board.boardAt || null } });
    });
    if (o.chat && o.chat.pendingCount > 0) add('chat-pending', 'info', '有 ' + o.chat.pendingCount + ' 則買家詢問等待處理', 'Wishlist.ai 的聊聊待問；這個數字最多延遲約 2 小時。', { rule: RULES[5][0], app: WISHLIST, since: o.chat.observedAt || null,
      source: '營運數據 /api/aihankapps/ops/latest（chatPending）', basis: { pendingCount: o.chat.pendingCount, observedAt: o.chat.observedAt || null } });
    const st = D.sources.store, gen = st && st.ok ? Date.parse(st.generatedAt || '') : 0;
    if (gen && now - gen > 8 * DAY) add('store-stale', 'warn', '商店報表超過一週沒更新', '安裝、下載、收入這幾項停在上一次產生報表的時候（' + Math.floor((now - gen) / DAY) + ' 天前）。', { rule: RULES[6][0], since: gen, go: 'sources', start: gen,
      source: '商店報表 reports/data.js', basis: { generatedAt: gen, daysAgo: Math.floor((now - gen) / DAY) } });
    Object.keys(D.latest.rating || {}).forEach(k => {
      const r = D.latest.rating[k], a = D.BYKEY[k];
      if (a && r && r.value < 4) add('rating-' + a.id, 'warn', a.short + ' 的評分是 ' + r.value.toFixed(1), 'Google Play 評分低於 4.0。', { rule: RULES[7][0], app: k,
        source: '商店報表 reports/data.js（googleRating）', basis: { appKey: k, rating: r.value, date: r.date || null } });
    });
    D.services.forEach(svc => {
      if (svc.now && svc.now.ok === false) add('svc-down-' + svc.id, 'crit', svc.name + ' 沒有回應', '最近一次健康檢查' + (svc.now.status ? '回了 ' + svc.now.status : '連不上或逾時') + '。', { rule: RULES[8][0], apps: svc.apps, since: svc.now.at, go: 'live',
        source: '後台服務檢查 /api/aihankapps/hub/services', basis: { serviceId: svc.id, ok: false, status: svc.now.status == null ? null : svc.now.status, ms: svc.now.ms == null ? null : svc.now.ms, checkedAt: svc.now.at || null } });
    });
    D.infra.forEach(row => {
      const v = row.volume, label = row.project + ' ' + row.name, st = row.deploy && row.deploy.status;
      if (v && v.sizeMb > 0 && v.usedMb / v.sizeMb >= 0.8) {
        const pct = v.usedMb / v.sizeMb * 100;
        add('space-' + row.id, pct >= 95 ? 'crit' : 'warn', label + ' 的空間用了 ' + Math.round(pct) + '%', '已用 ' + mbText(v.usedMb) + '，上限 ' + mbText(v.sizeMb) + '；滿了之後這個服務會寫不進去，要清理資料或在 Railway 加大空間。',
          { rule: RULES[10][0], apps: row.apps, go: 'live', source: 'Railway 後台資源（railway 收集來源）', basis: { serviceId: row.id, service: label, usedMb: v.usedMb, sizeMb: v.sizeMb, percent: Math.round(pct * 10) / 10 } });
      }
      if (st === 'FAILED' || st === 'CRASHED') add('deploy-' + row.id, 'crit', label + (st === 'CRASHED' ? ' 執行中當掉' : ' 部署失敗'),
        '這個服務最新一次部署的狀態是 ' + st + '，可能沒有在提供服務；到 Railway 看部署紀錄。', { rule: RULES[11][0], apps: row.apps, since: row.deploy.at, go: 'live', start: row.deploy.at || null,
          source: 'Railway 後台資源（railway 收集來源）', basis: { serviceId: row.id, service: label, deployStatus: st, deployAt: row.deploy.at || null } });
    });
    const collectors = (D.sources.imports && D.sources.imports.collectors) || {};
    Object.keys(collectors).forEach(id => {
      const c = collectors[id], name = (COLLECTORS[id] || [id])[0];
      if (c.collectedAt && now - c.collectedAt > 36 * HOUR) add('collector-stale-' + id, 'warn', name + '的數據超過一天沒更新', '上一次匯入是 ' + Math.floor((now - c.collectedAt) / HOUR) + ' 小時前；收集工具在這台 Mac 上執行。', { rule: RULES[9][0], since: c.collectedAt, go: 'sources', start: c.collectedAt,
        source: '匯入的後台數據（' + id + '）', basis: { collector: id, collectedAt: c.collectedAt, hoursAgo: Math.floor((now - c.collectedAt) / HOUR) } });
    });
    // 拾光每個帳號的上傳額度與被拒收（伺服器 1.0.126 起；收集工具每小時匯入一次）
    const th = (D.latest.facts || {})[TIMEHUT] || {}, thKeys = Object.keys(th).filter(k => /^thUser[a-f0-9]{10}$/.test(k) && th[k] && th[k].v === 1).sort();
    // LINE 收件的等待時間用這次讀數的時間（thUsersMeta.asOf）算，不用現在：收集停了，等待時間不會一直往上加而誤報
    const thAsOf = Math.min(now, Date.parse((th.thUsersMeta && th.thUsersMeta.asOf) || '') || now), lines = {}, blockedAccounts = {};
    thKeys.forEach(k => { const l = lineState(th[k], thAsOf); if (l) lines[k] = l; });
    const stuckAccounts = Object.keys(lines).filter(k => lines[k].stuck).length;
    Object.keys(lines).forEach(k => lines[k].blocked.forEach(b => { blockedAccounts[b[0]] = (blockedAccounts[b[0]] || 0) + 1; }));
    thKeys.forEach(k => {
      const u = th[k], ref = k.slice(6), name = u.name || '（沒有暱稱）', q = u.quota, rf = u.refusals;
      const codes = ((rf && rf.codes) || []).filter(c => Array.isArray(c) && typeof c[0] === 'string'), recent = codes.filter(c => c[3] && now - c[3] < 2 * HOUR);
      const full = recent.filter(c => D.refusalKind(c[0]) === 'full');
      if (q && q.limit) {
        const used = (q.stored || 0) + (q.pendingBytes || 0), ratio = Math.max(used / q.limit, q.limitItems ? ((q.items || 0) + (q.pending || 0)) / q.limitItems : 0);
        if (ratio >= 0.9 || full.length) add('th-full-' + ref, ratio >= 1 || full.length ? 'crit' : 'warn', full.length ? name + ' 的拾光帳號已滿，上傳被拒收' : name + ' 的拾光雲端空間用了 ' + Math.floor(ratio * 100) + '%',
          '已用 ' + gbText(used) + '，上限 ' + gbText(q.limit) + '；照片 ' + ((q.items || 0) + (q.pending || 0)) + '／' + (q.limitItems || '—') + ' 張。滿了之後這個帳號的新照片一律不收，要放寬每帳號上限（後端 account-upload-admissions.js）或請用戶清理。',
          { rule: RULES[16][0], app: TIMEHUT, since: full.length ? Math.max(...full.map(c => c[3])) : null, source: '時光相簿伺服器 /api/internal/admin-stats（uploadQuota，收集工具每小時匯入）',
            basis: { user: ref, usedBytes: used, limitBytes: q.limit, items: (q.items || 0) + (q.pending || 0), limitItems: q.limitItems || null, ratio: Math.round(ratio * 1000) / 1000, refusedFull: full.map(c => c[0]) } });
      } else if (full.length) add('th-full-' + ref, 'crit', name + ' 的拾光帳號已滿，上傳被拒收', '伺服器拒收的原因是「' + D.refusalText(full[0][0]) + '」。', { rule: RULES[16][0], app: TIMEHUT, since: Math.max(...full.map(c => c[3])),
        source: '時光相簿伺服器 /api/internal/admin-stats（uploadRefusals）', basis: { user: ref, refusedFull: full.map(c => c[0]) } });
      const stuck = recent.filter(c => D.refusalKind(c[0]) === 'stuck'), wait = codes.filter(c => D.refusalKind(c[0]) === 'wait'), today = (rf && rf.today && rf.today.count) || 0;
      const waitRecent = recent.some(c => D.refusalKind(c[0]) === 'wait');
      if (stuck.length || (waitRecent && today > 20)) {
        const top = (stuck.length ? stuck : wait).slice().sort((a, b) => b[1] - a[1])[0];
        add('th-refused-' + ref, 'warn', name + ' 的上傳被伺服器拒收：' + D.refusalText(top[0]),
          (stuck.length ? '這類原因同一筆重送也不會過，要看是哪一筆、為什麼；' : '伺服器忙這類暫時原因，稍後再傳就會過，但現行 App 不會自己重試、會顯示「上傳沒完成」；') + '近 7 天被拒 ' + ((rf.week && rf.week.count) || 0) + ' 次，今天 ' + today + ' 次。伺服器日誌搜尋 [upload-refusal] ' + top[0] + ' account=' + ref + '。',
          { rule: RULES[17][0], app: TIMEHUT, since: top[3] || null, code: top[0], source: '時光相簿伺服器 /api/internal/admin-stats（uploadRefusals，收集工具每小時匯入）',
            basis: { user: ref, today, week: (rf.week && rf.week.count) || 0, recentCodes: recent.map(c => ({ code: c[0], kind: D.refusalKind(c[0]), count7d: c[1], lastAt: c[3] })) } });
      }
      // LINE 收件卡住（還在等，但超過 1 小時沒往下走）與無法處理（停在 blocked，不會自己往下走）
      const l = lines[k];
      if (!l) return;
      const lineSource = '時光相簿伺服器 /api/internal/admin-stats（line.stages／reasons／oldestWaitingAt，收集工具每小時匯入）';
      if (l.stuck) {
        const others = stuckAccounts - 1, stages = l.waitingStages.slice().sort((a, b) => b[1] - a[1]);
        add('th-line-stuck-' + ref, l.age >= 6 * HOUR ? 'crit' : 'warn', name + ' 的 LINE 收件卡住：' + l.waiting + ' 張等了 ' + durText(l.age),
          '有 ' + l.waiting + ' 張 LINE 照片還在收件流程裡（' + stages.map(x => LINE_WAITING[x[0]] + ' ' + x[1]).join('、') + '），最久的一張從 ' + at(l.oldest) + ' 等到讀數時間 ' + at(thAsOf) +
          '。超過 1 小時沒往下走，多半是辨識 worker 或伺服器的收件流程停了' + (others > 0 ? '；另有 ' + others + ' 個帳號也卡住，比較像是整個流程停了' : '') + '。先看即時監控的拾光人物比對 worker，再看伺服器日誌。',
          { rule: RULES[18][0], app: TIMEHUT, since: l.oldest, go: 'live', source: lineSource,
            basis: { user: ref, waiting: l.waiting, waitingStages: Object.fromEntries(l.waitingStages), oldestWaitingAt: l.oldest, readAt: thAsOf, waitedMinutes: Math.floor(l.age / MIN),
              accountsStuck: stuckAccounts, reasons: l.reasons } });
      }
      l.blocked.forEach(b => {
        const code = b[0], kind = code === 'BLOCKED' ? 'unknown' : D.lineBlockedKind(code), others = blockedAccounts[code] - 1;
        add('th-line-blocked-' + ref, 'warn', name + ' 的 LINE 照片無法處理：' + D.lineBlockedText(code),
          '有 ' + b[1] + ' 張 LINE 照片停在這裡，不會自己往下走、也不會進相簿。' + LINE_BLOCKED_WHY[kind] +
          (others > 0 ? '另有 ' + others + ' 個帳號也是同樣原因，比較像是流程壞了。' : '') + (l.processed ? '這個帳號之前有 ' + l.processed + ' 張 LINE 照片處理完。' : ''),
          { rule: RULES[19][0], app: TIMEHUT, code, source: lineSource,
            basis: { user: ref, reason: code, kind, count: b[1], blocked: l.blockedTotal, received: l.received, processedBefore: l.processed, accountsSameReason: blockedAccounts[code],
              lastReceivedAt: l.lastReceivedAt, readAt: thAsOf, reasons: l.reasons } });
      });
    });
    applyInbox(out);
    D.ALERTS = foldMuted(out);
    // 確認（Hank 2026-11-13）：存在伺服器，依通知 ID；附上他寫的對策。確認過的不再算觸發中，側邊欄的點也跟著消失
    const acks = {};
    ((D.inbox && D.inbox.acks) || []).forEach(k => { if (k && k.ref) acks[k.ref] = k; });
    D.ALERTS.forEach(a => { const k = acks[a.ref]; a.ack = k ? { at: k.at || null, plan: k.plan || null, planAt: k.planAt || null } : null; });
  }
  D.isAcked = a => !!(a && a.ack);
  // 以後略過類似警告（Hank 2026-11-13）：同一類（同一個 id）的警示合併成一則資訊；沒有成員時也留著，才能取消略過
  D.muteKey = a => a.id;
  D.mutable = a => !!a && !/^(human|muted|feedback-(eclaw|fraud|beta|timehut-app|timehut-line|discord))$/.test(a.id);
  function foldMuted(list) {
    const mutes = (D.inbox && D.inbox.mutes) || [];
    if (!mutes.length) return list;
    const byType = {};
    mutes.forEach(m => { byType[m.type] = m; });
    const kept = [], groups = {};
    list.forEach(a => { if (byType[D.muteKey(a)] && D.mutable(a)) (groups[D.muteKey(a)] = groups[D.muteKey(a)] || []).push(a); else kept.push(a); });
    mutes.forEach(m => {
      const members = groups[m.type] || [], apps = [];
      members.forEach(a => [a.app].concat(a.apps || []).forEach(k => { if (k && apps.indexOf(k) < 0) apps.push(k); }));
      const first = members.reduce((t, a) => (a.since && (!t || a.since < t) ? a.since : t), null);
      kept.push({ id: 'muted', sev: 'info', title: '已略過：' + m.label + '（目前 ' + members.length + ' 件）',
        detail: members.length ? '這一類不再個別提醒，合併在這裡。' : '目前沒有這一類的警示；之後出現也會收在這裡。',
        rule: RULES[15][0], app: apps.length === 1 ? apps[0] : null, apps: apps.length > 1 ? apps : null, since: first || m.at || null, go: null,
        ref: 'muted-' + String(m.type).replace(/[^A-Za-z0-9._-]/g, '_'), source: '你按的「以後略過類似警告」', triage: null, quote: null, ask: null,
        muted: { type: m.type, label: m.label, at: m.at || null, members: members.map(a => ({ ref: a.ref, title: a.title, detail: a.detail, since: a.since || null, triage: a.triage || null })) },
        basis: { type: m.type, count: members.length, members: members.map(a => a.ref), mutedAt: m.at || null } });
    });
    return kept;
  }
  // 這款 APP 的警示（側邊欄的紅點／黃點就是它們）
  D.alertsFor = a => D.ALERTS.filter(x => x.app === a.key || (x.apps && x.apps.indexOf(a.key) >= 0));
  async function send(method, url, body) {
    const res = await fetch(url, { method: method, credentials: 'same-origin', cache: 'no-store', headers: Object.assign({ Accept: 'application/json' }, body ? { 'Content-Type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined });
    if (!res.ok) { const e = new Error('HTTP ' + res.status); e.status = res.status; throw e; }
    return res.json();
  }
  D.ack = (ref, title, plan) => send('POST', API + '/acks', Object.assign({ ref: ref, title: title }, plan ? { plan: plan } : {}));
  D.unack = ref => send('DELETE', API + '/acks/' + encodeURIComponent(ref));
  D.mute = (type, label, sampleRef) => send('POST', API + '/mutes', { type: type, label: label, sampleRef: sampleRef });
  D.unmute = type => send('DELETE', API + '/mutes/' + encodeURIComponent(type));
  // 畫面上的順序：要 Hank 處理的排最前面，接著是嚴重、警告、資訊；同一級維持算出來的順序
  D.byUrgency = list => {
    const rank = a => (a.triage && a.triage.state === 'human' ? 0 : a.sev === 'crit' ? 1 : a.sev === 'warn' ? 2 : 3);
    return list.map((a, i) => [a, i]).sort((x, y) => rank(x[0]) - rank(y[0]) || x[1] - y[1]).map(x => x[0]);
  };
  // ---- 問題回饋與排程判斷（Hank 2026-11-13）-------------------------------------
  // 每則近 30 天的回報都是一則警示，直到警示處理排程把它結案；排程對任何一則警示的判斷都附在那則警示上：
  // auto＝排程處理中或會自己恢復；human＝只有 Hank 能處理（升成嚴重，寫明要他做什麼）；done＝排程已結案。
  const FB_SOURCE = { eclaw: 'APP 內回報', 'eclaw-health': '被動健康檢查', fraud: 'APP 內回報', beta: '作品集內測回饋', 'timehut-app': 'APP 內回報', 'timehut-line': 'LINE 問題回饋', discord: 'Discord 問題回報' };
  const FB_CATEGORY = { bug: '錯誤', feature: '建議', question: '問題', operation: '操作', rules: '規則', dialogue: '對話', art: '美術', balance: '平衡', other: '其他',
    upload: '照片／影片上傳', line: 'LINE 自動收件', person: '人物辨識', app: 'APP 操作或畫面', account: '帳號與登入', health: '實體自我修復失敗' };
  D.TRIAGE = { auto: '排程處理中', human: '需要你處理', done: '排程已結案' };
  const excerpt = (t, n) => { const s = String(t || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
  const triageOf = n => (n ? { state: n.state, label: D.TRIAGE[n.state], note: n.note, ask: n.ask || null, by: n.by || null, at: n.updatedAt || null } : null);
  function applyInbox(out) {
    const inbox = D.inbox || { feedback: [], notes: [] }, notes = {};
    (inbox.notes || []).forEach(n => { if (n && n.ref) notes[n.ref] = n; });
    const used = {};
    // 1. 排程的判斷附在已經算出來的警示上；需要 Hank 的那則升成嚴重，標題寫明
    out.forEach(a => {
      const n = notes[a.ref];
      if (!n) return;
      used[a.ref] = true;
      a.triage = triageOf(n);
      if (n.state === 'human') { a.sev = 'crit'; a.title = '需要你處理：' + (n.title || a.title); a.ask = n.ask; }
    });
    // 2. 每則回報一則警示；排程結案的不再顯示
    (inbox.feedback || []).forEach(f => {
      const n = notes[f.ref];
      if (n) used[f.ref] = true;
      if (n && n.state === 'done') return;
      const app = D.BYKEY[f.app], name = app ? app.short : f.app, cat = FB_CATEGORY[f.category] || (f.category && f.source !== 'beta' ? f.category : '');
      const what = (FB_SOURCE[f.source] || '問題回饋') + (cat ? '・' + cat : '') + (f.rating ? '・' + f.rating + ' 星' : '');
      const human = n && n.state === 'human';
      out.push({ id: 'feedback-' + f.source, sev: human ? 'crit' : n ? 'info' : 'warn', title: (human ? '需要你處理：' + (n.title || name + ' 的問題回饋') : name + ' 問題回饋：' + what),
        detail: human ? n.ask : excerpt(f.text, 140) || '（沒有文字）', quote: f.text || null, ask: human ? n.ask : null, triage: triageOf(n), rule: RULES[13][0], app: f.app, apps: null,
        since: f.at || null, go: null, ref: f.ref, source: '問題回饋（' + (FB_SOURCE[f.source] || f.source) + '）',
        basis: Object.assign({ source: f.source, category: f.category || null, version: f.version || null, channel: f.channel || null, rating: f.rating || null, hasImage: f.hasImage === true, receivedAt: f.at || null },
          f.entity ? { entity: f.entity, reports24h: f.count } : {}) });
    });
    // 3. 排程自己發的「需要你處理」，以及對應的警示已經消失但還沒結案的
    Object.keys(notes).forEach(ref => {
      const n = notes[ref];
      if (used[ref] || n.state !== 'human') return;
      out.push({ id: 'human', sev: 'crit', title: '需要你處理：' + (n.title || ref), detail: n.ask, ask: n.ask, quote: null, triage: triageOf(n), rule: RULES[14][0],
        app: n.app || null, apps: null, since: n.createdAt || null, go: null, ref: ref, source: '警示處理排程',
        basis: { ref: ref, standalone: n.standalone === true, raisedAt: n.createdAt || null, updatedAt: n.updatedAt || null } });
    });
  }
  D.RULES = RULES;
  D.computeAlerts = computeAlerts;
  // 側欄與列表上的狀態：有還沒確認的警示就顯示警示的等級，否則看有沒有公開上架
  D.appState = function (a) {
    let st = a.stage === 'dev' ? 'dev' : 'live';
    D.ALERTS.forEach(x => { if (!x.ack && (x.app === a.key || (x.apps && x.apps.indexOf(a.key) >= 0)) && (x.sev === 'crit' || (x.sev === 'warn' && st !== 'crit'))) st = x.sev; });
    return st;
  };
  // Claude 訂閱方案的用量（右上角的電池）：收集工具在 Mac 上用 CLI 的本機指令讀，不呼叫模型
  D.quota = function () {
    const c = ((D.sources.imports && D.sources.imports.collectors) || {})['claude-usage'];
    if (!c || !c.quota || !Array.isArray(c.quota.windows) || !c.quota.windows.length) return null;
    return { plan: c.quota.plan || null, windows: c.quota.windows, at: c.collectedAt || null };
  };

  // 收集工具匯入的「目前數字」（玩家總數、近 7 天活躍…），依它給的順序
  D.facts = function (a) {
    const f = (D.latest.facts || {})[a.key] || {};
    return Object.keys(f).filter(k => k !== 'retention' && f[k] && typeof f[k].label === 'string').map(k => Object.assign({ key: k }, f[k])).sort((x, y) => (x.order || 50) - (y.order || 50));
  };
  // 每週註冊的那一批人，之後第 N 天還有多少比例回來
  D.retention = function (a) {
    const r = ((D.latest.facts || {})[a.key] || {}).retention;
    return r && Array.isArray(r.cohorts) && r.cohorts.length ? r : null;
  };
  D.serviceFor = a => D.services.filter(svc => svc.apps.indexOf(a.key) >= 0);
  D.infraFor = a => D.infra.filter(row => (row.apps || []).indexOf(a.key) >= 0);

  // ---- 資料來源一覽 --------------------------------------------------------------
  D.sourceRows = function () {
    const s = D.sources, o = D.ops, iso = i => { const d = new Date(dayT(i) + TZ); return (d.getUTCMonth() + 1) + '/' + d.getUTCDate(); };
    const state = id => (s[id] ? (s[id].ok ? 'ok' : 'crit') : 'crit');
    const st = s.store || {}, storeEnds = st.ends ? [['Google', st.ends.googleInstalls], ['Apple', st.ends.appleDownloads], ['AdMob', st.ends.admobRevenue]].filter(e => e[1]).map(e => e[0] + ' 到 ' + iso(idxOfIso(e[1]))).join('、') : '';
    const opsSeen = Date.parse(o.updatedAt.latestStatus || '') || null, collectors = (s.imports && s.imports.collectors) || {};
    return [
      { name: '商店報表', gives: 'Google Play 安裝、App Store 首次下載、AdMob 收入、當機事件、評分', cover: '有上架的 APP', freq: '每天產生一次', last: Date.parse(st.generatedAt || '') || null, state: state('store'), note: storeEnds || '—' },
      { name: '作品集流量', gives: '作品集瀏覽、介紹頁瀏覽、商店點擊', cover: '全部 APP', freq: '即時累計', last: s.traffic && s.traffic.ok ? D.T0 : null, state: state('traffic'), note: s.traffic && s.traffic.startedAt ? '自 ' + iso(idxOfIso(s.traffic.startedAt)) + ' 起' : '—' },
      { name: '作品集互動', gives: '按讚、留言、內測回饋', cover: '全部 APP', freq: '即時累計', last: s.community && s.community.ok ? D.T0 : null, state: state('community'), note: '只統計數量，不含內容' },
      { name: 'EClaw 帳號', gives: '帳號數、每日新註冊、裝置與實體數', cover: 'EClawbot', freq: '即時', last: s.eclaw && s.eclaw.ok ? D.T0 : null, state: state('eclaw'), note: '裝置與實體數不含測試裝置' },
      { name: 'EClaw 對話', gives: '每日訊息數、活躍裝置', cover: 'EClawbot', freq: '每 10 分鐘重新統計', last: s.eclawChat && s.eclawChat.ok ? s.eclawChat.readAt : null, state: state('eclawChat'), note: s.eclawChat && s.eclawChat.since ? '自 ' + iso(idxOfIso(s.eclawChat.since)) + ' 起' : '—' },
      { name: '夢話夥伴後台', gives: '對話回合、活躍裝置、廣告獎勵次數', cover: '夢話夥伴', freq: '即時', last: s.dreambuddy && s.dreambuddy.ok ? D.T0 : null, state: state('dreambuddy'), note: s.dreambuddy && s.dreambuddy.startedAt ? '自 ' + iso(idxOfIso(s.dreambuddy.startedAt)) + ' 起' : '還沒有紀錄' },
      { name: '問題回饋', gives: 'APP 內送出的問題回饋件數', cover: '詐騙帝國', freq: '即時', last: s.feedback && s.feedback.ok ? D.T0 : null, state: state('feedback'), note: '只統計數量，不含內容' },
      { name: '問題回饋與排程判斷', gives: '近 30 天每一則問題回饋的內容（每則一個警示），以及警示處理排程對每則警示的判斷', cover: 'EClawbot、詐騙帝國、作品集內測回饋（全部 APP）、拾光AI雲端相簿（APP 內與 LINE，由排程匯入）',
        freq: '即時；拾光的回報每 15 分鐘匯入', last: s.inbox && s.inbox.ok ? D.T0 : null, state: state('inbox'),
        note: s.inbox && s.inbox.partial && s.inbox.partial.length ? '讀不到：' + s.inbox.partial.join('、') : '只有管理者看得到回報內容' },
      { name: '營運數據', gives: 'AI worker 的 CPU、記憶體、完成件數；Wishlist 上架數、公開可見數、聊聊待問', cover: 'Wishlist.ai、時光相簿、夢話夥伴', freq: '每 5 到 30 分鐘', last: opsSeen, state: o.ok ? 'ok' : 'crit', note: '與公開的「營運數據」頁同一份資料' },
      { name: 'EClaw 付款', gives: '刷卡成功與儲值付款的筆數與金額', cover: 'EClawbot', freq: '即時', last: s.eclawPayments && s.eclawPayments.ok ? D.T0 : null, state: state('eclawPayments'), note: '不含失敗與已退款' },
      { name: '後台服務檢查', gives: '每個後台有沒有回應、回應時間、可用率', cover: D.services.length + ' 個後台服務', freq: '每分鐘', last: D.services.reduce((m, svc) => Math.max(m, (svc.now && svc.now.at) || 0), 0) || null, state: state('services'), note: '由 EClaw 主站去問各後台公開的健康檢查網址' }
    ].concat(Object.keys(COLLECTORS).map(id => {
      const c = collectors[id], stale = c && D.T0 - c.collectedAt > 36 * HOUR;
      return { name: COLLECTORS[id][0], gives: COLLECTORS[id][2] || '新用戶、每日活躍、對局、內購筆數、信箱、留存', cover: COLLECTORS[id][1], freq: id === 'railway' || id === 'wishlist-users' || id === 'claude-usage' ? '每小時' : id === 'feedback-discord' ? '每 2 分鐘' : id.indexOf('feedback-') === 0 ? '每 15 分鐘' : '每天 06:20', last: c ? c.collectedAt : null,
        state: !s.imports || !s.imports.ok ? 'crit' : !c ? 'none' : stale ? 'warn' : 'ok', note: !c ? '還沒有匯入過' : stale ? '超過一天沒更新；收集工具在這台 Mac 上執行' : ((c.notes || [])[0] || COLLECTORS[id][3] || '只匯入彙總數字，不含任何帳號或內容') };
    })).concat([
      { name: '其他 APP 的使用紀錄', gives: '活躍用戶、留存', cover: '沒有自己伺服器的 APP', freq: '—', last: null, state: 'none', note: '這些 APP 不會回報使用情況，要在 APP 裡加上回報再發新版才會有' },
      { name: '商店的內購金額', gives: 'Google Play 與 App Store 的實際銷售金額', cover: '有內購的 APP', freq: '—', last: null, state: 'none', note: '商店報表目前只收廣告收入；遊戲後台只記內購筆數' }
    ]);
  };

  global.HubData = D;
})(window);
