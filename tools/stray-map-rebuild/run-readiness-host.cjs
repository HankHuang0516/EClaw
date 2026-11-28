#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict'),{spawn}=require('node:child_process'),{pathToFileURL}=require('node:url');
const h=require('./synthetic-harness.cjs'),{PendingService,checks,digest}=require('./pending-service.cjs'),{selfMadeProof}=require('./photo-rights.cjs');
const dedup=require('./sql-dedup.cjs'),{publicContent,VIEW}=require('./projection-contract.cjs'),{buildNativeEntry}=require('./build-native-entry.cjs');
const {PgSchedulerBridge,withPgScheduledPass}=require('./pg-scheduler.cjs'),{startLoopback}=require('../stray-map-intake/rehearsal');
const f=require('../stray-map-intake/synthetic-fixtures'),c=require('../stray-map-intake/case-fixtures');
const CHECKS=Object.fromEntries(checks.map(key=>[key,true]));
const DUP_CHECKS={sameCaseConfirmed:true,sourceVerified:true,privacyReviewed:true};
function fixtures(){const result={lost:c.caseTip('LOST'),found:c.caseTip('FOUND'),sighting:c.caseTip('SIGHTING')};
    result.duplicate=f.clone(result.lost);Object.assign(result.duplicate.source,{publisherId:f.peerPolicy.publisherId,datasetId:f.peerPolicy.datasetId,recordKey:'private_readiness_duplicate_lost_001'});
    result.duplicate.display.title='Second source: same invented lost case';
    for(const name of ['unlicensed','unknown','wildlife','rejected']){result[name]=c.caseTip('SIGHTING');result[name].source.recordKey=`private_readiness_${name}_001`;}
    result.unlicensed.display={locale:'zh-TW',title:'沒有授權照片的合成區域線索',description:'文字線索保留；公開可見的外部照片並未取得再發布授權。'};
    result.unknown.location.regionCode=null;result.wildlife.animal.kind='WILDLIFE';result.wildlife.location.sensitivity='HABITAT';return result;}
async function runProbe(resource,receipts){const input=path.join(resource.runRoot,'probe-input.private.json');
    fs.writeFileSync(input,JSON.stringify({kind:'READINESS_SYNTHETIC_PROBE',workspace:resource.workspace,receipts}),{mode:0o600});
    return new Promise((resolve,reject)=>{const child=spawn(process.execPath,['--require',path.join(__dirname,'loopback-guard.cjs'),path.join(__dirname,'readiness-state-probe.cjs'),input],{env:h.environment(resource),stdio:['ignore','pipe','pipe']});
        let out='',err='';const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('PERSISTENCE_PROBE_TIMEOUT'));},30000);child.stdout.on('data',v=>out+=v);child.stderr.on('data',v=>err+=v);
        child.on('error',error=>{clearTimeout(timer);reject(error);});child.on('exit',code=>{clearTimeout(timer);if(code!==0)return reject(Error(err.slice(0,400)));try{resolve(JSON.parse(out));}catch(error){reject(error);}});});}
async function main(root,evidenceRoot){const resource=await h.create(root,{evidenceRoot,kind:'readiness'});let source,trap,operator,resolveStop;const stopped=new Promise(resolve=>resolveStop=resolve);const evidence=[];
    const save=(file,data)=>h.write(resource.runRoot,file,data),policies=[{...f.policy},{...f.peerPolicy}],data=fixtures();let clock=f.SUBMITTED,roundNumber=0,mode='PRESENT',imageFetches=0,sourceGets=0;
    try{
        const original=await resource.sharp({create:{width:128,height:96,channels:3,background:{r:28,g:89,b:61}}}).withExif({IFD0:{Artist:'READINESS_SELF_MADE_SYNTHETIC'}}).png().toBuffer();
        const pixelHashes=[digest(original)],service=new PendingService({pool:resource.pool,sourcePolicies:policies,now:()=>clock,knownSyntheticPixelHashes:pixelHashes,requirePersistentPhotoRights:true,enablePersistentDedup:true});await service.init();
        const {LocalStorageProvider}=await import(pathToFileURL(path.join(resource.workspace,'apps/api/dist/storage/local.js')).href),storage=new LocalStorageProvider(resource.directories['private-photos'],'http://127.0.0.1/unserved');
        fs.writeFileSync(path.join(resource.runRoot,'original-self-made.private.png'),original,{mode:0o600,flag:'wx'});
        const permission={context:data.found.source,originalHash:pixelHashes[0],proof:selfMadeProof(data.found.source,pixelHashes[0])};
        const grant=await service.photoRights.register(permission);assert.ok(grant.success);assert.equal((await service.photoRights.register(permission)).grantId,grant.grantId);
        const denied=await service.photoRights.register({...permission,context:data.unlicensed.source,proof:{...selfMadeProof(data.unlicensed.source,pixelHashes[0]),mayRepublish:false}});assert.equal(denied.success,false);
        const noLedger=await service.addSyntheticPhoto(original,'image/png',{synthetic:true,license:'EXPLICIT_PERMISSION',originalHash:pixelHashes[0],context:data.found.source},storage,resource.sharp);assert.equal(noLedger.success,false);
        const photo=await service.addSyntheticPhoto(original,'image/png',{synthetic:true,license:'EXPLICIT_PERMISSION',originalHash:pixelHashes[0],context:data.found.source,grantId:grant.grantId},storage,resource.sharp);assert.ok(photo.success);
        data.found.photos=[{uploadId:photo.uploadId,rights:photo.rights,caption:'Self-made QA pixels; not an animal photograph.'}];
        trap=await startLoopback((_req,res)=>{imageFetches++;res.writeHead(403);res.end();});
        const omitted=await service.photoRights.admit(data.unlicensed,[{url:`${trap.url}/unlicensed-image.jpg`}],await service.uploads());assert.ok(omitted.success);assert.equal(omitted.tip.photos.length,0);data.unlicensed=omitted.tip;
        evidence.push({name:'persistent case-bound self-made permission required; unlicensed URL omitted but text retained',passed:true});save('photo-admission.private.json',{grant,denied,noLedger,photo,omitted});
        const fixtureConfig=path.join(resource.runRoot,'native-fixture.private.json');save(path.basename(fixtureConfig),{kind:'SYNTHETIC_NATIVE_PROJECTION',sourcePolicies:policies,pixelHashes,submittedAt:clock,requirePersistentPhotoRights:true,enablePersistentDedup:true,clientSpec:true});
        const entry=buildNativeEntry(root,resource.runId,fixtureConfig);save('native-entry.private.json',entry);await h.start(resource,entry.entry);const base=resource.base;
        source=await startLoopback((req,res)=>{
            if(req.url==='/unlicensed-image.jpg'){imageFetches++;res.writeHead(403);return res.end();}
            sourceGets++;const policy=policies.find(p=>req.url===`/${p.publisherId}`);if(!policy){res.writeHead(404,{'Content-Type':'application/json'});return res.end('{}');}
            if(mode==='OUTAGE_ALL'||mode==='OUTAGE_PEER'&&policy.publisherId===f.peerPolicy.publisherId){res.writeHead(503,{'Content-Type':'application/json'});return res.end(JSON.stringify({synthetic:true,error:'TEMPORARY_FAILURE'}));}
            const records=Object.entries(data).filter(([name,tip])=>tip.source.publisherId===policy.publisherId&&!(mode==='ABSENT'&&name==='lost')).map(([,tip])=>tip);
            const events=mode==='CLOSE'&&policy.publisherId===f.policy.publisherId?[{...c.event(data.lost,'EXPLICIT_CLOSED','readiness'),sourceChangedAt:f.date('2026-11-26')}]:[];
            res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({synthetic:true,completeSnapshot:true,records,events}));
        });
        const bridge=new PgSchedulerBridge({pool:resource.pool,sourcePolicies:policies,now:()=>clock,syntheticDatabase:true,enableSourceLifecycle:true});await bridge.init();
        const poll=async nextMode=>{mode=nextMode;clock=new Date(Date.parse(f.SUBMITTED)+roundNumber++*900000).toISOString();const result=[];
            for(const policy of policies)try{result.push(await withPgScheduledPass({bridge,sourceURL:`${source.url}/${policy.publisherId}`,receiverURL:base,sourceScope:policy,jobId:'synthetic-readiness',nativeReceiverVerified:true}));}catch(error){result.push({success:false,error:error.message});}
            return result;};
        const initial=await poll('PRESENT');assert.ok(initial.every(v=>v.success));const receipts=initial.flatMap(v=>v.results.map(r=>r.body.receipt));assert.equal(receipts.length,8);save('initial-pending.private.json',{initial,receipts});
        const rowList=(await resource.pool.query('SELECT id,public_id,record_key FROM rebuild_external.tips')).rows,byName={};for(const[name,tip]of Object.entries(data))byName[name]=rowList.find(r=>r.record_key===tip.source.recordKey);
        const publicIds=Object.fromEntries(Object.entries(byName).map(([name,row])=>[name,row.public_id]));
        const photoId=photo.uploadId.slice(3).replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/,'$1-$2-$3-$4-$5'),photoURL=`${base}/external-media/${publicIds.found}/${photoId}`;
        let approved=false,sequence=Promise.resolve();
        async function snapshot(){return {view:(await h.request(`${base}/v1/animals?view=${VIEW}`)).json,
            rows:(await resource.pool.query('SELECT id,review,source_case_status,source_availability,source_changed_at,source_closure_evidence FROM rebuild_external.tips ORDER BY id')).rows,
            grants:(await resource.pool.query('SELECT id,state,proof_hash FROM rebuild_external.photo_rights_grants')).rows,
            decisions:(await resource.pool.query('SELECT id,target_id FROM rebuild_external.duplicate_decisions')).rows,
            native:(await resource.pool.query('SELECT (SELECT count(*)::int FROM devices) devices,(SELECT count(*)::int FROM animals) animals,(SELECT count(*)::int FROM sightings) sightings')).rows[0],imageFetches,sourceGets,clock};}
        async function action(name){let outcome={success:true};
            if(name==='APPROVE'){
                assert.equal(approved,false);for(const[name,tip]of Object.entries(data)){const result=await service.decide(byName[name].id,name==='rejected'?'REJECT':'APPROVE',CHECKS,publicContent(tip));assert.ok(result.success);}approved=true;
            }else if(name==='CONFIRM_DUPLICATE'){
                const suggestions=await dedup.listRecommendations(resource.pool,byName.duplicate.id);assert.ok(suggestions.candidates.some(x=>x.candidateId===byName.lost.id&&x.kind==='SUSPECTED_DUPLICATE'));
                assert.equal((await dedup.confirmDuplicate(resource.pool,{id:byName.found.id,targetId:byName.lost.id,checks:DUP_CHECKS})).success,false);
                const decision=await dedup.confirmDuplicate(resource.pool,{id:byName.duplicate.id,targetId:byName.lost.id,checks:DUP_CHECKS});assert.ok(decision.success);outcome={...outcome,suggestions,decision};
            }else if(['ABSENT','OUTAGE_PEER','PRESENT','CLOSE','OUTAGE_ALL'].includes(name))outcome.rounds=await poll(name);
            else if(name==='REVOKE_PHOTO'){assert.ok((await service.photoRights.revoke(grant.grantId)).success);assert.equal((await service.photoRights.register(permission)).success,false);}
            else if(name==='WITHDRAW')assert.ok((await service.decide(byName.sighting.id,'WITHDRAW')).success);
            else if(name==='PERSIST'){outcome.probe=await runProbe(resource,receipts);assert.notEqual(outcome.probe.processId,process.pid);}
            else if(name==='STOP'){resolveStop();return {success:true,stopping:true};}
            else if(name!=='SNAPSHOT')throw Error('INVALID_FIXTURE_ACTION');
            const current=await snapshot();assert.deepEqual(current.native,{devices:0,animals:0,sightings:0});assert.equal(imageFetches,0);
            save(`stage-${String(evidence.length).padStart(2,'0')}-${name.toLowerCase()}.private.json`,{outcome,current});evidence.push({name,passed:true});return {...outcome,...current};
        }
        const socket=path.join('/tmp',`stray-readiness-${resource.runId}.sock`);operator=http.createServer(async(req,res)=>{try{let input='';for await(const chunk of req){input+=chunk;if(input.length>4096)throw Error('INPUT_LIMIT');}const data=JSON.parse(input);
            const job=sequence.then(()=>action(data.action));sequence=job.catch(()=>{});const result=await job;res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(result));
        }catch(error){res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({success:false,error:error.message}));}});
        await new Promise((resolve,reject)=>{operator.once('error',reject);operator.listen(socket,resolve);});fs.chmodSync(socket,0o600);
        const ready={kind:'NON_FORMAL_CLIENT_READINESS',baseURL:base,operatorSocket:socket,runRoot:resource.runRoot,publicIds,privateIds:Object.fromEntries(Object.entries(byName).map(([name,row])=>[name,row.id])),photoURL,sourceFields:{lostObservation:data.lost.observation,foundObservation:data.found.observation,foundCustody:data.found.report.custody},sourceAudit:'APP_SOURCE_AND_AUTHORIZED_BUILD_UNAVAILABLE',trustedPointAvailable:false};
        save('READY.private.json',ready);console.log(JSON.stringify({ready:true,file:path.join(resource.runRoot,'READY.private.json'),baseURL:base,appUI:false}));
        await stopped;await sequence;const final=await snapshot();save('HOST_RESULT.private.json',{success:true,simulation:true,appUIVerified:false,prototypeOnly:true,evidence,final,productionWrites:0,trustedPointAvailable:false});
    }catch(error){save('FAILURE.private.json',{success:false,error:error.message,productionWrites:0});throw error;}
    finally{if(operator)await new Promise(resolve=>operator.close(resolve));if(source)await source.close();if(trap)await trap.close();await h.stop(resource);}
}
if(require.main===module)main(process.argv[2],process.argv[3]).catch(error=>{console.error(error.stack);process.exitCode=1});
module.exports={main,fixtures};
