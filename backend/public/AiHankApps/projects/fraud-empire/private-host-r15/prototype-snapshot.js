(function(root,factory){'use strict';if(typeof module==='object'&&module.exports)module.exports=factory();else root.FraudPrototypeSnapshot=factory();})(typeof globalThis==='object'?globalThis:this,function(){
'use strict';
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b),integer=n=>Number.isSafeInteger(n)&&n>=0;
function validateP02(s,data,model){
const fail=code=>({valid:false,code,preserve:true});
if(!s||s.game!=='MG-P02'||typeof s.session!=='string'||!s.session||s.session.length>200||!data?.fixtures?.['MG-P02']||typeof model?.create!=='function')return fail('invalid-snapshot-owner');
const fresh=model.create('MG-P02',s.session,data),keys=Object.keys(fresh).sort();if(!same(Object.keys(s).sort(),keys))return fail('snapshot-schema-mismatch');
if(!same(s.tickets,fresh.tickets)||!same(s.pieces,fresh.pieces)||!same(s.clock,fresh.clock)||s.awardedReward!==0||s.selectedJob!==null||!integer(s.revision)||!integer(s.logicalStep)||s.logicalStep>s.revision||!Array.isArray(s.processed)||s.processed.length!==s.revision||s.processed.length>30000||new Set(s.processed).size!==s.processed.length||s.pendingEvent!==null)return fail('invalid-or-busy-snapshot');
let maxEventSequence=0;const prefix=s.session+':event-';for(const id of s.processed){if(typeof id!=='string'||!id.startsWith(prefix))return fail('foreign-command-owner');const serial=id.slice(prefix.length);if(!/^[1-9][0-9]*$/.test(serial)||!Number.isSafeInteger(Number(serial))||Number(serial)>Number.MAX_SAFE_INTEGER-100)return fail('invalid-event-sequence');maxEventSequence=Math.max(maxEventSequence,Number(serial));}
const ids=['tao_ke','bi_an','fu_lin'],set=(a,allowed,max)=>Array.isArray(a)&&a.length<=max&&new Set(a).size===a.length&&a.every(x=>allowed.includes(x));
for(const k of['expectationsViewed','followupsViewed','followupsAttached','selectedPair'])if(!set(s[k],ids,k==='selectedPair'?2:3))return fail('invalid-proof-array');
if(!s.piecePlacements||typeof s.piecePlacements!=='object'||Array.isArray(s.piecePlacements)||Object.keys(s.piecePlacements).some(k=>k!=='moon')||s.piecePlacements.moon!==undefined&&s.piecePlacements.moon!=='tao_ke'||!s.boardStacks||!same(Object.keys(s.boardStacks).sort(),['A','B'])||!set(s.boardStacks.A,['tao_ke','bi_an'],2)||!set(s.boardStacks.B,['fu_lin'],1))return fail('invalid-piece-or-board');
if(![null,'moon','star','cloud'].includes(s.selectedPiece)||s.selectedPiece&&s.piecePlacements[s.selectedPiece]||!([null,...ids].includes(s.selectedTicket)))return fail('invalid-selection');
for(const key of['overlapRevealed','duplicateMarked','modelInspected','committed','sealed'])if(typeof s[key]!=='boolean')return fail('invalid-flag');
if(s.boardStacks.A.includes('tao_ke')&&!s.piecePlacements.moon||s.overlapRevealed&&s.boardStacks.A.length!==2||s.duplicateMarked&&!s.overlapRevealed)return fail('stale-proof');
const choices=data.choices.map(c=>c.id);if(![null,...choices].includes(s.pendingChoice)||![null,...choices].includes(s.committedChoice)||s.committed!==Boolean(s.committedChoice)||s.committed&&s.pendingChoice!==null)return fail('invalid-choice');
if((s.pendingChoice||s.committedChoice)&&model.proofMissing(s).length)return fail('choice-with-missing-proof');
if((s.followupsViewed.length||s.followupsAttached.length)&&!s.committedChoice||!s.followupsAttached.every(id=>s.followupsViewed.includes(id)))return fail('invalid-followup-proof');
if(![0,1].includes(s.resultCount)||s.sealed!==(s.resultCount===1)||s.resultId!==(s.sealed?s.session+':P02-result':null)||s.sealed&&(!s.committedChoice||s.followupsAttached.length!==3))return fail('invalid-result');
const views=['assembly','expectations','board','choice','follow_up','result'];if(!set(s.visited,views,6)||!s.visited.includes('assembly')||!s.visited.includes('expectations')||!s.visited.includes(s.activeView)||s.visited.includes('follow_up')&&!s.committedChoice||s.visited.includes('result')&&!s.sealed||s.phase!==model.phase(s))return fail('invalid-view-history');
const minimum=(s.piecePlacements.moon?1:0)+s.boardStacks.A.length+s.boardStacks.B.length+Number(s.overlapRevealed)+Number(s.duplicateMarked)+Number(s.committed)+s.followupsAttached.length+Number(s.sealed);if(s.logicalStep<minimum)return fail('impossible-step-count');
return{valid:true,maxEventSequence,snapshot:model.clone(s)};
}
return Object.freeze({validateP02});
});
