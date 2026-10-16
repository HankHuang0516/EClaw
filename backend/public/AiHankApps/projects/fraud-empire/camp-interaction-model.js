/* global window */
(function (root) {
  'use strict';
  const clone = value => JSON.parse(JSON.stringify(value));
  function validate(data) {
    if (!data || data.schemaVersion !== 1 || !Array.isArray(data.scenes) || data.scenes.length !== 10) return false;
    return data.scenes.every(scene => {
      const nodes = new Set(scene.nodes.map(node => node.id));
      return nodes.size === scene.nodes.length && scene.adjacency.every(edge => edge.length === 2 && edge.every(id => nodes.has(id))) && scene.hotspots.every(h => nodes.has(h.node_id));
    });
  }
  function create(ownerTimeline = null, ready = false) {
    return { ownerTimeline, ready, sceneId: 'M01', nodeId: null, lastPath: [], visited: [], selectedHotspot: null, inspected: [], items: [], notes: [], formalSceneEntryGranted: false, appliedMinutes: 0, rewardsGranted: 0 };
  }
  function syncOwner(state, owner) {
    if (!owner || !Number.isInteger(owner.timeline) || owner.timeline < 1) return state;
    const ready = owner.complete === true && owner.records.length === 7 && new Set(owner.records).size === 7;
    if (state.ownerTimeline !== owner.timeline) return create(owner.timeline, ready);
    if (!ready && state.ready) return create(owner.timeline, false);
    if (ready !== state.ready) return { ...state, ready };
    return state;
  }
  function pathBetween(scene, from, to) {
    const ids = new Set(scene.nodes.map(node => node.id));
    if (!ids.has(from) || !ids.has(to)) return null;
    const queue = [[from]];
    const seen = new Set([from]);
    while (queue.length) {
      const route = queue.shift();
      const end = route[route.length - 1];
      if (end === to) return route;
      for (const edge of scene.adjacency) {
        const next = edge[0] === end ? edge[1] : edge[1] === end ? edge[0] : null;
        if (next && !seen.has(next)) { seen.add(next); queue.push([...route, next]); }
      }
    }
    return null;
  }
  function transition(state, action, data) {
    const hold = message => ({ state, changed: false, message });
    if (!validate(data)) return hold('場景資料無法使用。');
    if (!state.ready) return hold('先完成 T02 的安置。');
    if (action.type === 'preview-scene') {
      if (!data.scenes.some(s => s.scene_id === action.value)) return hold('沒有這個場景。');
      return { state: { ...clone(state), sceneId: action.value, nodeId: null, lastPath: [], selectedHotspot: null }, changed: true, message: '已切換預覽，尚未授予正式入場條件。' };
    }
    const scene = data.scenes.find(s => s.scene_id === state.sceneId);
    if (!scene || action.scene !== state.sceneId) return hold('場景已變，這次操作未提交。');
    if (scene.routeHold) return hold('宿舍布局待確認，這裡先不試走。');
    const next = clone(state);
    const done = message => ({ state: next, changed: true, message });
    if (action.type === 'move') {
      if (!scene.nodes.some(node => node.id === action.value)) return hold('這裡無法通行。');
      const path = state.nodeId === null ? [action.value] : pathBetween(scene, state.nodeId, action.value);
      if (!path) return hold('來源沒有這條連線。');
      next.nodeId = action.value; next.lastPath = path; next.selectedHotspot = null;
      next.visited = [...new Set([...next.visited, ...path])];
      return done(state.nodeId === null ? '試走起點已設好。' : '到了。');
    }
    if (action.type === 'approach') {
      const hotspot = scene.hotspots.find(h => h.id === action.value);
      if (!hotspot) return hold('沒有這個熱點。');
      if (state.nodeId === null) return hold('先選一個試走起點。');
      const path = pathBetween(scene, state.nodeId, hotspot.node_id);
      if (!path) return hold('走不到這個站位。');
      next.nodeId = hotspot.node_id; next.lastPath = path; next.selectedHotspot = null;
      next.visited = [...new Set([...next.visited, ...path])];
      return done('已走近，可以查看熱點。');
    }
    if (action.type === 'inspect') {
      const hotspot = scene.hotspots.find(h => h.id === action.value);
      if (!hotspot) return hold('沒有這個熱點。');
      if (state.nodeId !== hotspot.node_id) return hold('要先走近。');
      next.selectedHotspot = hotspot.id;
      if (!next.inspected.includes(hotspot.id)) next.inspected.push(hotspot.id);
      return done('已查看，沒有領取物品或提交劇情。');
    }
    if (action.type === 'close') { next.selectedHotspot = null; return done('已收起，站位不變。'); }
    if (action.type === 'claim') return hold('還沒有完整事件的提交結果，不能領取。');
    return hold('這次操作沒有改變狀態。');
  }
  const api = { validate, create, syncOwner, pathBetween, transition, snapshot: clone };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.FraudCampInteractionModel = Object.freeze(api);
})(typeof window !== 'undefined' ? window : null);
