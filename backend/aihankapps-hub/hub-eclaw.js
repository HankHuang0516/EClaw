/* global window, document, localStorage, location, fetch, AbortController, setInterval, clearInterval */
/* EClaw's original admin data, read from the same account-gated APIs on demand.
   No database copy, credentials, private payload persistence or public data import. */
(function () {
  'use strict';
  const t = (key, vars) => window.HubEclawText.t(key, vars);
  const esc = value => String(value == null ? '—' : value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const get = (row, path) => path.split('.').reduce((v, k) => v == null ? null : v[k], row);
  const array = v => Array.isArray(v) ? v : [];
  const number = v => v == null || v === '' || !Number.isFinite(Number(v)) ? '—' : new Intl.NumberFormat(window.HubEclawText.locale).format(Number(v));
  const stamp = v => {
    if (v == null || v === '') return '—';
    const date = new Date(v);
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString(window.HubEclawText.locale, { timeZone: 'Asia/Taipei', hour12: false });
  };
  const f = (key, label, format) => ({ key, label: label || key, format });
  const common = [f('id'), f('name'), f('submittedBy.entityName', 'by'), f('description'), f('submittedAt', 'submitted', 'date')];
  // Explicit field lists are shared by table, search and drill-down. Never enumerate an API object.
  const DEFINITIONS = [
    { id: 'users', url: '/api/admin/users', list: 'users', cols: [f('source', 'source', 'enum'), f('email'), f('emailVerified', 'verified', 'bool'), f('subscriptionStatus', 'subscription', 'enum'), f('isAdmin', 'role', 'role'), f('balanceEcoin', 'balance', 'num'), f('deviceId', 'device'), f('createdAt', 'created', 'date'), f('lastLoginAt', 'lastLogin', 'date')], more: [f('subscriptionExpiresAt', 'expires', 'date'), f('heldEcoin', 'held', 'num'), f('boundEntities', 'boundEntities', 'num'), f('isTestDevice', 'qa', 'bool')] },
    { id: 'bots', url: '/api/admin/bots?readOnly=1', list: 'bots', cols: [f('botId', 'id'), f('displayName', 'name'), f('botType', 'type', 'enum'), f('status', 'status', 'enum'), f('bindingCount', 'bindingCount', 'num'), f('conversations24h', 'conversations', 'num'), f('avgConvPer5h', 'avgConversations', 'num'), f('uniqueUsers24h', 'uniqueUsers', 'num'), f('avgUsersPer5h', 'avgUsers', 'num')], more: [f('boundUserEmails', 'users'), f('assignedDeviceId', 'assigned'), f('assignedEntityId', 'entity', 'num'), f('assignedUserEmail', 'email'), f('assignedAt', 'assignedAt', 'date'), f('createdAt', 'created', 'date')] },
    { id: 'bindings', url: '/api/admin/bindings', list: 'bindings', cols: [f('botId', 'id'), f('botType', 'type', 'enum'), f('deviceId', 'device'), f('entityId', 'entity', 'num'), f('userEmail', 'email'), f('boundAt', 'boundAt', 'date'), f('subscriptionVerifiedAt', 'subVerified', 'date')] },
    { id: 'skills', url: '/api/skill-templates/contributions', list: 'contributions', cols: [f('id'), f('title', 'name'), f('submittedBy.entityName', 'by'), f('status', 'status', 'enum'), f('verificationResult.githubStatus', 'github', 'num'), f('verificationResult.stars', 'stars', 'num'), f('submittedAt', 'submitted', 'date')], more: [f('submittedBy.entityId', 'entity'), f('verificationResult.description', 'description'), f('rejectedReason', 'rejected')] },
    { id: 'souls', url: '/api/soul-templates/contributions', list: 'contributions', cols: common, more: [f('label', 'name'), f('icon', 'type'), f('submittedBy.entityId', 'entity')] },
    { id: 'rules', url: '/api/rule-templates/contributions', list: 'contributions', cols: [...common.slice(0, 3), f('ruleType', 'type'), ...common.slice(3)], more: [f('label', 'name'), f('icon', 'type'), f('submittedBy.entityId', 'entity')] },
    { id: 'arena', url: '/api/arena/feedback?limit=50', list: 'feedback', cols: [f('created_at', 'time', 'date'), f('model'), f('total_score', 'score', 'num'), f('desired_capabilities', 'capabilities'), f('credibility_score', 'credibility', 'num'), f('comment')] },
    { id: 'paper', url: '/api/admin/paper-beta-feedback', list: 'items', cols: [f('rating', 'rating', 'num'), f('continuation', 'continuation', 'enum'), f('comment'), f('version', 'appVersion'), f('platform'), f('createdAt', 'time', 'date')] },
    { id: 'submissions', url: '/api/admin/minigame-submissions?limit=50', list: 'submissions', cols: [f('created_at', 'time', 'date'), f('category'), f('severity'), f('status', 'status', 'enum'), f('source'), f('tags'), f('message'), f('device_id', 'device'), f('github_issue_url', 'issue')] },
    { id: 'errors', url: '/api/admin/minigame-analytics?hours=24&limit=25', list: 'errorStats', cols: [f('gameId', 'game'), f('count', 'total', 'num'), f('serverErrors', 'serverErrors', 'num'), f('telemetryErrors', 'clientErrors', 'num'), f('uniqueDevices', 'devices', 'num'), f('lastSeenAt', 'lastSeen', 'date'), f('errorSignature', 'signature')] }
  ];
  const STATS = { id: 'stats', url: '/api/admin/stats' };
  const ALL = [STATS, ...DEFINITIONS];
  // Additional original response fields stay in the private drill-down, not a generic JSON dump.
  const additions = {
    users: [f('id')], bindings: [f('botStatus', 'status', 'enum')],
    skills: [f('pendingId', 'pendingId'), f('url', 'github'), f('author', 'author'), f('icon', 'type'), f('verifiedAt', 'verifiedAt', 'date')],
    souls: [f('pendingId', 'pendingId'), f('author', 'author'), f('status', 'status', 'enum'), f('verifiedAt', 'verifiedAt', 'date')],
    rules: [f('pendingId', 'pendingId'), f('author', 'author'), f('status', 'status', 'enum'), f('verifiedAt', 'verifiedAt', 'date')],
    arena: [f('id'), f('exam_id', 'examId')], paper: [f('receiptId', 'receiptId')],
    submissions: [f('id'), f('app_version', 'appVersion')], errors: [f('firstSeenAt', 'firstSeen', 'date')]
  };
  DEFINITIONS.forEach(d => { d.more = [...(d.more || []), ...(additions[d.id] || [])]; });
  const ENUM_KEYS = { registered: 'web', app_device: 'app', true: 'yes', false: 'no', available: 'available', assigned: 'assignedState', approved: 'approved', pending: 'pending', rejected: 'rejectedState', premium: 'premiumState', free: 'free', personal: 'personal', yes: 'yes', no: 'no', maybe: 'maybe' };
  const enumText = v => Object.prototype.hasOwnProperty.call(ENUM_KEYS, v) ? t(ENUM_KEYS[v]) : v;
  function display(v, col) {
    if (v == null) return '—';
    if (col.format === 'day') return /^\d{4}-\d{2}-\d{2}/.test(String(v)) ? String(v).slice(0, 10) : '—';
    if (col.format === 'date') return stamp(v);
    if (col.format === 'num') return number(v);
    if (col.format === 'role') return t(v ? 'admin' : 'member');
    if (col.format === 'bool') return t(v ? 'yes' : 'no');
    if (col.format === 'enum') return enumText(v);
    if (Array.isArray(v)) return v.filter(x => typeof x === 'string' || typeof x === 'number').join('、') || '—';
    return ['string', 'number', 'boolean'].includes(typeof v) ? String(v) : '—';
  }
  const fields = def => [...def.cols, ...(def.more || [])];
  function project(row, def) {
    return Object.fromEntries(fields(def).map(c => {
      let value = get(row, c.key);
      if (['souls', 'rules'].includes(def.id) && c.key === 'name' && !value) value = row.label;
      // APP-only devices have no account email/role/wallet; unique-user averages are free-Bot-only.
      if (def.id === 'users' && row.source === 'app_device' && ['emailVerified', 'isAdmin', 'balanceEcoin', 'heldEcoin'].includes(c.key)) value = null;
      if (def.id === 'bots' && row.botType === 'personal' && ['uniqueUsers24h', 'avgUsersPer5h'].includes(c.key)) value = null;
      return [c.key, value];
    }));
  }
  const isQa = row => row.isTestDevice === true || /^(qa[._+-]|e2e[._+-]|test[._+@-]|arena_test_)/i.test(row.email || '');
  const attention = (row, id) => id === 'users' ? row.source === 'registered' && !row.emailVerified : id === 'skills' ? row.status === 'pending' : id === 'submissions' ? !['closed', 'resolved'].includes(row.status) : id === 'errors';
  const head = (title, subtitle) => '<div class="card-h"><div><h2>' + esc(title) + '</h2>' + (subtitle ? '<p class="muted">' + esc(subtitle) + '</p>' : '') + '</div></div>';
  const tile = (label, value) => '<div class="dm-c"><span>' + esc(t(label)) + '</span><b>' + esc(value) + '</b></div>';
  const button = (action, label, value, extra) => '<button type="button" class="btn" data-ec="' + action + '"' + (value == null ? '' : ' data-value="' + esc(value) + '"') + (extra || '') + '>' + esc(t(label)) + '</button>';

  function overview(s) {
    if (!s) return '';
    return '<div class="dm">' + [
      ['totalUsers', 'users.total'], ['premium', 'users.premium'], ['verified', 'users.verified'], ['devices', 'devices.total'], ['entities', 'devices.entities'], ['boundEntities', 'devices.boundEntities'],
      ['totalBindings', 'bindings.total'], ['freeBindings', 'bindings.free'], ['personalBindings', 'bindings.personal'], ['messagesToday', 'messagesToday']
    ].map(([key, path]) => tile(key, number(get(s, path)))).join('') + '</div><p class="muted">' + esc(t('version')) + ' ' + esc(s.currentAppVersion) + '</p>';
  }
  function insights(data) {
    const out = [], s = data.stats;
    if (s && get(s, 'users.total') != null && get(s, 'users.verified') != null && s.users.total > s.users.verified) out.push({ tab: 'users', filter: 'attention', text: t('unverifiedInsight', { n: number(s.users.total - s.users.verified) }) });
    if (data.bindings) out.push({ tab: 'bindings', text: t('bindingInsight', { n: number(array(data.bindings.bindings).length) }) });
    const n = data.skills && array(data.skills.contributions).filter(c => c.status === 'pending').length;
    if (n) out.push({ tab: 'skills', filter: 'attention', text: t('pendingInsight', { n: number(n) }) });
    const e = get(data.errors, 'summary.errorEvents');
    if (e > 0) out.push({ tab: 'errors', text: t('errorsInsight', { n: number(e) }) });
    return out;
  }
  function plainTable(cols, rows) {
    if (!rows.length) return '<p class="empty">' + esc(t('empty')) + '</p>';
    return '<div class="tbl-wrap"><table class="tbl ec-table"><thead><tr>' + cols.map(c => '<th scope="col">' + esc(t(c.label)) + '</th>').join('') + '</tr></thead><tbody>' + rows.map(row => '<tr>' + cols.map(c => '<td>' + esc(display(get(row, c.key), c)) + '</td>').join('') + '</tr>').join('') + '</tbody></table></div>';
  }
  function statsTables(s) {
    if (!s) return '';
    const botRows = ['free', 'personal'].map(type => ({ type, ...((s.officialBots || {})[type] || {}) }));
    return '<details class="ec-stats"><summary>' + esc(t('signup')) + ' · ' + esc(t('platform')) + ' · ' + esc(t('botOverview')) + ' · ' + esc(t('botDaily')) + '</summary>' +
      '<h3>' + esc(t('signup')) + '</h3>' + plainTable([f('date', 'date', 'day'), f('count', 'newUsers', 'num')], array(s.recentSignups)) +
      '<h3>' + esc(t('platform')) + '</h3><p class="muted">' + esc(t('platformNote')) + '</p><div class="dm">' + ['web', 'app', 'total'].map(k => tile(k, number(get(s, 'platformBreakdown.' + k)))).join('') + '</div>' +
      '<h3>' + esc(t('botOverview')) + '</h3>' + plainTable([f('type', 'type', 'enum'), f('total', 'total', 'num'), f('assigned', 'assignedCount', 'num')], botRows) +
      '<h3>' + esc(t('botDaily')) + '</h3>' + plainTable([f('date', 'date', 'day'), f('botType', 'type', 'enum'), f('msgCount', 'messages', 'num'), f('uniqueDevices', 'devices', 'num')], array(s.botConversationsDaily)) + '</details>';
  }
  function quoteToChat(source, title, excerpt) {
    const payload = { type: 'eclaw_quote', source, title: title.slice(0, 80), excerpt: excerpt.slice(0, 160), ts: Date.now() };
    if (window.self !== window.top) window.parent.postMessage(payload, location.origin);
    else { localStorage.setItem('eclaw_pending_quote', JSON.stringify(payload)); location.href = '/portal/chat.html'; }
  }

  function mount(root, options = {}) {
    if (!root) return () => {};
    let data = {}, errors = new Set(), stopped = false, busy = false, generation = 0, request;
    const timeouts = new Set();
    let sourceAt = {};
    let at = null, paperCursor = null, denied = false, submissionOffset = 0;
    const S = { tab: 'users', q: '', filter: 'all', sort: null, dir: 1, page: 0, open: null, hideQa: false, errorTab: 'errorStats' };
    const active = () => DEFINITIONS.find(d => d.id === S.tab);
    const alive = () => !stopped && root.isConnected;
    root.innerHTML = '<section class="card ec-admin">' + head(t('title'), t('subtitle')) + '<div class="ec-status" role="status"></div><div class="ec-overview"></div><div class="ec-insights"></div><nav class="ec-tabs" aria-label="' + esc(t('title')) + '"></nav><div class="ec-body"></div></section>';
    const el = selector => root.querySelector(selector);
    const status = () => {
      el('.ec-status').innerHTML = '<span>' + esc(denied ? t('denied') : busy ? t('loading') : at ? t('observed', { time: stamp(at) }) : '') + '</span>' + (denied ? '' : button('refresh', 'refresh', null, busy ? ' disabled' : ''));
    };
    function selected() {
      let def = active(), raw = data[S.tab];
      if (S.tab === 'errors') {
        const cols = S.errorTab === 'gameStats' ? [f('gameId', 'game'), f('totalEvents', 'events', 'num'), f('pageViews', 'pageViews', 'num'), f('playActions', 'plays', 'num'), f('errors', 'errorEvents', 'num'), f('uniqueDevices', 'devices', 'num'), f('avgDurationMs', 'avgDuration', 'num'), f('lastSeenAt', 'lastSeen', 'date')]
          : S.errorTab === 'recentErrors' ? [f('createdAt', 'time', 'date'), f('source'), f('gameId', 'game'), f('level'), f('device_id', 'device'), f('message')] : def.cols;
        def = { ...def, cols, list: S.errorTab };
      }
      const all = raw ? array(raw[def.list]).map(row => project(row, def)) : [];
      let rows = all.map((row, index) => ({ row, index }));
      if (S.tab === 'users' && S.hideQa) rows = rows.filter(x => !isQa(x.row));
      if (S.filter === 'attention') rows = rows.filter(x => attention(x.row, S.tab));
      if (['web', 'app'].includes(S.filter)) rows = rows.filter(x => x.row.source === (S.filter === 'web' ? 'registered' : 'app_device'));
      const q = S.q.trim().toLocaleLowerCase();
      if (q) rows = rows.filter(x => fields(def).some(c => display(x.row[c.key], c).toLocaleLowerCase().includes(q)));
      if (S.sort) rows.sort((a, b) => {
        const x = a.row[S.sort], y = b.row[S.sort];
        return x == null ? y == null ? a.index - b.index : 1 : y == null ? -1 : (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), window.HubEclawText.locale, { numeric: true })) * S.dir;
      });
      return { def, all, rows };
    }
    function summary() {
      const raw = data[S.tab], sum = raw && raw.summary;
      if (S.tab === 'users' && raw) return '<div class="dm">' + tile('totalDevices', number(raw.totalDevices)) + '</div>';
      if (!sum) return '';
      const paths = S.tab === 'paper' ? [['paperTotal', 'total'], ['averageRating', 'averageRating'], ['paperYes', 'continuation.yes'], ['paperMaybe', 'continuation.maybe'], ['paperNo', 'continuation.no']]
        : S.tab === 'submissions' ? [['totalSubmissions', 'total'], ['open', 'open'], ['bugReports', 'bugReports'], ['highPriority', 'highPriority']]
          : S.tab === 'errors' ? [['errorEvents', 'errorEvents'], ['serverErrors', 'serverErrorEvents'], ['clientErrors', 'telemetryErrorEvents'], ['affectedGames', 'affectedGames'], ['pageViews', 'pageViews'], ['plays', 'playActions'], ['devices', 'uniqueDevices'], ['telemetryEvents', 'totalEvents']] : [];
      return paths.length ? '<div class="dm">' + paths.map(([key, path]) => tile(key, number(get(sum, path)))).join('') + '</div>' : '';
    }
    function paintRows() {
      const body = el('.ec-results');
      if (!body) return;
      const { def, all, rows } = selected(), size = 25, pages = Math.max(1, Math.ceil(rows.length / size));
      S.page = Math.min(S.page, pages - 1);
      const visible = rows.slice(S.page * size, (S.page + 1) * size);
      const opened = visible.find(x => x.index === S.open);
      body.innerHTML = '<p class="muted" role="status">' + esc(t('count', { n: number(rows.length), total: number(all.length) })) + '</p>' +
        (rows.length ? '<div class="tbl-wrap"><table class="tbl ec-table"><thead><tr>' + def.cols.map(c => '<th scope="col" aria-sort="' + (S.sort !== c.key ? 'none' : S.dir === 1 ? 'ascending' : 'descending') + '">' + button('sort', c.label, c.key) + '</th>').join('') + '<th scope="col">' + esc(t('details')) + '</th></tr></thead><tbody>' + visible.map(({ row, index }) => '<tr' + (S.open === index ? ' class="is-open"' : '') + '>' + def.cols.map(c => '<td>' + esc(display(row[c.key], c)) + (S.tab === 'users' && c.key === 'email' && isQa(row) ? ' <span class="th-tag th-tag-qa">' + esc(t('qa')) + '</span>' : '') + '</td>').join('') + '<td>' + button('detail', S.open === index ? 'close' : 'details', index, ' aria-expanded="' + (S.open === index) + '" aria-controls="ec-detail"') + '</td></tr>').join('') + '</tbody></table></div>' : '<p class="empty">' + esc(t(all.length ? 'noMatch' : 'empty')) + '</p>') +
        '<div class="ec-pagination">' + button('previous', 'previous', null, S.page ? '' : ' disabled') + '<span>' + (S.page + 1) + ' / ' + pages + '</span>' + button('next', 'next', null, S.page + 1 < pages ? '' : ' disabled') + '</div>' +
        '<div id="ec-detail"' + (opened ? '' : ' hidden') + '>' + (opened ? '<div class="th-panel"><div class="th-panel-h"><h3>' + esc(t(S.tab)) + ' · ' + esc(t('details')) + '</h3>' + button('quote', 'quote') + button('close', 'close') + '</div><dl class="ec-detail-fields">' + fields(def).map(c => '<div><dt>' + esc(t(c.label)) + '</dt><dd>' + esc(display(opened.row[c.key], c)) + '</dd></div>').join('') + '</dl></div>' : '') + '</div>';
    }
    function paintBody() {
      const def = active(), body = el('.ec-body');
      if (denied) { body.replaceChildren(); return; }
      if (errors.has(def.id) || !data[def.id]) {
        body.innerHTML = '<p class="empty">' + esc(t(errors.has(def.id) ? 'unavailable' : 'loading')) + '</p>' + (errors.has(def.id) ? button('retry', 'retry', def.id, busy ? ' disabled' : '') : '');
        return;
      }
      body.innerHTML = '<h3>' + esc(t(def.id)) + '</h3><p class="muted">' + esc(t('observed', { time: stamp(sourceAt[def.id]) })) + '</p>' + summary() + (S.tab === 'errors' ? '<div class="seg">' + ['errorStats', 'gameStats', 'recentErrors'].map(k => button('error-tab', k, k, ' aria-pressed="' + (S.errorTab === k) + '"')).join('') + '</div>' : '') +
        '<div class="th-tools"><label class="ec-search">' + esc(t('search')) + '<input type="search" class="input" data-ec-input="search" placeholder="' + esc(t('searchHint')) + '" value="' + esc(S.q) + '"></label><div class="seg" role="group" aria-label="' + esc(t('attention')) + '">' + (S.tab === 'users' ? ['all', 'attention', 'web', 'app'] : ['skills', 'submissions', 'errors'].includes(S.tab) ? ['all', 'attention'] : ['all']).map(k => button('filter', k, k, ' aria-pressed="' + (S.filter === k) + '"')).join('') + '</div>' +
        (S.tab === 'users' ? '<label><input type="checkbox" data-ec-input="qa"' + (S.hideQa ? ' checked' : '') + '> ' + esc(t('hideQa')) + '</label>' : '') + '</div><div class="ec-results"></div>' +
        (S.tab === 'paper' ? '<div class="ec-pagination">' + button('paper-latest', 'paperLatest', null, busy ? ' disabled' : '') + button('paper-older', 'paperOlder', null, !paperCursor || busy ? ' disabled' : '') + '</div>' : '') +
        (S.tab === 'submissions' ? '<div class="ec-pagination">' + button('submissions-latest', 'submissionsLatest', null, busy ? ' disabled' : '') + button('submissions-older', 'submissionsOlder', null, busy || array(data.submissions.submissions).length < 50 ? ' disabled' : '') + '</div>' : '');
      paintRows();
    }
    function paint() {
      if (!alive()) return;
      status();
      el('.ec-overview').innerHTML = denied ? '' : overview(data.stats) + statsTables(data.stats);
      const items = denied ? [] : insights(data);
      el('.ec-insights').innerHTML = (errors.size && !denied ? '<p class="note">' + esc(t('partial')) + '</p>' : '') + (items.length ? '<div class="ec-ins"><b class="th-ins-h">' + esc(t('insights')) + '</b><ul class="th-ins">' + items.map(x => '<li class="th-in"><button type="button" class="th-in-b" data-ec="insight" data-value="' + x.tab + '" data-filter="' + (x.filter || 'all') + '">' + esc(x.text) + '</button></li>').join('') + '</ul></div>' : '');
      el('.ec-tabs').innerHTML = denied ? '' : DEFINITIONS.map(d => '<button type="button" class="btn" data-ec="tab" data-value="' + d.id + '" aria-pressed="' + (S.tab === d.id) + '">' + esc(t(d.id)) + (errors.has(d.id) ? ' !' : data[d.id] ? ' <span>' + number(array(data[d.id][d.list]).length) + '</span>' : '') + '</button>').join('');
      paintBody();
    }
    async function load(ids, before) {
      if (!alive() || busy) return;
      busy = true; status();
      const seq = ++generation;
      const controller = new AbortController();
      request = controller;
      const timeout = setTimeout(() => controller.abort(), 20000);
      timeouts.add(timeout);
      const targets = ids ? ALL.filter(d => ids.includes(d.id)) : ALL;
      await Promise.all(targets.map(async def => {
        try {
          const url = def.url + (def.id === 'paper' && before ? '?before=' + encodeURIComponent(before) : def.id === 'submissions' && submissionOffset ? '&offset=' + submissionOffset : '');
          const res = await fetch(url, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal, headers: { Accept: 'application/json' } });
          if (seq !== generation || !alive()) return;
          if (res.status === 401 || res.status === 403) { denied = true; data = {}; errors.clear(); paint(); controller.abort(); return; }
          if (!res.ok) throw new Error('unavailable');
          const value = await res.json();
          if (!value || value.success !== true || (def.list && !Array.isArray(value[def.list])) ||
            (def.id === 'stats' && (!value.users || !value.devices || !value.bindings)) ||
            (def.id === 'errors' && (!value.summary || !Array.isArray(value.gameStats) || !Array.isArray(value.recentErrors)))) throw new Error('invalid_shape');
          if (seq !== generation || !alive() || denied) return;
          data[def.id] = value; errors.delete(def.id);
          sourceAt[def.id] = Date.now();
          if (def.id === 'paper') paperCursor = value.nextCursor || null;
        } catch (error) {
          if (seq === generation && alive() && !denied) { delete data[def.id]; errors.add(def.id); }
        }
      }));
      clearTimeout(timeout);
      timeouts.delete(timeout);
      if (seq !== generation || !alive()) return;
      busy = false; at = Date.now();
      if (denied) { data = {}; sourceAt = {}; errors.clear(); clearInterval(timer); }
      paint();
    }
    function reset() { S.q = ''; S.filter = 'all'; S.sort = null; S.page = 0; S.open = null; }
    function click(event) {
      const b = event.target.closest('[data-ec]');
      if (!b || !root.contains(b) || b.disabled || denied) return;
      const action = b.dataset.ec, value = b.dataset.value;
      if (action === 'refresh') { S.open = null; load(); return; }
      if (action === 'retry') { load([value]); return; }
      if (action === 'paper-older' || action === 'paper-latest') { S.page = 0; S.open = null; load(['paper'], action === 'paper-older' ? paperCursor : null); return; }
      if (action === 'submissions-older' || action === 'submissions-latest') { if (busy) return; submissionOffset = action === 'submissions-older' ? submissionOffset + 50 : 0; S.page = 0; S.open = null; load(['submissions']); return; }
      if (action === 'quote') {
        const { def, rows } = selected(), row = rows.find(x => x.index === S.open);
        // Quote a short status/number summary; never copy emails, devices, comments or raw log messages.
        if (row) quoteToChat('EClaw', t(S.tab), def.cols.filter(c => ['num', 'enum', 'bool', 'role'].includes(c.format)).slice(0, 3).map(c => t(c.label) + ': ' + display(row.row[c.key], c)).join(' · ') || t('details'));
        return;
      }
      if (action === 'tab' || action === 'insight') { S.tab = value; reset(); if (action === 'insight') S.filter = b.dataset.filter; paint(); return; }
      if (action === 'error-tab') { S.errorTab = value; reset(); paintBody(); return; }
      if (action === 'sort') { S.dir = S.sort === value ? -S.dir : 1; S.sort = value; }
      if (action === 'filter') { S.filter = value; S.page = 0; S.open = null; paintBody(); return; }
      const oldOpen = S.open;
      if (action === 'detail') S.open = S.open === Number(value) ? null : Number(value);
      if (action === 'close') S.open = null;
      if (action === 'previous') { S.page = Math.max(0, S.page - 1); S.open = null; }
      if (action === 'next') { S.page++; S.open = null; }
      paintRows();
      if (action === 'detail' && S.open != null) el('#ec-detail').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      if (action === 'detail' || action === 'close') {
        const target = el(S.open != null ? '[data-ec="close"]' : '[data-ec="detail"][data-value="' + (value == null ? oldOpen : value) + '"]');
        if (target) target.focus({ preventScroll: true });
      }
    }
    function input(event) {
      const kind = event.target.dataset.ecInput;
      if (kind === 'search') S.q = event.target.value;
      else if (kind === 'qa') S.hideQa = event.target.checked;
      else return;
      S.page = 0; S.open = null; paintRows();
    }
    root.addEventListener('click', click);
    root.addEventListener('input', input);
    const timer = setInterval(() => {
      if (!alive()) { dispose(); return; }
      const editing = root.contains(document.activeElement) && ['INPUT', 'TEXTAREA', 'SELECT'].includes(String(document.activeElement.tagName).toUpperCase());
      if (!document.hidden && (!options.live || options.live()) && !editing && S.open == null && !S.q && S.page === 0 && submissionOffset === 0) load();
    }, 60000);
    function clearTimers() { timeouts.forEach(clearTimeout); timeouts.clear(); }
    function dispose() { stopped = true; generation++; clearInterval(timer); clearTimers(); if (request) request.abort(); data = {}; sourceAt = {}; root.removeEventListener('click', click); root.removeEventListener('input', input); window.removeEventListener('pagehide', hide); window.removeEventListener('pageshow', show); }
    function hide() { generation++; clearTimers(); if (request) request.abort(); data = {}; sourceAt = {}; busy = false; at = null; root.querySelectorAll('.ec-overview,.ec-insights,.ec-tabs,.ec-body').forEach(e => e.replaceChildren()); }
    function show(event) { if (event.persisted && alive()) { denied = false; load(); } }
    window.addEventListener('pagehide', hide);
    window.addEventListener('pageshow', show);
    // Operation flows retain their existing confirmation and audit behavior; this view only reads.
    root.insertAdjacentHTML('beforeend', '<section class="card">' + head(t('operations'), t('legacyNote')) + '<a class="btn" href="/portal/admin.html?operations=1" target="_blank" rel="noopener">' + esc(t('legacy')) + '</a><p class="muted">' + esc(t('limits')) + ' ' + esc(t('sourceTime')) + ' ' + esc(t('knownOnly')) + '</p></section>');
    paint(); load();
    return dispose;
  }
  window.HubEclaw = { mount, definitions: DEFINITIONS, overview, insights, project, display, isQa, attention };
})();
