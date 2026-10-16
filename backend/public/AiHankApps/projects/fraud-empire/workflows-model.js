/* Source-bound, page-local operations. No resource, account or payment authority. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.FraudWorkflowsModel=api;})(globalThis,function(){'use strict';
const copy=v=>JSON.parse(JSON.stringify(v)),modes=['靜態','動態','出差'];
function eligible(plan,ctx){if(!plan||!Array.isArray(plan.topics)||!ctx||!Number.isInteger(ctx.rank)||ctx.rank<1||ctx.rank>5||!Number.isSafeInteger(ctx.wisdom)||ctx.wisdom<0||!modes.includes(ctx.mode))return [];return plan.topics.filter(t=>!['T02','T16'].includes(t.id)&&t.supervisor_pool_eligible!==false&&Number.isInteger(t.rank_min)&&Number.isInteger(t.wisdom_min)&&Array.isArray(t.available_modes)&&t.rank_min<=ctx.rank&&t.wisdom_min<=ctx.wisdom&&t.available_modes.includes(ctx.mode)).map(t=>({id:t.id,name:t.name,rank:t.rank_min,wisdom:t.wisdom_min,available_modes:t.available_modes.slice()}));}
function dispatch(plan,ctx){const pool=eligible(plan,ctx),selected=Array.isArray(ctx?.selected)?ctx.selected:[],manager=ctx?.rank===1?'hou':'lin';if(![3,4,5].includes(ctx?.count))return {valid:false,code:'countPending',pool,manager};if(pool.length<ctx.count)return {valid:false,code:'insufficient',pool,manager};if(selected.length!==ctx.count||new Set(selected).size!==selected.length||selected.some(id=>!pool.some(t=>t.id===id)))return {valid:false,code:'needSelection',pool,manager};return {valid:true,code:'batchReady',pool,manager,selected:selected.slice(),countOrigin:'explicit-manual-scenario-not-derived-from-wisdom',formalUnlock:false};}
function create(game,session){if(!['MG-P05','MG-P06'].includes(game)||typeof session!=='string'||!session||session.length>100)return null;const s={schemaVersion:1,game,session,revision:0,processed:[],opened:false,selected:null,closed:false,resultCount:0,resultId:null,awardedReward:0,formalComplete:false};return game==='MG-P05'?{...s,balance:10,history:[],coverLifted:false,cancelTarget:null,physicalComplete:false}:{...s,eventIdentity:'R7',windows:[null,null],retained:null,belt:[],physicalComplete:false,mediaComplete:false};}
function apply(state,a){const reject=code=>({state,accepted:false,code});if(!state||!a||a.session!==state.session||a.revision!==state.revision||typeof a.id!=='string'||!a.id||a.id.length>120||state.processed.includes(a.id))return reject('stale');if(state.closed)return reject('closed');const s=copy(state);let code='selected';
if(a.type==='OPEN'){if(s.opened)return reject('duplicate');s.opened=true;}
else if(!s.opened)return reject('begin');
else if(s.game==='MG-P05'){
if(a.type==='SELECT'){if(!['A','B','C'].includes(a.item))return reject('wrongTarget');if(s.history.some(h=>h.id===a.item))return reject('duplicate');s.selected=a.item;}
else if(a.type==='PLACE'){const item=s.selected;if(!item)return reject('needSelection');if(item==='A'){if(s.history.length||a.target!=='credit')return reject(a.target!=='credit'?'wrongTarget':'wrongOrder');s.balance=18;s.history.push({id:'A',kind:'increase',from:10,to:18});}
else if(item==='B'){if(s.history.length!==1||s.history[0].id!=='A')return reject('wrongOrder');if(a.target!=='debit')return reject('wrongTarget');s.balance=12;s.history.push({id:'B',kind:'decrease',from:18,to:12});}
else{if(s.history.length!==2||s.history[1].id!=='B')return reject('wrongOrder');if(a.target!=='cancelB')return reject('wrongTarget');s.balance=18;s.cancelTarget='B';s.history.push({id:'C',kind:'cancel',target:'B',from:12,to:18});}s.selected=null;}
else if(a.type==='LIFT'){if(s.history.length!==3||s.cancelTarget!=='B')return reject('wrongOrder');if(s.coverLifted)return reject('duplicate');s.coverLifted=true;}
else if(a.type==='HANDOFF'){if(!s.coverLifted||s.balance!==18||s.cancelTarget!=='B')return reject('wrongOrder');s.closed=true;s.physicalComplete=true;s.resultCount=1;s.resultId=s.session+':P05-physical-result';code='physicalComplete';}
else return reject('wrongTarget');
}else{
const cards=['morning','noon','evening'];
if(a.type==='SELECT'){if(!cards.includes(a.item)||s.windows.includes(a.item)||s.belt.includes(a.item))return reject('duplicate');s.selected=a.item;}
else if(a.type==='PLACE'){if(![0,1].includes(a.slot)||s.windows[a.slot]||!s.selected||s.windows.includes(s.selected)||s.belt.includes(s.selected))return reject('wrongTarget');s.windows[a.slot]=s.selected;s.selected=null;}
else if(a.type==='REMOVE'){if(![0,1].includes(a.slot)||!s.windows[a.slot]||s.windows[a.slot]===s.retained)return reject('wrongTarget');s.windows[a.slot]=null;s.selected=null;}
else if(a.type==='OUTPUT'){if(s.belt.length===0){if(!s.windows.includes('morning')||!s.windows.includes('noon'))return reject('wrongOrder');s.belt=['morning','noon'];s.windows[s.windows.indexOf('morning')]=null;s.retained='noon';}
else if(s.belt.length===2){if(s.retained!=='noon'||!s.windows.includes('noon')||!s.windows.includes('evening'))return reject('wrongOrder');s.belt.push('evening');s.windows[s.windows.indexOf('noon')]=null;s.retained='evening';}
else return reject('duplicate');}
else if(a.type==='CLOSE'){if(s.belt.join(',')!=='morning,noon,evening'||s.retained!=='evening')return reject('wrongOrder');s.windows=[null,null];s.retained=null;s.closed=true;s.physicalComplete=true;s.resultCount=1;s.resultId=s.session+':P06-physical-result';code='physicalComplete';}
else return reject('wrongTarget');
}
s.revision++;s.processed.push(a.id);s.awardedReward=0;return {state:s,accepted:true,code};}
return {copy,modes,eligible,dispatch,create,apply};});
