const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '../../public/AiHankApps/projects/fraud-empire');
const model = require(path.join(root, 'interactive-prototype-model.js'));
const data = JSON.parse(fs.readFileSync(path.join(root, 'interactive-prototype-data.json'), 'utf8'));

describe('fraud empire two interactive proposal prototypes', () => {
  let state, n;
  const start = game => { n = 0; state = model.create(game, 'test-session', data); };
  const act = (type, payload = {}) => {
    const command = { ...payload, type, id: 'event-' + (++n), session: state.session, revision: state.revision };
    const outcome = model.apply(state, command);
    state = outcome.counted ? model.finishEvent(outcome.state, command.id) : outcome.state;
    return outcome;
  };
  const place = (job, slot) => expect(act('place_job', { job, slot }).accepted).toBe(true);
  const advance = () => expect(act('advance_round').accepted).toBe(true);
  const p02Proof = () => {
    expect(act('place_piece', { piece: 'moon', ticket: 'tao_ke' }).accepted).toBe(true);
    for (const [ticket, seat] of [['bi_an', 'A'], ['tao_ke', 'A'], ['fu_lin', 'B']]) expect(act('place_ticket', { ticket, seat }).accepted).toBe(true);
    expect(act('reveal_top_A', { ticket: 'tao_ke' }).accepted).toBe(true);
    expect(act('inspect_model').accepted).toBe(true);
    expect(act('mark_duplicate', { pair: ['tao_ke', 'bi_an'] }).accepted).toBe(true);
    for (const ticket of ['tao_ke', 'bi_an', 'fu_lin']) expect(act('view_expectation', { ticket }).accepted).toBe(true);
    expect(model.proofMissing(state)).toEqual([]);
  };

  test('pins paused independent fixtures, the one missing moon, and proposal boundaries', () => {
    expect(model.validate(data)).toBe(true);
    for (const id of ['MG-P01', 'MG-P02']) {
      const s = model.create(id, id, data);
      expect(s.logicalStep).toBe(0); expect(s.resultCount).toBe(0); expect(s.awardedReward).toBe(0); expect(s.clock.paused).toBe(true);
    }
    start('MG-P02');
    expect(state.tickets.filter(t => model.ticketComplete(state, t))).toHaveLength(2);
    expect(data.fixtures['MG-P02'].tickets.map(t => t.fixedSeat)).toEqual(['A', 'A', 'B']);
    expect(JSON.stringify(data)).not.toMatch(/\/Users\/|\/Volumes\//);
    const ui = fs.readFileSync(path.join(root, 'interactive-prototype.js'), 'utf8');
    expect(ui).not.toMatch(/localStorage|sessionStorage|indexedDB|sendBeacon|method\s*:\s*['"]POST/);
    expect(ui).toContain('restoreFocus(focused)'); expect(ui).toContain('preventScroll: true');
    expect(ui).toContain('change.dataset.switchGame = id');
    expect(ui).not.toContain('event.detail > 1');
    expect(ui).toContain("crop.setAttribute('width', '306')");
    expect(ui).toContain('if (confirmed && states?.[old.game]?.pendingEvent)');
  });

  test.each([[2, 6], [3, 7], [4, 8]])('P01 supports %i nonempty rounds with %i counted steps', (rounds, steps) => {
    start('MG-P01');
    if (rounds === 2) { place('fang_cen', 0); place('mi_luo', 1); advance(); place('duo_na', 1); advance(); }
    if (rounds === 3) { place('mi_luo', 0); place('duo_na', 1); advance(); place('fang_cen', 0); advance(); advance(); }
    if (rounds === 4) { place('fang_cen', 0); advance(); advance(); place('mi_luo', 0); advance(); place('duo_na', 0); advance(); }
    expect(state.round).toBe(rounds); expect(state.completed).toHaveLength(3); expect(state.slots).toEqual([null, null]);
    expect(act('handoff').accepted).toBe(true); expect(state.logicalStep).toBe(steps); expect(state.resultCount).toBe(1); expect(state.awardedReward).toBe(0);
    expect(act('handoff').accepted).toBe(false); expect(act('return_to_desk').accepted).toBe(true); expect(state.resultCount).toBe(1);
  });

  test('P01 rejects empty/occupied/duplicate/terminal operations and only withdraws before progress', () => {
    start('MG-P01'); expect(act('advance_round').accepted).toBe(false); expect(state.logicalStep).toBe(0);
    place('fang_cen', 0); expect(act('place_job', { job: 'mi_luo', slot: 0 }).accepted).toBe(false);
    expect(act('place_job', { job: 'fang_cen', slot: 1 }).accepted).toBe(false);
    expect(act('remove_staged', { job: 'fang_cen' }).accepted).toBe(true); place('fang_cen', 0); advance();
    const before = state.logicalStep; expect(act('remove_staged', { job: 'fang_cen' }).accepted).toBe(false); expect(state.logicalStep).toBe(before);
    place('mi_luo', 1); advance(); expect(state.jobs.find(j => j.id === 'mi_luo').state).toBe('EXITED');
    expect(act('place_job', { job: 'mi_luo', slot: 1 }).accepted).toBe(false);
  });

  test('work lock, event identity, revision and session reject replays and stale reset callbacks', () => {
    start('MG-P01'); place('fang_cen', 0);
    const command = { type: 'advance_round', id: 'rapid', session: state.session, revision: state.revision };
    const first = model.apply(state, command); expect(first.accepted).toBe(true);
    expect(model.apply(first.state, command).accepted).toBe(false);
    expect(model.apply(first.state, { ...command, id: 'rapid-2', revision: first.state.revision }).accepted).toBe(false);
    expect(first.state.jobs.find(j => j.id === 'fang_cen').progress).toBe(1);
    const fresh = model.create('MG-P01', 'new-session', data);
    expect(model.finishEvent(fresh, 'rapid')).toEqual(fresh);
    expect(model.apply(fresh, command).accepted).toBe(false);
  });

  test('P02 wrong shapes cost nothing; one added moon can be removed only while off the board', () => {
    start('MG-P02');
    for (const piece of ['star', 'cloud']) expect(act('place_piece', { piece, ticket: 'tao_ke' }).accepted).toBe(false);
    expect(state.logicalStep).toBe(0); expect(act('place_piece', { piece: 'moon', ticket: 'tao_ke' }).accepted).toBe(true);
    expect(act('place_piece', { piece: 'moon', ticket: 'tao_ke' }).accepted).toBe(false);
    expect(act('remove_piece', { ticket: 'bi_an' }).accepted).toBe(false);
    expect(act('place_ticket', { ticket: 'tao_ke', seat: 'A' }).accepted).toBe(true);
    expect(act('remove_piece', { ticket: 'tao_ke' }).accepted).toBe(false);
    expect(act('take_back_ticket', { ticket: 'tao_ke' }).accepted).toBe(true);
    expect(act('remove_piece', { ticket: 'tao_ke' }).accepted).toBe(true); expect(state.phase).toBe('ASSEMBLY');
  });

  test('P02 proof uses actual A stack order, all expectations and fixed A/A pair', () => {
    start('MG-P02'); p02Proof(); expect(state.boardStacks.A).toEqual(['bi_an', 'tao_ke']);
    expect(act('mark_duplicate', { pair: ['tao_ke', 'fu_lin'] }).accepted).toBe(false);
    expect(act('take_back_ticket', { ticket: 'bi_an' }).accepted).toBe(true);
    expect(state.overlapRevealed).toBe(false); expect(state.duplicateMarked).toBe(false); expect(model.proofMissing(state).length).toBeGreaterThan(0);
    expect(act('preview_choice', { choice: 'pause_batch' }).accepted).toBe(false);
  });

  test.each(['return_marked', 'pause_batch'])('P02 %s preserves three consequences and seals exactly once at step11', choice => {
    start('MG-P02'); p02Proof(); expect(act('preview_choice', { choice }).accepted).toBe(true);
    expect(act('cancel_choice').accepted).toBe(true); expect(state.committed).toBe(false);
    expect(act('preview_choice', { choice }).accepted).toBe(true); expect(act('confirm_choice').accepted).toBe(true);
    expect(state.committedChoice).toBe(choice);
    expect(act('take_back_ticket', { ticket: 'tao_ke' }).accepted).toBe(false);
    for (const ticket of ['tao_ke', 'bi_an']) { act('view_followup', { ticket }); expect(act('attach_followup', { ticket }).accepted).toBe(true); }
    expect(act('seal').accepted).toBe(false); act('view_followup', { ticket: 'fu_lin' }); expect(act('attach_followup', { ticket: 'fu_lin' }).accepted).toBe(true);
    expect(act('seal').accepted).toBe(true); expect(state.logicalStep).toBe(11); expect(state.resultCount).toBe(1); expect(state.awardedReward).toBe(0);
    const before = state.logicalStep; expect(act('seal').accepted).toBe(false); expect(act('confirm_choice').accepted).toBe(false);
    expect(state.logicalStep).toBe(before); expect(state.tickets.map(t => t.consequence)).toEqual(data.fixtures['MG-P02'].tickets.map(t => t.consequence));
  });
});
