/* global describe, test, expect */
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '../../public/AiHankApps/projects/fraud-empire');
const api = require(path.join(root, 'camp-interaction-model.js'));
const data = JSON.parse(fs.readFileSync(path.join(root, 'camp-interaction-data.json'), 'utf8'));
const owner = { timeline: 1, complete: true, records: Array.from({ length: 7 }, (_, i) => 'T02-S0' + (i + 1)) };
const ready = () => api.syncOwner(api.create(), owner);
const act = (s, type, value) => api.transition(s, { type, value, scene: s.sceneId }, data).state;
describe('Camp source-route rehearsal — partial B02, no acquisition claim', () => {
  test('retains ten source scenes, one held dorm and 38 hotspots without new edges', () => {
    expect(api.validate(data)).toBe(true);
    expect(data.scenes.filter(s => !s.routeHold)).toHaveLength(9);
    expect(data.scenes.reduce((n, s) => n + s.hotspots.length, 0)).toBe(38);
    expect(data.scenes.find(s => s.scene_id === 'M03').routeHold).toBe(true);
  });
  test('all non-dorm routes use only explicitly declared adjacency', () => {
    for (const scene of data.scenes.filter(s => !s.routeHold)) for (const target of scene.nodes) {
      const route = api.pathBetween(scene, scene.nodes[0].id, target.id);
      expect(route[0]).toBe(scene.nodes[0].id);
      expect(route[route.length - 1]).toBe(target.id);
      for (let i = 1; i < route.length; i++) expect(scene.adjacency.some(e => e.includes(route[i - 1]) && e.includes(route[i]))).toBe(true);
    }
  });
  test('does not start before complete T02 or grant formal scene entry', () => {
    const s = api.create();
    expect(act(s, 'move', 'M01-N01')).toEqual(s);
    expect(api.syncOwner(s, { ...owner, records: owner.records.slice(0, 6) }).ready).toBe(false);
    expect(ready().ready).toBe(true); expect(ready().formalSceneEntryGranted).toBe(false);
  });
  test('explicit starting node and path movement do not imply new spawn, time or rewards', () => {
    let s = act(ready(), 'preview-scene', 'M02');
    expect(s.nodeId).toBe(null); s = act(s, 'move', 'M02-N01');
    expect(s.lastPath).toEqual(['M02-N01']);
    s = act(s, 'move', 'M02-N04');
    expect(s.lastPath).toEqual(['M02-N01', 'M02-N06', 'M02-N02', 'M02-N04']);
    expect(s.appliedMinutes).toBe(0); expect(s.rewardsGranted).toBe(0);
  });
  test('unknown or unreachable nodes and stale scene actions cannot move the actor', () => {
    const s = act(ready(), 'move', 'M01-N01');
    expect(act(s, 'move', 'not-a-node')).toEqual(s);
    expect(api.transition(s, { type: 'move', value: 'M02-N01', scene: 'M02' }, data).state).toEqual(s);
    const isolated = { nodes: [{ id: 'a' }, { id: 'b' }], adjacency: [] };
    expect(api.pathBetween(isolated, 'a', 'b')).toBe(null);
  });
  test('hotspot needs approach and closing leaves position unchanged', () => {
    let s = act(ready(), 'preview-scene', 'M02');
    expect(act(s, 'inspect', 'M02-H02')).toEqual(s);
    s = act(s, 'move', 'M02-N01'); s = act(s, 'approach', 'M02-H02');
    expect(s.nodeId).toBe('M02-N04'); s = act(s, 'inspect', 'M02-H02');
    expect(s.selectedHotspot).toBe('M02-H02');
    const closed = act(s, 'close'); expect(closed.nodeId).toBe(s.nodeId); expect(closed.selectedHotspot).toBe(null);
  });
  test('inspection never grants items, notes, affinity or repeat rewards', () => {
    let s = act(ready(), 'preview-scene', 'M02');
    s = act(s, 'move', 'M02-N04'); s = act(s, 'inspect', 'M02-H02');
    s = act(s, 'inspect', 'M02-H02');
    expect(s.inspected).toEqual(['M02-H02']);
    expect(s.items).toEqual([]); expect(s.notes).toEqual([]); expect(s.rewardsGranted).toBe(0);
    expect(act(s, 'claim', 'IT01')).toEqual(s);
  });
  test('held dorm cannot acquire geometry or movement through the state layer', () => {
    const s = act(ready(), 'preview-scene', 'M03');
    expect(act(s, 'move', 'M03-N01')).toEqual(s);
    expect(act(s, 'approach', 'M03-H01')).toEqual(s);
    expect(data.scenes.find(x => x.scene_id === 'M03').nodes.every(n => n.x === undefined && n.y === undefined)).toBe(true);
  });
  test('preview switch clears local position but cannot unlock M09 or create ending receipts', () => {
    let s = act(ready(), 'move', 'M01-N01'); s = act(s, 'preview-scene', 'M09');
    expect(s.nodeId).toBe(null); expect(s.formalSceneEntryGranted).toBe(false);
    expect(act(s, 'claim', 'IT10')).toEqual(s); expect(s.items).toEqual([]);
  });
  test('new owner timeline drops future positions/inspection and snapshot cannot mutate source', () => {
    let s = act(ready(), 'move', 'M01-N01'); s = act(s, 'approach', 'M01-H01'); s = act(s, 'inspect', 'M01-H01');
    const reset = api.syncOwner(s, { timeline: 2, complete: false, records: [] });
    expect(reset.ready).toBe(false); expect(reset.nodeId).toBe(null); expect(reset.inspected).toEqual([]);
    const snapshot = api.snapshot(s); snapshot.inspected.push('fake'); expect(s.inspected).not.toContain('fake');
  });
  test('source differences preserve newer IT05 and ending-only IT10, not blanket pickup', () => {
    const items = data.scenes.flatMap(s => s.hotspots.flatMap(h => h.acquisition));
    expect(items.find(i => i.registry_id === 'IT05').latestUse).toContain('跳過ESC-S06');
    expect(items.find(i => i.registry_id === 'IT10').sourceDifference).toContain('終局');
  });
  test('adds no formal save, account, media, tracking, score or hidden identity UI default', () => {
    const script = fs.readFileSync(path.join(root, 'camp-interaction.js'), 'utf8');
    expect(script).not.toMatch(/localStorage|sessionStorage|indexedDB|sendBeacon|method\s*:\s*['"]POST|<iframe|eval\(/);
    expect(script).toContain('acquisitionImplemented: false'); expect(script).toContain('fullDesign() ? hotspot.label');
    expect(script).toContain('aria-label="場景預覽快捷選擇"');
    expect(script).toContain("button('preview-scene'");
  });
});
