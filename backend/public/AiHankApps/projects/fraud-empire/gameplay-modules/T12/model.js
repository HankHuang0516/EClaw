/* Isolated MG-P11 proposal, owned by the legacy T12 integration slot. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FraudT12Model = factory();
})(globalThis, function () {
  'use strict';
  const copy = value => JSON.parse(JSON.stringify(value));
  const people = ['xu', 'du', 'bai'];
  // Two pieces and two orientations are explicit prototype fixtures, not approved balance.
  const pieces = ['door', 'window'];
  function create(session) {
    if (typeof session !== 'string' || !session.trim()) throw new TypeError('session required');
    return { version: 1, module: 'T12', candidate: 'MG-P11', session, revision: 0,
      processed: [], view: 'intro', selected: null, placements: { door: null, window: null },
      rotations: { door: 0, window: 0 }, expectations: [], sectionOpen: false,
      marks: [], choice: null, followups: [], result: null };
  }
  function assembled(s) { return pieces.every(p => s.placements[p] === p && s.rotations[p] === 1); }
  function ready(s) { return assembled(s) && s.expectations.length === 3 && s.sectionOpen && s.marks.length === 2; }
  function apply(state, command) {
    const reject = code => ({ state: copy(state), accepted: false, code });
    if (!command || command.session !== state.session || command.revision !== state.revision ||
        typeof command.id !== 'string' || !command.id || state.processed.includes(command.id)) return reject('stale');
    const s = copy(state), c = command;
    if (c.type === 'view') {
      if (!['intro', 'work', 'menu'].includes(c.view)) return reject('invalid');
      s.view = c.view;
    } else {
      if (s.view !== 'work') return reject('paused');
      if (s.result) return reject('sealed');
      if (c.type === 'expectation') {
        if (!people.includes(c.person) || s.expectations.includes(c.person)) return reject('invalid');
        s.expectations.push(c.person);
      } else if (c.type === 'select') {
        if (s.choice || !pieces.includes(c.piece) || s.placements[c.piece]) return reject('invalid');
        s.selected = c.piece;
      } else if (c.type === 'cancel') {
        if (!s.selected) return reject('empty');
        s.selected = null;
      } else if (c.type === 'place') {
        if (s.choice || !s.selected || s.selected !== c.slot || s.placements[c.slot]) return reject('wrongSlot');
        s.placements[c.slot] = s.selected; s.selected = null;
      } else if (c.type === 'rotate' || c.type === 'remove') {
        if (s.choice || !pieces.includes(c.piece) || !s.placements[c.piece]) return reject('invalid');
        if (c.type === 'rotate') s.rotations[c.piece] = 1 - s.rotations[c.piece];
        else { s.placements[c.piece] = null; s.rotations[c.piece] = 0; }
        // Changing structure invalidates the previous cross-section evidence.
        s.sectionOpen = false; s.marks = [];
      } else if (c.type === 'openSection') {
        if (s.choice || !assembled(s) || s.sectionOpen) return reject('notAssembled');
        s.sectionOpen = true;
      } else if (c.type === 'mark') {
        if (s.choice || !s.sectionOpen || !['machine', 'delivery'].includes(c.zone) || s.marks.includes(c.zone)) return reject('wrongMark');
        s.marks.push(c.zone);
      } else if (c.type === 'unmark') {
        if (s.choice || !s.marks.includes(c.zone)) return reject('invalid');
        s.marks = s.marks.filter(x => x !== c.zone);
      } else if (c.type === 'choose') {
        if (s.choice || !ready(s) || !['withSection', 'stopDisplay'].includes(c.choice)) return reject('missing');
        s.choice = c.choice; s.selected = null;
      } else if (c.type === 'followup') {
        if (!s.choice || !people.includes(c.person) || s.followups.includes(c.person)) return reject('missing');
        s.followups.push(c.person);
      } else if (c.type === 'handoff') {
        if (!ready(s) || !s.choice || s.followups.length !== 3) return reject('missing');
        s.result = { id: s.session + ':T12:result', module: 'T12', candidate: 'MG-P11',
          status: 'proposal-preview-complete', choice: s.choice, previewOnly: true,
          awardedReward: 0, writeSave: false, gameMinutesDelta: 0, balancePending: true,
          consequences: { xu: 'expectation-unfulfilled', du: 'disappointed', bai: 'inactive' } };
      } else return reject('invalid');
    }
    s.revision += 1; s.processed.push(c.id);
    return { state: s, accepted: true, code: 'accepted' };
  }
  // Replay validates all fields and prevents forged reward/completion snapshots.
  function restore(snapshot) {
    if (!snapshot || Object.keys(snapshot).sort().join(',') !== 'commands,session,version' || snapshot.version !== 1 || !Array.isArray(snapshot.commands) || snapshot.commands.length > 10000) throw new TypeError('invalid snapshot');
    let s = create(snapshot.session);
    for (const command of snapshot.commands) {
      const outcome = apply(s, command);
      if (!outcome.accepted) throw new TypeError('invalid replay');
      s = outcome.state;
    }
    return s;
  }
  return { create, apply, assembled, ready, restore, copy };
});
