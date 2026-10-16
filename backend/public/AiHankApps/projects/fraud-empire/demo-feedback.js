(function () {
  'use strict';
  // This file and its imports must be absent from every formal-game artifact.
  if (!document.querySelector('meta[name="fraud-demo-report"][content="demo-only"]')) return;
  const model = window.FraudDemoFeedbackModel;
  const host = document.getElementById('demoFeedbackHost');
  if (!model || !host) return;
  const labels = { operation: '操作', rules: '玩法規則', dialogue: '劇情對話', art: '美術', balance: '數值', other: '其他' };
  let release = null;
  let draft = null;
  host.innerHTML = '<details class="demo-report-settings"><summary>Demo 設定</summary><button type="button" data-report="open" disabled>回報問題</button></details>'
    + '<dialog class="demo-report-dialog" aria-labelledby="demoReportTitle"><h2 id="demoReportTitle">回報問題</h2><p>僅供 Demo 研發。只會私人保存你預覽的畫面文字與參數，不建立公開 issue。</p>'
    + '<p data-report="capture-time"></p><form novalidate><label for="demoReportCategory">問題類別</label><select id="demoReportCategory"></select>'
    + '<label for="demoReportDescription">細節描述</label><textarea id="demoReportDescription" maxlength="2000" required placeholder="請描述遇到的問題及操作方式"></textarea>'
    + '<details><summary>送出前預覽：開啟回報時固定的快照</summary><pre data-report="preview"></pre></details>'
    + '<p role="status" aria-live="polite" data-report="status"></p><div class="report-actions"><button type="submit" data-report="send">私人送出</button><button type="button" data-report="close">取消，保留草稿</button></div></form></dialog>';
  const dialog = host.querySelector('dialog');
  const opener = host.querySelector('[data-report="open"]');
  const closer = host.querySelector('[data-report="close"]');
  const sender = host.querySelector('[data-report="send"]');
  const category = host.querySelector('select');
  const description = host.querySelector('textarea');
  const status = host.querySelector('[data-report="status"]');
  Object.entries(labels).forEach(([value, label]) => category.add(new Option(label, value)));

  function visibleTop() {
    if ([...document.querySelectorAll('dialog[open]')].some(sourceDialog => sourceDialog !== dialog)) return 0;
    let top = 0;
    document.querySelectorAll('.masthead,.section-nav').forEach(element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      if (rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight / 3
        && ['fixed', 'sticky'].includes(style.position) && style.display !== 'none') top = Math.max(top, rect.bottom);
    });
    return top;
  }
  function visible(element, includeDecorative = false) {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && rect.bottom > visibleTop() && rect.top < innerHeight
      && rect.right > 0 && rect.left < innerWidth && style.visibility !== 'hidden'
      && style.display !== 'none' && !element.closest(includeDecorative ? '[hidden]' : '[hidden],[aria-hidden="true"]');
  }
  const regions = [['camp', 'campInteractionHost'], ['T02', 'planInteractionHost'],
    ['prototype', 'interactivePrototype'], ['archive', 'newGameplayDemo'],
    ['archive', 'relationshipEventDetail'], ['archive', 'story'], ['archive', 'dialogues'],
    ['archive', 'reader'], ['archive', 'maps'], ['archive', 'topics'], ['legacy', 'demo']];
  let lastActivity = null;
  const modalOrigins = new WeakMap();
  function regionFor(element) {
    if (!(element instanceof Element) || host.contains(element)) return null;
    for (const [module, id] of regions) {
      const root = document.getElementById(id);
      if (root && root.contains(element)) return { module, id, element: root };
    }
    return null;
  }
  function trackActivity(event) {
    const region = regionFor(event.target);
    if (!region || !visible(event.target)) return;
    const rect = event.target.getBoundingClientRect();
    // One ephemeral point selects a visible source. No input or pointer history is collected or sent.
    lastActivity = { id: region.id, x: Math.max(0, Math.min(innerWidth - 1, rect.left + rect.width / 2)),
      y: Math.max(visibleTop() + 1, Math.min(innerHeight - 1, rect.top + rect.height / 2)) };
  }
  document.addEventListener('pointerdown', trackActivity, true);
  document.addEventListener('focusin', trackActivity, true);
  document.addEventListener('change', trackActivity, true);
  function currentRoot() {
    const sourceDialog = [...document.querySelectorAll('dialog[open]')].filter(element => element !== dialog).at(-1);
    if (sourceDialog) return { module: sourceDialog.id === 'interactivePrototypeDialog' ? 'prototype' : 'archive',
      id: sourceDialog.id || 'demo-source-dialog', element: sourceDialog, origin: modalOrigins.get(sourceDialog) || null };
    const top = visibleTop();
    const candidates = regions.map(([module, id]) => {
      const element = document.getElementById(id);
      const shown = Boolean(element && visible(element));
      const rect = element ? element.getBoundingClientRect() : null;
      return { module, id, element, visible: shown, area: shown
        ? Math.max(0, Math.min(innerHeight, rect.bottom) - Math.max(top, rect.top))
          * Math.max(0, Math.min(innerWidth, rect.right) - Math.max(0, rect.left)) : 0 };
    });
    const activePoint = lastActivity && regionFor(document.elementFromPoint(lastActivity.x, lastActivity.y));
    const activeId = activePoint && activePoint.id === lastActivity.id ? activePoint.id : null;
    const center = regionFor(document.elementFromPoint(innerWidth / 2, (top + innerHeight) / 2));
    // A parent Demo must not win merely because it contains another visible Demo.
    candidates.forEach(candidate => {
      if (!candidate.visible) return;
      const directChildren = candidates.filter(child => child.visible && child.id !== candidate.id
        && candidate.element.contains(child.element) && !candidates.some(middle => middle.visible
          && middle.id !== candidate.id && middle.id !== child.id
          && candidate.element.contains(middle.element) && middle.element.contains(child.element)));
      candidate.area = Math.max(0, candidate.area - directChildren.reduce((sum, child) => sum + child.area, 0));
    });
    return model.selectRegion(candidates, activeId, center ? center.id : null);
  }
  function visibleWords(element) {
    const top = visibleTop();
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const parts = [];
    let node;
    let count = 0;
    let examined = 0;
    while ((node = walker.nextNode()) && count < 6000 && examined < 12000) {
      const parent = node.parentElement;
      if (!parent || parent.closest('script,style,textarea,input,select,[data-demo-report-modal]') || !node.textContent.trim() || !visible(parent)) continue;
      const range = document.createRange();
      let offset = 0;
      let run = '';
      for (const glyph of node.textContent) {
        if (count >= 6000 || examined >= 12000) break;
        range.setStart(node, offset);
        offset += glyph.length;
        range.setEnd(node, offset);
        examined += glyph.length;
        const rect = range.getBoundingClientRect();
        const left = Math.max(0, rect.left);
        const right = Math.min(innerWidth, rect.right);
        const upper = Math.max(top, rect.top);
        const lower = Math.min(innerHeight, rect.bottom);
        const hit = right > left && lower > upper ? document.elementFromPoint((left + right) / 2, (upper + lower) / 2) : null;
        if (hit && (parent.contains(hit) || hit.contains(parent))) { run += glyph; count += glyph.length; }
        else if (run) { parts.push(run); run = ''; }
      }
      if (run.trim()) parts.push(run);
    }
    return parts.map(part => part.trim().replace(/\s+/g, ' ')).filter(Boolean).join('\n').slice(0, 6000);
  }

  const actionHistory = new Map();
  function historyKey(region) {
    if (region.module === 'prototype') return 'prototype:' + (window.FraudInteractiveDemo?.getActiveGame() || 'uninitialized');
    if (region.module === 'T02') return 'T02';
    if (region.module === 'camp') return 'camp:' + (document.getElementById('campSceneSelect')?.value || 'uninitialized');
    if (region.module === 'archive' && region.origin) return 'archive:' + (region.origin.sceneId || region.id);
    if (region.module === 'archive' && region.id === 'newGameplayDemo') return 'archive:' + (region.element.dataset.candidateId || 'uninitialized');
    if (region.module === 'legacy') {
      try { return 'legacy:' + (JSON.parse(document.getElementById('demo').dataset.proposalContext).sceneId || 'uninitialized'); }
      catch { return 'legacy:uninitialized'; }
    }
    return region.module + ':' + region.id;
  }
  function rememberGameAction(event) {
    if (!(event.target instanceof Element) || host.contains(event.target)) return;
    const selector = 'button[data-proto-action],button[data-pi-action],button[data-camp-action],button[data-switch-game],button[data-new-phase]';
    const control = event.type === 'click' ? event.target.closest(selector) : event.target;
    if (!control || !visible(control)) return;
    let region = regionFor(control);
    if (!region && control.closest('#interactivePrototypeDialog')) region = { module: 'prototype', id: 'interactivePrototypeDialog', element: control.closest('dialog') };
    if (!region) return;
    let key = historyKey(region);
    let action;
    let target;
    if (event.type === 'change') {
      if (control.id === 'newGameplayCandidate') { key = 'archive:' + control.value; action = '選擇圖文提案'; }
      else if (control.id === 'interactiveGameSelect') { key = 'prototype:' + control.value; action = '切換原型'; }
      else if (control.getAttribute('data-action') === 'scene') { key = 'legacy:' + control.value; action = '切換場景'; }
      else return;
      target = control.value;
    } else {
      action = control.dataset.protoAction || control.dataset.piAction || control.dataset.campAction || '切換示意';
      const values = ['piValue', 'campValue', 'job', 'piece', 'ticket', 'slot', 'view', 'choice', 'value'];
      const selected = values.find(name => typeof control.dataset[name] === 'string' && control.dataset[name].length);
      target = selected ? selected + ':' + control.dataset[selected] : control.dataset.newPhase || control.textContent.trim();
      if (control.dataset.switchGame) { key = 'prototype:' + control.dataset.switchGame; action = '切換原型'; target = control.dataset.switchGame; }
    }
    const records = actionHistory.get(key) || [];
    records.push({ action: ('嘗試：' + action).slice(0, 80), target: String(target).slice(0, 128) });
    actionHistory.set(key, records.slice(-12));
    if (actionHistory.size > 32) actionHistory.delete(actionHistory.keys().next().value);
  }
  document.addEventListener('click', rememberGameAction, { capture: true, passive: true });
  document.addEventListener('change', rememberGameAction, { capture: true, passive: true });

  function capture() {
    const current = currentRoot();
    const snapshot = { schemaVersion: 1, capturedAt: new Date().toISOString(), version: release.version,
      contentHash: release.contentHash,
      screen: { module: current ? current.module : 'uninitialized', id: current ? current.id : null,
        sceneId: null, stepId: null, visibleText: current ? visibleWords(current.element) : '目前沒有已初始化且可見的 Demo 畫面。', choices: [], assetIds: [] },
      game: { day: null, time: null, rank: null, scope: 'not-initialized',
        uninitialized: ['day', 'time', 'rank', 'mood', 'stamina', 'wisdom', 'score', 'xp', 'money'] },
      parameters: {}, recentActions: [] };
    if (!current) return snapshot;
    const root = current.element;
    snapshot.recentActions = (actionHistory.get(historyKey(current)) || []).slice(-12).map(record => ({ ...record }));
    snapshot.screen.choices = [...root.querySelectorAll('button')].filter(button => visible(button) && !button.hasAttribute('data-demo-report-modal')).slice(0, 20).map(button => ({
      id: (button.id || button.getAttribute('data-proto-action') || button.getAttribute('data-camp-action') || button.getAttribute('data-pi-action')
        || button.getAttribute('data-action') || button.textContent.trim()).slice(0, 128),
      label: button.textContent.trim().slice(0, 160), disabled: button.disabled
    }));
    const base = new URL('.', location.href);
    // aria-hidden can describe decorative art that is still visually present.
    snapshot.screen.assetIds = [...new Set([...root.querySelectorAll('img,svg image')].filter(media =>
      visible(media, true) && (!media.ownerSVGElement || visible(media.ownerSVGElement, true))).map(media => {
      try {
        const reference = media.tagName.toLowerCase() === 'img' ? (media.currentSrc || media.src)
          : media.getAttribute('href') || media.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
        if (!reference) return null;
        const url = new URL(reference, location.href);
        if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) return null;
        const path = url.pathname.slice(base.pathname.length);
        return /\.(?:webp|png|jpe?g|svg)$/.test(path) && release.assets.some(asset => asset.path === path) ? path : null;
      } catch { return null; }
    }).filter(Boolean))].slice(0, 12);
    // Read only named current/revealed scalars. Never serialize whole model state.
    if (current.module === 'camp' && window.FraudCampInteraction) {
      const state = window.FraudCampInteraction.getSnapshot();
      snapshot.screen.sceneId = state.sceneId;
      snapshot.screen.stepId = state.nodeId;
      snapshot.parameters = { timeline: state.ownerTimeline, appliedMinutes: state.appliedMinutes };
      snapshot.recentActions = state.lastPath.slice(-12).map(id => ({ action: '本次已顯示移動路徑', target: id }));
    } else if (current.module === 'T02' && window.FraudPlanInteraction) {
      const state = window.FraudPlanInteraction.getSnapshot();
      snapshot.screen.stepId = model.t02StepId(state);
      snapshot.parameters = { timeline: state.timeline };
    } else if (current.module === 'prototype' && window.FraudInteractiveDemo) {
      const id = window.FraudInteractiveDemo.getActiveGame();
      const state = window.FraudInteractiveDemo.getSnapshot(id);
      if (state) {
        snapshot.screen.sceneId = id;
        snapshot.screen.stepId = id + '/step-index/' + state.logicalStep;
        const piece = typeof state.selectedPiece === 'string' ? state.pieces?.[state.selectedPiece] : null;
        snapshot.parameters = { logicalStep: state.logicalStep, resultCount: state.resultCount, awardedReward: state.awardedReward,
          selectedJob: typeof state.selectedJob === 'string' ? state.selectedJob : null,
          selectedPiece: typeof state.selectedPiece === 'string' ? state.selectedPiece : null,
          selectedTicket: typeof state.selectedTicket === 'string' ? state.selectedTicket : null,
          selectedPieceRotation: typeof piece === 'number' ? piece : typeof piece?.rotation === 'number' ? piece.rotation : null }; 
        snapshot.game.day = state.clock.day;
        snapshot.game.time = state.clock.time;
        snapshot.game.scope = 'prototype-local';
        snapshot.game.uninitialized = snapshot.game.uninitialized.filter(k => k !== 'day' && k !== 'time');
      }
    } else if (current.module === 'archive' && current.origin) {
      snapshot.screen.sceneId = current.origin.sceneId;
      snapshot.screen.stepId = current.origin.stepId;
    } else if (current.module === 'archive' && current.id === 'newGameplayDemo') {
      snapshot.screen.sceneId = root.dataset.candidateId || null;
      snapshot.screen.stepId = root.dataset.frameId || null;
      // This is the rendered proposal, not the independently selected interactive game.
    } else if (current.module === 'legacy' && root.dataset.proposalContext) {
      try {
        const context = JSON.parse(root.dataset.proposalContext);
        snapshot.screen.sceneId = typeof context.sceneId === 'string' ? context.sceneId : null;
        snapshot.screen.stepId = typeof context.stepId === 'string' ? context.stepId : null;
        if (Number.isInteger(context.rank) && context.rank >= 1 && context.rank <= 5) {
          snapshot.game.rank = context.rank;
          snapshot.game.scope = 'configured-demo-context';
          snapshot.game.uninitialized = snapshot.game.uninitialized.filter(k => k !== 'rank');
        }
      } catch { /* Leave unavailable fields explicit, never manufacture a value. */ }
    }
    return snapshot;
  }

  function update() {
    const sending = draft.phase === 'sending';
    const locked = Boolean(draft.payload);
    category.value = draft.category;
    description.value = draft.description;
    category.disabled = locked;
    description.readOnly = locked;
    sender.disabled = sending || draft.phase === 'saved';
    closer.disabled = sending;
    closer.textContent = draft.phase === 'saved' ? '關閉' : '取消，保留草稿';
    sender.textContent = sending ? '正在私人保存…' : draft.phase === 'failed' ? '以同一編號重試' : '私人送出';
    status.textContent = draft.phase === 'saved' ? '已由伺服器私人保存。回報編號：' + draft.receipt.id
      : draft.error || (locked ? '重試沿用本次內容與編號，不重新擷取或重複建立。' : '尚未送出；不會改變遊戲進度、時鐘或數值。');
    host.querySelector('[data-report="capture-time"]').textContent = '快照固定於：' + draft.snapshot.capturedAt + '。不是送出時重新擷取；未初始化或未取得值以 null 與清單明列。';
    host.querySelector('[data-report="preview"]').textContent = JSON.stringify(draft.snapshot, null, 2);
  }

  function openReport() {
    if (!release) return;
    if (!draft || draft.phase === 'saved') draft = model.create(capture(), crypto.randomUUID());
    update();
    dialog.showModal();
    description.focus();
  }
  opener.addEventListener('click', openReport);
  function rememberModalSource(sourceDialog) {
    modalOrigins.delete(sourceDialog);
    if (!sourceDialog.open || sourceDialog.id !== 'newGameplayImageDialog') return;
    const viewer = document.getElementById('newGameplayDemo');
    const inlineImage = document.getElementById('newGameplayImage');
    const expandedImage = sourceDialog.querySelector('img');
    if (viewer && inlineImage && expandedImage && inlineImage.src === expandedImage.src) {
      modalOrigins.set(sourceDialog, Object.freeze({ sceneId: viewer.dataset.candidateId || null, stepId: viewer.dataset.frameId || null }));
    }
  }
  function bindModalEntries() {
    document.querySelectorAll('dialog').forEach(sourceDialog => {
      if (sourceDialog === dialog) return;
      let entry = sourceDialog.querySelector('[data-demo-report-modal]');
      if (!entry) {
        entry = document.createElement('button');
        entry.type = 'button';
        entry.textContent = '回報此畫面';
        entry.className = 'demo-report-modal-entry';
        entry.setAttribute('data-demo-report-modal', '');
        entry.setAttribute('data-demo-only', '');
        entry.addEventListener('click', openReport);
        (sourceDialog.querySelector('.dialog-bar') || sourceDialog).append(entry);
      }
      entry.disabled = !release;
    });
  }
  const modalObserver = new MutationObserver(records => {
    if (records.every(record => host.contains(record.target))) return;
    records.forEach(record => {
      if (record.type === 'attributes' && record.attributeName === 'open' && record.target !== dialog) rememberModalSource(record.target);
    });
    bindModalEntries();
  });
  modalObserver.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['open'] });
  bindModalEntries();
  function edit() { draft = model.edit(draft, category.value, description.value); status.textContent = draft.error; }
  category.addEventListener('change', edit);
  description.addEventListener('input', edit);
  closer.addEventListener('click', () => { if (draft.phase !== 'sending') dialog.close(); });
  dialog.addEventListener('keydown', event => event.stopPropagation());
  dialog.addEventListener('cancel', event => { event.stopPropagation(); if (draft.phase === 'sending') event.preventDefault(); });
  host.querySelector('form').addEventListener('submit', async event => {
    event.preventDefault();
    event.stopPropagation();
    if (!draft || draft.phase === 'sending' || draft.phase === 'saved') return;
    draft = model.begin(draft);
    update();
    if (draft.phase !== 'sending') return;
    try {
      const response = await fetch('/api/fraud-empire/demo/reports', { method: 'POST', credentials: 'omit',
        cache: 'no-store', redirect: 'error', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(draft.payload) });
      if (!response.ok) throw new Error('not_saved');
      draft = model.saved(draft, await response.json());
    } catch { draft = model.fail(draft); }
    update();
  });
  window.FraudDemoFeedback = Object.freeze({ getDraft: () => draft ? model.clone(draft) : null });
  fetch('release.json', { credentials: 'omit', cache: 'no-store' }).then(response => {
    if (!response.ok) throw new Error('release_unavailable');
    return response.json();
  }).then(data => {
    if (typeof data.version !== 'string' || !/^[a-f0-9]{64}$/.test(data.contentHash) || !Array.isArray(data.assets)) throw new Error('invalid_release');
    release = data;
    opener.disabled = false;
    bindModalEntries();
  }).catch(() => { opener.textContent = '回報暫不可用，請重新載入'; });
})();
