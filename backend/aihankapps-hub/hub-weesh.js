/* global window, localStorage */
/* Weesh（Wishlist.ai）的帳戶智慧數據庫（Hank 2026-11-13「缺少帳戶智慧數據庫，可參考拾光」）。
   資料是收集工具在 Wishlist 自己的容器裡唯讀統計後匯入的事實：一個帳戶一個 wlUser…，加一個 wlUsersMeta。
   每個帳戶只有數量與時間，加上顯示名稱與遮蔽過的登入信箱；這裡把它們分階段、排序、找出需要注意的地方。
   版面沿用拾光用戶明細的樣式（hub.css 的 .th-*）。 */
(function () {
  'use strict';
  const DAY = 86400000, HOUR = 3600000;
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const nf = new Intl.NumberFormat('zh-TW');
  const int = v => (v == null ? '—' : nf.format(v));
  const pct = (a, b) => (b ? Math.round(a / b * 100) : 0);
  const ago = t => {
    if (!t) return '—';
    const d = Date.now() - t;
    if (d < HOUR) return Math.max(1, Math.round(d / 60000)) + ' 分鐘前';
    if (d < DAY) return Math.round(d / HOUR) + ' 小時前';
    if (d < 60 * DAY) return Math.round(d / DAY) + ' 天前';
    return Math.round(d / (30 * DAY)) + ' 個月前';
  };
  const span = t => ago(t).replace('前', '');
  const dayLabel = d => d.slice(5).replace('-', '/');
  const store = {
    get(k, d) { try { const v = localStorage.getItem('hub.ws.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('hub.ws.' + k, JSON.stringify(v)); } catch (e) { /* 存不了就不存 */ } }
  };

  // 階段：一個帳戶走到最遠的那一步（註冊 → 有願望或刊登 → 開始對話 → 約面交 → 完成面交）
  const STAGES = [
    ['idle', '只有註冊', 'var(--line-2)'], ['content', '有願望或刊登', 'var(--s1)'], ['talk', '開始對話', 'var(--s4)'],
    ['meet', '約了面交', 'var(--s7)'], ['done', '完成面交', 'var(--s3)']
  ];
  const STAGE = Object.fromEntries(STAGES.map(s => [s[0], s]));
  const stageOf = u => (u.meet.done > 0 ? 'done' : u.meet.n > 0 ? 'meet' : u.chat.buy + u.chat.sell + u.chat.sent + u.chat.inquiries > 0 ? 'talk' : u.wish.n + u.sell.n > 0 ? 'content' : 'idle');
  const LISTING = [['active', '刊登中', 'var(--s3)'], ['reserved', '已保留', 'var(--s4)'], ['sold', '已售出', 'var(--s1)'], ['expired', '已過期', 'var(--deemph)'], ['removed', '已下架', 'var(--line-2)'], ['draft', '草稿／待確認', 'var(--s7)']];

  // ---- 資料整理 ----------------------------------------------------------------
  function enrich(u) {
    const stage = stageOf(u), act30 = (u.days || []).reduce((a, d) => a + d[1] + d[2] + d[3], 0);
    const unreadAge = u.chat.unread && u.chat.oldestUnreadAt ? Date.now() - u.chat.oldestUnreadAt : 0;
    const seenAt = Math.max(u.lastAt || 0, u.talkAt || 0) || null;
    const attention = unreadAge > DAY || u.wish.aiFailed > 0;
    return Object.assign({}, u, { shown: u.name || '（未命名）', stage, act30, unreadAge, seenAt, attention, talks: u.chat.buy + u.chat.sell, devices: u.dev.ios + u.dev.android + u.dev.other });
  }
  function totalsOf(users, meta) {
    // 有帳戶的明細被略過時用收集工具算好的總數，否則直接從明細加總
    if (meta && meta.dropped && meta.totals) return meta.totals;
    const sum = f => users.reduce((a, u) => a + f(u), 0), count = f => users.filter(f).length;
    return { users: users.length, withWish: count(u => u.wish.n > 0), withListing: count(u => u.sell.n > 0), withChat: count(u => u.chat.sent > 0), withMeetDone: count(u => u.meet.done > 0),
      active30: count(u => u.act30 > 0), wishes: sum(u => u.wish.n), listings: sum(u => u.sell.n), listingsActive: sum(u => u.sell.active), sent: sum(u => u.chat.sent),
      paidUsers: count(u => u.pay.n > 0), paidTwd: sum(u => u.pay.twd), appUsers: count(u => u.devices > 0) };
  }
  function insights(users, meta) {
    const out = [], t = totalsOf(users, meta), n = t.users;
    if (!n) return [{ sev: 'info', text: '目前還沒有任何帳戶。' }];
    out.push({ sev: 'ok', text: `共 ${int(n)} 個帳戶：${int(t.withWish)} 個建立過願望（${pct(t.withWish, n)}%）、${int(t.withListing)} 個刊登過商品（${pct(t.withListing, n)}%）、${int(t.withChat)} 個傳過訊息、${int(t.withMeetDone)} 個完成過面交。` });
    users.filter(u => u.unreadAge > DAY).sort((a, b) => b.unreadAge - a.unreadAge).slice(0, 4).forEach(u => {
      out.push({ sev: u.unreadAge > 3 * DAY ? 'crit' : 'warn', user: u.ref, text: `${u.shown} 有 ${int(u.chat.unread)} 個對話對方已回覆但還沒讀，最久的已經 ${span(u.chat.oldestUnreadAt)}。` });
    });
    users.filter(u => u.wish.aiFailed > 0).forEach(u => out.push({ sev: 'warn', user: u.ref, text: `${u.shown} 有 ${int(u.wish.aiFailed)} 個願望的 AI 整理失敗。` }));
    const idle = users.filter(u => u.stage === 'idle' && u.createdAt && Date.now() - u.createdAt > 7 * DAY);
    if (idle.length) out.push({ sev: 'info', filter: 'idle', text: `有 ${int(idle.length)} 個帳戶註冊超過 7 天，還沒有任何願望、刊登或對話。` });
    users.filter(u => u.sell.draft >= 3 && u.sell.active === 0).slice(0, 3).forEach(u => out.push({ sev: 'info', user: u.ref, text: `${u.shown} 有 ${int(u.sell.draft)} 件刊登停在草稿，沒有任何一件刊出。` }));
    users.filter(u => u.sell.expired > 0 && u.sell.active === 0).slice(0, 3).forEach(u => out.push({ sev: 'info', user: u.ref, text: `${u.shown} 的 ${int(u.sell.expired)} 件刊登已過期，目前沒有刊登中的商品。` }));
    const open = users.filter(u => u.meet.open > 0);
    if (open.length) out.push({ sev: 'info', filter: 'meet', text: `有 ${int(open.length)} 個帳戶約了面交還沒完成（共 ${int(open.reduce((a, u) => a + u.meet.open, 0))} 筆，買賣雙方各算一次）。` });
    const busy = users.filter(u => u.act30 > 0).sort((a, b) => b.act30 - a.act30)[0];
    if (busy) {
      const d = busy.days.reduce((a, x) => [a[0] + x[1], a[1] + x[2], a[2] + x[3]], [0, 0, 0]);
      out.push({ sev: 'info', user: busy.ref, text: `近 30 天最活躍的是 ${busy.shown}：新增 ${int(d[0])} 個願望、${int(d[1])} 件刊登、${int(d[2])} 則訊息。` });
    } else out.push({ sev: 'info', text: '近 30 天沒有任何帳戶新增願望、刊登或傳訊息。' });
    const fresh = users.filter(u => u.createdAt && Date.now() - u.createdAt < 7 * DAY);
    if (fresh.length) out.push({ sev: 'info', filter: 'new', text: `近 7 天有 ${int(fresh.length)} 個新帳戶，其中 ${int(fresh.filter(u => u.stage !== 'idle').length)} 個已經開始使用。` });
    const unverified = users.filter(u => !u.ev && !u.pv).length;
    if (unverified) out.push({ sev: 'info', filter: 'unverified', text: `有 ${int(unverified)} 個帳戶的信箱和手機都還沒驗證。` });
    if (t.appUsers) out.push({ sev: 'info', filter: 'app', text: `${int(t.appUsers)} 個帳戶裝了 App 並開啟通知（iOS ${int(users.filter(u => u.dev.ios > 0).length)}、Android ${int(users.filter(u => u.dev.android > 0).length)}）。` });
    if (t.paidUsers) out.push({ sev: 'info', text: `付費帳戶 ${int(t.paidUsers)} 個，累計 NT$ ${int(t.paidTwd)}。` });
    if (meta && meta.dropped) out.push({ sev: 'warn', text: `這次略過了 ${int(meta.dropped)} 個最久沒有動作的帳戶的明細（資料量上限）；上面的總數仍包含它們。` });
    const order = { crit: 0, warn: 1, info: 2, ok: 3 };
    return out.sort((a, b) => order[a.sev] - order[b.sev]);
  }

  // ---- 小圖 --------------------------------------------------------------------
  function stackBar(parts, total, cls) {
    // parts: [[label, value, color]]
    if (!total) return '<span class="th-bar is-empty' + (cls ? ' ' + cls : '') + '"></span>';
    const tip = parts.filter(p => p[1]).map(p => p[0] + ' ' + int(p[1]) + '（' + pct(p[1], total) + '%）').join('\n');
    return '<span class="th-bar' + (cls ? ' ' + cls : '') + '" tabindex="0" data-tip="' + esc(tip) + '">' + parts.filter(p => p[1]).map(p => '<i style="flex:' + p[1] + ';background:' + p[2] + '"></i>').join('') + '</span>';
  }
  const dayList = () => { const out = []; for (let i = 29; i >= 0; i--) out.push(new Date(Date.now() - i * DAY + 8 * HOUR).toISOString().slice(0, 10)); return out; };
  function spark(days) {
    if (!days || !days.length) return '<span class="muted">—</span>';
    const map = Object.fromEntries(days.map(d => [d[0], d[1] + d[2] + d[3]])), vals = dayList().map(d => map[d] || 0);
    const max = Math.max(1, ...vals), w = 90, h = 22, step = w / vals.length;
    return '<svg class="th-spark" viewBox="0 0 ' + w + ' ' + h + '" width="' + w + '" height="' + h + '" aria-hidden="true">' + vals.map((v, i) => (v ? '<rect x="' + (i * step + .5).toFixed(1) + '" y="' + (h - Math.max(2, v / max * h)).toFixed(1) + '" width="' + Math.max(1, step - 1).toFixed(1) + '" height="' + Math.max(2, v / max * h).toFixed(1) + '" rx="1"/>' : '')).join('') + '</svg>';
  }
  function dailyChart(days) {
    const series = [[1, '新增願望', 'var(--s1)'], [2, '新增刊登', 'var(--s3)'], [3, '傳出訊息', 'var(--s4)']];
    const map = Object.fromEntries((days || []).map(d => [d[0], d])), cols = dayList().map(d => [d, map[d] || null]);
    const total = r => (r ? r[1] + r[2] + r[3] : 0), max = Math.max(1, ...cols.map(c => total(c[1])));
    if (!cols.some(c => total(c[1]) > 0)) return '<p class="empty">近 30 天沒有新增願望、刊登或訊息。</p>';
    const w = 600, h = 120, bw = w / cols.length;
    const bars = cols.map(([d, r], i) => {
      let y = h; const tip = [d.replace(/-/g, '/')].concat(series.map(s => s[1] + ' ' + int(r ? r[s[0]] : 0)));
      const rects = series.map(s => { const v = r ? r[s[0]] : 0; if (!v) return ''; const hh = Math.max(1.5, v / max * (h - 4)); y -= hh; return '<rect x="' + (i * bw + 1).toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + Math.max(1, bw - 2).toFixed(1) + '" height="' + hh.toFixed(1) + '" style="fill:' + s[2] + '"/>'; }).join('');
      return '<g class="th-col" tabindex="0" data-tip="' + esc(tip.join('\n')) + '"><rect class="th-hit" x="' + (i * bw).toFixed(1) + '" y="0" width="' + bw.toFixed(1) + '" height="' + h + '"/>' + rects + '</g>';
    }).join('');
    return '<div class="th-chart"><svg viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none" role="img" aria-label="近 30 天每日活動">' + bars + '</svg>' +
      '<div class="th-axis"><span>' + dayLabel(cols[0][0]) + '</span><span>' + dayLabel(cols[15][0]) + '</span><span>今天</span></div>' +
      '<div class="legend">' + series.map(s => '<span class="lg"><i class="lg-k is-bar" style="--c:' + s[2] + '"></i>' + esc(s[1]) + '</span>').join('') + '</div></div>';
  }

  // ---- 畫面 --------------------------------------------------------------------
  const COLS = [
    ['name', '帳戶', false], ['stage', '走到哪一步', false], ['wishes', '願望', true], ['active', '刊登中', true], ['listings', '刊登', true], ['talks', '對話', true],
    ['sent', '訊息', true], ['unread', '未讀', true], ['meets', '面交', true], ['followers', '被追蹤', true], ['trend', '近 30 天活動', false], ['seen', '最近動作', true]
  ];
  const STAGE_RANK = Object.fromEntries(STAGES.map((s, i) => [s[0], i]));
  const SORT = {
    name: u => u.shown, stage: u => STAGE_RANK[u.stage], wishes: u => u.wish.n, active: u => u.sell.active, listings: u => u.sell.n, talks: u => u.talks, sent: u => u.chat.sent,
    unread: u => u.chat.unread, meets: u => u.meet.n, followers: u => u.social.followers, seen: u => u.seenAt || 0,
    attention: u => (u.attention ? 1e15 : 0) + (u.seenAt || u.createdAt || 0)
  };
  const FILTERS = [['all', '全部'], ['attention', '需要注意'], ['active30', '近 30 天活躍'], ['sellers', '有刊登'], ['idle', '只有註冊']];
  // 洞察帶出來的篩選不放在按鈕列，點洞察才會套用
  const HIDDEN_FILTERS = { new: '近 7 天註冊', unverified: '尚未驗證', app: '裝了 App', meet: '面交進行中' };
  const keep = (u, f) => f === 'attention' ? u.attention : f === 'active30' ? u.act30 > 0 : f === 'sellers' ? u.sell.n > 0 : f === 'idle' ? u.stage === 'idle'
    : f === 'new' ? !!u.createdAt && Date.now() - u.createdAt < 7 * DAY : f === 'unverified' ? !u.ev && !u.pv : f === 'app' ? u.devices > 0 : f === 'meet' ? u.meet.open > 0 : true;
  const tags = u => (u.premium ? '<span class="th-tag">Premium</span>' : '') + (u.api ? '<span class="th-tag">API</span>' : '');

  function mount(el, detail) {
    if (!el) return;
    if (!detail || !detail.meta) {
      el.innerHTML = '<section class="card">' + head('帳戶智慧數據庫', '每個帳戶的願望、刊登、對話與面交') + '<p class="empty">還沒有帳戶明細：收集工具下一次執行後就會出現。</p></section>';
      return;
    }
    const meta = detail.meta, users = detail.users.map(enrich);
    const S = { q: '', filter: store.get('filter', 'all'), sort: store.get('sort', { k: 'attention', dir: -1 }), open: store.get('open', null), group: null };
    if (!FILTERS.some(f => f[0] === S.filter)) S.filter = 'all';
    const tiles = () => {
      const t = totalsOf(users, meta);
      const c = (label, value, tip, cls) => '<div class="dm-c' + (cls ? ' ' + cls : '') + '"' + (tip ? ' data-tip="' + esc(tip) + '"' : '') + '><span>' + esc(label) + '</span><b>' + esc(value) + '</b></div>';
      return '<div class="dm">' + c('帳戶', int(t.users) + ' 個', meta.dropped ? '其中 ' + int(meta.dropped) + ' 個沒有明細' : '') + c('近 30 天有動作', int(t.active30) + ' 個', '近 30 天新增過願望、刊登或傳過訊息的帳戶') +
        c('願望', int(t.wishes) + ' 個', int(t.withWish) + ' 個帳戶建立過願望') + c('刊登中／全部', int(t.listingsActive) + '／' + int(t.listings), int(t.withListing) + ' 個帳戶刊登過商品') +
        c('傳出訊息', int(t.sent) + ' 則', int(t.withChat) + ' 個帳戶傳過訊息') + c('完成面交', int(t.withMeetDone) + ' 個帳戶') + c('付費帳戶', int(t.paidUsers) + ' 個', t.paidUsers ? '累計 NT$ ' + int(t.paidTwd) : '') + '</div>';
    };
    const overallBar = () => {
      const parts = STAGES.map(s => [s[1], users.filter(u => u.stage === s[0]).length, s[2], s[0]]);
      if (!users.length) return '';
      return '<div class="th-flow"><div class="th-flow-h"><b>所有帳戶走到哪一步</b><span class="muted">點一段只看停在那一步的帳戶</span></div>' + stackBar(parts, users.length, 'lg') +
        '<div class="th-legend">' + parts.filter(p => p[1]).map(p => '<button type="button" class="th-lg' + (S.group === p[3] ? ' is-on' : '') + '" data-ws="group" data-v="' + p[3] + '" aria-pressed="' + (S.group === p[3]) + '"><i style="background:' + p[2] + '"></i>' + esc(p[0]) + ' <b>' + int(p[1]) + '</b></button>').join('') + '</div></div>';
    };
    const insightHtml = () => '<ul class="th-ins">' + insights(users, meta).map(x => '<li class="th-in th-' + x.sev + '"><i class="sd sd-' + (x.sev === 'ok' ? 'ok' : x.sev === 'info' ? 'live' : x.sev) + '"></i>' +
      (x.user || x.filter ? '<button type="button" class="th-in-b" data-ws="' + (x.user ? 'focus' : 'filter') + '" data-v="' + esc(x.user || x.filter) + '">' + esc(x.text) + '</button>' : '<span>' + esc(x.text) + '</span>') + '</li>').join('') + '</ul>';
    const rows = () => {
      const q = S.q.trim().toLowerCase(), key = SORT[S.sort.k] || SORT.attention;
      let list = users.filter(u => keep(u, S.filter) && (!S.group || u.stage === S.group) && (!q || (u.shown + ' ' + (u.login || '')).toLowerCase().indexOf(q) >= 0));
      list = list.slice().sort((a, b) => { const x = key(a), y = key(b); return (x < y ? -1 : x > y ? 1 : 0) * S.sort.dir || a.shown.localeCompare(b.shown); });
      if (!list.length) return '<tr><td colspan="' + COLS.length + '" class="empty">沒有符合條件的帳戶。</td></tr>';
      return list.map(u => {
        const open = S.open === u.ref, st = STAGE[u.stage];
        const cell = (v, bad) => '<td class="num' + (bad ? ' is-bad' : '') + '">' + v + '</td>';
        return '<tr class="is-click' + (open ? ' is-sel' : '') + '" tabindex="0" data-ws="open" data-v="' + u.ref + '" aria-expanded="' + open + '">' +
          '<td><div class="th-who"><b>' + esc(u.shown) + '</b>' + tags(u) + (u.attention ? '<i class="sd sd-warn" data-tip="需要注意"></i>' : '') + '<span class="muted">' + esc(u.login || '沒有登入信箱') + (u.createdAt ? '・註冊 ' + ago(u.createdAt) : '') + '</span></div></td>' +
          '<td><i class="th-dot" style="background:' + st[2] + '"></i>' + esc(st[1]) + '</td>' +
          cell(int(u.wish.n), u.wish.aiFailed > 0) + cell(int(u.sell.active)) + cell(int(u.sell.n)) + cell(int(u.talks)) + cell(int(u.chat.sent)) +
          cell(int(u.chat.unread) + (u.unreadAge > DAY ? '<small class="th-age"> 最久 ' + span(u.chat.oldestUnreadAt) + '</small>' : ''), u.unreadAge > DAY) +
          cell(int(u.meet.n)) + cell(int(u.social.followers)) + '<td>' + spark(u.days) + '</td>' + cell(u.seenAt ? ago(u.seenAt) : '<span class="muted" data-tip="註冊後沒有任何動作">—</span>') + '</tr>';
      }).join('');
    };
    const table = () => '<div class="tbl-wrap"><table class="tbl th-tbl"><thead><tr>' + COLS.map(c => {
      const sortable = !!SORT[c[0]], on = S.sort.k === c[0];
      return '<th' + (c[2] ? ' class="num"' : '') + (on ? ' aria-sort="' + (S.sort.dir > 0 ? 'ascending' : 'descending') + '"' : '') + '>' + (sortable ? '<button type="button" class="th-sort" data-ws="sort" data-v="' + c[0] + '">' + esc(c[1]) + (on ? (S.sort.dir > 0 ? ' ▲' : ' ▼') : '') + '</button>' : esc(c[1])) + '</th>';
    }).join('') + '</tr></thead><tbody>' + rows() + '</tbody></table></div>';
    const tools = () => '<div class="th-tools"><input type="search" class="field th-q" placeholder="找帳戶（名稱或信箱）" aria-label="找帳戶" value="' + esc(S.q) + '" data-ws-in="q">' +
      '<div class="seg" role="group" aria-label="篩選">' + FILTERS.map(f => '<button type="button" data-ws="filter" data-v="' + f[0] + '" aria-pressed="' + (S.filter === f[0]) + '">' + esc(f[1]) + ' ' + users.filter(u => keep(u, f[0])).length + '</button>').join('') + '</div>' +
      (HIDDEN_FILTERS[S.filter] ? '<span class="chip">只看「' + esc(HIDDEN_FILTERS[S.filter]) + '」<button type="button" data-ws="filter" data-v="all" aria-label="取消">×</button></span>' : '') +
      (S.group ? '<span class="chip">只看「' + esc(STAGE[S.group][1]) + '」<button type="button" data-ws="group" data-v="' + S.group + '" aria-label="取消">×</button></span>' : '') + '</div>';
    // 詳細面板放在表格下面（不放進表格列，免得跟著很寬的表格被裁掉）
    const panel = () => {
      const u = users.find(x => x.ref === S.open);
      if (!u) return '';
      return '<section class="th-panel" id="ws-panel" aria-label="' + esc(u.shown) + ' 的詳細"><header class="th-panel-h"><div><h3>' + esc(u.shown) + tags(u) + '</h3><p class="muted">' + esc(u.login || '沒有登入信箱') + '・' +
        (u.createdAt ? '註冊於 ' + new Date(u.createdAt).toLocaleDateString('zh-TW') : '註冊時間不明') + '・' + (u.seenAt ? '最近動作 ' + ago(u.seenAt) : '註冊後沒有任何動作') + '</p></div>' +
        '<button type="button" class="btn-ghost" data-ws="open" data-v="' + u.ref + '" aria-label="關閉詳細">關閉</button></header>' + drill(u) + '</section>';
    };
    const stamp = () => '<p class="hint">資料時間 ' + esc(meta.asOf ? new Date(meta.asOf).toLocaleString('zh-TW', { hour12: false }) : '—') + (meta.notes && meta.notes.length ? '・' + esc(meta.notes.join('；')) : '') +
      '。每小時更新；在 Wishlist 自己的資料庫裡唯讀統計，只帶回數量與時間，信箱只顯示遮蔽後的樣子。「最近動作」是最後一次新增願望、刊登、傳訊息、詢問來源、付費或註冊裝置的時間（沒有記錄登入時間）。</p>';
    function paint(focusSel) {
      el.innerHTML = '<section class="card th-card">' + head('帳戶智慧數據庫', '每個帳戶的願望、刊登、對話與面交・點一列看詳細') + tiles() + '<div class="th-top"><div class="th-top-l">' + overallBar() + '</div><div class="th-top-r"><b class="th-ins-h">智慧洞察</b>' + insightHtml() + '</div></div>' +
        tools() + table() + panel() + stamp() + '</section>';
      if (focusSel) { const f = el.querySelector(focusSel); if (f) { f.focus({ preventScroll: true }); if (f.setSelectionRange && typeof f.value === 'string') f.setSelectionRange(f.value.length, f.value.length); } }
    }
    function act(name, v) {
      if (name === 'open') {
        S.open = S.open === v ? null : v; store.set('open', S.open); paint('tr[data-ws="open"][data-v="' + v + '"]');
        const p = el.querySelector('#ws-panel'); if (p && p.scrollIntoView) p.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        return;
      }
      if (name === 'sort') { S.sort = S.sort.k === v ? { k: v, dir: -S.sort.dir } : { k: v, dir: v === 'name' ? 1 : -1 }; store.set('sort', S.sort); paint('[data-ws="sort"][data-v="' + v + '"]'); return; }
      if (name === 'filter') { S.filter = v; S.group = null; if (FILTERS.some(f => f[0] === v)) store.set('filter', v); paint('[data-ws="filter"][data-v="' + v + '"]'); return; }
      // 「只有註冊」本身就是一個階段：再點階段長條時先放掉它，免得兩個條件互斥、整張表變空
      if (name === 'group') { S.group = S.group === v ? null : v; if (S.group && S.filter === 'idle') { S.filter = 'all'; store.set('filter', 'all'); } paint(); return; }
      if (name === 'focus') {
        S.open = v; S.filter = 'all'; S.group = null; S.q = ''; store.set('open', v); store.set('filter', 'all'); paint('tr[data-ws="open"][data-v="' + v + '"]');
        const p = el.querySelector('#ws-panel'); if (p && p.scrollIntoView) p.scrollIntoView({ block: 'start', behavior: 'smooth' });
      }
    }
    el.onclick = e => { const t = e.target.closest('[data-ws]'); if (t && el.contains(t)) { e.preventDefault(); act(t.dataset.ws, t.dataset.v); } };
    el.onkeydown = e => { const t = e.target.closest('tr[data-ws="open"]'); if (t && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); act('open', t.dataset.v); } };
    el.oninput = e => { if (e.target.dataset.wsIn === 'q') { S.q = e.target.value; paint('[data-ws-in="q"]'); } };
    paint();
  }
  function head(title, sub) { return '<header class="card-h"><div class="card-t"><h2>' + esc(title) + '</h2><p class="sub">' + esc(sub) + '</p></div></header>'; }

  // ---- 單一帳戶的詳細 ------------------------------------------------------------
  function cellK(label, value, bad) { return '<div class="dm-c' + (bad ? ' is-bad' : '') + '"><span>' + esc(label) + '</span><b>' + esc(value) + '</b></div>'; }
  function drill(u) {
    // 這個帳戶的使用歷程：每一步做了多少，長條以這個帳戶自己最多的那一項為滿
    const steps = [['願望', u.wish.n, 'var(--s1)'], ['刊登', u.sell.n, 'var(--s3)'], ['對話', u.talks, 'var(--s4)'], ['來源詢問', u.chat.inquiries, 'var(--ord5)'], ['約面交', u.meet.n, 'var(--s7)'], ['完成面交', u.meet.done, 'var(--s3)']];
    const top = Math.max(1, ...steps.map(s => s[1]));
    const journey = '<div class="th-fn">' + steps.map(s => '<div class="th-fn-r"><span>' + esc(s[0]) + '</span><span class="th-fn-b"><i style="width:' + (s[1] ? Math.max(2, pct(s[1], top)) : 0) + '%;background:' + s[2] + '"></i></span><b>' + int(s[1]) + '</b><em></em></div>').join('') + '</div>';
    const listing = LISTING.filter(x => u.sell[x[0]]).map(x => '<tr><td><i class="th-dot" style="background:' + x[2] + '"></i>' + esc(x[1]) + '</td><td class="num">' + int(u.sell[x[0]]) + '</td><td class="num muted">' + pct(u.sell[x[0]], u.sell.n) + '%</td></tr>').join('');
    const sub = u.sub ? ({ ACTIVE: '訂閱中', CANCELED: '已取消', EXPIRED: '已到期' }[u.sub] || u.sub) + (u.subUntil ? '（到 ' + new Date(u.subUntil).toLocaleDateString('zh-TW') + '）' : '') : '沒有訂閱';
    const dev = [u.dev.ios ? 'iOS ' + int(u.dev.ios) : '', u.dev.android ? 'Android ' + int(u.dev.android) : '', u.dev.other ? '其他 ' + int(u.dev.other) : ''].filter(Boolean).join('、') || '沒有';
    return '<div class="th-drill">' +
      '<div class="th-d th-d-fn"><h3>使用歷程</h3>' + journey + '<p class="hint">目前走到「' + esc(STAGE[u.stage][1]) + '」。</p></div>' +
      '<div class="th-d"><h3>願望</h3><div class="dm th-dm">' + cellK('願望', int(u.wish.n)) + cellK('清單（公開）', int(u.wish.lists) + '（' + int(u.wish.pub) + '）') + cellK('近 30 天新增', int(u.wish.d30)) + cellK('已買到', int(u.wish.bought)) +
        cellK('已隱藏', int(u.wish.hidden)) + cellK('AI 整理失敗', int(u.wish.aiFailed), u.wish.aiFailed) + cellK('從探索加入', int(u.wish.linked)) + cellK('關注別人的願望', int(u.wish.watches)) + '</div></div>' +
      '<div class="th-d"><h3>刊登（' + int(u.sell.n) + ' 件）</h3>' + (listing ? '<table class="tbl th-mini"><tbody>' + listing + '</tbody></table><p class="hint">近 30 天新增 ' + int(u.sell.d30) + ' 件。</p>' : '<p class="empty">沒有刊登過商品。</p>') + '</div>' +
      '<div class="th-d"><h3>對話與訊息</h3><div class="dm th-dm">' + cellK('當買家的對話', int(u.chat.buy)) + cellK('當賣家的對話', int(u.chat.sell)) + cellK('傳出訊息', int(u.chat.sent)) + cellK('近 30 天', int(u.chat.d30)) +
        cellK('對方回了還沒讀', int(u.chat.unread), u.unreadAge > DAY) + cellK('詢問來源賣家', int(u.chat.inquiries)) + '</div>' + (u.talkAt ? '<p class="hint">對話裡最後一則訊息 ' + ago(u.talkAt) + '。</p>' : '') + '</div>' +
      '<div class="th-d"><h3>面交與社群</h3><div class="dm th-dm">' + cellK('面交', int(u.meet.n)) + cellK('進行中', int(u.meet.open)) + cellK('已完成', int(u.meet.done)) + cellK('追蹤中', int(u.social.following)) + cellK('被追蹤', int(u.social.followers)) + cellK('意見回饋', int(u.feedback)) + '</div></div>' +
      '<div class="th-d"><h3>帳戶</h3><div class="dm th-dm">' + cellK('信箱驗證', u.ev ? '已驗證' : '還沒') + cellK('手機驗證', u.pv ? '已驗證' : '還沒') + cellK('付費', u.pay.n ? int(u.pay.n) + ' 筆・NT$ ' + int(u.pay.twd) : '沒有') + cellK('訂閱', sub) +
        cellK('開啟通知的裝置', dev) + cellK('AI 使用次數', int(u.ai)) + '</div></div>' +
      '<div class="th-d th-wide"><h3>近 30 天活動</h3>' + dailyChart(u.days) + '</div>' +
      '</div>';
  }

  // 從中樞的事實取出明細
  function fromFacts(facts) {
    const f = facts || {}, zero = (o, keys) => { const out = Object.assign({}, o || {}); keys.forEach(k => { out[k] = Number.isFinite(out[k]) ? out[k] : 0; }); return out; };
    const users = Object.keys(f).filter(k => /^wlUser[a-f0-9]{10}$/.test(k) && f[k] && f[k].v === 1).map(k => {
      const u = Object.assign({ ref: k.slice(6) }, f[k]);
      u.wish = zero(u.wish, ['n', 'lists', 'pub', 'bought', 'hidden', 'aiFailed', 'd30', 'linked', 'watches']);
      u.sell = zero(u.sell, ['n', 'active', 'reserved', 'sold', 'expired', 'removed', 'draft', 'd30']);
      u.chat = zero(u.chat, ['buy', 'sell', 'sent', 'd30', 'unread', 'inquiries']);
      u.meet = zero(u.meet, ['n', 'open', 'done']); u.pay = zero(u.pay, ['n', 'twd']); u.social = zero(u.social, ['following', 'followers']); u.dev = zero(u.dev, ['ios', 'android', 'other']);
      u.ai = Number.isFinite(u.ai) ? u.ai : 0; u.feedback = Number.isFinite(u.feedback) ? u.feedback : 0;
      u.days = (Array.isArray(u.days) ? u.days : []).filter(d => Array.isArray(d) && typeof d[0] === 'string').map(d => [d[0], +d[1] || 0, +d[2] || 0, +d[3] || 0]);
      return u;
    });
    return { meta: f.wlUsersMeta && f.wlUsersMeta.v === 1 ? f.wlUsersMeta : null, users };
  }
  window.HubWeesh = { mount, fromFacts, insights: (users, meta) => insights(users.map(enrich), meta), enrich, stageOf };
})();
