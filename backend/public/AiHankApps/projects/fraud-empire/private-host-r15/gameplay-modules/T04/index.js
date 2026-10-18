((root, factory) => {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./model'), require('./text'));
  else root.FraudT04 = factory(root.FraudT04Model, root.FraudT04Text);
})(globalThis, (model, text) => {
  'use strict';
  function mount(container, options = {}) {
    if (!container || !container.ownerDocument) throw new TypeError('DOM container required');
    const doc = container.ownerDocument;
    let seed = options.session || globalThis.crypto.randomUUID();
    let generation = 0, mountEpoch = 0, state = model.create(seed), host = null, panel = null, message = 'goal', resetPending = false;
    if (Object.prototype.hasOwnProperty.call(options, 'privateCheckpoint')) {
      const restored = globalThis.FraudPrivateModuleSave.checkpointState('T04', options.privateCheckpoint, state);
      state = restored.state;
      seed = restored.controller.seed;
      generation = restored.controller.generation;
    }
    const t = key => options.t?.(key) ?? text[key] ?? key;
    const copy = value => JSON.parse(JSON.stringify(value));
    const snapshot = () => copy(state);
    function node(tag, key) {
      const element = doc.createElement(tag);
      if (key) { element.textContent = t(key); element.dataset.i18n = 'T04.' + key; }
      return element;
    }
    function command(type, payload = {}, origin = state) {
      if (!panel) return { accepted: false, message: 'unmounted' };
      const outcome = model.apply(state, { ...payload, type, session: origin.session, revision: origin.revision, id: origin.session + ':' + origin.revision });
      state = outcome.state; message = outcome.message; render();
      // Each public consumer receives its own deep copy, including rejection paths.
      const publicOutcome = copy(outcome);
      options.onState?.(snapshot());
      if (outcome.result) options.onResult?.(copy(outcome.result));
      return publicOutcome;
    }
    function button(parent, key, type, payload = {}, pressed) {
      const element = node('button', key), origin = state, epoch = mountEpoch;
      element.type = 'button'; element.dataset.action = type;
      element.dataset.focusKey = key + ':' + JSON.stringify(payload);
      if (pressed !== undefined) element.setAttribute('aria-pressed', String(pressed));
      element.addEventListener('click', () => { if (epoch === mountEpoch) command(type, payload, origin); });
      parent.append(element); return element;
    }
    function localButton(parent, key, action) {
      const element = node('button', key), epoch = mountEpoch; element.type = 'button'; element.dataset.focusKey = key;
      element.addEventListener('click', () => { if (epoch === mountEpoch && panel) action(); }); parent.append(element);
    }
    function render() {
      if (!panel) return;
      const focus = panel.contains(doc.activeElement) ? doc.activeElement.dataset.focusKey : null;
      panel.replaceChildren(node('h2', 'title'), node('p', 'notice'), node('p', 'boundary'), node('p', 'artNotice'));
      const nav = node('nav'); panel.append(nav);
      button(nav, 'intro', 'navigate', { view: 'intro' });
      if (state.started) { button(nav, 'work', 'navigate', { view: 'work' }); button(nav, 'summary', 'navigate', { view: 'summary' }); }
      localButton(nav, 'exit', () => { unmount(); options.onExit?.(snapshot()); });
      localButton(nav, 'reset', () => { resetPending = true; render(); });
      if (resetPending) {
        const confirmation = node('section'); confirmation.append(node('p', 'resetNotice'));
        localButton(confirmation, 'confirmReset', () => { state = model.create(seed + ':reset-' + (++generation)); resetPending = false; message = 'goal'; render(); options.onState?.(snapshot()); });
        localButton(confirmation, 'cancelReset', () => { resetPending = false; render(); }); panel.append(confirmation);
      }
      if (state.view === 'intro') {
        panel.append(node('p', 'goal'));
        if (!state.started) button(panel, 'start', 'start');
      } else if (state.view === 'work') {
        panel.append(node('h3', 'timeline'));
        const controls = node('div'); controls.className = 't04-controls'; panel.append(controls);
        button(controls, 'seekBefore', 'seek', { time: 'before' }, state.playhead === 'before');
        button(controls, 'seekLater', 'seek', { time: 'later' }, state.playhead === 'later');
        for (const track of ['buyer', 'service', 'record']) {
          const row = node('section'); row.dataset.track = track; row.append(node('h3', track));
          button(row, 'read', 'read', { track });
          if (state.viewed.includes(track)) row.append(node('p', 'read_' + track));
          button(row, 'select', 'select', { track }, state.selected === track);
          row.append(node('p', state.positions[track] || 'unplaced'));
          button(row, 'remove', 'remove', { track });
          if (track !== 'record') button(row, 'mark', 'mark', { track }, state.marked.includes(track));
          panel.append(row);
        }
        if (state.selected) { const p = node('p', 'selectedLabel'); p.append(node('strong', state.selected)); panel.append(p); }
        const slots = node('div'); slots.className = 't04-controls'; panel.append(slots);
        button(slots, 'before', 'place', { time: 'before' }); button(slots, 'later', 'place', { time: 'later' });
        button(slots, 'cancel', 'cancel');
        button(panel, 'seller', 'locate', { owner: 'seller' }, state.location === 'seller');
        button(panel, 'buyerOwner', 'locate', { owner: 'buyer' });
        const gaps = model.missing(state); panel.append(node('p', gaps.length ? 'pending' : 'ready'));
        const list = node('ul'); for (const gap of gaps) list.append(node('li', 'gap_' + gap)); panel.append(list);
        if (!state.handedOff) {
          button(panel, 'stop', 'choose', { branch: 'stop' }, state.pendingBranch === 'stop');
          button(panel, 'dispute', 'choose', { branch: 'dispute' }, state.pendingBranch === 'dispute');
          if (state.pendingBranch) panel.append(node('p', 'branch_' + state.pendingBranch));
          button(panel, 'handoff', 'handoff');
        }
      } else {
        if (state.branch) {
          panel.append(node('p', 'branch_' + state.branch));
          button(panel, 'readFollowup', 'read_followup');
          if (state.followupRead) panel.append(node('p', 'followup_' + state.branch));
          button(panel, 'archive', 'archive');
          button(panel, 'previewStop', 'preview_followup', { branch: 'stop' });
          button(panel, 'previewDispute', 'preview_followup', { branch: 'dispute' });
        } else panel.append(node('p', 'incomplete'));
        if (state.archived) panel.append(node('p', 'result'));
      }
      const feedback = node('p', message); feedback.setAttribute('role', 'status'); feedback.setAttribute('aria-live', 'polite'); panel.append(feedback);
      if (focus) [...panel.querySelectorAll('button')].find(b => b.dataset.focusKey === focus)?.focus({ preventScroll: true });
    }
    function unmount() { mountEpoch += 1; if (panel) panel.remove(); panel = null; host = null; resetPending = false; return snapshot(); }
    function remount(target) {
      if (!target || target.ownerDocument !== doc) throw new TypeError('same document container required');
      if (panel && target === host) return api;
      unmount(); host = target; panel = node('section'); panel.className = 'fraud-t04'; host.append(panel); render(); return api;
    }
    const api = { mount: remount, unmount, getState: snapshot, dispatch: (type, payload) => command(type, payload),
      getPrivateCheckpoint: () => globalThis.FraudPrivateModuleSave.makeCheckpoint('T04', snapshot(), { seed, generation }) };
    return remount(container);
  }
  return { mount };
});
