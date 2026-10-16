/* global document, window, MutationObserver, IntersectionObserver, performance */
(() => {
  'use strict';
  const model = globalThis.FraudCoachModel, locales = globalThis.FraudCoachLocales;
  const demo = document.getElementById('demo'), panel = document.getElementById('interactivePrototype');
  if (!model || !locales || !demo || !panel || window.FraudSupervisorCoach) return;
  const adapters = new Map([['MG-P02', model.describeP02]]), cleanups = [];
  let contextProvider = null, disposed = false, enabled = true, muted = true, volume = 50, focused = document.hasFocus(), intersecting = true, lastLine = null, pendingAttempt = null;
  const el = (tag, value, cls) => { const n = document.createElement(tag); if (value !== undefined) n.textContent = value; if (cls) n.className = cls; return n; };
  const coach = el('aside', undefined, 'supervisor-coach'); coach.id = 'supervisorCoach'; coach.hidden = true; coach.setAttribute('aria-label', '主管提示');
  const bar = el('div', undefined, 'supervisor-coach-bar'), name = el('strong', undefined, 'supervisor-coach-name'), hint = el('button'), message = el('div', undefined, 'supervisor-coach-message'), line = el('p'), dismiss = el('button');
  hint.type = dismiss.type = 'button'; hint.dataset.coachManual = 'true'; dismiss.dataset.coachDismiss = 'true';
  line.setAttribute('role', 'status'); line.setAttribute('aria-live', 'polite'); line.setAttribute('aria-atomic', 'true'); message.hidden = true; message.append(line, dismiss); bar.append(name, hint);
  const details = el('details'), summary = el('summary'), enableLabel = el('label'), enableInput = el('input'), enableText = el('span'), muteLabel = el('label'), muteInput = el('input'), muteText = el('span'), volumeLabel = el('label'), volumeText = el('span'), volumeInput = el('input'), volumeOutput = el('output');
  enableInput.type = muteInput.type = 'checkbox'; enableInput.checked = enabled; muteInput.checked = muted; enableInput.dataset.coachEnabled = 'true'; muteInput.dataset.coachMute = 'true';
  volumeInput.type = 'range'; volumeInput.min = '0'; volumeInput.max = '100'; volumeInput.step = '1'; volumeInput.value = String(volume); volumeInput.dataset.coachVolume = 'true'; volumeOutput.value = String(volume);
  const audioNote = el('small'), contextNote = el('small'), proposalNote = el('small');
  enableLabel.append(enableInput, enableText); muteLabel.append(muteInput, muteText); volumeLabel.append(volumeText, volumeInput, volumeOutput); details.append(summary, enableLabel, muteLabel, volumeLabel, audioNote, contextNote, proposalNote); coach.append(bar, message, details);
  function language() { return document.getElementById('b03ReadingLanguage')?.value || 'zh-TW'; }
  function context() {
    if (contextProvider) return contextProvider() || {};
    try { const c = JSON.parse(demo.dataset.proposalContext || '{}'); return { rank: c.rank, relationship: 'unknown', relationshipSource: 'not-connected-no-inference', provenance: 'existing-demo-context-not-formal-player-save' }; } catch { return {}; }
  }
  function source() {
    const game = window.FraudInteractiveDemo?.getActiveGame(), state = game ? window.FraudInteractiveDemo?.getSnapshot(game) : null;
    const descriptor = adapters.get(game)?.(state), person = model.speaker(context());
    const active = !disposed && !panel.hidden && document.documentElement.classList.contains('interactive-prototype-active') && Boolean(descriptor && person);
    const reading = Boolean(document.querySelector('dialog[open]') || details.open || panel.querySelector('.proto-hud-description') || descriptor?.reading || document.activeElement?.matches('select,input,textarea,[contenteditable=true]'));
    return { active: active && enabled, terminal: descriptor?.terminal || false, paused: !focused || document.visibilityState !== 'visible' || !intersecting || reading || descriptor?.busy, session: descriptor?.session || null, stage: descriptor?.stage || null, progressKey: descriptor?.progressKey || null, inputKey: descriptor?.inputKey || null, contextKey: JSON.stringify(person), speaker: person, descriptor };
  }
  function clearLine() { lastLine = null; message.hidden = true; if (line.textContent) line.textContent = ''; }
  function updateLine() { if (!lastLine) return; line.textContent = locales.line(language(), lastLine.speaker, lastLine.level, lastLine.serial, lastLine.descriptor); message.dataset.level = lastLine.level; message.dataset.cause = lastLine.cause; message.hidden = false; }
  const controller = model.createController({ read: source, now: () => performance.now(), schedule: (fn, ms) => window.setTimeout(fn, ms), cancel: id => window.clearTimeout(id), onClear: clearLine, onHint(value) { lastLine = value; updateLine(); } });
  function mount() {
    const board = panel.querySelector('.proto-live-board');
    if (board && coach.nextElementSibling !== board) board.before(coach);
    const current = source(), t = locales.get(language());
    coach.hidden = panel.hidden || !current.descriptor; coach.lang = language(); coach.setAttribute('aria-label', t.title);
    const setText = (n, value) => { if (n.textContent !== value) n.textContent = value; };
    setText(name, current.speaker ? current.speaker.name + ' / R' + current.speaker.rank : t.unknown); setText(hint, t.manual); setText(dismiss, t.dismiss); setText(summary, t.settings); setText(enableText, t.enabled); setText(muteText, t.mute); setText(volumeText, t.volume); setText(audioNote, t.noAudio); setText(contextNote, current.speaker?.provenance === 'existing-demo-context-not-formal-player-save' ? t.context : current.speaker?.provenance || t.unknown); setText(proposalNote, t.proposal);
    hint.disabled = !current.active || current.terminal || current.descriptor?.busy; coach.dataset.speaker = current.speaker?.id || 'unknown'; coach.dataset.stage = current.stage || 'none'; coach.dataset.audioAvailable = 'false';
  }
  function refresh(wrong = false) { if (disposed) return; mount(); controller.refresh({ wrong }); }
  hint.addEventListener('click', () => controller.manual()); dismiss.addEventListener('click', clearLine);
  enableInput.addEventListener('change', () => { enabled = enableInput.checked; clearLine(); refresh(); });
  muteInput.addEventListener('change', () => { muted = muteInput.checked; });
  volumeInput.addEventListener('input', () => { volume = Number(volumeInput.value); volumeOutput.value = String(volume); });
  details.addEventListener('toggle', () => refresh());
  function listen(target, event, callback, options) { target.addEventListener(event, callback, options); cleanups.push(() => target.removeEventListener(event, callback, options)); }
  function processAttempt() {
    if (!pendingAttempt || !pendingAttempt.complete) { refresh(); return; }
    const attempt = pendingAttempt; pendingAttempt = null; const after = window.FraudInteractiveDemo?.getSnapshot(attempt.game);
    const wrong = !attempt.event.defaultPrevented && !attempt.busy && after?.session === attempt.session && after?.revision === attempt.revision && Boolean(panel.querySelector('.proto-feedback.is-error'));
    refresh(wrong);
  }
  listen(document, 'click', event => {
    const action = event.target.closest?.('[data-proto-action]');
    if (!action || !panel.contains(action) || action.getAttribute('aria-disabled') === 'true') return;
    const s = window.FraudInteractiveDemo?.getSnapshot();
    if (!s || !adapters.has(s.game)) return;
    pendingAttempt = { game: s.game, session: s.session, revision: s.revision, busy: Boolean(s.pendingEvent), event, complete: false };
  }, true);
  listen(document, 'click', event => {
    if (pendingAttempt?.event === event) { pendingAttempt.complete = true; processAttempt(); }
    else if (pendingAttempt?.event.defaultPrevented) pendingAttempt = null;
  });
  const observer = new MutationObserver(records => {
    if (records.some(r => !coach.contains(r.target) && !(r.type === 'childList' && [...r.addedNodes, ...r.removedNodes].every(n => n === coach)) && (r.target === panel || panel.contains(r.target) || r.target.tagName === 'DIALOG' || r.target === demo || r.target === document.documentElement))) processAttempt();
  });
  observer.observe(panel, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'data-revision', 'data-busy', 'data-view'] });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  observer.observe(demo, { attributes: true, attributeFilter: ['data-proposal-context', 'hidden'] });
  const dialog = document.getElementById('interactivePrototypeDialog'); if (dialog) observer.observe(dialog, { attributes: true, attributeFilter: ['open'] });
  const visibility = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => { intersecting = entries[0]?.isIntersecting !== false; refresh(); }, { threshold: 0.01 }) : null;
  visibility?.observe(panel);
  listen(document, 'visibilitychange', () => { focused = document.hasFocus(); refresh(); });
  listen(window, 'blur', () => { focused = false; refresh(); }); listen(window, 'focus', () => { focused = true; refresh(); });
  listen(window, 'hashchange', () => refresh()); listen(document, 'fraud:demo-context', () => refresh()); listen(document, 'fraud:interactive-ready', () => refresh());
  listen(document, 'focusin', () => refresh()); listen(document, 'focusout', () => globalThis.queueMicrotask(() => refresh()));
  listen(document, 'change', event => { if (event.target.id === 'b03ReadingLanguage') { mount(); updateLine(); } });
  listen(window, 'pagehide', () => { focused = false; refresh(); }); listen(window, 'pageshow', () => { focused = document.hasFocus(); refresh(); });
  window.FraudSupervisorCoach = Object.freeze({ getStatus: () => ({ ...controller.getStatus(), speaker: model.speaker(context()), audio: { available: false, muted, volume, played: 0 }, implemented: [...adapters.keys()], formalStateMutation: false, playerSceneIntegrated: false }), refresh: () => refresh(), extensionPoint: 'FraudCoachModel.createController; source-specific read/describe/surface bindings required', setContextProvider(provider) { if (typeof provider !== 'function') throw new Error('Read-only player context provider required'); contextProvider = provider; refresh(); }, dispose() { if (disposed) return; disposed = true; controller.dispose(); observer.disconnect(); visibility?.disconnect(); for (const cleanup of cleanups) cleanup(); coach.remove(); } });
  refresh();
})();
