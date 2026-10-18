(function (root) {
  'use strict';
  const M = root.FraudT11Model;
  const owners = new WeakMap();
  const text = {
    title: 'T11 假中獎｜舊版 v4 提案試玩',
    notice: '本頁為舊七步流程的操作原型，並非 MG-P10 新版旋轉拆殼玩法。數值與對話待確認；正式獎勵 0，不寫正式存檔。美術僅為來源參考，UI 尚未通過 golden 驗收。',
    start: '開始／繼續操作', pause: '閱讀／選單（停表）', reset: '重設本輪', resetConfirm: '確認放棄並重設', resetCancel: '取消重設', exit: '提前交班（部分完成）',
    accept: '接案：銀河周年祭', model: '星圖模型', music: '音樂盒',
    zheng: '鄭伯：想要星圖模型', qian: '芊芊：想要音樂盒', luo: '羅森：只接受缺貨舊徽章',
    undoZheng: '撤回鄭伯分配', undoQian: '撤回芊芊分配', confirm: '確認兩件分配',
    find: '找替代紀念章', cancel: '公開取消第三份', outline: '檢查照片背面輪廓', collect: '登記代取唯一紀念章',
    keep: '保留音樂盒至遊戲日末', return: '收回音樂盒', handoff: '核對明細並單次交班', back: '返回調整保留',
    arrived: '預覽日末：芊芊到場', absent: '預覽日末：芊芊未到',
    badge: '替代紀念章', pending: '待處理', delivered: '已交付', reserved: '保留', cancelled: '取消／未領',
    art: '來源示意圖（非互動畫面／非 golden）', newer: '查看 MG-P10 新候選與缺圖說明', closeNewer: '返回舊版操作',
    newerText: 'MG-P10 尚待確認：在 M05 展示區旋轉獎品、拆空殼、對應重複展示與缺貨。現有舊圖不表示新版已實作。缺專用正面／背面／拆殼／空輪廓 golden，未借用舊圖冒充新版。可返回繼續舊版預覽。',
    steps: ['名單：3人、2件實物、缺額1。成年虛構角色，無領獎費。', '先選道具再選人物；不合願望消耗1個容錯格，容錯耗盡轉部分完成。', '選找替代物或公開取消。舊提案缺額時段5分鐘，尚未批准。', '點年份、檢查背面、登記代取。羅森來自第七年；錯誤允許2次，超出轉取消。', '芊芊臨時退出，只有1個保留格。保留或收回均留下後果，不加報酬。', '核對交付／保留／取消，三人均留下真實結果。可返回改保留決定。', '結案僅一次。日末到場／未到事件來源未定，本頁讓你明確選擇預覽，不抽籤、不影響正式故事。']
  };
  function mount(container, options = {}) {
    if (!container || owners.has(container)) throw new Error('T11 container missing or already mounted');
    const doc = container.ownerDocument;
    let sequence = 0, active = true, mounted = true, resetPending = false, newer = false;
    let state = M.create(options.session || root.crypto.randomUUID());
    let notice = '', emitted = null, last = null;
    if (Object.prototype.hasOwnProperty.call(options, 'privateCheckpoint')) {
      const restored = globalThis.FraudPrivateModuleSave.checkpointState('T11', options.privateCheckpoint, state);
      state = restored.state;
      sequence = restored.controller.sequence;
      emitted = state.result ? state.result.id : null;
    }
    const section = doc.createElement('section'); section.className = 'fraud-t11'; container.append(section);
    const t = key => options.translate?.(key, text[key]) || text[key];
    const running = () => mounted && active && !doc.hidden && !state.paused && !state.result;
    function advanceClock(now, visibleUntilNow = false) {
      if (!mounted || !active || state.paused || state.result || (doc.hidden && !visibleUntilNow)) { last = null; return false; }
      if (last === null) { last = now; return false; }
      const ms = Math.max(0, now - last); last = now;
      if (!ms) return false;
      const out = M.apply(state, { type: 'tick', ms, id: state.session + ':' + (++sequence), session: state.session, revision: state.revision });
      if (out.accepted) state = out.state;
      return out.accepted;
    }
    function publish() {
      if (state.result && emitted !== state.result.id) { emitted = state.result.id; options.onResult?.(JSON.parse(JSON.stringify(state.result))); }
      render(); options.onState?.(getState());
    }
    function send(type, payload = {}, revision = state.revision) {
      if (!mounted || !active) return;
      if (revision !== state.revision) {
        const stale = M.apply(state, { ...payload, type, id: state.session + ':' + (++sequence), session: state.session, revision });
        notice = stale.message; publish(); return JSON.parse(JSON.stringify(stale));
      }
      const now = root.performance.now();
      // Validate the original UI revision before charging its preceding active interval.
      if (type !== 'tick') advanceClock(now);
      const result = M.apply(state, { ...payload, type, id: state.session + ':' + (++sequence), session: state.session, revision: state.revision });
      state = result.state; notice = result.message;
      last = running() ? now : null;
      publish(); return JSON.parse(JSON.stringify(result));
    }
    function node(tag, content) { const el = doc.createElement(tag); if (content !== undefined) el.textContent = content; return el; }
    function button(label, handler) { const b = node('button', label); b.type = 'button'; b.onclick = handler; section.append(b); return b; }
    function action(key, type, payload = {}) { const revision = state.revision; return button(t(key), () => send(type, payload, revision)); }
    function render() {
      const focused = section.contains(doc.activeElement) ? doc.activeElement.textContent : null;
      section.replaceChildren(); section.append(node('h1', t('title')), node('p', t('notice')));
      const status = node('p', notice); status.setAttribute('role', 'status'); section.append(status);
      section.append(node('p', '步驟 ' + state.step + '/7 · 操作時間 ' + (state.elapsedMs / 60000).toFixed(2) + ' 遊戲分鐘 · ' + (state.paused ? '已停表' : '1真實分鐘＝1遊戲分鐘')));
      if (newer) { section.append(node('p', t('newerText'))); button(t('closeNewer'), () => { newer = false; render(); }); return; }
      if (resetPending) {
        button(t('resetConfirm'), () => { state = M.create(root.crypto.randomUUID()); emitted = null; resetPending = false; notice = ''; last = null; render(); });
        button(t('resetCancel'), () => { resetPending = false; render(); }); return;
      }
      button(t('newer'), () => { send('pause'); newer = true; render(); });
      action(state.paused ? 'start' : 'pause', state.paused ? 'resume' : 'pause');
      button(t('reset'), () => { send('pause'); resetPending = true; render(); });
      section.append(node('h2', t('steps')[state.step - 1]));
      if (!state.result) action('exit', 'exit');
      if (state.step === 1) action('accept', 'accept');
      if (state.step === 2) {
        ['model', 'music'].forEach(item => action(item, 'select', { item }));
        section.append(node('p', '已選：' + (state.selected ? t(state.selected) : '無')));
        ['zheng', 'qian', 'luo'].forEach(person => action(person, 'place', { person }));
        action('undoZheng', 'undo', { person: 'zheng' }); action('undoQian', 'undo', { person: 'qian' }); action('confirm', 'confirm');
      }
      if (state.step === 3) { action('find', 'branch', { choice: 'find' }); action('cancel', 'branch', { choice: 'cancel' }); }
      if (state.step === 4) {
        if (state.branch === 'find') {
          [6, 7, 8].forEach(year => { const rev = state.revision; button('第' + year + '年', () => send('year', { year }, rev)); });
          section.append(node('p', '檔案年份：' + (state.year || '未選') + ' · 輪廓：' + (state.outline ? '紀念章已找到' : '未找到') + ' · 誤查：' + state.wrongYears));
          action('outline', 'outline'); action('collect', 'collect');
        }
        action('cancel', 'cancel');
      }
      if ([5, 6].includes(state.step)) { action('keep', 'withdraw', { choice: 'keep' }); action('return', 'withdraw', { choice: 'return' }); }
      const list = node('ul');
      ['zheng', 'qian', 'luo'].forEach(person => list.append(node('li', t(person) + '：' + (state.result ? t(state.result.people[person]) : state.assignments[person] ? t(state.assignments[person]) || state.assignments[person] : t('pending')))));
      section.append(list);
      if (state.step === 6) { action('back', 'back'); action('handoff', 'handoff'); }
      if (state.result) {
        section.append(node('p', '結果：' + state.result.status + '；交付 ' + state.result.delivered + '／保留 ' + state.result.reserved + '／取消 ' + state.result.cancelled + '。羅森取消留下空獎位；芊芊未保留留下未領紀錄。獎勵 0。'));
        if (!state.followup) { action('arrived', 'followup', { event: 'arrived' }); action('absent', 'followup', { event: 'absent' }); }
        else section.append(node('p', '日末已封存：' + state.followup + '。保留格已釋放，不再次結算。'));
      }
      const details = node('details'); details.append(node('summary', t('art')));
      const img = node('img'); img.src = (options.assetBase || '../../') + 'images/' + ['ba7ae8c55b248a047a20','3d6395289cb17bab2a5f','e6d13ad0726cff7c0c59','d0aeed900eaf04c999d5','b79955f81521f55c9d00','6dedb01a43ea618b4135','4a85ecb1e629c3de78e3'][state.step - 1] + '.webp'; img.alt = t('art'); details.append(img);
      if (focused) [...section.querySelectorAll('button')].find(b => b.textContent === focused)?.focus({ preventScroll: true });
      details.addEventListener('toggle', () => { if (details.open && !state.paused) send('pause'); }); section.append(details);
    }
    function getState() { return JSON.parse(JSON.stringify(state)); }
    const interval = root.setInterval(() => {
      if (advanceClock(root.performance.now())) publish();
    }, 1000);
    const visibility = () => {
      if (doc.hidden && active) { advanceClock(root.performance.now(), true); send('pause'); }
      last = null;
    };
    doc.addEventListener('visibilitychange', visibility);
    const api = { getState, dispatch: send,
      getPrivateCheckpoint() {
        if (advanceClock(root.performance.now())) publish();
        return globalThis.FraudPrivateModuleSave.makeCheckpoint('T11', getState(), { sequence });
      },
      suspend() { if (active) send('pause'); active = false; last = null; section.hidden = true; },
      resume() { if (!mounted) return; active = true; last = null; section.hidden = false; render(); },
      unmount() { if (!mounted) return getState(); if (advanceClock(root.performance.now())) publish(); state = { ...state, paused: true }; mounted = false; active = false; root.clearInterval(interval); doc.removeEventListener('visibilitychange', visibility); section.remove(); owners.delete(container); return getState(); }
    };
    owners.set(container, api); render(); return api;
  }
  root.FraudT11 = { mount };
})(globalThis);
