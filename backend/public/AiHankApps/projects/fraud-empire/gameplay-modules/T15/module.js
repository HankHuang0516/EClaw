/* global document */
(function (root) {
  'use strict';
  const owners = new WeakMap();
  const words = { box: '音樂盒', shell: '展示外殼', gear: '阿岑的玩具齒片', sleeve: '外套', pad: '紙墊', board: '固定展示板', package: '原盒', repair: '維修格', display: '展示物格', storage: '外殼收納格', packed: '已放回原盒', repairedRack: '修復完成架', returnRack: '退回架', accept: '陶安收下（由整合者提供的故事狀態）', decline: '陶安婉拒（不是操作失敗）', unknown: '前章狀態未提供：後續尚待整合，不冒稱陶安收下' };
  function mount(container, options = {}) {
    if (!container || owners.has(container)) throw new Error('T15 container already mounted or missing');
    const model = root.FraudT15Model;
    let round = 0, seq = 0, mounted = true, menu = false, emitted = false, notice = '';
    let session = options.session || root.crypto.randomUUID();
    let state = model.create(session, options.recipient || 'unknown');
    if (Object.prototype.hasOwnProperty.call(options, 'privateCheckpoint')) {
      const restored = globalThis.FraudPrivateModuleSave.checkpointState('T15', options.privateCheckpoint, state);
      state = restored.state;
      session = restored.controller.baseSession;
      round = restored.controller.round;
      seq = restored.controller.seq;
      menu = true;
      emitted = Boolean(state.result);
    }
    const host = document.createElement('section'); container.append(host);
    const view = host.attachShadow({ mode: 'open' });
    const t = (key, fallback) => options.translate?.(key, fallback) || fallback;
    function node(tag, text) { const n = document.createElement(tag); if (text) n.textContent = text; return n; }
    function button(label, handler, key) { const n = node('button', t(key || label, label)); n.type = 'button'; n.dataset.action = key || label; n.onclick = handler; view.append(n); }
    function send(type, payload = {}, origin = { session: state.session, revision: state.revision }) {
      if (!mounted) return;
      const out = model.apply(state, { ...payload, type, session: origin.session, revision: origin.revision, id: state.session + ':' + (++seq) });
      state = out.state; notice = out.accepted ? '操作已記錄；僅本次預覽。' : '操作未成立：請依覆蓋順序、選取物件與目標格操作；沒有扣資源。';
      render();
      if (state.result && !emitted) { emitted = true; options.onResult?.(model.clone(state.result)); }
    }
    function render() {
      const focus = view.activeElement?.dataset.action;
      view.replaceChildren();
      const style = node('style', ':host{display:block;font:16px/1.6 system-ui;color:#302b26;background:#f5efe4;padding:16px;max-width:650px;margin:auto}button{min-height:48px;margin:5px;padding:10px;border:1px solid #746555;border-radius:7px;background:#fffaf0;color:#302b26;font:inherit}button:focus-visible{outline:3px solid #976b31}p{white-space:pre-line}'); view.append(style);
      view.append(node('h1', t('title', 'T15 假禮物包裹｜MG-P14 提案')),
        node('p', t('notice', '可操作規則示意，非完成美術。拆殼、缺齒、試音與退回分鏡缺 golden；此頁不使用舊圖冒充新狀態，不發正式獎勵、不寫存檔。')));
      const status = node('p', notice); status.setAttribute('role', 'status'); view.append(status);
      button(menu ? '返回操作' : '閱讀／選單（停表）', () => { menu = !menu; send(menu ? 'pause' : 'resume'); }, 'menu');
      button('返回整合頁', () => { send('pause'); options.onExit?.(model.clone(state)); }, 'exit');
      if (menu) {
        view.append(node('p', '先放宣傳照片，依外套→紙墊→展示板拆開。選物件後點目的格；實物與外殼分開。修復須裝齒、試音、裝盒；退回須固定實物、收殼、封夾。拒收不是失敗。'));
        button('重設本次預覽', () => { state = model.create(session + ':reset-' + (++round), state.recipient); menu = false; emitted = false; notice = '已建立新預覽；舊按鈕與結果不再使用。'; render(); }, 'reset');
      } else {
        view.append(node('p', '覆蓋層：' + (state.layers.map(x => words[x]).join(' → ') || '已拆完') + '\n實物：' + words[state.box] + '；外殼：' + (words[state.shell] || '手邊') + '\n已選：' + (words[state.selected] || '無') + '；分支：' + (state.branch || '未選')));
        if (state.result) view.append(node('p', '操作預覽完成，正式獎勵 0。' + words[state.recipient] + '。修復不代表退款或兌現假豪華承諾。'));
        else {
          const origin = { session: state.session, revision: state.revision };
          const action = (label, type, payload) => button(label, () => send(type, payload, origin), type + ':' + JSON.stringify(payload || {}));
          if (!state.photo) action('把宣傳照片放盒旁', 'photo');
          if (state.layers.length) for (const item of ['sleeve', 'pad', 'board']) action('取下' + words[item], 'remove', { item });
          for (const item of ['box', 'shell', 'gear']) action('選取' + words[item], 'select', { item });
          for (const target of ['repair', 'display', 'box', 'package', 'storage', 'repairedRack', 'returnRack']) action('放到' + words[target], 'place', { target });
          if (!state.inspected) action('轉把手，查看缺齒與停住旋律（示意）', 'inspect');
          if (!state.branch) { action('選修復', 'choose', { branch: 'repair' }); action('選退回', 'choose', { branch: 'return' }); }
          if (state.branch === 'repair') { action('拆回齒片', 'removeGear'); action('轉一圈試音（狀態示意，缺音訊）', 'test'); }
          if (state.branch === 'return') { action('固定原盒內實物', 'fix'); action('蓋退回庫房夾', 'clip'); }
          if (['repairedRack', 'returnRack'].includes(state.box)) { view.append(node('p', words[state.recipient])); action('確認人物後果／待補狀態', 'acknowledge'); action('結束操作預覽', 'finish'); }
        }
      }
      [...view.querySelectorAll('button')].find(n => n.dataset.action === focus)?.focus();
    }
    const api = { getState: () => model.clone(state),
      getPrivateCheckpoint: () => globalThis.FraudPrivateModuleSave.makeCheckpoint('T15', model.clone(state), { baseSession: session, round, seq }),
      unmount() { if (!mounted) return; state = { ...state, paused: true }; mounted = false; host.remove(); owners.delete(container); },
      remount(target = container) { if (mounted || owners.has(target)) throw new Error('container occupied'); container = target; mounted = true; container.append(host); owners.set(container, api); menu = true; render(); },
      resume() { if (mounted) { menu = false; send('resume'); } },
      advanceActiveTime(ms) { if (!mounted || menu) return; state = model.advanceActiveTime(state, ms); } };
    owners.set(container, api); render(); return api;
  }
  root.FraudT15 = { mount };
})(globalThis);
