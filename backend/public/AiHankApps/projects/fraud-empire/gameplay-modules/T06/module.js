/* Independent mount lifecycle. Host retains controller to resume the same run. */
(function (root) {
  'use strict';
  const zh = {
    title: 'T06｜欠費點數', notice: '可操作提案：沿舊版 v4 事件帳，非已批准規則。新版 MG-P05 翻單美術尚缺 golden；本頁不是美術驗收完成品。無正式獎勵或存檔。',
    intro: '成年虛構人物葉冬收到假欠費聲稱。依序選 A、B 加入路徑，再選 C 點 B 撤銷；比較餘額與聲稱後交件。點數不可兌換。',
    start: '開始預覽', A: 'A：增加8', B: 'B：扣除6', C: 'C：撤銷B', path: '加入事件路徑', targetA: 'A 節點', targetB: 'B 節點（撤銷目標）',
    undo: '撤回最後一筆', cancel: '取消選取', compareBalance: '查看原始帳餘額18', compareClaim: '查看假欠費聲稱6', settle: '交件（僅預覽）',
    exit: '返回／暫離', resume: '重入同一局', reset: '重設預覽（新局）',
    selected: '已選：', none: '無', balance: '故事餘額：', claim: '假欠費聲稱：6（與原始帳分開）', history: '事件路徑：', initial: '初始10',
    time: '提案遊戲分鐘：', timing: '首次有效 A／B／C／結算各5分鐘，1分鐘＝1遊戲分鐘；閱讀、選單、撤回及重做不另扣時。非實時倒數，不連接共用時鐘。',
    cancelled: 'B 已撤銷，歷史仍保留；C 不產生新獎勵。', difference: '原始帳18與假聲稱6不一致。葉冬仍因這次事件不安，不能宣告現實款項已返還。',
    done: '預覽完成：餘額18、B已撤銷、假聲稱獨立保留。正式獎勵0，正式存檔未寫入。',
    paused: '已暫離；本局進度保留，沒有發通關分。', empty: '請先選事件；空操作不計時。', order: '必須先加入A，再加入B；C依賴B。',
    wrongTarget: '不是這筆事件：C只能撤銷B，不能當作新增點數。', used: '這筆已處理，不重複計點。',
    incomplete: '尚未完成事件鏈及兩項對照，不能結算。', invalid: '目前狀態不可執行此操作。', stale: '過期或重送指令已忽略。',
    select: '已選事件，請點目標。', place: '事件已登記。', compare: '已讀取對照。',
    art: '舊版提案圖參考（非互動區、非golden）', artNote: 'T06-S01 操作前；不將舊圖當新版 MG-P05 狀態圖。', artMissing: 'T06-S01 參考圖載入失敗；仍可操作提案模型。'
  };
  function create(options = {}) {
    const model = root.FraudT06Model;
    let run = 0, sequence = 0, state = model.create(options.sessionId || 'T06-' + root.crypto.randomUUID());
    let base = state.sessionId;
    if (Object.prototype.hasOwnProperty.call(options, 'privateCheckpoint')) {
      const restored = globalThis.FraudPrivateModuleSave.checkpointState('T06', options.privateCheckpoint, state);
      state = restored.state;
      base = restored.controller.base;
      run = restored.controller.run;
      sequence = restored.controller.sequence;
    }
    let container = null, host = null, feedback = 'intro';
    const i18n = { t: key => options.translate?.(key, zh[key] || key) || zh[key] || key };
    const t = key => i18n.t(key);
    function node(tag, text) { const n = host.ownerDocument.createElement(tag); if (text) n.textContent = text; return n; }
    function button(key, type, extra = {}) {
      const b = node('button', t(key)); b.type = 'button'; b.dataset.action = key;
      b.addEventListener('click', () => dispatch(type, extra)); return b;
    }
    function dispatch(type, extra = {}) {
      const out = model.apply(state, { ...extra, type, sessionId: state.sessionId, revision: state.revision, id: String(++sequence) });
      state = out.state; feedback = out.message; render();
      // Commit state before notifying; reentrant calls cannot settle twice.
      if (out.accepted) options.onState?.(snapshot(), { preview: true, minuteDeltaProposal: out.minuteDelta });
      if (out.result) options.onResult?.(JSON.parse(JSON.stringify(out.result)));
      // Never expose out.state: it is the controller's committed state.
      return JSON.parse(JSON.stringify(out));
    }
    function snapshot() { return JSON.parse(JSON.stringify(state)); }
    function render() {
      if (!host) return;
      const focusedAction = host.contains(host.ownerDocument.activeElement) ? host.ownerDocument.activeElement.dataset.action : null;
      host.replaceChildren(); host.append(node('h2', t('title')), node('p', t('notice')));
      const live = node('p', t(feedback)); live.setAttribute('role', 'status'); live.setAttribute('aria-live', 'polite'); host.append(live);
      host.append(node('p', t('time') + state.minutes), node('p', t('timing')));
      if (state.phase === 'intro') host.append(node('p', t('intro')), button('start', 'start'));
      if (state.phase === 'exited') host.append(node('p', t('paused')), button('resume', 'resume'));
      if (state.phase === 'work' || state.phase === 'result') {
        host.append(node('p', t('history') + t('initial') + state.ledger.map(e => ' → ' + t(e)).join('')));
        const balance = node('strong', t('balance') + state.balance); balance.dataset.balance = String(state.balance); host.append(balance, node('p', t('claim')));
        if (state.ledger.includes('C')) host.append(node('p', t('cancelled')));
        if (state.phase === 'work') {
          host.append(node('p', t('selected') + (state.selected || t('none'))));
          const choices = node('div'); choices.className = 't06-controls';
          for (const event of ['A', 'B', 'C']) { const b = button(event, 'select', { event }); b.setAttribute('aria-pressed', String(state.selected === event)); choices.append(b); }
          for (const [key, type, extra] of [['path','place',{target:'path'}],['targetA','place',{target:'A'}],['targetB','place',{target:'B'}],['undo','undo',{}],['cancel','cancel',{}],['compareBalance','compare',{target:'balance'}],['compareClaim','compare',{target:'claim'}],['settle','settle',{}]]) choices.append(button(key,type,extra));
          host.append(choices);
        }
        if (state.compared.length === 2) host.append(node('p', t('difference')));
        if (state.phase === 'result') host.append(node('p', t('done')));
      }
      if (state.phase !== 'exited') host.append(button('exit', 'exit'));
      const reset = node('button', t('reset')); reset.type = 'button'; reset.dataset.action = 'reset'; reset.addEventListener('click', resetRun); host.append(reset);
      const details = node('details'); details.append(node('summary', t('art')), node('p', t('artNote')));
      const img = node('img'); img.alt = t('artNote'); img.loading = 'lazy'; img.src = options.referenceArtUrl || '../../images/1cd13f3453160474b562.webp';
      img.addEventListener('error', () => { const fallback = img.ownerDocument.createElement('p'); fallback.textContent = t('artMissing'); img.replaceWith(fallback); }); details.append(img); host.append(details);
      if (focusedAction) Array.from(host.querySelectorAll('button')).find(b => b.dataset.action === focusedAction)?.focus({ preventScroll: true });
    }
    function resetRun() { state = model.create(base + ':reset-' + (++run)); feedback = 'intro'; render(); options.onState?.(snapshot(), { preview: true, minuteDeltaProposal: 0 }); }
    function unmount() { host?.remove(); host = null; container = null; return snapshot(); }
    function mount(target) {
      if (!target?.ownerDocument) throw new TypeError('DOM target required');
      unmount(); container = target; host = target.ownerDocument.createElement('section'); host.className = 'fraud-t06'; container.append(host); render(); return api;
    }
    const api = { mount, unmount, snapshot, dispatch, reset: resetRun,
      getPrivateCheckpoint: () => globalThis.FraudPrivateModuleSave.makeCheckpoint('T06', snapshot(), { base, run, sequence }) }; return api;
  }
  root.FraudT06 = { create };
})(globalThis);
