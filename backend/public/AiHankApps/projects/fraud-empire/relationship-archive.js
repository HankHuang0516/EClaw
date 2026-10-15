/* global document, window, fetch, Event */
(() => {
  'use strict';
  const story = document.getElementById('story'), model = globalThis.FraudRelationshipModel;
  if (!story || !model || document.getElementById('relationshipArchive')) return;
  const el = (tag, text, cls) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (cls) node.className = cls; return node; };
  const button = (text, action, key) => { const node = el('button', text); node.type = 'button'; if (key) node.dataset.relKey = key; node.addEventListener('click', action); return node; };
  const fieldNames = { motivation: '動機', buildup: '鋪陳', existing_choices: '沿用的選擇', follow_through: '後續回扣', preserved_boundaries: '保留的界線', status: '來源狀態', story: '故事提案', choices: '選擇', rewards: '獎勵', duration_minutes: '時間', systems_added: '新增系統', canonical: '是否正式採納', existing_event_anchors: '既有來源錨點', proposed_conditions: '僅提案的條件', all: 'ALL／全部', any: 'ANY／至少一項', not: 'NOT／排除', numerical_thresholds: '數值門檻', note: '說明', description: '內容', certainty: '來源確定程度', applicability: '適用情境', spoiler_reveal_gate: '揭露門檻', unknowns: '未定內容', source_scope: '來源範圍', source_flag: '原有旗標', condition: '適用條件', text: '文字', repeat: '重複／回顧規則', recovery: '回復與補救', outcome: '事件原結果（不自動套給每個選項）', story_action: '操作與故事', duration_game_minutes: '原定遊戲分鐘（提案）', delayed_effects: '延後效果', acquisition_instruction: '取得說明', acquisition_note: '取得來源說明', presentation_variants: '既有呈現變體', pending_variants: '未開放變體', relationship_variants: '關係情境變體', condition_text: '完整條件語義', earliest_bound: '日期與職階推導下界', exclusion: '排除與競爭規則', revision_direction: '修訂方向', explanation: '原有歧義', website_integration: '本頁整合狀態', linked_event_ids: '關聯事件', event_ids: '事件編號', question: '待確認問題', alternative: '替代路徑', no_required: '不是必要前置', logical_note: '路徑閱讀提醒', sequence: '閱讀路徑' };
  const root = el('section'); root.id = 'relationshipArchive'; story.querySelector('.story-toolbar').before(root);
  const loading = el('p', '角色關係與支線來源載入中；原企劃及兩款互動原型保留。', 'rel-notice'); loading.setAttribute('role', 'status'); root.append(loading);
  document.documentElement.dataset.relationshipReady = 'loading';
  let data, enrichment, corrections, bundle, index, tree, nodeDetail, eventNav, eventList, eventDetail, footer, nodeInput, eventInput, modeControl, eventCount, more;
  const state = { node: 'protagonist', event: null, spoilers: false, nodeQuery: '', eventQuery: '', onlyNode: true, filter: 'all', limit: 24, timeline: null };
  const groupViews = [], nodeButtons = new Map(), presentationSelections = new Map();
  const dialog = el('dialog'); dialog.id = 'relationshipModeDialog'; document.body.append(dialog);
  let dialogReturn = null;
  const cleanLabel = id => { if (id === 'narrator') return '旁白'; if (id === 'system') return '系統提示'; const node = model.resolve(index, id); return node ? model.label(node, state.spoilers) : id || '來源未指定說話者'; };
  function prose(parent, value, label) {
    if (value == null) { if (label) parent.append(el('p', label + '：來源未定／未列，不推算。', 'rel-muted')); return; }
    const block = el('div', undefined, 'rel-field'); if (label) block.append(el('strong', label));
    if (typeof value !== 'object') block.append(el('p', typeof value === 'boolean' ? value ? '是' : '否' : String(value)));
    else if (Array.isArray(value)) { if (!value.length) block.append(el('p', '未列額外內容。', 'rel-muted')); for (const item of value) { if (typeof item === 'object' && item !== null) prose(block, item); else block.append(el('p', String(item))); } }
    else for (const [key, item] of Object.entries(value)) prose(block, item, fieldNames[key] || key);
    parent.append(block);
  }
  function accordion(parent, title, open = false) { const details = el('details', undefined, 'rel-accordion'); details.open = open; details.append(el('summary', title)); const body = el('div'); details.append(body); parent.append(details); return body; }
  function status(parent, text, warning = false) { parent.append(el('p', text, 'rel-status' + (warning ? ' rel-warning' : ''))); }
  function requestSpoilers() {
    if (state.spoilers) { setSpoilers(false); return; }
    dialogReturn = document.activeElement; dialog.replaceChildren(); const title = el('h3', '開啟含劇透的設計閱讀？'); title.id = 'relationshipModeTitle'; dialog.setAttribute('aria-labelledby', title.id);
    dialog.append(title, el('p', '將揭露匿名身份、阿凱後果、支線與結局條件。這只是本頁設計閱讀，不代表玩家已解鎖，不提交選擇、同意或獎勵。'), button('開啟完整設計圖（含劇透）', () => { dialog.close(); setSpoilers(true); modeControl.focus({ preventScroll: true }); modeControl.scrollIntoView({ block: 'nearest' }); }, 'approve-spoilers'), button('取消，保持無劇透', () => { dialog.close(); (dialogReturn?.isConnected ? dialogReturn : modeControl).focus({ preventScroll: true }); }, 'cancel-spoilers'));
    dialog.showModal();
  }
  dialog.addEventListener('cancel', event => { event.preventDefault(); dialog.close(); (dialogReturn?.isConnected ? dialogReturn : modeControl)?.focus({ preventScroll: true }); });
  function setSpoilers(value) {
    state.spoilers = value; state.nodeQuery = ''; state.eventQuery = ''; state.timeline = null; state.limit = 24; presentationSelections.clear(); nodeInput.value = ''; eventInput.value = '';
    root.dataset.spoilers = String(value); modeControl.textContent = value ? '關閉劇透／恢復匿名' : '完整設計圖（含劇透）'; modeControl.setAttribute('aria-pressed', String(value));
    renderTree(); renderNode(); renderEvents(); renderEvent(); renderFooter();
  }
  function gate(parent) { status(parent, '以下條件、故事與結果含劇透，尚未展開。不會用瀏覽狀態冒充事件已解鎖。'); parent.append(button('明確開啟含劇透設計閱讀', requestSpoilers, 'open-spoilers')); }
  function addFace(parent, node, large = false) {
    const view = model.visibleNode(node, state.spoilers);
    if (view.cell) { const img = el('img', undefined, large ? '' : 'rel-node-image'); img.src = view.cell.src; img.width = view.cell.width; img.height = view.cell.height; img.alt = view.name + '／既有表情提案，外觀未批准'; img.loading = 'lazy'; parent.append(img); }
    else parent.append(el('span', view.anonymous ? 'H001' : view.functional ? '符號' : '人物', 'rel-symbol'));
  }
  function renderTree() {
    for (const item of groupViews) {
      item.summary.textContent = item.group.id === 'hidden_aid' && !state.spoilers ? '匿名聯絡／身份尚未揭露' : item.group.label;
      let visible = 0;
      for (const child of item.group.children) {
        const node = index.nodes.get(child.node_ref), control = nodeButtons.get(node.id), match = model.nodeMatches(node, state.nodeQuery, state.spoilers);
        control.hidden = !match; control.replaceChildren(); addFace(control, node); control.append(el('span', model.label(node, state.spoilers))); control.classList.toggle('is-selected', node.id === state.node); control.setAttribute('aria-pressed', String(node.id === state.node)); control.setAttribute('aria-label', '查看 ' + model.label(node, state.spoilers));
        if (match) visible++;
      }
      item.details.hidden = visible === 0; if (state.nodeQuery && visible) item.details.open = true;
    }
    tree.querySelector('.rel-tree-result').textContent = [...nodeButtons.values()].filter(node => !node.hidden).length + '／39 個唯一身份；分組只是導航，不是家族樹。';
  }
  function selectNode(id) {
    if (!index.nodes.has(id)) return;
    state.node = id; state.event = null; state.timeline = null; state.limit = 24;
    renderTree(); renderNode(); renderEvents(); renderEvent();
    const heading = nodeDetail.querySelector('h4'); heading.tabIndex = -1; heading.focus({ preventScroll: true }); heading.scrollIntoView({ block: 'start' });
  }
  function eventButton(parent, id) {
    const event = data.events[id];
    const text = event ? model.eventLabel(event, state.spoilers) : id + ' · 原逃離逐步來源';
    parent.append(button(text, () => { if (event) selectEvent(id); else coreNavigate(id); }, 'event-' + id));
  }
  function renderNode() {
    const node = index.nodes.get(state.node); nodeDetail.replaceChildren();
    const heading = el('div', undefined, 'rel-person'); addFace(heading, node, true); const copy = el('div'); copy.append(el('p', '唯一身份節點／不是角色複製', 'rel-kicker'), el('h4', model.label(node, state.spoilers))); if (node.age != null) copy.append(el('p', '成年角色／來源年齡 ' + node.age, 'rel-muted')); copy.append(el('p', node.display_note, 'rel-muted')); heading.append(copy); nodeDetail.append(heading);
    if (!state.spoilers) { if (node.id === 'tang') status(nodeDetail, '同一個匿名節點維持 H001；未揭露時不顯示真人表情或真名。'); gate(nodeDetail); return; }
    prose(nodeDetail, node.description, '角色說明'); prose(nodeDetail, node.appearance_note, '關聯不等於當下在場'); prose(accordion(nodeDetail, '出場與揭露界線／原始規則'), node.reveal_policy);
    if (node.entity_type === 'anonymous_account_role') status(nodeDetail, '只標記功能化名；背後真人、外貌及人數未知，不新增真人身份。');
    const edges = model.nodeEdges(index, node.id), body = accordion(nodeDetail, '關係與跨組連結／' + edges.length + ' 條');
    for (const edge of edges) {
      const item = el('article', undefined, 'rel-edge'), other = index.nodes.get(edge.from === node.id ? edge.to : edge.from);
      item.append(el('strong', model.edgeLabel(index, edge, true)), button('轉到 ' + model.label(other, true), () => selectNode(other.id), 'node-' + other.id)); prose(item, edge.applicability, '適用條件'); prose(item, edge.unknowns, '不能臆測的部分');
      const links = el('div', undefined, 'rel-buttons'); for (const eventId of edge.linked_event_ids) eventButton(links, eventId); item.append(links); body.append(item);
    }
    if (node.unknowns?.length) prose(nodeDetail, node.unknowns, '來源未定');
  }
  function selectEvent(id) {
    if (!data.events[id]) return;
    state.event = id; state.timeline = null; renderEvent();
    const heading = eventDetail.querySelector('h4'); heading?.focus({ preventScroll: true }); heading?.scrollIntoView({ block: 'start' });
  }
  function renderEvents() {
    const pool = state.onlyNode ? model.nodeEvents(index, state.node) : Object.values(data.events);
    const matches = pool.filter(event => (state.filter === 'all' || event.id.startsWith(state.filter)) && model.eventMatches(event, state.eventQuery, state.spoilers));
    eventList.replaceChildren(); eventCount.textContent = matches.length + ' 個符合的既有事件／步驟；完整索引 214，BR 36＋ROM 8 保持原狀。';
    for (const event of matches.slice(0, state.limit)) { const control = button('', () => selectEvent(event.id), 'event-' + event.id); control.className = 'rel-event'; control.dataset.relEvent = event.id; control.append(el('small', event.id), el('span', model.eventLabel(event, state.spoilers))); eventList.append(control); }
    if (!matches.length) eventList.append(el('p', '沒有符合的可見資料。無劇透模式不以隱藏真名、未見結果或全文內容搜尋。', 'rel-empty'));
    more.hidden = matches.length <= state.limit; more.textContent = '再顯示 ' + Math.min(24, Math.max(0, matches.length - state.limit)) + ' 個事件';
  }
  function renderLine(parent, line) { const row = el('article', undefined, 'rel-line'); if (line.stable_id) row.dataset.enrichmentLine = line.stable_id; row.append(el('strong', cleanLabel(line.speaker_id)), el('p', line.text), el('small', (line.stable_id ? line.stable_id + '／' : '') + '文字提案，未採納為正式台詞')); parent.append(row); }
  function renderConditional(parent, line) {
    const metadata = line.presentation_variants; if (!metadata) return;
    const body = el('div', undefined, 'rel-timeline'), controls = el('div', undefined, 'rel-buttons'); controls.setAttribute('role', 'group'); controls.setAttribute('aria-label', line.stable_id + ' 文字情境'); controls.dataset.relPresentationGroup = metadata.group; controls.dataset.relLine = line.stable_id;
    const output = el('p', model.variantText(line, presentationSelections.get(metadata.group)) || '先指定明確的既有情境；不自動把各段接成一條時間線。'); output.dataset.relPresentationOutput = 'true';
    const change = value => { presentationSelections.set(metadata.group, value); for (const other of root.querySelectorAll('[data-rel-presentation-group]')) { if (other.dataset.relPresentationGroup !== metadata.group) continue; const source = bundle.lines.find(item => item.stable_id === other.dataset.relLine); other.closest('.rel-timeline').querySelector('[data-rel-presentation-output]').textContent = model.variantText(source, value) || '尚未指定既有情境，不播放。'; for (const control of other.querySelectorAll('[data-rel-variant]')) control.setAttribute('aria-pressed', String(control.dataset.relVariant === value)); } };
    for (const variant of metadata.variants) { const control = button(variant.condition, () => change(variant.id), 'variant-' + line.stable_id + '-' + variant.id); control.dataset.relVariant = variant.id; control.setAttribute('aria-pressed', String(presentationSelections.get(metadata.group) === variant.id)); controls.append(control); }
    controls.append(button('清除情境預覽', () => change(''), 'clear-' + line.stable_id)); body.append(el('strong', line.stable_id), el('p', '依原有旗標選一個文字預覽，不修改旗標。', 'rel-muted'), controls, output); parent.append(body);
  }
  function renderEvent() {
    eventDetail.replaceChildren(); eventDetail.hidden = !state.event; if (!state.event) return;
    const event = data.events[state.event], heading = el('h4', model.eventLabel(event, state.spoilers)); heading.tabIndex = -1; eventDetail.append(heading);
    eventDetail.append(button('收合事件，回到角色關聯', () => { const old = state.event; state.event = null; renderEvent(); const target = [...eventList.querySelectorAll('button')].find(node => node.dataset.relEvent === old); target?.focus({ preventScroll: true }); target?.scrollIntoView({ block: 'center' }); }, 'close-event'));
    if (!state.spoilers) { gate(eventDetail); return; }
    status(eventDetail, '只讀設計提案；瀏覽不是事件完成，不提交選擇、同意、正式條件或任何獎勵。');
    const groups = model.conditionGroups(event), conditions = accordion(eventDetail, '完整前置：ALL／ANY／NOT', true);
    if (groups.sourceOnly) prose(conditions, event.trigger?.condition_text, '依來源取得事件，不新增獨立門檻');
    else { for (const [key, title] of [['all', 'ALL／全部同時成立'], ['any', 'ANY／至少一項成立'], ['not', 'NOT／每項均不得存在']]) { conditions.append(el('h5', title)); if (!groups[key].length) conditions.append(el('p', key === 'any' ? groups.emptyAnyMeans : '沒有列出額外條件。', 'rel-muted')); for (const clause of groups[key]) conditions.append(el('p', clause, 'rel-clause')); } prose(conditions, event.trigger?.condition_text, '完整來源語義'); }
    prose(conditions, event.trigger?.earliest_bound, '只是日期／職階下界，不是保證可玩日'); prose(conditions, event.trigger?.exclusion, '排除與競爭'); status(conditions, '條件只按原文閱讀，不在網站執行 eligibility 或把未知條件算通過。');
    const sourceChoices = event.choices || [], choices = accordion(eventDetail, '選項與各自結果／' + sourceChoices.length + ' 項', true);
    for (const choice of sourceChoices) { const row = el('article', undefined, 'rel-choice'); row.append(el('h5', choice.id + ' · ' + choice.label)); prose(row, model.choiceResult(choice), '只屬這個選項的來源結果'); prose(row, choice.binding_note, '綁定界線'); choices.append(row); }
    if (!sourceChoices.length) choices.append(el('p', '來源沒有列出獨立玩家選項；不自行增加。', 'rel-muted'));
    const results = accordion(eventDetail, '故事、結果、成本與回顧規則', true);
    for (const key of ['story_action', 'outcome', 'repeat', 'recovery', 'duration_game_minutes', 'delayed_effects', 'acquisition_instruction', 'acquisition_note']) if (event[key] != null) prose(results, event[key], fieldNames[key]);
    if (event.id === 'BR34') status(results, '林若晴局內親密變體維持不可播放。普通休息陪伴仍可閱讀，不整段封鎖，也不給親密收益。', true);
    const variants = accordion(eventDetail, '互斥情境與未開放變體');
    if (event.id === 'IT01') {
      status(variants, '阿凱在場與缺席只能選一條閱讀時間線；主人仍是同一個阿凱，不另造角色。');
      const controls = el('div', undefined, 'rel-buttons'); for (const [value, name] of [['present', '阿凱在場時間線'], ['absent', '阿凱缺席時間線']]) { const choose = button(name, () => { state.timeline = value; renderEvent(); eventDetail.querySelector('[data-rel-timeline="' + value + '"]').focus({ preventScroll: true }); }, 'timeline-' + value); choose.dataset.relTimeline = value; choose.setAttribute('aria-pressed', String(state.timeline === value)); controls.append(choose); } variants.append(controls);
      if (state.timeline) for (const line of model.timelineLines(bundle, state.timeline)) { const row = el('article', undefined, 'rel-line'); row.dataset.timelineLine = line.stable_id; row.append(el('strong', cleanLabel(line.speaker_id)), el('p', line.text), el('small', line.stable_id)); variants.append(row); }
      else variants.append(el('p', '尚未選時間線，不把兩段對話自動串接。', 'rel-muted'));
      variants.parentElement.open = true;
    } else prose(variants, event.presentation_variants, '既有變體只按原情境讀取');
    prose(variants, event.pending_variants, '暫停／待確認，不能冒充可玩');
    for (const line of bundle.lines.filter(line => line.source_event === event.id && line.presentation_variants || event.id === 'E_BOSS' && line.stable_id.startsWith('E_BOSS__') && line.presentation_variants)) renderConditional(variants, line);
    if (event.id === 'E_BOSS' || event.id === 'BR30') variants.parentElement.open = true;
    const refs = [...new Set([...(event.prerequisite_event_refs || []), ...(event.acquisition_source_event_ids || [])])], links = accordion(eventDetail, '前置／取得來源與對話關聯', true);
    const related = el('div', undefined, 'rel-buttons'); for (const id of refs) eventButton(related, id); links.append(related);
    const sourceLinks = el('div', undefined, 'rel-buttons'); sourceLinks.append(button('在原企劃定位 ' + event.id, () => coreNavigate(event.id), 'core-' + event.id)); for (const entry of data.dialogue_links[event.id] || []) sourceLinks.append(button('讀取對話：' + entry.title, () => dialogueNavigate(entry.id), 'dialogue-' + entry.id)); links.append(sourceLinks);
    const arcs = enrichment.arcs.filter(arc => arc.event_ids.includes(event.id)), arcBody = accordion(eventDetail, '此事件的角色弧增補／' + arcs.length);
    for (const arc of arcs) renderArc(arcBody, arc, event.id);
    const fixes = corrections.corrections.filter(item => item.event_ids.includes(event.id)), fixesBody = accordion(eventDetail, '本事件的易讀修訂方向／' + fixes.length);
    for (const fix of fixes) renderCorrection(fixesBody, fix);
    const pending = data.pending_design_questions.filter(item => item.event_ids.includes(event.id)); if (pending.length) prose(accordion(eventDetail, '仍待確認，不自行決定', true), pending);
  }
  function renderArc(parent, arc, eventId) {
    const body = accordion(parent, arc.id + ' · ' + arc.title); body.parentElement.dataset.arcId = arc.id; status(body, '文字增補提案／未採納；只讀，不加成本、旗標、獎勵或正式分支。');
    for (const key of ['motivation', 'buildup', 'existing_choices', 'follow_through', 'preserved_boundaries']) prose(body, arc[key], fieldNames[key]);
    for (const scene of arc.scene_extensions.filter(scene => !eventId || scene.event_id === eventId)) { const part = accordion(body, scene.event_id + ' · ' + scene.insertion_point); prose(part, scene.presentation_condition, '本段只適用這個原有情境，不與互斥版本連播'); for (const line of scene.lines) renderLine(part, line); }
  }
  function renderCorrection(parent, correction) { const body = accordion(parent, correction.id + ' · ' + correction.title); body.parentElement.dataset.correctionId = correction.id; for (const key of ['status', 'website_integration', 'explanation', 'revision_direction']) prose(body, correction[key], fieldNames[key]); const links = el('div', undefined, 'rel-buttons'); for (const id of correction.event_ids) eventButton(links, id); body.append(links); }
  function renderFooter() {
    footer.replaceChildren(); footer.append(el('h4', '支線增補與待確認的故事方向'));
    if (!state.spoilers) { status(footer, '10 條角色弧／111 句文字提案、28 項易讀修訂與 3 條未採納新支線；內容含劇透，尚未展開。'); return; }
    const pending = accordion(footer, '先看待確認事項：來源缺口、同意與機制界線', true); prose(pending, data.pending_design_questions); prose(pending, enrichment.decisions_pending, '文字增補仍待決策');
    status(pending, '可達性說明已核對並同步：T13 原有智慧 25 要求需先依學習規則達成。本次只補足說明，不新增智慧門檻、日期保證或其他機制。');
    const paths = accordion(footer, '7 條事件路徑：閱讀導航，不是新的線性前置'); for (const path of data.event_paths) { const body = accordion(paths, path.title); for (const key of ['logical_note', 'alternative', 'no_required']) prose(body, path[key], fieldNames[key]); const links = el('div', undefined, 'rel-buttons'); for (const id of path.sequence) eventButton(links, id); body.append(links); }
    const arcs = accordion(footer, '10 條角色弧／完整 111 句增補提案'); for (const arc of enrichment.arcs) renderArc(arcs, arc);
    const proposed = accordion(footer, '3 條新增支線提案／未進入正式事件池'); for (const branch of enrichment.new_optional_branches) { const body = accordion(proposed, branch.id + ' · ' + branch.title); body.parentElement.dataset.proposedBranch = branch.id; status(body, branch.status, true); for (const key of ['story', 'choices', 'follow_through', 'rewards', 'duration_minutes', 'systems_added', 'proposed_conditions', 'canonical']) prose(body, branch[key], fieldNames[key]); for (const line of branch.sample_dialogue) renderLine(body, line); }
    const fixes = accordion(footer, '28 項既有事件與條件的易讀修訂'); for (const correction of corrections.corrections) renderCorrection(fixes, correction);
    prose(accordion(footer, '8 項不可臆測的關係與身份'), data.unknown_relationships);
    prose(accordion(footer, '原關係閱讀規則'), data.rules);
  }
  function announce(text) { loading.textContent = text; loading.scrollIntoView({ block: 'center' }); }
  function coreNavigate(id) {
    if (!state.spoilers) { requestSpoilers(); return; }
    const link = data.core_links[id]; if (!link) { announce('此來源尚無可定位的原企劃紀錄，未建立假連結。'); return; }
    if (link.type === 'topic') { const select = document.getElementById('topicSelect'); select.value = String(link.topic); select.dispatchEvent(new Event('change', { bubbles: true })); document.querySelector('#topics [data-step="' + link.step + '"]')?.click(); window.location.hash = 'topics'; const heading = document.getElementById('topics').querySelector('h2'); heading.tabIndex = -1; heading.focus({ preventScroll: true }); heading.scrollIntoView({ block: 'start' }); }
    else { const select = document.getElementById('storyType'); select.value = link.type; document.getElementById('storySearch').value = ''; select.dispatchEvent(new Event('change', { bubbles: true })); [...document.querySelectorAll('#storyList [data-record]')].find(node => node.dataset.record === id)?.click(); window.location.hash = 'story'; const target = document.querySelector('#storyContent .record-title') || document.getElementById('storyContent'); target.tabIndex = -1; target.focus({ preventScroll: true }); target.scrollIntoView({ block: 'start' }); }
  }
  function dialogueNavigate(id) {
    if (!state.spoilers) { requestSpoilers(); return; }
    const select = document.getElementById('dialogueEntry'); if (!select || ![...select.options].some(option => option.value === id)) { announce('原台詞目錄尚未就緒，請稍後再試；沒有提交遊戲事件。'); return; }
    select.value = id; select.dispatchEvent(new Event('change', { bubbles: true })); window.location.hash = 'dialogues'; document.getElementById('dialogueEntry').focus({ preventScroll: true }); document.getElementById('dialogues').scrollIntoView({ block: 'start' });
  }
  function mount() {
    root.dataset.spoilers = 'false'; root.replaceChildren(); const head = el('div', undefined, 'rel-head'), copy = el('div'); copy.append(el('p', 'RELATIONSHIP ATLAS / STORY MARGINS', 'rel-kicker'), el('h3', '把人物與另一條路，慢慢展開。')); head.append(copy); modeControl = button('完整設計圖（含劇透）', requestSpoilers, 'spoiler-mode'); modeControl.id = 'relationshipSpoilerMode'; modeControl.setAttribute('aria-pressed', 'false'); head.append(modeControl); root.append(head);
    loading.textContent = data.website_revision.scope + ' 外觀與故事仍是提案，原條件／重複規則保留，瀏覽不給獎勵。'; root.append(loading);
    const counts = el('div', undefined, 'rel-counts'); for (const [number, text] of [[39, '唯一身份'], [55, '關係連線'], [214, '舊事件／步驟'], [44, '既有 BR／ROM'], [111, '新增台詞提案']]) { const item = el('span'); item.append(el('strong', String(number)), el('span', text)); counts.append(item); } root.append(counts);
    const controls = el('div', undefined, 'rel-controls'), searchLabel = el('label', '搜尋可見人物／化名'); nodeInput = el('input'); nodeInput.type = 'search'; nodeInput.id = 'relationshipNodeSearch'; nodeInput.placeholder = '人物姓名，或匿名回聲 H001'; nodeInput.addEventListener('input', () => { state.nodeQuery = nodeInput.value; renderTree(); }); searchLabel.append(nodeInput); controls.append(searchLabel, button('展開全部人物分組', () => { for (const item of groupViews) if (!item.details.hidden) item.details.open = true; }, 'expand-tree'), button('收合人物分組', () => { for (const item of groupViews) item.details.open = false; }, 'collapse-tree')); root.append(controls);
    const layout = el('div', undefined, 'rel-layout'); tree = el('nav', undefined, 'rel-tree'); tree.setAttribute('aria-label', '39 個唯一人物的關係導航'); tree.append(el('p', '', 'rel-tree-result'));
    for (const group of data.navigation_tree.groups) { const details = el('details', undefined, 'rel-group'), summary = el('summary', group.label), leaves = el('div', undefined, 'rel-leaves'); details.dataset.relGroup = group.id; details.open = group.id === 'workplace' && !window.matchMedia('(max-width:760px)').matches; details.append(summary, leaves); for (const child of group.children) { const control = button('', () => selectNode(child.node_ref), 'node-' + child.node_ref); control.className = 'rel-node'; control.dataset.relNode = child.node_ref; nodeButtons.set(child.node_ref, control); leaves.append(control); } tree.append(details); groupViews.push({ group, details, summary }); }
    const detail = el('article', undefined, 'rel-detail'); detail.id = 'relationshipDetail'; nodeDetail = el('div'); eventNav = el('section'); eventNav.append(el('h4', '連動事件、條件與對話'));
    const eventControls = el('div', undefined, 'rel-controls'), eventSearchLabel = el('label', '搜尋本索引事件'); eventInput = el('input'); eventInput.type = 'search'; eventInput.id = 'relationshipEventSearch'; eventInput.placeholder = '事件編號；開劇透後可搜尋標題'; eventInput.addEventListener('input', () => { state.eventQuery = eventInput.value; state.limit = 24; renderEvents(); }); eventSearchLabel.append(eventInput);
    const onlyLabel = el('label', '只看目前角色關聯'), only = el('input'); only.type = 'checkbox'; only.checked = true; only.id = 'relationshipOnlyNode'; only.addEventListener('change', () => { state.onlyNode = only.checked; state.limit = 24; renderEvents(); }); onlyLabel.append(only); eventControls.append(eventSearchLabel, onlyLabel); eventNav.append(eventControls);
    const filters = el('div', undefined, 'rel-buttons'); for (const [value, text] of [['all', '全部'], ['BR', '支線 36'], ['ROM', '關係事件 8'], ['MS', '主線'], ['T', '舊題材／序章來源']]) { const control = button(text, () => { state.filter = value; state.limit = 24; for (const other of filters.children) other.setAttribute('aria-pressed', String(other === control)); renderEvents(); }, 'filter-' + value); control.setAttribute('aria-pressed', String(value === 'all')); control.dataset.relFilter = value; filters.append(control); } eventNav.append(filters);
    eventCount = el('p', '', 'rel-muted'); eventCount.setAttribute('role', 'status'); eventList = el('div', undefined, 'rel-events'); more = button('顯示更多', () => { state.limit += 24; renderEvents(); }, 'more-events'); eventNav.append(eventCount, eventList, more); eventDetail = el('section'); eventDetail.id = 'relationshipEventDetail'; eventDetail.setAttribute('aria-label', '選定事件的完整提案內容'); detail.append(nodeDetail, eventNav, eventDetail); layout.append(tree, detail); root.append(layout); footer = el('div', undefined, 'rel-footer'); root.append(footer);
    for (const id of ['dialogues', 'storyContent']) { const target = id === 'storyContent' ? story.querySelector('.story-toolbar') : document.getElementById(id); if (target && !target.querySelector('[data-relationship-return]')) { const back = el('a', '返回角色關係與支線檔案', 'relationship-return'); back.href = '#relationshipArchive'; back.dataset.relationshipReturn = 'true'; target.prepend(back); } }
    document.getElementById('storyType').addEventListener('change', event => { if (event.target.value === 'relationships') root.scrollIntoView({ block: 'start' }); });
    renderTree(); renderNode(); renderEvents(); renderEvent(); renderFooter();
    window.FraudRelationshipArchive = Object.freeze({ getView: () => ({ ...state, nodeLabel: model.label(index.nodes.get(state.node), state.spoilers), canonicalNodeCount: index.nodes.size, sourceEventCount: index.events.size, formalStateMutation: false }) });
    document.documentElement.dataset.relationshipReady = 'true';
  }
  const get = path => fetch(path).then(response => { if (!response.ok) throw new Error('Relationship source unavailable'); return response.json(); });
  Promise.all([get('relationship-data.json'), get('branch-enrichment-proposals.json'), get('branch-logic-corrections.json'), get('dialogue-proposals.json')]).then(values => {
    [data, enrichment, corrections, bundle] = values; if (!model.validate(data, enrichment, corrections)) throw new Error('Relationship source contract mismatch'); index = model.makeIndex(data); mount();
  }).catch(() => { loading.textContent = '角色關係來源未能完整載入，沒有以空白、假角色或猜測條件冒充完成；原企劃與互動原型仍保留。'; loading.setAttribute('role', 'alert'); document.documentElement.dataset.relationshipReady = 'false'; });
})();
