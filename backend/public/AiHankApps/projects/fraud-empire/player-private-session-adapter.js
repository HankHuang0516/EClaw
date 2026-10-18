/* Ordinary scene adapter for the frozen, version-bound r15 private host.
 * Never maps private results into the legacy world or save contract. */
(function (root, factory) {
  'use strict';
  root.FraudPrivateSessionAdapter = factory();
})(globalThis, function () {
  'use strict';
  const clone = value => JSON.parse(JSON.stringify(value));
  const words = {
    'zh-TW': { title: '私人玩法', scope: '獨立保存，不改主線、獎勵或舊存檔。私人內容目前為繁中，原語系偏好不變。', save: '保存私人玩法', load: '還原私人玩法', back: '返回原場景', working: '正在處理私人進度…', ready: '私人玩法已接上；返回時會先保存，再回同一場景。', error: '私人操作尚未完成；原場景與既有存檔保留。', office: '請先回辦公室，再開啟私人玩法。', cancelled: '已取消私人還原，目前私人進度不變。', leave: '本次私人進度尚未確認保存。返回會保留已存資料，但本次未存變更可能遺失；仍要返回原場景嗎？' },
    en: { title: 'Private play', scope: 'Separate save. No story, rewards or legacy-save changes. Private content is Traditional Chinese; your language preference is unchanged.', save: 'Save private play', load: 'Restore private play', back: 'Return to the same scene', working: 'Working on private progress…', ready: 'Private play is connected. Returning saves it before resuming the same scene.', error: 'Private operation is incomplete. The original scene and existing saves are preserved.', office: 'Return to the office before opening private play.', cancelled: 'Private restore cancelled. Current private progress is unchanged.', leave: 'This private progress is not confirmed saved. Existing saved data will remain, but unsaved changes may be lost. Return to the original scene?' },
    'zh-CN': { title: '私人玩法', scope: '独立保存，不改主线、奖励或旧存档。私人内容目前为繁中，原语言偏好不变。', save: '保存私人玩法', load: '还原私人玩法', back: '返回原场景', working: '正在处理私人进度…', ready: '私人玩法已接上；返回时会先保存，再回同一场景。', error: '私人操作尚未完成；原场景与已有存档保留。', office: '请先回办公室，再开启私人玩法。', cancelled: '已取消私人还原，目前私人进度不变。', leave: '本次私人进度尚未确认保存。返回会保留已存数据，但未存更改可能丢失；仍要返回原场景吗？' },
    ja: { title: 'プライベート試遊', scope: '独立した保存です。本編・報酬・旧セーブは変更しません。内容は繁体字中国語で、言語設定は保持します。', save: '試遊を保存', load: '試遊を復元', back: '元の場面に戻る', working: '試遊の進行を処理中…', ready: '試遊に接続しました。保存してから同じ場面に戻ります。', error: '操作は未完了です。元の場面と既存セーブを保持しています。', office: 'オフィスに戻ってから試遊を開いてください。', cancelled: '復元を取り消しました。現在の試遊は保持されます。', leave: '今回の進行は保存を確認できていません。既存の保存は残りますが、未保存の変更は失われる場合があります。元の場面に戻りますか？' },
    ko: { title: '개인 체험', scope: '별도 저장입니다. 본편, 보상, 기존 저장은 바꾸지 않습니다. 체험 내용은 번체 중국어이며 언어 설정은 유지됩니다.', save: '개인 체험 저장', load: '개인 체험 복원', back: '원래 장면으로 돌아가기', working: '개인 진행 처리 중…', ready: '개인 체험이 연결되었습니다. 저장 후 같은 장면으로 돌아갑니다.', error: '작업이 완료되지 않았습니다. 원래 장면과 기존 저장은 유지됩니다.', office: '사무실로 돌아온 후 개인 체험을 여세요.', cancelled: '복원을 취소했습니다. 현재 개인 진행은 유지됩니다.', leave: '이번 진행의 저장을 확인하지 못했습니다. 기존 저장은 남지만 저장하지 않은 변경은 사라질 수 있습니다. 원래 장면으로 돌아갈까요?' }
  };
  function create({ window, document, privatePath, expectedVersion, expectedHash, language, getContext, onSuspend, onResume }) {
    let active = false, busy = false, disposed = false, frame = null, route = null, origin = null, lastResult = null, lastError = null, previousFocus = null, disposeChildUI = () => {};
    const viewportResets = [];
    const copy = () => words[language?.()] || words['zh-TW'];
    const el = (tag, text, cls) => { const node = document.createElement(tag); if (text) node.textContent = text; if (cls) node.className = cls; return node; };
    const shell = el('section', null, 'private-session-shell'), header = el('header', null, 'private-session-header'), title = el('h1', copy().title), scope = el('p', copy().scope), controls = el('nav'), status = el('p', '', 'private-session-status');
    const saveButton = el('button', copy().save), loadButton = el('button', copy().load), backButton = el('button', copy().back);
    shell.dataset.privateSession = 'true'; shell.hidden = true; shell.setAttribute('aria-label', copy().title); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    for (const button of [saveButton, loadButton, backButton]) button.type = 'button';
    saveButton.dataset.privateSessionSave = 'true'; loadButton.dataset.privateSessionLoad = 'true'; backButton.dataset.privateSessionReturn = 'true';
    controls.append(saveButton, loadButton, backButton); header.append(title, scope, controls, status); shell.append(header); document.body.append(shell);
    const delay = ms => new Promise(resolve => window.setTimeout(resolve, ms));
    async function until(test, code) { for (let i = 0; i < 240; i++) { if (disposed) throw Error('adapter-disposed'); if (test()) return; await delay(50); } throw Error(code); }
    function update() {
      shell.setAttribute('aria-busy', String(busy));
      saveButton.disabled = loadButton.disabled = busy || !route || route.getStatus().blocked;
      backButton.disabled = busy;
      title.textContent = copy().title; scope.textContent = copy().scope;
      saveButton.textContent = copy().save; loadButton.textContent = copy().load; backButton.textContent = copy().back;
    }
    function result(accepted, code, detail) { lastResult = { accepted, code, detail: detail || null }; return clone(lastResult); }
    async function run(operation) {
      if (disposed) return result(false, 'adapter-disposed');
      if (busy) return result(false, 'adapter-busy');
      busy = true; lastError = null; status.textContent = copy().working; update();
      try { return await operation(); }
      catch (error) { lastError = error.message; status.textContent = copy().error + ' [' + lastError + ']'; return result(false, 'private-operation-incomplete', lastError); }
      finally { busy = false; update(); }
    }
    function bindChildUI(child) {
      const childWindow = frame.contentWindow, stage = child.querySelector('.route-preview-stage'), notice = child.querySelector('.route-preview-status');
      let previousHeading = null, previousView = null, scheduled = 0;
      function syncViewport() {
        scheduled = 0;
        if (!active || disposed || frame?.contentDocument !== child) return;
        const heading = stage.querySelector(':scope > h2'), host = childWindow.FraudPrivateLegacyPreview, hostState = host?.getStatus(), id = hostState?.active || null;
        const instance = hostState?.instances?.find(row => row.id === id), snapshot = id ? host.getSnapshot(id) : null, state = snapshot?.state || snapshot;
        const view = { id, session: instance?.session || state?.session || null, run: instance?.run ?? null, revision: state?.revision ?? null };
        const newHeading = heading && heading !== previousHeading;
        const reset = previousView?.id === id && id && (view.session !== previousView.session || view.run !== previousView.run || Number.isInteger(view.revision) && Number.isInteger(previousView.revision) && view.revision < previousView.revision);
        if (newHeading || reset) {
          childWindow.scrollTo({ top: 0, left: 0, behavior: 'instant' }); child.documentElement.scrollTop = 0; child.body.scrollTop = 0;
          if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
          viewportResets.push({ module: id, reason: reset ? 'source-reset' : 'view-change', title: heading?.textContent || '' });
          if (viewportResets.length > 64) viewportResets.shift();
        }
        previousHeading = heading; previousView = view;
      }
      function scheduleViewport() { if (!scheduled) scheduled = childWindow.requestAnimationFrame(syncViewport); }
      const observer = new childWindow.MutationObserver(records => {
        if (!busy && notice && records.some(record => record.target === notice || notice.contains(record.target))) status.textContent = notice.textContent || copy().ready;
        scheduleViewport();
      });
      observer.observe(stage, { childList: true, subtree: true });
      if (notice) observer.observe(notice, { childList: true, characterData: true, subtree: true });
      child.addEventListener('click', scheduleViewport, true); scheduleViewport();
      disposeChildUI = () => { observer.disconnect(); child.removeEventListener('click', scheduleViewport, true); if (scheduled) childWindow.cancelAnimationFrame(scheduled); scheduled = 0; disposeChildUI = () => {}; };
    }
    async function ensureOpen() {
      if (active) { if (!route || route.getStatus().blocked) throw Error('private-host-held'); return; }
      if (getContext().phase !== 'office') throw Error('office-required');
      previousFocus = document.activeElement;
      origin = clone(onSuspend());
      active = true; shell.hidden = false; document.body.classList.add('private-session-open');
      const target = new window.URL(privatePath, window.location.href);
      if (target.origin !== window.location.origin) throw Error('private-origin-mismatch');
      frame = document.createElement('iframe'); frame.title = copy().title; frame.dataset.privateSessionFrame = 'true';
      frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-modals'); frame.setAttribute('referrerpolicy', 'no-referrer'); shell.append(frame); frame.src = target.href;
      await until(() => Boolean(frame.contentWindow?.FraudRoutePreview), 'private-host-timeout');
      route = frame.contentWindow.FraudRoutePreview;
      await until(() => !route.getStatus().busy, 'private-host-busy');
      const identity = route.getStatus();
      if (identity.privateSaveVersion !== expectedVersion || identity.privateSaveRuntimeHash !== expectedHash) throw Error('private-host-identity-mismatch');
      const child = frame.contentDocument;
      for (const selector of ['[data-route-save]', '[data-route-load]', '[data-route-exit]', '[data-route-stage-select]', '.route-preview']) if (!child.querySelector(selector)) throw Error('private-host-control-contract');
      const style = child.createElement('style'); style.textContent = '.route-preview-header,.route-preview-footer,.route-preview-status{display:none!important}.route-preview{min-height:100dvh}.route-preview-stage{padding-top:8px}'; child.head.append(style);
      bindChildUI(child);
      child.querySelector('[data-route-exit]').addEventListener('click', event => { event.preventDefault(); event.stopImmediatePropagation(); void back(); }, true);
      if (identity.blocked) throw Error('private-host-held');
      if (route.getStatus().step !== 'games') {
        const select = child.querySelector('[data-route-stage-select]'); select.value = 'games'; select.dispatchEvent(new frame.contentWindow.Event('change', { bubbles: true }));
        await until(() => route.getStatus().blocked || !route.getStatus().busy && route.getStatus().step === 'games', 'private-games-entry-timeout');
        if (route.getStatus().blocked) throw Error('private-host-held');
      }
      status.textContent = copy().ready;
    }
    async function command(kind) {
      await ensureOpen();
      await until(() => !route.getStatus().busy, 'private-host-busy');
      const child = frame.contentDocument, panel = child.querySelector('.route-preview'), button = child.querySelector(kind === 'save' ? '[data-route-save]' : '[data-route-load]');
      if (route.getStatus().blocked || button.disabled) throw Error('private-command-unavailable');
      panel.removeAttribute('data-private-save-outcome');
      button.click(); // Delegates to the frozen r15 manual command and its existing confirmation/CAS gates.
      await delay(0);
      await until(() => !route.getStatus().busy, 'private-command-timeout');
      if (route.getStatus().blocked) throw Error(route.getStatus().lastFailure || 'private-host-held');
      const outcome = panel.dataset.privateSaveOutcome, expected = kind === 'save' ? 'manual-saved' : 'restored';
      if (outcome !== expected) { status.textContent = copy().cancelled; return result(false, 'private-command-cancelled-or-unavailable'); }
      status.textContent = child.querySelector('.route-preview-status')?.textContent || copy().ready;
      return result(true, kind === 'save' ? 'private-saved' : 'private-restored', outcome);
    }
    async function finishReturn() {
      if (!active) return result(false, 'private-not-open');
      if (route?.getStatus().blocked) {
        if (!window.confirm(copy().leave)) return result(false, 'private-return-cancelled');
      } else if (route) {
        await until(() => !route.getStatus().busy, 'private-return-busy');
        const host = frame.contentWindow.FraudPrivateLegacyPreview, id = host?.getStatus().active;
        await until(() => { const state = id ? host.getSnapshot(id) : null; return !state?.pendingEvent && !state?.state?.pendingEvent; }, 'private-source-step-busy');
        host?.close();
        const saved = await route.flush();
        if (saved === false || route.getStatus().blocked) throw Error('private-return-not-saved');
      }
      disposeChildUI();
      if (route) await route.dispose();
      onResume(clone(origin));
      frame?.remove(); frame = null; route = null; active = false; shell.hidden = true; document.body.classList.remove('private-session-open');
      if (previousFocus?.isConnected) previousFocus.focus();
      return result(true, 'returned-to-same-scene');
    }
    const open = () => run(async () => { await ensureOpen(); return result(true, 'private-opened'); });
    const save = () => run(() => command('save'));
    const load = () => run(() => command('load'));
    const back = () => run(finishReturn);
    saveButton.addEventListener('click', () => { void save(); }); loadButton.addEventListener('click', () => { void load(); }); backButton.addEventListener('click', () => { void back(); });
    return Object.freeze({
      open, save, load, back,
      getStatus: () => ({ source: 'ordinary-scene-private-adapter-r2', viewportResets: clone(viewportResets), active, busy, lastResult: lastResult && clone(lastResult), lastError, topLevelURL: window.location.href, returnContext: origin && clone(origin), privateHostVersion: expectedVersion, privateHostHash: expectedHash, private: route?.getStatus() || null, formalCommits: 0, awardedReward: 0, legacySaveWritesByAdapter: 0 }),
      async dispose() { if (disposed) return; if (route) { frame.contentWindow.FraudPrivateLegacyPreview?.close(); const saved = await route.flush(); if (saved === false || route.getStatus().blocked) return result(false, 'private-dispose-not-saved'); await route.dispose(); } disposeChildUI(); disposed = true; frame?.remove(); shell.remove(); document.body.classList.remove('private-session-open'); }
    });
  }
  return Object.freeze({ create });
});
