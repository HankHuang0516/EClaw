/* Pure proposal model; no shared clock, persistence or resource writes. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FraudT13Model = api;
})(globalThis, function () {
  'use strict';
  const copy = value => JSON.parse(JSON.stringify(value));
  const props = ['previous', 'rain', 'record', 'blank'];
  function create(options = {}, run = 1) {
    return { schemaVersion: 1, moduleId: 'T13', candidateId: 'MG-P12', run, revision: 0,
      proposal: true, prerequisiteMet: options.chapter1 === true && options.chapter2 === true,
      view: 'intro', side: 'front', phase: 'setup', selected: null,
      locations: { previous: 'stage', rain: 'rack', record: 'rack', blank: 'rack' },
      rainViewed: false, refusalViewed: false, elapsedSeconds: 0,
      result: null, message: '先讀操作說明；前情未提供時只能進入明示的獨立示意。' };
  }
  function apply(state, action) {
    const reject = message => ({ state, accepted: false, message });
    if (!action || action.run !== state.run || action.revision !== state.revision) return reject('舊操作已忽略。');
    if (action.type === 'reset') return { state: create({ chapter1: state.prerequisiteMet, chapter2: state.prerequisiteMet }, state.run + 1), accepted: true, message: '新一輪獨立示意，不修改正式前情。' };
    const next = copy(state);
    const stage = id => next.locations[id] === 'stage';
    let message = '';
    if (action.type === 'view' && ['intro', 'play', 'menu'].includes(action.view)) {
      next.view = action.view; next.selected = null; message = action.view === 'play' ? '可操作；僅提案預覽。' : '閱讀／選單暫停計時。';
    } else if (action.type === 'tick') {
      if (state.view !== 'play' || state.result || !Number.isFinite(action.seconds) || action.seconds <= 0) return reject('目前不計時。');
      next.elapsedSeconds += action.seconds; message = state.message;
    } else {
      if (state.view !== 'play' || state.result) return reject('請返回操作頁；已完成的結果不能再結算。');
      if (action.type === 'flip') {
        next.side = state.side === 'front' ? 'back' : 'front'; next.selected = null;
        message = next.side === 'back' ? '背面開放取放；點物件再點舞台或原槽。' : '正面只能播放；取放請翻到背面。';
      } else if (action.type === 'select' && props.includes(action.prop)) {
        if (state.side !== 'back') return reject('正面不能取放，請先翻到背面。');
        next.selected = action.prop; message = '已選物件，請點目標位置。';
      } else if (action.type === 'place') {
        if (state.side !== 'back' || !state.selected || !['stage', 'rack'].includes(action.target)) return reject('先在背面選物件，再選位置。');
        const id = state.selected;
        if (state.locations[id] === action.target) return reject('物件已在此處。');
        if (action.target === 'stage') {
          if (state.phase === 'setup' && !['rain', 'record'].includes(id)) return reject('本幕指定雨景片與舊唱片。');
          if (state.phase === 'setup' && stage('previous')) return reject('先把上一幕道具收回原槽。');
          if (state.phase === 'closing' && (id !== 'blank' || stage('record') || stage('rain'))) return reject('先收回雨景片與唱片，再換空白收場片。');
          if (!['setup', 'closing'].includes(state.phase)) return reject('片段已結束，請收回道具。');
        }
        next.locations[id] = action.target; next.selected = null; message = action.target === 'rack' ? '物件已回原槽。' : '物件已放入舞台。';
      } else if (action.type === 'play') {
        if (state.side !== 'front') return reject('翻到正面才能播放。');
        if (state.phase === 'setup' && stage('rain') && stage('record') && !stage('previous')) {
          next.phase = 'closing'; next.rainViewed = true; next.view = 'intro';
          message = '固定片段示意：雨天、公車站、曾答應聽的舊歌。未提供動畫或音軌，沒有假裝已播放影片。';
        } else if (state.phase === 'closing' && stage('blank') && !stage('rain') && !stage('record')) {
          next.phase = 'cleanup'; next.refusalViewed = true; next.view = 'intro';
          message = '梁澄：今天想停一下。人物拒談是正常收束，請收好道具；信任不因一首歌自動恢復。';
        } else return reject('本幕道具未就緒，或片段已讀；回看不增加進度。');
      } else if (action.type === 'close') {
        if (state.side !== 'back' || state.phase !== 'cleanup' || props.some(stage)) return reject('先完成兩幕、翻回背面，將所有道具收回原槽才能闔上。');
        next.phase = 'result';
        next.result = { moduleId: 'T13', candidateId: 'MG-P12', run: state.run, outcome: 'proposal-complete', official: false, rewards: { score: 0, xp: 0, cultivation: 0 }, savePatch: null, globalMinutesApplied: 0 };
        message = '提案收台完成。梁澄拒談與信任受損的後果保留；未發正式獎勵、未完成正式章節。';
      } else return reject('未知或空操作。');
    }
    next.revision += 1; next.message = message;
    return { state: next, accepted: true, message };
  }
  return Object.freeze({ create, apply, copy });
});
