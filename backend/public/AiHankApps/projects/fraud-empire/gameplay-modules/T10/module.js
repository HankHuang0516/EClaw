((root) => {
  'use strict';
  const M = root.FraudT10Model, i18n = root.FraudT10I18n;
  // This provider owns the module-local source dictionary, not the portal dictionary.
  const moduleText = i18n.t.bind(i18n);
  const labels = { radio: moduleText('t001'), rail: moduleText('t002'), night: moduleText('t003'), roof: moduleText('t004'), island: moduleText('t005'), other: moduleText('t006') };
  function create(options = {}) {
    let state = M.create(), host = null, message = '', delivered = false, last = null, timer = null;
    if (Object.prototype.hasOwnProperty.call(options, 'privateCheckpoint')) {
      const restored = globalThis.FraudPrivateModuleSave.checkpointState('T10', options.privateCheckpoint, state);
      state = restored.state;
      delivered = Boolean(state.result);
    }
    const snapshot = () => M.copy(state);
    function flush() {
      if (!host) return;
      const now = host.ownerDocument.defaultView.performance.now();
      if (last !== null) state = M.apply(state, { type: 'tick', value: now - last, revision: state.revision }).state;
      last = host.ownerDocument.hidden ? null : now;
    }
    function visibility() { flush(); }
    function dispatch(type, value) {
      flush();
      const out = M.apply(state, { type, value, revision: state.revision });
      state = out.state;
      message = out.accepted ? '' : ({ mismatch: moduleText('t007'), date: moduleText('t008'), incomplete: moduleText('t009') }[out.reason] || moduleText('t010'));
      if (state.result && !delivered) { delivered = true; options.onResult?.(M.copy(state.result)); }
      render(); return out.accepted;
    }
    function render() {
      if (!host) return;
      const doc = host.ownerDocument, focused = doc.activeElement?.dataset?.key;
      host.replaceChildren();
      const el = (tag, text) => { const node = doc.createElement(tag); node.textContent = text; host.append(node); return node; };
      const button = (text, type, value, pressed) => {
        const b = el('button', text); b.type = 'button'; b.dataset.key = type + ':' + (value || '');
        if (pressed !== undefined) b.setAttribute('aria-pressed', String(pressed));
        b.onclick = () => dispatch(type, value); return b;
      };
      el('h2', moduleText('t011'));
      el('p', moduleText('t012'));
      el('p', moduleText('t013'));
      el('p', moduleText('t014') + (state.activeMs / 60000).toFixed(2) + moduleText('t015'));
      if (state.paused) { el('p', moduleText('t016')); button(moduleText('t017'), 'resume'); }
      else {
        if (state.phase === 'intro') { el('p', moduleText('t018')); button(moduleText('t019'), 'start'); }
        if (state.phase === 'assembly') {
          el('h3', moduleText('t020'));
          for (const id of M.pieces) {
            if (state.placed.includes(id)) el('p', labels[id] + moduleText('t021'));
            else button(labels[id] + ' · ' + state.turns[id] * 90 + '°', 'select', id, state.selected === id);
          }
          button(moduleText('t022'), 'rotate');
          for (const id of M.pieces) button(moduleText('t023') + labels[id], 'place', id);
        }
        if (state.phase === 'source') { el('p', moduleText('t024')); button(moduleText('t025'), 'route', 'witness'); button(moduleText('t026'), 'route', 'record'); }
        if (state.phase === 'reading') {
          el('p', state.route === 'witness' ? moduleText('t027') : moduleText('t028'));
          el('p', moduleText('t029')); button(moduleText('t030'), 'read');
        }
        if (state.phase === 'compare') { el('p', moduleText('t031')); for (const id of ['roof', 'island', 'other']) button(labels[id], 'tag', id, state.pair.includes(id)); button(moduleText('t032'), 'compare'); }
        if (state.phase === 'archive') {
          el('p', moduleText('t033'));
          for (const id of ['memory', 'source']) { const b = button((id === 'memory' ? moduleText('t034') : moduleText('t035')) + (state.archived.includes(id) ? moduleText('t036') : moduleText('t037')), 'archive', id); b.disabled = state.archived.includes(id); }
          button(moduleText('t038'), 'handoff');
        }
        if (state.phase === 'result') { el('h3', moduleText('t039')); el('p', moduleText('t040') + (state.route === 'witness' ? moduleText('t041') : moduleText('t042')) + moduleText('t043')); }
        button(moduleText('t044'), 'pause');
      }
      const status = el('p', message); status.setAttribute('role', 'status');
      const reset = el('button', moduleText('t045')); reset.type = 'button'; reset.onclick = () => { state = M.create(); delivered = false; message = ''; last = host.ownerDocument.hidden ? null : host.ownerDocument.defaultView.performance.now(); render(); };
      if (focused) Array.from(host.querySelectorAll('button')).find(b => b.dataset.key === focused)?.focus({ preventScroll: true });
    }
    function mount(target) {
      if (!target?.ownerDocument) throw new TypeError('mount requires a DOM element');
      unmount(); host = target; host.classList.add('fe-t10'); last = target.ownerDocument.hidden ? null : target.ownerDocument.defaultView.performance.now(); render();
      target.ownerDocument.addEventListener('visibilitychange', visibility);
      timer = target.ownerDocument.defaultView.setInterval(flush, 250);
      return api;
    }
    function unmount() {
      if (host) { flush(); host.ownerDocument.removeEventListener('visibilitychange', visibility); host.ownerDocument.defaultView.clearInterval(timer); host.replaceChildren(); host.classList.remove('fe-t10'); }
      host = null; timer = null; last = null;
    }
    const api = { mount, unmount, getState: snapshot,
      getPrivateCheckpoint() {
        const revision = state.revision;
        flush();
        if (state.revision !== revision) render();
        return globalThis.FraudPrivateModuleSave.makeCheckpoint('T10', snapshot(), {});
      } };
    return api;
  }
  root.FraudT10 = { create };
})(globalThis);
