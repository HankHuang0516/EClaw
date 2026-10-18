/* Source-linked engineering guidance. Not new canon, user comprehension certification, or story integration. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.FraudPrivateStepGuide=api;})(globalThis,function(){'use strict';
const sourceHash='67ba13c122de79e85dae52d5ef6983f5151f28e0febd809259bbdb21132ee3f1';
const candidates={T01:'MG-P01',T03:'MG-P02',T05:'MG-P04',T07:'MG-P06'};
const byTarget=new WeakMap();
const activationByDocument=new WeakMap();
function guardFor(d){let state=activationByDocument.get(d);if(state)return state;
state={held:new Set(),blocked:new Set(),moduleRoot:null,arm(root){for(const key of this.held)this.blocked.add(key);this.moduleRoot=this.blocked.size?root:null;}};
const activation=event=>event.key==='Enter'||event.key===' ';
const stop=event=>{event.preventDefault();event.stopImmediatePropagation();};
d.addEventListener('keydown',event=>{if(!activation(event))return;if(state.blocked.has(event.key)||(event.repeat&&event.target?.closest?.('.route-preview'))){stop(event);return;}state.held.add(event.key);},true);
d.addEventListener('keyup',event=>{if(!activation(event))return;if(state.blocked.has(event.key))stop(event);state.held.delete(event.key);state.blocked.delete(event.key);if(!state.blocked.size)state.moduleRoot=null;},true);
d.addEventListener('click',event=>{if(event.detail===0&&state.blocked.size&&state.moduleRoot?.contains(event.target))stop(event);},true);
d.defaultView?.addEventListener('blur',()=>{state.held.clear();state.blocked.clear();state.moduleRoot=null;});
activationByDocument.set(d,state);return state;}
function build(id,raw){if(!candidates[id]||!raw)return null;const s=id==='T03'?raw.state:raw;
const m={id,candidate:candidates[id],phase:'work',next:'',why:'',choices:[],actions:[],after:'',gap:'正式角色反應與主線下一幕尚未接入；這裡只保存本頁原型結果。',source:'new-gameplay-proposals.json '+candidates[id]+' steps / story_choice / personal_consequences；另對照本款交付模組。',sourceHash,humanComprehensionValidated:false};
const a=key=>id==='T01'?'.t01-module [data-t01="'+key+'"]':id==='T03'?'.t03-module [data-focus-key="t03.'+key+'"]':'.fraud-'+id.toLowerCase()+' [data-action="'+key+'"]';
if(id==='T01'){
 m.why='依候選提案，這裡整理的是遠端工單，不是把人物搬進園區。方岑需2輪，米洛與朵娜各1輪；工單完成不等於薪資發放。';
 m.choices=['可以調整工單排入先後；只推進本輪開始時已在槽中的工作。','「中止整批」目前是原型的退出操作：保留已發生後果，未處理工單不算成功；不是已定案的新劇情分支。'];
 if(raw.aborted){m.phase='aborted';m.next='本批已中止。可查看留下的後果、返回列表，或明確重設另開一局。';m.why='已完成／退出的工單保留原狀，待排工單沒有變成成功；中止不代表退款或救援。';m.actions=[a('exit'),a('reset')];}
 else if(s.committed){m.phase='result';m.next='三份後果已保留。可查看紀錄或返回列表；重玩需明確重設。';m.why='方岑仍未領薪、米洛退出且損失保留、朵娜未被記為已付款。這些是已顯示的候選固定後果。';m.actions=[a('read-fang_cen'),a('exit')];}
 else if(s.jobs.every(j=>['COMPLETED','EXITED'].includes(j.state))){m.phase='ready-handoff';m.next='三份工單均已有終態，點「核對並交班一次」。';m.actions=[a('handoff')];}
 else if(s.selectedJob&&s.jobs.find(j=>j.id===s.selectedJob)?.state==='STAGED'){m.phase='staged-selection';m.next='這份工單已在工位，不能再放第二槽。可撤回未推進工單、取消選取，或改選另一份待排工單。';m.why='同一工單不能占兩槽；只有尚未推進的工單可以撤回。';m.actions=[a('remove-'+s.selectedJob),a('cancel')];}
 else if(s.selectedJob&&s.jobs.find(j=>j.id===s.selectedJob)?.state==='WAITING'&&s.slots.some(x=>x===null)){const slot=s.slots.findIndex(x=>x===null);m.next='已選工單；點空的「工位 '+(slot+1)+'」放入。';m.actions=[a('slot-'+slot)];}
 else if(s.slots.some(x=>x===null)&&s.jobs.some(j=>j.state==='WAITING')){const j=s.jobs.find(j=>j.state==='WAITING');m.next='先選「'+j.name+'」工單，再點空工位；不要覆蓋已有工單。';m.actions=[a('select-'+j.id)];}
 else{m.next='工位已有工作，點「推進一輪」；進行中的工單不能撤回。';m.actions=[a('advance')];}
 m.after='完成單會釋放工位；三份均處理後才能交班。交班／中止僅留本頁紀錄，不是正式派工或下一幕。';
}else if(id==='T03'){m.gap='此來源提到的主管固定反應、選擇進日記與正式下一幕尚未接入。';
 m.why='來源設定是無效道具，不是真票。先看三人的期待，再保留原票與重複承諾；不是替人安排有效座位。';
 m.choices=['「標記矛盾後交回」：已發現同一個A被答應給兩人，仍把標記過的本批工作交回。','「整批暫停」：停止交回自己這批工作；不是改票、讓演出成真、退款或救援。','兩者都保留三人的落空後果。主管固定反應與選擇進日記的演出尚未接入。'];
 const ids=['tao_ke','bi_an','fu_lin'],ticket=id=>s.tickets.find(t=>t.id===id);
 if(s.sealed){m.phase='result';m.next='三人後續已封存。可回看原票或返回列表，不會再次結算。';m.why='陶可失望、畢安憤怒、芙琳尚未成行都保留；沒有任何人因此有效入場或退款。';m.actions=[a('exit')];}
 else if(s.committed){m.phase='followups';const unread=ids.find(x=>!s.followupsViewed.includes(x)),unattached=ids.find(x=>!s.followupsAttached.includes(x));if(unread){m.next='先點「查看 '+ticket(unread).name+' 後續」，再把後果夾回原票。';m.actions=[a('followup.'+unread)];}else if(unattached){m.next='已讀後續，點「夾回原票：'+ticket(unattached).name+'」。';m.actions=[a('attach.'+unattached)];}else{m.next='三份後果均已夾回，點「封存提案結果」。';m.actions=[a('seal')];}m.why='選擇已固定；每個人都要被讀取並留存，不能只留一個合計結果。';}
 else{const unread=ids.find(x=>!s.expectationsViewed.includes(x)),unplaced=ids.find(x=>!['A','B'].some(k=>s.boardStacks[k].includes(x)));
 if(unread){m.phase='expectations';m.next='先讀「'+ticket(unread).name+'期待」，確認這份道具對誰有意義。';m.actions=[a('expectation.'+unread)];}
 else if(s.piecePlacements.moon!=='tao_ke'){m.phase='assembly';m.next=s.selectedPiece==='moon'?'已選月牙，點「放入陶可缺口」。':'選「月牙」，再點陶可的活動缺口；另外兩票的預裝圖案不能撤。';m.actions=[a(s.selectedPiece==='moon'?'placePiece':'piece.moon')];}
 else if(unplaced){m.phase='board';m.next=s.selectedTicket===unplaced?'將這張原票放到固定 '+ticket(unplaced).fixedSeat+' 展示位。':'選「'+ticket(unplaced).name+'」原票，再依票面放到固定 '+ticket(unplaced).fixedSeat+'。';m.actions=[a(s.selectedTicket===unplaced?'place.'+ticket(unplaced).fixedSeat:'select.'+unplaced)];}
 else if(!s.overlapRevealed){m.phase='reveal';m.next='點「抬起 A 上層原票」，同時看見實際疊放的兩個名字。';m.actions=[a('reveal')];m.why='同一位置被答應給兩人，必須看見兩張原票；不能只看上面一張。';}
 else if(!s.modelInspected){m.phase='model';m.next='點「翻看劇場模型支架」，確認道具背後並沒有演出兌現能力。';m.actions=[a('model')];}
 else if(!s.duplicateMarked){m.phase='mark';const wrong=s.selectedPair.find(x=>!['tao_ke','bi_an'].includes(x)),missing=['tao_ke','bi_an'].find(x=>!s.selectedPair.includes(x));m.next=wrong?'先取消不屬於雙A的名字，再選陶可與畢安。':missing?'點「標記人選：'+ticket(missing).name+'」，只選雙A的兩人。':'已選陶可與畢安，點「確認兩名重複承諾」。';m.actions=[a(wrong?'pair.'+wrong:missing?'pair.'+missing:'mark')];}
 else{m.phase=s.pendingChoice?'confirm-choice':'choice';m.next=s.pendingChoice?'先讀清這個選擇的意思；可確認本局選擇，或返回修改。':'證據與期待已齊，現在才預覽「交回」或「整批暫停」。';m.actions=s.pendingChoice?[a('confirm'),a('cancelChoice')]:[a('choice.return_marked'),a('choice.pause_batch')];m.why='已看見雙A重複承諾與空模型，主角此刻決定自己是否交回這批工作；不是決定誰能入場。';}}
 m.after='確認後需逐人閱讀、夾回三份後續，再封存。本原型只存結果；不冒稱主管片尾、日記或正式下一幕已完成。';
}else if(id==='T05'){
 m.why='孟柏看到的是冒名權威舞台；三視角要讓你看見觀眾、表演者與後台是同一場演出，而不是只追光點。';
 m.choices=['「照原工作單交回」：完成並交回主角參與的排場工作。','「暫停自己的工作」：停止主角這段演出工作；不代表孟柏離場、獲救或玩家取得逮捕／遣散權。'];
 if(s.result){m.phase='result';m.next=s.result.commonShadow?'本輪影子工序已完成，可回看結果或到選單退出。':'這是殘缺結案，不能當成已取得共同影子；可到選單重設練習。';m.actions=[a(s.view==='menu'?'exit':'menu')];if(s.view==='menu')m.next='已在選單，點「退出模組」回列表；明確重設才清除此局。';}
 else if(s.view==='menu'){m.phase='menu';m.next='返回視角可接續同一局；只有明確確認重設才恢復機會。';m.actions=[a('backstage'),a('reset')];}
 else{const unseen=['bell','moon','backstage'].find(x=>!s.visited.includes(x));if(unseen){m.phase='views';m.next='先查看'+({bell:'鐘門：觀眾視角',moon:'月門：表演者視角',backstage:'星門：後台視角'})[unseen]+'。';m.actions=[a(unseen)];}
 else if(!s.capture&&s.attempts===0){m.phase='incomplete-choice';m.next=s.view==='backstage'?'兩次機會已用完，只能殘缺結案，或到選單重設。':'返回星門後台，查看殘缺結案；換頁不會補回機會。';m.actions=s.view==='backstage'?[a('handoff'),a('pause'),a('menu')]:[a('backstage')];}
 else if(!s.capture&&s.frame!==1){m.phase='frame';m.next=s.view==='moon'?'用「前一幕／下一幕」觀察，找到「共同中央亮起」，再回後台定格。':'回月門逐格調整燈光；單門影子不能當共同證據。';m.actions=s.view==='moon'?[a('previous'),a('next')]:[a('moon')];}
 else if(!s.capture){m.phase='capture';m.next=s.view==='backstage'?'共同中央已亮，點「定格這一幕」。':'回星門後台，在共同中央亮起的這一格定格。';m.actions=[a(s.view==='backstage'?'capture':'backstage')];}
 else if(s.view!=='backstage'){m.phase='return-backstage';m.next='回星門後台，把取得的兩門影子疊到側台玻璃。';m.actions=[a('backstage')];}
 else if(s.placed.length<2){m.phase='overlay';const shadow=s.placed.includes('bell')?'moon':'bell';m.next=s.selectedShadow?'已選影子，點「放到側台玻璃」；道具架不是目標。':'選'+(shadow==='bell'?'鐘門':'月門')+'影子，再點側台玻璃。';m.actions=[a(s.selectedShadow?'glass':shadow==='bell'?'shadowBell':'shadowMoon')];}
 else{m.phase='choice';m.next='三視角與兩門影子已齊，選交回工作單或暫停自己的工作。';m.actions=[a('handoff'),a('pause')];}}
 m.after='結果保留孟柏的恐懼與主角參與記憶；目前只有文字後果，主管／人物固定演出與正式下一幕未接入。';
}else{
 m.why='同一個R7事件從待記、已記到沖回。只拿午間數字當結論會漏掉前後態；結果帶不是第三個工作窗。';
 if(s.closed){m.phase='result';m.next=s.view==='menu'?'已在選單，點「離開預覽」回列表；本件結果仍保留。':'本件已關閉，可回看三態結果帶或到選單退出。';m.actions=[a(s.view==='menu'?'exit':'menu')];}
 else if(s.view!=='work'){m.phase='menu';m.next='點「操作頁」回同一局；閱讀與選單不推進時間。';m.actions=[a('work')];}
 else if(s.tape.length===3){m.phase='close';m.next='三態結果帶已齊，點「關閉本件」；不要再複製快照。';m.actions=[a('close')];}
 else{const expected=s.tape.length===0?['morning','noon']:['noon','evening'],wrong=s.slots.findIndex(x=>x&&!expected.includes(x)),missing=expected.find(x=>!s.slots.includes(x)),names={morning:'晨間待記',noon:'午間已記',evening:'晚間沖回'};m.phase=s.tape.length===0?'first-segment':'second-segment';
 if(wrong>=0){m.next='這段銜接不符，先「取回」工作窗 '+(wrong+1)+' 的快照，再放'+expected.map(x=>names[x]).join('與')+'。';m.actions=[a('remove-'+wrong)];}
 else if(!missing){m.next='這段兩態已齊，點「輸出這一段」；前態釋槽，後態留下接下一段。';m.actions=[a('output')];}
 else if(s.selected&&!expected.includes(s.selected)){m.next='先取消不屬於這段的選取；本段需要'+expected.map(x=>names[x]).join('與')+'。';m.actions=[a('cancel')];}
 else if(s.selected===missing){const slot=s.slots.findIndex(x=>x===null);m.next='已選'+names[missing]+'，點空的工作窗 '+(slot+1)+'。';m.actions=[a('place-'+slot)];}
 else{m.next='選'+names[missing]+'，再點空工作窗。';m.actions=[a(missing)];}}
 m.after='三態24→30→24只代表本件資料完整。主管仍貼回誇張警報、許澄受驚的文字後果保留；正式片尾與下一幕尚未接入。';
}
return m;}
function render(target,id,raw,{moduleRoot,nextPreviewTitle}={}){const model=build(id,raw);if(!model){target.hidden=true;return;}target.hidden=false;const reset={T01:'[data-t01="confirm-reset"]',T03:'[data-focus-key="t03.resetConfirm"]',T05:'[data-action="confirmReset"]',T07:'[data-action="confirm-reset"]'}[id];if(moduleRoot?.querySelector(reset)){model.phase='reset-confirmation';model.next='正在確認重設：取消會保留本局；只有確認重設才清除此模組。';model.why='這不是正式存檔操作，也不會重設其他模組。';model.actions=[reset];}
model.nextPreview='回玩法列表可重看；頁尾「繼續預覽」可查看'+(nextPreviewTitle||'下一個預覽段落')+'。這只是預覽導覽，不代表正式劇情已銜接。';
let ui=byTarget.get(target);if(!ui){const d=target.ownerDocument,keyGuard=guardFor(d),make=(tag,text,cls,parent=target)=>{const el=d.createElement(tag);if(text)el.textContent=text;if(cls)el.className=cls;parent.append(el);return el;};const label=make('p','依現有候選提案的操作說明・不是定案劇情','private-guide-label');const next=make('p','','private-guide-next');next.setAttribute('aria-live','polite');const jump=make('button','前往這一步操作','private-guide-jump');jump.type='button';jump.addEventListener('click',()=>{const button=ui.model.actions.map(selector=>ui.moduleRoot?.querySelector(selector)).find(b=>b?.isConnected&&!b.disabled);if(button){keyGuard.arm(ui.moduleRoot);button.focus({preventScroll:true});button.scrollIntoView({block:'center',inline:'nearest'});}});const details=make('details','','private-guide-details');make('summary','為何這樣做／完成後接哪裡','',details);const why=make('p','','private-guide-why',details),choices=make('div','','private-guide-choices',details),after=make('p','','private-guide-after',details),preview=make('p','','private-guide-preview',details),gap=make('p','','private-guide-gap',details),source=make('small','','private-guide-source',details);ui={label,next,jump,details,why,choices,after,preview,gap,source,model:null,moduleRoot:null,lastPhase:null,key:null};byTarget.set(target,ui);}
ui.model=model;ui.moduleRoot=moduleRoot;ui.jump.disabled=!model.actions.some(selector=>{const b=moduleRoot?.querySelector(selector);return b&&!b.disabled;});const key=JSON.stringify(model);if(ui.key===key)return;ui.key=key;target.dataset.guidePhase=model.phase;target.dataset.guideActions=JSON.stringify(model.actions);ui.next.textContent='下一步：'+model.next;ui.why.textContent='為什麼：'+model.why;ui.choices.replaceChildren();for(const text of model.choices){const p=target.ownerDocument.createElement('p');p.className='private-guide-choice';p.textContent=text;ui.choices.append(p);}ui.after.textContent='完成後：'+model.after;ui.preview.textContent=model.nextPreview;ui.gap.textContent='尚未接入：'+model.gap;ui.source.textContent='來源：'+model.source+'（設計提案，仍待確認）';if(['choice','confirm-choice','incomplete-choice','ready-handoff'].includes(model.phase)&&ui.lastPhase!==model.phase)ui.details.open=true;ui.lastPhase=model.phase;const focused=target.ownerDocument.activeElement;if(moduleRoot?.contains(focused)){const r=focused.getBoundingClientRect(),height=target.ownerDocument.defaultView.innerHeight;if(r.top<8||r.bottom>height-8)focused.scrollIntoView({block:'nearest',inline:'nearest'});}}
return Object.freeze({build,render,sourceHash,coverage:Object.keys(candidates),humanComprehensionValidated:false});
});