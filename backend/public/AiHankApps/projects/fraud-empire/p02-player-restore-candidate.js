/* global document, window, fetch, Image, MutationObserver, performance, CustomEvent */
(() => {
  'use strict';
  const root = document.getElementById('demo'), stage = document.getElementById('demoStage');
  if (!root || !stage || document.getElementById('interactivePrototype')) return;
  const model = globalThis.FraudInteractiveModel;
  const el = (tag, text, cls) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; return n; };
  const plainButton = (label, handler, cls = '') => { const n = el('button', label, cls); n.type = 'button'; n.dataset.focusKey = label.replace('（已讀）', ''); n.addEventListener('click', handler); return n; };
  const panel = el('section', undefined, 'interactive-prototype'); panel.id = 'interactivePrototype'; panel.hidden = true; root.append(panel);
  const loadNote = el('p', '兩款互動原型載入中；六幅原圖參考仍可使用。', 'proto-load'); loadNote.setAttribute('role', 'status'); root.querySelector('.demo-toolbar').after(loadNote);
  const entry = plainButton('試玩兩款前端原型', () => enter(), 'demo-primary'); entry.id = 'interactivePrototypeEnter'; entry.disabled = true; root.querySelector('.demo-toolbar').append(entry);
  document.documentElement.dataset.interactiveReady = 'loading';
  if (!model) { loadNote.textContent = '互動規則未能載入；不以圖片切換冒稱可玩，原閱讀與六圖參考仍保留。'; document.documentElement.dataset.interactiveReady = 'false'; return; }
  let data, states, game = 'MG-P01', active = false, entering = false, lastSurface = 'legacy', coreSeen = Boolean(root.dataset.proposalContext), sequence = 0, notice = '', rejected = false, hudOpen = false, drag = null, suppressClickUntil = 0, modal = null;
  const timers = new Set();
  const resetButton = document.getElementById('demoReset');
  const dialog = el('dialog', undefined, 'proto-dialog'); dialog.id = 'interactivePrototypeDialog'; document.body.append(dialog);
  function captureFocus() {
    const node = document.activeElement;
    if (!node || !panel.contains(node)) return node?.id ? { outsideId: node.id } : null;
    const controls = [...panel.querySelectorAll('button, select')];
    return { key: node.dataset.focusKey, index: controls.indexOf(node) };
  }
  function restoreFocus(token) {
    if (!token || !active || dialog.open) return;
    if (token.outsideId) { document.getElementById(token.outsideId)?.focus({ preventScroll: true }); return; }
    const controls = [...panel.querySelectorAll('button, select')];
    const same = controls.find(node => node.dataset.focusKey === token.key);
    const next = same || controls[Math.min(Math.max(token.index, 0), controls.length - 1)];
    next?.focus({ preventScroll: true });
  }
  const session = () => globalThis.crypto?.randomUUID?.() || 'local-' + Date.now() + '-' + (++sequence);
  function leave(remember = false) { active = false; document.documentElement.classList.remove('interactive-prototype-active'); panel.hidden = true; stage.style.removeProperty('display'); resetButton.textContent = '重設 Demo'; if (!remember) lastSurface = 'legacy'; closeDialog(); clearDrag(); }
  function show() { active = true; document.documentElement.classList.add('interactive-prototype-active'); lastSurface = 'interactive'; panel.hidden = false; stage.style.display = 'none'; const reference = document.getElementById('newGameplayDemo'); if (reference) reference.hidden = true; resetButton.textContent = '重玩此 Demo（需確認）'; render(); }
  function enter(id) { if (!states) return; if (id && states[id]) game = id; entering = true; document.getElementById('demoEnter').click(); entering = false; show(); panel.querySelector('select')?.focus({ preventScroll: true }); panel.scrollIntoView({ block: 'start' }); }
  document.addEventListener('fraud:interactive-open', event => { if (['MG-P01', 'MG-P02'].includes(event.detail?.game)) enter(event.detail.game); });
  document.getElementById('demoEnter').addEventListener('click', () => { if (!entering) leave(); });
  document.getElementById('demoRead').addEventListener('click', () => leave(true));
  document.querySelector('.section-nav')?.addEventListener('click', event => leave(event.target.closest('a')?.getAttribute('href') !== '#demo'));
  document.addEventListener('fraud:demo-context', () => { if (!coreSeen) { coreSeen = true; return; } if (!entering) leave(); });
  window.addEventListener('hashchange', () => { if (window.location.hash === '#demo' && lastSurface === 'interactive' && states) show(); else if (window.location.hash !== '#demo' && active) leave(true); });
  resetButton.addEventListener('click', event => { if (!active) return; event.preventDefault(); event.stopImmediatePropagation(); requestReset(); }, true);
  function context() { const s = states[game]; return { game, session: s.session, revision: s.revision }; }
  function send(type, payload = {}, origin = context()) {
    if (!active || origin.game !== game) return { accepted: false };
    const command = { ...payload, type, id: origin.session + ':event-' + (++sequence), session: origin.session, revision: origin.revision };
    const outcome = model.apply(states[game], command); states[game] = outcome.state; notice = outcome.message; rejected = !outcome.accepted;
    if (outcome.counted) {
      const target = game, owner = states[target].session, eventId = command.id;
      const timer = window.setTimeout(() => { timers.delete(timer); if (states[target].session !== owner) return; states[target] = model.finishEvent(states[target], eventId); if (active && game === target) render(); }, 240); timers.add(timer);
    }
    render(); return outcome;
  }
  function actionButton(label, type, payload = {}, options = {}) {
    const origin = context(); const n = plainButton(label, () => send(type, payload, origin), options.primary ? 'proto-action is-primary' : 'proto-action');
    n.dataset.protoAction = type; for (const [key, value] of Object.entries(payload)) if (typeof value !== 'object') n.dataset[key] = String(value);
    const identity = Object.entries(payload).filter(([key]) => !(['place_job', 'place_piece', 'mark_duplicate', 'reveal_top_A'].includes(type) && ['job', 'piece', 'pair', 'ticket'].includes(key) && !(type === 'place_piece' && key === 'ticket')));
    n.dataset.focusKey = type + ':' + JSON.stringify(identity);
    if (options.unavailable || states[game].pendingEvent && !options.read) n.setAttribute('aria-disabled', 'true');
    if (options.drag) { n.dataset.dragKind = options.drag.kind; n.dataset.dragId = options.drag.id; n.dataset.revision = String(origin.revision); n.dataset.session = origin.session; n.classList.add('proto-draggable'); }
    return n;
  }
  function artBand(frame, y, height, cls) {
    const ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg'), image = document.createElementNS(ns, 'image');
    svg.setAttribute('viewBox', `0 ${y} 941 ${height}`); svg.setAttribute('width', '941'); svg.setAttribute('height', String(height)); svg.setAttribute('aria-hidden', 'true'); svg.classList.add('proto-art', cls); image.setAttribute('href', frame.src); image.setAttribute('width', '941'); image.setAttribute('height', String(frame.height)); svg.append(image); return svg;
  }
  function motif(kind, empty = false) {
    const ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg'), path = document.createElementNS(ns, 'path');
    svg.setAttribute('viewBox', '0 0 64 64'); svg.setAttribute('aria-hidden', 'true'); svg.classList.add('proto-motif');
    const paths = { moon: 'M48 5A28 28 0 1 0 55 49A27 27 0 0 1 48 5Z', star: 'M32 4L41 22L61 25L46 39L50 60L32 50L14 60L18 39L3 25L23 22Z', cloud: 'M12 51C-2 48 0 30 12 29C10 12 31 5 40 20C55 16 65 31 56 41C65 50 49 56 42 51Z', person: 'M24 7H40V12H45V29H40V36H49V42H55V60H9V42H15V36H24V29H19V12H24Z' };
    path.setAttribute('d', paths[kind] || paths.person); path.setAttribute('fill', empty ? 'none' : kind === 'person' ? '#5a4934' : '#dca84c'); path.setAttribute('stroke', empty ? '#e8bc65' : '#51402d'); path.setAttribute('stroke-width', empty ? '3' : '2'); if (empty) path.setAttribute('stroke-dasharray', '5 4'); svg.append(path); return svg;
  }
  function feedback(parent) { const note = el('p', notice || '點物件，再點目的地；可以取消。場景時鐘暫停，只有成功工作操作計步。', 'proto-feedback' + (rejected ? ' is-error' : '')); note.setAttribute('role', 'status'); parent.append(note); }
  function label(parent, title, text) { const block = el('div', undefined, 'proto-field'); block.append(el('strong', title), el('p', text)); parent.append(block); }
  function ticketCard(s, ticket, mode = 'tray', index = 0) {
    const card = el('article', undefined, 'proto-ticket' + (mode === 'stack' ? ' is-stacked' : '')); card.dataset.ticketId = ticket.id;
    if (mode === 'stack') { card.style.setProperty('--stack-index', String(index)); if (s.overlapRevealed && index === 1) card.classList.add('is-lifted'); }
    const selected = s.selectedTicket === ticket.id || s.selectedPair.includes(ticket.id);
    const pick = actionButton(ticket.name + ' · ' + ticket.fixedSeat, mode === 'tray' ? 'select_ticket' : 'select_pair', { ticket: ticket.id }, { drag: { kind: 'ticket', id: ticket.id }, unavailable: s.committed }); pick.classList.add('proto-ticket-face'); pick.setAttribute('aria-pressed', String(selected));
    pick.append(el('strong', ticket.name), motif('person'), el('span', '固定展示位 ' + ticket.fixedSeat, 'proto-seat-print'), el('span', '遊戲道具・無效', 'proto-invalid'));
    if (ticket.id === 'tao_ke' && !model.ticketComplete(s, ticket)) pick.append(motif('moon', true)); else pick.append(motif(ticket.id === 'fu_lin' ? 'star' : 'moon'));
    card.append(pick); return card;
  }
  function renderP01(board, s) {
    const summary = el('div', undefined, 'proto-board-heading'); summary.append(el('h4', '假兼職・真實工單狀態'), el('p', `第 ${s.round} 輪／工位 ${s.slots.filter(Boolean).length}／2／完成 ${s.completed.length}／3`)); board.append(summary);
    if (s.committed) board.append(el('p', '已交班，以下只讀。返回不重開、不重發結果。', 'proto-readonly'));
    if (s.activeView === 'result') {
      board.append(el('h4', '三份工作，沒有薪水'), el('p', '完成 3／3・退出 1 人・本局結果 ' + s.resultCount + '・獎勵 0'));
      for (const job of s.jobs) label(board, job.name, job.consequence);
      board.append(actionButton('返回工位（保留本局結果）', 'return_to_desk', {}, { read: true })); return;
    }
    const waiting = el('div', undefined, 'proto-job-tray'); waiting.dataset.drop = 'job-tray'; waiting.append(el('h5', '待排工單／尚未推進者可拖回撤回'));
    const cards = el('div', undefined, 'proto-job-cards');
    for (const job of s.jobs.filter(j => j.state === 'WAITING')) { const card = actionButton(job.name, 'select_job', { job: job.id }, { drag: { kind: 'job', id: job.id } }); card.classList.add('proto-job'); card.setAttribute('aria-pressed', String(s.selectedJob === job.id)); card.append(motif('person'), el('strong', job.name), el('small', '需 ' + job.requiredRounds + ' 輪')); cards.append(card); }
    if (!cards.children.length) cards.append(el('p', '沒有待排工單。')); waiting.append(cards); board.append(waiting);
    const slots = el('div', undefined, 'proto-slots');
    s.slots.forEach((id, slot) => {
      const item = el('div', undefined, 'proto-slot'); item.dataset.drop = 'job-slot'; item.dataset.slot = String(slot); item.append(el('h5', '工位 ' + (slot + 1)));
      if (!id) { const drop = actionButton('空槽 ' + (slot + 1) + '・點此放入', 'place_job', { job: s.selectedJob, slot }, { unavailable: !s.selectedJob || s.committed }); drop.dataset.drop = 'job-slot'; drop.dataset.slot = String(slot); item.append(drop); }
      else { const job = s.jobs.find(j => j.id === id); const card = actionButton(job.name + ' ' + job.progress + '／' + job.requiredRounds, 'select_job', { job: job.id }, { drag: { kind: 'job', id: job.id }, unavailable: job.state !== 'STAGED' }); card.classList.add('proto-job'); card.append(el('strong', job.name), el('span', job.progress + '／' + job.requiredRounds), el('small', job.state === 'STAGED' ? '尚未推進' : '已推進，不可撤回')); item.append(card, actionButton('工位 ' + (slot + 1) + ' 已占用・不能放入', 'place_job', { job: s.selectedJob, slot }, { unavailable: true }), actionButton('撤回 ' + job.name, 'remove_staged', { job: job.id }, { unavailable: job.state !== 'STAGED' })); }
      slots.append(item);
    }); board.append(slots);
    const controls = el('div', undefined, 'proto-controls'); controls.append(actionButton('推進一輪', 'advance_round', {}, { primary: true, unavailable: !s.slots.some(Boolean) || s.committed }), actionButton('取消選取', 'cancel_selection', {}, { read: true }), actionButton('交班一次', 'handoff', {}, { unavailable: s.phase !== 'READY_TO_HANDOFF' })); board.append(controls);
    if (!s.slots.some(Boolean) && s.phase === 'WORK') board.append(el('p', '先放至少一份工單；沒有空輪，也沒有三輪硬失敗。', 'proto-reason'));
    const completed = el('div', undefined, 'proto-completed'); completed.append(el('h5', '完成匣・退出不是操作失敗'));
    for (const id of s.completed) { const job = s.jobs.find(j => j.id === id); const row = el('div', undefined, 'proto-complete-row'); row.append(actionButton(job.name + (job.state === 'EXITED' ? '・已退出，不可回排' : '・已完成，不可回排'), 'select_job', { job: id }, { drag: { kind: 'job', id }, unavailable: true }), plainButton('查看 ' + job.name + '後果', () => { const out = send('view_job', { job: id }); if (out.accepted) showInfo(job.name, job.consequence); })); completed.append(row); } board.append(completed);
  }
  function renderP02(board, s) {
    const complete = s.tickets.filter(t => model.ticketComplete(s, t)).length, readonly = s.committed;
    board.append(el('h4', '假票券・固定無效遊戲道具'), el('p', `完整 ${complete}／3・活動缺口 ${s.piecePlacements.moon ? 1 : 0}／1・已留存 ${s.followupsAttached.length}／3`));
    const views = el('nav', undefined, 'proto-view-tabs'); views.setAttribute('aria-label', '同一局回看');
    for (const [view, name] of [['assembly', '拼片'], ['board', '展示板'], ['choice', '故事選擇'], ['follow_up', '人物後續'], ['result', '本局結果']]) { const control = actionButton(name + (readonly && ['assembly', 'board', 'choice'].includes(view) ? '・唯讀' : ''), 'navigate', { view }, { read: true, unavailable: !s.visited.includes(view) }); control.setAttribute('aria-pressed', String(s.activeView === view)); views.append(control); } board.append(views);
    if (readonly) board.append(el('p', '故事已提交，拼片／板位／選擇只能回看。當前分支：' + choiceLabel(s.committedChoice), 'proto-readonly'));
    if (s.activeView === 'assembly' || s.activeView === 'expectations') {
      const tickets = el('div', undefined, 'proto-assembly-tickets');
      for (const ticket of s.tickets) { const row = el('div', undefined, 'proto-ticket-work'); row.append(ticketCard(s, ticket)); const hole = actionButton(ticket.id === 'tao_ke' ? s.piecePlacements.moon ? '陶可月牙已補入' : '陶可月牙缺口・點此放片' : ticket.name + '預裝固定，沒有活動缺口', 'place_piece', { piece: s.selectedPiece, ticket: ticket.id }, { unavailable: readonly || ticket.id !== 'tao_ke' || Boolean(s.piecePlacements.moon) }); hole.dataset.drop = 'piece-hole'; hole.dataset.ticket = ticket.id; row.append(hole, actionButton(ticket.id === 'tao_ke' ? '撤回陶可月片' : '預裝圖案不可拆', 'remove_piece', { ticket: ticket.id }, { unavailable: readonly || ticket.id !== 'tao_ke' || !s.piecePlacements.moon })); tickets.append(row); } board.append(tickets);
      const pieces = el('div', undefined, 'proto-pieces'); pieces.append(el('h5', '預製拼片・點片再點缺口，也可拖曳'));
      for (const piece of s.pieces.filter(p => !s.piecePlacements[p.id])) { const pick = actionButton(piece.shape, 'select_piece', { piece: piece.id }, { drag: { kind: 'piece', id: piece.id }, unavailable: readonly }); pick.classList.add('proto-piece'); pick.setAttribute('aria-pressed', String(s.selectedPiece === piece.id)); pick.prepend(motif(piece.id)); pieces.append(pick); } pieces.append(actionButton('取消選取', 'cancel_selection', {}, { read: true })); board.append(pieces);
      board.append(actionButton('前往展示板', 'navigate', { view: 'board' }, { read: true, unavailable: !s.visited.includes('board') }));
    } else if (s.activeView === 'board') {
      const tray = el('div', undefined, 'proto-ticket-tray'); tray.dataset.drop = 'ticket-tray'; tray.append(el('h5', '原道具托盤・板上票可拖回這裡'));
      for (const ticket of s.tickets.filter(t => !model.position(s, t.id))) tray.append(ticketCard(s, ticket)); board.append(tray);
      const positions = el('div', undefined, 'proto-board-positions');
      for (const seat of ['A', 'B']) { const spot = el('div', undefined, 'proto-board-seat'); spot.dataset.drop = 'ticket-seat'; spot.dataset.seat = seat; spot.append(el('h5', seat + ' 展示位（不是場館座位）')); const place = actionButton('放入所選原票到 ' + seat, 'place_ticket', { ticket: s.selectedTicket, seat }, { unavailable: readonly || !s.selectedTicket }); place.dataset.drop = 'ticket-seat'; place.dataset.seat = seat; if (!readonly && s.selectedTicket) place.style.zIndex = '2'; spot.append(place); const stack = el('div', undefined, 'proto-stack'); for (const [i, id] of s.boardStacks[seat].entries()) stack.append(ticketCard(s, s.tickets.find(t => t.id === id), 'stack', i)); spot.append(stack); positions.append(spot); } board.append(positions);
      const upper = s.boardStacks.A.at(-1); const lift = actionButton('抬起目前上卡' + (upper ? '：' + s.tickets.find(t => t.id === upper).name : ''), 'reveal_top_A', { ticket: upper }, { unavailable: readonly || s.boardStacks.A.length !== 2 || s.overlapRevealed }); lift.dataset.drop = 'reveal-top'; board.append(lift);
      if (s.overlapRevealed) board.append(el('p', '已露出上下兩個名字：' + s.boardStacks.A.map(id => s.tickets.find(t => t.id === id).name).join(' → ') + '。同一個 A，答應兩個人。', 'proto-proof'));
      const pair = el('div', undefined, 'proto-pair'); pair.append(el('h5', '選兩個名字，標記原票上的矛盾'));
      for (const ticket of s.tickets) { const pick = actionButton(ticket.name + ' · ' + ticket.fixedSeat, 'select_pair', { ticket: ticket.id }, { unavailable: readonly }); pick.setAttribute('aria-pressed', String(s.selectedPair.includes(ticket.id))); pair.append(pick); } pair.append(actionButton('標記所選兩張', 'mark_duplicate', { pair: s.selectedPair.slice() }, { primary: true, unavailable: readonly || s.duplicateMarked }), actionButton('清除標記', 'clear_duplicate', {}, { unavailable: readonly || !s.duplicateMarked })); board.append(pair);
      const back = el('div', undefined, 'proto-controls'); for (const ticket of s.tickets) back.append(actionButton('取回 ' + ticket.name + '原票', 'take_back_ticket', { ticket: ticket.id }, { unavailable: readonly || !model.position(s, ticket.id) })); board.append(back);
    } else if (s.activeView === 'choice') {
      board.append(el('h4', readonly ? '已提交的故事選擇（唯讀）' : '先預覽，再確認；取消不提交'));
      for (const choice of data.choices) board.append(plainButton('預覽：' + choice.label, () => { const out = send('preview_choice', { choice: choice.id }); if (out.accepted) showChoice(); }, 'proto-action'));
    } else if (s.activeView === 'follow_up') {
      board.append(el('h4', '三個名字，逐一讀取並夾回原票'));
      for (const ticket of s.tickets) { const row = el('article', undefined, 'proto-followup'); row.append(el('h5', ticket.name + ' · ' + ticket.fixedSeat + ' · 遊戲道具・無效'), el('p', s.followupsAttached.includes(ticket.id) ? '已夾回同一原票：' + ticket.consequence : '尚未夾回原票'), plainButton('查看 ' + ticket.name + '後續', () => { const out = send('view_followup', { ticket: ticket.id }); if (out.accepted) showInfo(ticket.name + '後續', ticket.consequence, ticket.id); }, 'proto-action'), actionButton('夾回 ' + ticket.name + '原票', 'attach_followup', { ticket: ticket.id }, { unavailable: !s.followupsViewed.includes(ticket.id) || s.followupsAttached.includes(ticket.id) })); board.append(row); }
      board.append(actionButton('封存本批一次', 'seal', {}, { primary: true, unavailable: s.followupsAttached.length !== 3 || s.sealed }));
    } else if (s.activeView === 'result') {
      board.append(el('h4', '本局唯一封存結果'), el('p', '分支：' + choiceLabel(s.committedChoice) + '／結果 ' + s.resultCount + '／獎勵 0'));
      for (const ticket of s.tickets) { const record = el('article', undefined, 'proto-result-ticket'); record.append(el('strong', ticket.name + ' · 固定 ' + ticket.fixedSeat), el('span', '遊戲道具・無效', 'proto-invalid'), el('p', ticket.consequence)); board.append(record); }
      board.append(el('p', '三張都不能入場；沒有新增退款、獲救或付款。', 'proto-proof'), actionButton('返回展示板（本局唯讀）', 'navigate', { view: 'board' }, { read: true }));
    }
    const reading = el('div', undefined, 'proto-reading');
    for (const ticket of s.tickets) reading.append(plainButton('查看 ' + ticket.name + '期待' + (s.expectationsViewed.includes(ticket.id) ? '（已讀）' : ''), () => { const out = send('view_expectation', { ticket: ticket.id }); if (out.accepted) showInfo(ticket.name + '的固定期待', data.fixtures['MG-P02'].expectation); }, 'proto-action'));
    reading.append(plainButton('翻看模型支架' + (s.modelInspected ? '（已讀）' : ''), () => { const out = send('inspect_model'); if (out.accepted) showInfo('空支架／未接線', '模型不是場館，三張道具都不能入場。', null, true); }, 'proto-action')); board.append(reading);
    if (!s.committed) { const missing = model.proofMissing(s); const list = el('div', undefined, 'proto-missing'); list.append(el('h5', missing.length ? '還缺以下項目，不能提交故事' : '原物件與三人期待已核對，可預覽故事選擇')); for (const value of missing) list.append(el('p', '・' + value)); if (!missing.length) list.append(actionButton('前往故事選擇', 'navigate', { view: 'choice' }, { read: true })); board.append(list); }
  }
  function choiceLabel(id) { return data.choices.find(c => c.id === id)?.label || '尚未提交'; }
  function render() {
    if (!states || !active) return;
    const focused = captureFocus();
    const s = states[game], fixture = data.fixtures[game]; panel.replaceChildren(); panel.hidden = false;
    Object.assign(panel.dataset, { game, phase: s.phase, view: s.activeView, logicalStep: String(s.logicalStep), resultCount: String(s.resultCount), awardedReward: String(s.awardedReward), busy: String(Boolean(s.pendingEvent)), revision: String(s.revision) });
    const head = el('div', undefined, 'section-heading'); head.append(el('h3', '兩款可操作前端原型'), el('p', '不再靠切圖通關；正式機制與平衡仍是提案。')); panel.append(head, el('p', data.sessionNotice + ' ' + data.resourceNotice, 'proposal-note'));
    const controls = el('div', undefined, 'proto-global-controls'), selectLabel = el('label', '切換獨立原型'), select = el('select'); select.id = 'interactiveGameSelect'; select.setAttribute('aria-label', '切換獨立原型');
    select.dataset.focusKey = 'game-select';
    for (const [id, f] of Object.entries(data.fixtures)) { const option = el('option', id + ' · ' + f.title); option.value = id; select.append(option); } select.value = game; select.addEventListener('change', () => { clearDrag(); closeDialog(); game = select.value; notice = ''; rejected = false; render(); }); selectLabel.append(select); controls.append(selectLabel, plainButton('重玩此 Demo（只清本題）', requestReset, 'proto-action'), plainButton('返回原有 Demo（保留本頁進度）', () => { leave(); stage.scrollIntoView({ block: 'start' }); }, 'proto-action')); panel.append(controls);
    for (const [id, name] of [['MG-P01', '工單原型'], ['MG-P02', '票券原型']]) { const change = plainButton('切換：' + name, () => { clearDrag(); closeDialog(); game = id; notice = ''; rejected = false; render(); }, 'proto-action'); change.dataset.switchGame = id; change.dataset.focusKey = 'switch-' + id; change.setAttribute('aria-pressed', String(game === id)); controls.append(change); }
    const metrics = el('div', undefined, 'proto-metrics'); metrics.append(el('span', `第 ${s.clock.day} 天 ${s.clock.time}・時鐘暫停`), el('strong', 'Demo 邏輯步數 ' + s.logicalStep), el('span', '結果 ' + s.resultCount + '／獎勵 ' + s.awardedReward)); panel.append(metrics, el('p', data.stepNotice + '；兩題不共用連續日程。', 'proto-reason'));
    const canvas = el('div', undefined, 'proto-canvas');
    const hud = el('div', undefined, 'proto-hud'); hud.append(artBand(fixture.art[0], 0, 160, 'proto-hud-art'), plainButton('展開 HUD 說明', () => { hudOpen = !hudOpen; render(); }, 'proto-hud-toggle')); canvas.append(hud);
    if (hudOpen) canvas.append(el('p', 'HUD 為既定像素美術示意；場景時鐘暫停。正式體力、心情、飽食與金錢不連動，獎勵固定 0。', 'proto-hud-description'));
    const artIndex = s.resultCount || s.game === 'MG-P02' && s.committed ? 2 : s.logicalStep ? 1 : 0;
    canvas.append(artBand(fixture.art[artIndex], 160, fixture.officeEnd - 160, 'proto-office-art'));
    const board = el('div', undefined, 'proto-live-board'); board.dataset.liveObjects = 'true';
    if (s.game === 'MG-P01') renderP01(board, s); else renderP02(board, s); feedback(board); canvas.append(board);
    const bottom = el('div', undefined, 'proto-bottom'); bottom.append(artBand(fixture.art[0], 1536, 136, 'proto-bottom-art')); const nav = el('div', undefined, 'proto-unavailable-nav'); for (const name of ['角色', '道具', '信箱', '設定']) { const b = plainButton('', () => showInfo(name, '此 Demo 未開放。只有上方工作區為本輪互動原型。')); b.dataset.focusKey = 'unavailable-' + name; b.setAttribute('aria-label', name + '（此 Demo 未開放）'); nav.append(b); } bottom.append(nav); canvas.append(bottom, el('p', '底部角色／道具／信箱／設定：此 Demo 未開放。', 'proto-bottom-note')); panel.append(canvas);
    restoreFocus(focused);
  }
  function openDialog(title, text, kind, extra) {
    dialog.replaceChildren(); modal = { kind, game, session: states[game].session, focus: captureFocus() }; const h = el('h3', title); h.id = 'interactiveDialogTitle'; dialog.setAttribute('aria-labelledby', h.id); dialog.append(h, el('p', text)); if (extra) extra(dialog); dialog.append(plainButton(kind === 'reset' || kind === 'choice' ? '取消，不提交' : '關閉，回到同一局', () => closeDialog(), 'proto-action')); if (!dialog.open) dialog.showModal();
  }
  function closeDialog(confirmed = false) {
    if (!modal) return;
    const old = modal; modal = null;
    if (confirmed && states?.[old.game]?.pendingEvent) suppressClickUntil = Math.max(suppressClickUntil, performance.now() + 240);
    if (!confirmed && old.kind === 'choice' && states?.[old.game]?.session === old.session && !states[old.game].committed && states[old.game].pendingChoice) { const current = states[old.game]; const out = model.apply(current, { type: 'cancel_choice', id: current.session + ':event-' + (++sequence), session: current.session, revision: current.revision }); states[old.game] = out.state; if (active && game === old.game) { notice = out.message; render(); } }
    if (dialog.open) dialog.close();
    restoreFocus(old.focus);
  }
  dialog.addEventListener('cancel', event => { event.preventDefault(); closeDialog(); });
  function requestReset() {
    if (!states || !active) return;
    const target = game, owner = states[target].session;
    openDialog('只重玩目前這一題？', '只清除此款本頁 Demo 的步數、選擇與本局結果；另一款進度及正式資料不動。取消會保留目前狀態。', 'reset', parent => parent.append(plainButton('確認重玩此題', () => { if (game !== target || states[target].session !== owner) return; clearDrag(); states[target] = model.create(target, session(), data); notice = '已建立本題新局；另一題完全保留。'; rejected = false; closeDialog(true); render(); }, 'proto-action is-primary')));
  }
  function showChoice() {
    const s = states[game]; openDialog('確認前預覽：' + choiceLabel(s.pendingChoice), '陶可失望、畢安憤怒、芙琳尚未成行，兩分支都保留。此確認是本頁故事提交點；不退款、不入場、不發獎，正式後果仍是提案。', 'choice', parent => parent.append(plainButton('確認提交這個選擇', () => { const out = send('confirm_choice'); if (out.accepted) closeDialog(true); }, 'proto-action is-primary')));
  }
  function showInfo(title, text, followup, showModel = false) {
    openDialog(title, text, 'info', parent => { if (showModel) { const crop = artBand(data.fixtures['MG-P02'].art[1], 430, 230, 'proto-model-inspection'); crop.setAttribute('viewBox', '635 430 306 230'); crop.setAttribute('width', '306'); crop.setAttribute('height', '230'); parent.append(crop); } if (followup) parent.append(plainButton('夾回 ' + states[game].tickets.find(t => t.id === followup).name + '原票', () => { const out = send('attach_followup', { ticket: followup }); if (out.accepted) closeDialog(true); }, 'proto-action is-primary')); });
  }
  function clearDrag() { if (drag?.ghost) drag.ghost.remove(); drag = null; }
  panel.addEventListener('pointerdown', event => { const target = event.target.closest('[data-drag-kind]'); if (!target || event.pointerType === 'touch' || event.button !== 0 || !active) return; drag = { kind: target.dataset.dragKind, id: target.dataset.dragId, session: target.dataset.session, revision: Number(target.dataset.revision), game, startX: event.clientX, startY: event.clientY, node: target, ghost: null, moved: false }; });
  document.addEventListener('pointermove', event => { if (!drag || !active) return; if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 6) return; if (!drag.ghost) { drag.ghost = drag.node.cloneNode(true); drag.ghost.id = 'interactiveDragGhost'; drag.ghost.classList.add('proto-drag-ghost'); drag.ghost.setAttribute('aria-hidden', 'true'); document.body.append(drag.ghost); } drag.moved = true; drag.ghost.style.left = event.clientX + 12 + 'px'; drag.ghost.style.top = event.clientY + 12 + 'px'; });
  document.addEventListener('pointerup', event => {
    if (!drag) return; const item = drag, target = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-drop]'); clearDrag(); if (!item.moved) return; suppressClickUntil = performance.now() + 180;
    const origin = { game: item.game, session: item.session, revision: item.revision };
    if (!target || !panel.contains(target)) { notice = '沒有放到有效目的地，物件仍在原位；步數不變。'; rejected = true; render(); return; }
    if (item.kind === 'job' && target.dataset.drop === 'job-slot') send('place_job', { job: item.id, slot: Number(target.dataset.slot) }, origin);
    else if (item.kind === 'job' && target.dataset.drop === 'job-tray') send('remove_staged', { job: item.id }, origin);
    else if (item.kind === 'piece' && target.dataset.drop === 'piece-hole') send('place_piece', { piece: item.id, ticket: target.dataset.ticket }, origin);
    else if (item.kind === 'ticket' && target.dataset.drop === 'ticket-seat') send('place_ticket', { ticket: item.id, seat: target.dataset.seat }, origin);
    else if (item.kind === 'ticket' && target.dataset.drop === 'ticket-tray') send('take_back_ticket', { ticket: item.id }, origin);
    else if (item.kind === 'ticket' && target.dataset.drop === 'reveal-top') send('reveal_top_A', { ticket: item.id }, origin);
    else { notice = '這不是此物件的目的地，沒有增加步數。'; rejected = true; render(); }
  });
  document.addEventListener('pointercancel', clearDrag); window.addEventListener('blur', clearDrag);
  panel.addEventListener('click', event => { if (performance.now() < suppressClickUntil) { event.preventDefault(); event.stopImmediatePropagation(); } }, true);
  document.addEventListener('keydown', event => { if (!active) return; if (event.repeat && event.target.closest?.('[data-proto-action]')) event.preventDefault(); if (event.key === 'Escape' && !dialog.open) { clearDrag(); send('cancel_selection'); } });
  async function preload(source) { await Promise.all(Object.values(source.fixtures).flatMap(f => f.art).map(frame => new Promise((resolve, reject) => { const img = new Image(); const timeout = window.setTimeout(() => reject(new Error('Art preload timeout')), 30000); img.onload = () => { window.clearTimeout(timeout); resolve(); }; img.onerror = () => { window.clearTimeout(timeout); reject(new Error('Art unavailable')); }; img.src = frame.src; }))); }
  fetch('interactive-prototype-data.json').then(response => { if (!response.ok) throw new Error('Prototype data unavailable'); return response.json(); }).then(async source => {
    if (!model.validate(source)) throw new Error('Prototype contract mismatch'); await preload(source); data = source; states = { 'MG-P01': model.create('MG-P01', session(), data), 'MG-P02': model.create('MG-P02', session(), data) };
    loadNote.textContent = data.status + '。' + data.sessionNotice; entry.disabled = false;
    const hero = plainButton('試玩兩款前端原型', () => enter(), 'button primary'); hero.id = 'interactivePrototypeHero'; const actions = document.querySelector('.hero-actions');
    if (actions) { actions.prepend(hero); new MutationObserver(() => { if (actions.firstElementChild !== hero) actions.prepend(hero); }).observe(actions, { childList: true }); }
    window.FraudInteractiveDemo = Object.freeze({
      getSnapshot: id => model.clone(states[id || game]), getActiveGame: () => game,
      validateP02Snapshot: snapshot => globalThis.FraudPrototypeSnapshot?.validateP02(snapshot, data, model) || { valid: false, code: 'snapshot-validator-unavailable', preserve: true },
      restoreP02Snapshot(snapshot) {
        const check = globalThis.FraudPrototypeSnapshot?.validateP02(snapshot, data, model);
        if (!check?.valid) return { accepted: false, code: check?.code || 'snapshot-validator-unavailable', preserve: true };
        if (states['MG-P02'].pendingEvent || modal) return { accepted: false, code: 'prototype-busy', preserve: true };
        states['MG-P02'] = model.clone(check.snapshot); sequence = Math.max(sequence, check.maxEventSequence);
        notice = ''; rejected = false; clearDrag(); if (active && game === 'MG-P02') render();
        document.dispatchEvent(new CustomEvent('fraud:prototype-restored', { detail: { game: 'MG-P02', session: snapshot.session, revision: snapshot.revision } }));
        return { accepted: true, game: 'MG-P02', session: snapshot.session, revision: snapshot.revision };
      }
    });
    document.documentElement.dataset.interactiveReady = 'true';
    document.dispatchEvent(new CustomEvent('fraud:interactive-ready'));
  }).catch(() => { loadNote.textContent = '互動原型資料或美術未能完整載入，不以空白或換圖冒稱可玩；原有六圖參考與閱讀仍可使用。'; loadNote.setAttribute('role', 'alert'); document.documentElement.dataset.interactiveReady = 'false'; });
})();
