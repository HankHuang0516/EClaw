export const FIELDS = {
  googleInstalls: { label: 'Google 使用者安裝', unit: '次', platform: 'Google Play' },
  appleDownloads: { label: 'Apple 首次下載', unit: '單位', platform: 'App Store' },
  admobRevenue: { label: 'AdMob 預估收益', unit: 'TWD', platform: '雙平台廣告' },
  crashes: { label: 'Google 當機', unit: '次', platform: 'Google Play' },
  anrs: { label: 'Google ANR', unit: '次', platform: 'Google Play' },
};
const number = new Intl.NumberFormat('zh-TW', { maximumFractionDigits: 2 });
const money = new Intl.NumberFormat('zh-TW', { style: 'currency', currency: 'TWD', minimumFractionDigits: 2, maximumFractionDigits: 4 });
export function formatValue(value, field) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '未取得';
  if (field === 'admobRevenue' && value !== 0 && Math.abs(value) < 0.0001) return value < 0 ? '> -NT$0.0001' : '< NT$0.0001';
  return field === 'admobRevenue' ? money.format(value) : number.format(value);
}
export function chartBuckets(apps, field, granularity, start, end) {
  if (!FIELDS[field] || !['day', 'month', 'year'].includes(granularity)) throw new Error('Invalid chart metric');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || start > end) return [];
  const first = Date.parse(start + 'T00:00:00Z'), last = Date.parse(end + 'T00:00:00Z');
  if (!Number.isFinite(first) || !Number.isFinite(last) || (last - first) / 86400000 > 36600) return [];
  const groups = new Map();
  for (let day = first; day <= last; day += 86400000) {
    const date = new Date(day).toISOString().slice(0, 10);
    const key = date.slice(0, granularity === 'year' ? 4 : granularity === 'month' ? 7 : 10);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(date);
  }
  const lookups = apps.map(app => new Map(app[field].points.map(point => [point.date, point.value])));
  return [...groups].map(([label, days]) => ({ label, values: apps.map((app, i) => {
    const values = days.map(day => lookups[i].get(day)).filter(value => value !== null && value !== undefined);
    return { id: app.id, value: values.length ? values.reduce((sum, value) => sum + value, 0) : null, coveredDays: values.length, expectedDays: days.length };
  }) }));
}
export function sortApps(apps, key, direction = 'desc') {
  const value = app => key === 'name' || key === 'category' ? app[key] : key === 'rating' ? app.googleRating?.value ?? null : app[key]?.historyTotal ?? null;
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
    text('data-mode', '週報尚未載入');
    text('report-period', '資料版本不符或下載失敗，請稍後重新整理；不會以零代替。');
  } else {
    const palette = ['#496653', '#a86a2d', '#376c88', '#974d53', '#75613c', '#55877e', '#9b633c', '#5164a0', '#795d82', '#76813e', '#aa746e', '#447b63', '#887044'];
    const set = new Set(report.apps.map(app => app.id));
    const state = { field: 'googleInstalls', granularity: 'month', sort: 'googleInstalls', direction: 'desc' };
    text('data-mode', '官方報表・真實資料');
    text('reviews-value', formatValue(report.reviews?.visibleCount, 'reviews'));
    text('reviews-coverage', report.reviews ? `雙平台 API 已讀評論${report.reviews.partial ? '・尚有未讀分頁' : ''}，非商店歷年總數` : '評論資料尚未取得，不以零代替');
    text('report-period', `更新：${new Date(report.generatedAt).toLocaleString('zh-TW')} ｜ 本週：${report.period.start} 至 ${report.period.end}`);
    for (const [field, config] of Object.entries(FIELDS)) {
      const value = report.totals[field].last7;
      text(`${field}-value`, formatValue(value.value, field));
      const coverage = value.expectedAppDays !== undefined ? `${value.observedAppDays}/${value.expectedAppDays} APP・日` : `${value.coveredDays}/${value.expectedDays} 日`;
      text(`${field}-coverage`, `${config.unit}・${value.complete ? '完整' : '部分或尚無資料'}・${coverage}`);
    }
    text('unallocated', `未歸屬廣告歷史收益：${formatValue(report.totals.unallocatedRevenue.historyTotal, 'admobRevenue')}。${report.coverage.unallocatedAdmobAppCount} 個廣告應用程式尚待確認對應，已保留在總收益中。`);
    text('coverage-note', '歷史總計僅代表已取得報表，不保證是上架以來全部數據。Google 使用者安裝與 Apple 首次下載定義不同，不合併為人數。空白期間不當作零；部分資料的加總會標示涵蓋率。當機與 ANR 是事件次數，不是金額，也不是無當機率。');
    const startInput = document.getElementById('range-start'), endInput = document.getElementById('range-end');
    const dates = report.apps.flatMap(app => Object.keys(FIELDS).flatMap(field => app[field].points.map(point => point.date))).sort();
    startInput.value = dates[0] || report.period.start;
    startInput.min = dates[0] || report.period.start;
    endInput.value = report.period.end; endInput.max = report.period.end; startInput.max = report.period.end;
    const metricSelect = document.getElementById('metric-select');
    const legend = document.getElementById('trend-legend');
    report.apps.forEach((app, index) => {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'legend-button';
      const dot = document.createElement('span'); dot.className = 'legend-dot'; dot.style.setProperty('--series-color', palette[index % palette.length]);
      button.append(dot, document.createTextNode(app.name)); button.setAttribute('aria-pressed', 'true');
      button.addEventListener('click', () => {
        if (set.has(app.id)) set.delete(app.id); else set.add(app.id);
        button.classList.toggle('is-off', !set.has(app.id)); button.setAttribute('aria-pressed', String(set.has(app.id))); draw();
      }); legend.append(button);
    });
    const svg = document.getElementById('trend-chart'), slider = document.getElementById('period-cursor');
    let buckets = [];
    function element(tag, attrs = {}, value) {
      const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
      for (const [key, val] of Object.entries(attrs)) node.setAttribute(key, val);
      if (value !== undefined) node.textContent = value;
      svg.append(node); return node;
    }
    function detail(index) {
      const bucket = buckets[index]; const panel = document.getElementById('point-detail'); panel.replaceChildren();
      if (!bucket) { panel.textContent = '選擇有效日期範圍以查看資料。'; return; }
      slider.value = index; slider.setAttribute('aria-valuetext', bucket.label);
      const title = document.createElement('strong'); title.textContent = `${bucket.label}・${FIELDS[state.field].label}`; panel.append(title);
      for (const app of report.apps.filter(app => set.has(app.id))) {
        const value = bucket.values.find(value => value.id === app.id);
        const line = document.createElement('div');
        line.textContent = `${app.name}：${formatValue(value.value, state.field)}（${value.coveredDays}/${value.expectedDays} 日）`;
        panel.append(line);
      }
    }
    function draw() {
      buckets = chartBuckets(report.apps, state.field, state.granularity, startInput.value, endInput.value);
      svg.replaceChildren();
      text('chart-caption', `${FIELDS[state.field].label}・${FIELDS[state.field].unit}。線條中斷代表缺資料；空心點代表期間資料不完整。`);
      slider.max = Math.max(0, buckets.length - 1); slider.disabled = !buckets.length;
      const observed = buckets.flatMap(bucket => bucket.values.filter(value => set.has(value.id) && value.value !== null).map(value => value.value));
      if (!observed.length) {
        element('text', { x: 500, y: 200, 'text-anchor': 'middle', fill: '#73786e' }, '此範圍尚無已取得資料，或未選擇 APP');
        detail(Math.max(0, buckets.length - 1)); return;
      }
      const min = Math.min(0, ...observed), max = Math.max(1, ...observed);
      const x = i => 75 + (buckets.length === 1 ? 425 : i * 850 / (buckets.length - 1));
      const y = value => 360 - (value - min) * 320 / (max - min);
      for (let i = 0; i <= 4; i++) {
        const value = min + (max - min) * i / 4;
        element('line', { x1: 75, x2: 925, y1: y(value), y2: y(value), stroke: '#d9d0c0' });
        element('text', { x: 66, y: y(value) + 4, 'text-anchor': 'end', fill: '#73786e', 'font-size': 11 }, formatValue(value, state.field));
      }
      const step = Math.max(1, Math.ceil(buckets.length / 7));
      buckets.forEach((bucket, i) => { if (i % step === 0 || i === buckets.length - 1) element('text', { x: x(i), y: 394, 'text-anchor': 'middle', fill: '#73786e', 'font-size': 11 }, bucket.label); });
      report.apps.forEach((app, appIndex) => {
        if (!set.has(app.id)) return;
        let path = '', connected = false;
        const color = palette[appIndex % palette.length];
        buckets.forEach((bucket, i) => {
          const value = bucket.values[appIndex];
          if (value.value === null) { connected = false; return; }
          const complete = value.coveredDays === value.expectedDays;
          path += `${connected && complete ? 'L' : 'M'}${x(i)},${y(value.value)} `;
          connected = complete;
          const dot = element('circle', { cx: x(i), cy: y(value.value), r: 3, fill: complete ? color : '#fffdf8', stroke: color, 'stroke-width': 1.5 });
          const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
          title.textContent = `${app.name} ${bucket.label} ${formatValue(value.value, state.field)} (${value.coveredDays}/${value.expectedDays})`; dot.append(title);
        });
        element('path', { d: path, fill: 'none', stroke: color, 'stroke-width': 2, 'pointer-events': 'none' });
      });
      detail(Math.min(Number(slider.value) || buckets.length - 1, buckets.length - 1));
    }
    svg.addEventListener('pointermove', event => {
      if (!buckets.length) return;
      const rect = svg.getBoundingClientRect();
      const position = ((event.clientX - rect.left) / rect.width * 1000 - 75) / 850;
      detail(Math.max(0, Math.min(buckets.length - 1, Math.round(position * (buckets.length - 1)))));
    });
    slider.addEventListener('input', () => detail(Number(slider.value)));
    metricSelect.addEventListener('change', () => { state.field = metricSelect.value; draw(); });
    for (const input of [startInput, endInput]) input.addEventListener('change', draw);
    document.querySelectorAll('[data-granularity]').forEach(button => button.addEventListener('click', () => {
      state.granularity = button.dataset.granularity;
      document.querySelectorAll('[data-granularity]').forEach(item => { item.classList.toggle('is-active', item === button); item.setAttribute('aria-pressed', String(item === button)); }); draw();
    }));
    function renderTable() {
      const tbody = document.getElementById('performance-body'); tbody.replaceChildren();
      for (const app of sortApps(report.apps, state.sort, state.direction)) {
        const row = document.createElement('tr');
        for (const key of ['name', 'category', 'googleInstalls', 'appleDownloads', 'admobRevenue', 'rating', 'crashes', 'anrs']) {
          const cell = document.createElement(key === 'name' ? 'th' : 'td');
          if (key === 'name') cell.scope = 'row';
          if (key === 'name' || key === 'category') cell.textContent = app[key];
          else if (key === 'rating') { cell.textContent = formatValue(app.googleRating?.value, key); cell.title = app.googleRating?.date || '尚無 Google 評分報表'; }
          else {
            const metric = app[key]; cell.textContent = formatValue(metric.historyTotal, key);
            const note = document.createElement('small'); note.textContent = metric.historyStart ? `${metric.historyStart} 至 ${metric.historyEnd}` : '尚無資料'; cell.append(note);
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
