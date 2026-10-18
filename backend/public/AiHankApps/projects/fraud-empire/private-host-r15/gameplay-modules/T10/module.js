((root) => {
  'use strict';
  const M = root.FraudT10Model, i18n = root.FraudT10I18n;
  const labels = { radio: i18n.t('t001'), rail: i18n.t('t002'), night: i18n.t('t003'), roof: i18n.t('t004'), island: i18n.t('t005'), other: i18n.t('t006') };
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
      message = out.accepted ? '' : ({ mismatch: i18n.t('t007'), date: i18n.t('t008'), incomplete: i18n.t('t009') }[out.reason] || i18n.t('t010'));
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
      el('h2', i18n.t('t011'));
      el('p', i18n.t('t012'));
      el('p', i18n.t('t013'));
      el('p', i18n.t('t014') + (state.activeMs / 60000).toFixed(2) + i18n.t('t015'));
      if (state.paused) { el('p', i18n.t('t016')); button(i18n.t('t017'), 'resume'); }
      else {
        if (state.phase === 'intro') { el('p', i18n.t('t018')); button(i18n.t('t019'), 'start'); }
        if (state.phase === 'assembly') {
          el('h3', i18n.t('t020'));
          for (const id of M.pieces) {
            if (state.placed.includes(id)) el('p', labels[id] + i18n.t('t021'));
            else button(labels[id] + ' · ' + state.turns[id] * 90 + '°', 'select', id, state.selected === id);
          }
          button(i18n.t('t022'), 'rotate');
          for (const id of M.pieces) button(i18n.t('t023') + labels[id], 'place', id);
        }
        if (state.phase === 'source') { el('p', i18n.t('t024')); button(i18n.t('t025'), 'route', 'witness'); button(i18n.t('t026'), 'route', 'record'); }
        if (state.phase === 'reading') {
          el('p', state.route === 'witness' ? i18n.t('t027') : i18n.t('t028'));
          el('p', i18n.t('t029')); button(i18n.t('t030'), 'read');
        }
        if (state.phase === 'compare') { el('p', i18n.t('t031')); for (const id of ['roof', 'island', 'other']) button(labels[id], 'tag', id, state.pair.includes(id)); button(i18n.t('t032'), 'compare'); }
        if (state.phase === 'archive') {
          el('p', i18n.t('t033'));
          for (const id of ['memory', 'source']) { const b = button((id === 'memory' ? i18n.t('t034') : i18n.t('t035')) + (state.archived.includes(id) ? i18n.t('t036') : i18n.t('t037')), 'archive', id); b.disabled = state.archived.includes(id); }
          button(i18n.t('t038'), 'handoff');
        }
        if (state.phase === 'result') { el('h3', i18n.t('t039')); el('p', i18n.t('t040') + (state.route === 'witness' ? i18n.t('t041') : i18n.t('t042')) + i18n.t('t043')); }
        button(i18n.t('t044'), 'pause');
      }
      const status = el('p', message); status.setAttribute('role', 'status');
      const reset = el('button', i18n.t('t045')); reset.type = 'button'; reset.onclick = () => { state = M.create(); delivered = false; message = ''; last = host.ownerDocument.hidden ? null : host.ownerDocument.defaultView.performance.now(); render(); };
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
