/* T16 proposal-only, deterministic instance state. No storage or clock writes. */
((root, factory) => {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FraudT16Model = api;
})(globalThis, () => {
  'use strict';
  const copy = value => JSON.parse(JSON.stringify(value));
  function create(session) {
    if (typeof session !== 'string' || !session) throw new TypeError('session required');
    return { session, revision: 0, step: 1, mode: null, seat: null, accompanied: false,
      consent: false, route: null, record: null, paused: false, processed: false,
      resultCount: 0, followup: null, elapsedGameMinutes: 0, reward: 0, previewOnly: true };
  }
  function result(state) {
    return state.processed ? { moduleId: 'T16', resultId: state.session + ':support',
      previewOnly: true, formalSaveAllowed: false, storyProcessed: true,
      presentation: state.mode, consentScope: state.record, gameMinutes: 0,
      rewards: { score: 0, growth: 0, money: 0, income: 0 } } : null;
  }
  function apply(state, command) {
    const reject = () => ({ accepted: false, state, result: null });
    if (!command || command.session !== state.session || command.revision !== state.revision) return reject();
    const s = copy(state);
    const finish = () => { s.processed = true; s.resultCount = 1; s.step = 6; };
    if (command.type === 'pause') s.paused = true;
    else if (command.type === 'resume') s.paused = false;
    else if (s.paused) return reject();
    else if (command.type === 'followup' && s.processed && !s.followup && ['greet', 'rest'].includes(command.value)) { s.followup = command.value; s.step = 7; }
    else if (s.processed) return reject();
    else if (command.type === 'skip') { s.mode = 'skip'; finish(); }
    else if (command.type === 'summary') { s.mode = 'summary'; s.step = 6; }
    else if (command.type === 'watch' && s.step === 1) { s.mode = 'watch'; s.step = 2; }
    else if (command.type === 'seat' && s.step === 2 && command.value === 'quiet') s.seat = 'quiet';
    else if (command.type === 'accompany' && s.step === 2 && s.seat === 'quiet') { s.accompanied = true; s.step = 3; }
    else if (command.type === 'nearby' && s.step === 2) { s.accompanied = true; s.step = 3; }
    else if (command.type === 'ask' && s.step === 3 && !s.consent) s.consent = true;
    else if (command.type === 'go' && s.step === 3 && s.consent) s.step = 4;
    else if (command.type === 'wait' && s.step === 3 && s.consent) { s.route = 'waiting'; s.step = 5; }
    else if (command.type === 'travel' && s.step === 4 && ['arrived', 'resting'].includes(command.value)) { s.route = command.value; s.step = 5; }
    else if (command.type === 'record' && s.step === 5 && ['supported', 'none'].includes(command.value)) s.record = command.value;
    else if (command.type === 'review' && s.step === 5 && s.record) s.step = 6;
    else if (command.type === 'back' && s.step === 6 && s.mode === 'watch') s.step = 5;
    else if (command.type === 'finish' && s.step === 6 && (s.mode === 'summary' || s.record)) finish();
    else return reject();
    s.revision += 1;
    return { accepted: true, state: s, result: !state.processed && s.processed ? result(s) : null };
  }
  return Object.freeze({ create, apply, result, copy });
});
