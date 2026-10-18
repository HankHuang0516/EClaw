/* T17 legacy proposal only. No persistence, production clock or media substitution. */
((root, factory) => {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FraudT17Model = api;
})(globalThis, () => {
  'use strict';
  const clone = value => JSON.parse(JSON.stringify(value));
  function create() {
    return { revision: 0, phase: 'reading', selected: null, slots: [null, null],
      races: ['race1', 'race2', 'race3'].map(id => ({ id, status: 'waiting' })),
      round: 1, view: 1, repairPreview: null, result: null,
      elapsedGameMinutes: 0, awardedReward: 0, processed: [] };
  }
  function apply(state, command) {
    const reject = reason => ({ state, accepted: false, reason });
    if (!command || typeof command.id !== 'string' || !command.id || command.revision !== state.revision || state.processed.includes(command.id)) return reject('stale');
    const s = clone(state), race = s.races.find(r => r.id === command.race);
    if (s.result && !['view', 'return'].includes(command.type)) return reject('sealed');
    switch (command.type) {
      case 'start':
        if (s.phase !== 'reading') return reject('phase');
        s.phase = 'schedule'; break;
      case 'select':
        if (s.phase !== 'schedule' || !race || race.status !== 'waiting') return reject('selection');
        s.selected = race.id; break;
      case 'place': {
        if (s.phase !== 'schedule' || ![0, 1].includes(command.slot) || s.slots[command.slot]) return reject('occupied');
        const chosen = s.races.find(r => r.id === s.selected);
        if (!chosen || chosen.status !== 'waiting') return reject('selection');
        s.slots[command.slot] = chosen.id; chosen.status = 'staged'; s.selected = null; break;
      }
      case 'withdraw':
        if (s.phase !== 'schedule' || !race || race.status !== 'staged') return reject('selection');
        s.slots[s.slots.indexOf(race.id)] = null; race.status = 'waiting'; break;
      case 'confirm':
        if (s.phase !== 'schedule' || s.slots.some(x => !x)) return reject('empty');
        s.phase = 'media-unavailable'; s.view = 3; break;
      case 'back':
        if (s.phase !== 'media-unavailable') return reject('phase');
        s.phase = 'schedule'; s.view = 2; break;
      case 'round':
        if (s.phase !== 'media-unavailable' || ![-1, 1].includes(command.delta)) return reject('phase');
        s.round = Math.max(1, Math.min(3, s.round + command.delta)); break;
      case 'judge': case 'play': case 'splice': case 'handoff':
        return reject('media-unavailable');
      case 'repair-preview':
        if (s.phase !== 'media-unavailable' || ![0, 1].includes(command.slot)) return reject('phase');
        s.repairPreview = command.slot; s.view = 4; break;
      case 'view':
        if (!Number.isInteger(command.step) || command.step < 1 || command.step > 7) return reject('selection');
        s.view = command.step; break;
      case 'return': s.view = 2; break;
      case 'exit':
        s.phase = 'exited';
        s.result = { module: 'T17', ruleset: 'legacy-v4.1-proposal', outcome: 'incomplete-preview',
          completed: false, reason: 'missing-approved-media', awardedReward: 0,
          elapsedGameMinutes: s.elapsedGameMinutes, formalSaveAllowed: false };
        break;
      default: return reject('unknown');
    }
    s.revision++; s.processed.push(command.id);
    return { state: s, accepted: true, reason: 'ok' };
  }
  return { create, apply };
});
