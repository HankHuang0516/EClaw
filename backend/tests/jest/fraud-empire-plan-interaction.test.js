/* global describe, test, expect */
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '../../public/AiHankApps/projects/fraud-empire');
const model = require(path.join(root, 'plan-interaction-model.js'));
const data = JSON.parse(fs.readFileSync(path.join(root, 'plan-interaction-data.json'), 'utf8'));
const act = (state, type, value) => model.transition(state, { type, value, step: state.step }, data).state;
function toMemories() {
  let s = model.createState();
  s = act(s, 'walk-inside'); s = act(s, 'continue');
  s = act(s, 'room-view', 'promise'); s = act(s, 'room-view', 'reality'); s = act(s, 'room-response', 'silent'); s = act(s, 'continue');
  s = act(s, 'bag-pick', 'blue'); s = act(s, 'bag-place'); s = act(s, 'continue');
  s = act(s, 'npc-approach'); s = act(s, 'npc-response', 'private'); s = act(s, 'continue');
  s = act(s, 'exit-skip'); s = act(s, 'continue');
  return s;
}
function complete() {
  let s = toMemories();
  s = act(s, 'memory-toggle', 'arrival'); s = act(s, 'memory-toggle', 'room');
  s = act(s, 'memory-save'); s = act(s, 'continue');
  return act(s, 'settle');
}
describe('Whole-plan interaction batch B01 — independent T02', () => {
  test('keeps seven source IDs, zero rewards, no supervisor pool or global clock', () => {
    expect(model.validateData(data)).toBe(true);
    expect(data.steps.map(s => s.id)).toEqual(Array.from({ length: 7 }, (_, i) => 'T02-S0' + (i + 1)));
    expect(data.pending.length).toBeGreaterThan(0);
    expect(model.validateData({ ...data, supervisorPool: true })).toBe(false);
  });
  test('movement changes a real state before a segment can be saved; stale input is rejected', () => {
    const start = model.createState();
    expect(act(start, 'continue')).toEqual(start);
    const inside = act(start, 'walk-inside');
    expect(inside.location).toBe('inside');
    expect(inside.records).toEqual([]);
    const saved = act(inside, 'continue');
    expect(saved.records).toEqual(['T02-S01']);
    expect(model.transition(saved, { type: 'continue', step: 0 }, data).state).toEqual(saved);
    expect(start.location).toBe('outside');
  });
  test('room views and either source response are distinct without invented affinity', () => {
    let s = act(act(model.createState(), 'walk-inside'), 'continue');
    s = act(s, 'room-view', 'promise'); s = act(s, 'room-view', 'reality');
    expect(s.inspectedViews).toEqual(['promise', 'reality']);
    expect(act(s, 'room-response', 'ask').roomChoice).toBe('ask');
    expect(act(s, 'room-response', 'silent').roomChoice).toBe('silent');
    expect(s.resources).toEqual({ score: 0, xp: 0, cultivation: 0 });
  });
  test('neither an unseen nor a single-view room can submit either response or continue', () => {
    let s = act(act(model.createState(), 'walk-inside'), 'continue');
    for (const choice of ['ask', 'silent']) expect(act(s, 'room-response', choice)).toEqual(s);
    expect(act(s, 'continue')).toEqual(s);
    s = act(s, 'room-view', 'promise');
    for (const choice of ['ask', 'silent']) expect(act(s, 'room-response', choice)).toEqual(s);
    expect(act(s, 'continue')).toEqual(s);
    s = act(s, 'room-view', 'reality');
    for (const choice of ['ask', 'silent']) expect(model.canContinue(act(s, 'room-response', choice))).toBe(true);
  });
  test('other peoples baggage cannot be taken and the owned bag must be held before placement', () => {
    let s = model.createState();
    s = act(s, 'walk-inside'); s = act(s, 'continue');
    s = act(s, 'room-view', 'promise'); s = act(s, 'room-view', 'reality');
    s = act(s, 'room-response', 'silent'); s = act(s, 'continue');
    expect(act(s, 'bag-pick', 'red')).toEqual(s);
    expect(act(s, 'bag-place')).toEqual(s);
    s = act(s, 'bag-pick', 'blue'); expect(s.bag).toBe('held');
    s = act(s, 'bag-place'); expect(s.bag).toBe('bedside');
    expect(act(s, 'bag-pick', 'blue')).toEqual(s);
  });
  test('NPC response requires approach and permits keeping personal details', () => {
    let s = model.createState();
    for (const [type, value] of [['walk-inside'], ['continue'], ['room-view', 'promise'], ['room-view', 'reality'], ['room-response', 'silent'], ['continue'], ['bag-pick', 'blue'], ['bag-place'], ['continue']]) s = act(s, type, value);
    expect(act(s, 'npc-response', 'open')).toEqual(s);
    s = act(s, 'npc-approach'); s = act(s, 'npc-response', 'private');
    expect(s.npcChoice).toBe('private'); expect(model.canContinue(s)).toBe(true);
  });
  test('unavailable media is never marked played; only authored explicit skip permits continuation', () => {
    let s = toMemories();
    s = { ...s, step: 4, records: s.records.slice(0, 4), exitSkipped: false };
    s = act(s, 'exit-open'); s = act(s, 'exit-return');
    expect(s.animationPlayed).toBe(false); expect(model.canContinue(s)).toBe(false);
    s = act(s, 'exit-skip'); expect(model.canContinue(s)).toBe(true);
    expect(s.animationPlayed).toBe(false);
  });
  test('two experienced memories must be selected and explicitly saved', () => {
    let s = toMemories();
    expect(act(s, 'memory-save')).toEqual(s);
    s = act(s, 'memory-toggle', 'arrival'); expect(act(s, 'memory-save')).toEqual(s);
    s = act(s, 'memory-toggle', 'room'); expect(s.savedMemories).toEqual([]);
    s = act(s, 'memory-save'); expect(s.savedMemories).toEqual(['arrival', 'room']);
  });
  test('completion records every segment once and never applies pending time or rewards', () => {
    const s = complete();
    expect(s.complete).toBe(true); expect(s.records).toHaveLength(7);
    expect(new Set(s.records).size).toBe(7); expect(s.flags).toEqual(['T02_completed']);
    expect(s.proposedActionMinutes).toBe(20); expect(s.globalClockMinutesApplied).toBe(0);
    expect(s.resources).toEqual({ score: 0, xp: 0, cultivation: 0 });
    expect(act(s, 'settle')).toEqual(s);
  });
  test('replay is read-only and reset makes a separate empty demonstration timeline', () => {
    const s = complete(); let replay = act(s, 'review-start');
    for (let i = 0; i < 12; i++) replay = act(replay, 'review-next');
    expect(replay.reviewIndex).toBe(6); expect(replay.records).toEqual(s.records);
    expect(replay.resources).toEqual(s.resources); expect(replay.proposedActionMinutes).toBe(s.proposedActionMinutes);
    const reset = act(replay, 'reset');
    expect(reset.timeline).toBe(2); expect(reset.records).toEqual([]); expect(reset.complete).toBe(false);
    const snapshot = model.snapshot(s); snapshot.records.push('fake'); expect(s.records).toHaveLength(7);
  });
  test('coverage counts are source records, not completed features; no server save or tracking is added', () => {
    const coverage = JSON.parse(fs.readFileSync(path.join(root, 'interaction-coverage.json'), 'utf8'));
    expect(coverage.totalRecords).toBe(696); expect(coverage.chapterHeadings).toBe(230);
    expect(coverage.legacySteps).toBe(119); expect(coverage.batches).toHaveLength(7);
    const script = fs.readFileSync(path.join(root, 'plan-interaction.js'), 'utf8');
    expect(script).not.toMatch(/localStorage|sessionStorage|indexedDB|sendBeacon|method\s*:\s*['"]POST|<iframe|eval\(/);
    expect(script).toMatch(/fullPlanComplete:\s*false/);
  });
});
