(function(root,factory){'use strict';if(typeof module==='object'&&module.exports)module.exports=factory();else root.FraudPlayerSceneBridge=factory();})(typeof globalThis==='object'?globalThis:this,function(){
'use strict';
function create({scene,view,prototype,schedule,cancel,events,extraHandlers={}}){
let frame=null,last=null,disposed=false,updateLocked=false;const paused=new Set(),cleanups=[];
function stop(){if(frame!==null)cancel(frame);frame=null;last=null;}
function canMove(){const s=scene.getSnapshot();return !disposed&&!paused.size&&s.phase==='office'&&!s.modal&&s.path.length>0;}
function pump(){if(!canMove()){stop();return;}if(frame===null)frame=schedule(time=>{frame=null;if(disposed)return;const delta=last===null?0:Math.max(0,time-last);last=time;if(delta<=1000)scene.tick(delta);else last=null;render();});}
function render(){if(disposed)return;view.render(scene.getSnapshot(),scene.getScope());pump();}
function issue(type,payload={}){if(disposed||updateLocked)return{accepted:false,code:disposed?'disposed':'update-locked'};const out=scene.issue(type,payload);if(!out.accepted)view.notice?.(out.code);render();return out;}
function openGame(){if(disposed)return false;const snapshot=prototype.getSnapshot();const out=issue('enter-minigame',{snapshot});if(!out.accepted)return false;stop();prototype.open('MG-P02');return true;}
function sync(){if(disposed||updateLocked||scene.getSnapshot().phase!=='minigame'||scene.getSnapshot().modal)return;const snapshot=prototype.getSnapshot();if(!snapshot||snapshot.pendingEvent||snapshot.resultCount!==1)return;const out=scene.issue('sync-result',{snapshot});if(out.accepted){prototype.pause();render();}}
function back(){if(disposed||updateLocked)return false;const s=scene.getSnapshot();const type=s.phase==='minigame'?'leave-minigame':s.phase==='result'?'return-scene':null;if(!type)return false;const out=issue(type);if(out.accepted)prototype.pause();return out.accepted;}
function pause(reason,value){if(disposed)return;if(value)paused.add(reason);else paused.delete(reason);scene.pause(reason,value);if(value)stop();render();}
function ground(point){return issue('move',{point});}
const handlers={ground,approach:()=>issue('approach'),acceptTask:id=>issue('accept-task',{task:id}),openDrawer:()=>issue('open-drawer'),openSettings:()=>{const p=prototype.getSnapshot();if(p?.pendingEvent)return{accepted:false,code:'prototype-busy'};extraHandlers.beforeSettings?.();return issue('open-settings');},close:()=>{const out=issue('close-modal');sync();return out;},openGame,back,...Object.fromEntries(Object.entries(extraHandlers).filter(([k])=>k!=='beforeSettings'))};
const offView=view.subscribe(handlers);if(typeof offView==='function')cleanups.push(offView);
const offPrototype=prototype.observe(sync);if(typeof offPrototype==='function')cleanups.push(offPrototype);
if(events){for(const[event,reason,value]of[['blur','blur',true],['focus','blur',false],['hidden','hidden',true],['visible','hidden',false]]){const off=events.on(event,()=>pause(reason,value));if(typeof off==='function')cleanups.push(off);}}
render();return Object.freeze({issue,openGame,back,pause,refresh:render,sync,setUpdateLock(value){updateLocked=Boolean(value);pause('menu',updateLocked);view.setBusy?.(updateLocked);},getStatus:()=>({disposed,updateLocked,activeFrames:frame===null?0:1,paused:[...paused],playerUIValidated:false}),dispose(){if(disposed)return;disposed=true;stop();for(const off of cleanups)off();prototype.pause();view.dispose?.();}});
}
function legacyPrototype({document,window}){
const panel=document.getElementById('interactivePrototype');if(!panel||!window.FraudInteractiveDemo)throw new Error('Existing MG-P02 renderer must be ready');
return Object.freeze({getSnapshot:()=>window.FraudInteractiveDemo.getSnapshot('MG-P02'),open:game=>{if(game!=='MG-P02')throw new Error('Unsupported slice game');document.dispatchEvent(new window.CustomEvent('fraud:interactive-open',{detail:{game}}));},pause:()=>document.getElementById('demoRead')?.click(),observe(fn){const observer=new window.MutationObserver(()=>fn());observer.observe(panel,{childList:true,subtree:true,attributes:true,attributeFilter:['data-revision','data-result-count','data-busy','data-view']});return()=>observer.disconnect();}});
}
return Object.freeze({create,legacyPrototype});
});
