/* 營運數據 page: three zoomable waveform charts over /api/aihankapps/ops (see backend/aihankapps-ops.js).
 * Pure helpers live on OpsChartMath so they can be unit-tested in Node; everything else needs a browser. */
(function (root) {
  'use strict';
  const TZ = 'Asia/Taipei', TZ_OFFSET_MS = 8 * 3600e3;
  const STEPS = ['minute', 'hour', 'day', 'month'];
  const STEP_MS = { minute: 60e3, hour: 3600e3, day: 86400e3, month: 30 * 86400e3 };
  const STEP_LABEL = { minute: '分', hour: '時', day: '日', month: '月' };
  // Zoom thresholds (visible span) at which the x axis changes unit.
  const THRESHOLDS = { minute: 6 * 3600e3, hour: 7 * 86400e3, day: 120 * 86400e3 };
  // Span shown when a unit is picked by hand.
  const PRESET_SPAN = { minute: 3 * 3600e3, hour: 2 * 86400e3, day: 60 * 86400e3, month: 730 * 86400e3 };
  const TICK_UNITS = {
    minute: [1, 2, 5, 10, 15, 30, 60, 120, 180, 360, 720].map(m => m * 60e3),
    hour: [1, 2, 3, 6, 12, 24, 48, 72, 168].map(h => h * 3600e3),
    day: [1, 2, 7, 14, 30].map(d => d * 86400e3),
    month: [1, 2, 3, 6, 12],
  };

  function pickStep(spanMs, minStep) {
    let step = spanMs <= THRESHOLDS.minute ? 'minute' : spanMs <= THRESHOLDS.hour ? 'hour' : spanMs <= THRESHOLDS.day ? 'day' : 'month';
    if (minStep && STEPS.indexOf(step) < STEPS.indexOf(minStep)) step = minStep;
    return step;
  }
  // Calendar parts in Taipei without Intl (the offset is a constant +08:00).
  function parts(ms) {
    const d = new Date(ms + TZ_OFFSET_MS);
    return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), wd: d.getUTCDay() };
  }
  const fromParts = (y, mo, d, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi) - TZ_OFFSET_MS;
  function bucketStart(ms, step) {
    if (step === 'minute' || step === 'hour') return Math.floor(ms / STEP_MS[step]) * STEP_MS[step];
    const p = parts(ms);
    return step === 'day' ? fromParts(p.y, p.mo, p.d) : fromParts(p.y, p.mo, 1);
  }
  function bucketNext(ms, step) {
    if (step !== 'month') return bucketStart(ms, step) + STEP_MS[step];
    const p = parts(bucketStart(ms, step));
    return p.mo === 12 ? fromParts(p.y + 1, 1, 1) : fromParts(p.y, p.mo + 1, 1);
  }
  const pad = n => String(n).padStart(2, '0');
  function formatTick(ms, step, prev) {
    const p = parts(ms), q = prev === undefined ? null : parts(prev);
    const dayChanged = !q || q.d !== p.d || q.mo !== p.mo || q.y !== p.y;
    if (step === 'minute') return (dayChanged ? p.mo + '/' + p.d + ' ' : '') + pad(p.h) + ':' + pad(p.mi);
    if (step === 'hour') return (dayChanged ? p.mo + '/' + p.d + ' ' : '') + pad(p.h) + ':00';
    if (step === 'day') return (!q || q.y !== p.y ? p.y + '/' : '') + p.mo + '/' + p.d;
    return p.y + '/' + pad(p.mo);
  }
  function formatTime(ms, step) {
    const p = parts(ms);
    if (step === 'month') return p.y + ' 年 ' + p.mo + ' 月';
    if (step === 'day') return p.y + '/' + pad(p.mo) + '/' + pad(p.d);
    return p.y + '/' + pad(p.mo) + '/' + pad(p.d) + ' ' + pad(p.h) + ':' + pad(p.mi);
  }
  function formatBucket(ms, step) {
    if (step === 'month' || step === 'day') return formatTime(ms, step);
    const a = parts(ms), b = parts(bucketNext(ms, step));
    return a.y + '/' + pad(a.mo) + '/' + pad(a.d) + ' ' + pad(a.h) + ':' + pad(a.mi) + '–' + pad(b.h) + ':' + pad(b.mi);
  }
  // Tick positions for the visible window: the smallest unit that keeps ticks at least minPx apart.
  function ticksFor(from, to, step, widthPx, minPx) {
    const span = to - from, units = TICK_UNITS[step], out = [];
    if (step === 'month') {
      const months = Math.max(1, span / STEP_MS.month);
      const every = units.find(u => widthPx / (months / u) >= minPx) || 12;
      let t = bucketStart(from, 'month');
      while (t < to) { const p = parts(t); if ((p.mo - 1) % every === 0) out.push(t); t = bucketNext(t, 'month'); }
      return out;
    }
    const unit = units.find(u => widthPx / (span / u) >= minPx) || units[units.length - 1];
    let t = step === 'day' ? bucketStart(from, 'day') : Math.floor((from + TZ_OFFSET_MS) / unit) * unit - TZ_OFFSET_MS;
    if (step === 'day' && unit > STEP_MS.day) { const p = parts(t); t = unit === 7 * 86400e3 || unit === 14 * 86400e3 ? t - ((p.wd + 6) % 7) * STEP_MS.day : fromParts(p.y, p.mo, 1); }
    for (let guard = 0; t < to && guard < 400; guard++) {
      if (t >= from) out.push(t);
      t = step === 'day' && unit === 30 * 86400e3 ? bucketNext(t, 'month') : t + unit;
    }
    return out;
  }
  function niceTicks(min, max, count) {
    if (!(max > min)) max = min + 1;
    const raw = (max - min) / Math.max(1, count), mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const unit = [1, 2, 2.5, 5, 10].map(m => m * mag).find(u => u >= raw) || 10 * mag;
    const start = Math.floor(min / unit) * unit, ticks = [];
    for (let v = start; v <= max + unit / 2 && ticks.length < 12; v += unit) ticks.push(Number(v.toFixed(10)));
    return { ticks, unit, min: start, max: ticks[ticks.length - 1] };
  }
  const UNIT_LABEL = { item: '件', product: '件', inquiry: '則', photo: '張', video: '部', image: '張', marketing_set: '組', conversation_turn: '回合', '%core': '%', '%host': '%', bytes: '' };
  const unitLabel = unit => (unit && UNIT_LABEL[unit] !== undefined ? UNIT_LABEL[unit] : unit || '');
  function formatNumber(v, unit) {
    if (v === null || v === undefined || !Number.isFinite(v)) return '—';
    if (unit === '%core' || unit === '%host') return (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1)) + '%';
    if (unit === 'bytes') return v >= 1e9 ? (v / 1e9).toFixed(2) + ' GB' : (v / 1e6).toFixed(0) + ' MB';
    const n = Math.abs(v) >= 100 || Number.isInteger(v) ? Math.round(v).toLocaleString('en-US') : v.toFixed(1);
    return n;
  }
  function cumulative(points) {
    let sum = 0; return points.map(p => { sum += p[1]; return [p[0], sum]; });
  }
  const OpsChartMath = { STEPS, STEP_MS, STEP_LABEL, THRESHOLDS, PRESET_SPAN, pickStep, parts, bucketStart, bucketNext, formatTick, formatTime, formatBucket, ticksFor, niceTicks, formatNumber, unitLabel, cumulative };
  if (typeof module !== 'undefined' && module.exports) module.exports = OpsChartMath;
  if (!root || !root.document) return;
  root.OpsChartMath = OpsChartMath;

  // ---- data ------------------------------------------------------------------------------------------------------
  const API = '../../api/aihankapps/ops';
  const PALETTE = ['#23634f', '#bb791d', '#2f6f9f', '#b2503f', '#6b5b95', '#3f8f6f', '#8a7a2a', '#c2667d', '#4e7d8c', '#9a6b3c', '#557a2f', '#7a5f9a'];
  async function getJson(url) {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }
  const $ = (sel, el) => (el || document).querySelector(sel);
  const el = (tag, attrs, text) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v); if (text !== undefined) e.textContent = text; return e; };
  const svgEl = (tag, attrs) => { const e = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v); return e; };

  // ---- the chart ---------------------------------------------------------------------------------------------------
  class WaveChart {
    constructor(section, cfg) {
      this.section = section; this.cfg = cfg;
      this.svg = $('[data-role=svg]', section); this.tooltip = $('[data-role=tooltip]', section); this.detail = $('[data-role=detail]', section);
      this.legend = $('[data-role=legend]', section); this.rangeText = $('[data-role=range]', section); this.help = $('[data-role=help]', section); this.emptyNote = $('[data-role=empty]', section);
      this.stepsBox = $('[data-role=steps]', section); this.modeBox = $('[data-role=mode]', section);
      this.series = []; this.hidden = new Set(); this.manualStep = null; this.mode = 'rate'; this.cursor = null; this.pinned = null;
      this.cache = new Map(); this.pointers = new Map(); this.fetching = 0; this.generation = 0; this.error = null;
      const now = Date.now();
      this.to = now; this.from = now - cfg.defaultSpan; this.step = pickStep(cfg.defaultSpan, cfg.minStep);
      this.buildSteps(); this.bindEvents();
      new ResizeObserver(() => this.render()).observe(this.svg.parentElement);
      $('[data-role=reset]', section).addEventListener('click', () => this.reset());
    }
    setSeries(series) {
      this.series = series.map((s, i) => ({ color: PALETTE[i % PALETTE.length], ...s }));
      this.hidden = new Set(series.filter(s => s.hiddenByDefault).map(s => s.id));
      this.cache.clear(); this.buildLegend(); this.load();
    }
    reset() { const now = Date.now(); this.manualStep = null; this.pinned = null; this.setRange(now - this.cfg.defaultSpan, now); }
    buildSteps() {
      this.stepsBox.textContent = '';
      for (const step of STEPS) {
        if (STEPS.indexOf(step) < STEPS.indexOf(this.cfg.minStep)) continue;
        const b = el('button', { type: 'button', class: 'seg', 'data-step': step }, STEP_LABEL[step]);
        b.addEventListener('click', () => { this.manualStep = step; const to = this.to; this.setRange(to - PRESET_SPAN[step], to); });
        this.stepsBox.appendChild(b);
      }
      if (this.modeBox) for (const b of this.modeBox.querySelectorAll('[data-mode]')) b.addEventListener('click', () => {
        this.mode = b.dataset.mode; for (const x of this.modeBox.querySelectorAll('[data-mode]')) x.classList.toggle('is-active', x === b); this.render();
      });
    }
    buildLegend() {
      this.legend.textContent = '';
      for (const s of this.series) {
        const chip = el('button', { type: 'button', class: 'chip' + (this.hidden.has(s.id) ? ' is-off' : ''), 'aria-pressed': String(!this.hidden.has(s.id)), title: s.note || s.label });
        chip.style.setProperty('--c', s.color); chip.appendChild(el('i')); chip.appendChild(document.createTextNode(s.label + (unitLabel(s.unit) && !/^%/.test(s.unit) ? '（' + unitLabel(s.unit) + '）' : '')));
        chip.addEventListener('click', () => { if (this.hidden.has(s.id)) this.hidden.delete(s.id); else this.hidden.add(s.id); chip.classList.toggle('is-off', this.hidden.has(s.id)); chip.setAttribute('aria-pressed', String(!this.hidden.has(s.id))); this.render(); });
        this.legend.appendChild(chip);
      }
    }
    visibleSeries() { return this.series.filter(s => !this.hidden.has(s.id)); }
    setRange(from, to) {
      const now = Date.now(), minSpan = 12 * STEP_MS[this.cfg.minStep], maxSpan = 6 * 365 * 86400e3;
      let span = Math.min(maxSpan, Math.max(minSpan, to - from));
      to = Math.min(to, now + STEP_MS[this.cfg.minStep]); from = to - span;
      // Zooming out stops a day before the first stored point, so an empty year never fills the axis.
      const floor = this.floor || Date.UTC(2025, 0, 1); if (from < floor) { from = floor; to = Math.max(from + minSpan, to); }
      this.from = from; this.to = to;
      const auto = pickStep(span, this.cfg.minStep);
      this.step = this.manualStep && STEPS.indexOf(this.manualStep) >= STEPS.indexOf(this.cfg.minStep) ? this.manualStep : auto;
      // A hand-picked unit gives way once the zoom has moved two units away from it, so the axis never gets absurd.
      if (this.manualStep && Math.abs(STEPS.indexOf(auto) - STEPS.indexOf(this.manualStep)) >= 2) { this.manualStep = null; this.step = auto; }
      this.render(); this.load();
    }
    // Keep a window three times the visible span per unit; refetch when the view leaves it.
    load() {
      const ids = this.series.map(s => s.id); if (!ids.length) return;
      const span = this.to - this.from, want = { from: bucketStart(this.from - span, this.step), to: bucketNext(this.to + span, this.step) };
      const have = this.cache.get(this.step);
      if (have && have.from <= this.from && have.to >= this.to) return;
      const step = this.step, gen = ++this.generation;
      clearTimeout(this.loadTimer);
      this.loadTimer = setTimeout(async () => {
        this.fetching++; this.render();
        try {
          const maxPoints = 2800, spanMs = STEP_MS[step];
          let from = want.from, to = Math.min(want.to, Date.now() + spanMs);
          if ((to - from) / spanMs > maxPoints) from = to - maxPoints * spanMs;
          const json = await getJson(API + '/series?ids=' + encodeURIComponent(ids.join(',')) + '&from=' + from + '&to=' + to + '&step=' + step);
          if (gen !== this.generation && this.step !== step) return;
          const bySeries = {};
          for (const id of ids) bySeries[id] = ((json.series[id] && json.series[id].points) || []).slice().sort((a, b) => a[0] - b[0]);
          this.cache.set(step, { from, to, bySeries, kind: Object.fromEntries(ids.map(id => [id, json.series[id] ? json.series[id].kind : 'gauge'])) });
          this.error = null;
        } catch (e) { this.error = e; }
        finally { this.fetching--; this.render(); }
      }, 160);
    }
    pointsFor(id) {
      const have = this.cache.get(this.step); if (!have) return [];
      const pts = (have.bySeries[id] || []).filter(p => p[0] >= bucketStart(this.from, this.step) && p[0] < this.to);
      return this.mode === 'cumulative' && this.kindOf(id) === 'count' ? cumulative(pts) : pts;
    }
    kindOf(id) { const s = this.series.find(x => x.id === id); return (s && s.kind) || 'gauge'; }
    axisOf(id) { return this.cfg.dualAxis && this.kindOf(id) === 'gauge' ? 'right' : 'left'; }
    geometry() {
      const rect = this.svg.getBoundingClientRect(), W = Math.max(280, rect.width), H = Math.max(160, rect.height);
      const right = this.cfg.dualAxis && this.visibleSeries().some(s => this.axisOf(s.id) === 'right') ? 52 : 14;
      return { W, H, L: 50, R: right, T: 12, B: 26 };
    }
    xOf(ms, g) { return g.L + (ms - this.from) / (this.to - this.from) * (g.W - g.L - g.R); }
    msOf(x, g) { return this.from + (x - g.L) / (g.W - g.L - g.R) * (this.to - this.from); }
    render() {
      const g = this.geometry(), svg = this.svg, step = this.step;
      svg.setAttribute('viewBox', '0 0 ' + g.W + ' ' + g.H); svg.textContent = '';
      for (const b of this.stepsBox.querySelectorAll('[data-step]')) { b.classList.toggle('is-active', b.dataset.step === step); b.classList.toggle('is-auto', b.dataset.step === step && !this.manualStep); }
      const visible = this.visibleSeries(), data = visible.map(s => ({ s, pts: this.pointsFor(s.id) }));
      const scales = {};
      for (const axis of ['left', 'right']) {
        const vals = [];
        for (const d of data) if (this.axisOf(d.s.id) === axis) for (const p of d.pts) { vals.push(p[1]); if (p[2] !== undefined && this.kindOf(d.s.id) === 'gauge') vals.push(p[2]); }
        if (!vals.length) continue;
        let min = Math.min(...vals), max = Math.max(...vals);
        const zero = this.cfg.zeroBased !== false || axis === 'left' && this.kindOf(visible.find(s => this.axisOf(s.id) === axis).id) === 'count';
        if (zero || min <= 0) min = Math.min(0, min); else min = min - (max - min) * 0.15;
        if (max === min) max = min + 1;
        const nice = niceTicks(min, max, 4);
        scales[axis] = { ...nice, y: v => g.T + (1 - (v - nice.min) / (nice.max - nice.min)) * (g.H - g.T - g.B) };
      }
      const grid = svgEl('g', { class: 'grid' }), axis = svgEl('g', { class: 'axis' });
      const left = scales.left || scales.right;
      if (left) for (const v of left.ticks) {
        const y = left.y(v); grid.appendChild(svgEl('line', { x1: g.L, x2: g.W - g.R, y1: y, y2: y }));
        const t = svgEl('text', { x: g.L - 6, y: y + 3, 'text-anchor': 'end' }); t.textContent = formatNumber(v, (visible[0] || {}).unit); axis.appendChild(t);
      }
      if (scales.right && scales.left) for (const v of scales.right.ticks) { const t = svgEl('text', { x: g.W - g.R + 6, y: scales.right.y(v) + 3 }); t.textContent = formatNumber(v); axis.appendChild(t); }
      const ticks = ticksFor(this.from, this.to, step, g.W - g.L - g.R, 72); let prev;
      for (const ms of ticks) { const x = this.xOf(ms, g); axis.appendChild(svgEl('line', { x1: x, x2: x, y1: g.H - g.B, y2: g.H - g.B + 4 })); const t = svgEl('text', { x, y: g.H - 8, 'text-anchor': 'middle' }); t.textContent = formatTick(ms, step, prev); axis.appendChild(t); prev = ms; }
      axis.appendChild(svgEl('line', { x1: g.L, x2: g.W - g.R, y1: g.H - g.B, y2: g.H - g.B }));
      svg.appendChild(grid); svg.appendChild(axis);
      const bucketPx = Math.max(1, (g.W - g.L - g.R) * STEP_MS[step] / (this.to - this.from));
      const bars = data.filter(d => this.kindOf(d.s.id) === 'count' && this.mode === 'rate'), barW = Math.max(1, Math.min(bucketPx * 0.72 / Math.max(1, bars.length), 40));
      let anyPoint = false;
      data.forEach(({ s, pts }) => {
        if (!pts.length) return; anyPoint = true;
        const sc = scales[this.axisOf(s.id)], y = v => sc.y(v);
        if (this.kindOf(s.id) === 'count' && this.mode === 'rate') {
          const k = bars.findIndex(d => d.s === s), gBar = svgEl('g', { class: 'series-bar', fill: s.color });
          for (const p of pts) { const x0 = this.xOf(p[0], g) + bucketPx / 2 - bars.length * barW / 2 + k * barW, h = Math.max(0, y(sc.min) - y(p[1])); gBar.appendChild(svgEl('rect', { x: x0, y: y(p[1]), width: Math.max(1, barW - 1), height: p[1] === 0 ? 1 : h, ...(p[1] === 0 ? { opacity: .35 } : {}) })); }
          svg.appendChild(gBar); return;
        }
        // A gap breaks the line: wider than 1.6 times the usual spacing of this series (the first day of CPU history
        // was fetched at 2-minute steps, so the step alone would cut every segment). Lone points get a dot.
        const diffs = pts.slice(1).map((p, i) => p[0] - pts[i][0]).filter(v => v > 0).sort((a, b) => a - b);
        const spacing = diffs.length ? diffs[Math.floor(diffs.length / 2)] : STEP_MS[step];
        const gap = 1.6 * Math.max(STEP_MS[step] * (step === 'month' ? 1.1 : 1), spacing), half = bucketPx / 2; let d = '', dp = '', last = null, run = 0;
        const lone = svgEl('g', { fill: s.color });
        pts.forEach((p, i) => {
          const x = this.xOf(p[0], g) + half, broke = last === null || p[0] - last > gap, cmd = broke ? 'M' : 'L';
          if (broke && run === 1) lone.appendChild(svgEl('circle', { cx: this.xOf(pts[i - 1][0], g) + half, cy: y(pts[i - 1][1]), r: 1.8 }));
          run = broke ? 1 : run + 1;
          d += cmd + x.toFixed(1) + ' ' + y(p[1]).toFixed(1); if (p[2] !== undefined) dp += cmd + x.toFixed(1) + ' ' + y(p[2]).toFixed(1); last = p[0];
        });
        if (run === 1) lone.appendChild(svgEl('circle', { cx: this.xOf(pts[pts.length - 1][0], g) + half, cy: y(pts[pts.length - 1][1]), r: 1.8 }));
        if (lone.childNodes.length) svg.appendChild(lone);
        if (this.kindOf(s.id) === 'gauge' && dp && (step === 'day' || step === 'month')) svg.appendChild(svgEl('path', { d: dp, class: 'series-peak', stroke: s.color }));
        if (data.length === 1 || this.mode === 'cumulative') { let area = '', start = null, lastX = null, prev = null; for (const p of pts) { const x = this.xOf(p[0], g) + half; if (start === null || p[0] - prev > gap) { if (start !== null) area += 'L' + lastX + ' ' + y(sc.min) + 'Z'; start = x; area += 'M' + x.toFixed(1) + ' ' + y(sc.min).toFixed(1); } area += 'L' + x.toFixed(1) + ' ' + y(p[1]).toFixed(1); lastX = x.toFixed(1); prev = p[0]; } area += 'L' + lastX + ' ' + y(sc.min) + 'Z'; svg.appendChild(svgEl('path', { d: area, class: 'series-area', fill: s.color })); }
        svg.appendChild(svgEl('path', { d, class: 'series-line', stroke: s.color }));
      });
      const at = this.pinned !== null ? this.pinned : this.cursor;
      if (at !== null && anyPoint) {
        const b = bucketStart(at, step), x = this.xOf(b, g) + bucketPx / 2;
        svg.appendChild(svgEl('line', { x1: x, x2: x, y1: g.T, y2: g.H - g.B, class: 'cursor-line' }));
        for (const { s, pts } of data) { const p = pts.find(q => q[0] === b); if (p) svg.appendChild(svgEl('circle', { cx: x, cy: scales[this.axisOf(s.id)].y(p[1]), r: 3.5, fill: s.color, class: 'cursor-dot' })); }
        this.showTooltip(b, x, g, data);
      } else this.tooltip.hidden = true;
      const overlay = svgEl('rect', { x: g.L, y: g.T, width: g.W - g.L - g.R, height: g.H - g.T - g.B, fill: 'transparent' }); overlay.style.pointerEvents = 'all'; svg.appendChild(overlay);
      const have = this.cache.get(step), count = data.reduce((n, d) => n + d.pts.length, 0);
      this.rangeText.textContent = formatTime(this.from, step === 'month' ? 'day' : step) + ' 〜 ' + formatTime(this.to, step === 'month' ? 'day' : step) + ' · 刻度：' + STEP_LABEL[step] + (this.manualStep ? '（手動）' : '（自動）') + ' · ' + count + ' 點' + (this.fetching ? ' · 讀取中…' : '');
      this.help.textContent = this.cfg.help || '';
      this.emptyNote.hidden = anyPoint || this.fetching > 0 && !have;
      this.emptyNote.textContent = this.error ? '資料暫時讀不到（' + this.error.message + '）' : !visible.length ? '沒有選取任何數據' : this.fetching ? '讀取中…' : '這段時間沒有觀測值';
      if (this.pinned !== null) this.renderDetail(bucketStart(this.pinned, step), data);
    }
    showTooltip(b, x, g, data) {
      const rows = data.map(({ s, pts }) => { const p = pts.find(q => q[0] === b); return '<div class="row" style="--c:' + s.color + '"><span><i></i>' + s.label + '</span><b>' + (p ? formatNumber(p[1], s.unit) + (p[2] !== undefined && this.kindOf(s.id) === 'gauge' && this.step !== 'minute' ? ' <span style="opacity:.7">峰 ' + formatNumber(p[2], s.unit) + '</span>' : '') : '—') + '</b></div>'; });
      this.tooltip.innerHTML = '<div class="t">' + formatBucket(b, this.step) + (this.pinned !== null ? ' · 已固定' : '') + '</div>' + rows.join('');
      this.tooltip.hidden = false;
      const wrap = this.svg.parentElement.getBoundingClientRect(), tw = this.tooltip.offsetWidth, px = x / g.W * wrap.width;
      this.tooltip.style.left = Math.max(4, Math.min(wrap.width - tw - 4, px + 14 > wrap.width - tw ? px - tw - 14 : px + 14)) + 'px';
      this.tooltip.style.top = (g.T + 6) + 'px';
    }
    renderDetail(b, data) {
      const rows = data.map(({ s, pts }) => { const p = pts.find(q => q[0] === b); return '<tr><td style="--c:' + s.color + '">' + s.label + (unitLabel(s.unit) && !/^%/.test(s.unit) ? '（' + unitLabel(s.unit) + '）' : '') + '</td><td class="num">' + (p ? formatNumber(p[1], s.unit) : '無觀測') + '</td><td class="num">' + (p && p[2] !== undefined && this.kindOf(s.id) === 'gauge' ? '峰值 ' + formatNumber(p[2], s.unit) : '') + '</td></tr>'; });
      const kind = this.visibleSeries().some(s => this.kindOf(s.id) === 'gauge') ? (this.step === 'minute' || this.step === 'hour' ? '量值為該時段的觀測' + (this.step === 'hour' ? '平均' : '') : '量值為該時段平均，峰值為最高一小時') : '';
      this.detail.innerHTML = '<button type="button" class="ghost close" data-role="close">關閉</button><h3>' + formatBucket(b, this.step) + '（' + STEP_LABEL[this.step] + '）</h3><table>' + rows.join('') + '</table>' + (kind ? '<div style="color:var(--muted);margin-top:6px;font-size:11px">' + kind + (this.mode === 'cumulative' ? '；件數為可見範圍起算的累計' : '') + '。</div>' : '');
      this.detail.hidden = false;
      $('[data-role=close]', this.detail).addEventListener('click', () => this.unpin());
    }
    unpin() { this.pinned = null; this.detail.hidden = true; this.render(); }
    pin(ms) { this.pinned = ms; this.render(); if (navigator.vibrate) { try { navigator.vibrate(12); } catch (e) { /* no haptics */ } } }
    zoom(factor, anchorX) {
      const g = this.geometry(), anchor = this.msOf(anchorX, g), span = (this.to - this.from) * factor;
      const ratio = (anchor - this.from) / (this.to - this.from);
      this.setRange(anchor - span * ratio, anchor + span * (1 - ratio));
    }
    bindEvents() {
      const svg = this.svg, pointX = e => { const r = svg.getBoundingClientRect(), g = this.geometry(); return (e.clientX - r.left) / r.width * g.W; };
      let drag = null, longPress = null, pinch = null;
      svg.addEventListener('pointerdown', e => {
        svg.setPointerCapture(e.pointerId); this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY }); try { svg.focus({ preventScroll: true }); } catch (x) { /* focus is optional */ }
        if (this.pointers.size === 2) { const [a, b] = [...this.pointers.values()]; pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), from: this.from, to: this.to, mid: (a.x + b.x) / 2 }; clearTimeout(longPress); longPress = null; drag = null; return; }
        drag = { x: e.clientX, from: this.from, to: this.to, moved: false, type: e.pointerType, ms: this.msOf(pointX(e), this.geometry()) };
        clearTimeout(longPress);
        longPress = setTimeout(() => { if (drag && !drag.moved) { this.pin(drag.ms); drag.longPressed = true; } }, 450);
        e.preventDefault();
      });
      svg.addEventListener('pointermove', e => {
        if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pinch && this.pointers.size === 2) {
          const [a, b] = [...this.pointers.values()], dist = Math.hypot(a.x - b.x, a.y - b.y) || 1, r = svg.getBoundingClientRect(), g = this.geometry();
          const factor = pinch.dist / dist, span = (pinch.to - pinch.from) * factor, anchor = pinch.from + ((pinch.mid - r.left) / r.width * g.W - g.L) / (g.W - g.L - g.R) * (pinch.to - pinch.from);
          const ratio = (anchor - pinch.from) / (pinch.to - pinch.from); this.setRange(anchor - span * ratio, anchor + span * (1 - ratio)); return;
        }
        if (drag) {
          const dx = e.clientX - drag.x;
          if (Math.abs(dx) > 5) { drag.moved = true; clearTimeout(longPress); }
          if (drag.moved && !drag.longPressed) { const r = svg.getBoundingClientRect(), g = this.geometry(), per = (drag.to - drag.from) / ((g.W - g.L - g.R) * r.width / g.W); this.setRange(drag.from - dx * per, drag.to - dx * per); }
          return;
        }
        if (e.pointerType === 'mouse' && this.pinned === null) { this.cursor = this.msOf(pointX(e), this.geometry()); this.render(); }
      });
      const up = e => {
        this.pointers.delete(e.pointerId); clearTimeout(longPress); longPress = null;
        if (this.pointers.size < 2) pinch = null;
        if (drag && !drag.moved && !drag.longPressed && e.type === 'pointerup') { if (this.pinned !== null) this.unpin(); else if (drag.type !== 'mouse') this.pin(drag.ms); else this.pin(this.msOf(pointX(e), this.geometry())); }
        drag = null;
      };
      svg.addEventListener('pointerup', up); svg.addEventListener('pointercancel', up);
      svg.addEventListener('pointerleave', () => { if (this.pinned === null && !drag) { this.cursor = null; this.render(); } });
      svg.addEventListener('wheel', e => { if (document.activeElement !== svg && !e.ctrlKey && !e.metaKey) return; e.preventDefault(); if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) { const span = this.to - this.from, d = (e.deltaX || e.deltaY) / 400 * span; this.setRange(this.from + d, this.to + d); return; } this.zoom(Math.pow(1.0015, e.deltaY), pointX(e)); }, { passive: false });
      svg.addEventListener('dblclick', e => { e.preventDefault(); this.zoom(0.5, pointX(e)); });
      svg.addEventListener('keydown', e => {
        const unit = STEP_MS[this.step] * (this.step === 'month' ? 1 : 1), at = this.pinned !== null ? this.pinned : this.cursor !== null ? this.cursor : this.to - unit;
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); const next = e.key === 'ArrowLeft' ? bucketStart(at, this.step) - 1 : bucketNext(at, this.step); if (next < this.from || next >= this.to) { const d = next < this.from ? -unit : unit; this.setRange(this.from + d, this.to + d); } this.pinned = bucketStart(Math.max(this.from, Math.min(this.to - 1, next)), this.step); this.render(); }
        else if (e.key === '+' || e.key === '=') { e.preventDefault(); this.zoom(0.5, (this.geometry().W + this.geometry().L) / 2); }
        else if (e.key === '-') { e.preventDefault(); this.zoom(2, (this.geometry().W + this.geometry().L) / 2); }
        else if (e.key === 'Escape') { this.unpin(); }
        else if (e.key === 'Home') { this.reset(); }
      });
    }
  }

  // ---- page --------------------------------------------------------------------------------------------------------
  const HEALTH = { healthy: '正常', degraded: '部分異常', unhealthy: '異常', unknown: '未知', '': '未知' };
  function text(id, value, note, pending) { const v = $('#' + id); v.textContent = value; v.classList.toggle('is-pending', !!pending); if (note !== undefined) $('#' + id + '-note').textContent = note; }
  function ago(ms) { if (!ms) return ''; const s = Math.max(0, Math.round((Date.now() - ms) / 1000)); return s < 90 ? s + ' 秒前' : s < 5400 ? Math.round(s / 60) + ' 分鐘前' : Math.round(s / 3600) + ' 小時前'; }
  function renderLatest(latest) {
    const st = latest.status, ls = latest.listing, cp = latest.workTotals && latest.workTotals.totals && latest.workTotals.totals['work.wishlist-retail.retail_cp_evaluated'];
    const verified = latest.workTotals && latest.workTotals.totals && latest.workTotals.totals['work.wishlist-retail.retail_prices_verified'];
    const badge = $('#data-mode');
    if (st) {
      const measured = st.workers.filter(w => w.cpuCorePercent !== null), core = measured.reduce((n, w) => n + w.cpuCorePercent, 0), host = measured.reduce((n, w) => n + (w.cpuHostPercent || 0), 0);
      text('m-cpu', measured.length ? core.toFixed(1) + '%' : '未量到', measured.length ? '整機 ' + host.toFixed(2) + '% · ' + measured.length + '/' + st.workers.length + ' 個 worker 有量到 · ' + ago(st.observedAt) : '監控沒有量到任何 worker', !measured.length);
      const online = st.workers.filter(w => w.processOnline).length;
      text('m-health', HEALTH[st.health] || st.health, online + '/' + st.workers.length + ' 個 worker 程序在線 · 監控' + (st.monitorStatus === 'healthy' ? '正常' : st.monitorStatus || '狀態未知'));
      $('#observed-at').textContent = st.observedAt ? '觀測 ' + formatTime(st.observedAt, 'minute') : '';
      const fresh = latest.cpuFreshness && latest.cpuFreshness.dataFresh;
      badge.textContent = fresh ? '監控資料即時' : '監控資料延遲'; badge.className = 'data-badge' + (fresh ? '' : ' is-warn');
    } else { text('m-cpu', '尚無資料', '', true); text('m-health', '尚無資料', '', true); badge.textContent = '尚未收到監控資料'; badge.className = 'data-badge is-bad'; }
    if (ls) {
      text('m-listed', ls.today && ls.today.count !== null ? ls.today.count.toLocaleString('en-US') : '—', (ls.yesterday && ls.yesterday.count !== null ? '昨日 ' + ls.yesterday.count.toLocaleString('en-US') + ' 件 · ' : '') + (ls.perHour24h !== null ? '近 24 小時每小時 ' + ls.perHour24h + ' 件' : '') + (ls.targetPerHour ? '（目標 ' + ls.targetPerHour + '）' : ''), !(ls.today && ls.today.count !== null));
      text('m-visible', ls.publiclyVisible !== null ? ls.publiclyVisible.toLocaleString('en-US') : '—', (ls.records && ls.records.published !== null ? '已公開紀錄 ' + ls.records.published.toLocaleString('en-US') : '') + (ls.waitingToPublish !== null ? ' · 待公開 ' + ls.waitingToPublish : '') + (ls.cumulative && ls.cumulative.count !== null ? ' · 累計上架 ' + ls.cumulative.count.toLocaleString('en-US') : ''), ls.publiclyVisible === null);
    } else { text('m-listed', '尚無資料', '', true); text('m-visible', '尚無資料', '', true); }
    if (cp && cp.knownTotalLowerBound !== null) text('m-cp', (cp.isCompleteHistory ? '' : '≥ ') + cp.knownTotalLowerBound.toLocaleString('en-US'), (cp.collectionStartedAt ? '自 ' + formatTime(cp.collectionStartedAt, 'day') + ' 起統計' : '') + (verified && verified.knownTotalLowerBound !== null ? ' · 原價寫入 ≥ ' + verified.knownTotalLowerBound : '') + (cp.lastCompletedAt ? ' · 最近完成 ' + ago(cp.lastCompletedAt) : ''));
    else text('m-cp', '尚無資料', '監控尚未回報 wishlist-retail 指標', true);
    const ch = latest.chatPending;
    if (ch && ch.pendingCount !== null) text('m-chat', String(ch.pendingCount), (ch.needApproval !== null ? '待核准 ' + ch.needApproval + ' · ' : '') + (ch.approvedWaitingSend !== null ? '待轉達 ' + ch.approvedWaitingSend + ' · ' : '') + '觀測 ' + ago(ch.observedAt));
    else text('m-chat', '未知', '監控尚未回報聊聊待問數', true);
  }

  async function main() {
    const charts = {
      cpu: new WaveChart($('[data-chart=cpu]'), { minStep: 'minute', defaultSpan: 6 * 3600e3, zeroBased: true, help: '滾輪／雙指縮放、拖曳平移；長按或點一下固定某一分鐘看每個 worker 的數值。' }),
      work: new WaveChart($('[data-chart=work]'), { minStep: 'hour', defaultSpan: 7 * 86400e3, zeroBased: true, help: '只有監控整小時都在看的時段才有數字，其他留空；區間累計從可見範圍的第一格起算。' }),
      wishlist: new WaveChart($('[data-chart=wishlist]'), { minStep: 'hour', defaultSpan: 7 * 86400e3, zeroBased: true, dualAxis: true, help: '件數畫在左軸、存量（公開可見、待公開、聊聊待問）畫在右軸；長按看該時段所有數值。' }),
    };
    let catalog;
    try { catalog = await getJson(API + '/catalog'); } catch (e) { for (const c of Object.values(charts)) { c.error = e; c.render(); } $('#data-mode').textContent = '資料服務暫時無法連線'; $('#data-mode').className = 'data-badge is-bad'; return; }
    const series = catalog.series, byId = Object.fromEntries(series.map(s => [s.id, s]));
    const firstHour = catalog.coverage && catalog.coverage.hour && catalog.coverage.hour.first ? Date.parse(catalog.coverage.hour.first) : NaN;
    if (Number.isFinite(firstHour)) for (const c of Object.values(charts)) c.floor = firstHour - 86400e3;
    const cpuSeries = [byId['cpu.total.core'], ...series.filter(s => s.group === 'cpu' && s.worker && s.id.endsWith('.core'))].filter(Boolean).map((s, i) => ({ ...s, label: s.worker ? s.label : '全部 worker', hiddenByDefault: i > 0 && !/wishlist|timehut|dream/.test(s.id) }));
    charts.cpu.setSeries(cpuSeries);
    // Work chart: one worker at a time (units differ between workers), chosen in the select.
    const workSeries = series.filter(s => s.group === 'work'), workers = [];
    for (const s of workSeries) if (!workers.some(w => w.id === s.worker)) workers.push({ id: s.worker, name: s.workerName || s.worker });
    const sel = $('#work-metric'); sel.textContent = '';
    for (const w of workers) sel.appendChild(el('option', { value: w.id }, w.name));
    const pickWorker = id => charts.work.setSeries(workSeries.filter(s => s.worker === id).map(s => ({ ...s, label: s.label })));
    if (workers.length) { const preferred = workers.find(w => w.id === 'timehut-shiguang') || workers[0]; sel.value = preferred.id; pickWorker(preferred.id); }
    else { sel.appendChild(el('option', { value: '' }, '監控尚未回報工作量')); charts.work.render(); }
    sel.addEventListener('change', () => pickWorker(sel.value));
    const wl = id => byId[id];
    const wishlistSeries = [
      wl('wishlist.listed') && { ...wl('wishlist.listed'), label: '成功上架' },
      wl('work.wishlist-retail.retail_cp_evaluated') && { ...wl('work.wishlist-retail.retail_cp_evaluated'), label: 'CP 評估完成', unit: 'product' },
      wl('work.wishlist-retail.retail_lookups_completed') && { ...wl('work.wishlist-retail.retail_lookups_completed'), label: '原價查價完成', hiddenByDefault: true },
      wl('work.wishlist-retail.retail_prices_verified') && { ...wl('work.wishlist-retail.retail_prices_verified'), label: '原價寫入', hiddenByDefault: true },
      wl('wishlist.republished') && { ...wl('wishlist.republished'), label: '重新公開', hiddenByDefault: true },
      wl('wishlist.visible') && { ...wl('wishlist.visible'), label: '公開可見商品', hiddenByDefault: true },
      wl('wishlist.waiting') && { ...wl('wishlist.waiting'), label: '待公開', hiddenByDefault: true },
      wl('wishlist.chatPending') && { ...wl('wishlist.chatPending'), label: '聊聊待問', hiddenByDefault: true },
    ].filter(Boolean);
    charts.wishlist.setSeries(wishlistSeries);
    const refreshLatest = async () => { try { renderLatest(await getJson(API + '/latest')); } catch (e) { $('#data-mode').textContent = '狀態暫時讀不到'; $('#data-mode').className = 'data-badge is-warn'; } };
    await refreshLatest();
    setInterval(() => { if (!document.hidden) { refreshLatest(); for (const c of Object.values(charts)) { c.cache.clear(); c.load(); } } }, 5 * 60e3);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', main); else main();
})(typeof window !== 'undefined' ? window : null);
