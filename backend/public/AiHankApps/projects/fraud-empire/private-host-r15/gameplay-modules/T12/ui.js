(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./model.js'));
  else root.FraudT12 = factory(root.FraudT12Model);
})(globalThis, function (model) {
  'use strict';
  const owners = new WeakMap();
  const zh = {
    title: '假投資｜只有正面的建案', notice: 'MG-P11 提案操作驗證・非正式玩法。缺少核准 golden 與可操作分層美術，本頁不是完成遊戲畫面。',
    balance: '新規則與零件配置待確認；獎勵 0、不寫正式存檔。閱讀、選單與逐格操作停表；本版無核准分鐘，不推進全局時間。',
    goal: '目標：拼合固定正面 → 查看剖面兩個未完工處 → 保留三人後果 → 單次交班。完成外牆不代表建案能交付。',
    fixture: '操作提案用兩件「門／窗」及兩種方向驗證規則；數量、形狀與轉角尚待正式美術及規格確認。',
    start: '進入操作驗證', menu: '選單／停表', back: '返回操作', reset: '重設此預覽', confirm: '確認重設（清除本局）', cancelReset: '取消重設',
    resetNote: '重設只清除此實例的預覽，沒有正式獎勵或存檔。',
    expectations: '三人的固定專案期待（文字示意）', xu: '徐禾', du: '杜樹', bai: '白露',
    expectation: '查看期待', xuExpectation: '徐禾期待專案真正完成；現在只有展示模型。', duExpectation: '杜樹期待交付；模型內部仍空著。', baiExpectation: '白露尚未啟用，查看模型不代表加入或付款。',
    tray: '固定零件', door: '門立面', window: '窗立面', select: '選取', slot: '放入對應位置', rotate: '旋轉方向', remove: '拆回', cancel: '取消選取',
    placed: '已放入', empty: '空位', aligned: '門窗連續', seam: '接縫未對齊',
    section: '拉開剖面', exterior: '外觀：展示正面完整', machine: '機房：沒有設備支撐', delivery: '交付區：沒有可交付實體', mark: '壓上「已完工」卡核對', unmark: '撤回標記',
    unsupported: '展示卡懸空：已記錄未完工，沒有把內部建成。',
    withSection: '原樣交回模型並附剖面', stopDisplay: '先停本輪展示', choiceNote: '兩條提案分支都保留未完工事實；停止展示不是投資失敗。',
    followup: '保留人物後果', xuFollowup: '徐禾的期待仍未兌現。', duFollowup: '杜樹的失望沒有因正面拼好而消失。', baiFollowup: '白露保持未啟用，不產生收益。',
    handoff: '交班一次', result: '提案操作完成；正式獎勵 0，沒有正式入帳。',
    accepted: '操作已記錄。', stale: '過期或重複操作已忽略。', invalid: '此狀態不能執行這項操作。', paused: '閱讀／選單停表，請先返回操作。', sealed: '已交班，只能回看；重玩請重設。', emptyAction: '尚未選取零件。', wrongSlot: '位置不符或沒有選取零件，原狀保留。', notAssembled: '請先放齊零件並旋轉至門窗連續。', wrongMark: '外觀不是未完工處，或此處已記錄；請核對機房及交付區。', missing: '尚有工序、期待或人物後果未完成。',
    selected: '目前選取：', none: '無', progress: '已保留人物後果：'
  };
  function mount(container, options = {}) {
    if (!container || !container.ownerDocument || owners.has(container)) throw new TypeError('fresh container required');
    const document = container.ownerDocument;
    const t = key => options.t?.(key, zh[key]) || zh[key] || key;
    const freshSession = () => globalThis.crypto.randomUUID();
    let commands = options.snapshot ? model.copy(options.snapshot.commands) : [];
    let state = options.snapshot ? model.restore(options.snapshot) : model.create(options.session || freshSession());
    let mounted = true, sequence = commands.reduce((max, c) => Math.max(max, Number(c.id.split(':').pop()) || 0), 0), pendingReset = false, message = '', delivered = Boolean(state.result);
    const panel = document.createElement('section'); panel.className = 'fraud-t12'; container.append(panel);
    function node(tag, key, parent = panel) { const n = document.createElement(tag); n.textContent = t(key); n.dataset.i18n = 't12.' + key; parent.append(n); return n; }
    function button(key, action, parent = panel, disabled = false, focusKey = key) {
      const n = node('button', key, parent); n.type = 'button'; n.disabled = disabled; n.dataset.focus = focusKey;
      n.addEventListener('click', action); return n;
    }
    function dispatch(type, payload = {}) {
      if (!mounted) return { accepted: false, code: 'unmounted' };
      const command = model.copy({ ...payload, type, session: state.session, revision: state.revision, id: state.session + ':' + (++sequence) });
      const out = model.apply(state, command);
      if (out.accepted) { state = out.state; commands.push(command); }
      message = t(out.code === 'empty' ? 'emptyAction' : out.code); render();
      const result = state.result && !delivered ? model.copy(state.result) : null;
      if (result) delivered = true;
      options.onState?.(model.copy(state));
      if (result) options.onResult?.(result);
      return model.copy(out);
    }
    function render() {
      const focus = panel.contains(document.activeElement) ? document.activeElement.dataset.focus : null;
      panel.replaceChildren(); node('h2', 'title'); node('p', 'notice'); node('p', 'balance'); node('p', 'goal');
      const status = document.createElement('p'); status.setAttribute('role', 'status'); status.textContent = message; panel.append(status);
      if (state.view === 'intro') button('start', () => dispatch('view', { view: 'work' }));
      else if (state.view === 'menu') {
        button('back', () => { pendingReset = false; dispatch('view', { view: 'work' }); });
        button('reset', () => { pendingReset = true; render(); });
        if (pendingReset) {
          node('p', 'resetNote');
          button('confirm', () => { state = model.create(freshSession()); commands = []; sequence = 0; delivered = false; pendingReset = false; message = ''; render(); options.onState?.(model.copy(state)); });
          button('cancelReset', () => { pendingReset = false; render(); });
        }
      } else {
        button('menu', () => dispatch('view', { view: 'menu' })); node('p', 'fixture');
        node('h3', 'expectations');
        for (const person of ['xu', 'du', 'bai']) {
          const row = node('div', person);
          button('expectation', () => dispatch('expectation', { person }), row, state.expectations.includes(person) || Boolean(state.result), 'expectation-' + person);
          if (state.expectations.includes(person)) node('p', person + 'Expectation', row);
        }
        node('h3', 'tray'); const selection = node('p', 'selected'); selection.append(t(state.selected || 'none'));
        for (const piece of ['door', 'window']) {
          const row = node('div', piece); const locked = Boolean(state.choice || state.result);
          node('p', state.placements[piece] ? 'placed' : 'empty', row);
          if (state.placements[piece]) node('p', state.rotations[piece] ? 'aligned' : 'seam', row);
          button('select', () => dispatch('select', { piece }), row, locked || Boolean(state.placements[piece]), 'select-' + piece);
          button('slot', () => dispatch('place', { slot: piece }), row, locked, 'slot-' + piece);
          button('rotate', () => dispatch('rotate', { piece }), row, locked || !state.placements[piece], 'rotate-' + piece);
          button('remove', () => dispatch('remove', { piece }), row, locked || !state.placements[piece], 'remove-' + piece);
        }
        button('cancel', () => dispatch('cancel'), panel, !state.selected);
        button('section', () => dispatch('openSection'), panel, Boolean(state.choice || state.result || state.sectionOpen));
        if (state.sectionOpen) for (const zone of ['exterior', 'machine', 'delivery']) {
          const row = node('div', zone);
          button('mark', () => dispatch('mark', { zone }), row, Boolean(state.choice || state.result || state.marks.includes(zone)), 'mark-' + zone);
          if (state.marks.includes(zone)) { node('p', 'unsupported', row); button('unmark', () => dispatch('unmark', { zone }), row, Boolean(state.choice || state.result), 'unmark-' + zone); }
        }
        node('p', 'choiceNote');
        for (const choice of ['withSection', 'stopDisplay']) button(choice, () => dispatch('choose', { choice }), panel, !model.ready(state) || Boolean(state.choice));
        if (state.choice) {
          node('p', state.choice);
          for (const person of ['xu', 'du', 'bai']) {
            const row = node('div', person);
            button('followup', () => dispatch('followup', { person }), row, state.followups.includes(person), 'followup-' + person);
            if (state.followups.includes(person)) node('p', person + 'Followup', row);
          }
        }
        const progress = node('p', 'progress'); progress.append(state.followups.length + '/3');
        button('handoff', () => dispatch('handoff'), panel, Boolean(state.result));
        if (state.result) node('p', 'result');
      }
      if (focus) [...panel.querySelectorAll('button')].find(n => n.dataset.focus === focus && !n.disabled)?.focus();
    }
    const api = { dispatch, getState: () => model.copy(state),
      getSnapshot: () => ({ version: 1, session: state.session, commands: model.copy(commands) }),
      unmount() { if (!mounted) return; mounted = false; panel.remove(); owners.delete(container); } };
    owners.set(container, api); render(); return api;
  }
  return { mount };
});
