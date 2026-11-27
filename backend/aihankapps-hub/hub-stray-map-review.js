/* global window, document, fetch, AbortController */
(function () {
  'use strict';

  const API = '/api/aihankapps/hub/stray-map/review/';
  const COPY = {
    title: ['人工審核', 'Manual review', '人工审核', '手動審査', '수동 검토'],
    reports: ['檢舉案件', 'Reports', '举报案件', '通報案件', '신고 건'],
    photos: ['照片與申訴', 'Photos and appeals', '照片与申诉', '写真と異議申立て', '사진 및 이의 제기'],
    token: ['浪浪地圖審核通行碼', 'Stray Map review token', '浪浪地图审核通行码', 'Stray Map の審査トークン', 'Stray Map 검토 토큰'],
    connect: ['開啟審核', 'Open review', '打开审核', '審査を開く', '검토 열기'],
    lock: ['鎖定審核', 'Lock review', '锁定审核', '審査をロック', '검토 잠그기'],
    active: ['處理中與待處理', 'Open and in review', '处理中与待处理', '未処理・処理中', '미처리 및 검토 중'],
    overdue: ['已逾時', 'Overdue', '已超时', '期限超過', '기한 초과'],
    resolved: ['已結案', 'Closed reports', '已结案', '対応済み', '처리 완료'],
    dismissed: ['已駁回', 'Dismissed', '已驳回', '却下済み', '기각됨'],
    open: ['待處理', 'Open', '待处理', '未処理', '미처리'],
    reviewing: ['處理中', 'In review', '处理中', '処理中', '검토 중'],
    pending: ['待審查', 'Pending', '待审核', '審査待ち', '검토 대기'],
    approved: ['已核准', 'Approved', '已批准', '承認済み', '승인됨'],
    rejected: ['已拒絕', 'Rejected', '已拒绝', '否認済み', '거부됨'],
    animal: ['動物通報', 'Animal report', '动物通报', '動物の投稿', '동물 제보'],
    photo: ['照片', 'Photo', '照片', '写真', '사진'],
    comment: ['留言', 'Comment', '留言', 'コメント', '댓글'],
    filter: ['顯示範圍', 'Filter', '显示范围', '表示範囲', '표시 범위'],
    search: ['搜尋檢舉案件', 'Search reports', '搜索举报案件', '通報案件を検索', '신고 건 검색'],
    note: ['判斷理由', 'Reason for decision', '判断理由', '判断理由', '판단 사유'],
    reasonRequired: ['請填寫判斷理由。', 'Enter a reason for the decision.', '请填写判断理由。', '判断理由を入力してください。', '판단 사유를 입력하세요.'],
    start: ['開始處理', 'Start review', '开始处理', '処理を開始', '검토 시작'],
    dismiss: ['駁回檢舉', 'Dismiss report', '驳回举报', '通報を却下', '신고 기각'],
    remove: ['移除內容', 'Remove content', '移除内容', '内容を削除', '콘텐츠 삭제'],
    ban: ['移除並封鎖來源', 'Remove and block author', '移除并封锁来源', '削除して投稿者をブロック', '삭제하고 작성자 차단'],
    approve: ['核准照片', 'Approve photo', '批准照片', '写真を承認', '사진 승인'],
    reject: ['拒絕照片', 'Reject photo', '拒绝照片', '写真を否認', '사진 거부'],
    hide: ['隱藏照片', 'Hide photo', '隐藏照片', '写真を非表示', '사진 숨기기'],
    appeal: ['照片申訴', 'Photo appeal', '照片申诉', '写真への異議申立て', '사진 이의 제기'],
    allowAppeal: ['接受申訴', 'Accept appeal', '接受申诉', '異議申立てを認容', '이의 제기 수용'],
    denyAppeal: ['維持拒絕', 'Decline appeal', '维持拒绝', '否認を維持', '거부 유지'],
    deadline: ['期限', 'Due', '期限', '期限', '기한'],
    previous: ['上一頁', 'Previous', '上一页', '前へ', '이전'],
    next: ['下一頁', 'Next', '下一页', '次へ', '다음'],
    loading: ['正在讀取案件…', 'Loading cases…', '正在读取案件…', '案件を読み込み中…', '사건을 불러오는 중…'],
    reconnect: ['審核服務暫時無法讀取，正在重新讀取…', 'Review is temporarily unavailable. Reconnecting…', '审核服务暂时无法读取，正在重新读取…', '審査に接続できません。再接続中…', '검토 서비스에 연결할 수 없습니다. 다시 연결하는 중…'],
    empty: ['此範圍沒有案件。', 'No cases in this view.', '此范围没有案件。', 'この範囲に案件はありません。', '이 범위에 사건이 없습니다.'],
    invalid: ['審核通行碼無效。', 'The review token is invalid.', '审核通行码无效。', '審査トークンが無効です。', '검토 토큰이 유효하지 않습니다.'],
    denied: ['請使用管理員帳號重新登入管理中樞。', 'Sign in to the Hub with an administrator account.', '请使用管理员帐号重新登录管理中枢。', '管理者アカウントで管理ハブにログインしてください。', '관리자 계정으로 허브에 로그인하세요.'],
    verifyState: ['操作未確認。正在讀取案件最新狀態…', 'The action is unconfirmed. Checking the current case status…', '操作未确认。正在读取案件最新状态…', '操作を確認できませんでした。最新の状態を確認中…', '작업을 확인하지 못했습니다. 현재 상태를 확인 중…'],
    checked: ['已讀取最新案件狀態。請確認操作結果。', 'The latest case status is shown. Check the outcome.', '已读取最新案件状态。请确认操作结果。', '最新の状態を表示しています。操作の結果を確認してください。', '최신 상태를 표시했습니다. 처리 결과를 확인하세요.'],
    updated: ['案件已更新。', 'Case updated.', '案件已更新。', '案件を更新しました。', '사건이 업데이트되었습니다.'],
    saving: ['正在更新案件…', 'Updating the case…', '正在更新案件…', '案件を更新中…', '사건을 업데이트하는 중…'],
    confirm: ['確認執行', 'Confirm action', '确认执行', '操作を確認', '작업 확인'],
  };
  const languages = ['zh-TW', 'en', 'zh-CN', 'ja', 'ko'];
  const t = key => COPY[key]?.[Math.max(languages.indexOf(window.HubStrayMap?.language() || 'en'), 0)] || key || '';

  function tag(name, value, className) {
    const el = document.createElement(name);
    if (value) el.textContent = value;
    if (className) el.className = className;
    return el;
  }
  function button(key, action, className) {
    const el = tag('button', t(key), className || 'btn');
    el.type = 'button';
    el.onclick = action;
    return el;
  }

  function mount(root) {
    let token = '';
    let kind = 'reports', filter = 'active', offset = 0, searchText = '';
    let rows = [], selected, hasNext = false, read, timer, busy = false, dead = false, delay = 1000;
    const fold = tag('details', '', 'card smr');
    const content = tag('div', '', 'smr-body');
    const status = tag('p', '', 'smr-status');
    status.setAttribute('role', 'status');
    fold.append(tag('summary', t('title')), content, status);
    root.replaceChildren(fold);

    function lock(message) {
      token = '';
      rows = [];
      selected = null;
      clearTimeout(timer);
      read?.abort();
      const form = tag('form', '', 'smr-unlock');
      const label = tag('label', t('token'));
      const input = tag('input');
      input.type = 'password';
      input.autocomplete = 'off';
      input.required = true;
      input.maxLength = 512;
      label.append(input);
      const submit = tag('button', t('connect'), 'btn');
      submit.type = 'submit';
      form.append(label, submit);
      form.onsubmit = event => {
        event.preventDefault();
        token = input.value.trim();
        input.value = '';
        if (token) void load();
      };
      content.replaceChildren(form);
      status.textContent = message ? t(message) : '';
    }

    async function request(path, body, signal) {
      const headers = { 'X-Stray-Map-Review-Token': token };
      if (body) headers['Content-Type'] = 'application/json';
      const response = await fetch(API + path, {
        method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
        signal, headers, ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const data = await response.json().catch(() => null);
      if (response.ok && data?.success === true) return data;
      const error = new Error('Review request failed');
      error.status = response.status;
      error.code = data?.error;
      throw error;
    }

    function accessError(error) {
      if (error.status === 401 || error.status === 403) {
        lock(error.code === 'REVIEW_TOKEN_REJECTED' || error.code === 'REVIEW_TOKEN_REQUIRED' ? 'invalid' : 'denied');
        return true;
      }
      return false;
    }

    async function load(message) {
      if (dead || !fold.open || !token) return;
      clearTimeout(timer);
      read?.abort();
      const controller = new AbortController();
      read = controller;
      rows = [];
      hasNext = false;
      render(false);
      status.textContent = t(message || 'loading');
      try {
        const data = await request(kind === 'reports' ? 'reports' : 'photos?' + new URLSearchParams({ status: filter, offset }), null, controller.signal);
        if (dead || read !== controller || controller.signal.aborted) return;
        rows = data.rows;
        hasNext = data.hasNext === true;
        delay = 1000;
        render();
        status.textContent = message === 'verifyState' ? t('checked') : message ? t(message) : '';
      } catch (error) {
        if (dead || read !== controller || controller.signal.aborted || accessError(error)) return;
        status.textContent = t('reconnect');
        timer = setTimeout(() => void load(message), delay);
        delay = Math.min(30000, delay * 2);
      }
    }

    function switchView(nextKind, nextFilter, nextOffset = 0) {
      if (busy) return;
      kind = nextKind;
      filter = nextFilter;
      offset = nextOffset;
      selected = null;
      void load();
    }

    function date(value) {
      const when = new Date(value);
      return value && Number.isFinite(+when) ? new Intl.DateTimeFormat(window.HubStrayMap?.language(), { dateStyle: 'medium', timeStyle: 'short' }).format(when) : '';
    }

    function render(loaded = true) {
      const tools = tag('div', '', 'smr-tools');
      for (const tab of ['reports', 'photos']) {
        const opt = button(tab, () => switchView(tab, tab === 'reports' ? 'active' : 'pending'));
        opt.setAttribute('aria-pressed', String(tab === kind));
        tools.append(opt);
      }
      tools.append(button('lock', () => lock()));
      const filters = tag('div', '', 'smr-tools');
      const label = tag('label', t('filter'));
      const select = tag('select');
      for (const key of kind === 'reports' ? ['active', 'overdue', 'resolved'] : ['pending', 'approved', 'rejected']) {
        const option = tag('option', t(key));
        option.value = key;
        select.append(option);
      }
      select.value = filter;
      select.onchange = () => switchView(kind, select.value);
      label.append(select);
      filters.append(label);
      if (kind === 'reports') {
        const search = tag('input');
        search.type = 'search';
        search.value = searchText;
        search.placeholder = t('search');
        search.setAttribute('aria-label', t('search'));
        search.oninput = () => { searchText = search.value; cases(main, loaded); };
        filters.append(search);
      } else {
        const prev = button('previous', () => switchView(kind, filter, offset - 50));
        const next = button('next', () => switchView(kind, filter, offset + 50));
        prev.disabled = offset === 0;
        next.disabled = !hasNext;
        filters.append(prev, next);
      }
      const main = tag('div');
      content.replaceChildren(tools, filters, main);
      cases(main, loaded);
    }

    function cases(main, loaded) {
      if (!loaded) { main.replaceChildren(); return; }
      const report = kind === 'reports';
      const matches = rows.filter(row => {
        if (!report) return true;
        const included = filter === 'overdue' ? row.overdue : filter === 'resolved'
          ? ['resolved', 'dismissed'].includes(row.status) : ['open', 'reviewing'].includes(row.status);
        return included && [row.id, row.reason, row.details, row.targetSummary].join(' ').toLowerCase().includes(searchText.trim().toLowerCase());
      });
      if (!matches.length) { main.replaceChildren(tag('p', t('empty'), 'empty')); return; }
      const first = matches.find(row => row.id === selected) || matches[0];
      const list = tag('div', '', 'smr-list');
      for (const row of matches) {
        const title = report ? t(row.targetType) + ' · ' + t(row.status) : t('photo') + ' · ' + t(row.moderationStatus);
        const item = button('', () => { selected = row.id; cases(main, true); }, 'smr-item');
        item.append(tag('strong', title), tag('span', report ? (row.overdue ? t('overdue') + ' · ' : '') + (row.reason || '') : date(row.createdAt)));
        item.setAttribute('aria-pressed', String(row.id === first.id));
        list.append(item);
      }
      const panel = tag('article', '', 'smr-case');
      panel.append(tag('h3', report ? t(first.targetType) + ' · ' + t(first.status) : t('photo') + ' · ' + t(first.moderationStatus)));
      if (report && first.dueAt) panel.append(tag('p', t('deadline') + ' · ' + date(first.dueAt), 'muted'));
      if (first.image) {
        const img = tag('img');
        img.alt = t('photo');
        img.referrerPolicy = 'no-referrer';
        img.src = first.image;
        panel.append(img);
      }
      for (const value of report ? [first.reason, first.details, first.targetSummary, first.moderatorNote]
        : [first.description, first.sensitiveReason, first.autoModerationReason, first.reviewerNote]) {
        if (typeof value === 'string' && value) panel.append(tag('p', value));
      }
      if (!report && first.appeal) panel.append(tag('h4', t('appeal') + ' · ' + t(first.appeal.status)), tag('p', first.appeal.message));

      const decisions = [];
      if (report && ['open', 'reviewing'].includes(first.status)) {
        if (first.status === 'open') decisions.push(['start', 'mark_reviewing']);
        decisions.push(['dismiss', 'dismiss'], ['remove', 'remove', true], ['ban', 'remove_and_ban', true]);
      }
      if (!report && first.moderationStatus === 'pending' && !first.hiddenAt) decisions.push(['approve', 'approve'], ['reject', 'reject', true]);
      if (!report && first.moderationStatus === 'approved' && !first.hiddenAt) decisions.push(['hide', 'hide', true]);
      if (!report && first.appeal && ['open', 'reviewing'].includes(first.appeal.status)) {
        decisions.push(['allowAppeal', 'approve', true, first.appeal.id], ['denyAppeal', 'reject', true, first.appeal.id]);
      }
      if (decisions.length) {
        const label = tag('label', t('note'));
        const note = tag('textarea');
        note.maxLength = report || decisions.every(item => item[3]) ? 500 : 200;
        note.rows = 3;
        label.append(note);
        const actions = tag('div', '', 'smr-tools');
        for (const [labelKey, action, required, appealId] of decisions) {
          const control = button(labelKey, async () => {
            if (busy) return;
            const message = note.value.trim();
            if (required && !message) { status.textContent = t('reasonRequired'); note.focus(); return; }
            if (!window.confirm(t('confirm') + ' · ' + t(labelKey) + '？')) return;
            busy = true;
            status.textContent = t('saving');
            const path = (appealId ? 'appeals/' + appealId : kind + '/' + first.id) + '/decision';
            try {
              await request(path, { action, note: message });
              if (!dead) await load('updated');
            } catch (error) {
              if (!dead && !accessError(error)) await load('verifyState');
            } finally { busy = false; }
          }, actions.children.length === 0 ? 'btn is-primary' : 'btn');
          actions.append(control);
        }
        panel.append(label, actions);
      }
      main.className = 'smr-grid';
      main.replaceChildren(list, panel);
    }

    fold.ontoggle = () => {
      if (!fold.open) {
        clearTimeout(timer);
        read?.abort();
        rows = [];
        selected = null;
        content.replaceChildren();
        status.textContent = '';
      } else if (token) void load();
      else lock();
    };
    return () => { dead = true; clearTimeout(timer); read?.abort(); token = ''; };
  }
  window.HubStrayMapReview = { mount };
})();
