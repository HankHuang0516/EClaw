/* This script only presents design documents. It never runs game logic. */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const labels = { id:'編號', title:'名稱', name:'名稱', mode:'代表模式', available_modes:'設計支援模式', wisdom_min:'智慧門檻提案', rank_min:'職階門檻提案', duration_game_minutes:'遊戲分鐘提案', base_score:'基礎分數提案', growth_type:'養成類型', objective:'本局目標', setup:'故事與起始狀態', instruction:'操作指引', action:'本步動作', visible_before:'動作前畫面', visible_after:'動作後畫面', ui_controls:'介面入口', feedback:'可見回饋', success_check:'成功條件', failure_recovery:'失誤與恢復', scene_id:'場景', action_minutes:'行動分鐘提案', illustration_clock:'圖示遊戲時鐘', timed_action:'推進時鐘的動作', action_class:'動作類型', illustration_state:'示意圖狀態', screen_type:'畫面類型', win_condition:'完成條件', fail_condition:'失敗條件', persistence:'長期保留內容', rewards:'收益與獎勵提案', variations:'其他變體', notes:'設計備註', step_action_minutes:'各步遊戲分鐘提案', timing_note:'時間說明', conditions:'前置條件', all:'需同時符合', any:'至少符合其一', not:'不得存在', dialogue_beats:'對話與演出節拍', dialogue_and_actions:'對話與動作', choices:'選項', outcome:'選擇結果', miss_recovery:'錯過與恢復', repeat:'重訪規則', exclusion:'互斥條件', consequence:'故事後果', shots:'結局分鏡', single:'單人版本', xiaoyu:'小雨版本', lin:'林若晴版本', use:'用途', acquisition:'取得方式', recovery:'恢復方式', rules:'共通規則', relationship_effects:'人物關係的影響', escape_sequence:'逃離終局', ending_priority:'結局優先順序', hidden_member:'隱藏會員', adult_tone:'成年題材與內容界線', phone_failsafes:'手機閱讀與恢復規則', risk_state_rules:'風險後果', rank_progression:'職階成長提案', item_registry_scope:'道具登錄範圍', baseline:'關係基礎', consent:'雙方同意', required:'必要條件', optional:'可選支援', time_rule:'時間規則', route_note:'路線說明', alias:'別名', age:'年齡', introduction:'初次登場', affinity:'好感欄位', not_romance:'不是戀愛路線', scope:'設計範圍', rating:'分級狀態說明', allowed_tone:'敘事表現', content_controls:'內容提示與略過', moral_logic:'後果邏輯', rank:'職階', earliest_day:'最早遊戲日', cumulative_rank_exp:'累計職階經驗提案', stamina_cap:'體力上限提案', unlock_rule:'開放條件', default_exit:'返回區域', hotspots:'互動熱點', rooms:'區域配置', nodes:'設計節點', adjacency:'連通關係', canvas:'邏輯畫布', map_bounds:'區域範圍', palette:'色彩參考', visual:'場景圖', initial_state:'圖面說明', story_event_ids:'關聯故事事件', node_id:'站位節點', position:'設計位置', tap_target:'設計點按區', kind:'互動種類', registry_ids:'關聯情報／道具', target_scene:'前往區域', states:'設計狀態', bounds:'設計區域', label:'標示', performance:'完成品質', score_formula:'積分公式提案', cultivation:'培養與職階經驗', fictional_receipts:'虛構入帳說明', dates:'日期口徑', ranks:'職階口徑', values:'參數定義', costs:'成本規則', replay:'回顧規則', endings:'結局規則', safety:'虛構與安全界線', xiaoyu_help:'小雨的自願支援', xiaoyu_complication:'小雨的界線與歧見', lin_help:'林若晴的自願支援', lin_complication:'林若晴的界線與歧見', version:'資料版本', registry_scope:'登錄範圍', coordinate_system:'點位說明', navigation:'設計中的操作方式' };
  let plan;
  const state = { chapter:0, topic:0, step:0, storyType:'main_events', storyId:null, scene:0, hotspot:0, galleryLimit:24, lightbox:0 };
  let galleryFigures = [];
  const figureById = (id) => plan.figures.find((f) => f.id === id);
  const inline = (text) => escape(text).replace(/`([^`]+)`/g,'<code>$1</code>').replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>');
  function markdown(source) {
    const lines = source.replace(/\r/g,'').split('\n'); let out='', paragraph=[], list=null, code=null;
    const flush = () => { if(paragraph.length){out += '<p>'+inline(paragraph.join(' '))+'</p>';paragraph=[];} if(list){out += '</'+list+'>';list=null;} };
    for(let i=0;i<lines.length;i++) {
      const line=lines[i];
      if(line.startsWith('```')){flush();if(code===null)code=[];else{out+='<pre>'+escape(code.join('\n'))+'</pre>';code=null;}continue;}
      if(code!==null){code.push(line);continue;}
      if(!line.trim()){flush();continue;}
      const heading=line.match(/^(#{1,6})\s+(.+)/);
      if(heading){flush();const level=Math.min(4,heading[1].length+1);out+='<h'+level+'>'+inline(heading[2])+'</h'+level+'>';continue;}
      if(line.trim().startsWith('|')){flush();const rows=[];while(i<lines.length&&lines[i].trim().startsWith('|')){const row=lines[i].trim();if(!/^[|:\-\s]+$/.test(row))rows.push(row.replace(/^\||\|$/g,'').split('|'));i++;}i--;out+='<div class="table-wrap"><table>'+rows.map((r,n)=>'<tr>'+r.map(c=>'<'+(n===0?'th':'td')+'>'+inline(c.trim())+'</'+(n===0?'th':'td')+'>').join('')+'</tr>').join('')+'</table></div>';continue;}
      const item=line.match(/^\s*(?:[-*]|\d+[.、])\s+(.+)/);
      if(item){if(paragraph.length){out+='<p>'+inline(paragraph.join(' '))+'</p>';paragraph=[];}if(!list){list='ul';out+='<ul>';}out+='<li>'+inline(item[1])+'</li>';continue;}
      if(list){out+='</'+list+'>';list=null;}paragraph.push(line);
    }
    flush();if(code!==null)out+='<pre>'+escape(code.join('\n'))+'</pre>';return out;
  }
  function value(v) {
    if(v===null||v===undefined)return '<p>未指定</p>';
    if(Array.isArray(v))return v.length?'<ul>'+v.map(x=>'<li>'+value(x)+'</li>').join('')+'</ul>':'<p>無額外項目</p>';
    if(typeof v==='object')return fields(v);
    return '<p>'+inline(typeof v==='boolean'?(v?'是':'否'):v)+'</p>';
  }
  Object.assign(labels,{designAssessment:'玩法設計評估',immersion:'沉浸感',logic:'合理性',status:'確認狀態'});
  function fields(object,skip=[]) {return Object.entries(object).filter(([k])=>!skip.includes(k)).map(([k,v])=>'<div class="field"><h4>'+escape(labels[k]||k.replace(/_/g,' '))+'</h4>'+value(v)+'</div>').join('');}
  function figure(f) {if(!f)return '';if(f.pendingReplacement)return '<figure class="illustration"><p class="empty-state">'+escape(f.id)+' · 此圖待修正，暫不作已完成示意圖展示。</p></figure>';return '<figure class="illustration"><button class="image-open" type="button" data-image="'+escape(f.id)+'" aria-label="放大'+escape(f.title)+'"><img src="'+escape(f.src)+'" width="'+f.width+'" height="'+f.height+'" alt="'+escape(f.title)+'，AI 示意圖" loading="lazy" decoding="async"></button><figcaption>'+escape(f.id)+' · '+escape(f.title)+'<br>AI 示意圖，非可玩成品；點圖完整放大。</figcaption></figure>';}
  function renderChapter() {
    $('chapterTabs').innerHTML=plan.chapters.map((c,i)=>'<button type="button" data-chapter="'+i+'" class="'+(i===state.chapter?'active':'')+'" aria-pressed="'+(i===state.chapter)+'"><small>CHAPTER '+String(i+1).padStart(2,'0')+'</small>'+escape(c.title)+'</button>').join('');
    const c=plan.chapters[state.chapter];$('chapterContent').innerHTML='<div class="chapter-status">'+escape(c.status)+' · 完整正文 · '+plan.version+'</div>'+markdown(c.content_markdown);$('chapterContent').classList.remove('fade-in');void $('chapterContent').offsetWidth;$('chapterContent').classList.add('fade-in');
  }
  function clarifications(ref) {return plan.decisions.filter(d=>(d.references||[]).includes(ref)).map(d=>'<div class="notice"><p><b>'+escape(d.status)+' · '+escape(d.title)+'</b><br>'+escape(d.text)+' <a href="#decisions">查看最新決策</a></p></div>').join('');}
  function renderTopic() {
    const t=plan.topics[state.topic];state.step=Math.min(state.step,t.steps.length-1);const s=t.steps[state.step];
    $('topicIntro').innerHTML='<div class="topic-intro"><p class="eyebrow">'+escape(t.id)+' / 設計提案</p><h3>'+escape(t.name)+'</h3><p>'+escape(t.objective)+'</p><p>'+escape(t.setup)+'</p><div class="tag-row"><span class="tag">代表模式：'+escape(t.content_class==='main_story_prologue'?'主線序章／不進派工':t.mode)+'</span><span class="tag pending">精確成本與收益待確認</span></div></div>'+clarifications(t.id)+(t.content_class==='main_story_prologue'?'<div class="notice"><p>七段一次性主線序章，保留舊ID；不是主管工作。原欄位的安置用字、首次20分鐘與到場日期仍是待確認舊提案；回顧不發任何資源。</p></div>':'');
    $('stepTabs').innerHTML=t.steps.map((x,i)=>'<button type="button" data-step="'+i+'" class="'+(i===state.step?'active':'')+'" aria-label="步驟 '+(i+1)+'：'+escape(x.title)+'" aria-pressed="'+(i===state.step)+'">'+String(i+1).padStart(2,'0')+'</button>').join('');
    $('stepContent').innerHTML=figure(figureById(s.id))+'<article class="step-copy"><p class="eyebrow">'+escape(s.id)+' / 逐步設計說明</p><h3>'+escape(s.title)+'</h3>'+fields(s,['id','title'])+'</article>';
    $('stepCounter').textContent=(state.step+1)+' / '+t.steps.length;$('previousStep').disabled=state.step===0;$('nextStep').disabled=state.step===t.steps.length-1;$('topicDetails').innerHTML=fields(t,['id','name','objective','setup','steps']);
  }
  function storyRecords() {
    if(state.storyType==='escape')return plan.narrative.escape_sequence.steps;
    if(state.storyType==='relationships')return [{id:'RELATIONSHIPS',title:'人物關係與其他敘事規則',...Object.fromEntries(Object.entries(plan.narrative).filter(([k])=>!['version','title','status','main_events','branches','romance_events','endings','intel','items','escape_sequence'].includes(k)))}];
    return plan.narrative[state.storyType]||[];
  }
  function recordTitle(r) {return r.title||r.name||({E_BOSS:'玻璃王座：接任最高位',E_ESCAPE:'走到有警燈的地方'}[r.id])||r.id;}
  function renderStory() {
    const query=$('storySearch').value.trim().toLowerCase();const records=storyRecords().filter(r=>JSON.stringify(r).toLowerCase().includes(query));
    if(!records.some(r=>r.id===state.storyId))state.storyId=records[0]?.id||null;
    $('storyList').innerHTML=records.map(r=>'<button type="button" data-record="'+escape(r.id)+'" class="'+(state.storyId===r.id?'active':'')+'" aria-pressed="'+(state.storyId===r.id)+'"><small>'+escape(r.id)+'</small>'+escape(recordTitle(r))+'</button>').join('');
    const r=records.find(x=>x.id===state.storyId);if(!r){$('storyContent').innerHTML='<p class="empty-state">沒有符合的紀錄。請試試其他人物、名稱或編號。</p>';return;}
    const images=plan.figures.filter(f=>f.id===r.id||f.id.startsWith(r.id+'-'));const unique=[...new Map(images.map(f=>[f.src,f])).values()];
    $('storyContent').innerHTML='<p class="eyebrow">'+escape(r.id)+' / 設計提案，非已實作功能</p><h3 class="record-title">'+escape(recordTitle(r))+'</h3>'+clarifications(r.id)+fields(r,['id','title','name'])+(state.storyType==='escape'?fields(plan.narrative.escape_sequence,['id','title','steps']):'')+'<div class="event-figures">'+unique.map(figure).join('')+'</div>';
  }
  function renderMap() {
    const s=plan.maps.scenes[state.scene];const overview=figureById(s.scene_id+'-OVERVIEW');state.hotspot=Math.min(state.hotspot,s.hotspots.length-1);const h=s.hotspots[state.hotspot];
    $('mapContent').innerHTML='<div class="map-layout">'+figure(overview)+'<article><h3>'+escape(s.name)+'</h3><p class="muted">'+escape(s.unlock_rule)+'</p><p class="eyebrow">點選熱點名稱，閱讀前置與互動結果</p><div class="hotspot-list">'+s.hotspots.map((x,i)=>'<button type="button" data-hotspot="'+i+'" class="'+(i===state.hotspot?'active':'')+'">'+escape(x.label)+'</button>').join('')+'</div><div class="map-detail">'+(h?fields(h):'<p>本場景未列出額外熱點。</p>')+'</div><details class="design-details"><summary>完整區域與連通規格（僅設計閱讀）</summary>'+fields(s,['name','visual','hotspots'])+'</details></article></div>';
  }
  function renderGallery(reset=true) {
    if(reset)state.galleryLimit=24;const group=$('galleryGroup').value;const q=$('gallerySearch').value.trim().toLowerCase();
    const hit=(f)=>group==='all'||(group==='M'?/^M\d/.test(f.id):group==='I'?/^I\d/.test(f.id):f.id.startsWith(group));
    galleryFigures=[...new Map(plan.figures.filter(f=>!f.pendingReplacement&&hit(f)&&(f.id+' '+f.title).toLowerCase().includes(q)).map(f=>[f.src,f])).values()];
    $('galleryCount').textContent='符合 '+galleryFigures.length+' 張 · 目前顯示 '+Math.min(galleryFigures.length,state.galleryLimit)+' 張';
    $('galleryGrid').innerHTML=galleryFigures.slice(0,state.galleryLimit).map(f=>'<figure class="gallery-card"><button type="button" data-image="'+escape(f.id)+'" aria-label="放大'+escape(f.title)+'"><img src="'+escape(f.src)+'" alt="'+escape(f.title)+'，AI 示意圖" loading="lazy" decoding="async" width="'+f.width+'" height="'+f.height+'"></button><figcaption>'+escape(f.title)+'<small>'+escape(f.id)+' · 設計示意</small></figcaption></figure>').join('')||'<p class="empty-state">沒有符合的圖位。</p>';$('galleryMore').hidden=state.galleryLimit>=galleryFigures.length;
  }
  function navigateReference(ref) {
    const topic=plan.topics.findIndex(t=>t.id===ref);if(topic>=0){state.topic=topic;state.step=0;$('topicSelect').value=String(topic);renderTopic();location.hash='topics';return;}
    const type=ref.startsWith('ESC-')?'escape':ref.startsWith('BR')?'branches':ref.startsWith('ROM')?'romance_events':'main_events';state.storyType=type;state.storyId=ref;$('storyType').value=type;$('storySearch').value='';renderStory();location.hash='story';
  }
  function renderDecisions() {
    $('decisionList').innerHTML=plan.decisions.map(d=>'<article class="decision-card"><span class="tag '+(d.status.startsWith('已')?'':'pending')+'">'+escape(d.status)+'</span><h3>'+escape(d.title)+'</h3><p>'+escape(d.text)+'</p><div class="decision-links">'+(d.references||[]).map(r=>'<button type="button" data-reference="'+escape(r)+'">查看 '+escape(r)+' ↗</button>').join('')+'</div><small class="muted">'+escape(d.date)+'</small></article>').join('');
    $('downloadList').innerHTML='<div class="download-grid">'+plan.downloads.map(d=>'<a href="'+escape(d.src)+'" download>'+escape(d.label)+'<small>'+Math.round(d.bytes/1048576)+' MB · 文件備份</small></a>').join('')+'</div>';
    $('artOverviewList').innerHTML=(plan.artOverview||[]).map(a=>'<article class="decision-card"><span class="tag">已有情境示意</span><h3>'+escape(a.title)+'</h3><p>'+escape(a.existing)+'</p><p class="muted">'+escape(a.pending)+'</p><button class="button" type="button" data-gallery-group="'+escape(a.galleryGroup)+'">查看現有情境圖 ↗</button></article>').join('');
  }
  function openImage(id) {const f=figureById(id);if(!f||f.pendingReplacement)return;const list=[...new Map(plan.figures.filter(x=>!x.pendingReplacement).map(x=>[x.src,x])).values()];state.lightbox=list.findIndex(x=>x.src===f.src);showLightbox(list);if(!$('imageDialog').open)$('imageDialog').showModal();}
  function showLightbox(list) {const f=list[state.lightbox];$('dialogTitle').textContent=f.id+' · '+f.title;$('dialogImage').src=f.src;$('dialogImage').alt=f.title+'，完整 AI 示意圖';$('previousImage').disabled=state.lightbox===0;$('nextImage').disabled=state.lightbox===list.length-1;}
  function moveLightbox(offset) {const list=[...new Map(plan.figures.filter(x=>!x.pendingReplacement).map(x=>[x.src,x])).values()];state.lightbox=Math.max(0,Math.min(list.length-1,state.lightbox+offset));showLightbox(list);}
  function bind() {
    document.addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;if(b.dataset.chapter!==undefined){state.chapter=Number(b.dataset.chapter);renderChapter();}if(b.dataset.step!==undefined){state.step=Number(b.dataset.step);renderTopic();}if(b.dataset.record){state.storyId=b.dataset.record;renderStory();}if(b.dataset.hotspot!==undefined){state.hotspot=Number(b.dataset.hotspot);renderMap();}if(b.dataset.image)openImage(b.dataset.image);if(b.dataset.reference)navigateReference(b.dataset.reference);if(b.dataset.galleryGroup){$('galleryGroup').value=b.dataset.galleryGroup;$('gallerySearch').value='';renderGallery();location.hash='gallery';}});
    $('topicSelect').addEventListener('change',e=>{state.topic=Number(e.target.value);state.step=0;renderTopic();});$('previousStep').addEventListener('click',()=>{if(state.step>0){state.step--;renderTopic();}});$('nextStep').addEventListener('click',()=>{if(state.step<plan.topics[state.topic].steps.length-1){state.step++;renderTopic();}});
    $('storyType').addEventListener('change',e=>{state.storyType=e.target.value;state.storyId=null;renderStory();});$('storySearch').addEventListener('input',renderStory);$('sceneSelect').addEventListener('change',e=>{state.scene=Number(e.target.value);state.hotspot=0;renderMap();});$('galleryGroup').addEventListener('change',()=>renderGallery());$('gallerySearch').addEventListener('input',()=>renderGallery());$('galleryMore').addEventListener('click',()=>{state.galleryLimit+=24;renderGallery(false);});$('closeDialog').addEventListener('click',()=>$('imageDialog').close());$('imageDialog').addEventListener('click',e=>{if(e.target===$('imageDialog'))$('imageDialog').close();});$('previousImage').addEventListener('click',()=>moveLightbox(-1));$('nextImage').addEventListener('click',()=>moveLightbox(1));$('imageDialog').addEventListener('keydown',e=>{if(e.key==='ArrowLeft')moveLightbox(-1);if(e.key==='ArrowRight')moveLightbox(1);});
  }
  async function init() {
    try {
      const response=await fetch('plan.json',{cache:'no-cache'});if(!response.ok)throw Error('Plan unavailable');plan=await response.json();
      $('heroImage').src=figureById('UX01').src;$('topicSelect').innerHTML=plan.topics.map((t,i)=>'<option value="'+i+'">'+escape(t.id+' · '+t.name+(t.content_class==='main_story_prologue'?'／主線序章':''))+'</option>').join('');$('sceneSelect').innerHTML=plan.maps.scenes.map((s,i)=>'<option value="'+i+'">'+escape(s.scene_id+' · '+s.name)+'</option>').join('');
      bind();renderChapter();renderTopic();renderStory();renderMap();renderGallery();renderDecisions();document.documentElement.dataset.planReady='true';
      document.addEventListener('fraud:request-plan',()=>document.dispatchEvent(new CustomEvent('fraud:plan-ready',{detail:plan})));document.dispatchEvent(new CustomEvent('fraud:plan-ready',{detail:plan}));
    }catch(_error){$('chapterContent').innerHTML='<p class="load-error">完整企劃暫時無法載入。請重新整理；不會用空白內容冒充完整企劃。</p>';document.documentElement.dataset.planReady='false';}
  }
  init();
})();
