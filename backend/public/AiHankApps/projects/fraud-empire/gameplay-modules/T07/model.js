/* Proposal only. No storage, global clock, resource mutation or network. */
((root, factory) => {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FraudT07Model = api;
})(globalThis, () => {
  'use strict';
  const copy = value => JSON.parse(JSON.stringify(value));
  const snapshots = Object.freeze({ morning: '晨間｜R7 待記6｜餘額24', noon: '午間｜R7 已記6｜餘額30', evening: '晚間｜R7 沖回6｜餘額24' });
  function create(session) {
    if (typeof session !== 'string' || !session) throw new TypeError('session required');
    return { schemaVersion: 1, module: 'T07', proposal: 'MG-P06-v2', session, revision: 0, selected: null, slots: [null, null], tape: [], closed: false, result: null, view: 'work', previewOnly: true, clock: { paused: true, elapsedGameMinutes: 0, workMinutes: null }, awardedReward: 0 };
  }
  function apply(state, command) {
    const reject = message => ({ state, accepted: false, message });
    if (!command || command.session !== state.session || command.revision !== state.revision) return reject('已忽略過期或重複操作。');
    const next = copy(state);
    let message = '';
    if (command.type === 'view') {
      if (!['work', 'help', 'menu'].includes(command.view)) return reject('未知頁面。');
      next.view = command.view;
      next.selected = null;
      message = '閱讀與選單停表；本局進度保留。';
    } else {
      if (state.view !== 'work') return reject('請先返回操作頁。');
      if (state.closed) return reject('本件已完成；只能回看，重玩請重設。');
      switch (command.type) {
      case 'select':
        if (!Object.hasOwn(snapshots, command.snapshot)) return reject('請選擇來源快照。');
        if (state.slots.includes(command.snapshot) || state.tape.includes(command.snapshot)) return reject('此態已在工作窗或結果帶，不能複製回工作窗。');
        next.selected = command.snapshot; message = '已選快照，請點空工作窗。'; break;
      case 'cancel':
        next.selected = null; message = '已取消選取。'; break;
      case 'place':
        if (![0, 1].includes(command.slot) || !state.selected || state.slots[command.slot]) return reject('先選快照，再點空窗；不會覆蓋既有快照。');
        next.slots[command.slot] = state.selected; next.selected = null; message = '快照已入窗；兩窗齊備後可輸出。'; break;
      case 'remove':
        if (![0, 1].includes(command.slot) || !state.slots[command.slot]) return reject('此窗沒有快照。');
        if (state.tape.includes(state.slots[command.slot])) return reject('前段後態須保留作下一段起點，不能取回。');
        next.slots[command.slot] = null; message = '快照已取回，可重新排列。'; break;
      case 'output': {
        const expected = state.tape.length === 0 ? ['morning', 'noon'] : state.tape.length === 2 ? ['noon', 'evening'] : null;
        if (!expected || !expected.every(id => state.slots.includes(id))) return reject('未銜接：先待記→已記，再已記→沖回。可取回未輸出的快照重排；不扣時間或資源。');
        next.tape = state.tape.length === 0 ? expected : [...state.tape, 'evening'];
        next.slots[state.slots.indexOf(expected[0])] = null;
        next.selected = null;
        message = '已輸出；前態釋槽，後態保留。結果帶永久保留本局已完成段落。'; break;
      }
      case 'close':
        if (state.tape.join(',') !== 'morning,noon,evening') return reject('三態尚未齊全，不能關閉本件。');
        next.closed = true; next.slots = [null, null]; next.selected = null;
        next.result = { id: state.session + ':result', module: 'T07', proposal: 'MG-P06-v2', previewOnly: true, outcome: 'completed', tape: [...state.tape], fictionalNet: 0, awardedReward: 0, persistAllowed: false, consequence: '主管仍把誇張警報貼回外層；許澄受到驚擾，需要時間平復。帳面恢復不代表傷害消失。' };
        message = '本件已放入完成匣；沒有正式獎勵或正式存檔。'; break;
      default: return reject('未知操作。');
      }
    }
    next.revision += 1;
    return { state: next, accepted: true, message };
  }
  return { create, apply, snapshots, copy };
});
