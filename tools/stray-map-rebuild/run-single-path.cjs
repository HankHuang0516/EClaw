#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');const {pathToFileURL}=require('node:url');
const h=require('./synthetic-harness.cjs');
const {PendingService,checks,digest}=require('./pending-service.cjs');
const {publicContent,VIEW}=require('./projection-contract.cjs');
const {buildNativeEntry}=require('./build-native-entry.cjs');
const {PgSchedulerBridge,withPgScheduledPass}=require('./pg-scheduler.cjs');
const {startLoopback}=require('../stray-map-intake/rehearsal');
const f=require('../stray-map-intake/synthetic-fixtures'),c=require('../stray-map-intake/case-fixtures');
const reviewChecks=Object.fromEntries(checks.map(key=>[key,true]));
function records(){
    const pending=c.caseTip('SIGHTING');pending.source.recordKey='private_synthetic_single_pending_001';
    const rejected=c.caseTip('SIGHTING');rejected.source.recordKey='private_synthetic_single_rejected_001';
    const sensitive=c.caseTip('SIGHTING');sensitive.source.recordKey='private_synthetic_single_habitat_001';sensitive.animal.kind='WILDLIFE';sensitive.location.sensitivity='HABITAT';
    const unknown=c.caseTip('SIGHTING');unknown.source.recordKey='private_synthetic_single_unknown_001';unknown.location.regionCode=null;
    const privacy=c.caseTip('SIGHTING');privacy.source.recordKey='private_synthetic_single_privacy_001';privacy.display.description='PRIVATE_ADDRESS_CANARY private@example.invalid 0912-345-678';
    return [c.caseTip('LOST'),c.caseTip('FOUND'),c.caseTip('SIGHTING'),pending,rejected,sensitive,unknown,privacy];
}
async function probe(resource,config,name){
    const file=path.join(resource.runRoot,`${name}.input.private.json`);h.write(resource.runRoot,path.basename(file),config);
    return new Promise((resolve,reject)=>{
        const child=spawn(process.execPath,[path.join(__dirname,'single-path-probe.cjs'),file],{env:h.environment(resource),stdio:['ignore','pipe','pipe']});
        let out='',err='';const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('SINGLE_PATH_PROBE_TIMEOUT'));},60000);
        child.stdout.on('data',chunk=>{out+=chunk;if(out.length>1048576)child.kill('SIGKILL');});child.stderr.on('data',chunk=>{err+=chunk;});
        child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('exit',code=>{clearTimeout(timer);if(code!==0)return reject(Error(`SINGLE_PATH_PROBE_FAILED: ${err.slice(0,500)}`));
            try{const result=JSON.parse(out);h.write(resource.runRoot,`${name}.private.json`,result);resolve(result);}catch(error){reject(error);}});
    });
}
async function main(root){
    const resource=await h.create(root);let source,operator;const assertions=[];const checked=(name,fn)=>{fn();assertions.push({name,passed:true});};
    const save=(file,data)=>h.write(resource.runRoot,file,data);
    try{
        const policies=[{...f.policy},{...f.peerPolicy}],fixtures=records();let clock=f.SUBMITTED;
        const original=await resource.sharp({create:{width:128,height:96,channels:3,background:{r:31,g:73,b:52}}})
            .withExif({IFD0:{Artist:'SELF_MADE_SINGLE_PATH_QA'},IFD3:{GPSLatitudeRef:'N',GPSLatitude:'0/1 0/1 0/1',GPSLongitudeRef:'E',GPSLongitude:'0/1 0/1 0/1'}}).png().toBuffer();
        fs.writeFileSync(path.join(resource.runRoot,'original-self-made.private.png'),original,{mode:0o600,flag:'wx'});
        const pixelHashes=[digest(original)],service=new PendingService({pool:resource.pool,sourcePolicies:policies,knownSyntheticPixelHashes:pixelHashes,now:()=>clock});await service.init();
        const {LocalStorageProvider}=await import(pathToFileURL(path.join(resource.workspace,'apps/api/dist/storage/local.js')).href);
        const storage=new LocalStorageProvider(resource.directories['private-photos'],'http://127.0.0.1/unserved');
        const photo=await service.addSyntheticPhoto(original,'image/png',{synthetic:true,license:'EXPLICIT_PERMISSION',originalHash:pixelHashes[0],context:fixtures[1].source},storage,resource.sharp);
        assert.ok(photo.success);fixtures[1].photos=[{uploadId:photo.uploadId,rights:photo.rights,caption:'Private photo note: private@example.invalid'}];
        checked('actual self-made image is authorized, re-encoded and metadata stripped',()=>assert.equal(photo.afterMime,'jpeg'));
        assert.equal((await service.addSyntheticPhoto(original,'image/png',null,storage,resource.sharp)).status,403);
        assert.equal((await service.addSyntheticPhoto(original,'image/jpeg',{synthetic:true,license:'EXPLICIT_PERMISSION',originalHash:pixelHashes[0],context:fixtures[1].source},storage,resource.sharp)).status,415);
        const fixtureConfig=path.join(resource.runRoot,'native-fixture-context.private.json');save(path.basename(fixtureConfig),{kind:'SYNTHETIC_NATIVE_PROJECTION',sourcePolicies:policies,pixelHashes,submittedAt:clock});
        const entry=buildNativeEntry(root,resource.runId,fixtureConfig);save('NATIVE_ENTRY_PROVENANCE.private.json',entry);await h.start(resource,entry.entry);
        const base=resource.base,list=()=>h.request(`${base}/v1/animals?view=${VIEW}`);
        checked('native process starts checked health with zero seeded native data',()=>assert.ok(resource.child.pid));
        assert.equal((await h.request(`${base}/v1/animals`)).status,400);
        const protectedWrite=await h.request(`${base}/v1/animals`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
        checked('legacy native authentication/default list unchanged',()=>{assert.equal(protectedWrite.status,400);assert.equal(protectedWrite.json.error,'missing_device_id');});
        const terms=await h.request(`${base}/v1/terms`);assert.equal(terms.json.terms,'2026-09-14.1');
        let sourceRequests=0,remoteImageRequests=0;
        source=await startLoopback((req,res)=>{
            if(req.url==='/unlicensed-image.png'){remoteImageRequests++;res.writeHead(403);return res.end();}
            const policy=policies.find(item=>req.url===`/${item.publisherId}`);sourceRequests++;
            res.writeHead(policy?200:404,{'Content-Type':'application/json'});res.end(JSON.stringify({synthetic:true,records:policy?fixtures.filter(t=>t.source.publisherId===policy.publisherId):[]}));
        });
        const bridge=new PgSchedulerBridge({pool:resource.pool,sourcePolicies:policies,now:()=>clock,syntheticDatabase:true});await bridge.init();
        const runRound=async()=>{const result=[];for(const policy of policies)result.push(await withPgScheduledPass({bridge,sourceURL:`${source.url}/${policy.publisherId}`,
            receiverURL:base,sourceScope:policy,jobId:'synthetic-single-path',nativeReceiverVerified:true}));return result;};
        const first=await runRound();assert.ok(first.every(result=>result.success&&!result.skipped));
        const receipts=first.flatMap(result=>result.results.map(item=>item.body.receipt));assert.equal(receipts.length,fixtures.length);
        assert.equal(new Set(receipts.map(item=>item.tipId)).size,fixtures.length);save('01-scheduled-pending.private.json',{clock,sourceRequests,rounds:first,receipts});
        checked('actual registered API GET through existing 15-minute scheduler commits PG receipts',()=>assert.equal(sourceRequests,2));
        const pendingList=await list();assert.equal(pendingList.status,200);assert.equal(pendingList.json.externalLeads.length,0);assert.deepEqual(pendingList.json.mapMarkers,[]);
        const rows=(await resource.pool.query('SELECT id,public_id,record_key FROM rebuild_external.tips ORDER BY record_key')).rows;
        const byKey=Object.fromEntries(rows.map(row=>[row.record_key,row]));
        for(const row of rows)assert.equal((await h.request(`${base}/a/${row.public_id}`)).status,404);
        const foundRow=byKey[fixtures[1].source.recordKey],photoId=photo.uploadId.slice(3).replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/,'$1-$2-$3-$4-$5');
        const photoURL=`${base}/external-media/${foundRow.public_id}/${photoId}`;assert.equal((await h.request(photoURL)).status,404);
        checked('pending native view, native share and photo all hidden',()=>assert.equal(pendingList.json.nativeIncluded,false));
        const skipped=await runRound();assert.ok(skipped.every(r=>r.skipped));assert.equal(sourceRequests,2);
        clock='2026-11-26T12:14:59.999Z';assert.ok((await runRound()).every(r=>r.skipped));assert.equal(sourceRequests,2);
        checked('same slot and 14:59.999 tick do not poll or submit again',()=>assert.equal(sourceRequests,2));
        const context={kind:'SYNTHETIC_SINGLE_PATH_PROBE',workspace:resource.workspace,policies,records:fixtures,nativeURL:base,pixelHashes,receipts};
        const reopened=await probe(resource,{...context,clock},'02-fresh-process-skipped');assert.notEqual(reopened.processId,process.pid);assert.equal(reopened.sourceRequests,0);assert.ok(reopened.rounds.every(r=>r.skipped));
        checked('fresh process reopens persisted poll slots and original receipts',()=>assert.deepEqual(reopened.receipts,receipts));
        clock='2026-11-26T12:15:00.000Z';const replayed=await probe(resource,{...context,clock},'03-fresh-process-next-slot');assert.equal(replayed.sourceRequests,2);
        assert.ok(replayed.rounds.every(r=>r.success&&!r.skipped&&r.results.every(x=>x.body.replay)));
        checked('next 15-minute round repeats same receipts across process and new source ports',()=>assert.deepEqual(replayed.receipts,receipts));
        const socket=path.join('/tmp',`stray-single-op-${resource.runId}.sock`);
        operator=http.createServer(async(req,res)=>{try{let bytes='';for await(const chunk of req){bytes+=chunk;if(bytes.length>16384)throw Error('TOO_LARGE');}
            const input=JSON.parse(bytes),result=await service.decide(input.tipId,input.action,input.checks,input.publicContent??null);
            res.writeHead(typeof result.status==='number'?result.status:200,{'Content-Type':'application/json'});res.end(JSON.stringify(result));
        }catch{res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({success:false,error:'INVALID_PRIVATE_REVIEW'}));}});
        await new Promise((resolve,reject)=>{operator.once('error',reject);operator.listen(socket,resolve);});fs.chmodSync(socket,0o600);
        const operate=input=>new Promise((resolve,reject)=>{const q=http.request({socketPath:socket,path:'/',method:'POST'},res=>{let body='';res.on('data',chunk=>body+=chunk);res.on('end',()=>resolve(JSON.parse(body)));});q.on('error',reject);q.end(JSON.stringify(input));});
        const decision=async(index,action,content)=>operate({tipId:byKey[fixtures[index].source.recordKey].id,action,checks:reviewChecks,publicContent:content});
        const failed=await operate({tipId:foundRow.id,action:'APPROVE',checks:{},publicContent:publicContent(fixtures[1])});assert.equal(failed.error,'REVIEW_CHECKS_REQUIRED');
        assert.equal((await h.request(`${base}/a/${foundRow.public_id}`)).status,404);
        const failedReviewList=await list();checked('incomplete safety review cannot enable native projection',()=>assert.equal(failedReviewList.json.externalLeads.length,0));
        await decision(0,'APPROVE',publicContent(fixtures[0]));const foundContent=publicContent(fixtures[1]);foundContent.photoCaptions[0].caption='Self-made synthetic QA pixels; not an animal photograph.';
        assert.ok((await decision(1,'APPROVE',foundContent)).publicVisible);await decision(2,'APPROVE',publicContent(fixtures[2]));
        await decision(4,'REJECT');assert.equal((await decision(5,'APPROVE',publicContent(fixtures[5]))).status,'APPROVED_PRIVATE');
        assert.equal((await decision(6,'APPROVE',publicContent(fixtures[6]))).status,'APPROVED_PRIVATE');
        const unsafePublic=await decision(7,'APPROVE',publicContent(fixtures[7]));assert.equal(unsafePublic.error,'INVALID_PUBLIC_CONTENT');
        const cleanContent=publicContent(fixtures[7]);cleanContent.description='合成已審核線索，僅保留國別與台北市粗區域。';await decision(7,'APPROVE',cleanContent);
        const approved=await list();assert.equal(approved.status,200);assert.equal(approved.json.externalLeads.length,4);assert.deepEqual(approved.json.mapMarkers,[]);
        const Ajv=require('../../backend/node_modules/ajv'),ajv=new Ajv({allErrors:true});
        ajv.addSchema(require('../../docs/stray-map-external-intake.openapi.json'),'stray-map-external-intake.openapi.json');
        const validateView=ajv.compile(require('../../docs/stray-map-native-external-view.schema.json'));
        checked('actual native HTTP list validates against explicit versioned contract',()=>assert.equal(validateView(approved.json),true));
        const lostLead=approved.json.externalLeads.find(item=>item.id===byKey[fixtures[0].source.recordKey].public_id),foundLead=approved.json.externalLeads.find(item=>item.id===foundRow.public_id);
        assert.equal(lostLead.report.type,'LOST');assert.equal(lostLead.report.locationMeaning,'LAST_KNOWN');assert.deepEqual(lostLead.observation,fixtures[0].observation);
        assert.equal(foundLead.report.type,'FOUND');assert.equal(foundLead.report.locationMeaning,'FOUND_AT');assert.deepEqual(foundLead.report.custody,fixtures[1].report.custody);
        checked('native versioned list preserves lost/found, date precision, country and care meanings',()=>assert.equal(foundLead.careLocationInferred,false));
        for(const lead of approved.json.externalLeads){assert.equal(lead.origin,'EXTERNAL_PUBLIC_LEAD');assert.equal(lead.selfWitness,false);assert.equal(lead.location.coordinates,null);assert.equal(lead.mapMarkerEligible,false);}
        const publicText=JSON.stringify(approved.json);for(const forbidden of ['private@example.invalid','0912-345-678','PRIVATE_ADDRESS_CANARY','publisherId','datasetId','recordKey','evidenceRef','latitude','longitude','lastSeenAt'])assert.ok(!publicText.includes(forbidden));
        checked('reviewed external list contains no private input, source keys, invented positions or UTC dates',()=>assert.ok(!JSON.stringify([lostLead,foundLead]).includes('T00:00:00')));
        for(const index of [3,4,5,6])assert.equal((await h.request(`${base}/a/${byKey[fixtures[index].source.recordKey].public_id}`)).status,404);
        checked('pending, rejected, habitat and untrusted-location cases have no share or map pin',()=>assert.deepEqual(approved.json.mapMarkers,[]));
        const shared=await h.request(`${base}/a/${foundRow.public_id}?lang=en`),lostShare=await h.request(`${base}/a/${lostLead.id}?lang=en`);assert.equal(shared.status,200);assert.equal(lostShare.status,200);
        const html=shared.bytes.toString();assert.ok(html.includes('Found region'));assert.ok(lostShare.bytes.toString().includes('Last known region'));assert.ok(html.includes('data-time-precision="DATE"'));
        for(const forbidden of ['private@example.invalid','PRIVATE_ADDRESS_CANARY','maps.google','lastSeenAt','T00:00:00','straymap://'])assert.ok(!html.includes(forbidden));
        checked('existing native /a/:UUID serves separate safe external-origin HTML',()=>assert.equal(shared.headers['cache-control'],'no-store'));
        const readablePhoto=await h.request(photoURL);assert.equal(readablePhoto.status,200);const metadata=await resource.sharp(readablePhoto.bytes).metadata();assert.ok(!metadata.exif&&!metadata.xmp&&!metadata.icc);
        checked('native share photo is actual sanitized authorized bytes',()=>assert.equal(readablePhoto.headers['cache-control'],'no-store'));
        const trap=c.caseTip('SIGHTING');trap.source.recordKey='private_synthetic_unlicensed_url_001';trap.photos=[{url:`${source.url}/unlicensed-image.png`}];
        const refused=await h.request(`${base}/external-rebuild/v1/tips`,{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':'synthetic_unlicensed_url_001'},body:JSON.stringify(trap)});
        checked('unverified image URL is rejected and never fetched',()=>{assert.equal(refused.status,400);assert.equal(remoteImageRequests,0);});
        save('04-reviewed-native-projection.private.json',{list:approved.json,sharedStatus:shared.status,photoHash:digest(readablePhoto.bytes),rawInputsExcluded:true,rows});
        await decision(0,'WITHDRAW');await decision(1,'WITHDRAW');
        const after=await list();assert.equal(after.json.externalLeads.length,2);assert.ok(after.json.externalLeads.every(lead=>![lostLead.id,foundLead.id].includes(lead.id)));
        for(const id of [lostLead.id,foundLead.id]){assert.equal((await h.request(`${base}/a/${id}`)).status,404);assert.equal((await h.request(`${base}/a/${id}`,{method:'HEAD'})).status,404);}
        assert.equal((await h.request(photoURL)).status,404);assert.equal((await h.request(photoURL,{method:'HEAD'})).status,404);
        checked('withdrawal removes both list entries, native shares and image GET/HEAD',()=>assert.equal(after.headers['cache-control'],'no-store'));
        clock='2026-11-26T12:30:00.000Z';
        const afterReopen=await probe(resource,{...context,clock},'05-fresh-process-withdrawn');
        assert.ok(afterReopen.rounds.every(r=>r.success&&!r.skipped&&r.results.every(x=>x.body.replay)));assert.deepEqual(afterReopen.receipts,receipts);
        const finalList=await list();checked('reopening and receipt retries cannot re-publish withdrawn cases',()=>assert.equal(finalList.json.externalLeads.length,2));
        for(const id of [lostLead.id,foundLead.id])assert.equal((await h.request(`${base}/a/${id}`)).status,404);
        assert.equal((await h.request(photoURL)).status,404);
        assert.equal((await resource.pool.query('SELECT count(*)::int n FROM rebuild_external.tips')).rows[0].n,8);
        const counts=(await resource.pool.query('SELECT (SELECT count(*)::int FROM devices) devices,(SELECT count(*)::int FROM animals) animals,(SELECT count(*)::int FROM sightings) sightings')).rows[0];
        checked('complete path creates no device, native animal or native sighting rows',()=>assert.deepEqual(counts,{devices:0,animals:0,sightings:0}));
        const nativeContracts=await import(pathToFileURL(path.join(resource.workspace,'packages/contracts/dist/index.js')).href);
        assert.equal(nativeContracts.animalSummarySchema.safeParse(foundLead).success,false);assert.equal(nativeContracts.animalSummarySchema.shape.latitude.safeParse(null).success,false);
        checked('legacy contract incompatibility is explicit; opt-in view is never passed off as legacy summary',()=>assert.ok(foundLead.location.coordinates===null));
        const nativeViewHead=await h.request(`${base}/v1/animals?view=${VIEW}`,{method:'HEAD'});
        checked('real native HEAD external view avoids the device handler',()=>{assert.equal(nativeViewHead.status,200);assert.equal(nativeViewHead.bytes.length,0);});
        let limited=false;
        for(let attempt=0;attempt<205;attempt++){
            const response=await h.request(`${base}/v1/animals?view=${VIEW}`,{method:'HEAD'});
            if(response.status===429){limited=true;break;}assert.equal(response.status,200);
        }
        checked('existing native rate limit still applies to the public external view',()=>assert.equal(limited,true));
        const finalNativeCounts=(await resource.pool.query('SELECT (SELECT count(*)::int FROM devices) devices,(SELECT count(*)::int FROM animals) animals,(SELECT count(*)::int FROM sightings) sightings')).rows[0];
        assert.deepEqual(finalNativeCounts,{devices:0,animals:0,sightings:0});
        const result={success:true,simulation:true,checks:assertions,scheduler:'actual existing scheduledPass, 15-minute persisted PG slots, test clock only',
            receipts:receipts.length,freshProcesses:[reopened.processId,replayed.processId,afterReopen.processId],sourceGETsFirstRound:sourceRequests,
            nativeCounts:counts,nativeListView:VIEW,nativeShareVerified:true,sharePath:'/a/:UUID',publicPhotosVerified:true,
            mapPins:0,coarseOnly:true,noFakeCoordinates:true,appContract:'LEGACY_UNCHANGED; NEW OPT_IN_EXTERNAL_ENVELOPE',appUIVerified:false,
            publication:'ISOLATED_NATIVE_FASTIFY_ONLY',productionWrites:0,productionDeployed:false,officialApiVerified:false,
            sourceRestored:false,signature:'UNSIGNED',limitations:['App source unavailable; App UI not exercised','No production adoption, terms or operator authority',
                'Synthetic rights/pixels/manual checks only; no real author/photo semantic safety proof','No external point supplied: all external map pins remain absent','SQL source lifecycle/matching beyond review/withdraw remains unimplemented']};
        save('RESULT.private.json',result);h.write(root,`SINGLE_PATH_RESULT-${resource.runId}.private.json`,{success:true,runRoot:resource.runRoot,checks:assertions.length});
        console.log(JSON.stringify({success:true,runRoot:resource.runRoot,checks:assertions.length,productionWrites:0,nativeShare:true,appUI:false,mapPins:0}));
    }catch(error){save('FAILURE.private.json',{success:false,error:error.message,productionWrites:0});throw error;}
    finally{if(operator)await new Promise(resolve=>operator.close(resolve));if(source)await source.close();await h.stop(resource);}
}
if(require.main===module)main(process.argv[2]).catch(error=>{console.error(error.stack);process.exitCode=1});
module.exports={main,records};
