/* global window, localStorage */
/* 拾光AI雲端相簿的用戶明細（Hank 2026-11-13「每個用戶的辨識的詳細數據 從上傳到本地／排隊中／辨識併入相簿／辨識排除相簿／辨識失敗」
   「每個帳戶的相簿照片影片總數量／上傳or下載使用了多少流量」「要用成智慧互動UX」）。
   資料是收集工具從拾光伺服器的 /api/internal/admin-stats 匯入的事實（一位用戶一個 thUser…，加一個 thUsersMeta）。
   階段與原因是伺服器用 LINE 收件頁同一套判定算出來的；這裡只把它們分組、排序、找出需要注意的地方。 */
(function () {
  'use strict';
  const DAY = 86400000, HOUR = 3600000;
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const nf = new Intl.NumberFormat('zh-TW');
  const int = v => (v == null ? '—' : nf.format(v));
  const pct = (a, b) => (b ? Math.round(a / b * 100) : 0);
  const bytes = v => {
    if (v == null) return '—';
    if (v < 1024) return nf.format(v) + ' B';
    const u = ['KB', 'MB', 'GB', 'TB']; let x = v / 1024, i = 0;
    while (x >= 1024 && i < u.length - 1) { x /= 1024; i += 1; }
    return (x >= 100 ? Math.round(x) : x >= 10 ? x.toFixed(1) : x.toFixed(2)) + ' ' + u[i];
  };
  const ago = t => {
    if (!t) return '—';
    const d = Date.now() - t;
    if (d < HOUR) return Math.max(1, Math.round(d / 60000)) + ' 分鐘前';
    if (d < DAY) return Math.round(d / HOUR) + ' 小時前';
    if (d < 60 * DAY) return Math.round(d / DAY) + ' 天前';
    return Math.round(d / (30 * DAY)) + ' 個月前';
  };
  const dayLabel = d => d.slice(5).replace('-', '/');
  const store = {
    get(k, d) { try { const v = localStorage.getItem('hub.th.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('hub.th.' + k, JSON.stringify(v)); } catch (e) { /* 存不了就不存 */ } }
  };

  // 階段：伺服器的固定詞彙 → 畫面上的名字與分組
  const STAGE = {
    download_queued: ['等待從 LINE 下載', 'recv'], downloading: ['從 LINE 下載中', 'recv'], downloaded: ['已收到本地', 'recv'],
    recognition_queued: ['排隊辨識', 'queue'], recognizing: ['辨識中', 'queue'], recognized: ['已辨識，待匯入', 'queue'],
    uploading: ['匯入相簿中', 'importing'], uploaded: ['辨識併入相簿', 'merged'], excluded: ['辨識排除相簿', 'excluded'],
    blocked: ['卡住，需要處理', 'blocked'], failed: ['失敗', 'failed'], unknown: ['狀態不明', 'other'], stopped: ['已停止', 'other']
  };
  const GROUPS = [
    ['recv', '收到本地', 'var(--s1)'], ['queue', '排隊／辨識中', 'var(--s4)'], ['importing', '匯入中', 'var(--s7)'], ['merged', '併入相簿', 'var(--s3)'],
    ['excluded', '排除', 'var(--deemph)'], ['blocked', '卡住', 'var(--serious)'], ['failed', '失敗', 'var(--crit)'], ['other', '其他', 'var(--line-2)']
  ];
  const GROUP = Object.fromEntries(GROUPS.map(g => [g[0], g]));
  const WAITING = ['recv', 'queue', 'importing'];
  const REASON = {
    ITEM_AWAITING_DOWNLOAD: '等待從 LINE 下載', RECEIVER_LEASED: '正在從 LINE 下載', ITEM_DOWNLOAD_FAILED: '從 LINE 下載失敗', ITEM_STOPPED: '已停止處理',
    IMPORT_PLAN_PENDING: '等待匯入相簿', IMPORT_RECEIVING: '匯入中：接收檔案', IMPORT_UPLOAD_STAGED: '匯入中：上傳到相簿', IMPORT_FAILED: '匯入相簿失敗',
    IMPORT_CANCELLED: '匯入已取消', IMPORT_OUTCOME_UNKNOWN: '匯入結果不明', UPLOAD_COMPLETED: '已併入相簿', RECEIPT_NOT_COMPLETED: '上傳收據未完成',
    RECEIPT_MISSING: '缺上傳收據', MEMBERSHIP_UNCONFIRMED: '相簿成員未確認', PLAN_MISMATCH: '匯入計畫不一致', RECOGNITION_QUEUED: '排隊等待辨識',
    RECOGNITION_IN_PROGRESS: '辨識中', RECOGNITION_COMPLETE: '辨識完成', RECOGNITION_UNCERTAIN: '辨識不確定，等人確認', IMPORT_DECISION_PENDING: '判定要匯入，等待執行',
    SKIP_DECISION_PERSISTED: '判定不匯入', DECISION_EXPIRED: '判定已過期', DECISION_UNUSABLE: '判定不能用', DECISION_RUN_MISMATCH: '判定與批次不符',
    RUN_NOT_ACTIVE: '辨識批次已停止', RUN_EXPIRED: '辨識批次已過期', RUN_RECORD_MISSING: '缺辨識批次紀錄', ITEM_NOT_ENGAGED: '照片資訊不完整',
    AUTOMATION_NOT_READY: '自動辨識還沒準備好', AUTOMATION_DISABLED: '自動辨識已關閉', RELEVANCE_SOURCE_NOT_READY: '辨識來源還沒準備好',
    TRANSPORT_NOT_READY: '辨識連線還沒準備好', PROVIDER_NOT_CONNECTED: '相簿服務沒有連線', MATCH_NO_PERSON: '照片裡沒有參考對象',
    MATCH_DELETED_BEFORE: '之前刪除過，不再放回', MATCH_NOT_CONFIGURED: '這本相簿沒開人物辨識', UNSUPPORTED_MEDIA: '不支援的檔案類型',
    REFERENCES_NOT_READY: '參考照片還沒設定好', COLLECTION_NOT_CONFIGURED: '收件相簿沒設定', STATUS_UNAVAILABLE: '狀態讀不到'
  };
  const reasonText = code => REASON[code] || code;

  // ---- 資料整理 ----------------------------------------------------------------
  function groupsOf(u) {
    const g = Object.fromEntries(GROUPS.map(x => [x[0], 0])), s = (u.line && u.line.stages) || {};
    Object.keys(s).forEach(k => { g[(STAGE[k] || ['', 'other'])[1]] += s[k]; });
    return g;
  }
  function enrich(u) {
    const g = groupsOf(u), received = (u.line && u.line.received) || 0;
    const waiting = WAITING.reduce((a, k) => a + g[k], 0), problems = g.failed + g.blocked;
    const oldest = u.line && u.line.oldestWaitingAt, waitAge = oldest ? Date.now() - oldest : 0;
    const traffic30 = u.traffic && u.traffic.days ? u.traffic.days.reduce((a, d) => a + d[2], 0) : null;
    const uploaded = (u.history && (u.history.appUploadBytes || 0) + (u.history.lineReceivedBytes || 0)) || 0;
    const attention = problems > 0 || waitAge > 6 * HOUR || (u.ai && u.ai.failed > 0) || (u.uploads && u.uploads.failed > 0);
    return Object.assign({}, u, { g, received, waiting, problems, waitAge, traffic30, uploadedBytes: uploaded, attention });
  }
  function insights(users, meta) {
    const out = [], all = users.reduce((a, u) => { GROUPS.forEach(g => { a[g[0]] += u.g[g[0]]; }); a.n += u.received; return a; }, Object.assign({ n: 0 }, Object.fromEntries(GROUPS.map(g => [g[0], 0]))));
    if (all.n) {
      const waiting = WAITING.reduce((a, k) => a + all[k], 0);
      out.push({ sev: all.failed + all.blocked ? 'warn' : 'ok', text: `LINE 共收到 ${int(all.n)} 張：併入相簿 ${int(all.merged)}（${pct(all.merged, all.n)}%）、排除 ${int(all.excluded)}、處理中 ${int(waiting)}、失敗或卡住 ${int(all.failed + all.blocked)}。`, filter: 'line' });
    } else out.push({ sev: 'info', text: '目前還沒有任何用戶透過 LINE 傳照片進來。' });
    users.filter(u => u.waitAge > 6 * HOUR).sort((a, b) => b.waitAge - a.waitAge).slice(0, 3).forEach(u => {
      out.push({ sev: u.waitAge > DAY ? 'crit' : 'warn', user: u.ref, text: `${u.name} 有 ${int(u.waiting)} 張 LINE 照片還在處理，最久的已等了 ${ago(u.line.oldestWaitingAt).replace('前', '')}。` });
    });
    users.filter(u => u.g.failed).forEach(u => {
      const top = Object.entries(u.line.reasons || {}).filter(([k]) => /FAILED|UNKNOWN|MISSING|MISMATCH/.test(k)).sort((a, b) => b[1] - a[1])[0];
      out.push({ sev: 'crit', user: u.ref, text: `${u.name} 有 ${int(u.g.failed)} 張處理失敗${top ? '，主要是「' + reasonText(top[0]) + '」' : ''}。` });
    });
    users.filter(u => u.g.blocked).forEach(u => {
      const r = u.line.reasons || {};
      const hint = r.MATCH_NOT_CONFIGURED ? '：照片所在的相簿沒開人物辨識，請在 LINE 收件設定打開' : r.RECOGNITION_UNCERTAIN ? '：辨識不確定，等人確認' : '';
      out.push({ sev: 'warn', user: u.ref, text: `${u.name} 有 ${int(u.g.blocked)} 張卡住${hint}。` });
    });
    users.filter(u => u.received >= 10 && pct(u.g.excluded, u.received) >= 60).forEach(u => {
      out.push({ sev: 'info', user: u.ref, text: `${u.name} 有 ${pct(u.g.excluded, u.received)}% 的 LINE 照片被判定不是參考對象，可以看看參考照片是否需要更新。` });
    });
    users.filter(u => u.ai && u.ai.failed).forEach(u => out.push({ sev: 'warn', user: u.ref, text: `${u.name} 的拾光分析有 ${int(u.ai.failed)} 張失敗。` }));
    users.filter(u => u.uploads && u.uploads.failed).forEach(u => out.push({ sev: 'warn', user: u.ref, text: `${u.name} 從 App／網頁上傳有 ${int(u.uploads.failed)} 個檔案失敗。` }));
    const traffic = users.filter(u => u.traffic30 != null), totalOut = traffic.reduce((a, u) => a + u.traffic30, 0);
    if (traffic.length && totalOut > 0) {
      const top = traffic.slice().sort((a, b) => b.traffic30 - a.traffic30)[0];
      out.push({ sev: 'info', user: top.ref, text: `近 30 天下載流量 ${bytes(totalOut)}，最多的是 ${top.name}（${bytes(top.traffic30)}，占 ${pct(top.traffic30, totalOut)}%）。` });
    }
    if (meta && meta.trafficSince && Date.now() - Date.parse(meta.trafficSince) < 30 * DAY) out.push({ sev: 'info', text: `流量從 ${meta.trafficSince.slice(0, 10)} 開始記錄，之前的下載量沒有資料；上傳量另外從已存的照片推算。` });
    users.filter(u => !u.owner && u.lastLoginAt && Date.now() - u.lastLoginAt > 30 * DAY).forEach(u => out.push({ sev: 'info', user: u.ref, text: `${u.name} 已經 ${ago(u.lastLoginAt).replace('前', '')}沒有登入。` }));
    if (meta && meta.dropped) out.push({ sev: 'warn', text: `這次略過了 ${meta.dropped} 位最不活躍用戶的明細（資料量上限）。` });
    const order = { crit: 0, warn: 1, info: 2, ok: 3 };
    return out.sort((a, b) => order[a.sev] - order[b.sev]);
  }

  // ---- 小圖 --------------------------------------------------------------------
  function stackBar(g, total, cls) {
    if (!total) return '<span class="th-bar is-empty' + (cls ? ' ' + cls : '') + '"></span>';
    const tip = GROUPS.filter(x => g[x[0]]).map(x => x[1] + ' ' + int(g[x[0]]) + '（' + pct(g[x[0]], total) + '%）').join('\n');
    return '<span class="th-bar' + (cls ? ' ' + cls : '') + '" tabindex="0" data-tip="' + esc(tip) + '">' + GROUPS.filter(x => g[x[0]]).map(x => '<i style="flex:' + g[x[0]] + ';background:' + x[2] + '"></i>').join('') + '</span>';
  }
  function spark(days, idx) {
    if (!days || !days.length) return '<span class="muted">—</span>';
    const map = Object.fromEntries(days.map(d => [d[0], d])), end = Date.now(), vals = [];
    for (let i = 29; i >= 0; i--) { const d = new Date(end - i * DAY + 8 * HOUR).toISOString().slice(0, 10); vals.push(map[d] ? map[d][idx] : 0); }
    const max = Math.max(1, ...vals), w = 90, h = 22, step = w / vals.length;
    return '<svg class="th-spark" viewBox="0 0 ' + w + ' ' + h + '" width="' + w + '" height="' + h + '" aria-hidden="true">' + vals.map((v, i) => v ? '<rect x="' + (i * step + .5).toFixed(1) + '" y="' + (h - Math.max(2, v / max * h)).toFixed(1) + '" width="' + Math.max(1, step - 1).toFixed(1) + '" height="' + Math.max(2, v / max * h).toFixed(1) + '"/>' : '').join('') + '</svg>';
  }
  function dailyChart(days, series, fmt) {
    // series: [[index in the day array, label, color]]
    const end = Date.now(), cols = [];
    const map = Object.fromEntries((days || []).map(d => [d[0], d]));
    for (let i = 29; i >= 0; i--) { const d = new Date(end - i * DAY + 8 * HOUR).toISOString().slice(0, 10); cols.push([d, map[d] || null]); }
    const total = r => (r ? series.reduce((a, s) => a + (r[s[0]] || 0), 0) : 0), max = Math.max(1, ...cols.map(c => total(c[1])));
    if (!cols.some(c => total(c[1]) > 0)) return '<p class="empty">近 30 天沒有資料。</p>';
    const w = 600, h = 120, bw = w / cols.length;
    const bars = cols.map(([d, r], i) => {
      let y = h; const tip = [d.replace(/-/g, '/')].concat(series.map(s => s[1] + ' ' + fmt(r ? r[s[0]] || 0 : 0)));
      const rects = series.map(s => { const v = r ? r[s[0]] || 0 : 0; if (!v) return ''; const hh = Math.max(1.5, v / max * (h - 4)); y -= hh; return '<rect x="' + (i * bw + 1).toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + Math.max(1, bw - 2).toFixed(1) + '" height="' + hh.toFixed(1) + '" style="fill:' + s[2] + '"/>'; }).join('');
      return '<g class="th-col" tabindex="0" data-tip="' + esc(tip.join('\n')) + '"><rect class="th-hit" x="' + (i * bw).toFixed(1) + '" y="0" width="' + bw.toFixed(1) + '" height="' + h + '"/>' + rects + '</g>';
    }).join('');
    return '<div class="th-chart"><svg viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none" role="img" aria-label="近 30 天每日">' + bars + '</svg>' +
      '<div class="th-axis"><span>' + dayLabel(cols[0][0]) + '</span><span>' + dayLabel(cols[15][0]) + '</span><span>今天</span></div>' +
      '<div class="legend">' + series.map(s => '<span class="lg"><i class="lg-k is-bar" style="--c:' + s[2] + '"></i>' + esc(s[1]) + '</span>').join('') + '</div></div>';
  }

  // ---- 畫面 --------------------------------------------------------------------
  const COLS = [
    ['name', '用戶', false], ['albums', '相簿', true], ['photos', '照片', true], ['videos', '影片', true], ['received', 'LINE 收到', true], ['flow', '辨識流程', false],
    ['merged', '併入', true], ['excluded', '排除', true], ['waiting', '處理中', true], ['problems', '失敗／卡住', true], ['up', '上傳量', true], ['down', '下載量 30 天', true], ['trend', '近 30 天 LINE', false]
  ];
  const SORT = {
    name: u => u.name, albums: u => u.media.albums || 0, photos: u => u.media.photos == null ? -1 : u.media.photos, videos: u => u.media.videos == null ? -1 : u.media.videos,
    received: u => u.received, merged: u => u.g.merged, excluded: u => u.g.excluded, waiting: u => u.waiting, problems: u => u.problems, up: u => u.uploadedBytes, down: u => u.traffic30 == null ? -1 : u.traffic30,
    attention: u => (u.problems ? 1e9 : 0) + u.waitAge / 1000 + (u.attention ? 1e6 : 0)
  };
  const FILTERS = [['all', '全部'], ['attention', '需要注意'], ['line', '有 LINE 收件'], ['traffic', '有流量']];
  const keep = (u, f) => f === 'attention' ? u.attention : f === 'line' ? u.received > 0 : f === 'traffic' ? (u.traffic30 || 0) > 0 : true;

  function mount(el, detail) {
    if (!el) return;
    if (!detail || !detail.users.length) {
      el.innerHTML = '<section class="card">' + head('用戶明細', '每位用戶的辨識、相簿與流量') + '<p class="empty">' + (detail && detail.meta && detail.meta.notes && detail.meta.notes.length ? esc(detail.meta.notes.join('；')) : '還沒有用戶明細：拾光伺服器 1.0.118 起提供，收集工具下一次匯入後就會出現。') + '</p></section>';
      return;
    }
    const meta = detail.meta || {}, users = detail.users.map(enrich);
    const S = { q: '', filter: store.get('filter', 'all'), sort: store.get('sort', { k: 'attention', dir: -1 }), open: store.get('open', null), group: null };
    if (!FILTERS.some(f => f[0] === S.filter)) S.filter = 'all';
    const tiles = () => {
      const sum = k => users.reduce((a, u) => a + (u[k] || 0), 0), n = sum('received'), merged = users.reduce((a, u) => a + u.g.merged, 0);
      const photos = users.every(u => u.media.photos != null) ? users.reduce((a, u) => a + u.media.photos, 0) : null;
      const videos = users.every(u => u.media.videos != null) ? users.reduce((a, u) => a + u.media.videos, 0) : null;
      const out30 = users.some(u => u.traffic30 != null) ? users.reduce((a, u) => a + (u.traffic30 || 0), 0) : null;
      const t = (label, value, tip, cls) => '<div class="dm-c' + (cls ? ' ' + cls : '') + '"' + (tip ? ' data-tip="' + esc(tip) + '"' : '') + '><span>' + esc(label) + '</span><b>' + esc(value) + '</b></div>';
      return '<div class="dm">' + t('用戶', int(users.length) + ' 位', meta.users > users.length ? '另有 ' + (meta.users - users.length) + ' 位沒有明細' : '') + t('照片／影片', (photos == null ? '—' : int(photos)) + '／' + (videos == null ? '—' : int(videos)), photos == null ? '有家庭相簿的數量讀不到（Flickr）' : '家庭相簿用 Flickr 的數量；同一張在多本家庭相簿會各算一次') +
        t('LINE 收到', int(n) + ' 張') + t('併入率', n ? pct(merged, n) + '%' : '—', '併入相簿 ÷ LINE 收到') + t('處理中', int(sum('waiting')) + ' 張', '', sum('waiting') ? '' : '') +
        t('失敗／卡住', int(sum('problems')) + ' 張', '', sum('problems') ? 'is-bad' : '') + t('下載量 30 天', bytes(out30), meta.trafficSince ? '從 ' + meta.trafficSince.slice(0, 10) + ' 開始記錄' : '') + '</div>';
    };
    const overallBar = () => {
      const g = Object.fromEntries(GROUPS.map(x => [x[0], users.reduce((a, u) => a + u.g[x[0]], 0)])), n = users.reduce((a, u) => a + u.received, 0);
      if (!n) return '';
      return '<div class="th-flow"><div class="th-flow-h"><b>所有 LINE 照片目前在哪一步</b><span class="muted">點一段只看那一步有照片的用戶</span></div>' + stackBar(g, n, 'lg') +
        '<div class="th-legend">' + GROUPS.filter(x => g[x[0]]).map(x => '<button type="button" class="th-lg' + (S.group === x[0] ? ' is-on' : '') + '" data-th="group" data-v="' + x[0] + '" aria-pressed="' + (S.group === x[0]) + '"><i style="background:' + x[2] + '"></i>' + esc(x[1]) + ' <b>' + int(g[x[0]]) + '</b></button>').join('') + '</div></div>';
    };
    const insightHtml = () => '<ul class="th-ins">' + insights(users, meta).map(x => '<li class="th-in th-' + x.sev + '">' + '<i class="sd sd-' + (x.sev === 'ok' ? 'ok' : x.sev === 'info' ? 'live' : x.sev) + '"></i>' +
      (x.user || x.filter ? '<button type="button" class="th-in-b" data-th="' + (x.user ? 'focus' : 'filter') + '" data-v="' + esc(x.user || x.filter) + '">' + esc(x.text) + '</button>' : '<span>' + esc(x.text) + '</span>') + '</li>').join('') + '</ul>';
    const rows = () => {
      const q = S.q.trim().toLowerCase(), key = SORT[S.sort.k] || SORT.attention;
      let list = users.filter(u => keep(u, S.filter) && (!S.group || u.g[S.group] > 0) && (!q || (u.name + ' ' + u.login).toLowerCase().indexOf(q) >= 0));
      list = list.slice().sort((a, b) => { const x = key(a), y = key(b); return (x < y ? -1 : x > y ? 1 : 0) * S.sort.dir || a.name.localeCompare(b.name); });
      if (!list.length) return '<tr><td colspan="' + COLS.length + '" class="empty">沒有符合條件的用戶。</td></tr>';
      return list.map(u => {
        const open = S.open === u.ref;
        const cell = (v, bad) => '<td class="num' + (bad ? ' is-bad' : '') + '">' + v + '</td>';
        return '<tr class="is-click' + (open ? ' is-sel' : '') + '" tabindex="0" data-th="open" data-v="' + u.ref + '" aria-expanded="' + open + '">' +
          '<td><div class="th-who"><b>' + esc(u.name) + '</b>' + (u.owner ? '<span class="th-tag">擁有者</span>' : '') + (u.attention ? '<i class="sd sd-warn" data-tip="需要注意"></i>' : '') + '<span class="muted">' + esc(u.login) + '・' + (u.lastLoginAt ? '最近登入 ' + ago(u.lastLoginAt) : '沒有登入紀錄') + '</span></div></td>' +
          cell(int(u.media.albums)) + cell(int(u.media.photos)) + cell(int(u.media.videos)) + cell(int(u.received)) + '<td>' + stackBar(u.g, u.received) + '</td>' +
          cell(int(u.g.merged)) + cell(int(u.g.excluded)) + cell(int(u.waiting) + (u.waitAge > 6 * HOUR ? '<small class="th-age"> 最久 ' + ago(u.line.oldestWaitingAt).replace('前', '') + '</small>' : ''), u.waitAge > DAY) +
          cell(int(u.problems), u.problems > 0) + cell(bytes(u.uploadedBytes)) + cell(u.traffic30 == null ? '<span class="muted" data-tip="這位用戶還沒有流量紀錄">—</span>' : bytes(u.traffic30)) +
          '<td>' + spark(u.line && u.line.days, 1) + '</td></tr>';
      }).join('');
    };
    const table = () => '<div class="tbl-wrap"><table class="tbl th-tbl"><thead><tr>' + COLS.map(c => {
      const sortable = !!SORT[c[0]], on = S.sort.k === c[0];
      return '<th' + (c[2] ? ' class="num"' : '') + (on ? ' aria-sort="' + (S.sort.dir > 0 ? 'ascending' : 'descending') + '"' : '') + '>' + (sortable ? '<button type="button" class="th-sort" data-th="sort" data-v="' + c[0] + '">' + esc(c[1]) + (on ? (S.sort.dir > 0 ? ' ▲' : ' ▼') : '') + '</button>' : esc(c[1])) + '</th>';
    }).join('') + '</tr></thead><tbody>' + rows() + '</tbody></table></div>';
    const tools = () => '<div class="th-tools"><input type="search" class="field th-q" placeholder="找用戶（暱稱或帳號）" aria-label="找用戶" value="' + esc(S.q) + '" data-th-in="q">' +
      '<div class="seg" role="group" aria-label="篩選">' + FILTERS.map(f => '<button type="button" data-th="filter" data-v="' + f[0] + '" aria-pressed="' + (S.filter === f[0]) + '">' + esc(f[1]) + ' ' + users.filter(u => keep(u, f[0])).length + '</button>').join('') + '</div>' +
      (S.group ? '<span class="chip">只看「' + esc(GROUP[S.group][1]) + '」<button type="button" data-th="group" data-v="' + S.group + '" aria-label="取消">×</button></span>' : '') + '</div>';
    // 詳細面板放在表格下面（不放進表格列，免得跟著很寬的表格被裁掉）
    const panel = () => {
      const u = users.find(x => x.ref === S.open);
      if (!u) return '';
      return '<section class="th-panel" id="th-panel" aria-label="' + esc(u.name) + ' 的詳細"><header class="th-panel-h"><div><h3>' + esc(u.name) + (u.owner ? '<span class="th-tag">擁有者</span>' : '') + '</h3><p class="muted">' + esc(u.login) + '・' +
        (u.createdAt ? '註冊於 ' + new Date(u.createdAt).toLocaleDateString('zh-TW') : '註冊時間不明') + '・' + (u.lastLoginAt ? '最近登入 ' + ago(u.lastLoginAt) : '沒有登入紀錄') + '</p></div>' +
        '<button type="button" class="btn-ghost" data-th="open" data-v="' + u.ref + '" aria-label="關閉詳細">關閉</button></header>' + drill(u, meta) + '</section>';
    };
    const stamp = () => '<p class="hint">' + '資料時間 ' + esc(meta.asOf ? new Date(meta.asOf).toLocaleString('zh-TW', { hour12: false }) : '—') + (meta.version ? '・伺服器 ' + esc(meta.version) : '') +
      (meta.notes && meta.notes.length ? '・' + esc(meta.notes.join('；')) : '') + '。階段用 LINE 收件頁同一套判定；家庭相簿的照片數來自 Flickr。</p>';
    function paint(focusSel) {
      el.innerHTML = '<section class="card th-card">' + head('用戶明細', '每位用戶的辨識、相簿與流量・點一列看詳細') + tiles() + '<div class="th-top"><div class="th-top-l">' + overallBar() + '</div><div class="th-top-r"><b class="th-ins-h">智慧洞察</b>' + insightHtml() + '</div></div>' +
        tools() + table() + panel() + stamp() + '</section>';
      if (focusSel) { const f = el.querySelector(focusSel); if (f) { f.focus({ preventScroll: true }); if (f.setSelectionRange && typeof f.value === 'string') f.setSelectionRange(f.value.length, f.value.length); } }
    }
    function act(name, v) {
      if (name === 'open') {
        S.open = S.open === v ? null : v; store.set('open', S.open); paint('tr[data-th="open"][data-v="' + v + '"]');
        const p = el.querySelector('#th-panel'); if (p && p.scrollIntoView) p.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        return;
      }
      if (name === 'sort') { S.sort = S.sort.k === v ? { k: v, dir: -S.sort.dir } : { k: v, dir: v === 'name' ? 1 : -1 }; store.set('sort', S.sort); paint('[data-th="sort"][data-v="' + v + '"]'); return; }
      if (name === 'filter') { S.filter = v; store.set('filter', v); paint('[data-th="filter"][data-v="' + v + '"]'); return; }
      if (name === 'group') { S.group = S.group === v ? null : v; paint(); return; }
      if (name === 'focus') {
        S.open = v; S.filter = 'all'; S.group = null; S.q = ''; store.set('open', v); store.set('filter', 'all'); paint('tr[data-th="open"][data-v="' + v + '"]');
        const p = el.querySelector('#th-panel'); if (p && p.scrollIntoView) p.scrollIntoView({ block: 'start', behavior: 'smooth' });
      }
    }
    el.onclick = e => { const t = e.target.closest('[data-th]'); if (t && el.contains(t)) { e.preventDefault(); act(t.dataset.th, t.dataset.v); } };
    el.onkeydown = e => { const t = e.target.closest('tr[data-th="open"]'); if (t && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); act('open', t.dataset.v); } };
    el.oninput = e => { if (e.target.dataset.thIn === 'q') { S.q = e.target.value; paint('[data-th-in="q"]'); } };
    paint();
  }
  function head(title, sub) { return '<header class="card-h"><div class="card-t"><h2>' + esc(title) + '</h2><p class="sub">' + esc(sub) + '</p></div></header>'; }

  // ---- 單一用戶的詳細 ------------------------------------------------------------
  function drill(u, meta) {
    const l = u.line, n = u.received, recognized = l ? l.recognized || 0 : 0;
    const funnel = n ? [['LINE 收到', n, 'var(--s1)'], ['完成辨識', recognized, 'var(--s4)'], ['併入相簿', u.g.merged, 'var(--s3)'], ['排除', u.g.excluded, 'var(--deemph)']] : [];
    const funnelHtml = funnel.length ? '<div class="th-fn">' + funnel.map(f => '<div class="th-fn-r"><span>' + esc(f[0]) + '</span><span class="th-fn-b"><i style="width:' + Math.max(2, pct(f[1], n)) + '%;background:' + f[2] + '"></i></span><b>' + int(f[1]) + '</b><em>' + pct(f[1], n) + '%</em></div>').join('') + '</div>' : '<p class="empty">這位用戶還沒有透過 LINE 傳照片。</p>';
    const stages = l ? Object.keys(STAGE).filter(k => l.stages[k]).map(k => '<tr><td><i class="th-dot" style="background:' + GROUP[STAGE[k][1]][2] + '"></i>' + esc(STAGE[k][0]) + '</td><td class="num">' + int(l.stages[k]) + '</td><td class="num muted">' + pct(l.stages[k], n) + '%</td></tr>').join('') : '';
    const reasons = l ? Object.entries(l.reasons || {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => '<tr><td>' + esc(reasonText(k)) + '</td><td class="num">' + int(v) + '</td></tr>').join('') : '';
    const t = u.traffic;
    const trafficHtml = t ? '<div class="dm th-dm">' + cellK('下載（伺服器→用戶）', bytes(t.outBytes)) + cellK('其中照片／影片', bytes(t.mediaOutBytes)) + cellK('上傳（用戶→伺服器）', bytes(t.inBytes)) + cellK('其中大型上傳', bytes(t.uploadInBytes)) + cellK('請求次數', int(t.requests)) + '</div>' +
      // 每日資料是 [日, 上傳, 下載, 其中照片／影片下載]：先換成不重疊的三段再堆疊
      dailyChart((t.days || []).map(d => [d[0], d[3], Math.max(0, d[2] - d[3]), d[1]]), [[1, '照片／影片下載', 'var(--s1)'], [2, '其他下載', 'var(--ord5)'], [3, '上傳', 'var(--s2)']], bytes) +
      '<p class="hint">從 ' + esc((t.since || meta.trafficSince || '').slice(0, 10) || '—') + ' 開始記錄。</p>' : '<p class="empty">這位用戶還沒有流量紀錄（伺服器 1.0.118 起才開始記）。</p>';
    const albums = (u.albums || []).map(a => '<tr' + (a[4] ? ' class="is-dim"' : '') + '><td>' + esc(a[0]) + '</td><td>' + (a[1] === 'f' ? '家庭相簿' : '帳戶相簿') + (a[4] ? '・已封存' : '') + '</td><td class="num">' + int(a[2]) + '</td><td class="num">' + int(a[3]) + '</td></tr>').join('');
    const up = u.uploads, ai = u.ai;
    return '<div class="th-drill">' +
      '<div class="th-d th-d-fn"><h3>辨識漏斗</h3>' + funnelHtml + (l && l.lastReceivedAt ? '<p class="hint">最後一張 LINE 照片 ' + ago(l.lastReceivedAt) + '・影片 ' + int(l.videos) + ' 部・共 ' + bytes(l.bytes) + '</p>' : '') + '</div>' +
      '<div class="th-d"><h3>每一步的數量</h3>' + (stages ? '<table class="tbl th-mini"><tbody>' + stages + '</tbody></table>' : '<p class="empty">—</p>') + '</div>' +
      '<div class="th-d"><h3>原因</h3>' + (reasons ? '<table class="tbl th-mini"><tbody>' + reasons + '</tbody></table>' : '<p class="empty">—</p>') + '</div>' +
      '<div class="th-d th-wide"><h3>近 30 天 LINE 照片</h3>' + dailyChart(l && l.days, [[2, '併入相簿', 'var(--s3)'], [3, '排除', 'var(--deemph)'], [4, '失敗', 'var(--crit)'], [5, '處理中', 'var(--s4)']], int) + '</div>' +
      '<div class="th-d th-wide"><h3>流量</h3>' + trafficHtml + '</div>' +
      '<div class="th-d th-wide"><h3>相簿（' + int(u.media.albums) + ' 本' + (u.media.archived ? '，另有 ' + int(u.media.archived) + ' 本封存' : '') + '）</h3>' + (albums ? '<div class="tbl-wrap"><table class="tbl th-mini"><thead><tr><th>相簿</th><th>類型</th><th class="num">照片</th><th class="num">影片</th></tr></thead><tbody>' + albums + '</tbody></table></div>' : '<p class="empty">沒有相簿。</p>') +
        '<p class="hint">存在伺服器的帳戶照片 ' + bytes(u.media.storedBytes) + (u.media.deleted ? '・已刪除 ' + int(u.media.deleted) + ' 張' : '') + '；歷史上傳量 ' + bytes(u.uploadedBytes) + '（App／網頁 ' + bytes(u.history.appUploadBytes) + '、LINE ' + bytes(u.history.lineReceivedBytes) + '）。</p></div>' +
      '<div class="th-d"><h3>App／網頁上傳</h3>' + (up ? '<div class="dm th-dm">' + cellK('完成', int(up.completed)) + cellK('處理中', int(up.waiting)) + cellK('失敗', int(up.failed), up.failed) + cellK('取消', int(up.cancelled)) + '</div><p class="hint">佇列裡目前 ' + int(up.total) + ' 筆・' + bytes(up.bytes) + '</p>' : '<p class="empty">—</p>') + '</div>' +
      '<div class="th-d"><h3>拾光分析</h3>' + (ai ? '<div class="dm th-dm">' + cellK('已分析', int(ai.analyzed)) + cellK('排隊中', int(ai.pending)) + cellK('失敗', int(ai.failed), ai.failed) + cellK('待確認', int(ai.unconfirmed)) + '</div><p class="hint">' + (ai.enabled ? '已開啟' : '沒有開啟') + (ai.retrying ? '・重試中 ' + int(ai.retrying) : '') + '</p>' : '<p class="empty">—</p>') + '</div>' +
      '</div>';
  }
  function cellK(label, value, bad) { return '<div class="dm-c' + (bad ? ' is-bad' : '') + '"><span>' + esc(label) + '</span><b>' + esc(value) + '</b></div>'; }

  // 從中樞的事實取出明細
  function fromFacts(facts) {
    const f = facts || {}, users = Object.keys(f).filter(k => /^thUser[a-f0-9]{10}$/.test(k) && f[k] && f[k].v === 1).map(k => Object.assign({ ref: k.slice(6) }, f[k]));
    users.forEach(u => { u.media = u.media || {}; u.history = u.history || {}; u.albums = Array.isArray(u.albums) ? u.albums : []; });
    return { meta: f.thUsersMeta || null, users };
  }
  window.HubTimehut = { mount, fromFacts, insights: (users, meta) => insights(users.map(enrich), meta), enrich, bytes };
})();
