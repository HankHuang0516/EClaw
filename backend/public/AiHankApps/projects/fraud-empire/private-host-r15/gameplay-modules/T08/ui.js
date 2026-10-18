(() => {
  'use strict';
  const base = new URL('.', document.currentScript.src);
  const model = globalThis.FraudT08Model;
  const copy = value => JSON.parse(JSON.stringify(value));
  let sequence = 0;
  const newSession = () => 'T08-' + (globalThis.crypto?.randomUUID?.() || Date.now() + '-' + (++sequence));
  function mount(container, options = {}) {
    let state = model.create(newSession()), host = null, shadow = null, resetPending = false;
    let feedback = 'ready', eventSequence = 0, closed = false, mountEpoch = 0;
    if (Object.prototype.hasOwnProperty.call(options, 'privateCheckpoint')) {
      const restored = globalThis.FraudPrivateModuleSave.checkpointState('T08', options.privateCheckpoint, state);
      state = restored.state;
      eventSequence = restored.controller.eventSequence;
    }
    const i18n = { t(key, values = {}) {
      let value = options.messages?.[key] || globalThis.FraudT08Messages[key] || key;
      for (const [name, replacement] of Object.entries(values)) value = value.replace('{' + name + '}', replacement);
      return value;
    } };
    function notify(fn, value) {
      if (typeof fn === 'function') {
        try { fn(copy(value)); } catch (error) { if (typeof options.onError === 'function') options.onError(error); }
      }
    }
    const errors = { wrongBox: 'errorWrongBox', approach: 'approachError', select: 'selectError', mark: 'markError', close: 'closeError', preview: 'previewError', result: 'resultError' };
    function send(type, payload = {}, origin = { session: state.session, revision: state.revision, epoch: mountEpoch }) {
      if (!host) return { accepted: false, code: 'unmounted' };
      if (origin.epoch !== mountEpoch) return { accepted: false, code: 'stale' };
      const out = model.apply(state, { ...payload, type, ...origin, id: state.session + ':' + (++eventSequence) });
      state = out.state;
      feedback = out.accepted ? 'ok' : errors[out.code] || out.code;
      render();
      if (out.accepted) notify(options.onChange, { state, deltaMinutes: out.deltaMinutes, proposal: true });
      if (out.result) notify(options.onResult, out.result);
      return copy(out);
    }
    function render() {
      const focus = shadow.activeElement?.dataset.action;
      shadow.replaceChildren();
      const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = new URL('ui.css', base).href; shadow.append(css);
      const main = document.createElement('section'); main.className = 't08'; shadow.append(main);
      const text = (tag, key, values, parent = main) => { const n = document.createElement(tag); n.textContent = i18n.t(key, values); parent.append(n); return n; };
      const button = (key, handler, parent = main, pressed) => {
        const n = text('button', key, {}, parent); n.type = 'button'; n.dataset.action = key;
        if (pressed !== undefined) n.setAttribute('aria-pressed', String(pressed));
        n.addEventListener('click', handler); return n;
      };
      const action = (key, type, payload = {}, parent, pressed) => {
        const origin = { session: state.session, revision: state.revision, epoch: mountEpoch };
        return button(key, () => send(type, payload, origin), parent, pressed);
      };
      text('h1', 'title'); text('p', 'boundary'); text('p', 'objective'); text('p', 'source');
      text('p', 'time', { minutes: state.minutes });
      const note = text('p', feedback); note.setAttribute('role', 'status'); note.setAttribute('aria-live', 'polite');
      const reference = document.createElement('details'); main.append(reference); text('summary', 'artNote', {}, reference);
      const art = document.createElement('img'); art.src = new URL('../../images/8c617c7f097fea482027.webp', base).href;
      art.alt = reference.querySelector('summary').textContent; art.loading = 'lazy'; reference.append(art);
      text('h2', 'live'); text('p', 'position', { position: i18n.t(state.position) });
      text('p', 'marked', { value: i18n.t(state.marked ? 'yes' : 'no') });
      text('p', 'routes', { count: state.edges.length });
      if (state.edges.includes('moon-star')) text('p', 'generic');
      if (state.edges.includes('star-fog')) text('p', 'gap');
      text('p', 'contents', { value: i18n.t(state.inspected ? 'weight' : 'unopened') });
      if (!state.result) {
        text('h2', 'entry'); action('enter', 'enter'); action('approach', 'approach', { box: 'H8' }); action('wrongBox', 'approach', { box: 'other' });
        text('h2', 'markTitle'); action('select', 'select', { box: 'H8' }, undefined, state.selected);
        if (state.selected) text('p', 'selected');
        for (const [key, station] of [['markMoon', 'moon'], ['markStar', 'star'], ['markFog', 'fog']]) action(key, 'mark', { station });
        text('h2', 'edgeTitle'); action('moonStar', 'edge', { edge: 'moon-star' }); action('starFog', 'edge', { edge: 'star-fog' });
        text('h2', 'inspectTitle'); action('open', 'open'); action('close', 'close');
        text('h2', 'choiceTitle'); action('returnChoice', 'preview', { choice: 'return' }); action('holdChoice', 'preview', { choice: 'hold' });
        if (state.pendingChoice) { text('p', state.pendingChoice === 'return' ? 'returnPreview' : 'holdPreview'); action('confirm', 'confirm'); }
        action('cancel', 'cancel');
        if (state.choice) text('p', state.choice === 'return' ? 'returnPreview' : 'holdPreview');
        text('h2', 'finishTitle'); action('seal', 'seal'); action('abandon', 'abandon');
      } else {
        text('h2', 'resultTitle'); text('p', state.result.outcome);
        if (state.choice) text('p', state.choice === 'return' ? 'returnPreview' : 'holdPreview');
        if (state.returned) text('p', 'returned'); else action('back', 'return');
      }
      action('read', 'read'); button('exit', () => { unmount(); notify(options.onExit, state); });
      button('reset', () => { resetPending = true; render(); });
      if (resetPending) {
        text('p', 'resetNote');
        button('confirmReset', () => { state = model.create(newSession()); resetPending = false; feedback = 'ready'; render(); notify(options.onChange, { state, deltaMinutes: 0, proposal: true }); });
        button('cancelReset', () => { resetPending = false; render(); });
      }
      if (focus) {
        const target = [...shadow.querySelectorAll('button')].find(n => n.dataset.action === focus) || note;
        if (target === note) note.tabIndex = -1;
        target.focus({ preventScroll: true });
      }
    }
    function attach(target) {
      if (closed) throw new Error('T08 instance destroyed');
      if (!target || typeof target.append !== 'function') throw new TypeError('container required');
      if (host) unmount();
      host = document.createElement('div'); target.append(host); shadow = host.attachShadow({ mode: 'open' }); render();
    }
    function unmount() { if (host) host.remove(); host = null; shadow = null; resetPending = false; mountEpoch++; }
    attach(container);
    return { mount: attach, unmount, dispatch: send, getState: () => copy(state),
      getPrivateCheckpoint: () => globalThis.FraudPrivateModuleSave.makeCheckpoint('T08', copy(state), { eventSequence }),
      destroy() { unmount(); closed = true; } };
  }
  globalThis.FraudT08 = Object.freeze({ mount });
})();
