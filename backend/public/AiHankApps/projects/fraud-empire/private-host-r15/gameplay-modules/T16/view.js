/* Isolated DOM adapter. Load model.js first; caller owns the container. */
((root) => {
  'use strict';
  const mounted = new WeakSet();
  const words = {
    title: 'T16｜把選擇權交還給他', notice: '提案互動預覽・成年虛構同伴支持故事。無露骨素材、無收益、無失敗懲罰。',
    art: '正式畫面尚未完成：T16-S01～S07 缺無 HUD 底圖及可操作分層。以下是可操作的文字狀態預覽，不是美術驗收。',
    clock: '遊戲時間 +0 分鐘｜績效、培養點、零用錢、會員收入皆 0｜不寫正式存檔',
    watch: '觀看支持故事', summary: '文字簡述', skip: '略過故事（同等進度）',
    seat: '選安靜座位', accompany: '坐下陪伴', nearby: '留在附近', ask: '請阿岑選擇', go: '經同意一起走', wait: '在此等候',
    arrived: '前往醫護室座位', resting: '停一下，在休息點陪伴', supported: '只記已獲陪伴', none: '不記細節',
    review: '查看結束頁', back: '返回調整紀錄', finish: '故事完成', greet: '普通招呼', rest: '繼續休息',
    pause: '暫停／閱讀選單', resume: '繼續故事', exit: '退出預覽', reset: '重設此預覽', confirm: '確認重設', cancel: '取消重設',
    paused: '故事已暫停。退出後可重新掛載此實例，保留進度。', resetNote: '重設只清除此實例的提案進度。',
    rejected: '尚未滿足這項操作條件，狀態未改變。', complete: '本次預覽已處理；觀看、簡述與略過進度等效，不發獎。',
    summaryText: '阿岑獲得陪伴，是否談話、是否前往醫護室及紀錄範圍由他決定。無需探問私人細節，支持故事不產生收益。',
    consent: '阿岑選擇醫護室，同意同行；也可以在此等候。', selected: '安靜座位已選，尚未開始陪伴。',
    followup: '後續日常片段預覽（非真的推進至翌日）：可打招呼或繼續休息，皆無代價。',
    greeted: '阿岑聊起今天的餐點。普通日常片段已看過，不追問事件。', rested: '你繼續休息。未談話不扣好感，故事不反覆提醒。',
    pendingRecord: '紀錄尚空；只可記陪伴狀態，不收集私人內容。', recordSupported: '紀錄範圍：已獲陪伴。離開前仍可改為不記。', recordNone: '紀錄範圍：不記細節。',
    routeArrived: '已抵達醫護室座位，照護者等待同意。', routeResting: '已停在休息點；不強迫走完路線。', routeWaiting: '留在原地等候，尊重阿岑的選擇。'
  };
  let sequence = 0;
  function create(options = {}) {
    const model = root.FraudT16Model;
    if (!model) throw new Error('Load T16/model.js first');
    const i18n = options.i18n || { t: key => words[key] || key };
    const t = key => i18n.t(key);
    const session = () => 'T16-' + (++sequence) + '-' + (root.crypto?.randomUUID?.() || Date.now());
    let state = model.create(session()), container = null, panel = null, resetPending = false, message = '';
    const steps = options.source?.topic?.steps;
    if (!Array.isArray(steps) || steps.length !== 7 || options.source.topic.id !== 'T16') throw new Error('T16 source.json required');
    if (Object.prototype.hasOwnProperty.call(options, 'privateCheckpoint')) {
      const restored = globalThis.FraudPrivateModuleSave.checkpointState('T16', options.privateCheckpoint, state);
      state = restored.state;
    }
    function node(tag, text) { const n = document.createElement(tag); if (text) n.textContent = text; return n; }
    function button(parent, key, type, value, disabled = false) {
      const b = node('button', t(key)); b.type = 'button'; b.dataset.action = key; b.disabled = disabled;
      const origin = { session: state.session, revision: state.revision };
      b.addEventListener('click', () => {
        if (!container || origin.session !== state.session || origin.revision !== state.revision) return;
        if (type === 'exit') { unmount(); options.onExit?.(getState()); return; }
        if (type === 'resetPrompt') { resetPending = true; render(); return; }
        if (type === 'cancelReset') { resetPending = false; render(); return; }
        if (type === 'reset') { state = model.create(session()); resetPending = false; message = ''; render(); return; }
        const outcome = model.apply(state, { ...origin, type, value });
        state = outcome.state; message = outcome.accepted ? '' : t('rejected'); render();
        if (outcome.result) options.onResult?.(model.copy(outcome.result));
      }); parent.append(b);
    }
    function render() {
      if (!panel) return;
      const focused = panel.contains(document.activeElement) ? document.activeElement.dataset.action : null;
      panel.replaceChildren(node('h2', t('title')), node('p', t('notice')), node('p', t('art')), node('p', t('clock')));
      const status = node('p', message || (state.processed ? t('complete') : steps[state.step - 1].instruction));
      status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); panel.append(status);
      const body = node('section'); body.dataset.step = String(state.step); panel.append(body);
      const add = (key, type = key, value, disabled) => button(body, key, type, value, disabled);
      if (resetPending) { body.append(node('p', t('resetNote'))); add('confirm', 'reset'); add('cancel', 'cancelReset'); }
      else if (state.paused) { body.append(node('p', t('paused'))); add('resume'); }
      else if (state.processed) {
        body.append(node('p', t('followup')));
        if (state.followup) body.append(node('p', t(state.followup === 'greet' ? 'greeted' : 'rested')));
        else { add('greet', 'followup', 'greet'); add('rest', 'followup', 'rest'); }
      } else {
        body.append(node('h3', steps[state.step - 1].title));
        if (state.step === 1) add('watch');
        if (state.step === 2) {
          body.append(node('p', state.seat ? t('selected') : '阿岑：想安靜一下。'));
          add('seat', 'seat', 'quiet', Boolean(state.seat)); add('accompany', 'accompany', undefined, !state.seat); add('nearby');
        }
        if (state.step === 3) {
          add('ask', 'ask', undefined, state.consent);
          if (state.consent) body.append(node('p', t('consent')));
          add('go', 'go', undefined, !state.consent); add('wait', 'wait', undefined, !state.consent);
        }
        if (state.step === 4) { add('arrived', 'travel', 'arrived'); add('resting', 'travel', 'resting'); }
        if (state.step === 5) {
          body.append(node('p', t({ arrived: 'routeArrived', resting: 'routeResting', waiting: 'routeWaiting' }[state.route])));
          body.append(node('p', t(state.record ? state.record === 'none' ? 'recordNone' : 'recordSupported' : 'pendingRecord')));
          add('supported', 'record', 'supported'); add('none', 'record', 'none'); add('review', 'review', undefined, !state.record);
        }
        if (state.step === 6) {
          body.append(node('p', t('summaryText'))); add('finish'); if (state.mode === 'watch') add('back');
        }
        add('summary'); add('skip'); add('pause');
      }
      button(panel, 'exit', 'exit'); button(panel, 'reset', 'resetPrompt');
      if (focused) (panel.querySelector('[data-action="' + focused + '"]:not(:disabled)') || panel.querySelector('button:not(:disabled)'))?.focus({ preventScroll: true });
    }
    function mount(target) {
      if (!target || typeof target.append !== 'function') throw new TypeError('DOM container required');
      if (container === target) return api;
      if (mounted.has(target)) throw new Error('Container already has a T16 instance');
      unmount(); container = target; mounted.add(target); panel = node('article'); panel.className = 'fraud-t16'; panel.lang = 'zh-Hant'; container.append(panel); render(); return api;
    }
    function unmount() { if (container) mounted.delete(container); panel?.remove(); panel = null; container = null; }
    function getState() { return model.copy(state); }
    const api = Object.freeze({ mount, unmount, getState, getResult: () => model.result(state),
      getPrivateCheckpoint: () => globalThis.FraudPrivateModuleSave.makeCheckpoint('T16', getState(), {}) });
    return api;
  }
  root.FraudT16 = Object.freeze({ create });
})(globalThis);
