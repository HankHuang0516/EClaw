/* Isolated proposal model: no storage, clock service or reward service. */
(function (root) {
  'use strict';
  const copy = value => JSON.parse(JSON.stringify(value));
  const minutes = [30, 10, 10, 10, 10, 0, 30];
  function create() {
    return { version: 1, revision: 0, step: 0, paused: false, selectedDay: null,
      outbound: null, inbound: null, inspected: [], ending: null, records: [],
      proposedMinutes: 0, result: null, resultCount: 0 };
  }
  function ready(s) {
    return [true, s.outbound === 1 && s.inbound === 3,
      ['inn', 'night1', 'night2'].every(x => s.inspected.includes(x)),
      ['zhou', 'list', 'promise'].every(x => s.inspected.includes(x)),
      ['missingNight', 'missingPerson'].every(x => s.inspected.includes(x)) && !!s.ending,
      s.inspected.includes('summary'), s.inspected.includes('album')][s.step] === true;
  }
  function apply(state, action) {
    const reject = message => ({ state, accepted: false, message });
    if (!action || action.revision !== state.revision) return reject('空操作或過期操作未提交。');
    const s = copy(state);
    const accept = message => { s.revision++; return { state: s, accepted: true, message }; };
    if (action.type === 'reset') { const fresh = create(); fresh.revision = s.revision + 1; return { state: fresh, accepted: true, message: '已重開獨立預覽；正式資源未變。' }; }
    if (action.type === 'pause' || action.type === 'resume') {
      const pause = action.type === 'pause';
      if (s.paused === pause) return reject('目前已是此狀態。');
      s.paused = pause; return accept(pause ? '已返回選單；閱讀停表。' : '已回到本次預覽進度。');
    }
    if (s.paused || s.result) return reject('選單或已結束狀態不能提交工作。');
    if (action.type === 'day' && s.step === 1 && [1, 2, 3].includes(action.value)) {
      s.selectedDay = action.value; return accept('已選霧日' + action.value + '；再點固定船班。');
    }
    if (action.type === 'place' && s.step === 1 && ['outbound', 'inbound'].includes(action.value)) {
      const expected = action.value === 'outbound' ? 1 : 3;
      if (s.selectedDay !== expected) return reject('錯放：這張固定船班只屬於霧日' + expected + '，請重新選日期。');
      if (s[action.value] === expected) return reject('船班已落位，沒有複製。');
      s[action.value] = expected; return accept('船班已落位；需要兩夜住宿。');
    }
    if (action.type === 'undo' && s.step === 1) {
      s.outbound = null; s.inbound = null; s.selectedDay = null; return accept('已撤回船班，可重新放置。');
    }
    const views = { 2: ['inn', 'night1', 'night2'], 3: ['zhou', 'list', 'promise'], 4: ['missingNight', 'missingPerson'], 5: ['summary'], 6: ['album'] };
    if (action.type === 'inspect' && (views[s.step] || []).includes(action.value)) {
      if (s.inspected.includes(action.value)) return reject('已查看；重讀不推進時間。');
      s.inspected.push(action.value); return accept('已查看並保留此項事實；閱讀不推進時間。');
    }
    if (action.type === 'ending' && s.step === 4 && ['cancel', 'dispute'].includes(action.value)) {
      if (!['missingNight', 'missingPerson'].every(x => s.inspected.includes(x))) return reject('先點出缺住宿與漏同行兩項缺口。');
      s.ending = action.value; return accept(action.value === 'cancel' ? '取消：兩人不登船，舊版提案故事入帳沖回。' : '保留爭議：兩人不出發，爭議待解決；不假定已退款。');
    }
    if (action.type === 'confirm') {
      if (!ready(s)) return reject('本段操作未齊全；請先完成畫面所列目標。');
      s.records.push('T09-S0' + (s.step + 1)); s.proposedMinutes += minutes[s.step]; s.step++;
      if (s.step === 7) {
        s.resultCount = 1;
        s.result = { moduleId: 'T09', proposal: true, outcome: s.ending, departed: 0,
          proposedMinutes: s.proposedMinutes, completedSegments: 3,
          proposedBaseScore: 600, officialRewards: 0, formalSave: false,
          storyNetReceipts: s.ending === 'cancel' ? 0 : null };
      }
      return accept(s.result ? '提案流程已完成一次；兩人未成行。沒有正式獎勵或存檔。' : '已確認本段；只累計來源提案動作分鐘。');
    }
    return reject('此操作不屬於目前步驟。');
  }
  const api = Object.freeze({ create, apply, ready, snapshot: copy });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.FraudT09Model = api;
})(typeof window === 'undefined' ? null : window);
