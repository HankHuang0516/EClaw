/* global document, window, fetch, Event, CustomEvent, performance */
(() => {
  'use strict';
  const model = globalThis.FraudProposalModel;
  if (!model) {
    document.documentElement.dataset.proposalsReady = 'false';
    document.documentElement.dataset.proposalsError = 'model-unavailable';
    const target = document.getElementById('art-overview') || document.querySelector('main');
    if (target) { const message = document.createElement('p'); message.id = 'proposalLoadFailure'; message.className = 'proposal-empty'; message.setAttribute('role', 'alert'); message.textContent = '增補展示模型未能載入，請重新整理。核心企劃仍保留，不用空白頁冒稱已接入。'; target.append(message); }
    return;
  }
  const $ = id => document.getElementById(id);
  const el = (tag, text, cls) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; return n; };
  const button = (text, action, cls) => { const n = el('button', text, cls); n.type = 'button'; n.addEventListener('click', action); return n; };
  const change = node => node.dispatchEvent(new Event('change', { bubbles: true }));
  let bundle, art, plan, index;
  const talkStates = new Map();
  let revealed = false;
  let galleryRevealed = false;
  let currentContext = null;
  let speechEpoch = 0;
  let speechLockedUntil = 0;
  const bookState = { entry: 'MS01', query: '', kind: 'all', speaker: 'all', page: 0, global: false };
  let sourceLineOwners = new Map();
  const kindNames = { main: '主線', branch: '支線', romance: '關係', ending_variant: '結局變體', intel_acquisition: '情報取得', item_acquisition: '道具取得', gameplay_step: '玩法逐步', gameplay_result: '玩法結果／回顧', prologue_step: '主線序章逐段', prologue_result: '主線序章收束／回顧', supervisor: '主管職階語氣', pending: '待確認' };
  const section = el('section', undefined, 'section shell proposal-section');
  section.id = 'dialogues';
  section.innerHTML = '<div class="section-heading"><div><p class="eyebrow">DIALOGUE / THE PROPOSED VOICES</p><h2>把每一句，放回它的情境。</h2></div><p>完整新增對話提案；角色台詞與系統提示分開，不修改既有規則。</p></div><div class="proposal-note">全部新增台詞與表情均待確認。互斥時間線、照片與回答分別預覽，不把它們連成同一天；閱讀與回顧不提交遊戲選擇或獎勵。</div><div id="dialogueSummary" class="proposal-summary"></div><div id="dialogueControls" class="proposal-controls"></div><div class="proposal-actions" id="dialogueModes"></div><p id="dialogueCount" aria-live="polite" tabindex="-1"></p><div id="dialogueBody"></div>';
  $('story').after(section);
  const navLink = el('a', '完整對話');
  navLink.href = '#dialogues';
  document.querySelector('.section-nav')?.insertBefore(navLink, document.querySelector('.section-nav a[href="#art-overview"]'));
  function select(parent, title, options, value, callback, id) {
    const label = el('label', title, 'proposal-label');
    const input = el('select');
    if (id) input.id = id;
    input.setAttribute('aria-label', title);
    options.forEach(item => { const option = el('option', item.label); option.value = item.value; input.append(option); });
    input.value = String(value ?? '');
    input.addEventListener('change', () => callback(input.value));
    label.append(input); parent.append(label); return input;
  }
  function note(parent, value, cls = 'proposal-condition') { if (model.asText(value)) parent.append(el('p', model.asText(value), cls)); }
  function summary(parent, values) { parent.replaceChildren(); for (const [number, name] of values) { const item = el('span', name); item.prepend(el('b', String(number))); parent.append(item); } }
  function sourceButtons(parent, source, entry) {
    const actions = el('div', undefined, 'proposal-actions');
    actions.append(button('返回來源企劃／逐步畫面', () => toSource(source)));
    const referenceItem = art.items.find(item => item.source_id === source);
    if (!source?.startsWith('ART-CHAR-') && !source?.startsWith('REF-CHAR') && !referenceItem?.image_ids?.some(id => id.startsWith('REF-CHAR'))) actions.append(button('在靜態 Demo 預覽此情境', () => {
      const detail = { sourceId: source };
      if (entry?.kind === 'ending_variant') detail.companion = entry.id.split('__')[1];
      if (entry?.kind?.endsWith('_result')) detail.view = 'result';
      if (entry?.kind === 'pending') detail.sourceId = entry.structure.source_steps?.[0] || source;
      document.dispatchEvent(new CustomEvent('fraud:demo-navigate', { detail }));
    }));
    parent.append(actions);
  }
  function toSource(source) {
    if (source?.startsWith('SUP-R')) { const rules = $('supervisorRules'); if (rules) { rules.open = true; window.location.hash = 'supervisorRules'; rules.scrollIntoView({ block: 'start' }); } return; }
    if (source?.startsWith('ART-CHAR-')) { $('chapterTabs').querySelector('[data-chapter="0"]')?.click(); window.location.hash = 'reader'; $('reader').scrollIntoView({ block: 'start' }); return; }
    if (/^(?:MS\d+|BR\d+|ROM\d+|IT\d+|I\d+|ESC-S\d+)-/.test(source || '')) source = source.match(/^(?:MS\d+|BR\d+|ROM\d+|IT\d+|I\d+|ESC-S\d+)/)[0];
    if (/^E_(BOSS|ESCAPE)[-_]/.test(source || '')) source = source.startsWith('E_BOSS') ? 'E_BOSS' : 'E_ESCAPE';
    const topic = plan.topics.findIndex(t => t.id === source || t.steps.some(s => s.id === source));
    if (topic >= 0) {
      $('topicSelect').value = String(topic); change($('topicSelect'));
      const step = plan.topics[topic].steps.findIndex(s => s.id === source);
      if (step >= 0) $('stepTabs').querySelector(`[data-step="${step}"]`)?.click();
      window.location.hash = 'topics'; $('topics').scrollIntoView({ block: 'start' }); return;
    }
    const types = [['main_events', plan.narrative.main_events], ['branches', plan.narrative.branches], ['romance_events', plan.narrative.romance_events], ['escape', plan.narrative.escape_sequence.steps], ['endings', plan.narrative.endings], ['intel', plan.narrative.intel], ['items', plan.narrative.items]];
    for (const [type, list] of types) if (list.some(r => r.id === source)) {
      $('storySearch').value = ''; $('storyType').value = type; change($('storyType'));
      [...$('storyList').querySelectorAll('button')].find(b => b.dataset.record === source)?.click();
      window.location.hash = 'story'; $('story').scrollIntoView({ block: 'start' }); return;
    }
    const scene = plan.maps.scenes.findIndex(s => s.scene_id === source || source === s.scene_id + '-OVERVIEW');
    if (scene >= 0) { $('sceneSelect').value = String(scene); change($('sceneSelect')); window.location.hash = 'maps'; return; }
    if (source?.startsWith('REF-CHAR') || art.items.find(item => item.source_id === source)?.image_ids?.some(id => id.startsWith('REF-CHAR'))) { $('chapterTabs').querySelector('[data-chapter="0"]')?.click(); window.location.hash = 'reader'; return; }
    $('galleryGroup').value = 'all'; change($('galleryGroup')); $('gallerySearch').value = source || ''; $('gallerySearch').dispatchEvent(new Event('input', { bubbles: true })); window.location.hash = 'gallery';
  }
  function showSpeaker(id) {
    bookState.speaker = id; bookState.query = ''; bookState.kind = 'all'; bookState.global = true; bookState.page = 0;
    renderControls(); renderBook(); window.location.hash = 'dialogues'; section.scrollIntoView({ block: 'start' });
  }
  function showPortrait(id) { $('portraitIdentity').value = id; renderPortrait(id); window.location.hash = 'portraits'; $('portraits').scrollIntoView({ block: 'start' }); }
  function lineCard(line, options = {}) {
    const decision = model.portraitFor(art.portraits, line.speaker_id, line.expression, { revealed: options.revealed ?? revealed });
    const card = el('article', undefined, 'proposal-line' + (line.speaker_id === 'system' ? ' is-system' : line.speaker_id === 'narrator' ? ' is-narrator' : ''));
    card.dataset.lineId = line.stable_id;
    if (decision.kind === 'image') {
      const face = el('div', undefined, 'proposal-portrait');
      const image = el('img'); image.src = decision.cell.src; image.alt = `${decision.name}／${decision.cell.label}，表情提案`; image.width = decision.cell.width; image.height = decision.cell.height; image.loading = 'lazy';
      face.append(image, el('small', '表情提案')); card.append(face);
    }
    const copy = el('div', undefined, 'proposal-line-copy');
    copy.append(el('strong', decision.name + (line.speaker_id === 'system' || line.speaker_id === 'narrator' ? '' : ' · ' + ({ neutral: '平靜', smile: '微笑', angry: '生氣', surprised: '驚訝', sad: '難過', afraid: '害怕', suspicious: '懷疑', determined: '堅定' }[line.expression] || line.expression)), 'proposal-line-name'), el('p', line.text, 'proposal-line-text'));
    if (decision.reason) note(copy, decision.reason, 'proposal-source');
    const trace = el('details'); trace.append(el('summary', '逐句編號與適用說明'), el('p', line.stable_id, 'proposal-source'));
    if (line.trigger) note(trace, line.trigger, 'proposal-source');
    if (decision.person) trace.append(button('查看此身份的表情提案', () => showPortrait(decision.person.id)));
    if (!options.compact) { const entry = sourceLineOwners.get(line.stable_id); if (entry) trace.append(button('放回完整對話情境', () => openEntry(entry.id))); }
    copy.append(trace); card.append(copy); return card;
  }
  function renderControls() {
    const controls = $('dialogueControls'); controls.replaceChildren();
    const searchLabel = el('label', '搜尋台詞、人物或逐句編號'); const input = el('input'); input.type = 'search'; input.id = 'dialogueSearch'; input.placeholder = '例如 IT01、明信片、若晴'; input.value = bookState.query;
    input.addEventListener('input', () => { bookState.query = input.value; bookState.page = 0; renderBook(); }); searchLabel.append(input); controls.append(searchLabel);
    select(controls, '來源類別', [{ value: 'all', label: '所有來源' }, ...Object.entries(kindNames).map(([value, label]) => ({ value, label }))], bookState.kind, value => { bookState.kind = value; bookState.page = 0; renderBook(); }, 'dialogueKind');
    select(controls, '說話者／提示', [{ value: 'all', label: '所有說話者與提示' }, { value: 'system', label: '系統提示（不是角色台詞）' }, { value: 'narrator', label: '旁白' }, ...art.portraits.map(p => ({ value: p.id, label: p.name }))], bookState.speaker, value => { bookState.speaker = value; bookState.page = 0; renderBook(); }, 'dialogueSpeaker');
    select(controls, '完整來源紀錄', bundle.entries.map(e => ({ value: e.id, label: `${e.id} · ${e.title}` })), bookState.entry, value => openEntry(value), 'dialogueEntry');
    const modes = $('dialogueModes'); modes.replaceChildren(button('完整來源情境', () => { bookState.global = false; bookState.query = ''; bookState.speaker = 'all'; bookState.kind = 'all'; renderControls(); renderBook(); }), button('全部逐句索引', () => { bookState.global = true; bookState.page = 0; renderBook(); }));
  }
  function openEntry(id) { bookState.entry = id; bookState.query = ''; bookState.speaker = 'all'; bookState.kind = 'all'; bookState.global = false; bookState.page = 0; renderControls(); renderBook(); window.location.hash = 'dialogues'; }
  function canonicalSpeaker(line) { return art.portraits.find(p => p.id === line.speaker_id || p.aliases.includes(line.speaker_id))?.id || line.speaker_id; }
  function renderBook() {
    const body = $('dialogueBody'); body.replaceChildren();
    const globalMode = bookState.global || bookState.query.trim() || bookState.speaker !== 'all' || bookState.kind !== 'all';
    if (globalMode) {
      const q = bookState.query.trim().toLowerCase();
      const filtered = bundle.lines.filter(line => {
        const owner = sourceLineOwners.get(line.stable_id);
        const name = art.portraits.find(p => p.id === canonicalSpeaker(line))?.name || line.speaker_id;
        return (bookState.speaker === 'all' || canonicalSpeaker(line) === bookState.speaker) && (bookState.kind === 'all' || owner?.kind === bookState.kind) && (!q || `${line.stable_id} ${line.text} ${name} ${owner?.title || ''}`.toLowerCase().includes(q));
      });
      const pages = Math.max(1, Math.ceil(filtered.length / 50)); bookState.page = Math.max(0, Math.min(pages - 1, bookState.page));
      $('dialogueCount').textContent = `共 ${filtered.length} 筆／全部 ${bundle.lineCount} 筆；第 ${bookState.page + 1}／${pages} 頁。不同情境分開讀，不視作同一段連續對話。`;
      for (const line of filtered.slice(bookState.page * 50, bookState.page * 50 + 50)) body.append(lineCard(line));
      if (!filtered.length) note(body, '沒有符合的台詞。未交付內容不會以假台詞補齊。', 'proposal-empty');
      const pager = el('div', undefined, 'proposal-pager');
      const prev = button('上一頁', () => { bookState.page--; renderBook(); $('dialogueCount').focus(); }); prev.disabled = bookState.page === 0;
      const next = button('下一頁', () => { bookState.page++; renderBook(); $('dialogueCount').focus(); }); next.disabled = bookState.page >= pages - 1;
      pager.append(prev, el('span', `${bookState.page + 1} / ${pages}`), next); body.append(pager); return;
    }
    const entry = bundle.entries.find(e => e.id === bookState.entry) || bundle.entries[0];
    const groups = model.groupsFor(entry, index);
    $('dialogueCount').textContent = `${entry.id} · ${groups.reduce((n, g) => n + g.lines.length, 0)} 筆；所有內容是新增提案待確認。`;
    const head = el('div', undefined, 'proposal-entry-head'); head.append(el('span', kindNames[entry.kind] || '來源提案', 'tag'), el('h3', entry.title)); sourceButtons(head, entry.sourceId, entry); body.append(head);
    const rules = el('details', undefined, 'proposal-rules'); rules.append(el('summary', '原條件、互斥情境與待確認事項（不改既有數值）'));
    for (const key of ['conditions', 'trigger', 'context_order', 'photo_variant_note', 'source_variant_policy', 'editorial_notes', 'dialogue_applicability', 'failure_policy', 'submission_policy', 'deferred_variants']) if (entry.structure[key]) note(rules, entry.structure[key]);
    if (entry.structure.source_snapshot?.conditions) note(rules, entry.structure.source_snapshot.conditions);
    body.append(rules);
    const prompts = el('details'); prompts.append(el('summary', '系統提示／條件與恢復，與角色台詞分開'));
    for (const group of groups) { const block = el('div', undefined, 'proposal-group'); block.dataset.groupId = group.id; block.append(el('h4', group.label)); if (group.condition) note(block, group.condition); for (const line of group.lines) block.append(lineCard(line)); (group.system ? prompts : body).append(block); }
    if (prompts.children.length > 1) body.append(prompts);
    for (const item of entry.structure.deferred_variants || []) note(body, `待決策，不提供 Demo 播放：${item.reason}`, 'proposal-alert');
  }
  function humanGroup(group) {
    const id = group.id;
    if (id === 'OV-T02') return '主線序章／假徵才受困（七段，非派工）';
    const direct = { 'OV-CAST-CORE': '主要角色設定參考', 'OV-CAST-SUPPORT': '同伴角色設定參考', 'OV-CAST-INCIDENTAL': '故事角色設定參考', 'OV-ROM-XIAOYU': '小雨的關係故事', 'OV-ROM-LIN': '若晴的關係故事', 'OV-INTEL': '情報與取得', 'OV-ITEMS': '道具與取得', 'OV-ESC-PREP': '逃離準備', 'OV-ESC-STAGE': '逃離舞台', 'OV-ESC-COMPANION': '同行情境', 'OV-UX-HUD': '全域狀態介面', 'OV-UX-COLLECTION': '角色與收藏介面', 'OV-UX-ASSIGNMENT': '主管派工介面', 'OV-UX-COST': '入場成本介面', 'OV-UX-LIFE': '日常生活介面', 'OV-UX-GROWTH': '成長與結算介面', 'OV-UX-RISK': '風險與失敗介面', 'OV-UX-CONSENT': '選擇確認與內容提示' };
    if (direct[id]) return direct[id];
    if (/^OV-BR-\d+$/.test(id)) return '支線故事・第 ' + id.split('-').pop() + ' 組';
    if (/^OV-MAIN-\d+$/.test(id)) return '主線故事・第 ' + id.split('-').pop() + ' 組';
    if (id.startsWith('OV-END-')) return (id.includes('E_BOSS') ? '老闆結局' : '逃離結局') + '・' + ({ SINGLE: '單人', XIAOYU: '小雨', LIN: '若晴' }[id.split('-').pop()]);
    return group.title;
  }
  const artState = { group: 'OV-T01', query: '' };
  function renderArt() {
    const root = $('artOverviewList'); root.className = 'proposal-art-layout proposal-section'; root.replaceChildren();
    const facts = el('div', undefined, 'proposal-summary'); summary(facts, [[283, '來源項目'], [59, '總覽群組'], [319, '情境圖'], [8, '原角色設定卡']]); root.append(facts);
    note(root, '表情示意圖像檢查完成；外觀與表情仍待確認。原角色設定卡、情境圖與表情示意分開計數，不把它們當作可操作、透明或已批准的遊戲素材。', 'proposal-note');
    const controls = el('div', undefined, 'proposal-controls');
    select(controls, '美術總覽群組', art.groups.map(g => ({ value: g.id, label: humanGroup(g) })), artState.group, value => { artState.group = value; artState.query = ''; renderArt(); }, 'artGroupSelect');
    const label = el('label', '搜尋來源項目（跨全部群組）'); const search = el('input'); search.id = 'artItemSearch'; search.type = 'search'; search.value = artState.query; search.placeholder = '題材、圖位或名稱'; search.addEventListener('input', () => { artState.query = search.value; renderArtItems(); }); label.append(search); controls.append(label); root.append(controls, el('div', undefined, 'proposal-art-items')); root.lastElementChild.id = 'artItemList';
    renderArtItems();
    const portraits = el('section', undefined, 'proposal-portraits'); portraits.id = 'portraits'; portraits.append(el('h3', '39 個身份，表情先作提案。')); note(portraits, '35 位人物各 8 格，共 280 格 RGB 表情示意；4 個功能化名共用 1 張合圖，不虛構真人臉。朵娜依原始近方形比例呈現，不拉伸。', 'proposal-note');
    select(portraits, '身份與表情提案', art.portraits.map(p => ({ value: p.id, label: p.name + (p.functional ? '（功能化名）' : '（表情提案）') })), 'protagonist', renderPortrait, 'portraitIdentity'); portraits.append(el('div')); portraits.lastElementChild.id = 'portraitContent'; root.append(portraits); renderPortrait('protagonist');
    const references = el('section', undefined, 'proposal-portraits'); references.id = 'referenceCards'; references.append(el('h3', '八張原角色設定卡'), el('p', '既有設定參考，完整無損展示副本；不是新生成、透明角色精靈或正式外觀批准。老周使用嘴邊香菸修正版。', 'proposal-note'));
    const grid = el('div', undefined, 'proposal-reference-grid');
    for (const reference of art.references) { const figure = el('figure'); const open = button('', () => openAsset(reference.src, reference.id + ' · ' + reference.name + ' · ' + reference.revision)); open.dataset.referenceId = reference.id; const image = el('img'); image.src = reference.src; image.alt = reference.name + '原角色設定卡，完整無損展示'; image.width = reference.width; image.height = reference.height; image.loading = 'lazy'; open.append(image); figure.append(open, el('figcaption', reference.id + ' · ' + reference.name + '／' + reference.revision), button('返回來源企劃', () => toSource(reference.id))); grid.append(figure); }
    references.append(grid); root.append(references);
  }
  function assetTile(id, source) {
    const asset = art.assets[id]; const figure = el('figure');
    if (!asset) { note(figure, id + '：來源圖尚未交付，不建立可開啟資產的假連結。', 'proposal-empty'); return figure; }
    if (asset.type === 'portrait') { figure.append(button('查看表情示意／功能合圖', () => showPortrait(asset.portraitId)), el('figcaption', asset.title)); return figure; }
    const open = button('', () => asset.type === 'reference' ? openAsset(asset.src, asset.title + '／' + asset.revision) : toSource(source || asset.id));
    const image = el('img'); image.src = asset.src; image.alt = asset.title || asset.name; image.width = asset.width; image.height = asset.height; image.loading = 'lazy'; image.decoding = 'async'; open.append(image); figure.append(open, el('figcaption', id + ' · ' + (asset.title || asset.name)));
    figure.append(button(asset.type === 'reference' ? '看完整設定卡' : '回來源企劃／逐步玩法', () => asset.type === 'reference' ? openAsset(asset.src, asset.title) : toSource(source || asset.id)));
    return figure;
  }
  function renderArtItems() {
    const list = $('artItemList'); list.replaceChildren();
    const query = artState.query.trim().toLowerCase();
    const items = art.items.filter(item => query ? `${item.id} ${item.source_id} ${item.title}`.toLowerCase().includes(query) : item.overview_group_id === artState.group);
    list.append(el('p', `顯示 ${items.length} 項／全部 ${art.counts.catalogRecords} 來源項目。用途需求不是新增圖片數量。`, 'proposal-source'));
    for (const item of items) {
      const article = el('article', undefined, 'proposal-art-item'); article.dataset.artSource = item.source_id;
      article.append(el('small', item.source_id || item.id, 'proposal-source'), el('h4', item.title));
      const tags = el('div', undefined, 'proposal-tags'); (item.statuses || []).forEach(status => tags.append(el('span', status))); article.append(tags);
      const images = el('div', undefined, 'proposal-art-images'); for (const id of item.image_ids || []) images.append(assetTile(id, item.source_id)); article.append(images);
      sourceButtons(article, item.source_id);
      const details = el('details', undefined, 'proposal-requirements'); details.append(el('summary', `${item.requirements.length} 項用途需求（不是 ${item.requirements.length} 張圖）`));
      for (const requirement of item.requirements) { const row = el('div', undefined, 'proposal-requirement'); row.append(el('strong', requirement.category + ' · ' + requirement.name)); for (const value of [requirement.purpose, requirement.gap, requirement.status]) note(row, value, ''); details.append(row); }
      article.append(details); list.append(article);
    }
    if (!items.length) note(list, '這個篩選沒有符合項目。來源缺件維持標示，不用其他版本冒充。', 'proposal-empty');
  }
  function renderPortrait(id) {
    const person = art.portraits.find(p => p.id === id); const root = $('portraitContent'); if (!person || !root) return; root.replaceChildren();
    root.append(el('h4', person.name + ' · ' + person.proposalStatus), el('p', person.inspectionStatus, 'proposal-source'));
    if (person.id === 'tang' && !galleryRevealed) { note(root, '唐澄與 H001 是同一個身份。揭露前只用匿名回聲與既有剪影，不在此狀態顯示真人表情。', 'proposal-note'); root.append(button('預覽 MS08 已揭露後的外觀提案', () => { galleryRevealed = true; renderPortrait(id); })); return; }
    if (person.functional) { const reference = person.cells[0]; const image = el('img', undefined, 'proposal-functional'); image.src = reference.src; image.width = reference.width; image.height = reference.height; image.alt = '四個功能化名的完整圖示合圖，未拆分'; root.append(image); note(root, '這是完整合圖，不把 2×2 等分截圖當作四張已拆好圖示；沒有真實身份或人物臉。', 'proposal-alert'); root.append(button('查看完整功能合圖', () => openAsset(reference.src, '功能帳號頭像示意／未拆分合圖')), button('看此身份的提案台詞', () => showSpeaker(person.id))); return; }
    const grid = el('div', undefined, 'proposal-expression-grid');
    for (const cell of person.cells) { const figure = el('figure'); figure.dataset.expression = cell.key; const open = button('', () => showSpeaker(person.id)); const image = el('img'); image.src = cell.src; image.width = cell.width; image.height = cell.height; image.alt = person.name + '／' + cell.label + '，按原比例展示的表情提案'; image.loading = 'lazy'; open.append(image); figure.append(open, el('figcaption', cell.label + ' · 外觀／表情提案待確認'), button('完整表情圖', () => openAsset(cell.src, person.name + '／' + cell.label + '／RGB 表情示意'), 'proposal-full-link')); grid.append(figure); }
    root.append(grid); note(root, person.displayConditions.story_demo, 'proposal-alert'); root.append(button('查看此身份相關對話', () => showSpeaker(person.id)));
    for (const ref of person.references) root.append(button('查看原角色設定卡', () => { const r = art.assets[ref]; openAsset(r.src, ref + ' · ' + person.name); }));
  }
  const dialog = el('dialog', undefined, 'proposal-dialog'); dialog.id = 'proposalAssetDialog'; dialog.innerHTML = '<div class="proposal-dialog-head"><p id="proposalAssetTitle"></p><button type="button" id="proposalAssetClose">關閉完整圖片</button></div><img id="proposalAssetImage" alt=""><p class="proposal-source">完整畫面／原比例，非透明可用遊戲素材。關閉後回原本總覽位置。</p>'; document.body.append(dialog); dialog.setAttribute('aria-labelledby', 'proposalAssetTitle');
  $('proposalAssetClose').addEventListener('click', () => dialog.close()); dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
  function openAsset(src, title) { if (!/^(?:images|portraits|references)\/[a-f0-9]{20}\.webp$/.test(src)) return; $('proposalAssetTitle').textContent = title; $('proposalAssetImage').src = src; $('proposalAssetImage').alt = title + '，完整圖片'; if (!dialog.open) dialog.showModal(); }
  function talkState(entry) { if (!talkStates.has(entry.id)) talkStates.set(entry.id, { position: 0, contextIndex: null, choiceIndex: null, responseVariant: '', photoVariant: '', confirmed: false, repair: false, groupId: '', partner: '', memory: null }); return talkStates.get(entry.id); }
  function mountDialogue(context) {
    currentContext = context;
    const epoch = ++speechEpoch;
    if (!bundle || !art) return;
    const panel = document.querySelector('#demoStage .demo-panel'); if (!panel) return; panel.querySelector('.proposal-widget')?.remove();
    let entry = model.entryForContext(bundle, context);
    if (model.mediaGuard(context)) entry = bundle.entries.find(e => e.kind === 'pending' && e.sourceId === 'T17');
    const root = el('section', undefined, 'proposal-widget'); root.id = 'demoDialogue'; panel.append(root);
    root.append(el('span', '新增對話提案／待確認', 'demo-badge'), el('h4', entry?.title || '此段沿用原稿設計文字'));
    if (!entry) { note(root, '這個場景沒有新增逐句台詞包。保留原圖、原操作與原回饋，不另外編寫台詞或指派說話者。', 'proposal-source'); return; }
    root.dataset.proposalEntry = entry.id;
    if (model.mediaGuard(context)) { note(root, '影片不可用，不是玩家判讀失敗；不扣容錯、不切簡報、不假通關。等價圖文證據尚待確認。這裡只能翻閱設計畫面。', 'proposal-note'); for (const g of model.groupsFor(entry, index, true)) for (const line of g.lines) root.append(lineCard(line, { compact: true })); return; }
    const state = talkState(entry);
    note(root, '指定情境預覽，不把不同日期、職階或互斥回應當作連續遊戲。只瀏覽提案，沒有正式選擇、時間、金錢、物品或獎勵提交。', 'proposal-source');
    if (entry.structure.source_snapshot?.conditions) note(root, entry.structure.source_snapshot.conditions);
    if (context.group === 'endings') note(root, entry.structure.source_variant_policy);
    const update = action => { action(); state.position = 0; mountDialogue(currentContext); };
    if (entry.structure.context_variants?.length) select(root, '互斥時間線 · 必須指定一種情境', [{ value: '', label: '先指定來源情境，不自動混播' }, ...entry.structure.context_variants.map((v, i) => ({ value: String(i), label: v.trigger }))], state.contextIndex ?? '', value => update(() => { state.contextIndex = value === '' ? null : Number(value); state.choiceIndex = null; state.confirmed = false; }));
    if (entry.id === 'BR34') {
      select(root, '親密對象前提情境（不是替他人同意）', [{ value: '', label: '未指定既有自願伴侶' }, { value: 'xiaoyu', label: '小雨是既有伴侶且雙方當下已明確同意' }, { value: 'lin-rest', label: '林若晴僅普通休息陪伴，親密變體待決策' }], state.partner, value => update(() => { state.partner = value; state.choiceIndex = null; state.responseVariant = ''; }));
      note(root, '林若晴親密變體待使用者決策，沒有可播放台詞；普通休息與陪伴保留，不把未來約定當作現有親密資格。', 'proposal-alert');
    }
    const choices = entry.structure.choices || [];
    const controls = el('div', undefined, 'proposal-actions');
    for (let i = 0; i < choices.length; i++) {
      const choice = choices[i]; const control = button(choice.label, () => update(() => { state.memory = model.rememberChoice(state.memory, i); state.choiceIndex = i; state.confirmed = false; state.responseVariant = ''; state.groupId = ''; }), state.choiceIndex === i ? 'proposal-primary' : '');
      control.dataset.proposalChoice = choice.id; control.disabled = Boolean(entry.structure.context_variants?.length && state.contextIndex === null) || (entry.id === 'BR34' && choice.id === 'BR34_C02' && state.partner !== 'xiaoyu'); controls.append(control);
    }
    root.append(controls);
    if (state.memory) note(root, state.memory.replay ? '目前回看另一個選項；本 Demo 首次選擇示意未更改，也沒有再次領取或提交。' : '這是 Demo 內的首次選項示意，不是正式遊戲提交。', 'proposal-source');
    const responses = entry.structure.response_variants || [];
    if (responses.length) select(root, '另一個指定回答情境（不是玩家指定 NPC 意願）', [{ value: '', label: '不加入額外回應變體' }, ...responses.map(v => ({ value: v.id, label: v.presentation_condition || v.id }))], state.responseVariant, value => update(() => { state.responseVariant = value; }));
    if (entry.structure.photo_variants?.length) select(root, '互斥照片情境 · 只選一種', [{ value: '', label: '先指定有／無 IT08，不混播' }, { value: 'has', label: '持有 IT08 的照片情境' }, { value: 'absent', label: '沒有 IT08 的普通車票情境' }], state.photoVariant, value => update(() => { state.photoVariant = value; }));
    if (entry.structure.repair_dialogue?.length) root.append(button(state.repair ? '回到一般對話情境' : '獨立預覽修復對話', () => update(() => { state.repair = !state.repair; })));
    const groups = model.groupsFor(entry, index, true);
    const isStepEntry = /^(?:gameplay|prologue)_/.test(entry.kind);
    if (entry.kind.startsWith('prologue_')) note(root, 'T02 是一次性主線序章，不載入日常主管成功／失敗評語；只讀回顧不結算任何資源。首次時間與主線銜接仍待確認。', 'proposal-note');
    if (entry.kind === 'supervisor') note(root, `R${entry.rank} 的獨立語氣片段，具體措辭待確認。成功／失敗片段僅供設計預覽，不代表本次任務已成功或失敗；重大情境與題材專屬後果仍優先。`, 'proposal-note');
    if (isStepEntry) {
      const options = groups.filter(g => !g.system);
      select(root, '本步台詞適用情境（操作成立才適用，這裡只預覽）', [{ value: '', label: '先選一個操作／結果情境，不判定通關' }, ...options.map(g => ({ value: g.id, label: g.label + (g.condition ? ' · ' + g.condition : '') }))], state.groupId, value => update(() => { state.groupId = value; if (entry.sourceId?.startsWith('T04')) { const chosen = options.find(g => g.id === value); if (chosen) state.memory = model.rememberChoice(state.memory, chosen.choiceId || chosen.id); } }));
    }
    let result = model.queueFor(entry, index, state);
    if (isStepEntry) { const chosen = groups.find(g => g.id === state.groupId); result = { lines: chosen?.lines || [] }; if (chosen?.condition) note(root, chosen.condition); }
    if (result.needsContext) note(root, '先指定一個互斥來源情境；不會同播在場與缺席。', 'proposal-alert');
    if (result.variantConflict) note(root, '這段回應不符合已選選項，只保留來源說明，不把它插入本段。', 'proposal-alert');
    if (result.needsPhoto) note(root, '照片情境尚未指定，先停在照片前，不同播兩種收束。', 'proposal-alert');
    if (result.needsConfirm) root.append(button('確認此設計情境（不提交遊戲）', () => update(() => { state.confirmed = true; })));
    state.position = Math.max(0, Math.min(result.lines.length - 1, state.position));
    const activeLine = result.lines[state.position];
    if (activeLine) root.append(lineCard(activeLine, { compact: true, revealed }));
    else note(root, '請先選擇來源情境；沒有補造台詞、播放影片或判定勝利。', 'proposal-empty');
    const pager = el('div', undefined, 'proposal-pager');
    function move(delta) {
      if (epoch !== speechEpoch || performance.now() < speechLockedUntil) return;
      speechLockedUntil = performance.now() + 220;
      if (entry.id === 'MS08' && state.choiceIndex !== null && activeLine?.stage === 'closing') revealed = true;
      state.position = Math.max(0, Math.min(result.lines.length - 1, state.position + delta)); mountDialogue(currentContext);
    }
    const prev = button('上一句', () => move(-1)); prev.disabled = state.position <= 0;
    const next = button('下一句', () => move(1)); next.disabled = !activeLine || state.position >= result.lines.length - 1;
    pager.append(prev, el('span', result.lines.length ? `${state.position + 1} / ${result.lines.length}` : '情境未指定'), next); root.append(pager);
    if (entry.id === 'MS08' && state.choiceIndex !== null && activeLine?.stage === 'closing') root.append(button('確認已讀 MS08 揭露情境（非正式遊戲旗標）', () => { revealed = true; mountDialogue(currentContext); }));
    if (state.position >= result.lines.length - 1 && result.lines.length) note(root, '本段提案讀完；沒有正式遊戲進度或獎勵。其他變體須另選其來源情境。', 'proposal-source');
    const prompts = el('details'); prompts.append(el('summary', '系統提示／不符合條件／恢復與回顧'));
    for (const group of groups.filter(g => g.system)) for (const line of group.lines) prompts.append(lineCard(line, { compact: true })); root.append(prompts);
    root.append(button('閱讀此來源的全部提案與變體', () => openEntry(entry.id)));
  }
  document.addEventListener('fraud:demo-context', event => mountDialogue(event.detail));
  document.addEventListener('fraud:demo-reset', () => { talkStates.clear(); revealed = false; galleryRevealed = false; speechLockedUntil = 0; if (bundle) { renderBook(); if ($('portraitIdentity')?.value === 'tang') renderPortrait('tang'); } if (currentContext) mountDialogue(currentContext); });
  function renderSupervisorRules() {
    const details = el('details', undefined, 'proposal-rules proposal-section'); details.id = 'supervisorRules';
    details.append(el('summary', '五階主管態度與適用規則（具體台詞仍為提案）'));
    for (const item of bundle.supervisorProgression.characters) { const block = el('div'); block.append(el('h4', `R${item.rank} · ${item.attitude}`)); note(block, item.supervisor_direction); note(block, '主角：' + item.protagonist_direction); details.append(block); }
    for (const value of Object.values(bundle.supervisorProgression.runtimeContract)) note(details, value, 'proposal-source');
    $('dialogueSummary').after(details);
  }
  const planPromise = new Promise((resolve, reject) => { const timer = window.setTimeout(() => reject(new Error('Core reader unavailable')), 30000); document.addEventListener('fraud:plan-ready', event => { window.clearTimeout(timer); resolve(event.detail); }, { once: true }); document.dispatchEvent(new CustomEvent('fraud:request-plan')); });
  Promise.all([planPromise, fetch('dialogue-proposals.json').then(r => { if (!r.ok) throw new Error('Dialogues unavailable'); return r.json(); }), fetch('art-catalog.json').then(r => { if (!r.ok) throw new Error('Art catalogue unavailable'); return r.json(); })]).then(([source, dialogue, catalogue]) => {
    plan = source; bundle = dialogue; art = catalogue; index = model.makeIndex(bundle);
    sourceLineOwners = new Map(); for (const entry of bundle.entries) for (const group of model.groupsFor(entry, index)) for (const line of group.lines) sourceLineOwners.set(line.stable_id, entry);
    if (bundle.lineCount !== 1885 || index.size !== bundle.lineCount || sourceLineOwners.size !== bundle.lineCount) throw new Error('Dialogue coverage mismatch');
    summary($('dialogueSummary'), [[bundle.lineCount, '台詞／提示 ID'], [112, '玩法逐步來源'], [7, '主線序章段落'], [39, '身份（含功能化名）']]); renderSupervisorRules(); renderControls(); renderBook(); renderArt();
    const context = $('demo')?.dataset.proposalContext; if (context) mountDialogue(JSON.parse(context)); document.documentElement.dataset.proposalsReady = 'true';
  }).catch(() => { $('dialogueBody').replaceChildren(el('p', '增補資料暫時無法完整載入，沒有用空白資料冒稱完成。核心企劃與既有 Demo 仍可返回閱讀。', 'proposal-empty')); document.documentElement.dataset.proposalsReady = 'false'; });
})();
