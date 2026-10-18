(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FraudT11Model = api;
})(globalThis, function () {
  'use strict';
  const copy = value => JSON.parse(JSON.stringify(value));
  function create(session) {
    if (typeof session !== 'string' || !session) throw new Error('session required');
    return { schema: 1, module: 'T11', rules: 'legacy-v4-proposal', session, revision: 0,
      step: 1, paused: true, elapsedMs: 0, selected: null, assignments: {},
      wrongPlacements: 0, wrongYears: 0, year: null, outline: false,
      branch: null, badge: false, holding: null, withdrawal: null,
      result: null, followup: null, processed: [] };
  }
  function apply(state, action) {
    const reject = message => ({ state, accepted: false, message });
    if (!action || action.session !== state.session || action.revision !== state.revision ||
      typeof action.id !== 'string' || !action.id || state.processed.includes(action.id)) return reject('過期或重複操作已忽略。');
    const s = copy(state);
    if (action.type === 'pause') s.paused = true;
    else if (action.type === 'resume') s.paused = false;
    else if (action.type === 'tick') {
      if (s.paused || s.result || !Number.isFinite(action.ms) || action.ms <= 0) return reject('閱讀／選單／結案停表。');
      s.elapsedMs = Math.min(1200000, s.elapsedMs + action.ms);
      if (s.elapsedMs === 1200000) finish(s, 'partial');
    } else {
      if (s.paused) return reject('請先開始或繼續操作。');
      if (s.result && action.type !== 'followup') return reject('本輪已交班，只能回看或處理一次日末。');
      switch (action.type) {
      case 'accept':
        if (s.step !== 1) return reject('名單已鎖定。');
        s.step = 2; break;
      case 'select':
        if (s.step !== 2 || !['model', 'music'].includes(action.item)) return reject('請選本輪現有道具。');
        s.selected = action.item; break;
      case 'place': {
        if (s.step !== 2 || !s.selected || !['zheng', 'qian', 'luo'].includes(action.person)) return reject('先選道具，再選人物。');
        const expected = s.selected === 'model' ? 'zheng' : 'qian';
        if (action.person !== expected) {
          s.wrongPlacements += 1; s.selected = null;
          if (s.wrongPlacements >= 1) { s.step = 3; }
        } else { s.assignments[action.person] = s.selected; s.selected = null; }
        break;
      }
      case 'undo':
        if (s.step !== 2 || !s.assignments[action.person]) return reject('沒有可撤回的未確認分配。');
        delete s.assignments[action.person]; break;
      case 'confirm':
        if (s.step !== 2 || s.assignments.zheng !== 'model' || s.assignments.qian !== 'music') return reject('兩件實物尚未配給對應願望。');
        s.step = 3; break;
      case 'branch':
        if (s.step !== 3 || !['find', 'cancel'].includes(action.choice)) return reject('請明確選擇補缺或公開取消。');
        s.branch = action.choice; s.step = 4; break;
      case 'year':
        if (s.step !== 4 || s.branch !== 'find' || ![6, 7, 8].includes(action.year)) return reject('此處沒有可查找的年份。');
        s.year = action.year; s.outline = false; break;
      case 'outline':
        if (s.step !== 4 || s.branch !== 'find' || s.year === null) return reject('先打開檔案年份。');
        if (s.year === 7) s.outline = true;
        else { s.wrongYears += 1; if (s.wrongYears > 2) { s.branch = 'cancel'; s.year = null; } }
        break;
      case 'collect':
        if (s.step !== 4 || s.branch !== 'find' || !s.outline || s.badge) return reject('先找到第七年照片背面的紀念章輪廓。');
        s.badge = true; s.assignments.luo = 'badge'; s.step = 5; break;
      case 'cancel':
        if (s.step !== 4) return reject('目前不能取消缺額。');
        s.branch = 'cancel'; s.step = 5; break;
      case 'withdraw':
        if (![5, 6].includes(s.step) || !['keep', 'return'].includes(action.choice)) return reject('請選擇保留或收回。');
        s.withdrawal = action.choice;
        s.holding = action.choice === 'keep' && s.assignments.qian === 'music' ? 'qian' : null;
        s.step = 6; break;
      case 'back':
        if (s.step !== 6) return reject('此處不能倒退已確認的操作。');
        s.step = 5; break;
      case 'handoff':
        if (s.step !== 6 || !s.withdrawal) return reject('請先處理退出者與交班明細。');
        finish(s, s.wrongPlacements ? 'partial' : 'complete'); break;
      case 'exit': finish(s, 'partial'); break;
      case 'followup':
        if (!s.result || s.followup || !['arrived', 'absent'].includes(action.event)) return reject('日末事件尚未具備條件或已處理。');
        s.followup = s.holding ? action.event : 'no-reservation'; s.holding = null; s.step = 7; break;
      default: return reject('沒有這項操作。');
      }
    }
    s.revision += 1; s.processed.push(action.id);
    const message = action.type === 'outline' && s.wrongYears > state.wrongYears
      ? (s.wrongYears > 2
        ? '第' + state.year + '年照片背面沒有紀念章輪廓；第3次誤查已超過2次容錯，已轉為取消支線；請確認公開取消第三份，尚未取得紀念章。'
        : '第' + state.year + '年照片背面沒有紀念章輪廓；誤查 ' + s.wrongYears + '／2，請重新核對檔案年份。')
      : s.wrongPlacements && s.step === 3 ? '分配容錯已用盡，本段保留未完成後果；可繼續缺額支線。' : '操作已記錄；僅本輪提案預覽。';
    return { state: s, accepted: true, message }; 
  }
  function finish(s, status) {
    const people = {
      zheng: s.assignments.zheng ? 'delivered' : 'cancelled',
      qian: s.holding === 'qian' ? 'reserved' : 'cancelled',
      luo: s.badge ? 'delivered' : 'cancelled'
    };
    s.result = { id: s.session + ':result', module: 'T11', proposal: true, status,
      people, delivered: Object.values(people).filter(v => v === 'delivered').length,
      reserved: Object.values(people).filter(v => v === 'reserved').length,
      cancelled: Object.values(people).filter(v => v === 'cancelled').length,
      physicalSupply: 2 + Number(s.badge), elapsedGameMinutes: s.elapsedMs / 60000,
      reward: { score: 0, xp: 0, cultivation: 0 }, writesOfficialSave: false };
    s.step = 7; s.paused = true;
  }
  return { create, apply };
});
