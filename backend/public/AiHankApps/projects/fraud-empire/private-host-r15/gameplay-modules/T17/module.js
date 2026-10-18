/* Mount only inside the supplied container. Host HUD and clock remain host-owned. */
((root) => {
  'use strict';
  const owners = new WeakMap();
  const copy = x => JSON.parse(JSON.stringify(x));
  const zh = {
    title: 'T17 假博弈｜有限機甲回放', notice: '舊版提案操作台；非正式遊戲。三場、兩機；先點場次再點空機。未交付影片，不會通關、發獎或寫存檔。',
    start: '開始排程', select: '選取場次', waiting: '待播', staged: '已排程（未完成）',
    slot: '回放機', empty: '空機', withdraw: '撤回', confirm: '確認雙機排程', back: '返回排程',
    prev: '上一回合', next: '下一回合', round: '回合索引（無影片）', judge: '保留賽果', play: '播放第三場',
    missing: '影片目前無法顯示。這不是判讀失誤；等價圖文替代方案待確認。未播放第三場不得結算。',
    repair: '預覽保留此機', repairNote: '修復耗4遊戲分鐘是舊版提案；目前只預覽選擇，不扣時間、不修設備、不製造簡報成果。',
    view: '閱讀步驟示意', ref: '既有AI情境示意，非可操作影片或已批准golden。閱讀不推進進度。',
    exit: '退出並回報未完成', reset: '重設本次預覽', confirmReset: '確認清除本次預覽', cancel: '取消重設',
    handoff: '批次交班', ok: '狀態已更新；正式獎勵 0。', rejected: '操作未接受；狀態與時間不變。',
    result: '已退出：預覽未完成，正式獎勵0；重設才可開始新預覽。', time: '已確認遊戲分鐘',
    rejectOccupied: '這台回放機已有場次，不能覆蓋。先撤回該場次，或把已選場次放到另一台空機；沒有扣時間或資源。',
    rejectSelection: '尚未選取可排程的待播場次。先選待播場次，再點空回放機；已排程場次需先撤回。',
    rejectEmpty: '兩台回放機尚未排滿，不能確認。先選待播場次，逐一放入兩台空機；這不代表已播放或完成。',
    rejectStale: '這是舊版本或重複的操作，已忽略。請使用目前畫面上的控制項。',
    rejectSealed: '本次已退出且仍未完成；僅可閱讀，需明確重設才開始新預覽。',
    rejectPhase: '目前不在這項操作的階段。請返回排程，或先確認雙機排程；缺影片仍不會播放或結算。',
    upgrade: '容量2→3、維修1→2僅提案；成本未定，不提供購買。'
  };
  const art = ['29e114068257641861e7', '82c452f0c91107687378', '7c76ac6bbfe523dc589b', 'd91f48e7fb8e3153c05d', '0e61759555b54cb5af01', '030016c6d72e783a8ab3', 'd2cd7730c094cd93df40'];
  function mount(container, options = {}) {
    if (!container || owners.has(container)) throw new Error('T17 requires an unowned container');
    const model = root.FraudT17Model;
    if (!model) throw new Error('Load T17/model.js first');
    const restored = Object.prototype.hasOwnProperty.call(options, 'privateCheckpoint')
      ? globalThis.FraudPrivateModuleSave.checkpointState('T17', options.privateCheckpoint, model.create()) : null;
    const doc = container.ownerDocument, shell = doc.createElement('section');
    shell.className = 'fraud-t17'; container.append(shell);
    let state = restored ? restored.state : model.create(), generation = 0, sequence = restored ? restored.controller.sequence : 0, alive = true, delivered = Boolean(state.result), resetting = false, notice = 'notice';
    const t = key => options.translate?.(key, zh[key]) || zh[key];
    const node = (tag, key) => { const n = doc.createElement(tag); n.textContent = t(key); n.dataset.t17I18n = key; return n; };
    function send(type, payload, revision, owner) {
      if (!alive || owner !== generation) return;
      const out = model.apply(state, { ...payload, type, revision, id: 'event-' + (++sequence) });
      state = out.state; notice = out.accepted ? 'ok' : ({ 'media-unavailable': 'missing', occupied: 'rejectOccupied', selection: 'rejectSelection', empty: 'rejectEmpty', stale: 'rejectStale', sealed: 'rejectSealed', phase: 'rejectPhase' }[out.reason] || 'rejected');
      render();
      if (out.accepted) options.onState?.(copy(state));
      if (state.result && !delivered) { delivered = true; options.onResult?.(copy(state.result)); }
    }
    function render() {
      const focus = doc.activeElement?.dataset.t17Key;
      shell.replaceChildren(node('h2', 'title'), node('p', 'notice'));
      const button = (key, type, payload = {}, suffix = '', parent = shell) => {
        const b = node('button', key), revision = state.revision, owner = generation;
        b.type = 'button'; b.textContent += suffix; b.dataset.t17Key = type + JSON.stringify(payload);
        b.onclick = () => send(type, payload, revision, owner); parent.append(b); return b;
      };
      const summary = node('p', 'time'); summary.textContent += ': ' + state.elapsedGameMinutes; shell.append(summary);
      if (state.result) shell.append(node('p', 'result'));
      if (state.phase === 'reading') button('start', 'start');
      if (state.phase === 'schedule') {
        state.races.forEach((race, i) => {
          const row = doc.createElement('p');
          if (race.status === 'waiting') {
            const b = button('select', 'select', { race: race.id }, ' ' + (i + 1), row);
            b.setAttribute('aria-pressed', String(state.selected === race.id));
          } else button('withdraw', 'withdraw', { race: race.id }, ' ' + (i + 1), row);
          row.append(node('span', race.status)); shell.append(row);
        });
        state.slots.forEach((id, slot) => button('slot', 'place', { slot }, ' ' + (slot + 1) + ': ' + (id ? String(state.races.findIndex(r => r.id === id) + 1) : t('empty'))));
        button('confirm', 'confirm');
      }
      if (state.phase === 'media-unavailable') {
        shell.append(node('p', 'missing'));
        const round = node('p', 'round'); round.textContent += ': ' + state.round; shell.append(round);
        button('prev', 'round', { delta: -1 }); button('next', 'round', { delta: 1 }); button('judge', 'judge');
        button('repair', 'repair-preview', { slot: 0 }, ' 1'); button('repair', 'repair-preview', { slot: 1 }, ' 2');
        if (state.repairPreview !== null) { const p = node('p', 'repairNote'); p.textContent += ' ' + t('slot') + ' ' + (state.repairPreview + 1); shell.append(p); }
        button('play', 'play'); button('handoff', 'handoff'); button('back', 'back');
      }
      const nav = doc.createElement('nav');
      for (let step = 1; step <= 7; step++) button('view', 'view', { step }, ' ' + step, nav);
      shell.append(nav, node('p', 'ref'));
      if (state.view === 7) shell.append(node('p', 'upgrade'));
      if (options.assetBase) {
        const img = doc.createElement('img'); img.src = options.assetBase.replace(/\/$/, '') + '/images/' + art[state.view - 1] + '.webp';
        img.alt = t('ref') + ' T17-S0' + state.view; img.loading = 'lazy'; shell.append(img);
      }
      if (!state.result) button('exit', 'exit');
      const reset = node('button', resetting ? 'confirmReset' : 'reset'); reset.type = 'button'; reset.dataset.t17Key = 'reset';
      reset.onclick = () => {
        if (!alive) return;
        if (resetting) { generation++; state = model.create(); delivered = false; resetting = false; notice = 'notice'; render(); options.onState?.(copy(state)); }
        else { resetting = true; render(); }
      }; shell.append(reset);
      if (resetting) { const cancel = node('button', 'cancel'); cancel.type = 'button'; cancel.onclick = () => { resetting = false; render(); }; shell.append(cancel); }
      const feedback = node('p', notice); feedback.setAttribute('role', 'status'); shell.append(feedback);
      Array.from(shell.querySelectorAll('button')).find(b => b.dataset.t17Key === focus)?.focus();
    }
    const handle = { getState: () => copy(state),
      getPrivateCheckpoint: () => globalThis.FraudPrivateModuleSave.makeCheckpoint('T17', copy(state), { sequence }),
      unmount() { if (!alive) return; alive = false; shell.remove(); owners.delete(container); } };
    owners.set(container, handle); render(); return handle;
  }
  root.FraudT17 = { mount };
})(globalThis);
