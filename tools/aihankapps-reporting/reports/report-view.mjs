export const FIELDS = {
  googleInstalls: { label: 'Google 使用者安裝', unit: '次', platform: 'google' },
  appleDownloads: { label: 'Apple 首次下載', unit: '單位', platform: 'apple' },
  combinedAcquisition: { label: '雙平台下載合計（趨勢參考）', unit: '單位', platform: 'combined', summary: false },
  admobRevenue: { label: 'AdMob 預估收益', unit: 'TWD', platform: 'admob' },
  crashRate: { label: 'Google 當機率', unit: '%', platform: 'google', aggregation: 'last', cumulative: false },
  anrRate: { label: 'Google ANR 率', unit: '%', platform: 'google', aggregation: 'last', cumulative: false },
};

export function combinedAcquisition(app) {
  const byDate = new Map();
  for (const metric of [app.googleInstalls, app.appleDownloads]) {
    for (const point of metric.points) {
      if (point.value === null || point.value === undefined) continue;
      byDate.set(point.date, (byDate.get(point.date) || 0) + point.value);
    }
  }
  const points = [...byDate].sort(([a], [b]) => a.localeCompare(b)).map(([date, value]) => ({ date, value }));
  return {
    points,
    historyTotal: points.length ? points.reduce((sum, point) => sum + point.value, 0) : null,
    historyStart: points[0]?.date || null,
    historyEnd: points.at(-1)?.date || null,
  };
}

const DAY = 86400000;
const number = new Intl.NumberFormat('zh-TW', { maximumFractionDigits: 2 });
const money = new Intl.NumberFormat('zh-TW', { style: 'currency', currency: 'TWD', minimumFractionDigits: 2, maximumFractionDigits: 4 });

export function formatValue(value, field, fallback = '官方資料待補') {
  if (value === null || value === undefined || !Number.isFinite(value)) return fallback;
  if (field === 'admobRevenue' && value !== 0 && Math.abs(value) < 0.0001) return value < 0 ? '> -NT$0.0001' : '< NT$0.0001';
  if (field === 'admobRevenue') return money.format(value).replace(/^(-?)\$/, '$1NT$');
  return field === 'crashRate' || field === 'anrRate' ? `${number.format(value)}%` : number.format(value);
}

export function pointMarkerVisible(points, index, mode) {
  const point = points[index];
  return Boolean(point && ((!points[index - 1] && !points[index + 1]) || (mode === 'daily' && (!points[index - 1]?.complete || !point.complete || !points[index + 1]))));
}

export function chartFrame(pixelWidth, field = 'combinedAcquisition') {
  const measured = Number.isFinite(pixelWidth) && pixelWidth > 0 ? pixelWidth : 1428;
  const compact = measured < 1000;
  const width = compact ? measured : 1428;
  const left = compact && field === 'admobRevenue' ? 72 : 40;
  return { width, height: 273, left, span: Math.max(1, width - left - 30), gridRight: width - 10, ticks: compact ? (width < 480 ? 3 : 5) : 8 };
}

export function automaticGranularity(start, end) {
  const days = Math.floor((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / DAY) + 1;
  if (!Number.isFinite(days) || days < 1 || days <= 92) return 'day';
  if (days <= 180) return 'week';
  if (days <= 730) return 'month';
  if (days <= 2190) return 'quarter';
  return 'year';
}

function weekStart(date) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() - ((value.getUTCDay() + 6) % 7));
  return value.toISOString().slice(0, 10);
}

function bucketKey(date, granularity) {
  if (granularity === 'day') return date;
  if (granularity === 'week') return `週 ${weekStart(date)}`;
  if (granularity === 'month') return date.slice(0, 7);
  if (granularity === 'quarter') return `${date.slice(0, 4)} Q${Math.floor((Number(date.slice(5, 7)) - 1) / 3) + 1}`;
  return date.slice(0, 4);
}

export function chartBuckets(apps, field, granularity, start, end, options = {}) {
  if (!FIELDS[field] || !['day', 'week', 'month', 'quarter', 'year'].includes(granularity)) throw new Error('Invalid chart metric');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || start > end) return [];
  const first = Date.parse(`${start}T00:00:00Z`), last = Date.parse(`${end}T00:00:00Z`);
  if (!Number.isFinite(first) || !Number.isFinite(last) || (last - first) / DAY > 36600) return [];
  const groups = new Map();
  for (let day = first; day <= last; day += DAY) {
    const date = new Date(day).toISOString().slice(0, 10);
    const key = bucketKey(date, granularity);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(date);
  }
  const lookups = apps.map(app => new Map(app[field].points.map(point => [point.date, point.value])));
  const running = apps.map(app => app[field].points
    .filter(point => point.date < start && point.value !== null && point.value !== undefined)
    .reduce((sum, point) => sum + point.value, 0));
  const observed = apps.map(app => app[field].points.some(point => point.date < start && point.value !== null && point.value !== undefined));
  return [...groups].map(([label, days]) => ({
    label,
    start: days[0],
    end: days.at(-1),
    values: apps.map((app, index) => {
      const values = days.map(day => lookups[index].get(day)).filter(value => value !== null && value !== undefined);
      if (options.cumulative) {
        if (values.length) observed[index] = true;
        running[index] += values.reduce((sum, value) => sum + value, 0);
        return { id: app.id, value: observed[index] ? running[index] : null, coveredDays: values.length, expectedDays: days.length };
      }
      const value = FIELDS[field].aggregation === 'last' ? values.at(-1) : values.reduce((sum, item) => sum + item, 0);
      return { id: app.id, value: values.length ? value : null, coveredDays: values.length, expectedDays: days.length };
    }),
  }));
}

export function missingReason(app, field) {
  if (field === 'appleDownloads' && !app.platforms.apple) return '不適用';
  if (['googleInstalls', 'crashRate', 'anrRate', 'rating'].includes(field) && !app.platforms.google) return '不適用';
  if (field === 'rating') return 'Google 評分報表尚未涵蓋';
  if (field === 'admobRevenue') return '尚無可歸屬廣告資料';
  if (field === 'crashRate' || field === 'anrRate') return '樣本量不足，Google 尚未提供率';
  return '官方報表尚未涵蓋';
}

export function sortApps(apps, key, direction = 'desc') {
  const value = app => key === 'name' || key === 'category' ? app[key] : key === 'rating' ? app.googleRating?.value ?? null : app[key]?.historyLatest ?? app[key]?.historyTotal ?? null;
  return [...apps].sort((a, b) => {
    const av = value(a), bv = value(b);
    if (av === null && bv === null) return a.name.localeCompare(b.name, 'zh-TW');
    if (av === null) return 1;
    if (bv === null) return -1;
    const comparison = typeof av === 'string' ? av.localeCompare(bv, 'zh-TW') : av - bv;
    return (direction === 'asc' ? comparison : -comparison) || a.name.localeCompare(b.name, 'zh-TW');
  });
}


export function nearestSeries(series, x, y, threshold = 18) {
  let nearest = null;
  for (const line of series) {
    for (let i = 0; i < line.points.length; i++) {
      const b = line.points[i];
      if (!b) continue;
      const a = (!b.breakBefore && line.points[i - 1]) || b;
      const dx = b.x - a.x, dy = b.y - a.y;
      const ratio = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy || 1)));
      const distance = Math.hypot(x - a.x - ratio * dx, y - a.y - ratio * dy);
      if (distance <= threshold && (!nearest || distance < nearest.distance)) {
        nearest = { id: line.id, index: ratio < 0.5 && a !== b ? i - 1 : i, distance };
      }
    }
  }
  return nearest;
}

// The overview uses the same observed totals as its line. Close each observed
// segment separately, never filling across missing history or inventing zeros.
export function overviewAreaPath(values) {
  const peak = Math.max(1, ...values.filter(Number.isFinite));
  let path = '', start = null, last = null;
  const close = () => {
    if (start !== null) path += ` L${last},33 L${start},33 Z `;
    start = null;
  };
  values.forEach((value, index) => {
    if (!Number.isFinite(value)) { close(); return; }
    const x = index * 1428 / Math.max(1, values.length - 1);
    const y = 33 - value / peak * 29;
    if (start === null) { start = x; path += `M${x},33 L${x},${y}`; }
    else path += ` L${x},${y}`;
    last = x;
  });
  close();
  return path.trim();
}

export function reviewHasIssue(review) {
  return /當機|閃退|崩潰|卡死|無法登入|無法啟動|無法開啟|扣款|重複收費|crash|freez|not\s+(?:open|work)|can't\s+(?:open|login)|cannot\s+(?:open|login)|charged\s+twice/i.test(`${review.title || ''} ${review.body || ''}`);
}

export function filterReviews(reviews, filters = {}, names = {}) {
  const query = (filters.query || '').trim().toLocaleLowerCase();
  return reviews.filter(review =>
    (!filters.app || filters.app === 'all' || review.appId === filters.app) &&
    (!filters.platform || filters.platform === 'all' || review.platform === filters.platform) &&
    (!filters.rating || filters.rating === 'all' || (filters.rating === 'unrated' ? review.rating === null : review.rating === Number(filters.rating))) &&
    (filters.issues !== 'issues' || reviewHasIssue(review)) &&
    (!query || `${names[review.appId] || ''} ${review.author || ''} ${review.title || ''} ${review.body || ''}`.toLocaleLowerCase().includes(query))
  ).sort((a, b) => {
    if (filters.sort === 'rating-asc' || filters.sort === 'rating-desc') {
      if (a.rating === null && b.rating !== null) return 1;
      if (b.rating === null && a.rating !== null) return -1;
      if (a.rating !== b.rating) return (filters.sort === 'rating-asc' ? 1 : -1) * (a.rating - b.rating);
    }
    return (filters.sort === 'oldest' ? 1 : -1) * a.date.localeCompare(b.date) || `${a.appId}:${a.id}`.localeCompare(`${b.appId}:${b.id}`);
  });
}

export async function loadCommunityReviews(appIds, fetcher = globalThis.fetch, base = 'https://eclawbot.com/api/app-portfolio') {
  const items = [], failures = [], partial = [], totals = {};
  let cursor = 0;
  async function worker() {
    while (cursor < appIds.length) {
      const appId = appIds[cursor++];
      let before = null;
      const seen = new Set(), ids = new Set();
      try {
        for (let page = 0; page < 500; page++) {
          const response = await fetcher(`${base}/apps/${encodeURIComponent(appId)}/community${before ? `?before=${encodeURIComponent(before)}` : ''}`, { credentials: 'omit', signal: AbortSignal.timeout(12000) });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const data = await response.json();
          if (data.success !== true || !Array.isArray(data.comments) || !Number.isInteger(data.commentCount) || data.commentCount < 0) throw new Error('Invalid community response');
          totals[appId] = data.commentCount;
          for (const row of data.comments) {
            const date = new Date(row.createdAt);
            if (typeof row.id !== 'string' || !/^\d+$/.test(row.id) || typeof row.content !== 'string' || !Number.isFinite(date.getTime())) throw new Error('Invalid public comment');
            if (ids.has(row.id)) continue;
            ids.add(row.id);
            items.push({ id: row.id, appId, platform: 'community', author: String(row.nickname || '訪客').slice(0, 30), title: '', body: row.content.slice(0, 500), rating: null, date: date.toISOString(), version: null });
          }
          if (!data.nextCursor) {
            if (data.commentCount > ids.size || (data.nextCursor === undefined && data.comments.length >= 50)) partial.push(appId);
            break;
          }
          if (typeof data.nextCursor !== 'string' || !/^[1-9]\d{0,18}$/.test(data.nextCursor) || seen.has(data.nextCursor)) throw new Error('Invalid or repeated cursor');
          seen.add(data.nextCursor); before = data.nextCursor;
          if (page === 499) partial.push(appId);
        }
      } catch { failures.push(appId); }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, appIds.length) }, worker));
  return { items, failures, partial, totals };
}

if (typeof document !== 'undefined') {
  const report = window.AIHANK_REPORT;
  const byId = id => document.getElementById(id);
  const text = (id, value) => { if (byId(id)) byId(id).textContent = value; };
  const node = (tag, className, value) => {
    const result = document.createElement(tag);
    if (className) result.className = className;
    if (value !== undefined) result.textContent = value;
    return result;
  };
  if (!report || report.schemaVersion !== 2) {
    text('data-mode', 'APP 趨勢尚未載入');
    text('report-period', '資料版本不符或下載失敗，請重新整理；缺資料不以零代替。');
  } else {
    const palette = ['#227254', '#a8753d', '#487fa3', '#805c86', '#688b7b', '#c28f31', '#916151', '#507a92', '#7f8260', '#8c6ba8', '#ba7464', '#365d4b', '#b1925a', '#6e8e96', '#869450', '#a46a8b'];
    const catalog = new Map((window.AIHANK_APP_CATALOG?.apps || []).map(app => [app.communityId, app]));
    report.apps.forEach(app => { app.combinedAcquisition = combinedAcquisition(app); });
    const apps = report.apps;
    const names = Object.fromEntries(apps.map(app => [app.id, app.name]));
    const preferred = ['stray-map', 'chumen', 'eclawbot', 'rebound', 'typeforge-twin-cities', 'weesh'];
    const featured = preferred.map(id => apps.find(app => app.id === id)).filter(Boolean);
    const colors = new Map([...featured, ...apps.filter(app => !preferred.includes(app.id))].map((app, index) => [app.id, palette[index % palette.length]]));
    const selected = new Set(apps.map(app => app.id));
    const dates = apps.flatMap(app => Object.keys(FIELDS).flatMap(field => app[field].points.map(point => point.date))).sort();
    const calendar = [];
    for (let date = Date.parse(`${dates[0] || report.period.start}T00:00:00Z`), end = Date.parse(`${report.period.end}T00:00:00Z`); date <= end; date += DAY) calendar.push(new Date(date).toISOString().slice(0, 10));
    if (!calendar.length) calendar.push(report.period.end);
    const state = { field: 'combinedAcquisition', mode: 'cumulative', start: Math.max(0, calendar.length - 61), end: calendar.length - 1, sort: 'googleInstalls', direction: 'desc', pinned: false, focus: null };
    const overviewDomain = { start: Math.max(0, calendar.length - Math.ceil(61 * 2.5)), end: calendar.length - 1 };
    const filters = { query: '', app: 'all', platform: 'all', rating: 'all', sort: 'newest', issues: 'all' };
    let reviews = report.reviews?.items || [], communityState = null, reviewLimit = 4;
    function icon(app) {
      const source = catalog.get(app.id)?.icon;
      if (!source || /^(?:javascript:|data:|\/\/|http:)/i.test(source)) return node('span', 'icon-fallback', app.name.slice(0, 1));
      const image = node('img', 'app-icon'); image.alt = ''; image.loading = 'lazy';
      image.src = /^https:\/\//.test(source) ? source : `../${source.replace(/^\/+/, '')}`;
      image.addEventListener('error', () => image.replaceWith(node('span', 'icon-fallback', app.name.slice(0, 1))), { once: true });
      return image;
    }
    const sum = field => {
      const values = apps.map(app => app[field].historyTotal).filter(value => value !== null && value !== undefined);
      return values.length ? values.reduce((a, b) => a + b, 0) : null;
    };
    text('data-mode', '每日同步 · 官方真實資料');
    text('report-period', `更新 ${new Date(report.generatedAt).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })} · 資料截至 ${report.period.end}`);
    text('acquisition-value', formatValue(sum('combinedAcquisition'), 'combinedAcquisition', '官方資料待補'));
    text('googleInstalls-value', formatValue(sum('googleInstalls'), 'googleInstalls', '資料待補'));
    text('appleDownloads-value', formatValue(sum('appleDownloads'), 'appleDownloads', '資料待補'));
    text('acquisition-status', '已取得歷史總和 · 雙平台定義不同');
    text('admobRevenue-value', formatValue(report.totals.admobRevenue.historyTotal, 'admobRevenue', '廣告資料待補'));
    text('admobRevenue-coverage', '已取得歷史預估收益 · 非結算金額');
    for (const field of ['crashRate', 'anrRate']) {
      const value = report.totals[field]?.last7?.value;
      text(`${field}-value`, formatValue(value, field, '樣本不足'));
      byId(`${field}-value`).classList.toggle('is-pending', value === null || value === undefined);
      byId(`${field}-value`).title = '最近統計期間，各 APP 已回傳率的最大值；不是全 APP 平均';
    }
    text('stability-status', report.totals.crashRate?.last7?.value == null && report.totals.anrRate?.last7?.value == null ? '樣本不足' : '部分資料');
    byId('stability-status').title = '當機與 ANR 分列；小樣本不以 0 代替。';
    text('unallocated', `未歸屬廣告历史收益：${formatValue(report.totals.unallocatedRevenue.historyTotal, 'admobRevenue', '尚無資料')}。${report.coverage.unallocatedAdmobAppCount} 個廣告應用程式待確認對應，已保留在總收益中。`);
    text('coverage-note', '歷史總計只包含已取得官方資料，非保證上架以來全部。Google 使用者安裝與 Apple 首次下載定義不同，合計僅供趨勢參考；空白期間不補零。當機及 ANR 為 Google 回傳的使用者百分比，小樣本保持缺值。');

    const legend = byId('trend-legend'), picker = byId('app-options');
    const buttons = new Map();
    function appButton(app, parent) {
      const button = node('button', 'legend-button'); button.type = 'button';
      button.append(icon(app), node('span', '', app.name)); button.style.setProperty('--series-color', colors.get(app.id)); button.setAttribute('aria-pressed', 'true');
      button.addEventListener('click', () => {
        selected.has(app.id) ? selected.delete(app.id) : selected.add(app.id);
        syncButtons(); draw();
      });
      if (!buttons.has(app.id)) buttons.set(app.id, []);
      buttons.get(app.id).push(button); parent.append(button);
    }
    featured.forEach(app => appButton(app, legend)); apps.forEach(app => appButton(app, picker));
    function syncButtons() {
      for (const [id, list] of buttons) for (const button of list) { button.classList.toggle('is-off', !selected.has(id)); button.setAttribute('aria-pressed', String(selected.has(id))); }
    }
    byId('select-all-apps').addEventListener('click', () => { apps.forEach(app => selected.add(app.id)); syncButtons(); draw(); });
    byId('clear-apps').addEventListener('click', () => { selected.clear(); syncButtons(); draw(); });

    const svg = byId('trend-chart'), tooltip = byId('trend-tooltip'), slider = byId('period-cursor');
    let buckets = [], series = [], drag = null;
    let frame = chartFrame(svg.getBoundingClientRect().width, state.field);
    function shape(tag, attrs, value, parent = svg) {
      const result = document.createElementNS('http://www.w3.org/2000/svg', tag);
      for (const [key, val] of Object.entries(attrs)) result.setAttribute(key, val);
      if (value !== undefined) result.textContent = value;
      parent.append(result); return result;
    }
    function range() { return { start: calendar[state.start], end: calendar[state.end] }; }
    function setRange(start, end) {
      const last = calendar.length - 1;
      state.start = Math.max(0, Math.min(last, Math.round(start)));
      state.end = Math.max(state.start, Math.min(last, Math.round(end)));
      overviewDomain.start = Math.min(overviewDomain.start, state.start);
      overviewDomain.end = Math.max(overviewDomain.end, state.end);
      state.pinned = false; state.focus = null; draw();
    }
    function highlight(id) {
      for (const [appId, list] of buttons) for (const button of list) button.classList.toggle('is-highlighted', appId === id);
      svg.querySelectorAll('.series-line,.series-dot').forEach(item => {
        item.style.opacity = id && item.dataset.appId !== id ? '.18' : '1';
        if (item.classList.contains('series-line')) item.setAttribute('stroke-width', item.dataset.appId === id ? '3.5' : '2');
      });
    }
    function hideTooltip() { tooltip.hidden = true; state.focus = null; highlight(null); svg.querySelectorAll('.chart-crosshair,.focus-dot').forEach(item => item.remove()); }
    function showTooltip(hit) {
      if (!hit) { if (!state.pinned) hideTooltip(); return; }
      const app = apps.find(item => item.id === hit.id), bucket = buckets[hit.index], line = series.find(item => item.id === hit.id), point = line?.points[hit.index];
      if (!app || !bucket || !point) return;
      state.focus = { id: hit.id, index: hit.index }; highlight(hit.id);
      slider.value = hit.index;
      svg.querySelectorAll('.chart-crosshair,.focus-dot').forEach(item => item.remove());
      shape('line', { x1: point.x, x2: point.x, y1: 18, y2: 244, class: 'chart-crosshair', stroke: colors.get(hit.id), 'stroke-dasharray': '3 4', opacity: '.4' });
      shape('circle', { cx: point.x, cy: point.y, r: 5, class: 'focus-dot', fill: colors.get(hit.id), stroke: '#fff', 'stroke-width': 2 });
      tooltip.replaceChildren();
      const heading = node('div', 'tooltip-title'); heading.append(icon(app), node('strong', '', app.name));
      const pin = node('button', 'pin-control', state.pinned ? '取消固定' : '固定'); pin.type = 'button';
      pin.addEventListener('click', () => { state.pinned = !state.pinned; showTooltip(state.focus); }); heading.append(pin);
      tooltip.append(heading, node('div', 'tooltip-date', bucket.start === bucket.end ? bucket.start : `${bucket.start} 至 ${bucket.end}`));
      const value = bucket.values.find(item => item.id === app.id);
      tooltip.append(node('div', 'tooltip-value', `${state.mode === 'cumulative' ? '累計 ' : ''}${formatValue(value.value, state.field)}${FIELDS[state.field].unit === '%' || state.field === 'admobRevenue' ? '' : ' 次'}`));
      if (state.field === 'combinedAcquisition') {
        const platformValues = [];
        for (const field of ['googleInstalls', 'appleDownloads']) {
          const matching = chartBuckets([app], field, automaticGranularity(range().start, range().end), range().start, range().end, { cumulative: state.mode === 'cumulative' })[hit.index]?.values[0];
          platformValues.push(`${field === 'googleInstalls' ? 'Google Play' : 'App Store'} ${formatValue(matching?.value, field, missingReason(app, field))}`);
        }
        tooltip.append(node('div', 'tooltip-source', platformValues.join(' · ')));
      }
      tooltip.append(node('div', 'tooltip-coverage', `本區間 ${value.coveredDays}/${value.expectedDays} 日有資料${value.coveredDays < value.expectedDays ? ' · 缺資料未補零' : ''}`));
      text('point-detail', `${app.name} ${bucket.label} ${formatValue(value.value, state.field)}`);
      const box = svg.getBoundingClientRect(), container = tooltip.offsetParent?.getBoundingClientRect() || box;
      tooltip.hidden = false;
      tooltip.style.left = `${Math.max(8, Math.min(container.width - tooltip.offsetWidth - 8, box.left - container.left + point.x / frame.width * box.width - tooltip.offsetWidth - 28))}px`;
      tooltip.style.top = '-8px';
    }
    function draw() {
      hideTooltip();
      frame = chartFrame(svg.getBoundingClientRect().width, state.field);
      svg.setAttribute('viewBox', `0 0 ${frame.width} ${frame.height}`);
      const visible = range(), grain = automaticGranularity(visible.start, visible.end);
      buckets = chartBuckets(apps, state.field, grain, visible.start, visible.end, { cumulative: state.mode === 'cumulative' });
      svg.replaceChildren(); series = [];
      text('auto-granularity', ({ day: '每日', week: '每週', month: '每月', quarter: '每季', year: '每年' })[grain]);
      text('range-display', `${visible.start} — ${visible.end}`);
      text('chart-caption', `${FIELDS[state.field].label}，${state.mode === 'cumulative' ? '累計已取得歷史總和' : '區間變化'}。移過線條識別 APP，點擊固定，方向鍵切換點或 APP，Enter 固定，Escape 關閉。空心點表示涵蓋不完整，缺資料不補零。`);
      slider.max = Math.max(0, buckets.length - 1);
      const values = buckets.flatMap(bucket => bucket.values.filter(value => selected.has(value.id) && value.value !== null).map(value => value.value));
      const min = Math.min(0, ...values), max = Math.max(1, ...values);
      const x = index => frame.left + (buckets.length === 1 ? frame.span / 2 : index * frame.span / (buckets.length - 1));
      const y = value => 238 - (value - min) * 219 / (max - min);
      for (let i = 0; i <= 4; i++) {
        const value = min + (max - min) * i / 4;
        shape('line', { x1: frame.left, x2: frame.gridRight, y1: y(value), y2: y(value), stroke: '#d5dce2', 'stroke-width': .7, opacity: .8 });
        shape('text', { x: frame.left - 11, y: y(value) + 4, 'text-anchor': 'end', fill: '#617488', 'font-size': 12 }, formatValue(value, state.field));
      }
      const step = Math.max(1, Math.ceil(buckets.length / frame.ticks));
      buckets.forEach((bucket, index) => { if (index % step === 0 || index === buckets.length - 1) shape('text', { x: x(index), y: 264, 'text-anchor': index === buckets.length - 1 ? 'end' : index === 0 ? 'start' : 'middle', fill: '#617488', 'font-size': 12 }, grain === 'day' ? `${Number(bucket.start.slice(5, 7))}/${Number(bucket.start.slice(8))}` : bucket.label); });
      apps.forEach((app, appIndex) => {
        if (!selected.has(app.id)) return;
        const points = buckets.map((bucket, index) => {
          const value = bucket.values[appIndex];
          return value.value === null ? null : { x: x(index), y: y(value.value), complete: value.coveredDays === value.expectedDays };
        });
        let path = '', connected = false;
        points.forEach(point => {
          if (!point) { connected = false; return; }
          path += `${connected ? 'L' : 'M'}${point.x},${point.y} `;
          connected = state.mode === 'cumulative' || point.complete;
        });
        const line = shape('path', { d: path, fill: 'none', stroke: colors.get(app.id), 'stroke-width': 2, class: 'series-line', 'data-app-id': app.id, 'pointer-events': 'none' });
        shape('title', {}, app.name, line);
        points.forEach((point, index) => { if (pointMarkerVisible(points, index, state.mode)) shape('circle', { cx: point.x, cy: point.y, r: 2.2, fill: point.complete ? colors.get(app.id) : '#fefcf9', stroke: colors.get(app.id), 'stroke-width': 1, class: 'series-dot', 'data-app-id': app.id }); });
        // Do not hit-test across daily data gaps that were not drawn as connected.
        const hitPoints = points.map((point, index) => point && { ...point, breakBefore: index > 0 && state.mode !== 'cumulative' && !points[index - 1]?.complete });
        series.push({ id: app.id, points: hitPoints });
      });
      if (!values.length) shape('text', { x: frame.width / 2 + (frame.width === 1428 ? 18 : 0), y: 140, 'text-anchor': 'middle', fill: '#7b8179', 'font-size': frame.width < 480 ? 12 : 16 }, '此區間尚無官方資料，或尚未選擇 APP');
      const overview = byId('range-overview'); overview.replaceChildren();
      const all = chartBuckets(apps, state.field, automaticGranularity(calendar[overviewDomain.start], calendar[overviewDomain.end]), calendar[overviewDomain.start], calendar[overviewDomain.end], { cumulative: state.mode === 'cumulative' });
      const totals = all.map(bucket => { const found = bucket.values.filter(v => selected.has(v.id) && v.value !== null); return found.length ? found.reduce((sum, v) => sum + v.value, 0) : null; });
      const peak = Math.max(1, ...totals.filter(value => value !== null)); let path = '', previous = false;
      totals.forEach((value, index) => { if (value === null) { previous = false; return; } path += `${previous ? 'L' : 'M'}${index * 1428 / Math.max(1, totals.length - 1)},${33 - value / peak * 29} `; previous = true; });
      shape('path', { d: overviewAreaPath(totals), fill: '#aebfc9', 'fill-opacity': .16, stroke: 'none' }, undefined, overview);
      shape('path', { d: path, fill: 'none', stroke: '#9eafbc', 'stroke-width': 1.2 }, undefined, overview);
      for (const key of ['start', 'end']) { byId(`range-${key}`).min = overviewDomain.start; byId(`range-${key}`).max = overviewDomain.end; byId(`range-${key}`).value = state[key]; byId(`range-${key}`).setAttribute('aria-valuetext', calendar[state[key]]); }
      byId('range-window').style.left = `${(state.start - overviewDomain.start) / Math.max(1, overviewDomain.end - overviewDomain.start) * 100}%`;
      byId('range-window').style.width = `${Math.max(0.5, (state.end - state.start) / Math.max(1, overviewDomain.end - overviewDomain.start) * 100)}%`;
    }
    function position(event) {
      const box = svg.getBoundingClientRect();
      return { x: (event.clientX - box.left) / box.width * frame.width, y: (event.clientY - box.top) / box.height * frame.height };
    }
    function hit(event) {
      const box = svg.getBoundingClientRect();
      return nearestSeries(series.map(line => ({ id: line.id, points: line.points.map(point => point && { ...point, x: point.x / frame.width * box.width, y: point.y / frame.height * box.height }) })), event.clientX - box.left, event.clientY - box.top, 18);
    }
    svg.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      drag = { id: event.pointerId, x: event.clientX, start: state.start, end: state.end, moved: false };
      svg.setPointerCapture(event.pointerId);
    });
    svg.addEventListener('pointermove', event => {
      if (drag?.id === event.pointerId && Math.abs(event.clientX - drag.x) > 5) {
        drag.moved = true;
        const delta = Math.round((drag.x - event.clientX) / svg.getBoundingClientRect().width * (drag.end - drag.start + 1));
        const size = drag.end - drag.start, start = Math.max(0, Math.min(calendar.length - size - 1, drag.start + delta));
        setRange(start, start + size); return;
      }
      if (!state.pinned) showTooltip(hit(event));
    });
    svg.addEventListener('pointerleave', event => {
      if (!state.pinned && !drag && !tooltip.contains(event.relatedTarget)) hideTooltip();
    });
    tooltip.addEventListener('pointerleave', event => {
      if (!state.pinned && !drag && !svg.contains(event.relatedTarget)) hideTooltip();
    });
    tooltip.addEventListener('click', event => {
      // The tooltip may cover the hovered line; clicking its body pins the same APP.
      // Its explicit pin button owns its own toggle, avoiding a double toggle.
      if (!event.target.closest('.pin-control') && state.focus) { state.pinned = true; showTooltip(state.focus); }
    });
    svg.addEventListener('pointerup', event => {
      if (!drag || drag.id !== event.pointerId) return;
      if (!drag.moved) { const value = hit(event); if (value) { state.pinned = !(state.pinned && state.focus?.id === value.id && state.focus?.index === value.index); showTooltip(value); } else { state.pinned = false; hideTooltip(); } }
      drag = null;
    });
    svg.addEventListener('pointercancel', () => { drag = null; });
    svg.addEventListener('wheel', event => {
      if (calendar.length < 2) return;
      event.preventDefault();
      const size = state.end - state.start + 1, next = Math.max(Math.min(3, calendar.length), Math.min(calendar.length, Math.round(size * (event.deltaY > 0 ? 1.35 : .72))));
      const anchor = Math.max(0, Math.min(1, (position(event).x - frame.left) / frame.span));
      const start = Math.max(0, Math.min(calendar.length - next, Math.round(state.start + anchor * (size - 1) - anchor * (next - 1))));
      setRange(start, start + next - 1);
    }, { passive: false });
    svg.addEventListener('keydown', event => {
      if (event.key === 'Escape') { state.pinned = false; hideTooltip(); return; }
      const populated = series.filter(line => line.points.some(Boolean));
      if (!populated.length || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter'].includes(event.key)) return;
      event.preventDefault();
      let appIndex = Math.max(0, populated.findIndex(line => line.id === state.focus?.id));
      let index = state.focus?.index ?? buckets.length - 1;
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') appIndex = (appIndex + (event.key === 'ArrowDown' ? 1 : populated.length - 1)) % populated.length;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') index = Math.max(0, Math.min(buckets.length - 1, index + (event.key === 'ArrowRight' ? 1 : -1)));
      if (event.key === 'Enter') state.pinned = !state.pinned;
      const line = populated[appIndex];
      if (!line.points[index]) index = line.points.findIndex(Boolean);
      showTooltip({ id: line.id, index });
    });
    new ResizeObserver(() => {
      const next = chartFrame(svg.getBoundingClientRect().width, state.field);
      if (next.width !== frame.width) draw();
    }).observe(svg);
    slider.addEventListener('input', () => { const line = series.find(item => item.points[Number(slider.value)]); if (line) showTooltip({ id: line.id, index: Number(slider.value) }); });
    byId('range-start').addEventListener('input', event => setRange(Math.min(Number(event.target.value), state.end), state.end));
    byId('range-end').addEventListener('input', event => setRange(state.start, Math.max(state.start, Number(event.target.value))));
    byId('zoom-reset').addEventListener('click', () => setRange(0, calendar.length - 1));
    function syncMode() {
      document.querySelectorAll('[data-chart-mode]').forEach(button => { const active = button.dataset.chartMode === state.mode; button.classList.toggle('is-active', active); button.setAttribute('aria-pressed', String(active)); });
      document.querySelector('[data-chart-mode="cumulative"]').disabled = FIELDS[state.field].cumulative === false;
    }
    byId('metric-select').addEventListener('change', event => { state.field = event.target.value; if (FIELDS[state.field].cumulative === false) state.mode = 'daily'; syncMode(); state.pinned = false; draw(); });
    document.querySelectorAll('[data-chart-mode]').forEach(button => button.addEventListener('click', () => { state.mode = button.dataset.chartMode; syncMode(); state.pinned = false; draw(); }));
    function renderTable() {
      const tbody = byId('performance-body'); tbody.replaceChildren();
      for (const app of sortApps(apps, state.sort, state.direction)) {
        const row = node('tr');
        for (const field of ['name', 'category', 'googleInstalls', 'appleDownloads', 'admobRevenue', 'rating', 'crashRate', 'anrRate']) {
          const cell = node(field === 'name' ? 'th' : 'td');
          if (field === 'name') cell.scope = 'row';
          if (field === 'name' || field === 'category') cell.textContent = app[field];
          else if (field === 'rating') cell.textContent = formatValue(app.googleRating?.value, field, missingReason(app, field));
          else { const metric = app[field]; cell.textContent = formatValue(metric.historyLatest ?? metric.historyTotal, field, missingReason(app, field)); cell.append(node('small', '', metric.historyStart ? `${metric.historyStart} 至 ${metric.historyEnd}` : missingReason(app, field))); }
          row.append(cell);
        }
        tbody.append(row);
      }
      document.querySelectorAll('[data-sort]').forEach(button => button.closest('th').setAttribute('aria-sort', button.dataset.sort === state.sort ? (state.direction === 'asc' ? 'ascending' : 'descending') : 'none'));
      byId('sort-field').value = state.sort; byId('sort-direction').value = state.direction;
    }
    document.querySelectorAll('[data-sort]').forEach(button => button.addEventListener('click', () => { state.direction = state.sort === button.dataset.sort && state.direction === 'desc' ? 'asc' : 'desc'; state.sort = button.dataset.sort; renderTable(); }));
    byId('sort-field').addEventListener('change', event => { state.sort = event.target.value; renderTable(); });
    byId('sort-direction').addEventListener('change', event => { state.direction = event.target.value; renderTable(); });

    function reviewCard(review, app) {
      const card = node('article', 'review-card'), header = node('div', 'review-card-header'), heading = node('div', 'review-card-heading');
      const title = node('h3', '', app.name), meta = node('div', 'review-card-meta');
      meta.append(node('span', `source-pill ${review?.platform || ''}`, review ? ({ google: 'Google Play', apple: 'App Store', community: '作品集留言' })[review.platform] : '評論資料'));
      if (review) meta.append(node('time', 'review-date', review.date.slice(0, 10)));
      heading.append(title, meta); header.append(icon(app), heading); card.append(header);
      if (review) {
        const rating = node('div', 'review-rating', review.rating === null ? '作品集留言 · 無星等評分' : `${'★'.repeat(review.rating)}${'☆'.repeat(5 - review.rating)} ${review.rating}.0`);
        rating.classList.toggle('unrated', review.rating === null);
        card.append(rating);
        const body = node('p', 'review-body', `${review.title ? `${review.title}：` : ''}${review.body}`); card.append(body);
        const bottom = node('div', 'review-bottom'); bottom.append(node('span', 'review-author', `${review.author || '商店使用者'} · ${review.date.slice(0, 10)}`));
        if (reviewHasIssue(review)) bottom.append(node('span', 'review-tag issue', '待查'));
        const expand = node('button', 'review-expand', '全文'); expand.type = 'button'; expand.setAttribute('aria-expanded', 'false');
        expand.addEventListener('click', () => { const open = body.classList.toggle('is-open'); expand.setAttribute('aria-expanded', String(open)); expand.textContent = open ? '收合' : '全文'; });
        bottom.append(expand); card.append(bottom);
      } else {
        card.classList.add('empty-review');
        card.append(node('div', 'review-rating', '尚無可顯示評論'), node('p', 'review-body', communityState?.failures.includes(app.id) ? '留言暫時讀取失敗，不視為零則評論。' : communityState ? '尚無已取得的商店評論或留言。' : '正在讀取留言；已取得歷史持續保留。'));
        const bottom = node('div', 'review-bottom'); bottom.append(node('span', 'review-tag', '未收錄')); card.append(bottom);
      }
      return card;
    }
    function renderReviews() {
      const filtered = filterReviews(reviews, filters, names), grid = byId('review-grid'); grid.replaceChildren();
      for (const review of filtered.slice(0, reviewLimit)) { const app = apps.find(item => item.id === review.appId); if (app) grid.append(reviewCard(review, app)); }
      if (filtered.length > 0 && filtered.length < 4 && filters.app === 'all' && filters.platform === 'all' && filters.rating === 'all' && filters.issues === 'all' && !filters.query) {
        const already = new Set(filtered.map(review => review.appId));
        for (const app of featured.filter(app => !already.has(app.id)).slice(0, 4 - filtered.length)) grid.append(reviewCard(null, app));
      }
      if (!filtered.length) {
        if (Object.entries(filters).every(([key, value]) => key === 'sort' || value === 'all' || value === '')) featured.slice(0, 4).forEach(app => grid.append(reviewCard(null, app)));
        else grid.append(node('p', 'empty-review', '沒有符合篩選條件的公開評論。'));
      }
      byId('reviews-load-more').hidden = filtered.length <= reviewLimit;
      byId('reviews-load-more').textContent = `載入更多（${Math.min(reviewLimit, filtered.length)} / ${filtered.length}）`;
      const store = reviews.filter(review => review.platform !== 'community').length, comments = reviews.length - store;
      text('reviews-value', number.format(reviews.length));
      text('reviews-coverage', `商店 ${store} · 作品集 ${comments}${communityState?.failures.length ? ' · 部分讀取失敗' : ''}`);
      const limitations = [report.reviews?.partial ? '商店仍有待讀分頁' : '', report.reviews?.archivePartial ? '部分歷史快照待補' : '', communityState?.failures.length ? `${communityState.failures.length} 款 APP 留言讀取失敗` : '', communityState?.partial.length ? `${communityState.partial.length} 款 APP 留言分頁未完整` : ''].filter(Boolean);
      text('review-coverage', `整合 ${apps.length} 款 APP · 已讀 ${store} 則商店評論、${comments} 則作品集留言 · 非商店歷年總数${limitations.length ? ` · ${limitations.join('；')}` : ''}`);
    }
    for (const app of apps) { const option = node('option', '', app.name); option.value = app.id; byId('review-app').append(option); }
    for (const [id, key] of [['review-search', 'query'], ['review-app', 'app'], ['review-rating', 'rating'], ['review-sort', 'sort'], ['review-issues', 'issues']]) byId(id).addEventListener(id === 'review-search' ? 'input' : 'change', event => { filters[key] = event.target.value; reviewLimit = 4; renderReviews(); });
    document.querySelectorAll('[data-review-platform]').forEach(button => button.addEventListener('click', () => {
      filters.platform = button.dataset.reviewPlatform; reviewLimit = 4;
      document.querySelectorAll('[data-review-platform]').forEach(item => { item.classList.toggle('is-active', item === button); item.setAttribute('aria-pressed', String(item === button)); }); renderReviews();
    }));
    byId('reviews-load-more').addEventListener('click', () => { reviewLimit += 12; renderReviews(); });
    draw(); renderTable(); renderReviews();
    loadCommunityReviews(apps.map(app => app.id)).then(result => { communityState = result; reviews = [...reviews, ...result.items]; renderReviews(); }).catch(() => { communityState = { failures: apps.map(app => app.id), partial: [], items: [] }; renderReviews(); });
  }
}
