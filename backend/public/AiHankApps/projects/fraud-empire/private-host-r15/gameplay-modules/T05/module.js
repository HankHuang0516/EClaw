/* global FraudT05Model, FraudT05Strings */
(function (root) {
  'use strict';
  let sequence = 0;
  const scriptBase = new URL('.', document.currentScript.src);
  const owners = new WeakMap();
  function create(options = {}) {
    const model = FraudT05Model;
    const text = options.strings || FraudT05Strings;
    let state = model.create('T05-' + (++sequence));
    let host = null, section = null, resetPending = false, message = '', generation = 0;
    if (Object.prototype.hasOwnProperty.call(options, 'privateCheckpoint')) {
      const restored = globalThis.FraudPrivateModuleSave.checkpointState('T05', options.privateCheckpoint, state);
      state = restored.state;
    }
    const node = (tag, content, key) => {
      const element = document.createElement(tag);
      if (content !== undefined) element.textContent = content;
      if (key) element.dataset.i18n = 't05.' + key;
      return element;
    };
    function dispatch(command) {
      if (!host) return { state: model.snapshot(state), accepted: false, code: 'unmounted', result: null };
      const outcome = model.apply(state, command);
      state = outcome.state; message = text.messages[outcome.code];
      if (outcome.code === 'proofRequired') {
        const missing = ['bell', 'moon', 'backstage'].filter(view => !state.visited.includes(view)).map(view => '尚未查看' + text[view]);
        if (!state.capture) missing.push('尚未定格共同影子；到月門調整至共同中央亮起，再回後台定格');
        else { const shadows = ['bell', 'moon'].filter(view => !state.placed.includes(view)).map(view => view === 'bell' ? '鐘門影子' : '月門影子'); if (shadows.length) missing.push('側台玻璃尚缺' + shadows.join('、') + '；選取後放到側台玻璃'); }
        if (missing.length) message = '尚不能結案：' + missing.join('；') + '。沒有扣機會或時間。';
      }
      render();
      if (outcome.result && typeof options.onResult === 'function') options.onResult(model.snapshot(outcome.result));
      return { ...outcome, state: model.snapshot(state) };
    }
    function button(label, action, disabled = false, key = label) {
      const button = node('button', text[label], label);
      button.type = 'button'; button.disabled = disabled; button.dataset.action = key;
      // Capture the rendered revision: a detached/double-dispatched old button cannot advance a new state.
      const revision = state.revision, ownerGeneration = generation;
      button.addEventListener('click', () => {
        if (!host || ownerGeneration !== generation || revision !== state.revision) return;
        if (typeof action === 'function') action();
        else dispatch({ ...action, session: state.session, revision });
      });
      return button;
    }
    function render() {
      if (!host) return;
      const activeAction = section?.contains(document.activeElement) ? document.activeElement.dataset.action : null;
      const next = node('section'); next.className = 'fraud-t05';
      next.append(node('h1', text.title, 'title'), node('p', text.notice, 'notice'), node('p', text.clock, 'clock'));
      const nav = node('nav'); nav.setAttribute('aria-label', text.title);
      ['intro', 'bell', 'moon', 'backstage', 'menu'].forEach(view => {
        const b = button(view, { type: 'view', value: view }); b.setAttribute('aria-pressed', String(state.view === view)); nav.append(b);
      }); next.append(nav);
      next.append(node('p', text.visited + state.visited.map(v => text[v]).join('、')), node('p', text.goal, 'goal'));
      if (state.view === 'intro') next.append(node('p', text.boundary, 'boundary'));
      if (['bell', 'moon', 'backstage'].includes(state.view)) next.append(node('p', text[state.view + 'Story'], state.view + 'Story'));
      next.append(node('p', text.missing, 'missing'));
      if (state.view === 'moon' || state.view === 'backstage') {
        const frame = node('p', text.frames[state.frame]); frame.dataset.testid = 'frame'; next.append(frame);
        next.append(node('p', text.attempts + state.attempts));
      }
      if (state.view === 'moon') {
        next.append(button('previous', { type: 'frame', value: -1 }, Boolean(state.result || state.capture || !state.attempts)), button('next', { type: 'frame', value: 1 }, Boolean(state.result || state.capture || !state.attempts)));
      }
      if (state.view === 'backstage') {
        next.append(button('capture', { type: 'capture' }, Boolean(state.result || state.capture || !state.attempts)));
        if (state.capture) {
          next.append(node('p', text.selected + (state.selectedShadow ? text[state.selectedShadow] : text.none)));
          next.append(button('shadowBell', { type: 'select', value: 'bell' }, Boolean(state.result || state.placed.includes('bell'))), button('shadowMoon', { type: 'select', value: 'moon' }, Boolean(state.result || state.placed.includes('moon'))));
          next.append(button('glass', { type: 'place', value: 'glass' }, Boolean(state.result)), button('wrong', { type: 'place', value: 'rack' }, Boolean(state.result)));
          next.append(node('p', text.placed + state.placed.map(v => text[v]).join('、')));
        }
        next.append(button('handoff', { type: 'ending', value: 'handoff' }, Boolean(state.result)), button('pause', { type: 'ending', value: 'pause' }, Boolean(state.result)));
      }
      if (state.result) {
        const result = node('div'); result.dataset.testid = 'result';
        result.append(node('h2', text[state.result.commonShadow ? 'success' : 'failure']), node('p', text[state.choice === 'pause' ? 'pauseConsequence' : 'handoffConsequence']), node('p', text.resultBoundary, 'resultBoundary')); next.append(result);
      }
      if (state.view === 'intro') {
        const details = node('details'); details.append(node('summary', text.reference, 'reference'));
        const img = node('img'); img.src = new URL('../../images/cb74ae1eca756dcfc2a2.webp', options.moduleBase || scriptBase).href;
        img.alt = text.referenceAlt; img.loading = 'lazy'; details.append(node('p', text.referenceNote, 'referenceNote'), img); next.append(details);
      }
      if (state.view === 'menu') {
        if (resetPending) next.append(node('p', text.resetNotice, 'resetNotice'), button('confirmReset', () => { resetPending = false; dispatch({ type: 'reset', session: state.session, revision: state.revision }); }), button('cancel', () => { resetPending = false; render(); }));
        else next.append(button('reset', () => { resetPending = true; render(); }));
        next.append(button('exit', () => { unmount(); if (typeof options.onExit === 'function') options.onExit(); }));
      }
      const status = node('p', message); status.setAttribute('role', 'status'); status.dataset.testid = 'feedback'; next.append(status);
      if (section) section.replaceWith(next); else host.append(next);
      section = next;
      if (activeAction) Array.from(section.querySelectorAll('button')).find(b => b.dataset.action === activeAction)?.focus();
    }
    function unmount() {
      generation += 1;
      if (host) owners.delete(host);
      section?.remove(); section = null; host = null; resetPending = false;
    }
    function mount(target) {
      if (!target || target.nodeType !== 1) throw new Error('mount requires an element');
      if (owners.has(target) && owners.get(target) !== api) throw new Error('target already mounted');
      unmount(); host = target; owners.set(host, api); render(); return api;
    }
    const api = Object.freeze({ mount, unmount, dispatch, getState: () => model.snapshot(state),
      getPrivateCheckpoint: () => globalThis.FraudPrivateModuleSave.makeCheckpoint('T05', model.snapshot(state), {}) });
    return api;
  }
  root.FraudT05 = Object.freeze({ create });
})(globalThis);
