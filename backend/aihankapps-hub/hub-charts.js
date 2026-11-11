/* global window, document, ResizeObserver */
/* AiHankApps 管理中樞：圖表元件。純 SVG，沒有外部函式庫。
   規格：線 2px、面積 10% 淡底、格線實心細線、長條最寬 24px 且頂端圓角、
   游標吸附到最近的時間格、一個提示框列出所有數列、拖曳選取放大、同組圖表游標同步。 */
(function (global) {
  'use strict';

  const D = global.HubData, MIN = D.MIN, HOUR = D.HOUR, DAY = D.DAY, TZ = D.TZ;
  const NS = 'http://www.w3.org/2000/svg';
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  function S(name, attrs, style) {
    const e = document.createElementNS(NS, name);
    if (attrs) for (const k in attrs) if (attrs[k] != null) e.setAttribute(k, attrs[k]);
    if (style) for (const k in style) if (style[k] != null) e.style.setProperty(k, style[k]);
    return e;
  }
  function H(name, cls, text) {
    const e = document.createElement(name);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // ---- 數字與時間（一律台北時間）-------------------------------------------
  const nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
  const fmtInt = v => nf0.format(Math.round(v));
  const trimNum = x => String(Math.round(x * 100) / 100);
  function big(v) {
    const a = Math.abs(v);
    if (a >= 1e8) return (v / 1e8).toFixed(2) + ' 億';
    if (a >= 1e6) return fmtInt(v / 1e4) + ' 萬';
    return fmtInt(v);
  }
  const F = {
    int: big,
    full: fmtInt,
    money: v => 'NT$' + (Math.abs(v) < 100 ? trimNum(v) : big(v)),   // 金額很小的時候保留到分
    cpu: v => v.toFixed(1) + '%',
    mem: v => (v >= 1073741824 ? (v / 1073741824).toFixed(2) + ' GB' : fmtInt(v / 1048576) + ' MB'),
    // 資料量，單位 MB：1 GB 以上寫 GB
    mb: v => (Math.abs(v) >= 1024 ? (v / 1024).toFixed(Math.abs(v) >= 10240 ? 1 : 2) + ' GB' : (Math.abs(v) < 10 ? trimNum(Math.round(v * 100) / 100) : fmtInt(v)) + ' MB'),
    fix1: v => v.toFixed(1),
    num: v => (Math.abs(v) < 100 && v % 1 ? v.toFixed(1) : big(v)),   // 日均這類可能有小數的數字
    pct1: v => v.toFixed(1) + '%',
    pct2: v => v.toFixed(2) + '%',
    ms: v => fmtInt(v) + ' ms',
    fix2: v => v.toFixed(2),
    sec: v => v.toFixed(1) + ' 秒',
    text: v => String(v)
  };
  const fmt = (kind, v) => (v == null || (typeof v === 'number' && isNaN(v)) ? '—' : F[kind](v));
  function axisFmt(kind) {
    return function (hi, step) {
      if (kind === 'pct1' || kind === 'pct2' || kind === 'cpu') { const d = step >= 1 ? 0 : step >= 0.1 ? 1 : 2; return v => v.toFixed(d) + '%'; }
      if (kind === 'fix2') { const d = step >= 1 ? 0 : step >= 0.1 ? 1 : 2; return v => v.toFixed(d); }
      if (kind === 'mb') { if (hi >= 1024) { const d = step >= 1024 ? 0 : 1; return v => (v === 0 ? '0' : (v / 1024).toFixed(d) + ' GB'); } return v => (v === 0 ? '0' : trimNum(Math.round(v * 10) / 10) + ' MB'); }
      // 刻度間距到萬才用「萬」，否則寫完整數字：一條軸只用一種寫法
      if (step >= 1e8) return v => (v === 0 ? '0' : trimNum(v / 1e8) + ' 億');
      if (step >= 1e4) return v => (v === 0 ? '0' : trimNum(v / 1e4) + ' 萬');
      if (step < 1) { const d = step >= 0.1 ? 1 : 2; return v => v.toFixed(d); }
      return v => fmtInt(v);
    };
  }
  const DOW = ['日', '一', '二', '三', '四', '五', '六'];
  const p2 = n => (n < 10 ? '0' + n : '' + n);
  function tp(t) {
    const d = new Date(t + TZ);
    return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds(), dow: d.getUTCDay() };
  }
  const fTime = t => { const p = tp(t); return p2(p.h) + ':' + p2(p.mi); };
  const fClock = t => { const p = tp(t); return p2(p.h) + ':' + p2(p.mi) + ':' + p2(p.s); };
  const fDate = t => { const p = tp(t); return p.mo + '/' + p.d; };
  const fDateDow = t => { const p = tp(t); return p.mo + '/' + p.d + '（' + DOW[p.dow] + '）'; };
  const fStamp = t => fDate(t) + ' ' + fTime(t);
  const fIso = t => { const p = tp(t); return p.y + '-' + p2(p.mo) + '-' + p2(p.d) + ' ' + p2(p.h) + ':' + p2(p.mi); };
  function fBucket(t, step) {
    if (step > DAY) return fDate(t) + '–' + fDate(t + step - DAY);
    if (step === DAY) return fDateDow(t);
    if (step < 5 * MIN) return fDateDow(t) + ' ' + (step < MIN ? fClock(t) : fTime(t));
    return fDateDow(t) + ' ' + fTime(t) + '–' + fTime(t + step);
  }
  function fAgo(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return s + ' 秒前';
    const m = Math.floor(s / 60);
    if (m < 60) return m + ' 分鐘前';
    const h = Math.floor(m / 60);
    if (h < 24) return h + ' 小時前';
    return Math.floor(h / 24) + ' 天前';
  }
  function fDur(ms) {
    const m = Math.max(1, Math.round(ms / MIN));
    if (m < 60) return m + ' 分鐘';
    const h = Math.floor(m / 60), r = m % 60;
    if (h < 24) return h + ' 小時' + (r ? ' ' + r + ' 分' : '');
    const d = Math.floor(h / 24), hr = h % 24;
    return d + ' 天' + (hr ? ' ' + hr + ' 小時' : '');
  }

  // ---- 刻度 -----------------------------------------------------------------
  // 找出「刻度數不超過 maxTicks」的最小整齊間距，軸才不會留一大段空白
  function scaleY(lo, hi, zero, maxTicks, max, integer) {
    if (!(hi > lo)) hi = lo + (Math.abs(lo) || 1);
    const mag = Math.pow(10, Math.floor(Math.log10((hi - lo) / maxTicks)));
    let step = 10 * mag, a = 0, b = hi;
    for (const m of (mag >= 10 ? [1, 2, 2.5, 5, 10, 20] : [1, 2, 5, 10, 20])) { // 2.5 只在結果是整數時才用
      const s = m * mag;
      if (integer && s < 1) continue;
      a = zero ? 0 : Math.floor(lo / s + 1e-9) * s;
      b = Math.ceil(hi / s - 1e-9) * s;
      step = s;
      if ((b - a) / s <= maxTicks + 1e-9) break;
    }
    if (max != null && b > max) b = max;
    const ticks = [];
    for (let v = a; v <= b + step * 1e-6; v += step) ticks.push(+v.toFixed(8));
    if (ticks.length < 2) ticks.push(+(a + step).toFixed(8));
    return { lo: a, hi: Math.max(b, ticks[ticks.length - 1]), ticks: ticks, step: step };
  }
  const TICKS = [MIN, 5 * MIN, 15 * MIN, 30 * MIN, HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY, 3 * DAY, 7 * DAY, 14 * DAY, 28 * DAY, 56 * DAY, 91 * DAY];
  function timeTicks(from, to, maxCount) {
    let st = TICKS[TICKS.length - 1];
    for (const c of TICKS) if ((to - from) / c <= maxCount) { st = c; break; }
    const out = [];
    for (let t = Math.ceil((from + TZ) / st) * st - TZ; t <= to; t += st) out.push(t);
    return { step: st, ticks: out };
  }
  function tickLabel(t, st) {
    if (st >= DAY) return fDate(t);
    const p = tp(t);
    if (st < MIN) return fClock(t);
    return p.h === 0 && p.mi === 0 ? fDate(t) : fTime(t);
  }
  function textW(s) {
    let w = 0;
    for (const ch of String(s)) w += ch.charCodeAt(0) > 0x2e7f ? 11 : ch === ' ' ? 3 : 6.3;
    return w;
  }
  function downsample(vals, target) {
    if (vals.length <= target) return vals;
    const k = Math.ceil(vals.length / target), out = [];
    for (let i = 0; i < vals.length; i += k) {
      let s = 0, c = 0;
      for (let j = i; j < Math.min(vals.length, i + k); j++) if (vals[j] != null) { s += vals[j]; c++; }
      out.push(c ? s / c : null);
    }
    return out;
  }

  // ---- 提示框（整頁共用一個）-----------------------------------------------
  let tipEl = null;
  function tipNode() { return tipEl || (tipEl = document.getElementById('tip')); }
  function tipShow(node, x, y) {
    const t = tipNode();
    if (!t) return;
    t.replaceChildren(node);
    t.hidden = false;
    const r = t.getBoundingClientRect(), vw = document.documentElement.clientWidth, vh = window.innerHeight;
    let left = x + 14;
    if (left + r.width > vw - 8) left = x - 14 - r.width;
    t.style.left = clamp(left, 8, Math.max(8, vw - r.width - 8)) + 'px';
    t.style.top = clamp(y - r.height / 2, 8, Math.max(8, vh - r.height - 8)) + 'px';
  }
  // 貼在某個元素上方（放不下就改放下方），給長條、色塊這類「一個標記一個提示」用
  function tipAt(node, rect) {
    const t = tipNode();
    if (!t) return;
    t.replaceChildren(node);
    t.hidden = false;
    const r = t.getBoundingClientRect(), vw = document.documentElement.clientWidth, vh = window.innerHeight;
    let top = rect.top - r.height - 8;
    if (top < 8) top = Math.min(Math.max(8, vh - r.height - 8), rect.bottom + 8);
    t.style.left = clamp(rect.left + rect.width / 2 - r.width / 2, 8, Math.max(8, vw - r.width - 8)) + 'px';
    t.style.top = top + 'px';
  }
  function tipHide() { const t = tipNode(); if (t) t.hidden = true; }
  function tipLines(lines, rect) {
    const box = H('div', 'tip-box');
    lines.forEach((ln, i) => box.appendChild(H('div', i === 0 ? 'tip-h' : 'tip-t', ln)));
    tipAt(box, rect);
  }

  // ---- 時間序列圖 ------------------------------------------------------------
  const groups = {};
  const charts = new Set();

  const MARK_KIND = { release: '版本', deploy: '部署', campaign: '活動', incident: '事故' };
  function markGlyph(kind, x, y) {
    const s = 4.5;
    if (kind === 'deploy') return S('rect', { x: x - s + 0.5, y: y - s + 0.5, width: 2 * s - 1, height: 2 * s - 1, class: 'tc-mark' });
    if (kind === 'campaign') return S('path', { d: 'M' + x + ' ' + (y - s - 1) + 'L' + (x + s + 1) + ' ' + y + 'L' + x + ' ' + (y + s + 1) + 'L' + (x - s - 1) + ' ' + y + 'Z', class: 'tc-mark' });
    if (kind === 'incident') return S('circle', { cx: x, cy: y, r: s, class: 'tc-mark is-incident' });
    return S('path', { d: 'M' + x + ' ' + (y - s - 0.5) + 'L' + (x + s + 0.5) + ' ' + (y + s) + 'L' + (x - s - 0.5) + ' ' + (y + s) + 'Z', class: 'tc-mark' });
  }

  function timeChart(host, cfg) {
    const st = { cfg: cfg, cur: -1, pinned: false, tip: false, hidden: {}, drag: null, geo: null };
    host.classList.add('tc');
    host.textContent = '';
    const interactive = !cfg.compact || cfg.hover;
    const svg = S('svg', { class: 'tc-svg', role: 'img' });
    if (interactive && !cfg.compact) svg.setAttribute('tabindex', '0');
    const gStatic = S('g'), gCur = S('g', { class: 'tc-cur' });
    const brushEl = S('rect', { class: 'tc-brush', x: 0, y: 0, width: 0, height: 0 });
    const hit = S('rect', { class: 'tc-hit', x: 0, y: 0, width: 0, height: 0 });
    brushEl.style.display = 'none';
    svg.appendChild(gStatic); svg.appendChild(gCur); svg.appendChild(brushEl);
    if (interactive) svg.appendChild(hit);
    host.appendChild(svg);

    const visible = () => st.cfg.series.filter(s => !st.hidden[s.key]);

    function draw() {
      const c = st.cfg, w = host.clientWidth, h = c.height || host.clientHeight || 200;
      if (!w || !h || !c.x.length) return;
      const n = c.x.length, ser = visible();
      svg.setAttribute('width', w); svg.setAttribute('height', h); svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
      if (c.label) svg.setAttribute('aria-label', c.label);
      gStatic.textContent = '';

      let lo = Infinity, hi = -Infinity;
      if (c.stacked) {
        lo = 0; hi = 0;
        for (let i = 0; i < n; i++) { let s = 0; for (const r of ser) s += r.values[i] || 0; if (s > hi) hi = s; }
      } else {
        for (const r of ser) for (let i = 0; i < n; i++) { const v = r.values[i]; if (v == null) continue; if (v < lo) lo = v; if (v > hi) hi = v; }
      }
      if (c.threshold) { lo = Math.min(lo, c.threshold.value); hi = Math.max(hi, c.threshold.value); }
      if (!isFinite(lo) || !isFinite(hi)) { lo = 0; hi = 1; }
      const zero = c.zero !== false;
      if (c.domain) { lo = c.domain[0]; hi = c.domain[1]; } else if (!zero) { const pad = (hi - lo) * 0.18 || Math.abs(hi) * 0.01 || 1; lo = Math.max(0, lo - pad); hi += pad; } else if (c.compact) { hi *= 1.08; }
      const ys = c.compact ? { lo: zero ? 0 : lo, hi: hi > (zero ? 0 : lo) ? hi : (zero ? 0 : lo) + 1, ticks: [], step: 1 } : scaleY(zero ? 0 : lo, hi, zero, h >= 240 ? 5 : 4, c.max, c.integer);
      const fa = c.axisFmt ? c.axisFmt(ys.hi, ys.step) : String;
      const lines = ser.filter(r => r.style !== 'bar'), named = lines.filter(r => r.style !== 'dash');
      const direct = !c.compact && !c.stacked && c.direct !== false && named.length >= 2 && named.length <= 4;
      let labW = 0, nameW = 0;
      if (!c.compact) for (const v of ys.ticks) labW = Math.max(labW, textW(fa(v)));
      if (direct) for (const r of named) nameW = Math.max(nameW, textW(r.short || r.name));
      const hasMarks = !c.compact && c.annotations && c.annotations.length;
      const m = c.compact ? { l: 1, r: 6, t: 6, b: 3 } : { l: labW + 12, r: direct ? nameW + 16 : 12, t: hasMarks ? 22 : 10, b: 24 };
      const pw = Math.max(10, w - m.l - m.r), ph = Math.max(10, h - m.t - m.b), band = pw / n;
      const X = i => m.l + (i + 0.5) * band;
      const Y = v => m.t + ph * (1 - (v - ys.lo) / (ys.hi - ys.lo));
      const t0 = c.x[0], span = n * c.step, XT = t => m.l + ((t - t0) / span) * pw;
      st.geo = { m: m, pw: pw, ph: ph, band: band, n: n, X: X, Y: Y };
      const add = el => gStatic.appendChild(el);

      if (c.bands) for (const b of c.bands) {
        const x1 = Math.max(m.l, XT(b.from)), x2 = Math.min(m.l + pw, XT(b.to));
        if (x2 > x1) add(S('rect', { x: x1, y: m.t, width: x2 - x1, height: ph, class: 'tc-band' }, { fill: b.color || 'var(--crit)' }));
      }
      if (!c.compact) {
        for (const v of ys.ticks) {
          const y = Math.round(Y(v)) + 0.5;
          add(S('line', { x1: m.l, x2: m.l + pw, y1: y, y2: y, class: v === ys.lo ? 'tc-base' : 'tc-grid' }));
          const tx = S('text', { x: m.l - 8, y: y + 3.5, 'text-anchor': 'end', class: 'tc-tick' });
          tx.textContent = fa(v);
          add(tx);
        }
        // 每格一天以上：刻度放在格子正中央，標那一格開始的日期；更細的時間才用整點對齊的刻度
        const maxTicks = Math.max(2, Math.floor(pw / 58)), marks = [];
        if (c.step >= DAY) { const k = Math.max(1, Math.ceil(n / maxTicks)); for (let i = 0; i < n; i += k) marks.push([X(i), fDate(c.x[i])]); }
        else { const tt = timeTicks(t0, t0 + span, maxTicks); for (const t of tt.ticks) marks.push([XT(t), tickLabel(t, tt.step)]); }
        for (const mk of marks) {
          const x = mk[0];
          add(S('line', { x1: x, x2: x, y1: m.t + ph, y2: m.t + ph + 4, class: 'tc-base' }));
          const tx = S('text', { x: x, y: m.t + ph + 17, 'text-anchor': x > m.l + pw - 16 ? 'end' : x < m.l + 16 ? 'start' : 'middle', class: 'tc-tick' });
          tx.textContent = mk[1];
          add(tx);
        }
      }

      const bars = ser.filter(r => r.style === 'bar');
      if (bars.length) {
        const bw = Math.max(1.5, Math.min(24, band - 2)), gap = c.stacked && bars.length > 1 ? 2 : 0;
        for (let i = 0; i < n; i++) {
          let base = 0;
          const segs = [];
          for (const r of bars) { const v = r.values[i]; if (!(v > 0)) continue; segs.push({ r: r, a: base, b: base + v }); if (c.stacked) base += v; }
          segs.forEach((sg, k) => {
            const top = Y(sg.b), bot = Y(sg.a) - (k > 0 ? gap : 0), hh = bot - top;
            if (hh < 0.5) return;
            const x = X(i) - bw / 2, rr = k === segs.length - 1 ? Math.min(4, bw / 2, hh) : 0;
            const d = rr
              ? 'M' + x + ' ' + bot + 'V' + (top + rr) + 'Q' + x + ' ' + top + ' ' + (x + rr) + ' ' + top + 'H' + (x + bw - rr) + 'Q' + (x + bw) + ' ' + top + ' ' + (x + bw) + ' ' + (top + rr) + 'V' + bot + 'Z'
              : 'M' + x + ' ' + bot + 'V' + top + 'H' + (x + bw) + 'V' + bot + 'Z';
            add(S('path', { d: d, class: 'tc-bar' }, { fill: sg.r.color }));
          });
        }
      }

      const linePath = vals => {
        let d = '', pen = false;
        for (let i = 0; i < n; i++) {
          const v = vals[i];
          if (v == null) { pen = false; continue; }
          d += (pen ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(v).toFixed(1);
          pen = true;
        }
        return d;
      };
      const areaPath = vals => {
        let d = '', open = false;
        const yb = Y(ys.lo).toFixed(1);
        for (let i = 0; i <= n; i++) {
          const v = i < n ? vals[i] : null;
          if (v != null) {
            if (!open) { d += 'M' + X(i).toFixed(1) + ' ' + yb; open = true; }
            d += 'L' + X(i).toFixed(1) + ' ' + Y(v).toFixed(1);
          } else if (open) { d += 'L' + X(i - 1).toFixed(1) + ' ' + yb + 'Z'; open = false; }
        }
        return d;
      };
      for (const r of lines) if (r.style === 'area') add(S('path', { d: areaPath(r.values), class: 'tc-area' }, { fill: r.color }));
      for (const r of lines) if (r.style === 'dash') add(S('path', { d: linePath(r.values), class: 'tc-line is-dash' }, { stroke: r.color }));
      for (const r of named) add(S('path', { d: linePath(r.values), class: 'tc-line' + (c.compact ? ' is-thin' : '') }, { stroke: r.color }));

      if (c.threshold) {
        const y = Math.round(Y(c.threshold.value)) + 0.5, tk = c.threshold.kind === 'target' ? ' is-target' : '';
        add(S('line', { x1: m.l, x2: m.l + pw, y1: y, y2: y, class: 'tc-th' + tk }));
        if (!c.compact && c.threshold.label) {
          // 線太靠近上緣時，標籤改放線的下方，才不會被切掉
          const tx = S('text', { x: m.l + pw - 4, y: y - 5 < m.t + 8 ? y + 14 : y - 5, 'text-anchor': 'end', class: 'tc-th-l' + tk });
          tx.textContent = c.threshold.label;
          add(tx);
        }
      }
      if (hasMarks) for (const a of c.annotations) {
        if (a.t < t0 || a.t > t0 + span) continue;
        const x = Math.round(XT(a.t)) + 0.5;
        add(S('line', { x1: x, x2: x, y1: m.t - 3, y2: m.t + ph, class: 'tc-mark-l' }));
        add(markGlyph(a.kind, x, m.t - 11));
      }

      const ends = [];
      for (const r of named) {
        let j = n - 1;
        while (j >= 0 && r.values[j] == null) j--;
        if (j < 0) continue;
        const cy = Y(r.values[j]);
        add(S('circle', { cx: X(j), cy: cy, r: c.compact ? 3 : 4, class: 'tc-dot' }, { fill: r.color }));
        ends.push({ r: r, cy: cy });
      }
      if (direct) {
        ends.sort((a, b) => a.cy - b.cy);
        let ok = ends.length > 0;
        for (let k = 1; k < ends.length; k++) if (ends[k].cy - ends[k - 1].cy < 13) ok = false;
        if (ok) for (const e of ends) {
          const tx = S('text', { x: m.l + pw + 8, y: e.cy + 4, class: 'tc-dl' });
          tx.textContent = e.r.short || e.r.name;
          add(tx);
        }
      }

      hit.setAttribute('x', m.l); hit.setAttribute('y', m.t); hit.setAttribute('width', pw); hit.setAttribute('height', ph);
      if (st.cur >= n) st.cur = n - 1;
      paintCursor();
      if (st.tip && st.cur >= 0) showTooltip();
    }

    function paintCursor() {
      gCur.textContent = '';
      const g = st.geo, c = st.cfg;
      if (!g || st.cur < 0 || st.cur >= g.n) return;
      const x = g.X(st.cur);
      if (c.series.some(r => r.style === 'bar')) gCur.appendChild(S('rect', { x: x - g.band / 2, y: g.m.t, width: g.band, height: g.ph, class: 'tc-cur-band' }));
      else gCur.appendChild(S('line', { x1: x, x2: x, y1: g.m.t, y2: g.m.t + g.ph, class: 'tc-cur-l' }));
      for (const r of visible()) {
        if (r.style === 'bar') continue;
        const v = r.values[st.cur];
        if (v == null) continue;
        gCur.appendChild(S('circle', { cx: x, cy: g.Y(v), r: r.style === 'dash' ? 3 : c.compact ? 3 : 4, class: 'tc-dot' }, { fill: r.color }));
      }
    }
    function paintBrush(a, b) {
      const g = st.geo;
      if (!g || a < 0) { brushEl.style.display = 'none'; return; }
      const i0 = Math.min(a, b), i1 = Math.max(a, b);
      brushEl.setAttribute('x', g.m.l + i0 * g.band); brushEl.setAttribute('y', g.m.t);
      brushEl.setAttribute('width', (i1 - i0 + 1) * g.band); brushEl.setAttribute('height', g.ph);
      brushEl.style.display = '';
    }
    function showTooltip() {
      const g = st.geo, c = st.cfg, i = st.cur;
      if (!g || i < 0 || c.tooltip === false) return;
      const box = H('div', 'tip-box');
      box.appendChild(H('div', 'tip-h', c.tipTitle ? c.tipTitle(i) : fBucket(c.x[i], c.step)));
      let sum = 0, cnt = 0;
      for (const r of visible()) {
        const v = r.values[i], row = H('div', 'tip-r');
        const key = H('i', 'tip-k' + (r.style === 'dash' ? ' is-dash' : r.style === 'bar' ? ' is-bar' : ''));
        key.style.setProperty('--c', r.color);
        row.appendChild(key);
        row.appendChild(H('span', 'tip-n', r.name));
        row.appendChild(H('b', 'tip-v', v == null ? '—' : c.fmt(v)));
        box.appendChild(row);
        if (v != null && r.style !== 'dash') { sum += v; cnt++; }
      }
      if (c.stacked && cnt > 1) {
        const row = H('div', 'tip-r is-total');
        row.appendChild(H('span', 'tip-n', '合計'));
        row.appendChild(H('b', 'tip-v', c.fmt(sum)));
        box.appendChild(row);
      }
      if (c.tipExtra) { const extra = c.tipExtra(i); if (extra) box.appendChild(H('div', 'tip-x', extra)); }
      if (c.annotations) for (const a of c.annotations) if (a.t >= c.x[i] && a.t < c.x[i] + c.step) box.appendChild(H('div', 'tip-a', (MARK_KIND[a.kind] || '記號') + '・' + a.label));
      if (st.pinned) box.appendChild(H('div', 'tip-f', '已釘選，再點一下或按 Esc 取消'));
      const r = svg.getBoundingClientRect();
      tipShow(box, r.left + g.X(i), r.top + g.m.t + Math.min(g.ph * 0.35, 70));
      st.tip = true;
    }

    function broadcast(i) {
      const name = st.cfg.group;
      if (!name || !groups[name]) return;
      const t = i < 0 ? null : st.cfg.x[i] + st.cfg.step / 2;
      groups[name].forEach(o => { if (o !== api) o.sync(t); });
    }
    function setCur(i, src) {
      st.cur = i;
      paintCursor();
      if (src) { showTooltip(); broadcast(i); }
      if (st.cfg.onHover) st.cfg.onHover(i);
    }
    function clearCur(src) {
      st.cur = -1; st.tip = false;
      paintCursor();
      if (src) { tipHide(); broadcast(-1); }
      if (st.cfg.onHover) st.cfg.onHover(-1);
    }
    function setPinned(v) { st.pinned = v; host.classList.toggle('is-pinned', v); }
    function idxAt(e) {
      const g = st.geo, r = svg.getBoundingClientRect();
      return clamp(Math.floor((e.clientX - r.left - g.m.l) / g.band), 0, g.n - 1);
    }

    if (interactive) {
      hit.addEventListener('pointerdown', e => {
        if (e.button || !st.geo) return;
        try { hit.setPointerCapture(e.pointerId); } catch (_) { /* 不支援時照常運作 */ }
        st.drag = { x: e.clientX, i: idxAt(e), moved: false };
        if (!st.pinned) setCur(st.drag.i, true);
      });
      hit.addEventListener('pointermove', e => {
        if (!st.geo) return;
        if (st.drag) {
          if (st.cfg.onBrush && Math.abs(e.clientX - st.drag.x) > 5) {
            st.drag.moved = true;
            paintBrush(st.drag.i, idxAt(e));
            tipHide(); st.tip = false;
          }
          return;
        }
        if (!st.pinned) setCur(idxAt(e), true);
      });
      hit.addEventListener('pointerup', e => {
        const d = st.drag;
        st.drag = null;
        if (!d || !st.geo) return;
        if (d.moved) {
          const a = Math.min(d.i, idxAt(e)), b = Math.max(d.i, idxAt(e)), c = st.cfg;
          paintBrush(-1);
          setPinned(false);
          clearCur(true);
          if (b > a) c.onBrush(c.x[a], c.x[b] + c.step);
          return;
        }
        if (st.cfg.onClick) { st.cfg.onClick(idxAt(e)); return; }
        if (st.cfg.pin === false) return;
        setPinned(!st.pinned);
        setCur(idxAt(e), true);
      });
      hit.addEventListener('pointercancel', () => { st.drag = null; paintBrush(-1); if (!st.pinned) clearCur(true); });
      hit.addEventListener('pointerleave', () => { if (!st.pinned && !st.drag) clearCur(true); });
      svg.addEventListener('keydown', e => {
        const g = st.geo;
        if (!g) return;
        let i = st.cur < 0 ? g.n - 1 : st.cur;
        if (e.key === 'ArrowLeft') i -= e.shiftKey ? 10 : 1;
        else if (e.key === 'ArrowRight') i += e.shiftKey ? 10 : 1;
        else if (e.key === 'Home') i = 0;
        else if (e.key === 'End') i = g.n - 1;
        else if (e.key === 'Escape') { setPinned(false); clearCur(true); return; }
        else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setPinned(!st.pinned); setCur(clamp(i, 0, g.n - 1), true); return; }
        else return;
        e.preventDefault();
        setCur(clamp(i, 0, g.n - 1), true);
      });
      svg.addEventListener('focus', () => { if (st.cur < 0 && st.geo && svg.matches(':focus-visible')) setCur(st.geo.n - 1, true); });
      svg.addEventListener('blur', () => { if (!st.pinned) clearCur(true); });
    }

    const api = {
      get cfg() { return st.cfg; },
      hidden: st.hidden,
      update(next) { st.cfg = Object.assign({}, st.cfg, next); draw(); },
      toggle(key, solo) {
        const keys = st.cfg.series.map(s => s.key);
        if (solo) {
          const alone = keys.every(k => (k === key ? !st.hidden[k] : st.hidden[k]));
          keys.forEach(k => { if (alone || k === key) delete st.hidden[k]; else st.hidden[k] = true; });
        } else {
          if (st.hidden[key]) delete st.hidden[key]; else st.hidden[key] = true;
          if (keys.every(k => st.hidden[k])) keys.forEach(k => delete st.hidden[k]);
        }
        draw();
      },
      sync(t) {
        if (st.pinned || st.drag) return;
        const c = st.cfg;
        let i = -1;
        if (t != null) { i = Math.floor((t - c.x[0]) / c.step); if (i < 0 || i >= c.x.length) i = -1; }
        st.cur = i; st.tip = false;
        paintCursor();
        if (c.onHover) c.onHover(i);
      },
      unpin() { if (st.pinned) { setPinned(false); clearCur(true); } },
      destroy() {
        ro.disconnect();
        charts.delete(api);
        if (cfg.group && groups[cfg.group]) groups[cfg.group].delete(api);
      }
    };
    const ro = new ResizeObserver(() => draw());
    ro.observe(host);
    if (cfg.group) (groups[cfg.group] = groups[cfg.group] || new Set()).add(api);
    charts.add(api);
    draw();
    return api;
  }

  // 圖例：點一下隱藏或顯示，Alt＋點一下只看那一條
  function legend(el, chart, onChange) {
    el.textContent = '';
    const ser = chart.cfg.series;
    if (ser.length < 2) { el.hidden = true; return; }
    el.hidden = false;
    for (const s of ser) {
      const off = !!chart.hidden[s.key];
      const b = H('button', 'lg' + (off ? ' is-off' : ''));
      b.type = 'button';
      b.setAttribute('aria-pressed', off ? 'false' : 'true');
      b.title = '點一下隱藏或顯示；按住 Alt 再點，只看這一條';
      const k = H('i', 'lg-k' + (s.style === 'dash' ? ' is-dash' : s.style === 'bar' ? ' is-bar' : ''));
      k.style.setProperty('--c', s.color);
      b.appendChild(k);
      b.appendChild(H('span', null, s.name));
      b.addEventListener('click', e => { chart.toggle(s.key, e.altKey); legend(el, chart, onChange); if (onChange) onChange(); });
      el.appendChild(b);
    }
  }

  // 每張圖都有的表格檢視
  function dataTable(cfg, hidden) {
    const ser = cfg.series.filter(s => !(hidden && hidden[s.key]));
    const wrap = H('div', 'tbl-wrap tc-tablewrap'), tb = H('table', 'tbl'), head = H('thead'), tr = H('tr');
    tr.appendChild(H('th', null, '時間'));
    for (const s of ser) tr.appendChild(H('th', 'num', s.name));
    head.appendChild(tr); tb.appendChild(head);
    const body = H('tbody');
    for (let i = cfg.x.length - 1; i >= 0; i--) {
      const r = H('tr');
      r.appendChild(H('td', 'mono', fBucket(cfg.x[i], cfg.step)));
      for (const s of ser) r.appendChild(H('td', 'num', s.values[i] == null ? '—' : cfg.fmt(s.values[i])));
      body.appendChild(r);
    }
    tb.appendChild(body); wrap.appendChild(tb);
    return wrap;
  }
  function csv(cfg) {
    const rows = [['時間（台北）'].concat(cfg.series.map(s => s.name)).join(',')];
    for (let i = 0; i < cfg.x.length; i++) {
      rows.push([fIso(cfg.x[i])].concat(cfg.series.map(s => (s.values[i] == null ? '' : Math.round(s.values[i] * 100) / 100))).join(','));
    }
    return rows.join('\n');
  }

  // 表格列用的小走勢圖（固定像素大小）
  function spark(vals, o) {
    o = o || {};
    const w = o.w || 92, h = o.h || 24, p = 3.5;
    const v1 = downsample(vals, 48), v2 = o.cmp ? downsample(o.cmp, 48) : null;
    let lo = Infinity, hi = -Infinity;
    for (const v of (v2 ? v1.concat(v2) : v1)) if (v != null) { if (v < lo) lo = v; if (v > hi) hi = v; }
    if (!isFinite(lo)) return '<span class="muted">—</span>';
    if (hi === lo) { hi = lo + 1; lo = lo - 1; }
    const px = (i, n) => p + (n <= 1 ? 0 : i / (n - 1)) * (w - 2 * p), py = v => p + (h - 2 * p) * (1 - (v - lo) / (hi - lo));
    const path = arr => {
      let d = '', pen = false;
      for (let i = 0; i < arr.length; i++) {
        if (arr[i] == null) { pen = false; continue; }
        d += (pen ? 'L' : 'M') + px(i, arr.length).toFixed(1) + ' ' + py(arr[i]).toFixed(1);
        pen = true;
      }
      return d;
    };
    let j = v1.length - 1;
    while (j >= 0 && v1[j] == null) j--;
    return '<svg class="spark" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '" aria-hidden="true">' +
      (v2 ? '<path class="spark-c" d="' + path(v2) + '"/>' : '') + '<path class="spark-l" d="' + path(v1) + '"/>' +
      '<circle class="spark-d" cx="' + px(j, v1.length).toFixed(1) + '" cy="' + py(v1[j]).toFixed(1) + '" r="3"/></svg>';
  }

  global.Viz = {
    S: S, H: H, fmt: fmt, F: F, fmtInt: fmtInt, axisFmt: axisFmt, textW: textW, downsample: downsample,
    fTime: fTime, fClock: fClock, fDate: fDate, fDateDow: fDateDow, fStamp: fStamp, fBucket: fBucket, fAgo: fAgo, fDur: fDur, fIso: fIso,
    timeChart: timeChart, legend: legend, dataTable: dataTable, csv: csv, spark: spark,
    tipShow: tipShow, tipAt: tipAt, tipHide: tipHide, tipLines: tipLines,
    unpinAll() { charts.forEach(c => c.unpin()); },
    destroyAll() { Array.from(charts).forEach(c => c.destroy()); tipHide(); }
  };
})(window);
