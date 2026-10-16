const model = require('../../public/AiHankApps/projects/fraud-empire/demo-feedback-model');

const ID = '7b0b62d4-2441-46ce-8b2d-baf732bd45c8';
function draft() { return model.create({ capturedAt: 'fixed', screen: { sceneId: 'M02', visibleText: '已顯示畫面' }, game: { day: null } }, ID); }

test('snapshot is copied at opening and remains frozen across scene changes', () => {
  const scene = { screen: { sceneId: 'M02' }, game: { day: null } };
  const report = model.create(scene, ID);
  scene.screen.sceneId = 'M07';
  expect(report.snapshot.screen.sceneId).toBe('M02');
  expect(Object.isFrozen(report.snapshot.screen)).toBe(true);
  expect(report.snapshot.game.day).toBeNull();
});
test('blank description cannot begin a send', () => {
  expect(model.begin(draft())).toMatchObject({ phase: 'editing', payload: null });
  expect(model.begin(draft()).error).not.toBe('');
});
test('typing edits only the draft, never the captured game', () => {
  const original = draft();
  const edited = model.edit(original, 'rules', '細節');
  expect(original.description).toBe('');
  expect(edited.description).toBe('細節');
  expect(edited.snapshot).toBe(original.snapshot);
});
test('double begin keeps the same in-flight request and payload', () => {
  const sending = model.begin(model.edit(draft(), 'operation', '細節'));
  expect(model.begin(sending)).toBe(sending);
  expect(model.edit(sending, 'other', 'changed')).toBe(sending);
});
test('offline failure retains input, original snapshot and exact retry payload', () => {
  const sending = model.begin(model.edit(draft(), 'art', '這張圖的細節'));
  const failed = model.fail(sending);
  expect(failed).toMatchObject({ id: ID, description: '這張圖的細節', phase: 'failed' });
  const retry = model.begin(failed);
  expect(retry.id).toBe(ID);
  expect(retry.payload).toBe(sending.payload);
  expect(retry.snapshot).toBe(sending.snapshot);
});
test('a success flag without a matching server-saved ID is not success', () => {
  const sending = model.begin(model.edit(draft(), 'other', '細節'));
  expect(model.saved(sending, { success: true, id: null }).phase).toBe('failed');
  expect(model.saved(sending, { saved: true, id: 'different' }).phase).toBe('failed');
  expect(model.saved(sending, { success: true, saved: true, id: ID }).phase).toBe('saved');
});

test('T02 review snapshots identify the visible review step, not completed play step 7', () => {
  expect(model.t02StepId({ mode: 'review', step: 7, reviewIndex: 3 })).toBe('T02-S04');
  expect(model.t02StepId({ mode: 'play', step: 0, reviewIndex: 6 })).toBe('T02-S01');
});

describe('visible proposal and independent prototype sources', () => {
  const regions = Object.freeze([Object.freeze({ id: 'newGameplayDemo', visible: true, area: 400 }), Object.freeze({ id: 'interactivePrototype', visible: true, area: 100 })]);
  test('visible active prototype B wins over proposal A without modifying either', () => {
    expect(model.selectRegion(regions, 'interactivePrototype', 'newGameplayDemo').id).toBe('interactivePrototype');
    expect(regions[0].area).toBe(400);
  });
  test('switching back to the visible proposal chooses its source', () => {
    expect(model.selectRegion(regions, 'newGameplayDemo', 'interactivePrototype').id).toBe('newGameplayDemo');
  });
  test('off-screen previous activity cannot override the visible source', () => {
    expect(model.selectRegion([{ id: 'A', visible: true, area: 20 }, { id: 'B', visible: false, area: 100 }], 'B', 'A').id).toBe('A');
  });
  test('uninitialized views do not borrow a hidden model', () => {
    expect(model.selectRegion([{ id: 'B', visible: false, area: 100 }], 'B', 'B')).toBeNull();
  });
});
