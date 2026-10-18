/* global document, window, fetch, performance */
(() => {
  'use strict';
  const main = document.querySelector('main');
  if (!main || document.getElementById('demo')) return;
  const root = document.createElement('section');
  root.id = 'demo';
  root.className = 'section shell demo-section';
  root.setAttribute('aria-labelledby', 'demoTitle');
  root.innerHTML = '<header class="demo-intro"><div><span class="demo-kicker">DESIGN IN MOTION / v4</span><h2 id="demoTitle">走進企劃裡的園區</h2><p>用同一批美術，讀懂場景、對話與任務的連接方式。</p></div><button type="button" id="demoEnter">進入靜態 Demo</button></header><div class="demo-warning"><strong>靜態互動示意，非正式遊戲</strong><p id="demoNotice">正在載入展示資料。</p></div><div class="demo-toolbar"><button type="button" id="demoRead">返回完整企劃閱讀</button><button type="button" id="demoReset">重設 Demo</button></div><div id="demoStage"><p>載入中。完整企劃閱讀不受影響。</p></div><p class="demo-live" id="demoLive" aria-live="polite"></p>';
  main.append(root);
  const nav = document.querySelector('.section-nav');
  if (nav) {
    const link = document.createElement('a');
    link.href = '#demo';
    link.textContent = '靜態 Demo';
    link.addEventListener('click', () => setMode(true));
    nav.append(link);
    nav.addEventListener('click', event => {
      if (event.target.closest('a')?.getAttribute('href') !== '#demo') setMode(false);
    });
  }
  let plan;
  let config;
  let epoch = 0;
  let lockedUntil = 0;
  let state = initialState();
  function initialState() {
    return { view: 'map', scene: 'M01', mode: '靜態', rank: 1, supervisorContext: 'opening', count: 3, topic: null, step: 0, origin: 'assignment', group: 'main', record: 0, frame: 0, companion: 'single', choice: null, art: 0, history: [] };
  }
  function setMode(active) {
    document.body.classList.toggle('demo-mode', active);
    document.getElementById('demoEnter').textContent = active ? 'Demo 模式中' : '進入靜態 Demo';
  }
  function enter() {
    setMode(true);
    window.location.hash = 'demo';
    root.scrollIntoView({ block: 'start' });
  }
  document.getElementById('demoEnter').addEventListener('click', enter);
  document.getElementById('demoRead').addEventListener('click', () => {
    setMode(false);
    window.location.hash = 'reader';
    document.getElementById('reader')?.scrollIntoView({ block: 'start' });
  });
  document.getElementById('demoReset').addEventListener('click', () => {
    state = initialState();
    lockedUntil = 0;
    if (plan) render();
    document.dispatchEvent(new CustomEvent('fraud:demo-reset'));
    document.getElementById('demoLive').textContent = 'Demo 已重設；未建立或刪除任何正式遊戲存檔。';
  });
  window.addEventListener('hashchange', () => setMode(window.location.hash === '#demo'));
  setMode(window.location.hash === '#demo');
  const stage = document.getElementById('demoStage');
  function el(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }
  function text(value) {
    if (value === undefined || value === null) return '';
    if (Array.isArray(value)) return value.map(text).join('\n');
    if (typeof value === 'object') return Object.entries(value).map(([key, val]) => `${key}：${text(val)}`).join('\n');
    return String(value);
  }
  function button(label, action, value, primary = false) {
    const node = el('button', label, primary ? 'demo-primary' : '');
    node.type = 'button';
    node.dataset.action = action;
    node.dataset.epoch = String(epoch);
    if (value !== undefined) node.dataset.value = String(value);
    return node;
  }
  function field(panel, title, value) {
    if (!text(value)) return;
    const item = el('div', undefined, 'demo-field');
    item.append(el('h4', title), el('p', text(value)));
    panel.append(item);
  }
  function select(panel, title, items, selected, action) {
    const label = el('label', title, 'demo-select-label');
    const input = el('select');
    input.setAttribute('aria-label', title);
    input.dataset.action = action;
    input.dataset.epoch = String(epoch);
    for (const item of items) {
      const option = el('option', item.label);
      option.value = item.value;
      input.append(option);
    }
    input.value = String(selected);
    panel.append(label, input);
  }
  function figure(id) { return plan.figures.find(item => item.id === id && !item.pendingReplacement); }
  function showImage(canvas, caption, item, hotspots = []) {
    canvas.replaceChildren();
    if (!item) {
      canvas.append(el('p', '此情境美術尚未補齊，先保留文字設計。', 'demo-empty'));
      caption.textContent = '未交付，不以其他日期的畫面冒充。';
      return;
    }
    const image = el('img');
    image.src = item.src;
    image.alt = `${item.id}｜${item.title}，AI 設計示意`;
    image.width = item.width;
    image.height = item.height;
    image.decoding = 'async';
    image.addEventListener('error', () => {
      if (!canvas.contains(image)) return;
      canvas.replaceChildren(el('p', '這張美術未能載入，請返回再試。沒有扣除任何進度或資源。', 'demo-empty'));
    }, { once: true });
    canvas.append(image);
    caption.textContent = `${item.id}｜${item.title}。完整原圖呈現；畫內按鈕是原稿，請使用下方 Demo 控制。`;
    for (const hotspot of hotspots) {
      const hit = button(hotspot.label, 'hotspot', hotspot.id);
      hit.classList.add('demo-hotspot');
      hit.style.left = `${hotspot.position[0] / 390 * 100}%`;
      hit.style.top = `${hotspot.position[1] / 844 * 100}%`;
      canvas.append(hit);
    }
  }
  function records() {
    const n = plan.narrative;
    return { main: n.main_events, branch: n.branches, romance: n.romance_events, escape: n.escape_sequence.steps, endings: n.endings, intel: n.intel, items: n.items }[state.group] || [];
  }
  function currentTopic() { return plan.topics.find(item => item.id === state.topic); }
  function isPrologue(topic) { return topic.content_class === 'main_story_prologue'; }
  function matchingFigures(record) {
    return plan.figures.filter(item => !item.pendingReplacement && (item.id === record.id || item.id.startsWith(`${record.id}-`)));
  }
  function transition(view, values = {}) {
    state.history.push({ ...state, history: [] });
    Object.assign(state, { view }, values);
    render(true);
  }
  function render(focus = false) {
    epoch += 1;
    stage.replaceChildren();
    const tabs = el('div', undefined, 'demo-tabs');
    for (const [label, action, value] of [['園區場景', 'map', 'M01'], ['派工流程', 'dispatch', ''], ['16 玩法＋1 序章', 'topic-overview', ''], ['主管語氣', 'supervisor', ''], ['劇情與伴侶', 'story', 'main'], ['結局預覽', 'story', 'endings'], ['全部既有美術', 'art', '']]) {
      tabs.append(button(label, action, value));
    }
    stage.append(tabs);
    const layout = el('div', undefined, 'demo-layout');
    const visual = el('figure', undefined, 'demo-visual');
    const canvas = el('div', undefined, 'demo-canvas');
    const caption = el('figcaption', undefined, 'demo-image-note');
    visual.append(el('p', '靜態互動示意，非正式遊戲', 'demo-badge'), canvas, caption);
    const panel = el('div', undefined, 'demo-panel');
    panel.dataset.view = state.view;
    panel.append(el('span', '指定情境預覽 · 非連續遊戲日', 'demo-badge'), el('p', '畫面內日期／職階依該張原稿；切換情境不代表遊戲時間推進。未實作正式數值、碰撞、影片、存檔或獎勵。', 'demo-context'));
    const heading = el('h3');
    heading.tabIndex = -1;
    panel.append(heading);
    const scene = plan.maps.scenes.find(item => item.scene_id === state.scene) || plan.maps.scenes[0];
    if (state.view === 'map') {
      heading.textContent = `${scene.scene_id} · ${scene.name}`;
      const art = plan.figures.find(item => item.src === scene.visual);
      showImage(canvas, caption, art, scene.hotspots);
      select(panel, '切換指定場景（不推進日期）', plan.maps.scenes.map(item => ({ value: item.scene_id, label: `${item.scene_id} · ${item.name}` })), scene.scene_id, 'scene');
      field(panel, '進入條件 · 僅供設計閱讀，Demo 不冒充已解鎖', scene.unlock_rule);
      field(panel, '操作方式', '點畫面上的綠色熱點，或使用下列同名按鈕。先走近，再讀取對話或該物件的設計條件；不會自動發放道具。');
      const actions = el('div', undefined, 'demo-actions');
      for (const spot of scene.hotspots) actions.append(button(spot.label, 'hotspot', spot.id));
      if (scene.scene_id === 'M01') actions.append(button('前往辦公區', 'map', 'M02', true));
      if (scene.scene_id !== 'M01') actions.append(button('返回園區總覽', 'map', 'M01'));
      panel.append(actions);
    } else if (state.view === 'approach') {
      heading.textContent = '走近之後，再開始對話';
      showImage(canvas, caption, figure('UX02'));
      field(panel, '目前預覽', '辦公區 → 主管派工熱點。這是接近與互動的畫面串接，不含自由移動、碰撞或正式遊戲條件運算。');
      panel.append(button('開始主管對話', 'conversation', '', true));
    } else if (state.view === 'conversation') {
      heading.textContent = '主管對話 · 派工前';
      showImage(canvas, caption, figure('MS02-A') || figure('UX19'));
      field(panel, '原稿對話節拍', plan.narrative.main_events.find(item => item.id === 'MS02')?.dialogue_beats);
      field(panel, '尚未補齊', config.extensionStatus);
      panel.append(button('查看主管指定模式', 'dispatch', '', true));
    } else if (state.view === 'supervisor') {
      heading.textContent = `R${state.rank} · ${state.rank === 1 ? '阿猴' : '林若晴'}的態度漸進`;
      showImage(canvas, caption, figure('UX19'));
      select(panel, '主管職階提案預覽（不提交升階）', [1, 2, 3, 4, 5].map(value => ({ value: String(value), label: `R${value} · ${value === 1 ? '阿猴' : '林若晴'}` })), state.rank, 'rank');
      select(panel, '主管日常語氣情境（獨立片段）', Object.entries({ opening: '開場', assignment: '派工', selection: '選任務', success: '成功後評語', failure: '失敗後評語', rest: '休息', chat: '閒聊', promotion: '入階回應' }).map(([value, label]) => ({ value, label })), state.supervisorContext, 'supervisor-context');
      field(panel, '不是新增遊戲條件', config.rankToneStatus);
      field(panel, '原情境優先', '成功與失敗先有原任務結果，重大傷亡與揭露保持嚴肅；本頁不自動判定結果、不追加費用、不取得好感或戀愛資格。R1入階是入職基線，不是虛構晉升。原圖不是各階專屬的新畫面。');
      panel.append(button('回主管派工情境', 'dispatch', '', true));
    } else if (state.view === 'dispatch') {
      heading.textContent = `本輪主管指定：${state.mode}`;
      showImage(canvas, caption, figure({ 靜態: 'UX11', 動態: 'UX12', 出差: 'UX13' }[state.mode]));
      field(panel, '既有流程', '正式設計由主管先指定一種模式，玩家再從智慧決定的 3–5 個任務選一項。下列切換只是不同派工情境的展示，不是讓玩家改掉主管命令。');
      select(panel, '指定情境範例 · 主管模式', ['靜態', '動態', '出差'].map(value => ({ value, label: value })), state.mode, 'mode');
      select(panel, '指定職階情境（不改原圖日期或原有開放條件）', [1, 2, 3, 4, 5].map(value => ({ value: String(value), label: `R${value} · ${value === 1 ? '阿猴' : '林若晴'}` })), state.rank, 'rank');
      field(panel, '主管語氣漸進接點', config.rankToneStatus || '職階語氣資料待接入；不自行編寫台詞。原圖仍是既有指定情境，不冒充每階主管專屬畫面。');
      select(panel, '指定情境範例 · 任務選項數', [3, 4, 5].map(value => ({ value: String(value), label: `${value} 選 1（智慧對應數值待實作）` })), state.count, 'count');
      panel.append(button(`查看 ${state.count} 個候選任務`, 'tasks', '', true));
    } else if (state.view === 'tasks') {
      heading.textContent = `${state.mode} · ${state.count} 選 1`;
      showImage(canvas, caption, figure({ 3: 'UX14', 4: 'UX15', 5: 'UX16' }[state.count]));
      field(panel, '圖文邊界', '任務名單由現有資料選取；各任務七步圖是其已交付的代表模式。若和本次指定模式不同，會明示切換為代表模式預覽，不假裝已有另一套圖。');
      const options = plan.topics.filter(item => !isPrologue(item) && item.supervisor_pool_eligible !== false && item.available_modes.includes(state.mode)).slice(0, state.count);
      const list = el('div', undefined, 'demo-choice-grid');
      for (const topic of options) {
        const item = button(`${topic.id} · ${topic.name}`, 'topic', topic.id);
        item.append(el('small', `已交付代表模式：${topic.mode} · ${topic.steps.length} 步圖文`));
        list.append(item);
      }
      panel.append(list);
      field(panel, '不是全部內容的自由任務板', '這裡只有主管指定模式下的 3–5 個候選任務；T02是主線序章，不進任何模式候選。上方「16 玩法＋1 序章」是獨立設計目錄，不是本輪派工。');
    } else if (state.view === 'topic-overview') {
      heading.textContent = '16 玩法＋1 主線序章 · 舊版分類';
      showImage(canvas, caption, figure('UX07'));
      field(panel, '與遊戲派工分開', '保留17組舊ID、119段圖文：16個玩法分類112步，另有T02主線序章7段。這是既有分類修正，不是未來17個新小遊戲的上限或定案；T16等原故事例外仍保留，不宣稱16項全部可反覆派發。');
      const prologue = plan.topics.find(isPrologue);
      if (prologue) { panel.append(el('h4', '主線序章 · 只讀回顧不重發資源'), button(`${prologue.id} · ${prologue.name}／七段序章`, 'preview-topic', prologue.id)); field(panel, '首次時間與劇情銜接仍待確認', plan.prologue.pending); }
      panel.append(el('h4', '既有16個玩法分類（提案）'));
      const list = el('div', undefined, 'demo-choice-grid');
      for (const topic of plan.topics.filter(item => !isPrologue(item))) {
        const item = button(`${topic.id} · ${topic.name}`, 'preview-topic', topic.id);
        item.append(el('small', `${topic.mode}代表情境 · ${topic.steps.length} 步完整圖文`));
        list.append(item);
      }
      panel.append(list);
    } else if (state.view === 'task') {
      const topic = currentTopic();
      const step = topic.steps[state.step];
      heading.textContent = `${step.id} · ${step.title}`;
      showImage(canvas, caption, figure(step.id));
      panel.append(el('p', isPrologue(topic) ? '主線序章／未報到情境。保留原T02追溯ID；不是主管工作，不把受困做成分數。只讀回顧不改時間、物品、關係或資源。首次20分鐘與到場日期仍為待確認舊提案。' : `${state.origin === 'overview' ? '玩法總覽獨立預覽' : `主管指定：${state.mode}`}／本段代表圖：${topic.mode}。${state.mode !== topic.mode ? '本段已切換為獨立代表模式預覽，另一模式美術尚未補齊。' : '本段只示意圖文與操作節點。'}`, 'demo-mode-note'));
      field(panel, '本步操作設計 · 非真正玩法運算', step.instruction || step.action);
      if (step.action !== step.instruction) field(panel, '操作細節', step.action);
      field(panel, '操作前可見狀態', step.visible_before);
      field(panel, '達成條件', step.success_check);
      field(panel, '原稿可見回饋', step.feedback);
      field(panel, '操作後結果', step.visible_after);
      field(panel, '失敗與恢復設計', step.failure_recovery);
      if (topic.id === 'T17') field(panel, '影片題特別說明', '影片承載判讀證據，尚未交付影片。這裡只能讀步驟，不能把下一張當成答對或略過即完成；兩次重判及簡報備案依原規則，網路重載不自動算錯。');
      if (topic.id === 'T04') field(panel, '結局回看界線', '正式設計中，回看另一結局不改本局已提交選擇，也不再發獎勵；本 Demo 沒有提交正式遊戲選擇。');
      const progress = el('div', undefined, 'demo-progress');
      topic.steps.forEach((item, index) => {
        const node = button(`${index + 1} · ${item.title}`, 'step', index);
        node.classList.add('demo-step');
        node.setAttribute('aria-pressed', String(index === state.step));
        progress.append(node);
      });
      panel.append(progress);
      const actions = el('div', undefined, 'demo-toolbar');
      if (state.step > 0) actions.append(button('上一步畫面', 'step', state.step - 1));
      actions.append(state.step < topic.steps.length - 1 ? button('下一步畫面', 'step', state.step + 1, true) : button(isPrologue(topic) ? '查看序章收束／回顧' : '查看結果示意', 'result', '', true));
      panel.append(actions);
    } else if (state.view === 'result') {
      const topic = currentTopic();
      heading.textContent = `${topic.id} · ${isPrologue(topic) ? '主線序章收束／只讀回顧' : '結果示意'}`;
      showImage(canvas, caption, figure(topic.steps[topic.steps.length - 1].id));
      field(panel, isPrologue(topic) ? '舊稿完成條件／安置用字待整合' : '完成條件設計', topic.win_condition);
      field(panel, '失敗條件設計', topic.fail_condition);
      field(panel, '本 Demo 實際結果', '僅完成圖文瀏覽。未產生遊戲業績、培養點、經驗、金錢、會員或存檔；重複查看沒有可領取的獎勵。');
      panel.append(button('返回園區', 'map', 'M01', true), button(isPrologue(topic) ? '回看主線序章' : '回看本玩法', 'step', 0));
    } else if (state.view === 'hotspot') {
      const spot = scene.hotspots.find(item => item.id === state.hotspot);
      heading.textContent = `${scene.name} · ${spot?.label || '熱點'}`;
      showImage(canvas, caption, plan.figures.find(item => item.src === scene.visual));
      field(panel, '熱點類型', spot?.kind);
      field(panel, '來源與獲得條件', spot?.acquisition?.map(item => `${item.registry_name}：${item.prerequisite}\n${item.screen_flow}`));
      field(panel, '展示範圍', '已走近指定熱點；這裡讀取設計內容，不判定解鎖、不產生道具，不會自動觸發不符合條件的劇情。');
      const availableEvents = plan.narrative.main_events.filter(item => item.scene_id === scene.scene_id);
      for (const record of availableEvents) panel.append(button(`情境預覽：${record.title}`, 'main-record', record.id));
      for (const acquisition of spot?.acquisition || []) panel.append(button(`取得對話預覽：${acquisition.registry_name}（不發放）`, 'registry-record', acquisition.registry_id));
      panel.append(button('返回此場景', 'map', scene.scene_id, true));
    } else if (state.view === 'story') {
      const groupLabels = { main: '主線', branch: '支線', romance: '伴侶／友情', escape: '逃離流程', endings: '結局分鏡', intel: '情報取得', items: '道具取得' };
      const list = records();
      const record = list[state.record] || list[0];
      heading.textContent = `${record.id} · ${record.title || record.name || groupLabels[state.group]}`;
      select(panel, '劇情類別 · 各自指定情境，不冒充同一天', Object.entries(groupLabels).map(([value, label]) => ({ value, label })), state.group, 'group');
      select(panel, '指定劇情', list.map((item, index) => ({ value: String(index), label: `${item.id} · ${item.title || groupLabels[state.group]}` })), state.record, 'record');
      let images = matchingFigures(record);
      if (state.group === 'endings' || state.group === 'escape') {
        select(panel, '自願同行的獨立情境預覽（不替 NPC 同意）', [{ value: 'single', label: '單人' }, { value: 'xiaoyu', label: '小雨已自願同行的情境' }, { value: 'lin', label: '若晴已自願同行的情境' }], state.companion, 'companion');
        const suffix = state.companion === 'single' ? 'SINGLE' : state.companion.toUpperCase();
        if (state.group === 'endings') images = images.filter(item => item.id.includes('-' + suffix + '-'));
        else if (record.id === 'ESC-S05') images = images.filter(item => item.id === 'ESC-S05-' + (state.companion === 'single' ? 'SOLO' : suffix));
        else field(panel, '同行狀態不由載入或畫面重設', `目前仍是${{ single: '單人', xiaoyu: '小雨自願同行', lin: '若晴自願同行' }[state.companion]}情境。此步使用既有共用示意，未交付的專屬圖／短片不冒稱完成。`);
      }
      if (state.frame >= images.length) state.frame = 0;
      showImage(canvas, caption, images[state.frame]);
      field(panel, '對話／分鏡／操作', record.dialogue_beats || record.dialogue_and_actions || record.instruction || record.shots);
      field(panel, '原稿結果設計', record.consequence || record.feedback || record.outcome);
      field(panel, '恢復與回看', record.failure_recovery || record.miss_recovery);
      field(panel, '用途與取得設計', record.use || record.acquisition);
      if (record.id === 'ESC-S08') field(panel, '勝利提交界線', '正式遊戲由上車確認提交勝利，片尾播完不是門檻。本頁只展示該情境，不產生勝利存檔；影片、離線恢復尚未實作。');
      if (record.choices) {
        const choices = el('div', undefined, 'demo-actions');
        for (const choice of record.choices) choices.append(button(`預覽選項：${choice}`, 'choice', choice));
        panel.append(choices);
      }
      if (state.choice) field(panel, '本次預覽選項', `${state.choice}。只在本頁顯示，不提交正式遊戲選擇、不重發任何收益。`);
      if (images.length > 1) select(panel, '此事件既有畫面／分支（獨立預覽）', images.map((item, index) => ({ value: String(index), label: `${item.id} · ${item.title}` })), state.frame, 'frame');
      const controls = el('div', undefined, 'demo-toolbar');
      if (state.record > 0) controls.append(button('上一情境', 'record', state.record - 1));
      if (state.record < list.length - 1) controls.append(button('下一情境', 'record', state.record + 1, true));
      controls.append(button('返回園區', 'map', 'M01'));
      panel.append(controls);
      field(panel, '待補齊', config.extensionStatus);
    } else if (state.view === 'art') {
      const images = plan.figures.filter(item => !item.pendingReplacement);
      const art = images[state.art] || images[0];
      heading.textContent = '全部既有 AI 美術';
      showImage(canvas, caption, art);
      field(panel, '實際交付', `${plan.uniqueImageCount} 張不重複美術、${images.length} 個圖位可逐張查看。相同美術可能用於不同圖位，不能把圖位數當作獨立原圖數。`);
      select(panel, '依圖位選擇完整畫面', images.map((item, index) => ({ value: String(index), label: `${item.id} · ${item.title}` })), state.art, 'art-index');
      const controls = el('div', undefined, 'demo-toolbar');
      if (state.art > 0) controls.append(button('上一張', 'art-index', state.art - 1));
      if (state.art < images.length - 1) controls.append(button('下一張', 'art-index', state.art + 1, true));
      panel.append(controls);
      field(panel, '尚未補齊', config.completion);
    }
    const back = el('div', undefined, 'demo-toolbar');
    if (state.history.length) back.append(button('返回上個畫面', 'back'));
    panel.append(back);
    layout.append(visual, panel);
    stage.append(layout);
    const currentRecord = state.view === 'story' ? records()[state.record] : null;
    const context = { view: state.view, sceneId: state.scene, mode: state.mode, rank: state.rank, supervisorContext: state.supervisorContext, topicId: state.topic, stepId: state.view === 'task' ? currentTopic().steps[state.step].id : null, eventId: currentRecord?.id || (state.view === 'conversation' ? 'MS02' : null), group: state.group, companion: state.companion };
    root.dataset.proposalContext = JSON.stringify(context);
    document.dispatchEvent(new CustomEvent('fraud:demo-context', { detail: context }));
    if (focus) {
      heading.focus({ preventScroll: true });
      layout.scrollIntoView({ block: 'start' });
    }
  }
  function action(name, value) {
    if (name === 'back') {
      const previous = state.history.pop();
      if (previous) state = { ...previous, history: state.history };
      render(true);
    } else if (name === 'map' || name === 'scene') transition('map', { scene: value });
    else if (name === 'hotspot') {
      const scene = plan.maps.scenes.find(item => item.scene_id === state.scene);
      const spot = scene?.hotspots.find(item => item.id === value);
      if (!spot) return;
      if (value === 'M02-H01') transition('approach');
      else if (spot.target_scene && plan.maps.scenes.some(item => item.scene_id === spot.target_scene)) transition('map', { scene: spot.target_scene });
      else transition('hotspot', { hotspot: value });
    } else if (name === 'conversation' || name === 'dispatch' || name === 'tasks' || name === 'result' || name === 'topic-overview' || name === 'supervisor') transition(name);
    else if (name === 'mode') { state.mode = value; render(); }
    else if (name === 'rank') { state.rank = Math.max(1, Math.min(5, Number(value))); render(); }
    else if (name === 'supervisor-context') { state.supervisorContext = value; render(); }
    else if (name === 'count') { state.count = Math.min(5, Math.max(3, Number(value))); render(); }
    else if (name === 'topic') { const topic = plan.topics.find(item => item.id === value); if (topic && !isPrologue(topic) && topic.supervisor_pool_eligible !== false) transition('task', { topic: value, step: 0, origin: 'assignment' }); }
    else if (name === 'preview-topic') transition('task', { topic: value, mode: plan.topics.find(item => item.id === value).mode || state.mode, step: 0, origin: 'overview' });
    else if (name === 'step') { state.step = Math.min(currentTopic().steps.length - 1, Math.max(0, Number(value))); state.view = 'task'; render(true); }
    else if (name === 'story' || name === 'group') transition('story', { group: value, record: 0, frame: 0, choice: null });
    else if (name === 'record') { state.record = Math.max(0, Math.min(records().length - 1, Number(value))); state.frame = 0; state.choice = null; render(true); }
    else if (name === 'frame') { state.frame = Math.max(0, Number(value)); render(); }
    else if (name === 'companion') { state.companion = value; state.frame = 0; render(); }
    else if (name === 'choice') { state.choice = value; render(); }
    else if (name === 'main-record') transition('story', { group: 'main', record: plan.narrative.main_events.findIndex(item => item.id === value), frame: 0, choice: null });
    else if (name === 'registry-record') { const group = value.startsWith('IT') ? 'items' : 'intel'; const list = group === 'items' ? plan.narrative.items : plan.narrative.intel; const index = list.findIndex(item => item.id === value); if (index >= 0) transition('story', { group, record: index, frame: 0, choice: null }); }
    else if (name === 'art') transition('art', { art: 0 });
    else if (name === 'art-index') { state.art = Math.max(0, Number(value)); render(); }
  }
  stage.addEventListener('click', event => {
    const target = event.target.closest('button[data-action]');
    if (!target || !stage.contains(target) || target.dataset.epoch !== String(epoch) || performance.now() < lockedUntil) return;
    lockedUntil = performance.now() + 220;
    action(target.dataset.action, target.dataset.value);
  });
  stage.addEventListener('change', event => {
    const target = event.target.closest('select[data-action]');
    if (!target || !stage.contains(target) || target.dataset.epoch !== String(epoch)) return;
    action(target.dataset.action, target.value);
  });
  document.addEventListener('fraud:demo-navigate', event => {
    if (!plan) return;
    const ref = event.detail?.sourceId;
    if (typeof ref !== 'string') return;
    enter();
    const supervisor = ref.match(/^SUP-R([1-5])-(opening|assignment|selection|success|failure|rest|chat|promotion)$/);
    if (supervisor) { transition('supervisor', { rank: Number(supervisor[1]), supervisorContext: supervisor[2] }); return; }
    const topic = plan.topics.find(item => item.id === ref || item.steps.some(step => step.id === ref));
    if (topic) { transition(event.detail.view === 'result' ? 'result' : 'task', { topic: topic.id, step: Math.max(0, topic.steps.findIndex(step => step.id === ref)), mode: topic.mode || state.mode, origin: 'overview' }); return; }
    for (const [group, list] of Object.entries({ main: plan.narrative.main_events, branch: plan.narrative.branches, romance: plan.narrative.romance_events, escape: plan.narrative.escape_sequence.steps, endings: plan.narrative.endings, intel: plan.narrative.intel, items: plan.narrative.items })) {
      const index = list.findIndex(item => item.id === ref);
      if (index >= 0) { transition('story', { group, record: index, frame: 0, companion: event.detail.companion || state.companion, choice: null }); return; }
    }
    const scene = plan.maps.scenes.find(item => item.scene_id === ref || item.scene_id + '-OVERVIEW' === ref);
    if (scene) { transition('map', { scene: scene.scene_id }); return; }
    const image = plan.figures.findIndex(item => item.id === ref);
    if (image >= 0) transition('art', { art: image });
  });
  Promise.all([fetch('plan.json').then(response => {
    if (!response.ok) throw new Error('plan-unavailable');
    return response.json();
  }), fetch('demo-data.json').then(response => {
    if (!response.ok) throw new Error('demo-unavailable');
    return response.json();
  })]).then(([data, display]) => {
    plan = data;
    config = display;
    document.getElementById('demoNotice').textContent = `${config.notice} ${config.completion}`;
    render();
  }).catch(() => {
    stage.replaceChildren(el('p', 'Demo 資料暫時無法載入。請返回完整企劃閱讀，或重新整理再試。'));
    document.getElementById('demoNotice').textContent = '靜態 Demo 未能載入；未建立正式遊戲進度。';
  });
})();
