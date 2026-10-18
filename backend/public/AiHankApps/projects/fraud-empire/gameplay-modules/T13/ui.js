(function (root) {
  'use strict';
  function mount(container, options = {}) {
    const model = root.FraudT13Model;
    let state = model.create(options), host = null, last = null, timer = null, notifiedRun = null;
    if (Object.prototype.hasOwnProperty.call(options, 'privateCheckpoint')) {
      const restored = globalThis.FraudPrivateModuleSave.checkpointState('T13', options.privateCheckpoint, state);
      state = restored.state;
      notifiedRun = state.result ? state.run : null;
    }
    const labels = { previous: '上一幕道具', rain: '雨景片', record: '舊唱片', blank: '空白收場片' };
    function flush() {
      if (!host) return;
      const now = root.performance.now();
      if (last !== null && state.view === 'play' && !state.result) state = model.apply(state, { type: 'tick', seconds: (now - last) / 1000, run: state.run, revision: state.revision }).state;
      last = host.ownerDocument.hidden ? null : now;
    }
    function visibility() { flush(); }
    function dispatch(action) {
      flush();
      const result = model.apply(state, { ...action, run: state.run, revision: state.revision });
      state = result.state;
      render(result.message);
      if (state.result && notifiedRun !== state.run) {
        notifiedRun = state.run;
        if (options.onResult) options.onResult(model.copy(state.result));
      }
      return result.accepted;
    }
    function render(message = state.message) {
      if (!host) return;
      const focus = host.ownerDocument.activeElement?.dataset?.key;
      host.replaceChildren();
      const el = (tag, text) => { const n = host.ownerDocument.createElement(tag); n.textContent = text; return n; };
      const button = (text, key, action) => {
        const b = el('button', text); b.type = 'button'; b.dataset.key = key;
        b.addEventListener('click', () => dispatch(action)); host.append(b); return b;
      };
      host.append(el('h2', '假交友｜翻面角色台・提案操作預覽'));
      host.append(el('p', '美術未完成：缺 MG-P12 正面、背面、雨天幕、收場幕及歸槽狀態 golden。此為文字操作驗證，不是遊戲畫面驗收。'));
      host.append(el('p', state.prerequisiteMet ? '已提供前兩章旗標；本頁仍僅示意，不提交正式章節。' : '未提供前兩章紀錄：獨立示意情境，不解鎖第三章、不補造前情。'));
      button('操作說明', 'intro', { type: 'view', view: 'intro' });
      button('進入／返回操作', 'resume', { type: 'view', view: 'play' });
      button('返回選單（暫停）', 'menu', { type: 'view', view: 'menu' });
      button('重設示意', 'reset', { type: 'reset' });
      if (state.view === 'intro') host.append(el('p', '目標：背面收回舊道具，換雨景片與唱片；正面播放固定片段；背面收回兩物並換空白收場片；正面讀拒談；背面全數歸槽並闔上。點物件再點目標即可，無須拖曳。錯放可修正，拒談不是失敗，不提供挽留操作。'));
      if (state.view === 'play') {
        host.append(el('h3', state.side === 'front' ? '正面：固定故事片段' : '背面：道具取放'));
        host.append(el('p', '目前階段：' + ({ setup: '準備雨天幕', closing: '準備收場幕', cleanup: '拒談後收台', result: '示意完成' })[state.phase]));
        host.append(el('p', '操作累計分鐘（1:1）：' + (state.elapsedSeconds / 60).toFixed(2) + '；新工序總成本未定，不套舊案20分鐘。'));
        button('翻到' + (state.side === 'front' ? '背面' : '正面'), 'flip', { type: 'flip' });
        for (const [id, name] of Object.entries(labels)) {
          const b = button(name + '｜' + (state.locations[id] === 'stage' ? '舞台上' : '原槽內'), id, { type: 'select', prop: id });
          b.setAttribute('aria-pressed', String(state.selected === id));
        }
        button('放入舞台', 'stage', { type: 'place', target: 'stage' });
        button('收回所選物件原槽', 'rack', { type: 'place', target: 'rack' });
        button('閱讀本幕固定片段', 'play', { type: 'play' });
        button('所有道具歸槽後闔上', 'close', { type: 'close' });
        if (state.rainViewed) host.append(el('p', '已讀：雨天公車站的舊歌記憶。回看不增加進度。'));
        if (state.refusalViewed) host.append(el('p', '已讀：梁澄今天想停一下。拒談後收台；不強迫恢復關係或收益。'));
      }
      const feedback = el('p', message); feedback.setAttribute('role', 'status'); host.append(feedback);
      if (state.result) host.append(el('p', '結果：提案完成一次。正式分數／XP／培養點皆0，不寫存檔。'));
      if (focus) [...host.querySelectorAll('button')].find(b => b.dataset.key === focus)?.focus({ preventScroll: true });
    }
    function unmount() {
      if (host) { flush(); host.ownerDocument.removeEventListener('visibilitychange', visibility); }
      if (timer !== null) root.clearInterval(timer);
      timer = null; last = null;
      if (host) host.remove(); host = null;
    }
    function attach(target) {
      unmount();
      host = target.ownerDocument.createElement('section'); host.className = 'fraud-t13'; target.append(host); render();
      last = host.ownerDocument.hidden ? null : root.performance.now();
      host.ownerDocument.addEventListener('visibilitychange', visibility);
      timer = root.setInterval(flush, 250);
    }
    attach(container);
    return Object.freeze({ unmount, mount: attach, getState: () => model.copy(state), dispatch,
      getPrivateCheckpoint() {
        const revision = state.revision;
        flush();
        if (state.revision !== revision) render();
        return globalThis.FraudPrivateModuleSave.makeCheckpoint('T13', model.copy(state), {});
      } });
  }
  root.FraudT13 = Object.freeze({ mount });
})(globalThis);
