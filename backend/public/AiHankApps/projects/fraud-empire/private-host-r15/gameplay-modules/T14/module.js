(function (root) {
  'use strict';
  const occupiedRoots = new WeakMap(), ownedSurfaces = new WeakSet();
  function create(options = {}) {
    const model = root.FraudT14Model, words = { ...root.FraudT14Strings, ...options.strings };
    const t = key => words[key] || key;
    let generation = 0, state = model.create((options.session || 't14-' + root.crypto.randomUUID()) + ':0');
    let host = null, surface = null, last = null, selected = 'record', reading = '', readingKind = '', notice = '', confirming = false;
    if (Object.prototype.hasOwnProperty.call(options, 'privateCheckpoint')) {
      const restored = globalThis.FraudPrivateModuleSave.checkpointState('T14', options.privateCheckpoint, state);
      state = restored.state;
      generation = restored.controller.generation;
      selected = restored.controller.selected;
      readingKind = restored.controller.readingKind;
      const key = { relationship: 'relationshipText', project: 'projectText', playing: 'playing' }[readingKind];
      reading = key ? t(key) : '';
    }
    const now = options.now || (() => root.performance.now());
    const snapshot = () => model.copy(state);
    function sample(wasVisible = false) {
      const current = now();
      if (last !== null && state.view === 'desk' && !state.result && (wasVisible || !host.ownerDocument.hidden)) {
        const ms = Math.floor(current - last);
        if (ms > 0) state = model.apply(state, { type: 'tick', ms, session: state.session, revision: state.revision }).state;
      }
      last = current;
    }
    function dispatch(type, payload = {}) {
      if (!host || type === 'tick') return { accepted: false, code: 'unmounted', state: snapshot() };
      sample();
      const oldResult = state.result;
      const outcome = model.apply(state, { ...payload, type, session: state.session, revision: state.revision });
      state = outcome.state; notice = t(outcome.accepted ? 'accepted' : outcome.code);
      if (outcome.accepted && type === 'inspect') { readingKind = payload.folder; reading = t(readingKind + 'Text'); }
      if (outcome.accepted && type === 'play') { readingKind = 'playing'; reading = t('playing'); }
      render();
      if (options.onState) options.onState(snapshot());
      if (!oldResult && state.result && options.onResult) options.onResult(model.copy(state.result));
      return { ...outcome, state: snapshot() };
    }
    function node(tag, text) {
      const el = host.ownerDocument.createElement(tag);
      if (text !== undefined) el.textContent = text;
      return el;
    }
    function button(parent, key, fn, id = key) {
      const el = node('button', t(key)); el.type = 'button'; el.dataset.action = id;
      const epoch = generation, revision = state.revision;
      el.onclick = () => { if (host && generation === epoch && state.revision === revision) fn(); };
      parent.append(el); return el;
    }
    function render() {
      if (!surface) return;
      const focus = surface.activeElement?.dataset.action;
      surface.replaceChildren();
      const style = node('style');
      style.textContent = ':host{display:block;color:inherit;font:inherit}*{box-sizing:border-box}main{max-width:48rem;margin:auto;padding:1rem}h1{font-size:1.5rem}p{line-height:1.65}section{margin:1rem 0;padding:.8rem;border:1px solid currentColor;border-radius:.6rem}button{font:inherit;min-height:48px;padding:.65rem;margin:.25rem;max-width:100%;cursor:pointer;color:inherit;background:transparent;border:1px solid currentColor;border-radius:.4rem}button:focus-visible{outline:3px solid #b57616;outline-offset:2px}button[aria-pressed=true]{outline:3px solid #b57616}output{display:block;min-height:3rem;line-height:1.6}small{display:block;line-height:1.6}.actions{display:flex;flex-wrap:wrap}';
      surface.append(style);
      const main = node('main'); surface.append(main);
      main.append(node('h1', t('title')), node('p', t('boundary')), node('small', t('art')));
      main.append(node('p', t('clock') + '：' + (state.elapsedMs / 60000).toFixed(2) + (state.view !== 'desk' ? ' · ' + t('pausedLabel') : '')));
      if (state.result) main.append(node('p', t('done')));
      if (state.view === 'intro') {
        main.append(node('p', t('eligibility')), node('p', t('goal')));
        button(main, 'start', () => dispatch('view', { view: 'desk' }));
      } else if (state.view === 'reading') {
        main.append(node('p', reading)); button(main, 'back', () => dispatch('view', { view: 'desk' }));
      } else if (state.view === 'menu') {
        if (confirming) {
          main.append(node('p', t('resetQuestion')));
          button(main, 'confirm', reset);
          button(main, 'cancel', () => { confirming = false; render(); });
        } else {
          button(main, 'back', () => dispatch('view', { view: 'desk' }));
          button(main, 'reset', () => { confirming = true; render(); });
        }
      } else {
        main.append(node('p', t('goal')));
        const objects = node('section'); objects.setAttribute('aria-label', t('selected')); main.append(objects);
        objects.append(node('p', t('selected') + '：' + t(selected)));
        for (const prop of ['record', 'modelPage']) {
          const el = button(objects, prop, () => { selected = prop; render(); });
          el.setAttribute('aria-pressed', String(selected === prop));
        }
        for (const f of model.folders) {
          const section = node('section'); main.append(section);
          section.append(node('h2', t(f)), node('p', t('status') + '：' + t(state.folders[f])));
          button(section, 'inspect', () => dispatch('inspect', { folder: f }), 'inspect-' + f);
          button(section, 'load', () => dispatch('load', { folder: f, prop: selected }), 'load-' + f);
          button(section, 'deliver', () => dispatch('deliver', { folder: f }), 'deliver-' + f);
          button(section, state.folders[f] === 'deferred' ? 'recall' : 'defer', () => dispatch(state.folders[f] === 'deferred' ? 'recall' : 'defer', { folder: f }), 'defer-' + f);
        }
        const slot = node('section'); main.append(slot);
        slot.append(node('p', t('book') + '：' + t(state.book)), node('p', t('slot') + '：' + t(state.slot || 'emptySlot')));
        for (const action of ['play', 'receive', 'shelve', 'handoff']) button(slot, action, () => dispatch(action));
        button(main, 'menu', () => dispatch('view', { view: 'menu' }));
      }
      const feedback = node('output', notice); feedback.setAttribute('aria-live', 'polite'); main.append(feedback);
      if (focus) Array.from(surface.querySelectorAll('button')).find(el => el.dataset.action === focus)?.focus({ preventScroll: true });
    }
    function reset() {
      generation += 1; state = model.create(state.session.replace(/:\d+$/, '') + ':' + generation);
      last = now(); selected = 'record'; reading = ''; readingKind = ''; notice = ''; confirming = false; render();
      if (options.onState) options.onState(snapshot());
    }
    function visibility() { if (host.ownerDocument.hidden) sample(true); last = now(); }
    function mount(target) {
      if (!target || typeof target.attachShadow !== 'function') throw new TypeError('mount target');
      if (host === target) return api;
      if (occupiedRoots.has(target)) throw new Error('T14 target already mounted');
      if (target.shadowRoot && !ownedSurfaces.has(target.shadowRoot)) throw new Error('T14 requires an empty dedicated host');
      if (host) unmount();
      host = target; surface = target.shadowRoot || target.attachShadow({ mode: 'open' });
      ownedSurfaces.add(surface); occupiedRoots.set(target, api); last = now();
      host.ownerDocument.addEventListener('visibilitychange', visibility); render(); return api;
    }
    function unmount() {
      if (!host) return snapshot();
      sample(); state = model.apply(state, { type: 'view', view: 'menu', session: state.session, revision: state.revision }).state;
      host.ownerDocument.removeEventListener('visibilitychange', visibility);
      occupiedRoots.delete(host); surface.replaceChildren(); host = null; surface = null; last = null;
      return snapshot();
    }
    const api = { mount, unmount, getState: snapshot, dispatch,
      getPrivateCheckpoint() {
        if (host) {
          const revision = state.revision;
          sample();
          if (state.revision !== revision) { render(); options.onState?.(snapshot()); }
        }
        return globalThis.FraudPrivateModuleSave.makeCheckpoint('T14', snapshot(), { generation, selected, readingKind });
      } };
    return api;
  }
  root.FraudT14 = { create, mount: (target, options) => create(options).mount(target) };
})(globalThis);
