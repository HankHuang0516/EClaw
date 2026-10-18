/* T06 legacy v4 proposal. Page-local state; never writes production resources. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FraudT06Model = factory();
})(globalThis, function () {
  'use strict';
  const copy = x => JSON.parse(JSON.stringify(x));
  function create(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId.trim()) throw new TypeError('sessionId required');
    return { sessionId, revision: 0, phase: 'intro', selected: null, ledger: [], balance: 10,
      compared: [], charged: [], minutes: 0, result: null, message: 'intro', processed: [] };
  }
  function apply(state, command) {
    const no = message => ({ state: copy(state), accepted: false, message, minuteDelta: 0, result: null });
    if (!command || command.sessionId !== state.sessionId || command.revision !== state.revision ||
      typeof command.id !== 'string' || !command.id || state.processed.includes(command.id)) return no('stale');
    const s = copy(state); let result = null, minuteDelta = 0;
    const charge = step => { if (!s.charged.includes(step)) { s.charged.push(step); s.minutes += 5; minuteDelta = 5; } };
    switch (command.type) {
    case 'start':
      if (s.phase !== 'intro') return no('invalid');
      s.phase = 'work'; break;
    case 'select':
      if (s.phase !== 'work' || !['A', 'B', 'C'].includes(command.event)) return no('invalid');
      if (s.ledger.includes(command.event)) return no('used');
      s.selected = command.event; break;
    case 'place': {
      if (s.phase !== 'work' || !s.selected) return no('empty');
      const expected = ['A', 'B', 'C'][s.ledger.length];
      if (s.selected !== expected) return no('order');
      if (command.target !== (s.selected === 'C' ? 'B' : 'path')) return no('wrongTarget');
      s.ledger.push(s.selected); charge(s.selected); s.selected = null;
      s.balance = [10, 18, 12, 18][s.ledger.length]; s.compared = []; break;
    }
    case 'undo':
      if (s.phase !== 'work' || !s.ledger.length) return no('empty');
      s.ledger.pop(); s.balance = [10, 18, 12, 18][s.ledger.length]; s.selected = null; s.compared = []; break;
    case 'compare':
      if (s.phase !== 'work' || s.ledger.length !== 3 || !['balance', 'claim'].includes(command.target)) return no('incomplete');
      if (s.compared.includes(command.target)) return no('used');
      s.compared.push(command.target); break;
    case 'settle':
      if (s.phase !== 'work' || s.ledger.join('') !== 'ABC' || s.balance !== 18 || s.compared.length !== 2) return no('incomplete');
      charge('settle'); s.phase = 'result'; s.selected = null;
      result = { id: s.sessionId + ':T06', module: 'T06', ruleset: 'legacy-v4-proposal',
        status: 'preview-complete', preview: true, balance: 18, cancelledEvent: 'B', claim: 6,
        gameMinutesProposal: s.minutes, awardedReward: 0, productionSave: false };
      s.result = copy(result); break;
    case 'cancel':
      s.selected = null; break;
    case 'exit':
      if (s.phase === 'exited') return no('invalid');
      s.resumePhase = s.phase; s.phase = 'exited'; s.selected = null; break;
    case 'resume':
      if (s.phase !== 'exited') return no('invalid');
      s.phase = s.resumePhase; delete s.resumePhase; break;
    default: return no('invalid');
    }
    s.revision++; s.processed.push(command.id); s.message = command.type;
    return { state: s, accepted: true, message: command.type, minuteDelta, result };
  }
  return { create, apply };
});
