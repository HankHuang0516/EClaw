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
  if (field === 'admobRevenue') return money.format(value);
  return field === 'crashRate' || field === 'anrRate' ? `${number.format(value)}%` : number.format(value);
}

export function automaticGranularity(start, end) {
  const days = Math.floor((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / DAY) + 1;
  if (!Number.isFinite(days) || days < 1 || days <= 45) return 'day';
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
  if (field === 'rating') return '商店尚無公開評分';
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

if (typeof document !== 'undefined') {
  const report = window.AIHANK_REPORT;
  const text = (id, value) => { const element = document.getElementById(id); if (element) element.textContent = value; };
  if (!report || report.schemaVersion !== 2) {
    text('data-mode', 'APP 趨勢尚未載入');
    text('report-period', '資料版本不符或下載失敗，請稍後重新整理；頁面不會以零值代替。');
  } else {
    const palette = ['#496653', '#a86a2d', '#376c88', '#974d53', '#75613c', '#55877e', '#9b633c', '#5164a0', '#795d82', '#76813e', '#aa746e', '#447b63', '#887044'];
    report.apps.forEach(app => { app.combinedAcquisition = combinedAcquisition(app); });
    const selectedApps = new Set(report.apps.map(app => app.id));
    const sourceDates = report.apps.flatMap(app => Object.keys(FIELDS).flatMap(field => app[field].points.map(point => point.date))).sort();
    const earliest = sourceDates[0] || report.period.start;
    const calendar = [];
    for (let day = Date.parse(`${earliest}T00:00:00Z`), end = Date.parse(`${report.period.end}T00:00:00Z`); day <= end; day += DAY) calendar.push(new Date(day).toISOString().slice(0, 10));
    const state = { field: 'googleInstalls', mode: 'daily', sort: 'googleInstalls', direction: 'desc', startIndex: 0, endIndex: Math.max(0, calendar.length - 1) };
    text('data-mode', '每日同步・官方真實資料');
    text('reviews-value', formatValue(report.reviews?.visibleCount, 'reviews', '評論 API 待補'));
    text('reviews-coverage', report.reviews ? `雙平台 API 已讀評論${report.reviews.partial ? '・仍有待讀分頁' : ''}，非商店歷年總數` : '評論 API 尚未回傳資料，不以零代替');
    text('report-period', `更新：${new Date(report.generatedAt).toLocaleString('zh-TW')} ｜ 最近統計：${report.period.start} 至 ${report.period.end}`);
    for (const [field, config] of Object.entries(FIELDS)) {
      if (config.summary === false) continue;
      const value = report.totals[field].last7;
      const card = document.getElementById(`${field}-value`)?.closest('.metric');
      if (card) card.hidden = value.value === null;
      text(`${field}-value`, formatValue(value.value, field, '官方報表待補'));
      const coverage = value.expectedAppDays !== undefined ? `${value.observedAppDays}/${value.expectedAppDays} APP・日` : `${value.coveredDays}/${value.expectedDays} 日`;
      const status = value.complete ? '完整' : value.value === null ? '官方報表尚未涵蓋' : '部分資料';
      text(`${field}-coverage`, `${config.unit}・${status}・${coverage}`);
    }
    text('unallocated', `未歸屬廣告歷史收益：${formatValue(report.totals.unallocatedRevenue.historyTotal, 'admobRevenue', '尚無可歸屬資料')}。${report.coverage.unallocatedAdmobAppCount} 個廣告應用程式尚待確認對應，已保留在總收益中。`);
    text('coverage-note', '歷史總計僅代表已取得的官方報表，不保證是上架以來全部數據。Google 使用者安裝與 Apple 首次下載定義不同；跨平台合計只作視覺趨勢參考。空白期間不當作零。當機率與 ANR 率是 Google 回傳的不同使用者百分比，小樣本未回傳時保持空白。');

    const metricSelect = document.getElementById('metric-select');
    const legend = document.getElementById('trend-legend');
    report.apps.forEach((app, index) => {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'legend-button';
      const dot = document.createElement('span'); dot.className = 'legend-dot'; dot.style.setProperty('--series-color', palette[index % palette.length]);
      button.append(dot, document.createTextNode(app.name)); button.setAttribute('aria-pressed', 'true');
      button.addEventListener('click', () => {
        if (selectedApps.has(app.id)) selectedApps.delete(app.id); else selectedApps.add(app.id);
        button.classList.toggle('is-off', !selectedApps.has(app.id)); button.setAttribute('aria-pressed', String(selectedApps.has(app.id))); draw();
      }); legend.append(button);
    });

    const svg = document.getElementById('trend-chart');
    const slider = document.getElementById('period-cursor');
    let buckets = [];
    let drag = null;
    function element(tag, attrs = {}, value) {
      const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
      for (const [key, val] of Object.entries(attrs)) node.setAttribute(key, val);
      if (value !== undefined) node.textContent = value;
      svg.append(node); return node;
    }
    function currentRange() {
      return { start: calendar[state.startIndex] || report.period.start, end: calendar[state.endIndex] || report.period.end };
    }
    function detail(index) {
      const bucket = buckets[index]; const panel = document.getElementById('point-detail'); panel.replaceChildren();
      if (!bucket) { panel.textContent = '這個時間範圍沒有可顯示的官方報表資料。'; return; }
      slider.value = index; slider.setAttribute('aria-valuetext', `${bucket.start} 至 ${bucket.end}`);
      const title = document.createElement('strong'); title.textContent = `${bucket.label}・${FIELDS[state.field].label}${state.mode === 'cumulative' ? '累計' : ''}`; panel.append(title);
      for (const app of report.apps.filter(app => selectedApps.has(app.id))) {
        const value = bucket.values.find(item => item.id === app.id);
        const line = document.createElement('div');
        line.textContent = `${app.name}：${formatValue(value.value, state.field, missingReason(app, state.field))}（${value.coveredDays}/${value.expectedDays} 日有官方列）`;
        panel.append(line);
      }
    }
    function setRange(startIndex, endIndex) {
      const last = Math.max(0, calendar.length - 1);
      state.startIndex = Math.max(0, Math.min(last, Math.round(startIndex)));
      state.endIndex = Math.max(state.startIndex, Math.min(last, Math.round(endIndex)));
      draw();
    }
    function draw() {
      const range = currentRange();
      const granularity = automaticGranularity(range.start, range.end);
      buckets = chartBuckets(report.apps, state.field, granularity, range.start, range.end, { cumulative: state.mode === 'cumulative' });
      svg.replaceChildren();
      const labels = { day: '每日', week: '每週', month: '每月', quarter: '每季', year: '每年' };
      text('auto-granularity', `自動粒度：${labels[granularity]}`);
      text('range-display', `${range.start} 至 ${range.end}`);
      const combinedNote = state.field === 'combinedAcquisition' ? ' Google 與 Apple 定義不同，合計僅供跨平台視覺趨勢參考；缺少的平台日期不補零。' : '';
      text('chart-caption', `${FIELDS[state.field].label}・${FIELDS[state.field].unit}・${state.mode === 'cumulative' ? '每款 APP 累計已取得總和' : '期間變化'}。滾輪縮放、橫向拖曳選取範圍；空心點代表官方資料涵蓋不完整。${combinedNote}`);
      slider.max = Math.max(0, buckets.length - 1); slider.disabled = !buckets.length;
      const observed = buckets.flatMap(bucket => bucket.values.filter(value => selectedApps.has(value.id) && value.value !== null).map(value => value.value));
      if (!observed.length) {
        element('text', { x: 500, y: 200, 'text-anchor': 'middle', fill: '#73786e' }, '此範圍沒有官方報表資料，或尚未選擇 APP');
        detail(Math.max(0, buckets.length - 1)); return;
      }
      const min = Math.min(0, ...observed), max = Math.max(1, ...observed);
      const x = index => 75 + (buckets.length === 1 ? 425 : index * 850 / (buckets.length - 1));
      const y = value => 360 - (value - min) * 320 / (max - min);
      for (let index = 0; index <= 4; index++) {
        const value = min + (max - min) * index / 4;
        element('line', { x1: 75, x2: 925, y1: y(value), y2: y(value), stroke: '#d9d0c0' });
        element('text', { x: 66, y: y(value) + 4, 'text-anchor': 'end', fill: '#73786e', 'font-size': 11 }, formatValue(value, state.field));
      }
      const step = Math.max(1, Math.ceil(buckets.length / 7));
      buckets.forEach((bucket, index) => { if (index % step === 0 || index === buckets.length - 1) element('text', { x: x(index), y: 394, 'text-anchor': 'middle', fill: '#73786e', 'font-size': 11 }, bucket.label); });
      report.apps.forEach((app, appIndex) => {
        if (!selectedApps.has(app.id)) return;
        let path = '', connected = false;
        const color = palette[appIndex % palette.length];
        buckets.forEach((bucket, index) => {
          const value = bucket.values[appIndex];
          if (value.value === null) { connected = false; return; }
          const complete = value.coveredDays === value.expectedDays;
          path += `${connected || state.mode === 'cumulative' ? 'L' : 'M'}${x(index)},${y(value.value)} `;
          if (!path.startsWith('M')) path = `M${path.slice(1)}`;
          connected = complete;
          const dot = element('circle', { cx: x(index), cy: y(value.value), r: 3, fill: complete ? color : '#fffdf8', stroke: color, 'stroke-width': 1.5 });
          const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
          title.textContent = `${app.name} ${bucket.label} ${formatValue(value.value, state.field)} (${value.coveredDays}/${value.expectedDays})`; dot.append(title);
        });
        element('path', { d: path, fill: 'none', stroke: color, 'stroke-width': 2, 'pointer-events': 'none' });
      });
      detail(Math.min(Number(slider.value) || buckets.length - 1, buckets.length - 1));
    }
    function chartPosition(event) {
      const rect = svg.getBoundingClientRect();
      return Math.max(75, Math.min(925, (event.clientX - rect.left) / rect.width * 1000));
    }
    svg.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      const start = chartPosition(event);
      drag = { pointerId: event.pointerId, start, current: start, selection: element('rect', { x: start, y: 28, width: 0, height: 340, rx: 8, class: 'selection-window' }) };
      svg.setPointerCapture(event.pointerId);
    });
    svg.addEventListener('pointermove', event => {
      if (!buckets.length) return;
      const position = chartPosition(event);
      if (drag?.pointerId === event.pointerId) {
        drag.current = position;
        drag.selection.setAttribute('x', Math.min(drag.start, position));
        drag.selection.setAttribute('width', Math.abs(position - drag.start));
        return;
      }
      detail(Math.max(0, Math.min(buckets.length - 1, Math.round((position - 75) / 850 * (buckets.length - 1)))));
    });
    function finishDrag(event) {
      if (!drag || drag.pointerId !== event.pointerId) return;
      const from = Math.min(drag.start, drag.current), to = Math.max(drag.start, drag.current);
      drag.selection.remove();
      if (to - from > 18) {
        const width = state.endIndex - state.startIndex;
        setRange(state.startIndex + (from - 75) / 850 * width, state.startIndex + (to - 75) / 850 * width);
      } else {
        detail(Math.max(0, Math.min(buckets.length - 1, Math.round((from - 75) / 850 * (buckets.length - 1)))));
      }
      drag = null;
    }
    svg.addEventListener('pointerup', finishDrag);
    svg.addEventListener('pointercancel', finishDrag);
    svg.addEventListener('wheel', event => {
      if (calendar.length < 2) return;
      event.preventDefault();
      const size = state.endIndex - state.startIndex + 1;
      const nextSize = Math.max(7, Math.min(calendar.length, Math.round(size * (event.deltaY > 0 ? 1.35 : 0.72))));
      const anchor = (chartPosition(event) - 75) / 850;
      const center = state.startIndex + anchor * (size - 1);
      let start = Math.round(center - anchor * (nextSize - 1));
      start = Math.max(0, Math.min(calendar.length - nextSize, start));
      setRange(start, start + nextSize - 1);
    }, { passive: false });
    slider.addEventListener('input', () => detail(Number(slider.value)));
    metricSelect.addEventListener('change', () => {
      state.field = metricSelect.value;
      if (FIELDS[state.field].cumulative === false && state.mode === 'cumulative') {
        state.mode = 'daily';
        document.querySelectorAll('[data-chart-mode]').forEach(item => { const active = item.dataset.chartMode === 'daily'; item.classList.toggle('is-active', active); item.setAttribute('aria-pressed', String(active)); });
      }
      document.querySelector('[data-chart-mode="cumulative"]').disabled = FIELDS[state.field].cumulative === false;
      draw();
    });
    document.getElementById('zoom-reset').addEventListener('click', () => setRange(0, calendar.length - 1));
    document.querySelectorAll('[data-chart-mode]').forEach(button => button.addEventListener('click', () => {
      if (button.disabled) return;
      state.mode = button.dataset.chartMode;
      document.querySelectorAll('[data-chart-mode]').forEach(item => { item.classList.toggle('is-active', item === button); item.setAttribute('aria-pressed', String(item === button)); });
      draw();
    }));
    function renderTable() {
      const tbody = document.getElementById('performance-body'); tbody.replaceChildren();
      for (const app of sortApps(report.apps, state.sort, state.direction)) {
        const row = document.createElement('tr');
        for (const key of ['name', 'category', 'googleInstalls', 'appleDownloads', 'admobRevenue', 'rating', 'crashRate', 'anrRate']) {
          const cell = document.createElement(key === 'name' ? 'th' : 'td');
          if (key === 'name') cell.scope = 'row';
          if (key === 'name' || key === 'category') cell.textContent = app[key];
          else if (key === 'rating') { cell.textContent = formatValue(app.googleRating?.value, key, missingReason(app, key)); cell.title = app.googleRating?.date || missingReason(app, key); }
          else {
            const metric = app[key]; cell.textContent = formatValue(metric.historyLatest ?? metric.historyTotal, key, missingReason(app, key));
            const note = document.createElement('small'); note.textContent = metric.historyStart ? `${metric.historyStart} 至 ${metric.historyEnd}` : missingReason(app, key); cell.append(note);
          }
          row.append(cell);
        }
        tbody.append(row);
      }
      document.querySelectorAll('[data-sort]').forEach(button => button.closest('th').setAttribute('aria-sort', button.dataset.sort === state.sort ? (state.direction === 'asc' ? 'ascending' : 'descending') : 'none'));
      document.getElementById('sort-field').value = state.sort;
      document.getElementById('sort-direction').value = state.direction;
    }
    document.querySelectorAll('[data-sort]').forEach(button => button.addEventListener('click', () => { state.direction = state.sort === button.dataset.sort && state.direction === 'desc' ? 'asc' : 'desc'; state.sort = button.dataset.sort; renderTable(); }));
    document.getElementById('sort-field').addEventListener('change', event => { state.sort = event.target.value; renderTable(); });
    document.getElementById('sort-direction').addEventListener('change', event => { state.direction = event.target.value; renderTable(); });
    draw(); renderTable();
  }
}
