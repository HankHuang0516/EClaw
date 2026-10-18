(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FraudT15Model = api;
})(globalThis, function () {
  'use strict';
  const clone = value => JSON.parse(JSON.stringify(value));
  function create(session, recipient = 'unknown') {
    if (typeof session !== 'string' || !session) throw new TypeError('session required');
    if (!['accept', 'decline', 'unknown'].includes(recipient)) throw new TypeError('recipient');
    return { version: 1, module: 'T15', candidate: 'MG-P14', proposal: true, session, recipient,
      revision: 0, processed: [], photo: false, layers: ['sleeve', 'pad', 'board'],
      box: 'package', shell: 'table', inspected: false, branch: null, gear: false,
      tested: false, fixed: false, clipped: false, acknowledged: false,
      result: null, selected: null, paused: false, activeMilliseconds: 0 };
  }
  function apply(state, command) {
    const reject = reason => ({ state, accepted: false, reason });
    if (!command || command.session !== state.session || command.revision !== state.revision ||
        typeof command.id !== 'string' || !command.id || state.processed.includes(command.id)) return reject('stale');
    if (state.result) return reject('sealed');
    const n = clone(state), type = command.type;
    if (type === 'pause') n.paused = true;
    else if (type === 'resume') n.paused = false;
    else if (state.paused) return reject('paused');
    else if (type === 'photo' && !n.photo) n.photo = true;
    else if (type === 'remove' && n.photo && n.layers[0] === command.item) n.layers.shift();
    else if (type === 'select' && ['box', 'shell', 'gear'].includes(command.item)) n.selected = command.item;
    else if (type === 'place') {
      const item = n.selected, target = command.target;
      if (item === 'shell' && !n.layers.length && n.shell === 'table' && target === 'display') n.shell = 'display';
      else if (item === 'box' && !n.layers.length && n.box === 'package' && target === 'repair') n.box = 'repair';
      else if (item === 'gear' && n.branch === 'repair' && n.box === 'repair' && !n.gear && target === 'box') n.gear = true;
      else if (item === 'box' && n.branch === 'repair' && n.tested && n.box === 'repair' && target === 'package') n.box = 'packed';
      else if (item === 'box' && n.branch === 'return' && n.box === 'repair' && target === 'package') n.box = 'packed';
      else if (item === 'shell' && n.branch === 'return' && n.shell === 'display' && target === 'storage') n.shell = 'storage';
      else if (item === 'box' && n.box === 'packed' && n.shell === 'display' && n.branch === 'repair' && target === 'repairedRack') n.box = target;
      else if (item === 'box' && n.box === 'packed' && n.shell === 'storage' && n.clipped && n.branch === 'return' && target === 'returnRack') n.box = target;
      else return reject('wrong-placement');
      n.selected = null;
    } else if (type === 'inspect' && n.box === 'repair' && !n.inspected) n.inspected = true;
    else if (type === 'choose' && n.inspected && n.shell === 'display' && !n.branch && ['repair', 'return'].includes(command.branch)) n.branch = command.branch;
    else if (type === 'removeGear' && n.box === 'repair' && n.gear) { n.gear = false; n.tested = false; }
    else if (type === 'test' && n.box === 'repair' && n.gear && !n.tested) n.tested = true;
    else if (type === 'fix' && n.branch === 'return' && n.box === 'packed' && !n.fixed) n.fixed = true;
    else if (type === 'clip' && n.fixed && n.shell === 'storage' && !n.clipped) n.clipped = true;
    else if (type === 'acknowledge' && ['repairedRack', 'returnRack'].includes(n.box) && !n.acknowledged) n.acknowledged = true;
    else if (type === 'finish' && n.acknowledged) n.result = {
      id: n.session + ':result', module: 'T15', candidate: 'MG-P14', proposal: true,
      previewOnly: true, formalSaveAllowed: false, rewards: { score: 0, xp: 0, cultivation: 0 },
      branch: n.branch, objectLocation: n.box, shellLocation: n.shell, recipient: n.recipient,
      storyPending: n.recipient === 'unknown', refund: false, promiseFulfilled: false,
      activeGameMinutes: n.activeMilliseconds / 60000, balancedDurationMinutes: null
    };
    else return reject('prerequisite');
    n.revision++; n.processed.push(command.id);
    return { state: n, accepted: true, reason: 'accepted' };
  }
  // Host-supplied active interaction time only; menus/reading never call this.
  function advanceActiveTime(state, milliseconds) {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) throw new TypeError('milliseconds');
    if (state.paused || state.result) return state;
    return { ...state, activeMilliseconds: state.activeMilliseconds + milliseconds };
  }
  return { create, apply, clone, advanceActiveTime };
});
