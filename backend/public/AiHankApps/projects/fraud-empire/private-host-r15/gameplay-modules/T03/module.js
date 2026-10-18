/* global module */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FraudT03 = api;
})(globalThis, function () {
  'use strict';
  const copy = value => JSON.parse(JSON.stringify(value));
  const commands = new Set(['cancel_selection', 'navigate', 'view_expectation', 'inspect_model', 'view_followup', 'select_piece', 'place_piece', 'remove_piece', 'select_ticket', 'place_ticket', 'take_back_ticket', 'reveal_top_A', 'select_pair', 'mark_duplicate', 'clear_duplicate', 'preview_choice', 'cancel_choice', 'confirm_choice', 'attach_followup', 'seal']);
  const owners = new WeakMap();
  let serial = 0;
  function create(options) {
    const { model, data } = options;
    if (!model || !model.validate(data)) throw new Error('T03 requires the existing interactive-prototype model and validated data');
    const fixture = copy(data);
    let identity = (options.sessionId || 'T03') + '-' + (++serial);
    let generation = 0, sequence = 0, emitted = false;
    let state = model.create('MG-P02', identity + ':0', fixture);
    let element = null, section = null, notice = '', resetPending = false, mountEpoch = 0;
    if (Object.prototype.hasOwnProperty.call(options, 'privateCheckpoint')) {
      const restored = globalThis.FraudPrivateModuleSave.checkpointState('T03', options.privateCheckpoint, state);
      state = restored.state;
      identity = restored.controller.identity;
      generation = restored.controller.generation;
      sequence = restored.controller.sequence;
      emitted = state.sealed;
    }
    const t = (key, fallback) => options.translate?.(key, fallback) || fallback;
    const snapshot = () => ({ moduleId: 'T03', candidateId: 'MG-P02', proposal: true, rulesVersion: fixture.version, state: copy(state), timing: { approved: false, gameMinutes: null, clockPaused: true, operationCount: state.logicalStep }, reward: 0, writesSave: false });
    function dispatch(type, payload = {}, token = { session: state.session, revision: state.revision, mountEpoch }) {
      if (!element) return { accepted: false, message: 'unmounted', snapshot: snapshot() };
      if (token.mountEpoch !== mountEpoch) return { accepted: false, message: 'stale-mount', snapshot: snapshot() };
      if (!commands.has(type)) return { accepted: false, message: 'unsupported-command', snapshot: snapshot() };
      const command = { ...payload, type, id: state.session + ':event:' + (++sequence), session: token.session, revision: token.revision };
      const outcome = model.apply(state, command);
      // Pure transitions complete synchronously. No animation delay represents game time.
      state = outcome.counted ? model.finishEvent(outcome.state, command.id) : outcome.state;
      notice = outcome.message;
      render();
      const result = { accepted: outcome.accepted, message: outcome.message, snapshot: snapshot() };
      if (state.sealed && !emitted) {
        emitted = true;
        options.onResult?.({ moduleId: 'T03', candidateId: 'MG-P02', proposal: true, resultId: state.resultId, outcome: 'proposal-complete', choice: state.committedChoice, consequences: state.tickets.map(ticket => ({ id: ticket.id, text: ticket.consequence })), reward: 0, writesSave: false });
      }
      options.onState?.(snapshot());
      return result;
    }
    function unmount() {
      mountEpoch += 1;
      if (element) owners.delete(element);
      section?.remove(); section = null; element = null; resetPending = false;
      return snapshot();
    }
    function mount(target) {
      if (!target?.ownerDocument || !target.append) throw new TypeError('mount requires a DOM element');
      if (owners.has(target) && owners.get(target) !== api) throw new Error('T03 target already mounted');
      unmount(); element = target; owners.set(target, api);
      section = target.ownerDocument.createElement('section'); section.className = 't03-module'; target.append(section); render(); return api;
    }
    function reset(confirm) {
      if (!element || confirm !== true) return false;
      state = model.create('MG-P02', identity + ':' + (++generation), fixture);
      emitted = false; notice = ''; resetPending = false; render(); options.onState?.(snapshot()); return true;
    }
    function render() {
      if (!section) return;
      const doc = section.ownerDocument;
      const focused = section.contains(doc.activeElement) ? doc.activeElement.dataset.focusKey : null;
      section.replaceChildren();
      const node = (tag, key, text, parent = section) => { const n = doc.createElement(tag); n.textContent = t(key, text); n.dataset.i18n = key; parent.append(n); return n; };
      const button = (parent, key, text, handler, selected) => {
        const n = node('button', key, text, parent); n.type = 'button'; n.dataset.focusKey = key;
        if (selected !== undefined) n.setAttribute('aria-pressed', String(selected));
        const epoch = mountEpoch, session = state.session;
        n.addEventListener('click', () => { if (element && epoch === mountEpoch && session === state.session) handler(); }); return n;
      };
      const action = (parent, key, text, type, payload = {}, selected) => {
        const token = { session: state.session, revision: state.revision, mountEpoch };
        return button(parent, key, text, () => dispatch(type, payload, token), selected);
      };
      node('h2', 't03.title', 'T03｜三張票，兩個假象');
      node('p', 't03.proposal', 'MG-P02 可操作提案・未定案。三票皆為無效道具，不代表入場、退款或救援。');
      node('p', 't03.artHold', '互動美術尚待 golden 驗收；此處為操作預覽，不是完成版場景。');
      node('p', 't03.timing', '閱讀與選單停表；新版時數未定，不套舊版 40 分鐘。操作計數不是遊戲分鐘。');
      node('p', 't03.objective', '目標：補月牙 → 放回固定 A／A／B → 揭開雙 A、翻看模型、閱讀期待 → 選擇交回或暫停 → 將三人後續夾回原票。錯放可修正；缺項不能封存。');
      const toolbar = node('nav', 't03.toolbar', '');
      button(toolbar, 't03.exit', '退出（保留本局）', () => { const saved = unmount(); options.onExit?.(saved); });
      button(toolbar, 't03.reset', '重設此提案', () => { resetPending = true; render(); });
      if (resetPending) {
        node('p', 't03.resetNotice', '重設只清除此提案本局；不影響正式存檔。');
        button(toolbar, 't03.resetConfirm', '確認重設', () => reset(true));
        button(toolbar, 't03.resetCancel', '取消重設', () => { resetPending = false; render(); });
      }
      const status = node('p', 't03.feedback', notice || '先選月牙拼片，再點陶可缺口；手機全程可點選。'); status.setAttribute('role', 'status');
      const progress = node('p', 't03.progress', `完整道具 ${state.tickets.filter(ticket => model.ticketComplete(state, ticket)).length}/3 · 後續留存 ${state.followupsAttached.length}/3 · 結果 ${state.resultCount}/1 · 獎勵 0`);
      progress.dataset.phase = state.phase;
      const controls = node('div', 't03.controls', ''); controls.className = 't03-controls';
      if (!state.committed) {
        node('h3', 't03.assembly', '1．拼裝固定道具', controls);
        for (const piece of state.pieces) action(controls, 't03.piece.' + piece.id, piece.shape, 'select_piece', { piece: piece.id }, state.selectedPiece === piece.id);
        action(controls, 't03.placePiece', '放入陶可缺口', 'place_piece', { piece: state.selectedPiece, ticket: 'tao_ke' });
        action(controls, 't03.removePiece', '撤回月牙（先取回陶可票）', 'remove_piece', { ticket: 'tao_ke' });
        action(controls, 't03.cancelSelection', '取消選取', 'cancel_selection');
        node('h3', 't03.board', '2．原票展示位（不是可用座位）', controls);
        for (const ticket of state.tickets) action(controls, 't03.select.' + ticket.id, ticket.name + '・固定 ' + ticket.fixedSeat, 'select_ticket', { ticket: ticket.id }, state.selectedTicket === ticket.id);
        for (const seat of ['A', 'B']) {
          const names = state.boardStacks[seat].map(id => state.tickets.find(ticket => ticket.id === id).name);
          node('p', 't03.stack.' + seat, seat + '：' + (names.length ? names.join(' → ') + '（最後為上層）' : '空'), controls);
          action(controls, 't03.place.' + seat, '將選取原票放到 ' + seat, 'place_ticket', { ticket: state.selectedTicket, seat });
        }
        for (const ticket of state.tickets) if (model.position(state, ticket.id)) action(controls, 't03.take.' + ticket.id, '取回 ' + ticket.name, 'take_back_ticket', { ticket: ticket.id });
        action(controls, 't03.reveal', state.overlapRevealed ? '雙 A 已揭開' : '抬起 A 上層原票', 'reveal_top_A', { ticket: state.boardStacks.A[1] });
        action(controls, 't03.model', state.modelInspected ? '模型已翻看：空支架、未接線' : '翻看劇場模型支架', 'inspect_model');
        for (const ticket of state.tickets) {
          action(controls, 't03.expectation.' + ticket.id, '閱讀 ' + ticket.name + '期待' + (state.expectationsViewed.includes(ticket.id) ? '（已讀）' : ''), 'view_expectation', { ticket: ticket.id });
          action(controls, 't03.pair.' + ticket.id, '標記人選：' + ticket.name, 'select_pair', { ticket: ticket.id }, state.selectedPair.includes(ticket.id));
        }
        if (state.expectationsViewed.length) node('p', 't03.expectation', fixture.fixtures['MG-P02'].expectation, controls);
        action(controls, 't03.mark', '確認兩名重複承諾', 'mark_duplicate', { pair: state.selectedPair });
        action(controls, 't03.clear', '撤回標記', 'clear_duplicate');
        node('h3', 't03.choice', '3．故事選擇', controls);
        node('p', 't03.missing', model.proofMissing(state).join('；') || '工序齊備，可預覽選擇。', controls);
        for (const choice of fixture.choices) action(controls, 't03.choice.' + choice.id, choice.label, 'preview_choice', { choice: choice.id }, state.pendingChoice === choice.id);
        if (state.pendingChoice) {
          node('p', 't03.choiceConsequence', '兩種選擇都保留三人的落空後果，不產生入場資格或退款。', controls);
          action(controls, 't03.confirm', '確認這個選擇（本局不可改）', 'confirm_choice');
          action(controls, 't03.cancelChoice', '返回修改（取消預覽）', 'cancel_choice');
        }
      } else {
        node('h3', 't03.followups', '4．三人後續與原票', controls);
        const review = node('details', 't03.review', '', controls);
        node('summary', 't03.reviewTitle', '回看原票（唯讀、不重新結算）', review);
        for (const ticket of state.tickets) node('p', 't03.original.' + ticket.id, ticket.name + '：固定 ' + ticket.fixedSeat + '・遊戲道具無效・' + (state.followupsAttached.includes(ticket.id) ? '後續已夾回' : '後續未夾回'), review);
        for (const ticket of state.tickets) {
          action(controls, 't03.followup.' + ticket.id, '查看 ' + ticket.name + '後續', 'view_followup', { ticket: ticket.id });
          if (state.followupsViewed.includes(ticket.id)) node('p', 't03.consequence.' + ticket.id, ticket.consequence, controls);
          if (!state.sealed) action(controls, 't03.attach.' + ticket.id, (state.followupsAttached.includes(ticket.id) ? '已夾回：' : '夾回原票：') + ticket.name, 'attach_followup', { ticket: ticket.id });
        }
        if (!state.sealed) action(controls, 't03.seal', '封存提案結果', 'seal');
        else node('p', 't03.complete', '提案工序完成。三人後果保留；未兌現演出、未退款、正式獎勵 0。返回查看不再發結果。', controls);
      }
      if (focused) Array.from(section.querySelectorAll('button')).find(n => n.dataset.focusKey === focused)?.focus({ preventScroll: true });
    }
    const api = { mount, unmount, dispatch, snapshot, reset,
      getPrivateCheckpoint: () => globalThis.FraudPrivateModuleSave.makeCheckpoint('T03', snapshot(), { identity, generation, sequence }) };
    return api;
  }
  return { create };
});
