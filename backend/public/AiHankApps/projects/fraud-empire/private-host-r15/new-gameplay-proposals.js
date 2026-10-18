/* global document, window, fetch */
((root, factory) => {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.FraudNewGameplay = api; api.mount(); }
})(globalThis, () => {
  'use strict';
  function inlineText(value) {
    return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>');
  }
  function markdown(source) {
    const out = []; let paragraph = [], list = [], kind = '';
    const flushParagraph = () => { if (paragraph.length) { out.push('<p>' + inlineText(paragraph.join(' ')) + '</p>'); paragraph = []; } };
    const flushList = () => { if (list.length) { out.push('<' + kind + '>' + list.map(text => '<li>' + inlineText(text) + '</li>').join('') + '</' + kind + '>'); list = []; kind = ''; } };
    for (const raw of source.split(/\r?\n/)) {
      const line = raw.trim();
      const heading = line.match(/^(#{1,3})\s+(.+)$/);
      const item = line.match(/^(?:([-*])\s+|\d+\.\s+)(.+)$/);
      if (!line) { flushParagraph(); flushList(); }
      else if (heading) { flushParagraph(); flushList(); const level = heading[1].length === 3 ? 4 : 3; const id = heading[2].match(/^(MG-P\d{2})\s/); out.push('<h' + level + (id ? ' id="proposal-' + id[1] + '" data-new-candidate="' + id[1] + '"' : '') + '>' + inlineText(heading[2]) + '</h' + level + '>'); }
      else if (item) { flushParagraph(); const next = item[1] ? 'ul' : 'ol'; if (kind && kind !== next) flushList(); kind = next; list.push(item[2]); }
      else { flushList(); paragraph.push(line); }
    }
    flushParagraph(); flushList(); return out.join('\n');
  }
  function validate(data) {
    return data?.schemaVersion === 1 && data.plan?.candidate_count === 17 && data.plan.games?.length === 17 && new Set(data.plan.games.map(game => game.candidate_id)).size === 17 && typeof data.planMarkdown === 'string' && data.demos?.length === 2 && data.demos.every(demo => ['MG-P01', 'MG-P02'].includes(demo.id) && demo.frames?.length === 3 && demo.frames.every((frame, i) => frame.phase === ['before', 'middle', 'result'][i] && /^proposal-demos\/[a-f0-9]{20}\.png$/.test(frame.src) && frame.width === 941 && [1671, 1672].includes(frame.height))) && data.boundaries?.realMechanicsImplemented === false && data.boundaries?.legacyPoolUnchanged === true;
  }
  function previewState(previous, action, demos) {
    const selected = demos.find(demo => demo.id === previous?.candidateId) || demos[0];
    const state = { candidateId: selected.id, frame: Math.max(0, Math.min(selected.frames.length - 1, Number(previous?.frame) || 0)) };
    if (action.type === 'candidate') return { candidateId: (demos.find(demo => demo.id === action.value) || selected).id, frame: 0 };
    if (action.type === 'reset') return { candidateId: selected.id, frame: 0 };
    if (action.type === 'frame') state.frame = Math.max(0, Math.min(selected.frames.length - 1, Number(action.value) || 0));
    if (action.type === 'next') state.frame = Math.min(selected.frames.length - 1, state.frame + 1);
    if (action.type === 'previous') state.frame = Math.max(0, state.frame - 1);
    return state;
  }
  function mount() {
    const root = document.getElementById('demo'), stage = document.getElementById('demoStage');
    if (!root || !stage || document.getElementById('new-gameplay-plans')) return;
    const el = (tag, text, cls) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (cls) node.className = cls; return node; };
    const button = (text, action, cls = '') => { const node = el('button', text, cls); node.type = 'button'; node.addEventListener('click', action); return node; };
    const reader = el('section', undefined, 'section shell new-gameplay-section'); reader.id = 'new-gameplay-plans';
    reader.innerHTML = '<div class="section-heading"><div><p class="eyebrow">NEW GAMEPLAY / PROPOSALS V2</p><h2>十七個新提案，先看清楚再決定。</h2></div><p>完整正文直接閱讀。僅兩款已交六幅示意圖，其餘十五款尚無新圖；沒有把候選加入既有派工池。</p></div><p id="newGameplayLoad" class="proposal-note" role="status">正在載入完整提案與六幅示意。</p><div id="newGameplayLinks" class="new-gameplay-links"></div><article id="newGameplayText" class="new-gameplay-text"></article>';
    document.getElementById('topics').after(reader);
    const nav = el('a', '新17玩法提案'); nav.href = '#new-gameplay-plans'; document.querySelector('.section-nav')?.append(nav);
    const panel = el('section', undefined, 'new-gameplay-demo'); panel.id = 'newGameplayDemo'; panel.hidden = true; stage.after(panel);
    let data, state, entering = false, active = false, coreSeen = Boolean(root.dataset.proposalContext);
    function legacy() { active = false; panel.hidden = true; stage.style.removeProperty('display'); }
    function enter(candidate) {
      if (!data) return;
      if (candidate) state = previewState(state, { type: 'candidate', value: candidate }, data.demos);
      entering = true; document.getElementById('demoEnter').click(); entering = false;
      active = true; stage.style.display = 'none'; panel.hidden = false; render(); panel.scrollIntoView({ block: 'start' });
    }
    function readPlan(candidate) { legacy(); document.getElementById('demoRead').click(); window.location.hash = candidate ? 'proposal-' + candidate : 'new-gameplay-plans'; document.getElementById(candidate ? 'proposal-' + candidate : 'new-gameplay-plans')?.scrollIntoView({ block: 'start' }); }
    const entryButton = button('新玩法六圖預覽', () => enter(), 'demo-primary'); entryButton.id = 'newGameplayEnter'; entryButton.disabled = true; root.querySelector('.demo-toolbar').append(entryButton);
    document.getElementById('demoEnter').addEventListener('click', () => { if (!entering) legacy(); });
    document.getElementById('demoRead').addEventListener('click', legacy);
    document.querySelector('.section-nav')?.addEventListener('click', legacy);
    document.addEventListener('fraud:demo-context', () => { if (!coreSeen) { coreSeen = true; return; } if (!entering) legacy(); });
    document.addEventListener('fraud:demo-reset', () => { if (data) state = { candidateId: data.demos[0].id, frame: 0 }; legacy(); });
    const dialog = el('dialog', undefined, 'new-gameplay-dialog'); dialog.id = 'newGameplayImageDialog';
    const dialogTitle = el('p'), close = button('關閉完整示意圖', () => dialog.close()), fullImage = el('img'); dialogTitle.id = 'newGameplayImageTitle'; dialog.setAttribute('aria-labelledby', dialogTitle.id); dialog.append(dialogTitle, close, fullImage); document.body.append(dialog);
    function change(action) { state = previewState(state, action, data.demos); render(); }
    function field(parent, title, value) { if (!value) return; const block = el('div', undefined, 'new-gameplay-field'); block.append(el('h4', title), el('p', value)); parent.append(block); }
    function render() {
      const demo = data.demos.find(item => item.id === state.candidateId), frame = demo.frames[state.frame], game = data.plan.games.find(item => item.candidate_id === demo.id);
      panel.replaceChildren(); panel.dataset.candidateId = demo.id; panel.dataset.frameId = frame.id;
      const heading = el('div', undefined, 'section-heading'); heading.append(el('h3', '新玩法提案／六幅圖文預覽'), el('p', '保留舊版。不把示意圖當成可玩原型。')); panel.append(heading, el('p', data.notice, 'proposal-note'));
      const selectorLabel = el('label', '選擇已交圖的新玩法', 'new-gameplay-selector'), selector = el('select'); selector.id = 'newGameplayCandidate'; selector.setAttribute('aria-label', '選擇已交圖的新玩法');
      for (const item of data.demos) { const option = el('option', item.id + ' · ' + item.title); option.value = item.id; selector.append(option); } selector.value = demo.id; selector.addEventListener('change', () => change({ type: 'candidate', value: selector.value })); selectorLabel.append(selector); panel.append(selectorLabel);
      const phases = el('nav', undefined, 'new-gameplay-phases'); phases.setAttribute('aria-label', '圖文預覽階段');
      demo.frames.forEach((item, i) => { const control = button(item.phaseLabel, () => change({ type: 'frame', value: i })); control.dataset.newPhase = item.phase; control.setAttribute('aria-pressed', String(i === state.frame)); phases.append(control); }); panel.append(phases);
      const layout = el('div', undefined, 'new-gameplay-layout'), figure = el('figure'), image = el('img'); image.id = 'newGameplayImage'; image.src = frame.src; image.alt = frame.alt; image.width = frame.width; image.height = frame.height; image.decoding = 'async';
      image.addEventListener('error', () => { if (image.isConnected) { const alert = el('p', '此張示意圖未能載入；沒有推進玩法或扣除任何資源，請返回再試。', 'proposal-alert'); alert.setAttribute('role', 'alert'); image.replaceWith(alert); } }, { once: true });
      figure.append(image, el('figcaption', frame.lockedVersion + ' · 完整原圖／圖內按鈕不可操作'), button('看完整大圖', () => { dialogTitle.textContent = frame.lockedVersion + ' · ' + frame.label; fullImage.src = frame.src; fullImage.alt = frame.alt; dialog.showModal(); }));
      const copy = el('div', undefined, 'new-gameplay-copy'); copy.append(el('span', '玩法提案／未實作／未試玩驗收', 'demo-badge'), el('h3', frame.label));
      field(copy, '這張畫面在說什麼', frame.state); field(copy, '玩家在新提案中要做什麼', game.player_one_sentence); field(copy, '圖文與實作的界線', demo.interactionNote); field(copy, '獨立時間示意', demo.clockNote); field(copy, '仍待確認', game.balance_note); field(copy, '提案邊界', game.proposal_boundary);
      const controls = el('div', undefined, 'demo-toolbar'), previous = button('上一張示意', () => change({ type: 'previous' })), next = button('下一張示意', () => change({ type: 'next' }), 'demo-primary'); previous.disabled = state.frame === 0; next.disabled = state.frame === demo.frames.length - 1; controls.append(previous, el('span', (state.frame + 1) + ' / ' + demo.frames.length), next); copy.append(controls);
      const returns = el('div', undefined, 'demo-toolbar'); returns.append(button('重設此款圖文預覽', () => change({ type: 'reset' })), button('返回原有 Demo', () => { legacy(); stage.scrollIntoView({ block: 'start' }); }), button('讀這款完整提案', () => readPlan(demo.id))); copy.append(returns); layout.append(figure, copy); panel.append(layout);
      if (!active) panel.hidden = true;
    }
    document.documentElement.dataset.newGameplayReady = 'loading';
    fetch('new-gameplay-proposals.json').then(response => { if (!response.ok) throw new Error('New proposals unavailable'); return response.json(); }).then(source => {
      if (!validate(source)) throw new Error('Incomplete proposed handoff'); data = source; state = { candidateId: data.demos[0].id, frame: 0 };
      document.getElementById('newGameplayLoad').textContent = data.status + '。這裡可點的是圖文切換，不是圖內玩法；原提案的未實作與待確認狀態維持不變。';
      document.getElementById('newGameplayText').innerHTML = markdown(data.planMarkdown);
      const links = document.getElementById('newGameplayLinks');
      for (const demo of data.demos) links.append(button('看三張示意：' + demo.title, () => enter(demo.id), 'button'));
      const label = el('label', '直接跳到完整提案', 'new-gameplay-selector'), select = el('select'); select.id = 'newGameplayPlanSelect'; select.setAttribute('aria-label', '直接跳到完整提案');
      for (const game of data.plan.games) { const option = el('option', game.candidate_id + ' · ' + game.theme); option.value = game.candidate_id; select.append(option); } select.addEventListener('change', () => readPlan(select.value)); label.append(select); links.append(label);
      const hero = button('看新玩法六張示意', () => enter(), 'button primary'); document.querySelector('.hero-actions')?.prepend(hero); entryButton.disabled = false; render(); document.documentElement.dataset.newGameplayReady = 'true';
    }).catch(() => { document.getElementById('newGameplayLoad').textContent = '新玩法提案暫時未能完整載入，不能以空白資料冒稱交付；原有閱讀與 Demo 仍可使用。'; document.documentElement.dataset.newGameplayReady = 'false'; });
  }
  return { inlineText, markdown, validate, previewState, mount };
});
