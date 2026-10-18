/* T08 v4 proposal. Pure state transitions; no storage, scheduler or rewards. */
((root, factory) => {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FraudT08Model = api;
})(globalThis, () => {
  'use strict';
  const copy = value => JSON.parse(JSON.stringify(value));
  function create(session) {
    if (typeof session !== 'string' || !session) throw new TypeError('session required');
    return { version: 1, module: 'T08', rules: 'legacy-v4-proposal', session, revision: 0,
      entered: false, approached: false, selected: false, marked: false, edges: [],
      inspected: false, lidOpen: false, pendingChoice: null, choice: null,
      position: 'moon', claim: 'fog', contents: 'weight', person: '丁禾',
      minutes: 0, charged: [], result: null, returned: false, processed: [] };
  }
  function missing(s) {
    return [!s.marked && 'position', s.edges.length !== 2 && 'handoff', !s.inspected && 'contents', !s.choice && 'destination'].filter(Boolean);
  }
  function apply(state, command) {
    const reject = code => ({ state, accepted: false, code, deltaMinutes: 0, result: null });
    if (!command || command.session !== state.session || command.revision !== state.revision ||
        typeof command.id !== 'string' || !command.id || state.processed.includes(command.id)) return reject('stale');
    const n = copy(state);
    let deltaMinutes = 0, result = null;
    const charge = (step, minutes) => { if (!n.charged.includes(step)) { n.charged.push(step); n.minutes += minutes; deltaMinutes += minutes; } };
    const finish = outcome => {
      result = { id: n.session + ':T08-result', module: 'T08', rules: n.rules, proposal: true,
        outcome, choice: n.choice, position: n.position, missing: missing(n),
        disappointment: true, previewMinutesAtResult: n.minutes, awardedReward: 0, persist: false };
      n.result = copy(result);
    };
    if (n.result && !['read', 'return'].includes(command.type)) return reject('terminal');
    switch (command.type) {
    case 'read': break;
    case 'enter':
      if (n.entered) return reject('already');
      n.entered = true; break;
    case 'approach':
      if (!n.entered) return reject('aisle');
      if (command.box !== 'H8') return reject('wrongBox');
      if (n.approached) return reject('already');
      n.approached = true; charge('T08-S01', 10); break;
    case 'select':
      if (!n.approached) return reject('approach');
      if (command.box !== 'H8') return reject('wrongBox');
      n.selected = !n.selected; break;
    case 'mark':
      if (!n.selected) return reject('select');
      if (command.station !== 'moon') return reject('wrongStation');
      if (n.marked) return reject('already');
      n.marked = true; n.selected = false; charge('T08-S02', 5); break;
    case 'edge':
      if (!n.marked) return reject('mark');
      if (!['moon-star', 'star-fog'].includes(command.edge)) return reject('wrongEdge');
      if (n.edges.includes(command.edge)) return reject('already');
      n.edges.push(command.edge);
      if (n.edges.length === 2) charge('T08-S03', 5);
      break;
    case 'open':
      if (n.edges.length !== 2) return reject('edges');
      n.lidOpen = true; n.inspected = true; charge('T08-S04', 5); break;
    case 'close':
      if (!n.inspected) return reject('inspect');
      n.lidOpen = false; break;
    case 'preview':
      if (!n.inspected || n.lidOpen) return reject('close');
      if (n.choice) return reject('already');
      if (!['return', 'hold'].includes(command.choice)) return reject('wrongChoice');
      n.pendingChoice = command.choice; break;
    case 'cancel': n.pendingChoice = null; n.selected = false; break;
    case 'confirm':
      if (!n.pendingChoice || n.choice) return reject('preview');
      n.choice = n.pendingChoice; n.pendingChoice = null;
      n.position = n.choice === 'return' ? 'return-area' : 'hold-area';
      charge('T08-S05', 5); break;
    case 'seal':
      if (missing(n).length) return reject('missing');
      finish('complete'); break;
    case 'abandon': finish('abandoned'); break;
    case 'return':
      if (!n.result) return reject('result');
      if (n.returned) return reject('already');
      n.returned = true;
      if (n.approached) charge('T08-S07', 10);
      break;
    default: return reject('unknown');
    }
    n.revision++; n.processed.push(command.id);
    return { state: n, accepted: true, code: command.type, deltaMinutes, result };
  }
  return { create, apply, missing };
});
