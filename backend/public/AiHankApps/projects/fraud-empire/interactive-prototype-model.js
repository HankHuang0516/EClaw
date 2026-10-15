/* Pure, page-local prototype rules. No clock, storage, network or production resources. */
((root, factory) => {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FraudInteractiveModel = api;
})(globalThis, () => {
  'use strict';
  const clone = value => JSON.parse(JSON.stringify(value));
  const terminal = job => ['COMPLETED', 'EXITED'].includes(job.state);
  const add = (array, value) => array.includes(value) ? array : array.concat(value);
  function validate(data) {
    const a = data?.fixtures?.['MG-P01'], b = data?.fixtures?.['MG-P02'];
    return data?.schemaVersion === 1 && a?.jobs?.map(j => j.id + ':' + j.requiredRounds).join(',') === 'fang_cen:2,mi_luo:1,duo_na:1' && b?.tickets?.map(t => t.id + ':' + t.fixedSeat + ':' + t.initialComplete).join(',') === 'tao_ke:A:false,bi_an:A:true,fu_lin:B:true' && ['MG-P01', 'MG-P02'].every(id => data.fixtures[id].art?.length === 3 && data.fixtures[id].art.every(a => /^proposal-demos\/[a-f0-9]{20}\.png$/.test(a.src)));
  }
  function create(game, session, data) {
    const fixture = data.fixtures[game];
    const state = { game, session, revision: 0, processed: [], pendingEvent: null, logicalStep: 0, resultCount: 0, resultId: null, awardedReward: 0, committed: false, clock: clone(fixture.clock), selectedJob: null, selectedPiece: null, selectedTicket: null, selectedPair: [] };
    if (game === 'MG-P01') Object.assign(state, { jobs: clone(fixture.jobs), slots: [null, null], completed: [], round: 0, phase: 'WORK', activeView: 'work', visited: ['work'] });
    else Object.assign(state, { tickets: clone(fixture.tickets), pieces: clone(fixture.pieces), piecePlacements: {}, boardStacks: { A: [], B: [] }, overlapRevealed: false, modelInspected: false, duplicateMarked: false, expectationsViewed: [], pendingChoice: null, committedChoice: null, followupsViewed: [], followupsAttached: [], sealed: false, phase: 'ASSEMBLY', activeView: 'assembly', visited: ['assembly', 'expectations'] });
    return state;
  }
  function ticketComplete(state, ticket) { return ticket.initialComplete || state.piecePlacements.moon === ticket.id; }
  function position(state, id) { return ['A', 'B'].find(seat => state.boardStacks[seat].includes(id)) || null; }
  function proofMissing(state) {
    if (state.game !== 'MG-P02') return [];
    const missing = [];
    if (!state.tickets.every(t => ticketComplete(state, t))) missing.push('陶可月牙缺口未補好');
    if (!state.tickets.every(t => position(state, t.id) === t.fixedSeat)) missing.push('三張原票尚未在正確 A／A／B 展示位');
    if (!state.overlapRevealed) missing.push('雙 A 尚未揭開');
    if (!state.modelInspected) missing.push('尚未翻看模型支架');
    if (!state.duplicateMarked) missing.push('尚未正確標記陶可＋畢安');
    if (state.expectationsViewed.length !== 3) missing.push('尚未讀取三人的期待');
    return missing;
  }
  function phase(state) {
    if (state.game === 'MG-P01') return state.resultCount ? 'RESULT' : state.jobs.every(terminal) ? 'READY_TO_HANDOFF' : 'WORK';
    return state.sealed ? 'RESULT' : state.committedChoice ? 'FOLLOW_UP' : state.piecePlacements.moon !== 'tao_ke' ? 'ASSEMBLY' : proofMissing(state).length ? 'BOARD' : 'CHOICE';
  }
  function finishEvent(state, eventId) {
    if (state.pendingEvent?.id !== eventId || state.pendingEvent.session !== state.session) return state;
    return { ...state, pendingEvent: null };
  }
  function apply(state, command) {
    const reject = message => ({ state, accepted: false, counted: false, message });
    if (!command || command.session !== state.session || command.revision !== state.revision || typeof command.id !== 'string' || state.processed.includes(command.id)) return reject('過期、重送或重複指令已忽略；沒有再次結算。');
    const readActions = ['navigate', 'cancel_selection', 'view_job', 'view_expectation', 'inspect_model', 'view_followup', 'return_to_desk'];
    if (state.pendingEvent && !readActions.includes(command.type)) return reject('這個操作正在處理，請等完成後再進行下一次操作。');
    const next = clone(state); let delta = 0, message = '';
    const job = next.jobs?.find(j => j.id === command.job), ticket = next.tickets?.find(t => t.id === command.ticket);
    const readonly = '本批故事已提交，只能回看；如要重玩，請確認重設此題。';
    if (command.type === 'cancel_selection') {
      next.selectedJob = null; next.selectedPiece = null; next.selectedTicket = null; next.selectedPair = []; message = '已取消選取，沒有增加步數。';
    } else if (command.type === 'navigate') {
      if (!next.visited.includes(command.view)) return reject('尚未到達這個畫面；請先完成目前工序。');
      next.activeView = command.view; message = next.committed ? '回看同一局，已提交內容為唯讀。' : '回看同一局，不倒退進度、不結算。';
    } else if (next.game === 'MG-P01') {
      if (command.type === 'view_job') { if (!job) return reject('沒有這份原工單。'); message = terminal(job) ? job.consequence : job.name + '需 ' + job.requiredRounds + ' 輪，當前 ' + job.progress + '／' + job.requiredRounds + '。'; }
      else if (command.type === 'return_to_desk') { if (!next.committed) return reject('本批尚未交班。'); next.activeView = 'work'; message = '返回同一工位，三張結果保留；不重新開局。'; }
      else {
        if (next.committed) return reject(readonly);
        switch (command.type) {
        case 'select_job':
          if (!job || !['WAITING', 'STAGED'].includes(job.state)) return reject('已處理／退出的工單不可回排；已推進的工單請繼續處理。');
          next.selectedJob = job.id; message = job.state === 'STAGED' ? '這份尚未推進，可用撤回入口。' : '已選 ' + job.name + '，請點空工位。'; break;
        case 'place_job':
          if (!job || job.state !== 'WAITING' || ![0, 1].includes(command.slot) || next.slots[command.slot]) return reject('先等這個槽完成釋出；同一工單不能占兩槽，請選待排工單與空槽。');
          next.slots[command.slot] = job.id; job.state = 'STAGED'; next.selectedJob = null; delta = 1; message = job.name + '已進工位，尚未推進。'; break;
        case 'remove_staged':
          if (!job || job.state !== 'STAGED' || job.progress !== 0) return reject('已推進的工作不能撤回；可繼續處理或重玩此 Demo。');
          next.slots = next.slots.map(id => id === job.id ? null : id); job.state = 'WAITING'; next.selectedJob = null; delta = 1; message = job.name + '已回待排區，沒有倒退已做工作。'; break;
        case 'advance_round': {
          if (!next.slots.some(Boolean) || next.jobs.every(terminal)) return reject('請先放入至少一份工單；沒有空槽工作可推進。');
          const current = next.slots.slice(); next.round += 1;
          for (const id of current.filter(Boolean)) { const item = next.jobs.find(j => j.id === id); item.progress = Math.min(item.requiredRounds, item.progress + 1); item.state = item.progress === item.requiredRounds ? item.id === 'mi_luo' ? 'EXITED' : 'COMPLETED' : 'IN_PROGRESS'; if (terminal(item)) { next.completed = add(next.completed, id); next.slots = next.slots.map(value => value === id ? null : value); } }
          next.selectedJob = null; delta = 1; message = '第 ' + next.round + ' 個非空輪完成；只推進本輪開始時已在槽的工單。'; break;
        }
        case 'handoff':
          if (!next.jobs.every(terminal) || next.slots.some(Boolean) || next.resultCount !== 0) return reject('仍有未處理工單，請先完成；本批已交班則只能回看。');
          next.committed = true; next.resultCount = 1; next.resultId = next.session + ':P01-result'; next.activeView = 'result'; delta = 1; message = '本批只交班一次：三張結果、退出一人、獎勵 0。'; break;
        default: return reject('此 Demo 沒有這個工作操作。');
        }
      }
    } else {
      const canRead = ['view_expectation', 'inspect_model', 'view_followup'].includes(command.type);
      const afterCommit = ['view_followup', 'attach_followup', 'seal'].includes(command.type);
      if (next.committed && !canRead && !afterCommit) return reject(readonly);
      switch (command.type) {
      case 'view_expectation':
        if (!ticket) return reject('沒有這張原票。'); next.expectationsViewed = add(next.expectationsViewed, ticket.id); message = ticket.name + '的期待已讀；閱讀不增加步數。'; break;
      case 'inspect_model': next.modelInspected = true; message = '模型不是場館，三張道具都不能入場；空支架與未接線已看過。'; break;
      case 'select_piece':
        if (!next.pieces.some(p => p.id === command.piece) || next.piecePlacements[command.piece]) return reject('此片已拼入原票，先撤回才能重放。');
        next.selectedPiece = command.piece; message = '已選拼片，請點陶可的活動缺口；可以取消。'; break;
      case 'place_piece':
        if (command.piece !== 'moon' || !ticket || ticket.id !== 'tao_ke' || next.piecePlacements.moon) return reject('星／雲形狀不符，拼片回原位；畢安／芙琳已完整且沒有活動缺口；月片只能用一次。');
        next.piecePlacements.moon = 'tao_ke'; next.selectedPiece = null; next.activeView = 'board'; delta = 1; message = '陶可已補月牙，三票完整 3／3，現在可放展示板。'; break;
      case 'remove_piece':
        if (!ticket || ticket.id !== 'tao_ke' || !next.piecePlacements.moon) return reject('畢安／芙琳預裝圖案不能撤回；只有自己補入的陶可月片可撤。');
        if (position(next, ticket.id)) return reject('請先把陶可從展示板取回，再撤回月片。');
        delete next.piecePlacements.moon; next.selectedPiece = null; next.pendingChoice = null; next.activeView = 'assembly'; delta = 1; message = '月片回托盤，完整數回 2／3；預裝圖案不變。'; break;
      case 'select_ticket':
        if (!ticket) return reject('請選一張原票。'); next.selectedTicket = ticket.id; message = '已選 ' + ticket.name + '原票，請點固定 ' + ticket.fixedSeat + ' 展示位。'; break;
      case 'place_ticket':
        if (!next.tickets.every(t => ticketComplete(next, t))) return reject('請先補好陶可月牙，讓三票完整。');
        if (!ticket || position(next, ticket.id) || ticket.fixedSeat !== command.seat) return reject('票面固定 A／B，不能放另一位置或複製同一原票。');
        next.boardStacks[command.seat].push(ticket.id); next.selectedTicket = null; delta = 1; message = ticket.name + '已放 ' + command.seat + '；堆疊依實際放入次序。'; break;
      case 'take_back_ticket': {
        const seat = ticket && position(next, ticket.id); if (!seat) return reject('這張票目前不在展示板。');
        next.boardStacks[seat] = next.boardStacks[seat].filter(id => id !== ticket.id); if (seat === 'A') { next.overlapRevealed = false; next.duplicateMarked = false; next.selectedPair = []; next.pendingChoice = null; } next.selectedTicket = null; delta = 1; message = '原票已取回；移動 A 票會清除舊揭開與標記。'; break;
      }
      case 'reveal_top_A':
        if (next.boardStacks.A.length !== 2) return reject('請先把兩張 A 票放到 A 展示位。');
        if (next.overlapRevealed) return reject('雙 A 已揭開，可回看，不重複計步。');
        if (command.ticket && command.ticket !== next.boardStacks.A[1]) return reject('請抬起實際上卡，不是下卡。');
        next.overlapRevealed = true; delta = 1; message = '已抬起 ' + next.tickets.find(t => t.id === next.boardStacks.A[1]).name + '，露出下層 ' + next.tickets.find(t => t.id === next.boardStacks.A[0]).name + '；同一 A 答應兩人。'; break;
      case 'select_pair':
        if (!ticket) return reject('請選原票上的人名。'); next.selectedPair = next.selectedPair.includes(ticket.id) ? next.selectedPair.filter(id => id !== ticket.id) : next.selectedPair.length < 2 ? next.selectedPair.concat(ticket.id) : [next.selectedPair[1], ticket.id]; message = '已選 ' + next.selectedPair.length + '／2 個名字，尚未標記。'; break;
      case 'mark_duplicate':
        if (next.duplicateMarked) return reject('已標記，不重複計步。');
        if (!Array.isArray(command.pair) || command.pair.length !== 2 || !['tao_ke', 'bi_an'].every(id => command.pair.includes(id))) return reject('B 不是重複承諾，請回看雙 A；應是陶可＋畢安。');
        if (!next.overlapRevealed) return reject('請先揭開雙 A，不能憑未查看的疊票提交。');
        next.duplicateMarked = true; delta = 1; message = '兩張原 A 票已同時標記矛盾；B 仍是展示位。'; break;
      case 'clear_duplicate':
        if (!next.duplicateMarked) return reject('目前沒有可清除的標記。'); next.duplicateMarked = false; next.pendingChoice = null; next.selectedPair = []; delta = 1; message = '標記已清除，原票沒有刪除。'; break;
      case 'preview_choice':
        if (proofMissing(next).length) return reject('尚缺：' + proofMissing(next).join('、'));
        if (!['return_marked', 'pause_batch'].includes(command.choice)) return reject('沒有這個故事選擇。'); next.pendingChoice = command.choice; message = '只預覽，尚未提交；三人落空後果都會保留。'; break;
      case 'cancel_choice': next.pendingChoice = null; message = '已取消預覽，沒有提交故事或增加步數。'; break;
      case 'confirm_choice':
        if (proofMissing(next).length || !['return_marked', 'pause_batch'].includes(next.pendingChoice) || next.committedChoice) return reject('先完成缺項並預覽選擇；本批已選擇則只能回看。');
        next.committedChoice = next.pendingChoice; next.pendingChoice = null; next.committed = true; next.selectedPiece = null; next.selectedTicket = null; next.selectedPair = []; next.activeView = 'follow_up'; delta = 1; message = '選擇已固定，只存在本頁；三人後續各自保留，不產生退款或入場。'; break;
      case 'view_followup':
        if (!ticket || !next.committedChoice) return reject('請先確認交回／暫停本批。'); next.followupsViewed = add(next.followupsViewed, ticket.id); message = ticket.consequence; break;
      case 'attach_followup':
        if (!ticket || !next.committedChoice || !next.followupsViewed.includes(ticket.id)) return reject('請先查看這人的後續，再明確夾回原票。');
        if (next.followupsAttached.includes(ticket.id)) return reject('已留存，不重複附加或計步。');
        next.followupsAttached.push(ticket.id); delta = 1; message = ticket.name + '後果已夾回同一原票；已留存 ' + next.followupsAttached.length + '／3。'; break;
      case 'seal':
        if (!next.committedChoice || next.followupsAttached.length !== 3 || next.resultCount !== 0) return reject('還缺人物後續，請逐一查看並夾回；已封存只能回看。');
        next.sealed = true; next.resultCount = 1; next.resultId = next.session + ':P02-result'; next.activeView = 'result'; delta = 1; message = '本局只封存一次；三張無效原票、三人後果與所選分支都保留，獎勵 0。'; break;
      default: return reject('此 Demo 沒有這個工作操作。');
      }
    }
    next.logicalStep += delta; next.awardedReward = 0; next.revision += 1; next.processed.push(command.id);
    next.phase = phase(next);
    const reached = next.game === 'MG-P01' ? next.phase === 'RESULT' ? 'result' : 'work' : ({ ASSEMBLY: 'assembly', BOARD: 'board', CHOICE: 'choice', FOLLOW_UP: 'follow_up', RESULT: 'result' })[next.phase];
    next.visited = add(next.visited, reached);
    if (next.game === 'MG-P02' && next.phase === 'CHOICE' && state.phase !== 'CHOICE') next.activeView = 'choice';
    if (delta) next.pendingEvent = { id: command.id, session: next.session };
    return { state: next, accepted: true, counted: Boolean(delta), message };
  }
  return { clone, validate, create, apply, finishEvent, phase, ticketComplete, position, proofMissing, terminal };
});
