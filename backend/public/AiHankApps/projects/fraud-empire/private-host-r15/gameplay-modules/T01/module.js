/* global setTimeout, clearTimeout */
((root, factory) => {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('../../interactive-prototype-model.js'));
  else root.FraudT01 = factory(root.FraudInteractiveModel);
})(globalThis, model => {
  'use strict';
  // This adapter deliberately retains MG-P01's proposal rules and zero production effects.
  function create(options) {
    const { sessionId, onResult = () => {}, onExit = () => {}, assetBaseURL = "../../", i18n = { t: text => text } } = options;
    let data = options.data;
    if (!model?.validate(data) || typeof sessionId !== 'string' || !sessionId.trim()) throw new Error('T01 requires validated prototype data and a unique sessionId');
    data = model.clone(data);
    let busy = false, timer = null;
    let generation = 0, sequence = 0, state = model.create('MG-P01', sessionId + ':0', data);
    let host = null, panel = null, delivered = false, aborted = false, resetPending = false, notice = '';
    if (Object.prototype.hasOwnProperty.call(options, 'privateCheckpoint')) {
      const restored = globalThis.FraudPrivateModuleSave.checkpointState('T01', options.privateCheckpoint, state);
      state = restored.state;
      generation = restored.controller.generation;
      sequence = restored.controller.sequence;
      aborted = restored.snapshot.aborted;
      delivered = aborted || state.resultCount === 1;
    }
    const snapshot = () => ({ ...model.clone(state), moduleId: 'T01', ruleset: 'MG-P01-proposal', preview: true, aborted, elapsedGameMinutes: 0, timeStatus: 'unconfirmed-new-rules', productionEffects: false });
    function result() { return { moduleId: 'T01', session: state.session, resultId: state.session + ':T01-result', outcome: aborted ? 'aborted' : 'completed', preview: true, awardedReward: 0, elapsedGameMinutes: 0, timeStatus: 'unconfirmed-new-rules', jobs: model.clone(state.jobs) }; }
    function deliver() { if (!delivered) { delivered = true; onResult(result()); } }
    function dispatch(type, payload = {}, expected = state.revision) {
      if (!panel || aborted || resetPending || busy) return { accepted: false, message: '目前不能操作', state: snapshot() };
      const command = { ...payload, type, session: state.session, revision: expected, id: state.session + ':' + (++sequence) };
      const out = model.apply(state, command);
      state = out.counted ? model.finishEvent(out.state, command.id) : out.state;
      if (out.counted) { busy = true; timer = setTimeout(() => { busy = false; timer = null; render(); }, 240); }
      notice = out.message; render();
      if (state.resultCount) deliver();
      return { accepted: out.accepted, message: out.message, state: snapshot() };
    }
    function unmount() { clearTimeout(timer); timer = null; busy = false; panel?.remove(); panel = null; host = null; return snapshot(); }
    function mount(target) {
      if (!target || typeof target.append !== 'function') throw new Error('T01 requires a DOM container');
      unmount(); host = target; panel = host.ownerDocument.createElement('section'); panel.className = 't01-module'; host.append(panel); render(); return api;
    }
    function render() {
      if (!panel) return;
      const doc = host.ownerDocument, focus = doc.activeElement?.dataset.t01;
      const el = (tag, text) => { const n = doc.createElement(tag); if (text !== undefined) n.textContent = i18n.t(text); return n; };
      const button = (key, label, action, disabled = false) => {
        const n = el('button', label); n.type = 'button'; n.dataset.t01 = key; n.disabled = disabled;
        n.addEventListener('click', () => { if (panel?.contains(n)) action(); }); return n;
      };
      const revision = state.revision;
      const action = (key, label, type, payload, disabled) => button(key, label, () => dispatch(type, payload, revision), disabled);
      panel.replaceChildren(); panel.setAttribute('aria-label', 'T01 假兼職工單提案原型');
      panel.append(el('h2', 'T01｜做完卻領不到的工單'), el('p', '可操作提案／非正式遊戲。先點工單，再點空工位；每輪只推進已在槽中的工作。處理三份後交班，保留每個人的後果。'));
      panel.append(el('p', '新版時間未確認：本預覽不推進正式時鐘，閱讀與選單停表。操作步數不是分鐘；正式獎勵 0，不寫存檔。'));
      panel.append(el('p', '畫面尚非 golden 驗收：以下為操作控制與原始 AI 概念圖參考，缺可操作分層美術。'));
      panel.append(el('p', `輪數 ${state.round}｜完成 ${state.completed.length}/3｜退出 ${state.jobs.filter(j => j.state === 'EXITED').length}｜操作步數 ${state.logicalStep}`));
      const status = el('p', notice || '選一份待排工單開始。'); status.setAttribute('role', 'status'); panel.append(status);
      if (resetPending) {
        panel.append(el('p', '重設會清除這次提案進度，建立新的獨立預覽。'), button('confirm-reset', '確認重設', () => {
          state = model.create('MG-P01', sessionId + ':' + (++generation), data); delivered = false; aborted = false; resetPending = false; notice = ''; render();
        }), button('cancel-reset', '取消重設', () => { resetPending = false; render(); })); return;
      }
      const locked = state.committed || aborted || busy;
      for (const job of state.jobs) {
        const row = el('div'); row.className = 't01-job';
        const states = { WAITING: '待排', STAGED: '已放入', IN_PROGRESS: '進行中', COMPLETED: '完成', EXITED: '完成後退出' };
        row.append(el('p', `${job.name}｜${job.progress}/${job.requiredRounds}｜${states[job.state]}`));
        const select = action('select-' + job.id, '選取 ' + job.name, 'select_job', { job: job.id }, locked || !['WAITING', 'STAGED'].includes(job.state));
        select.setAttribute('aria-pressed', String(state.selectedJob === job.id));
        row.append(select, action('read-' + job.id, '查看紀錄', 'view_job', { job: job.id }, aborted), action('remove-' + job.id, '撤回未推進工單', 'remove_staged', { job: job.id }, locked || job.state !== 'STAGED'));
        if (model.terminal(job)) row.append(el('p', job.consequence)); panel.append(row);
      }
      state.slots.forEach((id, slot) => panel.append(action('slot-' + slot, `工位 ${slot + 1}：${id ? state.jobs.find(j => j.id === id).name : '空'}（放入所選）`, 'place_job', { job: state.selectedJob, slot }, locked)));
      panel.append(action('advance', '推進一輪', 'advance_round', {}, locked), action('handoff', '核對並交班一次', 'handoff', {}, locked), action('cancel', '取消選取', 'cancel_selection', {}, locked));
      panel.append(button('abort', '中止整批（保留已發生後果）', () => { aborted = true; notice = '已中止，未完成工作不冒稱完成；零獎勵。'; render(); deliver(); }, locked));
      panel.append(button('reset', '重設預覽', () => { resetPending = true; render(); }, busy), button('exit', '返回／離開（保留本局）', () => { const s = unmount(); onExit(s); }));
      if (state.committed || aborted) panel.append(el('p', aborted ? '本批已中止。重設才能開始新預覽。' : '本批已交班。三份結果保留，返回不重發。'));
      const details = el('details'); details.append(el('summary', '查看 MG-P01 原始 AI 概念圖（非操作完成證明）'));
      const frame = data.fixtures['MG-P01'].art[state.resultCount ? 2 : state.round ? 1 : 0];
      const img = el('img'); img.src = assetBaseURL + frame.src; img.alt = 'MG-P01 原始提案概念圖；圖面時間不是本預覽時鐘'; img.width = frame.width; img.height = frame.height;
      details.append(img); panel.append(details);
      [...panel.querySelectorAll('button')].find(n => n.dataset.t01 === focus)?.focus();
    }
    const api = { mount, unmount, getState: snapshot, dispatch,
      getPrivateCheckpoint: () => globalThis.FraudPrivateModuleSave.makeCheckpoint('T01', snapshot(), { generation, sequence }) };
    return api;
  }
  return { create };
});
