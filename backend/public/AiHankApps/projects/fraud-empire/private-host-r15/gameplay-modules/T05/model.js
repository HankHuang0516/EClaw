/* Page-local proposal state. No storage, network, global clock or rewards. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FraudT05Model = api;
})(globalThis, function () {
  'use strict';
  const copy = value => JSON.parse(JSON.stringify(value));
  const VIEWS = ['bell', 'moon', 'backstage'];
  function create(session) {
    if (typeof session !== 'string' || !session) throw new Error('session required');
    return { schemaVersion: 1, moduleId: 'T05', candidateId: 'MG-P04', session,
      revision: 0, run: 1, view: 'intro', visited: [], frame: 0, frameStep: 0, lastAttemptFrameStep: null, attempts: 2,
      capture: null, selectedShadow: null, placed: [], choice: null, result: null,
      clock: { paused: true, proposedMinutes: null, globalMinutesApplied: 0 },
      preview: true, awardedReward: 0, committed: false };
  }
  function apply(state, command) {
    const hold = code => ({ state, accepted: false, code, result: null });
    if (!command || command.session !== state.session || command.revision !== state.revision) return hold('stale');
    if (command.type === 'reset') {
      const next = create(state.session); next.run = state.run + 1; next.revision = state.revision + 1;
      return { state: next, accepted: true, code: 'reset', result: null };
    }
    const next = copy(state);
    const done = code => { next.revision += 1; return { state: next, accepted: true, code, result: null }; };
    if (command.type === 'view') {
      if (!['intro', 'menu', ...VIEWS].includes(command.value)) return hold('invalid');
      if (command.value === state.view) return hold('unchanged');
      next.view = command.value;
      if (VIEWS.includes(command.value) && !next.visited.includes(command.value) && !state.result) next.visited.push(command.value);
      return done('view');
    }
    if (state.result) return hold('readonly');
    if (command.type === 'frame') {
      if (state.view !== 'moon' || ![-1, 1].includes(command.value) || state.capture || state.attempts === 0) return hold('invalid');
      next.frame = (state.frame + command.value + 3) % 3; next.frameStep += 1;
      return done('frame');
    }
    if (command.type === 'capture') {
      if (state.view !== 'backstage' || VIEWS.some(v => !state.visited.includes(v))) return hold('viewsRequired');
      if (state.capture || state.attempts === 0) return hold('noAttempts');
      if (state.lastAttemptFrameStep === state.frameStep) return hold('sameFrame');
      next.attempts -= 1; next.lastAttemptFrameStep = state.frameStep;
      if (state.frame === 1) { next.capture = 'shared'; return done('captured'); }
      return done(next.attempts ? 'miss' : 'exhausted');
    }
    if (command.type === 'select') {
      if (state.view !== 'backstage' || state.capture !== 'shared' || !['bell', 'moon'].includes(command.value) || state.placed.includes(command.value)) return hold('invalid');
      if (state.selectedShadow === command.value) return hold('unchanged');
      next.selectedShadow = command.value; return done('selected');
    }
    if (command.type === 'place') {
      if (state.view !== 'backstage' || !state.selectedShadow) return hold('empty');
      if (command.value !== 'glass') return hold('wrongTarget');
      next.placed.push(state.selectedShadow); next.selectedShadow = null; return done('placed');
    }
    if (command.type === 'ending') {
      const complete = VIEWS.every(v => state.visited.includes(v)) && state.placed.length === 2;
      const incomplete = state.attempts === 0 && !state.capture;
      if (!['handoff', 'pause'].includes(command.value) || (!complete && !incomplete)) return hold('proofRequired');
      next.choice = command.value;
      next.result = { id: state.session + ':' + state.run + ':T05', moduleId: 'T05', candidateId: 'MG-P04',
        status: complete ? 'complete-preview' : 'incomplete-preview', choice: command.value,
        commonShadow: complete, preview: true, approved: false, reward: 0, persist: false,
        gameMinutes: null, globalMinutesApplied: 0,
        consequence: command.value === 'pause' ? 'own-work-paused' : 'work-returned',
        victimResolved: false };
      const transition = done('result'); transition.result = copy(next.result); return transition;
    }
    return hold('invalid');
  }
  return Object.freeze({ create, apply, snapshot: copy });
});
