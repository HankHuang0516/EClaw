/* global window */
(function (root) {
  'use strict';
  const copy = value => JSON.parse(JSON.stringify(value));
  function validateData(data) {
    return Boolean(data && data.schemaVersion === 1 && data.moduleId === 'T02' &&
      data.supervisorPool === false && data.clock.appliedToGlobalClock === false &&
      data.steps.length === 7 && data.steps.every((step, i) => step.id === 'T02-S0' + (i + 1)) &&
      ['score', 'xp', 'cultivation'].every(key => data.rewards[key] === 0));
  }
  function createState(timeline = 1) {
    return {
      schemaVersion: 1, timeline, step: 0, mode: 'play', reviewIndex: 0,
      location: 'outside', roomView: null, inspectedViews: [], roomChoice: null,
      bag: 'floor', npcApproached: false, npcChoice: null, exitViewed: false,
      exitSkipped: false, animationPlayed: false, selectedMemories: [], savedMemories: [],
      records: [], flags: [], complete: false, proposedActionMinutes: 0,
      globalClockMinutesApplied: 0, resources: { score: 0, xp: 0, cultivation: 0 }
    };
  }
  function canContinue(state) {
    if (state.complete || state.mode !== 'play') return false;
    return [
      state.location === 'inside', state.roomChoice !== null && state.inspectedViews.includes('promise') && state.inspectedViews.includes('reality'), state.bag === 'bedside',
      state.npcApproached && state.npcChoice !== null, state.exitSkipped,
      state.savedMemories.length === 2, false
    ][state.step] === true;
  }
  function transition(state, action, data) {
    if (!validateData(data)) return { state, changed: false, message: '來源資料未通過檢查，互動暫停。' };
    if (action.type === 'reset') return { state: createState(state.timeline + 1), changed: true, message: '已建立獨立提案試玩；不合併原時間線。' };
    const next = copy(state);
    const done = message => ({ state: next, changed: true, message });
    const hold = message => ({ state, changed: false, message });
    if (action.type === 'review-start') {
      if (!state.complete) return hold('完成本序章後才有完整回顧。');
      next.mode = 'review'; next.reviewIndex = 0;
      return done('只讀回顧，不重發資源、不推進時間。');
    }
    if (state.mode === 'review') {
      if (action.type === 'review-next') next.reviewIndex = Math.min(6, next.reviewIndex + 1);
      else if (action.type === 'review-previous') next.reviewIndex = Math.max(0, next.reviewIndex - 1);
      else if (action.type === 'review-exit') next.mode = 'play';
      else return hold('回顧不提交遊戲操作。');
      return done('只讀回顧；本時間線的紀錄與資源不變。');
    }
    if (state.complete) return hold('本時間線已完成；可只讀回顧，不能重領。');
    if (action.step !== state.step) return hold('段落已變動，這次舊操作未提交。');
    const finishStep = () => {
      const step = data.steps[next.step];
      if (!next.records.includes(step.id)) {
        next.records.push(step.id);
        next.proposedActionMinutes += step.actionMinutes;
      }
      next.step += 1;
      if (next.step === 7) { next.complete = true; next.flags.push('T02_completed'); }
    };
    if (action.type === 'continue') {
      if (!canContinue(state)) return hold('先完成本段明列的物件操作。');
      finishStep(); return done('已保存這一段互動；全局時鐘與資源未變。');
    }
    if (state.step === 0 && action.type === 'walk-inside') {
      next.location = 'inside'; return done('主角已從門外走到門內站位，行李仍在身邊。');
    }
    if (state.step === 1) {
      if (action.type === 'room-view' && ['promise', 'reality'].includes(action.value)) {
        next.roomView = action.value;
        if (!next.inspectedViews.includes(action.value)) next.inspectedViews.push(action.value);
        return done(action.value === 'promise' ? '查看住宿承諾：單人房。' : '查看眼前現實：多人床位。');
      }
      if (action.type === 'room-response' && ['ask', 'silent'].includes(action.value)) {
        if (!state.inspectedViews.includes('promise') || !state.inspectedViews.includes('reality')) return hold('先查看住宿承諾與眼前房間兩個熱點；詢問或沉默都可繼續，沒有懲罰。');
        next.roomChoice = action.value;
        return done(action.value === 'ask' ? '已選詢問住處；保留這次回應。' : '已選先沉默；仍可繼續，不捏造懲罰。');
      }
    }
    if (state.step === 2) {
      if (action.type === 'bag-pick' && action.value === 'red') return hold('紅行李屬於他人，不能收取；不扣分或懲罰。');
      if (action.type === 'bag-pick' && action.value === 'blue') {
        if (state.bag !== 'floor') return hold('自己的行李已拿起或放置，不複製物品。');
        next.bag = 'held'; return done('已拿起自己的藍行李，接著點床邊放置。');
      }
      if (action.type === 'bag-place') {
        if (state.bag !== 'held') return hold('先拿起自己的藍行李；不移動他人的物品。');
        next.bag = 'bedside'; return done('自己的藍行李已放到床邊；這不是核准宿舍布局。');
      }
    }
    if (state.step === 3) {
      if (action.type === 'npc-approach') { next.npcApproached = true; return done('已走近成年室友小雨；可以自行保留個人細節。'); }
      if (action.type === 'npc-response' && ['open', 'private'].includes(action.value)) {
        if (!state.npcApproached) return hold('先點小雨走近，再選回應。');
        next.npcChoice = action.value;
        return done(action.value === 'open' ? '已保留「說出剛來」回應；不擅加好感數值。' : '已保留「暫不多談」回應；不等於拒絕同伴支持。');
      }
    }
    if (state.step === 4) {
      if (action.type === 'exit-open') { next.exitViewed = true; return done('已查看出口與受困資訊。短片未提供，尚未播放。'); }
      if (action.type === 'exit-return') { next.exitViewed = false; return done('已回床邊；沒有假定未提供的短片播放完成。'); }
      if (action.type === 'exit-skip') { next.exitSkipped = true; next.exitViewed = false; return done('依來源明確略過壓迫演出；保留受困故事資訊，未宣稱播放短片。'); }
    }
    if (state.step === 5) {
      if (action.type === 'memory-toggle' && ['arrival', 'room'].includes(action.value)) {
        if (!state.records.includes('T02-S01') || !state.records.includes('T02-S02')) return hold('只可保存這條時間線已親歷的記憶。');
        next.selectedMemories = state.selectedMemories.includes(action.value) ? state.selectedMemories.filter(id => id !== action.value) : [...state.selectedMemories, action.value];
        return done('記憶選取已變更；按保存才寫入這次前端故事簿。');
      }
      if (action.type === 'memory-save') {
        if (state.selectedMemories.length !== 2) return hold('請選取到場與住宿兩段已親歷記憶。');
        next.savedMemories = ['arrival', 'room']; return done('兩段到場記憶已保存，不取得他人的物品或資料。');
      }
    }
    if (state.step === 6 && action.type === 'settle') {
      if (state.bag !== 'bedside' || state.savedMemories.length !== 2 || state.records.length !== 6) return hold('安置前需保留自己的行李與兩段記憶。');
      finishStep(); return done('T02 本時間線完成一次。業績、XP、培養點均為 0；沒有睡眠效果。');
    }
    return hold('這個操作不屬於目前段落，狀態未變。');
  }

  const checkpointKeys = ['schemaVersion','kind','moduleId','owner','sourceVersion','sourceHash','commands','pending','snapshot'];
  const checkpointActions = new Set(['walk-inside','room-view','room-response','bag-pick','bag-place','npc-approach','npc-response','exit-open','exit-return','exit-skip','memory-toggle','memory-save','continue','settle','review-start','review-previous','review-next','review-exit','reset']);
  const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join('|') === [...keys].sort().join('|');
  const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key,stable(value[key])])) : value;
  const equal = (a,b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));
  function freezeCheckpoint(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      Object.freeze(value); for (const child of Object.values(value)) freezeCheckpoint(child);
    }
    return value;
  }
  function createCheckpoint(commands, pending, data, owner) {
    if (!validateData(data) || typeof data.version !== 'string' || !/^[a-f0-9]{64}$/.test(data.source?.contentHash || '') || typeof owner !== 'string' || !owner || owner.length > 200 || !Array.isArray(commands) || commands.length > 500 || JSON.stringify(commands).length > 150000) throw Error('invalid-private-prologue-input');
    let replayed = createState();
    for (const command of commands) {
      if (!exactKeys(command,['type','value','step']) || !checkpointActions.has(command.type) || typeof command.value !== 'string' || command.value.length > 80 || !Number.isSafeInteger(command.step) || command.step < 0 || command.step > 7) throw Error('invalid-private-prologue-command');
      const out = transition(replayed,command,data);
      if (!out.changed) throw Error('incompatible-private-prologue-command');
      replayed = out.state;
    }
    if (pending !== null && !['T02-S01','T02-S05'].includes(pending)) throw Error('invalid-private-prologue-pending');
    if (pending !== null && (replayed.complete || replayed.mode !== 'play' || pending === 'T02-S01' && (replayed.step !== 0 || replayed.location !== 'outside') || pending === 'T02-S05' && replayed.step !== 4)) throw Error('private-prologue-pending-owner');
    return freezeCheckpoint({schemaVersion:1,kind:'private-prologue-checkpoint',moduleId:'T02',owner,sourceVersion:data.version,sourceHash:data.source.contentHash,commands:copy(commands),pending,snapshot:copy(replayed)});
  }
  function prepareCheckpoint(value,data,owner) {
    if (!exactKeys(value,checkpointKeys) || value.schemaVersion !== 1 || value.kind !== 'private-prologue-checkpoint' || value.moduleId !== 'T02' || value.owner !== owner || value.sourceVersion !== data.version || value.sourceHash !== data.source?.contentHash) throw Error('private-prologue-checkpoint-identity');
    const checked = createCheckpoint(value.commands,value.pending,data,owner);
    if (!equal(value.snapshot,checked.snapshot)) throw Error('private-prologue-checkpoint-state');
    return checked;
  }

  const api = { validateData, createState, canContinue, transition, snapshot: copy, createCheckpoint, prepareCheckpoint };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.FraudPlanInteractionModel = Object.freeze(api);
})(typeof window !== 'undefined' ? window : null);
