((root) => {
  'use strict';
  const model = root.FraudT07Model;
  let sequence = 0;
  function create(options = {}) {
    const newSession = () => 'T07-' + (++sequence) + '-' + (root.crypto?.randomUUID?.() || Date.now());
    let state = model.create(newSession()), host = null, panel = null, notice = '', resetPending = false, renderVersion = 0;
    if (Object.prototype.hasOwnProperty.call(options, 'privateCheckpoint')) {
      const restored = globalThis.FraudPrivateModuleSave.checkpointState('T07', options.privateCheckpoint, state);
      state = restored.state;
    }
    const snapshot = () => model.copy(state);
    function send(type, payload = {}, revision = state.revision) {
      if (!panel) return { accepted: false, message: 'unmounted' };
      const before = state.result;
      const out = model.apply(state, { ...payload, type, session: state.session, revision });
      state = out.state; notice = out.message;
      if (!out.accepted && type === 'output' && state.slots.some(value => value === null)) {
        const expected = state.tape.length === 0 ? ['morning', 'noon'] : state.tape.length === 2 ? ['noon', 'evening'] : null;
        if (expected) {
          const empty = state.slots.map((value, index) => value === null ? index + 1 : null).filter(Boolean);
          const names = { morning: '晨間待記', noon: '午間已記', evening: '晚間沖回' };
          const wrong = state.slots.map((id, index) => id && !expected.includes(id) ? '工作窗 ' + (index + 1) + ' 的' + names[id] : null).filter(Boolean);
          const correct = wrong.length ? '先取回' + wrong.join('、') + '，再選' : '先選';
          notice = '工作窗 ' + empty.join('、') + ' 尚未放入快照，不能輸出。' + correct + expected.filter(id => !state.slots.includes(id)).map(id => names[id]).join('、') + '，再點空工作窗；兩態齊備後再輸出。不扣時間或資源。';
        }
      }
      render();
      const result = !before && state.result ? model.copy(state.result) : null;
      const updated = snapshot();
      if (out.accepted) options.onState?.(updated);
      if (result) options.onResult?.(result);
      return { accepted: out.accepted, message: out.message };
    }
    function node(tag, text) { const n = host.ownerDocument.createElement(tag); if (text !== undefined) n.textContent = text; return n; }
    function button(label, action, key) {
      const n = node('button', label); n.type = 'button'; n.dataset.action = key; const version = renderVersion; n.addEventListener('click', () => { if (panel && version === renderVersion) action(); }); return n;
    }
    function render() {
      if (!panel) return;
      renderVersion += 1;
      const focused = host.ownerDocument.activeElement?.dataset.action;
      panel.replaceChildren();
      panel.append(node('h1', '金融異常｜三態終端輪轉'));
      panel.append(node('p', 'T07／MG-P06 v2 可操作提案｜規則未定案・golden 未交付・美術 UI 未驗收'));
      panel.append(node('p', '僅成年虛構故事。全程預覽停表；新版工作分鐘未定，無正式分數、獎勵或存檔。'));
      const nav = node('nav');
      for (const [view, label] of [['work', '操作頁'], ['help', '操作說明'], ['menu', '返回／選單']]) nav.append(button(label, () => send('view', { view }), view));
      panel.append(nav);
      if (state.view === 'help') panel.append(node('p', '點快照，再點空工作窗。先放晨間與午間並輸出，晨間釋槽、午間保留；再放晚間並輸出。結果帶三態齊全後，關閉本件。錯接可取回未輸出的快照；結果帶不是第三個工作窗。'));
      if (state.view === 'menu') {
        panel.append(node('p', '返回操作頁可繼續同一局。離開後由整合者保留本控制器，再 mount 可續玩；未寫入儲存。'));
        panel.append(button('離開預覽', () => { const saved = snapshot(); unmount(); options.onExit?.(saved); }, 'exit'));
      }
      if (state.view === 'work') {
        panel.append(node('h2', state.closed ? '已完成匣' : state.tape.length === 0 ? '目標：輸出待記→已記' : state.tape.length === 2 ? '目標：接入沖回並輸出' : '目標：關閉本件'));
        const rev = state.revision;
        const source = node('section'); source.setAttribute('aria-label', '來源快照');
        for (const [id, label] of Object.entries(model.snapshots)) {
          const b = button(label, () => send('select', { snapshot: id }, rev), id);
          b.setAttribute('aria-pressed', String(state.selected === id)); b.disabled = state.closed || state.slots.includes(id) || state.tape.includes(id); source.append(b);
        }
        source.append(button('取消選取', () => send('cancel'), 'cancel')); panel.append(source);
        const windows = node('section'); windows.className = 't07-windows';
        state.slots.forEach((id, slot) => {
          const window = node('section'); window.append(node('h3', '工作窗 ' + (slot + 1)), node('p', id ? model.snapshots[id] : '空窗'));
          window.append(button('放入此窗', () => send('place', { slot }, rev), 'place-' + slot), button('取回', () => send('remove', { slot }, rev), 'remove-' + slot)); windows.append(window);
        }); panel.append(windows);
        panel.append(button('輸出這一段', () => send('output', {}, rev), 'output'), button('關閉本件', () => send('close', {}, rev), 'close'));
        panel.append(node('h2', '唯一結果帶（唯讀）'), node('p', state.tape.map(id => model.snapshots[id]).join(' → ') || '尚未輸出'));
        if (state.result) panel.append(node('p', state.result.consequence), node('p', '故事淨變動0；正式獎勵0。'));
      }
      panel.append(button('重設此提案', () => { resetPending = true; render(); }, 'reset'));
      if (resetPending) {
        panel.append(node('p', '重設將清除本次預覽，另開新局。'));
        panel.append(button('確認重設', () => { state = model.create(newSession()); resetPending = false; notice = '已開新預覽局。'; render(); options.onState?.(snapshot()); }, 'confirm-reset'));
        panel.append(button('取消重設', () => { resetPending = false; render(); }, 'cancel-reset'));
      }
      const feedback = node('p', notice || '先點快照，再點目的窗；可用鍵盤 Tab 與 Enter 操作。'); feedback.setAttribute('role', 'status'); panel.append(feedback);
      if (focused) [...panel.querySelectorAll('button')].find(n => n.dataset.action === focused)?.focus({ preventScroll: true });
    }
    function unmount() { renderVersion += 1; panel?.remove(); panel = null; host = null; resetPending = false; }
    function mount(target) {
      if (!target?.ownerDocument) throw new TypeError('DOM container required');
      unmount(); host = target; panel = node('section'); panel.className = 'fraud-t07'; host.append(panel); render();
      return api;
    }
    const api = { mount, unmount, getState: snapshot, dispatch: send,
      getPrivateCheckpoint: () => globalThis.FraudPrivateModuleSave.makeCheckpoint('T07', snapshot(), {}) };
    return api;
  }
  root.FraudT07 = { create };
})(globalThis);
