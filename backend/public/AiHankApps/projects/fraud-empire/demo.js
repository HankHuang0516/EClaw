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
    return { view: 'map', scene: 'M01', mode: '靜態', count: 3, topic: null, step: 0, origin: 'assignment', group: 'main', record: 0, frame: 0, choice: null, art: 0, history: [] };
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
    return { main: n.main_events, branch: n.branches, romance: n.romance_events, escape: n.escape_sequence.steps, endings: n.endings }[state.group] || [];
  }
  function currentTopic() { return plan.topics.find(item => item.id === state.topic); }
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
    for (const [label, action, value] of [['園區場景', 'map', 'M01'], ['派工流程', 'dispatch', ''], ['17 題玩法總覽', 'topic-overview', ''], ['劇情與伴侶', 'story', 'main'], ['結局預覽', 'story', 'endings'], ['全部既有美術', 'art', '']]) {
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
    } else if (state.view === 'dispatch') {
      heading.textContent = `主管指定：${state.mode}`;
      showImage(canvas, caption, figure({ 靜態: 'UX11', 動態: 'UX12', 出差: 'UX13' }[state.mode]));
      field(panel, '既有流程', '正式設計由主管先指定一種模式，玩家再從智慧決定的 3–5 個任務選一項。下列切換只是不同派工情境的展示，不是讓玩家改掉主管命令。');
      select(panel, '指定情境範例 · 主管模式', ['靜態', '動態', '出差'].map(value => ({ value, label: value })), state.mode, 'mode');
      select(panel, '指定情境範例 · 任務選項數', [3, 4, 5].map(value => ({ value: String(value), label: `${value} 選 1（智慧對應數值待實作）` })), state.count, 'count');
      panel.append(button(`查看 ${state.count} 個候選任務`, 'tasks', '', true));
    } else if (state.view === 'tasks') {
      heading.textContent = `${state.mode} · ${state.count} 選 1`;
      showImage(canvas, caption, figure({ 3: 'UX14', 4: 'UX15', 5: 'UX16' }[state.count]));
      field(panel, '圖文邊界', '任務名單由現有資料選取；各任務七步圖是其已交付的代表模式。若和本次指定模式不同，會明示切換為代表模式預覽，不假裝已有另一套圖。');
      const options = plan.topics.filter(item => item.available_modes.includes(state.mode)).slice(0, state.count);
      const list = el('div', undefined, 'demo-choice-grid');
      for (const topic of options) {
        const item = button(`${topic.id} · ${topic.name}`, 'topic', topic.id);
        item.append(el('small', `已交付代表模式：${topic.mode} · ${topic.steps.length} 步圖文`));
        list.append(item);
      }
      panel.append(list);
      field(panel, '不是 17 題全選任務板', '這裡只有主管指定模式下的 3–5 個候選任務。要看其他玩法，請進入上方「17 題玩法總覽」，那是獨立設計預覽，不是本輪派工。');
    } else if (state.view === 'topic-overview') {
      heading.textContent = '17 題玩法總覽 · 獨立預覽';
      showImage(canvas, caption, figure('UX07'));
      field(panel, '與遊戲派工分開', '此處是所有 17 題材、119 步的設計目錄，不是遊戲任務板。選一題後看其已交付代表模式，每一步均可前後翻閱操作、條件與結果。正式派工仍由主管指定模式，再提供 3–5 選 1。');
      const list = el('div', undefined, 'demo-choice-grid');
      for (const topic of plan.topics) {
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
      panel.append(el('p', `${state.origin === 'overview' ? '玩法總覽獨立預覽' : `主管指定：${state.mode}`}／本段代表圖：${topic.mode}。${state.mode !== topic.mode ? '本段已切換為獨立代表模式預覽，另一模式美術尚未補齊。' : '本段只示意圖文與操作節點。'}`, 'demo-mode-note'));
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
      actions.append(state.step < topic.steps.length - 1 ? button('下一步畫面', 'step', state.step + 1, true) : button('查看結果示意', 'result', '', true));
      panel.append(actions);
    } else if (state.view === 'result') {
      const topic = currentTopic();
      heading.textContent = `${topic.id} · 結果示意`;
      showImage(canvas, caption, figure(topic.steps[topic.steps.length - 1].id));
      field(panel, '完成條件設計', topic.win_condition);
      field(panel, '失敗條件設計', topic.fail_condition);
      field(panel, '本 Demo 實際結果', '僅完成圖文瀏覽。未產生遊戲業績、培養點、經驗、金錢、會員或存檔；重複查看沒有可領取的獎勵。');
      panel.append(button('返回園區', 'map', 'M01', true), button('回看本玩法', 'step', 0));
    } else if (state.view === 'hotspot') {
      const spot = scene.hotspots.find(item => item.id === state.hotspot);
      heading.textContent = `${scene.name} · ${spot?.label || '熱點'}`;
      showImage(canvas, caption, plan.figures.find(item => item.src === scene.visual));
      field(panel, '熱點類型', spot?.kind);
      field(panel, '來源與獲得條件', spot?.acquisition?.map(item => `${item.registry_name}：${item.prerequisite}\n${item.screen_flow}`));
      field(panel, '展示範圍', '已走近指定熱點；這裡讀取設計內容，不判定解鎖、不產生道具，不會自動觸發不符合條件的劇情。');
      const availableEvents = plan.narrative.main_events.filter(item => item.scene_id === scene.scene_id);
      for (const record of availableEvents) panel.append(button(`情境預覽：${record.title}`, 'main-record', record.id));
      panel.append(button('返回此場景', 'map', scene.scene_id, true));
    } else if (state.view === 'story') {
      const groupLabels = { main: '主線', branch: '支線', romance: '伴侶／友情', escape: '逃離流程', endings: '結局分鏡' };
      const list = records();
      const record = list[state.record] || list[0];
      heading.textContent = `${record.id} · ${record.title || groupLabels[state.group]}`;
      select(panel, '劇情類別 · 各自指定情境，不冒充同一天', Object.entries(groupLabels).map(([value, label]) => ({ value, label })), state.group, 'group');
      select(panel, '指定劇情', list.map((item, index) => ({ value: String(index), label: `${item.id} · ${item.title || groupLabels[state.group]}` })), state.record, 'record');
      const images = matchingFigures(record);
      if (state.frame >= images.length) state.frame = 0;
      showImage(canvas, caption, images[state.frame]);
      field(panel, '對話／分鏡／操作', record.dialogue_beats || record.dialogue_and_actions || record.instruction || record.shots);
      field(panel, '原稿結果設計', record.consequence || record.feedback || record.outcome);
      field(panel, '恢復與回看', record.failure_recovery || record.miss_recovery);
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
    } else if (name === 'conversation' || name === 'dispatch' || name === 'tasks' || name === 'result' || name === 'topic-overview') transition(name);
    else if (name === 'mode') { state.mode = value; render(); }
    else if (name === 'count') { state.count = Math.min(5, Math.max(3, Number(value))); render(); }
    else if (name === 'topic') transition('task', { topic: value, step: 0, origin: 'assignment' });
    else if (name === 'preview-topic') transition('task', { topic: value, mode: plan.topics.find(item => item.id === value).mode, step: 0, origin: 'overview' });
    else if (name === 'step') { state.step = Math.min(currentTopic().steps.length - 1, Math.max(0, Number(value))); state.view = 'task'; render(true); }
    else if (name === 'story' || name === 'group') transition('story', { group: value, record: 0, frame: 0, choice: null });
    else if (name === 'record') { state.record = Math.max(0, Math.min(records().length - 1, Number(value))); state.frame = 0; state.choice = null; render(true); }
    else if (name === 'frame') { state.frame = Math.max(0, Number(value)); render(); }
    else if (name === 'choice') { state.choice = value; render(); }
    else if (name === 'main-record') transition('story', { group: 'main', record: plan.narrative.main_events.findIndex(item => item.id === value), frame: 0, choice: null });
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
