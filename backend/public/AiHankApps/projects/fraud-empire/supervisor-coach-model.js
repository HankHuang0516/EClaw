(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FraudCoachModel = factory();
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const defaults = Object.freeze({ gentleMs: 20000, specificMs: 45000, cooldownMs: 20000, wrongThreshold: 2, maxPerStage: 2, pollMs: 500, status: 'adjustable-interface-proposal-not-game-balance' });
  function config(overrides = {}) {
    const result = { ...defaults, ...overrides };
    for (const k of ['gentleMs', 'specificMs', 'cooldownMs', 'wrongThreshold', 'maxPerStage', 'pollMs']) if (!Number.isFinite(result[k]) || result[k] <= 0) throw new Error('Invalid coaching configuration: ' + k);
    if (result.specificMs < result.gentleMs || !Number.isInteger(result.wrongThreshold) || !Number.isInteger(result.maxPerStage)) throw new Error('Invalid coaching order');
    return Object.freeze(result);
  }
  function speaker(context = {}) {
    const rank = context.rank;
    if (!Number.isInteger(rank) || rank < 1 || rank > 5) return null;
    const relationship = ['trusted', 'strained'].includes(context.relationship) ? context.relationship : 'unknown';
    return Object.freeze({ id: rank === 1 ? 'hou' : 'lin', name: rank === 1 ? '阿猴' : '林若晴', rank, tone: rank === 1 ? 'hou' : 'lin' + rank, relationship, relationshipSource: context.relationshipSource || 'unavailable', provenance: context.provenance || 'unspecified' });
  }
  function describeP02(s) {
    if (!s || s.game !== 'MG-P02' || !Array.isArray(s.tickets) || !s.boardStacks) return null;
    const terminal = Boolean(s.sealed || s.resultCount);
    const base = { supported: true, session: s.session, terminal, busy: Boolean(s.pendingEvent), game: s.game };
    const progressKey = JSON.stringify([s.piecePlacements, s.boardStacks, s.overlapRevealed, s.duplicateMarked, s.expectationsViewed, s.modelInspected, s.committedChoice, s.followupsViewed, s.followupsAttached, s.sealed]);
    const make = (stage, hint, actions, params = {}, wantedView) => ({ ...base, stage, progressKey, hint, params, nextActions: actions, inputKey: JSON.stringify(actions), reading: Boolean(wantedView && s.activeView !== wantedView && !(wantedView === 'assembly' && s.activeView === 'expectations')) });
    const action = (type, payload = {}) => ({ type, ...payload });
    const go = (view, fallback) => s.activeView === view || (view === 'assembly' && s.activeView === 'expectations') ? fallback : [action('navigate', { view })];
    if (terminal) return make('result', 'result', []);
    if (!s.piecePlacements.moon) return make('assemble', s.selectedPiece === 'moon' ? 'placeMoon' : 'selectMoon', go('assembly', [s.selectedPiece === 'moon' ? action('place_piece', { piece: 'moon', ticket: 'tao_ke' }) : action('select_piece', { piece: 'moon' })]), {}, 'assembly');
    const unplaced = s.tickets.find(t => !Object.values(s.boardStacks).some(ids => ids.includes(t.id)));
    if (unplaced) return make('place-' + unplaced.id, s.activeView !== 'board' ? 'goBoard' : s.selectedTicket === unplaced.id ? 'placeTicket' : 'selectTicket', go('board', [s.selectedTicket === unplaced.id ? action('place_ticket', { ticket: unplaced.id, seat: unplaced.fixedSeat }) : action('select_ticket', { ticket: unplaced.id })]), { person: unplaced.name, seat: unplaced.fixedSeat }, 'board');
    if (!s.overlapRevealed) return make('reveal', s.activeView !== 'board' ? 'goBoard' : 'reveal', go('board', [action('reveal_top_A', { ticket: s.boardStacks.A.at(-1) })]), {}, 'board');
    if (!s.duplicateMarked) {
      const wrong = s.selectedPair.find(id => !['tao_ke', 'bi_an'].includes(id));
      const missing = ['tao_ke', 'bi_an'].find(id => !s.selectedPair.includes(id));
      const chosen = wrong || missing;
      const ticket = s.tickets.find(t => t.id === chosen);
      return make('mark', s.activeView !== 'board' ? 'goBoard' : wrong ? 'unselectPair' : missing ? 'selectPair' : 'mark', go('board', [chosen ? action('select_pair', { ticket: chosen }) : action('mark_duplicate', { pair: ['tao_ke', 'bi_an'] })]), { person: ticket?.name || '' }, 'board');
    }
    const unread = s.tickets.find(t => !s.expectationsViewed.includes(t.id));
    if (unread) return make('expectation-' + unread.id, 'expectation', [action('view_expectation', { ticket: unread.id })], { person: unread.name });
    if (!s.modelInspected) return make('inspect', 'inspect', [action('inspect_model')]);
    if (!s.committedChoice) return make('choice', s.activeView !== 'choice' ? 'goChoice' : s.pendingChoice ? 'confirm' : 'choice', go('choice', s.pendingChoice ? [action('confirm_choice')] : [action('preview_choice', { choice: 'return_marked' }), action('preview_choice', { choice: 'pause_batch' })]), {}, 'choice');
    const followup = s.tickets.find(t => !s.followupsAttached.includes(t.id));
    if (followup) return make('followup-' + followup.id, s.activeView !== 'follow_up' ? 'goFollowup' : s.followupsViewed.includes(followup.id) ? 'attach' : 'followup', go('follow_up', [s.followupsViewed.includes(followup.id) ? action('attach_followup', { ticket: followup.id }) : action('view_followup', { ticket: followup.id })]), { person: followup.name }, 'follow_up');
    return make('seal', s.activeView !== 'follow_up' ? 'goFollowup' : 'seal', go('follow_up', [action('seal')]), {}, 'follow_up');
  }
  function initial() { return { session: null, stage: null, progressKey: null, inputKey: null, contextKey: null, lastNow: null, idleMs: 0, activeMs: 0, lastEmissionMs: -Infinity, wrong: 0, count: 0, serial: 0, running: false, paused: true }; }
  function tick(previous, input, options = defaults) {
    const c = config(options), next = { ...previous }; let clear = false;
    const changed = input.session !== next.session || input.stage !== next.stage || input.progressKey !== next.progressKey || input.contextKey !== next.contextKey;
    if (changed) Object.assign(next, initial(), { serial: previous.serial, session: input.session, stage: input.stage, progressKey: input.progressKey, inputKey: input.inputKey, contextKey: input.contextKey });
    if (changed) clear = true;
    if (!input.active || input.terminal) { Object.assign(next, { running: false, paused: true, lastNow: null, idleMs: 0, wrong: 0 }); return { state: next, clear: true, hint: null }; }
    next.running = true;
    if (input.paused) { next.paused = true; next.lastNow = null; return { state: next, clear, hint: null }; }
    const elapsed = next.lastNow === null ? 0 : Math.max(0, Math.min(input.now - next.lastNow, c.pollMs * 2));
    next.paused = false; next.lastNow = input.now; next.activeMs += elapsed; next.idleMs += elapsed;
    if (input.inputKey !== next.inputKey) { next.inputKey = input.inputKey; next.idleMs = 0; next.wrong = 0; clear = true; }
    if (input.wrong) next.wrong += 1;
    let hint = null;
    if (next.count < c.maxPerStage && next.activeMs - next.lastEmissionMs >= c.cooldownMs) {
      const eligible = next.count === 0 ? next.idleMs >= c.gentleMs || next.wrong >= c.wrongThreshold : next.idleMs >= c.specificMs || next.wrong >= c.wrongThreshold * 2;
      if (eligible) { hint = { level: next.count === 0 ? 'gentle' : 'specific', serial: next.serial++, cause: next.idleMs >= (next.count === 0 ? c.gentleMs : c.specificMs) ? 'stall' : 'wrong' }; next.count += 1; next.lastEmissionMs = next.activeMs; }
    }
    return { state: next, clear, hint };
  }
  function createController(options) {
    const c = config(options.config), now = options.now || (() => Date.now());
    let state = initial(), timer = null, generation = 0, disposed = false;
    function stopTimer() { generation += 1; if (timer !== null) options.cancel(timer); timer = null; }
    function refresh(event = {}) {
      if (disposed) return;
      stopTimer(); const read = options.read(); const outcome = tick(state, { ...read, now: now(), wrong: Boolean(event.wrong) }, c); state = outcome.state;
      if (outcome.clear) options.onClear?.();
      if (outcome.hint) options.onHint({ ...outcome.hint, descriptor: read.descriptor, speaker: read.speaker });
      if (state.running && !state.paused) { const owner = generation; timer = options.schedule(() => { if (disposed || owner !== generation) return; timer = null; refresh(); }, c.pollMs); }
    }
    return Object.freeze({ refresh, manual() { if (disposed) return false; const read = options.read(); if (!read.active || read.terminal || read.descriptor?.busy) return false; options.onHint({ level: 'specific', serial: state.serial++, cause: 'manual', descriptor: read.descriptor, speaker: read.speaker }); state.lastEmissionMs = state.activeMs; state.idleMs = 0; return true; }, getStatus: () => ({ ...state, activeTimers: timer === null ? 0 : 1, disposed, configuration: c }), dispose() { if (disposed) return; stopTimer(); disposed = true; state = { ...state, running: false, paused: true, lastNow: null }; options.onClear?.(); } });
  }
  return Object.freeze({ defaults, config, speaker, describeP02, initial, tick, createController });
});
