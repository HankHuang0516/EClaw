/* global window */
(function (root) {
  'use strict';
  function mount(host, options) {
    const { source, onResult = () => {}, onState = () => {} } = options;
    const model = root.FraudT09Model;
    if (!host || !source || source.topic.id !== 'T09') throw new Error('T09 source/host required');
    const restored = Object.prototype.hasOwnProperty.call(options, 'privateCheckpoint')
      ? globalThis.FraudPrivateModuleSave.checkpointState('T09', options.privateCheckpoint, model.create()) : null;
    // One controller owns one host; a remount cannot leave duplicate listeners.
    if (host.__fraudT09) host.__fraudT09.unmount();
    const doc = host.ownerDocument;
    let state = restored ? restored.state : model.create(), live = true, message = '先閱讀目標，再確認出發。';
    const section = doc.createElement('section'); section.className = 't09-module'; host.append(section);
    const t = (key, fallback) => options.translate ? options.translate(key, fallback) : fallback;
    function text(tag, key, value, parent = section) {
      const el = doc.createElement(tag); el.textContent = t(key, value); el.dataset.i18n = '[html]t09_' + key; parent.append(el); return el;
    }
    function button(label, type, value, parent = section) {
      const b = text('button', type + '_' + (value || ''), label, parent); b.type = 'button';
      b.dataset.action = type; if (value !== undefined) b.dataset.value = String(value);
      b.dataset.revision = String(state.revision); return b;
    }
    const labels = { inn: '旅舍：只確認夜1', night1: '夜1：已確認', night2: '夜2：尚無安排，不能新增假確認', zhou: '周舟：原定同行', list: '同行名單：只有梁葵', promise: '封面承諾：兩人兩夜', missingNight: '標出缺住宿1夜', missingPerson: '標出漏同行1人', summary: '查看事件摘要', album: '查看空白相簿：此旅未成行' };
    function render() {
      section.replaceChildren();
      text('h2', 'title', 'T09 假旅遊申請｜可操作提案');
      text('p', 'boundary', '舊版 v4 七步提案；數值未批准。缺可操作 golden，美術與 UI 尚未驗收。預覽不發正式獎勵、不寫正式存檔。');
      text('p', 'clock', '提案動作時間 ' + state.proposedMinutes + '／100 分鐘；1 遊戲分鐘＝1 分鐘，不加速。閱讀／選單停表。');
      if (state.paused) { text('p', 'paused', '已返回選單，這個實例保留原進度。'); button('繼續預覽', 'resume'); }
      else if (state.result) {
        text('h3', 'result', state.ending === 'cancel' ? '已取消旅程：兩人未登船' : '爭議待解決：兩人未登船');
        text('p', 'consequence', '共同旅行的期待落空；相簿保留未成行紀錄。提案三段已完成，正式資源變動為 0。');
      } else {
        const step = source.topic.steps[state.step];
        text('h3', 'step' + state.step, step.title); text('p', 'goal' + state.step, step.instruction);
        text('p', 'facts' + state.step, step.visible_before.join('；'));
        if (state.step === 1) {
          for (const day of [1, 2, 3]) { const b = button('霧日' + day, 'day', day); b.setAttribute('aria-pressed', String(state.selectedDay === day)); }
          button('渡船：霧日1', 'place', 'outbound'); button('回船：霧日3', 'place', 'inbound'); button('撤回船班', 'undo');
          text('p', 'placement', '去程：' + (state.outbound || '未放置') + '；回程：' + (state.inbound || '未放置'));
        }
        const views = { 2: ['inn', 'night1', 'night2'], 3: ['zhou', 'list', 'promise'], 4: ['missingNight', 'missingPerson'], 5: ['summary'], 6: ['album'] };
        for (const id of views[state.step] || []) { const b = button(labels[id], 'inspect', id); b.setAttribute('aria-pressed', String(state.inspected.includes(id))); }
        if (state.step === 4) { button('取消旅程', 'ending', 'cancel'); button('保留爭議', 'ending', 'dispute'); }
        if (state.ending) text('p', 'chosen', state.ending === 'cancel' ? '已選取消：故事淨入帳0（提案）' : '已選保留爭議：故事淨額未定，不宣稱退款');
        const confirm = button(state.step === 6 ? '確認回程／完成提案' : '確認本段／下一步', 'confirm'); confirm.disabled = !model.ready(state);
        const details = doc.createElement('details'); section.append(details); text('summary', 'art', '來源情境圖對照（非可操作 golden）', details);
        const art = source.art.find(a => a.id === step.id);
        if (art) { const img = doc.createElement('img'); img.src = '../../' + art.src; img.alt = art.title + '，來源 AI 情境示意，非驗收畫面'; img.addEventListener('error', () => { img.remove(); text('p', 'missing', '來源圖片無法載入；互動狀態仍可預覽。', details); }, { once: true }); details.append(img); }
      }
      const status = text('output', 'feedback', message); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
      if (!state.paused) button('返回選單', 'pause'); button('重設獨立預覽', 'reset');
    }
    function dispatch(action) {
      if (!live) return false;
      const result = model.apply(state, action); state = result.state; message = result.message; render();
      if (result.accepted) { onState(model.snapshot(state)); if (state.result && !delivered) { delivered = true; onResult(model.snapshot(state.result)); } }
      // Reset is a new preview, permitted one result of its own.
      if (result.accepted && action.type === 'reset') delivered = false;
      return result.accepted;
    }
    let delivered = Boolean(state.result);
    function click(event) {
      const b = event.target.closest('button[data-action]'); if (!b || !section.contains(b)) return;
      const type = b.dataset.action, value = type === 'day' ? Number(b.dataset.value) : b.dataset.value;
      dispatch({ type, value, revision: Number(b.dataset.revision) });
      const target = [...section.querySelectorAll('button')].find(el => el.dataset.action === type && el.dataset.value === b.dataset.value && !el.disabled);
      if (target) target.focus(); else { section.tabIndex = -1; section.focus(); }
    }
    section.addEventListener('click', click);
    const api = { getState: () => model.snapshot(state), dispatch,
      getPrivateCheckpoint: () => globalThis.FraudPrivateModuleSave.makeCheckpoint('T09', model.snapshot(state), {}),
      unmount() { if (!live) return; live = false; section.removeEventListener('click', click); section.remove(); if (host.__fraudT09 === api) delete host.__fraudT09; } };
    host.__fraudT09 = api; render(); return api;
  }
  root.FraudT09 = Object.freeze({ mount });
})(window);
