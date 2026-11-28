'use strict';
// EXTERNAL TEST DRIVER. Never packaged in the candidate. No real identity, credential or Unix-socket control.
const fs=require('node:fs'),assert=require('node:assert/strict');
const {createRequire}=require('node:module'),local=createRequire('/candidate/apps/api/package.json');
const policy={verified:true,publisherId:'qa-publisher',datasetId:'qa-dataset',origin:'https://qa.example.invalid',pathPrefix:'/cases/',allowedRegions:['US-WA','TW-TPE']};
const peerPolicy={...policy,datasetId:'qa-peer-dataset'};
const gateFile='/test-runtime/gates.json',prefix='/external-intake/v1',now='2026-11-27T00:00:00.000Z';
const checks=['contentReviewed','localLanguageReviewed','privacyReviewed','sourceVerified','locationSafe'];
const sourceHeaders={'x-local-qa-principal':'source'},reviewHeaders={'x-local-qa-principal':'reviewer'};
function setGates(flags){fs.writeFileSync(gateFile,JSON.stringify({profile:'TEXT_COARSE_PENDING_V1',intake:false,review:false,publicRead:false,...flags}));}
async function activate(app,pool){const {install}=require('/candidate/apps/api/integrations/stray-map-pilot/pilot.cjs');
    assert.equal(pool.options.connectionString,'postgresql://postgres@localhost:5432/stray_map_linux_pilot_test');
    const bounded=new(local('pg').Pool)({connectionString:pool.options.connectionString,ssl:false,max:2,connectionTimeoutMillis:500,statement_timeout:3000,lock_timeout:1000,query_timeout:4000});
    app.addHook('onClose',async()=>bounded.end());
    await install(app,{pool:bounded,configuration:()=>JSON.parse(fs.readFileSync(gateFile)),now:()=>now,bindings:{sourcePolicies:[policy,peerPolicy],
        verifySource:async req=>['source','peer-dataset'].includes(req.headers['x-local-qa-principal'])?{publisherId:policy.publisherId,datasetId:req.headers['x-local-qa-principal']==='source'?policy.datasetId:peerPolicy.datasetId}:null,
        verifyReviewer:async req=>req.headers['x-local-qa-principal']==='reviewer'?{reviewerId:'LOCAL_TEST_REVIEWER_NOT_A_PRODUCTION_IDENTITY',canReview:true}:null}});}
function payload(type,key,tw=false){const unknown={precision:'UNKNOWN',value:null,timeZone:null},date=value=>({precision:'DATE',value,timeZone:'America/Los_Angeles'});
    return {schemaVersion:3,thirdParty:true,selfWitness:false,source:{publisherId:policy.publisherId,datasetId:policy.datasetId,recordKey:key,url:null,publishedAt:{precision:'INSTANT',value:'2026-11-26T18:00:00Z',timeZone:'UTC'}},
        observation:tw?{precision:'INSTANT',value:'2026-11-26T17:00:00+08:00',timeZone:'Asia/Taipei'}:date('2026-11-25'),
        animal:{kind:'DOG',count:1,condition:'UNKNOWN'},location:{countryCode:tw?'TW':'US',regionCode:tw?'TW-TPE':'US-WA',sensitivity:'NONE'},
        display:tw?{locale:'zh-TW',title:'合成區域線索',description:'這是隔離測試，沒有精確位置。'}:{locale:'en-US',title:`Invented ${type.toLowerCase()} region lead`,description:'Isolated text-only test. No current care location is supplied.'},photos:[],
        report:{type,locationMeaning:{LOST:'LAST_KNOWN',FOUND:'FOUND_AT',SIGHTING:'OBSERVED_AT'}[type],custody:type==='FOUND'?{status:'IN_CARE',asOf:date('2026-11-26')}:{status:'UNKNOWN',asOf:unknown}}};}
async function request(port,url,{body,headers={},raw,method}={}){const r=await fetch(`http://127.0.0.1:${port}${url}`,{method:method||(body!==undefined||raw!==undefined?'POST':'GET'),headers:{...(body!==undefined||raw!==undefined?{'Content-Type':'application/json'}:{}),...headers},
    body:raw!==undefined?raw:body!==undefined?JSON.stringify(body):undefined,redirect:'error',signal:AbortSignal.timeout(10000)});const bytes=await r.text();let json;try{json=JSON.parse(bytes);}catch{}return {status:r.status,json,text:bytes};}
async function wait(port){for(let n=0;n<100;n++){try{if((await request(port,'/health')).status===200)return;}catch{}await new Promise(resolve=>setTimeout(resolve,300));}throw Error('TEST_NATIVE_STARTUP_TIMEOUT');}
async function main(phase){const u=new URL(process.env.DATABASE_URL);assert.equal(u.hostname,'localhost');assert.equal(u.pathname,'/stray_map_linux_pilot_test');assert.equal(u.password,'');assert.equal(process.arch,'x64');assert.equal(process.platform,'linux');
    const pool=new(local('pg').Pool)({connectionString:u.href,ssl:false}),result=[];const pass=(name,fn)=>{fn();result.push({name,passed:true});};
    const native=async()=>((await pool.query('SELECT (SELECT count(*)::int FROM devices) devices,(SELECT count(*)::int FROM animals) animals,(SELECT count(*)::int FROM sightings) sightings')).rows[0]);
    const schema=async()=>(await pool.query("SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='stray_text_pilot') present")).rows[0].present;
    try{
        if(phase==='migrate'){
            const before=(await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public'")).rows.map(r=>r.table_name);
            assert.deepEqual(before.filter(name=>!['spatial_ref_sys','geometry_columns','geography_columns'].includes(name)),[]);
            const files=fs.readdirSync('/native-migrations').filter(f=>f.endsWith('.sql')).sort();assert.equal(files.length,12);for(const file of files)await pool.query(fs.readFileSync('/native-migrations/'+file,'utf8'));
            assert.deepEqual(await native(),{devices:0,animals:0,sightings:0});console.log(JSON.stringify({success:true,blankDatabase:true,migrations:12,native:await native(),postgres:(await pool.query('SELECT version() version')).rows[0].version}));return;
        }
        await wait(3161);await wait(3162);
        const legacyPaths=['/health','/v1/animals','/v1/terms'];async function compareLegacy(){for(const path of legacyPaths){const a=await request(3161,path),b=await request(3162,path);assert.equal(b.status,a.status);assert.equal(b.text,a.text);}
            const a=await request(3161,'/v1/animals',{body:{}}),b=await request(3162,'/v1/animals',{body:{}});assert.equal(b.status,a.status);assert.deepEqual(b.json,a.json);assert.equal(a.status,400);}
        if(phase==='default-closed'){
            await compareLegacy();assert.equal(await schema(),false);
            for(const path of [`${prefix}/cards`,`${prefix}/receipts/tip_${'0'.repeat(32)}`])assert.equal((await request(3162,path)).status,503);
            assert.equal((await request(3162,`${prefix}/tips`,{body:{}})).status,503);assert.equal(await schema(),false);
            assert.deepEqual(await native(),{devices:0,animals:0,sightings:0});console.log(JSON.stringify({success:true,noPilotDDL:true,legacyCompared:4,defaultFlags:'CLOSED',native:await native()}));return;
        }
        if(phase==='persist'){
            const expected=JSON.parse(fs.readFileSync('/test-runtime/receipts.expected.json')),rows=(await pool.query('SELECT receipt,review FROM stray_text_pilot.tips ORDER BY id')).rows;
            assert.equal(rows.length,3);for(const receipt of expected)assert.deepEqual(rows.find(r=>r.receipt.tipId===receipt.tipId).receipt,receipt);
            assert.deepEqual(await native(),{devices:0,animals:0,sightings:0});console.log(JSON.stringify({success:true,receipts:rows.length,states:rows.map(r=>r.review),native:await native(),processId:process.pid}));return;
        }
        assert.equal(phase,'acceptance');await wait(3163);
        assert.equal((await request(3163,`${prefix}/cards`)).status,503);assert.equal(await schema(),false);pass('wired external test bindings alone cannot open routes or create schema',()=>{});
        setGates({intake:true,limits:{perSourceHour:3}});
        assert.equal((await request(3163,`${prefix}/tips`,{body:{}})).status,403);pass('unverified caller cannot enter even when intake flag is on',()=>{});
        const tips=[payload('LOST','private_linux_lost_case_001'),payload('FOUND','private_linux_found_case_001'),payload('SIGHTING','private_linux_sighting_case_001',true)],receipts=[];
        const submit=(tip,key)=>request(3163,`${prefix}/tips`,{body:tip,headers:{...sourceHeaders,'Idempotency-Key':key}});
        for(let i=0;i<3;i++){const r=await submit(tips[i],`linux_pending_key_${i}_0001`);assert.equal(r.status,202,JSON.stringify(r.json));assert.equal(r.json.receipt.status,'PENDING');assert.equal(r.json.receipt.publicVisible,false);receipts.push(r.json.receipt);}
        pass('three independent text-only cases persist pending receipts',()=>assert.equal(new Set(receipts.map(r=>r.tipId)).size,3));
        const replay=await submit(tips[0],'linux_pending_key_0_0001');assert.deepEqual(replay.json.receipt,receipts[0]);assert.equal(replay.json.replay,true);
        const again=await submit(tips[0],'linux_pending_key_again_001');assert.deepEqual(again.json.receipt,receipts[0]);pass('request retry and same-case new request key retain original receipt',()=>{});
        const peer={...tips[0],source:{...tips[0].source,datasetId:peerPolicy.datasetId}};
        assert.equal((await request(3163,`${prefix}/tips`,{body:peer,headers:{'x-local-qa-principal':'peer-dataset','Idempotency-Key':'linux_pending_key_0_0001'}})).status,409);
        pass('publisher/key cannot create another receipt by switching dataset',()=>{});
        assert.equal((await submit({...tips[0],display:{...tips[0].display,title:'Conflicting invented text'}},'linux_pending_key_0_0001')).status,409);
        assert.equal((await submit(payload('LOST','private_linux_fourth_case_001'),'linux_pending_fourth_key_001')).status,429);pass('conflict and bounded per-source rate are enforced by SQL',()=>{});
        for(const bad of [{...tips[0],photos:[{url:'https://unlicensed.example.invalid/p.jpg'}]},{...tips[0],location:{...tips[0].location,latitude:0,longitude:0}},{...tips[0],source:{...tips[0].source,url:'https://qa.example.invalid/cases/test'}},{...tips[0],animal:{...tips[0].animal,kind:'WILDLIFE'}}])assert.equal((await submit(bad,'linux_pending_bad_key_001')).status,400);
        const large=await request(3163,`${prefix}/tips`,{raw:'x'.repeat(16385),headers:{...sourceHeaders,'Idempotency-Key':'linux_pending_large_001'}});assert.equal(large.status,413);
        const mime=await request(3163,`${prefix}/tips`,{raw:'{}',headers:{...sourceHeaders,'Content-Type':'application/octet-stream','Idempotency-Key':'linux_pending_mime_001'}});assert.equal(mime.status,415);pass('photos, URLs, points, wildlife, oversized and unsupported MIME are rejected',()=>{});
        setGates({intake:true,review:true,publicRead:true});let cards=(await request(3163,`${prefix}/cards`)).json.cards;assert.deepEqual(cards,[]);pass('public-read flag cannot expose pending cases',()=>{});
        const blocker=await pool.connect();try{await blocker.query('BEGIN');await blocker.query("SELECT pg_advisory_xact_lock(hashtextextended('TEXT_COARSE_PENDING_V1:queue',0))");
            const begin=Date.now(),blocked=[0,1].map(i=>submit(payload('LOST',`private_linux_blocked_${i}_001`),`linux_blocked_request_${i}_001`));
            await new Promise(resolve=>setTimeout(resolve,100));blocked.push(submit(payload('LOST','private_linux_blocked_2_001'),'linux_blocked_request_2_001'));
            const responses=await Promise.all(blocked);for(const response of responses)assert.equal(response.status,503);assert.ok(Date.now()-begin<6000);
        }finally{await blocker.query('ROLLBACK');blocker.release();}
        assert.equal((await pool.query('SELECT count(*)::int n FROM stray_text_pilot.tips')).rows[0].n,3);
        assert.equal((await pool.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory' AND state='active'")).rows[0].n,0);
        pass('actual PG lock and pool waits terminate with no delayed insert or lingering lock query',()=>{});
        const review=(id,body,headers=reviewHeaders)=>request(3163,`${prefix}/review/${id}`,{body,headers});
        const approved=i=>({decision:'APPROVE',checks:Object.fromEntries(checks.map(k=>[k,true])),display:tips[i].display});
        assert.equal((await review(receipts[0].tipId,approved(0),sourceHeaders)).status,403);assert.equal((await review(receipts[0].tipId,{decision:'APPROVE',display:tips[0].display})).status,403);
        assert.equal((await review(receipts[0].tipId,{...approved(0),display:{...tips[0].display,description:'Contact internal@example.invalid'}})).status,403);pass('reviewer identity, manual checklist and separate safe public text are required',()=>{});
        assert.equal((await review(receipts[0].tipId,approved(0))).status,200);assert.equal((await review(receipts[1].tipId,approved(1))).status,200);assert.equal((await review(receipts[2].tipId,{decision:'REJECT'})).status,200);
        cards=(await request(3163,`${prefix}/cards`)).json.cards;assert.equal(cards.length,2);for(const card of cards){assert.equal(card.location.coordinates,null);assert.equal(card.mapMarkerEligible,false);assert.deepEqual(card.photos,[]);assert.equal(card.display.locale,'en-US');assert.equal(card.observation.precision,'DATE');}
        assert.equal(cards.find(c=>c.report.type==='FOUND').report.custody.asOf.precision,'DATE');assert.ok(!JSON.stringify(cards).includes('recordKey'));assert.ok(!JSON.stringify(cards).includes('publisherId'));pass('only approved original-language coarse cards appear; no native pin or media projection',()=>{});
        const before=(await pool.query('SELECT id,review,receipt FROM stray_text_pilot.tips ORDER BY id')).rows;setGates({});
        for(const p of [`${prefix}/cards`,`${prefix}/receipts/${receipts[0].tipId}`])assert.equal((await request(3163,p)).status,503);
        assert.equal((await submit(tips[0],'linux_pending_rollback_key_001')).status,503);assert.equal((await review(receipts[0].tipId,{decision:'WITHDRAW'})).status,503);
        assert.deepEqual((await pool.query('SELECT id,review,receipt FROM stray_text_pilot.tips ORDER BY id')).rows,before);pass('rollback closes intake, review and public read while retaining every record',()=>{});
        setGates({intake:true});assert.deepEqual((await submit(tips[0],'linux_pending_key_0_0001')).json.receipt,receipts[0]);assert.equal((await request(3163,`${prefix}/cards`)).status,503);pass('explicit intake-only recovery replays receipt without reopening publication',()=>{});
        setGates({intake:true,review:true,publicRead:true});for(let i=0;i<2;i++)assert.equal((await review(receipts[i].tipId,{decision:'WITHDRAW'})).status,200);
        assert.deepEqual((await request(3163,`${prefix}/cards`)).json.cards,[]);assert.equal((await review(receipts[2].tipId,approved(2))).status,409);assert.deepEqual((await submit(tips[0],'linux_pending_after_withdraw_001')).json.receipt,receipts[0]);pass('withdrawn/rejected cases stay hidden and source replay cannot approve them',()=>{});
        await compareLegacy();assert.deepEqual(await native(),{devices:0,animals:0,sightings:0});pass('legacy status/body behavior and empty native tables remain unchanged',()=>{});
        fs.writeFileSync('/test-runtime/receipts.expected.json',JSON.stringify(receipts));setGates({});
        console.log(JSON.stringify({success:true,checks:result,receipts:3,native:await native(),productionIdentityVerified:false,fixtureBindingsPackaged:false,processId:process.pid}));
    }finally{await pool.end();}
}
if(require.main===module)main(process.argv[2]).catch(error=>{console.error(error.stack);process.exitCode=1});
module.exports={activate};
