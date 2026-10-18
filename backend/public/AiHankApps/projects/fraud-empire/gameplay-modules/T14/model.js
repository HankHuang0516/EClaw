/* MG-P13 proposal only. The T14 directory is an integration identity, not a rename of old rules. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FraudT14Model = api;
})(globalThis, function () {
  'use strict';
  const copy = value => JSON.parse(JSON.stringify(value));
  const folders = ['relationship', 'project'];
  const props = { relationship: 'record', project: 'modelPage' };
  function create(session) {
    if (typeof session !== 'string' || !session || session.length > 100) throw new TypeError('session');
    return { version: 1, moduleId: 'T14', candidateId: 'MG-P13', session, revision: 0,
      view: 'intro', inspected: [], folders: { relationship: 'waiting', project: 'waiting' },
      book: 'shelf', slot: null, prop: null, elapsedMs: 0, result: null };
  }
  function ready(s) {
    return s.book === 'shelf' && s.slot === null && folders.every(f => ['completed', 'deferred'].includes(s.folders[f])) && folders.some(f => s.folders[f] === 'completed');
  }
  function apply(state, action) {
    const reject = code => ({ state, accepted: false, code });
    if (!action || action.session !== state.session || action.revision !== state.revision) return reject('stale');
    const s = copy(state), f = action.folder;
    if (action.type === 'view') {
      if (!['intro', 'desk', 'reading', 'menu'].includes(action.view)) return reject('target');
      s.view = action.view;
    } else if (s.result) return reject('closed');
    else if (s.view !== 'desk') return reject('paused');
    else switch (action.type) {
    case 'inspect':
      if (!folders.includes(f)) return reject('target');
      if (!s.inspected.includes(f)) s.inspected.push(f);
      s.view = 'reading'; break;
    case 'load':
      if (!folders.includes(f) || action.prop !== props[f]) return reject('wrongProp');
      if (s.inspected.length !== 2) return reject('inspectBoth');
      if (s.slot || s.book !== 'shelf' || s.folders[f] !== 'waiting') return reject('occupied');
      s.slot = f; s.book = f; s.prop = action.prop; s.folders[f] = 'loaded'; break;
    case 'play':
      if (!s.slot || s.folders[s.slot] !== 'loaded') return reject('empty');
      s.folders[s.slot] = 'played'; s.view = 'reading'; break;
    case 'receive':
      if (!s.slot || s.folders[s.slot] !== 'played') return reject('notPlayed');
      s.folders[s.slot] = 'received'; s.slot = null; s.prop = null; s.book = 'hand'; break;
    case 'shelve':
      if (s.book !== 'hand') return reject('bookLocked');
      s.book = 'shelf'; break;
    case 'deliver':
      if (!folders.includes(f) || s.folders[f] !== 'received') return reject('notReceived');
      s.folders[f] = 'completed'; break;
    case 'defer':
      if (!folders.includes(f) || s.folders[f] !== 'waiting') return reject('locked');
      if (folders.every(x => x === f || s.folders[x] === 'deferred')) return reject('needCompleted');
      s.folders[f] = 'deferred'; break;
    case 'recall':
      if (!folders.includes(f) || s.folders[f] !== 'deferred') return reject('target');
      s.folders[f] = 'waiting'; break;
    case 'tick':
      if (!Number.isFinite(action.ms) || action.ms <= 0 || !Number.isSafeInteger(s.elapsedMs + action.ms)) return reject('time');
      s.elapsedMs += action.ms; break;
    case 'handoff':
      if (!ready(s)) return reject('unfinished');
      s.result = { id: s.session + ':result', moduleId: 'T14', candidateId: 'MG-P13',
        status: 'proposal-complete', formalComplete: false, rewards: { score: 0, xp: 0, cultivation: 0 },
        saveAllowed: false, folders: copy(s.folders), nextDayTodos: folders.filter(x => s.folders[x] === 'deferred'),
        elapsedGameMinutes: s.elapsedMs / 60000, globalClockMinutesApplied: 0 };
      break;
    default: return reject('target');
    }
    s.revision += 1;
    return { state: s, accepted: true, code: action.type };
  }
  return { create, apply, ready, copy, folders, props };
});
