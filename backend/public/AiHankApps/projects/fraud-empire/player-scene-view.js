(function(root,factory){'use strict';if(typeof module==='object'&&module.exports)module.exports=factory();else root.FraudPlayerSceneView=factory();})(typeof globalThis==='object'?globalThis:this,function(){
'use strict';
const texts={
  "zh-TW": {
    "title": "詐騙帝國",
    "demo": "前端試玩・不計分",
    "tasks": "目前任務",
    "settings": "設定",
    "back": "返回辦公室",
    "close": "關閉",
    "available": "可接任務",
    "accept": "接下任務",
    "start": "開始票券任務",
    "resume": "繼續票券任務",
    "complete": "本次任務已完成",
    "none": "尚未接任務，點主管走近交談。",
    "floor": "點擊走道移動，點主管交談",
    "audio": "目前未具備音源，僅提供文字提示。",
    "mute": "靜音",
    "volume": "音量偏好",
    "save": "儲存",
    "load": "讀取",
    "savePending": "存檔還原尚未接入，不會假裝已保存。",
    "result": "本局結果",
    "reward": "此試玩不發放正式資源",
    "fixture": "目前為來源相容 R1／第3天10:00的獨立不計分情境，不採用正式時間成本或資源平衡。",
    "test": "程式功能測試，非核准美術",
    "invalid": "這裡暫時走不到，請點走道。",
    "menu": "任務與設定開啟時暫停移動。",
    "missing": "核准場景圖層尚未就緒，未啟動遊戲。",
    "unavailable": "目前無法執行這一步，請先完成眼前的操作。"
  },
  "en": {
    "title": "Scam Empire",
    "demo": "Frontend trial / unscored",
    "tasks": "Current task",
    "settings": "Settings",
    "back": "Back to the office",
    "close": "Close",
    "available": "Available task",
    "accept": "Accept task",
    "start": "Start ticket task",
    "resume": "Continue ticket task",
    "complete": "Task completed",
    "none": "No task yet. Tap the supervisor to approach.",
    "floor": "Tap the aisle to move; tap the supervisor to talk",
    "audio": "No audio assets are available. Text hints only.",
    "mute": "Mute",
    "volume": "Volume preference",
    "save": "Save",
    "load": "Load",
    "savePending": "Save restoration is not connected. Nothing is falsely marked saved.",
    "result": "Session result",
    "reward": "This trial grants no formal resources",
    "fixture": "An independent source-compatible R1 / Day 3, 10:00 unscored fixture; no formal time costs or resource balance adopted.",
    "test": "Program test, not approved artwork",
    "invalid": "That spot is not reachable. Tap the aisle.",
    "menu": "Movement pauses while tasks or settings are open.",
    "missing": "Approved scene layers are not ready. The game has not started.",
    "unavailable": "That action is not available yet. Complete the current step first."
  },
  "zh-CN": {
    "title": "诈骗帝国",
    "demo": "前端试玩・不计分",
    "tasks": "当前任务",
    "settings": "设置",
    "back": "返回办公室",
    "close": "关闭",
    "available": "可接任务",
    "accept": "接下任务",
    "start": "开始票券任务",
    "resume": "继续票券任务",
    "complete": "本次任务已完成",
    "none": "尚未接任务，点主管走近交谈。",
    "floor": "点击走道移动，点主管交谈",
    "audio": "目前未具备音源，仅提供文字提示。",
    "mute": "静音",
    "volume": "音量偏好",
    "save": "保存",
    "load": "读取",
    "savePending": "存档还原尚未接入，不会假装已保存。",
    "result": "本局结果",
    "reward": "此试玩不发放正式资源",
    "fixture": "目前为来源兼容 R1／第3天10:00的独立不计分情境，不采用正式时间成本或资源平衡。",
    "test": "程序功能测试，非核准美术",
    "invalid": "这里暂时走不到，请点走道。",
    "menu": "任务与设置开启时暂停移动。",
    "missing": "核准场景图层尚未就绪，未启动游戏。",
    "unavailable": "目前无法执行这一步，请先完成眼前的操作。"
  },
  "ja": {
    "title": "詐欺帝国",
    "demo": "フロントエンド体験・得点なし",
    "tasks": "現在のタスク",
    "settings": "設定",
    "back": "事務所へ戻る",
    "close": "閉じる",
    "available": "受けられるタスク",
    "accept": "タスクを受ける",
    "start": "チケットのタスクを開始",
    "resume": "チケットのタスクを続ける",
    "complete": "タスク完了",
    "none": "まだタスクはない。上司をタップして近づこう。",
    "floor": "通路をタップして移動、上司をタップして会話",
    "audio": "音声素材は未提供です。文字のヒントのみ表示します。",
    "mute": "ミュート",
    "volume": "音量の設定",
    "save": "保存",
    "load": "読込",
    "savePending": "セーブの復元は未接続です。保存済みとは表示しません。",
    "result": "今回の結果",
    "reward": "正式な資源は付与しません",
    "fixture": "R1・3日目10:00の独立した得点なしの例です。正式な時間コストや資源バランスは採用していません。",
    "test": "プログラムの動作試験・承認済み美術ではありません",
    "invalid": "そこへは行けません。通路をタップしてください。",
    "menu": "タスクや設定を開いている間は移動を止めます。",
    "missing": "承認済みの場面レイヤーは未準備です。ゲームは開始していません。",
    "unavailable": "今はこの操作を実行できません。目の前の手順を先に終えてください。"
  },
  "ko": {
    "title": "사기 제국",
    "demo": "프런트엔드 체험 / 점수 없음",
    "tasks": "현재 임무",
    "settings": "설정",
    "back": "사무실로 돌아가기",
    "close": "닫기",
    "available": "가능한 임무",
    "accept": "임무 수락",
    "start": "표 임무 시작",
    "resume": "표 임무 계속",
    "complete": "임무 완료",
    "none": "아직 임무가 없습니다. 상사를 눌러 다가가세요.",
    "floor": "통로를 눌러 이동하고 상사를 눌러 대화",
    "audio": "음원이 아직 없습니다. 텍스트 힌트만 제공합니다.",
    "mute": "음소거",
    "volume": "음량 설정",
    "save": "저장",
    "load": "불러오기",
    "savePending": "저장 복원이 연결되지 않았습니다. 저장됐다고 표시하지 않습니다.",
    "result": "이번 결과",
    "reward": "정식 자원을 지급하지 않습니다",
    "fixture": "R1 / 3일째 10:00의 독립적인 무점수 예시입니다. 정식 시간 비용이나 자원 밸런스는 적용하지 않습니다.",
    "test": "프로그램 기능 시험 / 승인된 미술 아님",
    "invalid": "그곳으로 갈 수 없습니다. 통로를 누르세요.",
    "menu": "임무나 설정을 열면 이동을 멈춥니다.",
    "missing": "승인된 장면 레이어가 준비되지 않아 게임을 시작하지 않았습니다.",
    "unavailable": "아직 이 동작을 실행할 수 없습니다. 현재 단계를 먼저 완료하세요."
  }
};
Object.assign(texts["zh-TW"],{"language":"語言","report":"回報問題","clear":"刪除本機存檔","update":"檢查更新"});
Object.assign(texts["en"],{"language":"Language","report":"Report a problem","clear":"Delete local save","update":"Check for updates"});
Object.assign(texts["zh-CN"],{"language":"语言","report":"报告问题","clear":"删除本地存档","update":"检查更新"});
Object.assign(texts["ja"],{"language":"言語","report":"問題を報告","clear":"端末のセーブを削除","update":"更新を確認"});
Object.assign(texts["ko"],{"language":"언어","report":"문제 신고","clear":"기기 저장 삭제","update":"업데이트 확인"});
texts["zh-TW"].restart="重新試玩";
texts["en"].restart="Restart trial";
texts["zh-CN"].restart="重新试玩";
texts["ja"].restart="体験をやり直す";
texts["ko"].restart="체험 다시 시작";
texts["zh-TW"].install="安裝／加入主畫面";
texts["en"].install="Install / add to home screen";
texts["zh-CN"].install="安装／添加到主屏幕";
texts["ja"].install="インストール／ホーム画面に追加";
texts["ko"].install="설치 / 홈 화면에 추가";
texts["zh-TW"].autoSaved="本機進度已儲存";
texts["en"].autoSaved="Progress saved on this device";
texts["zh-CN"].autoSaved="本机进度已保存";
texts["ja"].autoSaved="この端末に進行を保存済み";
texts["ko"].autoSaved="이 기기에 진행 상황 저장됨";
function validateAssets(assets,g,testing){const loaded=i=>i?.complete===true&&Number.isFinite(i.naturalWidth)&&Number.isFinite(i.naturalHeight)&&i.naturalWidth>0&&i.naturalHeight>0;const sameScene=i=>loaded(i)&&i.naturalWidth===g.width&&i.naturalHeight===g.height;if(!assets||(!testing&&assets.reviewed!==true)||!sameScene(assets.office?.image)||!assets.player)return false;for(const key of['front','right','back','left']){const s=assets.player[key];if(!s||!loaded(s.image)||!Number.isFinite(s.anchor?.x)||!Number.isFinite(s.anchor?.y)||s.anchor.x<0||s.anchor.y<0||s.anchor.x>s.image.naturalWidth||s.anchor.y>s.image.naturalHeight||!Number.isFinite(s.scale)||s.scale<=0||(!testing&&s.alphaReady!==true))return false;}if(assets.requiresContactShadow&&['front','right','back','left'].some(key=>{const s=assets.player[key];return !loaded(s.shadow)||s.shadow.naturalWidth!==s.image.naturalWidth||s.shadow.naturalHeight!==s.image.naturalHeight||(!testing&&s.shadowAlphaReady!==true);}))return false;return !g.foregroundRequired||Boolean(sameScene(assets.foreground?.image)&&(testing||assets.foreground.alphaReady===true));}
function create({document,root,geometry,assets,gameHost,language='zh-TW',testing=false}){
if(!root||!geometry||(!testing&&geometry.reviewed!==true)||!validateAssets(assets,geometry,testing))throw new Error('Approved scene layers and source-space geometry required; no unapproved cleanup fallback');
const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
let locale=Object.hasOwn(texts,language)?language:'zh-TW',handlers={},state=null,scope=null,modalKey='',disposed=false,muted=true,volume=50,hasAutoSave=false;const t=()=>texts[locale];
const app=el('section',undefined,'player-app'),header=el('header',undefined,'player-hud'),title=el('strong'),date=el('span'),badge=el('small'),returnButton=el('button'),headerSettings=el('button'),languageSelect=el('select'),stage=el('div',undefined,'player-scene'),canvas=el('canvas'),npc=el('button',undefined,'player-npc'),footer=el('nav',undefined,'player-nav'),taskButton=el('button'),settingsButton=el('button'),saveNote=el('small',undefined,'player-save-note'),status=el('p',undefined,'player-status'),dialog=el('dialog',undefined,'player-dialog');
const viewport=geometry.viewport||{x:0,y:0,width:geometry.width,height:geometry.height};canvas.width=viewport.width;canvas.height=viewport.height;canvas.tabIndex=0;canvas.setAttribute('role','img');canvas.dataset.playerCanvas='true';stage.style.aspectRatio=viewport.width+'/'+viewport.height;const ctx=canvas.getContext('2d');ctx.imageSmoothingEnabled=false;
for(const b of[returnButton,headerSettings,npc,taskButton,settingsButton])b.type='button';taskButton.dataset.playerTasks='true';settingsButton.dataset.playerSettings='true';returnButton.dataset.playerBack='true';npc.dataset.playerSupervisor='true';
headerSettings.dataset.playerHeaderSettings='true';languageSelect.dataset.playerLanguage='true';for(const[code,label]of[['zh-TW','繁體中文'],['en','English'],['zh-CN','简体中文'],['ja','日本語'],['ko','한국어']]){const option=el('option',label);option.value=code;languageSelect.append(option);}languageSelect.addEventListener('change',()=>{locale=languageSelect.value;modalKey='';handlers.language?.(locale);if(state)api.render(state,scope);});headerSettings.addEventListener('click',()=>handlers.openSettings?.());header.append(title,date,badge,languageSelect,headerSettings,returnButton,saveNote);stage.append(canvas,npc);footer.append(taskButton,settingsButton);status.setAttribute('role','status');app.append(header,stage,footer,status);root.append(app);if(gameHost)app.insertBefore(gameHost,footer);document.body.append(dialog);dialog.setAttribute('aria-label',t().tasks);
const button=(text,fn)=>{const b=el('button',text);b.type='button';b.addEventListener('click',fn);return b;};
function draw(){if(!state)return;ctx.clearRect(0,0,canvas.width,canvas.height);ctx.save();ctx.translate(-viewport.x,-viewport.y);ctx.drawImage(assets.office.image,0,0,geometry.width,geometry.height);const sprite=assets.player[state.direction]||assets.player.front;const width=sprite.image.naturalWidth||sprite.image.width,height=sprite.image.naturalHeight||sprite.image.height;if(sprite.shadow)ctx.drawImage(sprite.shadow,state.position.x-sprite.anchor.x*sprite.scale,state.position.y-sprite.anchor.y*sprite.scale,width*sprite.scale,height*sprite.scale);ctx.drawImage(sprite.image,state.position.x-sprite.anchor.x*sprite.scale,state.position.y-sprite.anchor.y*sprite.scale,width*sprite.scale,height*sprite.scale);if(assets.foreground?.image)ctx.drawImage(assets.foreground.image,0,0,geometry.width,geometry.height);ctx.restore();canvas.dataset.sourceX=String(state.position.x);canvas.dataset.sourceY=String(state.position.y);canvas.dataset.sourceDirection=state.direction;canvas.dataset.assetIds=JSON.stringify([assets.office.path,sprite.path,sprite.shadowPath,assets.foreground?.path].filter(Boolean));const hit=geometry.supervisor.hitRegion||{x:geometry.supervisor.approach.x-10,y:geometry.supervisor.approach.y-10,width:20,height:20};npc.style.left=(hit.x-viewport.x)/viewport.width*100+'%';npc.style.top=(hit.y-viewport.y)/viewport.height*100+'%';npc.style.width=hit.width/viewport.width*100+'%';npc.style.height=hit.height/viewport.height*100+'%';}
function modal(){const key=JSON.stringify([state.modal,state.phase,state.task?.status,state.result?.id,locale]);if(key===modalKey)return;modalKey=key;if(!state.modal&&state.phase!=='result'){if(dialog.open)dialog.close();return;}dialog.replaceChildren();const heading=el('h2'),content=el('div');dialog.append(heading,content);if(state.phase==='result'){heading.textContent=t().result;content.append(el('p',t().complete),el('p',t().reward),el('small',state.result.id),button(t().back,()=>handlers.back?.()));}
else if(state.modal==='supervisor'){heading.textContent=scope.supervisor==='hou'?'阿猴':'林若晴';content.append(el('p',t().available));for(const task of scope.eligibleTasks)content.append(button(task.name,()=>handlers.acceptTask?.(task.id)));if(!scope.eligibleTasks.length)content.append(el('p',t().none));}
else if(state.modal==='tasks'){heading.textContent=t().tasks;content.append(el('p',state.task?state.task.name:t().none));if(state.task){content.append(el('p',state.task.status==='completed'?t().complete:t().demo));if(state.task.status!=='completed')content.append(button(state.task.status==='in-progress'?t().resume:t().start,()=>handlers.openGame?.()));else content.append(el('small',state.result.id));}}
else if(state.modal==='settings'){heading.textContent=t().settings;content.append(el('p',t().audio));const muteLabel=el('label',t().mute),mute=el('input');mute.type='checkbox';mute.checked=muted;mute.addEventListener('change',()=>{muted=mute.checked;handlers.audio?.({muted,volume});});muteLabel.prepend(mute);const volumeLabel=el('label',t().volume),slider=el('input');slider.type='range';slider.min='0';slider.max='100';slider.value=String(volume);slider.addEventListener('input',()=>{volume=Number(slider.value);handlers.audio?.({muted,volume});});volumeLabel.append(slider);content.append(muteLabel,volumeLabel,el('p',t().fixture),el('p',t().menu));const menuStatus=el('p');menuStatus.dataset.playerMenuStatus='true';menuStatus.setAttribute('role','status');content.append(menuStatus);const save=button(t().save,()=>handlers.save?.()),load=button(t().load,()=>handlers.load?.());save.disabled=typeof handlers.save!=='function';load.disabled=typeof handlers.load!=='function';content.append(save,load);for(const[key,handler]of[['restart',handlers.restart],['report',handlers.report],['install',handlers.install],['update',handlers.update]]){const b=button(t()[key],()=>handler?.());b.disabled=typeof handler!=='function';content.append(b);}if(save.disabled||load.disabled)content.append(el('small',t().savePending));}if(state.phase!=='result')content.append(button(t().close,()=>handlers.close?.()));if(!dialog.open)dialog.showModal();}
canvas.addEventListener('pointerup',e=>{if(!state||state.phase!=='office'||state.modal)return;const r=canvas.getBoundingClientRect(),scale=Math.min(r.width/viewport.width,r.height/viewport.height),p={x:(e.clientX-r.left-(r.width-viewport.width*scale)/2)/scale+viewport.x,y:(e.clientY-r.top-(r.height-viewport.height*scale)/2)/scale+viewport.y};handlers.ground?.(p);});npc.addEventListener('click',()=>handlers.approach?.());taskButton.addEventListener('click',()=>handlers.openDrawer?.());settingsButton.addEventListener('click',()=>handlers.openSettings?.());returnButton.addEventListener('click',()=>handlers.back?.());dialog.addEventListener('cancel',e=>{e.preventDefault();if(state?.phase==='result')handlers.back?.();else handlers.close?.();});
const api=Object.freeze({subscribe(value){handlers=value;return()=>{handlers={};};},render(next,nextScope){if(disposed)return;state=next;scope=nextScope;app.lang=locale;if(hasAutoSave)saveNote.textContent=t().autoSaved;title.textContent=t().title;date.textContent='R'+state.context.rank+' / D'+state.clock.day+' '+state.clock.time;headerSettings.textContent=t().settings;languageSelect.setAttribute('aria-label',t().language);languageSelect.value=locale;if(gameHost)gameHost.inert=Boolean(state.modal);badge.textContent=testing?t().test:t().demo;taskButton.textContent=t().tasks+(state.task?' / 1':'');settingsButton.textContent=t().settings;returnButton.textContent=t().back;returnButton.hidden=!['minigame','result'].includes(state.phase);canvas.setAttribute('aria-label',t().floor);npc.setAttribute('aria-label',scope.supervisor==='hou'?'阿猴':'林若晴');npc.disabled=!scope.supervisor;stage.hidden=state.phase==='minigame';footer.hidden=state.phase==='minigame';if(gameHost)gameHost.hidden=state.phase!=='minigame';draw();modal();},autoSaved(){hasAutoSave=true;if(saveNote.textContent!==t().autoSaved)saveNote.textContent=t().autoSaved;},message(text){if(status.textContent!==text)status.textContent=text;const menuStatus=dialog.querySelector('[data-player-menu-status]');if(menuStatus&&menuStatus.textContent!==text)menuStatus.textContent=text;},setBusy(value){app.inert=Boolean(value);},notice(code){status.textContent=code==='unreachable-ground'?t().invalid:t().unavailable;},setLanguage(code){if(!Object.hasOwn(texts,code))return false;locale=code;modalKey='';if(state)this.render(state,scope);return true;},getStatus:()=>({disposed,testing,visualApproved:!testing&&assets.reviewed===true,audio:{available:false,muted,volume},saveConnected:typeof handlers.save==='function'}),dispose(){if(disposed)return;disposed=true;if(dialog.open)dialog.close();dialog.remove();app.remove();handlers={};}});return api;
}
return Object.freeze({create,validateAssets,languages:Object.freeze(Object.keys(texts)),texts});
});
