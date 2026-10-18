(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FraudDemoFeedbackModel = factory();
})(typeof window === 'undefined' ? globalThis : window, function () {
  'use strict';
  const categories = Object.freeze(['operation', 'rules', 'dialogue', 'art', 'balance', 'other']);
  const clone = value => JSON.parse(JSON.stringify(value));
  function freeze(value) {
    if (value && typeof value === 'object') {
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    }
    return value;
  }
  function create(snapshot, id) {
    return { id, snapshot: freeze(clone(snapshot)), category: 'operation', description: '',
      phase: 'editing', payload: null, receipt: null, error: '' };
  }
  function edit(draft, category, description) {
    if (draft.payload || draft.phase === 'sending' || draft.phase === 'saved') return draft;
    return { ...draft, category, description, error: '' };
  }
  function begin(draft) {
    if (draft.phase === 'sending' || draft.phase === 'saved') return draft;
    if (!categories.includes(draft.category) || !draft.description.trim() || draft.description.length > 2000) {
      return { ...draft, error: '請選擇問題類別，並填寫 1 至 2000 字的細節描述。' };
    }
    const payload = draft.payload || freeze({ id: draft.id, category: draft.category,
      description: draft.description.trim(), snapshot: draft.snapshot });
    return { ...draft, phase: 'sending', payload, error: '' };
  }
  function fail(draft) {
    return { ...draft, phase: 'failed', error: '尚未確認保存成功。輸入與原快照已保留，請重試。' };
  }
  function saved(draft, response) {
    if (!response || response.saved !== true || response.id !== draft.id) return fail(draft);
    return { ...draft, phase: 'saved', receipt: clone(response), error: '' };
  }
  function t02StepId(state) {
    const ids = ['T02-S01', 'T02-S02', 'T02-S03', 'T02-S04', 'T02-S05', 'T02-S06', 'T02-S07'];
    return ids[state.mode === 'review' ? state.reviewIndex : state.step] || null;
  }
  function selectRegion(regions, activeId, centerId) {
    const shown = regions.filter(region => region.visible);
    return shown.find(region => region.id === activeId) || shown.find(region => region.id === centerId)
      || [...shown].sort((a, b) => b.area - a.area)[0] || null;
  }
  return { categories, create, edit, begin, fail, saved, clone, t02StepId, selectRegion };
});
