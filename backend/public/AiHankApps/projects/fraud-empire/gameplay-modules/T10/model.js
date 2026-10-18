/* T10 / MG-P09 proposal only. Pure state; no production persistence or rewards. */
((root, factory) => {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FraudT10Model = api;
})(globalThis, () => {
  'use strict';
  const pieces = ['radio', 'rail', 'night'];
  const copy = value => JSON.parse(JSON.stringify(value));
  function create() {
    return { version: 1, candidate: 'MG-P09', proposal: true, phase: 'intro', revision: 0,
      selected: null, turns: { radio: 1, rail: 2, night: 3 }, placed: [], pair: [],
      route: null, evidence: false, contradiction: false, archived: [], activeMs: 0,
      paused: false, result: null };
  }
  function apply(state, command) {
    const reject = reason => ({ state, accepted: false, reason });
    if (!command || command.revision !== state.revision) return reject('stale');
    const n = copy(state), { type, value } = command;
    if (type === 'pause') n.paused = true;
    else if (type === 'resume') n.paused = false;
    else if (type === 'tick') {
      if (n.paused || !['assembly', 'compare', 'archive'].includes(n.phase) || !Number.isFinite(value) || value <= 0) return reject('paused');
      n.activeMs += value;
    } else {
      if (n.paused) return reject('paused');
      switch (type) {
      case 'start':
        if (n.phase !== 'intro') return reject('order');
        n.phase = 'assembly'; break;
      case 'select':
        if (n.phase !== 'assembly' || !pieces.includes(value) || n.placed.includes(value)) return reject('piece');
        n.selected = value; break;
      case 'rotate':
        if (n.phase !== 'assembly' || !n.selected) return reject('empty');
        n.turns[n.selected] = (n.turns[n.selected] + 1) % 4; break;
      case 'place':
        if (n.phase !== 'assembly' || !n.selected) return reject('empty');
        if (value !== n.selected || n.turns[n.selected] !== 0) return reject('mismatch');
        n.placed.push(n.selected); n.selected = null;
        if (n.placed.length === 3) n.phase = 'source'; break;
      case 'route':
        if (n.phase !== 'source' || !['witness', 'record'].includes(value)) return reject('order');
        n.route = value; n.phase = 'reading'; break;
      case 'read':
        if (n.phase !== 'reading') return reject('order');
        n.evidence = true; n.phase = 'compare'; break;
      case 'tag':
        if (n.phase !== 'compare' || !['roof', 'island', 'other'].includes(value)) return reject('order');
        n.pair = n.pair.includes(value) ? n.pair.filter(x => x !== value) : n.pair.concat(value).slice(-2); break;
      case 'compare':
        if (n.phase !== 'compare' || n.pair.length !== 2 || !n.pair.includes('roof') || !n.pair.includes('island')) return reject('date');
        n.contradiction = true; n.phase = 'archive'; break;
      case 'archive':
        if (n.phase !== 'archive' || !['memory', 'source'].includes(value) || n.archived.includes(value)) return reject('order');
        n.archived.push(value); break;
      case 'handoff':
        if (n.phase !== 'archive' || n.archived.length !== 2 || !n.evidence || !n.contradiction || n.result) return reject('incomplete');
        n.phase = 'result';
        n.result = { moduleId: 'T10', candidateId: 'MG-P09', status: 'proposal-preview-complete', officialCompletion: false,
          reward: 0, save: false, route: n.route, witnessCount: n.route === 'witness' ? 1 : 0, activeGameMinutes: n.activeMs / 60000 };
        break;
      default: return reject('unknown');
      }
    }
    n.revision += 1;
    return { state: n, accepted: true, reason: 'ok' };
  }
  return { create, apply, pieces, copy };
});
