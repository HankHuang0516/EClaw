#!/usr/bin/env node
'use strict';
// Actual runtime-source rebuild + NEW isolated adapter. All DB/storage/network resources are synthetic/local.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { spawn, execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { PendingService, checks, digest } = require('./pending-service.cjs');
const f = require('../stray-map-intake/synthetic-fixtures');
const c = require('../stray-map-intake/case-fixtures');
const DOCKER_IMAGE = 'postgis/postgis:17-3.5';
const nativeId = '00000000-0000-4000-8000-000000000002';
const fixtureDevice = '00000000-0000-4000-8000-000000000001';
const nativeMarker = 'SYNTHETIC_REBUILD_NATIVE_APPROVED';
const pause = ms => new Promise(resolve => setTimeout(resolve,ms));
const cli = args => execFileSync('docker',args,{encoding:'utf8',timeout:30000}).trim();
const write = (root,name,value) => fs.writeFileSync(path.join(root,name),JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:'wx'});
function cleanEnv(extra) {
    const env = Object.fromEntries(['PATH','LANG','TZ'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
    return { ...env,...extra };
}
async function freePort() { const s=net.createServer();await new Promise(resolve=>s.listen(0,'127.0.0.1',resolve));const p=s.address().port;await new Promise(resolve=>s.close(resolve));return p; }
async function request(url,options={}) {
    const u=new URL(url);if(u.protocol!=='http:'||u.hostname!=='127.0.0.1')throw Error('LOCAL_HTTP_ONLY');
    const response=await fetch(url,{...options,redirect:'error',headers:{...options.headers,Connection:'close'},signal:AbortSignal.timeout(5000)});
    const bytes=Buffer.from(await response.arrayBuffer());return {status:response.status,type:response.headers.get('content-type'),bytes,
        json:response.headers.get('content-type')?.includes('json')?JSON.parse(bytes.toString()):null};
}
async function body(req,max=16384) {const chunks=[];let n=0;for await(const chunk of req){n+=chunk.length;if(n>max){const error=Error('BODY_TOO_LARGE');error.status=413;throw error}chunks.push(chunk)}return Buffer.concat(chunks)}
function serve(server,where) {return new Promise((resolve,reject)=>{server.once('error',reject);server.listen(where,resolve)})}
function close(server) {return server?new Promise(resolve=>server.close(resolve)):Promise.resolve()}
async function main(root) {
    assert.ok(path.isAbsolute(root));const prep=JSON.parse(fs.readFileSync(path.join(root,'PREPARE_RESULT.private.json'),'utf8'));
    assert.equal(prep.readyForSyntheticIntegration,true,'complete fresh-ci and provenance checks first');
    const workspace=prep.paths.workspace;assert.equal(workspace,path.join(root,'workspace'));
    const emitted=JSON.parse(fs.readFileSync(path.join(root,'FIRST_BUILD_OUTPUTS.private.json'),'utf8'));
    assert.equal(Object.keys(emitted).length,31);
    for(const [relative,hash] of Object.entries(emitted)){
        assert.ok(/^(apps\/api|packages\/contracts)\/dist\/[A-Za-z0-9_./-]+$/.test(relative)&&!relative.includes('..'));
        assert.equal(digest(fs.readFileSync(path.join(workspace,relative))),hash,'compiled output drift');
    }
    assert.equal(process.versions.node,'22.23.3','run this with the pinned reconstruction Node');
    const localRequire=createRequire(path.join(workspace,'apps/api/package.json'));const {Pool}=localRequire('pg');const sharp=localRequire('sharp');
    const ctx=JSON.parse(cli(['context','inspect','--format','{{json .Endpoints.docker.Host}}']));
    const info=JSON.parse(cli(['info','--format','{{json .OperatingSystem}}']));
    assert.ok(ctx.startsWith('unix://')&&/Docker Desktop/i.test(info),'only the existing local Docker Desktop engine is allowed');
    const image=JSON.parse(cli(['image','inspect',DOCKER_IMAGE,'--format','{{json .}}']));
    const runId=randomUUID().slice(0,8), name=`stray-rebuild-${runId}`, network=`stray-rebuild-net-${runId}`;
    const runRoot=path.join(root,`integration-${runId}`);fs.mkdirSync(runRoot,{mode:0o700});
    const schema='stray_map_synthetic', nativeUploads=path.join(runRoot,'native-uploads'), privatePhotos=path.join(runRoot,'private-photos');
    const runtimeHome=path.join(runRoot,'empty-home'),runtimeTmp=path.join(runRoot,'tmp');
    for(const dir of [nativeUploads,privatePhotos,runtimeHome,runtimeTmp])fs.mkdirSync(dir,{mode:0o700});
    let app,pool,gateway,operator;const assertions=[];const check=(name,fn)=>{fn();assertions.push({name,passed:true})};
    // Docker Desktop internal networks do not publish host ports. Dedicated bridge, no outbound masquerading.
    const networkId=cli(['network','create','--driver','bridge','--opt','com.docker.network.bridge.enable_ip_masquerade=false',
        '--opt','com.docker.network.bridge.enable_icc=false','--label',`stray-rebuild=${runId}`,network]);
    const containerId=cli(['run','-d','--pull=never','--platform',`linux/${image.Architecture}`,'--name',name,'--network',network,
        '--label',`stray-rebuild=${runId}`,'-e','POSTGRES_HOST_AUTH_METHOD=trust','-e',`POSTGRES_DB=${schema}`,
        '-p','127.0.0.1::5432',image.Id]);
    write(runRoot,'RESOURCE_OWNERSHIP.private.json',{runId,name,containerId,imageId:image.Id,network,networkId,
        loopbackOnly:true,credentialsCreated:false,syntheticDb:schema});
    try {
        let ready=false;for(let i=0;i<60;i++){try{cli(['exec',name,'pg_isready','-h','127.0.0.1','-U','postgres','-d',schema]);ready=true;break}catch{await pause(500)}}assert.ok(ready);
        const binding=cli(['port',name,'5432/tcp']);assert.match(binding,/^127\.0\.0\.1:\d+$/);const dbPort=Number(binding.split(':').pop());
        const dsn=`postgresql://postgres@localhost:${dbPort}/${schema}`;pool=new Pool({connectionString:dsn,ssl:false,max:4});
        const pg=(await pool.query('SELECT version() v,PostGIS_Version() postgis')).rows[0];write(runRoot,'SYNTHETIC_DB_VERSION.private.json',pg);
        await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())');
        const migrations=fs.readdirSync(path.join(workspace,'apps/api/migrations')).filter(n=>n.endsWith('.sql')).sort();
        for(const migration of migrations){await pool.query(fs.readFileSync(path.join(workspace,'apps/api/migrations',migration),'utf8'));await pool.query('INSERT INTO schema_migrations(name) VALUES($1)',[migration])}
        check('all 12 captured native migrations applied',()=>assert.equal(migrations.length,12));
        // Native foreign keys need one explicitly synthetic seed row. No App device header or posting flow is used.
        await pool.query(`INSERT INTO devices(id) VALUES($1);`,[fixtureDevice]);
        await pool.query(`INSERT INTO animals(id,type,description,created_by_device_id,city,district) VALUES($1,'dog',$2,$3,'Synthetic','Coarse private QA')`,[nativeId,nativeMarker,fixtureDevice]);
        await pool.query(`INSERT INTO sightings(animal_id,created_by_device_id,location,seen_at) VALUES($1,$2,ST_SetSRID(ST_MakePoint(0,0),4326)::geography,'2026-11-26T01:00:00Z')`,[nativeId,fixtureDevice]);
        const nativePort=await freePort();const log=fs.openSync(path.join(runRoot,'native-source-server.private.log'),'wx',0o600);
        const env=cleanEnv({HOME:runtimeHome,TMPDIR:runtimeTmp,NODE_ENV:'test',DATABASE_URL:dsn,PORT:String(nativePort),API_PUBLIC_URL:`http://127.0.0.1:${nativePort}`,
            STORAGE_PROVIDER:'local',UPLOAD_DIR:nativeUploads,TRUST_PROXY:'false',RATE_LIMIT_MAX:'120',
            STRAY_REBUILD_SYNTHETIC:'1',STRAY_REBUILD_PORTS:`${dbPort},${nativePort}`,XDG_CACHE_HOME:path.join(runRoot,'cache')});
        app=spawn(process.execPath,['--require',path.resolve(__dirname,'loopback-guard.cjs'),path.join(workspace,'apps/api/dist/server.js')],{cwd:workspace,env,stdio:['ignore',log,log]});fs.closeSync(log);
        let health;const healthDeadline=Date.now()+120000;
        while(Date.now()<healthDeadline){if(app.exitCode!==null)throw Error('native source exited: see private log');try{health=await request(`http://127.0.0.1:${nativePort}/health`);if(health.status===200)break}catch{}await pause(250)}
        assert.ok(health,'native source did not become ready within the isolated startup limit');
        check('freshly built native health response matches observed public contract',()=>assert.deepEqual(health.json,{ok:true}));
        const share=await request(`http://127.0.0.1:${nativePort}/a/${nativeId}?lang=en`);
        check('captured native share code reads only synthetic approved fixture',()=>{assert.equal(share.status,200);assert.ok(share.bytes.includes(Buffer.from(nativeMarker)))});
        const terms=await request(`http://127.0.0.1:${nativePort}/v1/terms?lang=zh-Hant`);
        check('native legal version from captured migrations remains unchanged',()=>{assert.equal(terms.status,200);assert.equal(terms.json.terms,'2026-09-14.1')});
        const noDevice=await request(`http://127.0.0.1:${nativePort}/v1/animals`);
        check('native device gate retained; no anonymous device impersonation',()=>assert.equal(noDevice.status,400));
        const {LocalStorageProvider}=await import(pathToFileURL(path.join(workspace,'apps/api/dist/storage/local.js')).href);
        const storage=new LocalStorageProvider(privatePhotos,'http://127.0.0.1/private-unserved');
        const pixels=Buffer.alloc(128*96*3);for(let i=0;i<pixels.length;i++)pixels[i]=i%251;
        const original=await sharp(pixels,{raw:{width:128,height:96,channels:3}}).withExif({IFD0:{Artist:'SYNTHETIC_REBUILD_PIXELS'},
            IFD3:{GPSLatitudeRef:'N',GPSLatitude:'0/1 0/1 0/1',GPSLongitudeRef:'E',GPSLongitude:'0/1 0/1 0/1'}}).png().toBuffer();
        fs.writeFileSync(path.join(runRoot,'self-made-original.private.png'),original,{mode:0o600});
        const originalMetadata=await sharp(original).metadata();assert.ok(originalMetadata.exif);
        const tip=c.caseTip('SIGHTING');const grant={synthetic:true,license:'EXPLICIT_PERMISSION',originalHash:digest(original),context:tip.source};
        const serviceOptions={pool,sourcePolicies:[{...f.policy},{...f.peerPolicy}],now:()=>f.SUBMITTED,knownSyntheticPixelHashes:[digest(original)]};
        let service=new PendingService(serviceOptions);await service.init();
        const photograph=await service.addSyntheticPhoto(original,'image/png',grant,storage,sharp);assert.ok(photograph.success);
        check('captured LocalStorageProvider strips EXIF/GPS in actual codec path',()=>assert.equal(photograph.afterMime,'jpeg'));
        tip.photos=[{uploadId:photograph.uploadId,rights:photograph.rights,caption:'自製合成像素，不是真實動物照片。'}];
        const missing=await service.addSyntheticPhoto(original,'image/png',null,storage,sharp);
        const wrong=await service.addSyntheticPhoto(original,'image/jpeg',grant,storage,sharp);
        check('missing photo grant and wrong declared MIME refused',()=>{assert.equal(missing.success,false);assert.equal(wrong.status,415)});
        const json=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value))};
        gateway=http.createServer(async(req,res)=>{try{
            const u=new URL(req.url,'http://127.0.0.1');
            if(req.method==='POST'&&u.pathname==='/v1/public/tips'){
                if(!/^application\/json(?:;\s*charset=utf-8)?$/i.test(req.headers['content-type']||''))return json(res,415,{success:false,error:'JSON_CONTENT_TYPE_REQUIRED'});
                const v=await service.accept(await body(req),req.headers['idempotency-key']);return json(res,v.status||202,v)}
            const receipt=u.pathname.match(/^\/v1\/public\/tip-receipts\/(tip_[a-f0-9]{32})$/);
            if(req.method==='GET'&&receipt){const v=await service.getReceipt(receipt[1]);return json(res,v.status||200,v)}
            const pub=u.pathname.match(/^\/v1\/public\/tips\/(tip_[a-f0-9]{32})$/);
            if(req.method==='GET'&&pub){const v=await service.publicTip(pub[1]);return json(res,v.status||200,v)}
            const media=u.pathname.match(/^\/v1\/public\/tip-photos\/(up_[a-f0-9]{32})$/);
            if(req.method==='GET'&&media){const bytes=await service.publicPhoto(media[1]);if(!bytes)return json(res,404,{success:false,error:'NOT_FOUND'});res.writeHead(200,{'Content-Type':'image/jpeg','Cache-Control':'no-store'});return res.end(bytes)}
            if(req.method!=='GET')return json(res,404,{success:false,error:'NOT_FOUND'});
            const upstream=await request(`http://127.0.0.1:${nativePort}${u.pathname}${u.search}`);res.writeHead(upstream.status,{'Content-Type':upstream.type||'application/octet-stream'});res.end(upstream.bytes);
        }catch(error){return json(res,error.status===413?413:500,{success:false,error:error.status===413?'PAYLOAD_TOO_LARGE':'ISOLATED_FAILURE'})}});
        gateway.requestTimeout=5000;gateway.headersTimeout=5000;
        await serve(gateway,{port:0,host:'127.0.0.1'});const base=`http://127.0.0.1:${gateway.address().port}`;
        const socket=path.join('/tmp',`stray-rebuild-op-${runId}.sock`);
        operator=http.createServer(async(req,res)=>{try{const data=JSON.parse((await body(req)).toString());const v=await service.decide(data.tipId,data.action,data.checks);json(res,v.status>=400?v.status:200,v)}catch{json(res,400,{success:false,error:'INVALID_LOCAL_REVIEW'})}});
        await serve(operator,socket);fs.chmodSync(socket,0o600);
        const operate=data=>new Promise((resolve,reject)=>{const q=http.request({socketPath:socket,path:'/',method:'POST',headers:{'Content-Type':'application/json'}},res=>{const b=[];res.on('data',x=>b.push(x));res.on('end',()=>resolve(JSON.parse(Buffer.concat(b))))});q.on('error',reject);q.end(JSON.stringify(data))});
        const post=payload=>request(`${base}/v1/public/tips`,{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':'synthetic_rebuild_request_001'},body:JSON.stringify(payload)});
        const wrongType=await request(`${base}/v1/public/tips`,{method:'POST',headers:{'Content-Type':'text/plain'},body:'{}'});
        const tooLarge=await request(`${base}/v1/public/tips`,{method:'POST',headers:{'Content-Type':'application/json'},body:'x'.repeat(16385)});
        check('actual HTTP refuses wrong MIME and oversized JSON',()=>{assert.equal(wrongType.status,415);assert.equal(tooLarge.status,413)});
        const accepted=await post(tip);assert.equal(accepted.status,202);const receipt=accepted.json.receipt;const id=receipt.tipId;
        const nativeProbe=id.slice(4).replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/,'$1-$2-$3-$4-$5');
        check('durable pending receipt returned before approval',()=>{assert.equal(receipt.status,'PENDING');assert.equal(receipt.publicVisible,false)});
        check('pending tip and photo absent from anonymous reads',()=>{});
        assert.equal((await request(`${base}/v1/public/tips/${id}`)).status,404);assert.equal((await request(`${base}/v1/public/tip-photos/${photograph.uploadId}`)).status,404);
        assert.equal((await request(`${base}/a/${nativeProbe}`)).status,404);
        const paths=fs.readdirSync(privatePhotos);assert.ok(paths.length);for(const filename of paths)assert.equal((await request(`${base}/uploads/${filename}`)).status,404);
        const replies=await Promise.all(Array.from({length:8},()=>post(tip)));
        check('parallel retries return the exact original persisted receipt',()=>assert.ok(replies.every(v=>JSON.stringify(v.json.receipt)===JSON.stringify(receipt))));
        // New controller instance reads PostgreSQL, with no file-store or in-memory receipt cache.
        service=new PendingService(serviceOptions);
        check('receipt survives controller replacement from actual PostgreSQL',()=>{});assert.deepEqual((await service.getReceipt(id)).receipt,receipt);
        const probe=JSON.parse(execFileSync(process.execPath,['--require',path.resolve(__dirname,'loopback-guard.cjs'),
            path.join(__dirname,'receipt-probe.cjs'),workspace,id],{encoding:'utf8',timeout:10000,
            env:cleanEnv({HOME:runtimeHome,TMPDIR:runtimeTmp,DATABASE_URL:dsn,STRAY_REBUILD_SYNTHETIC:'1',STRAY_REBUILD_PORTS:String(dbPort)})}));
        check('new independent process reads the identical durable pending receipt',()=>assert.deepEqual(probe.receipt,receipt));
        const badReview=await operate({tipId:id,action:'APPROVE',checks:{}});assert.equal(badReview.error,'REVIEW_CHECKS_REQUIRED');
        assert.equal((await request(`${base}/v1/public/tips/${id}`)).status,404);
        const approved=await operate({tipId:id,action:'APPROVE',checks:Object.fromEntries(checks.map(key=>[key,true]))});assert.ok(approved.publicVisible);
        const published=await request(`${base}/v1/public/tips/${id}`), publishedPhoto=await request(`${base}/v1/public/tip-photos/${photograph.uploadId}`);
        check('explicit local supervisor approval makes only the new external read route visible',()=>{assert.equal(published.status,200);assert.equal(publishedPhoto.status,200)});
        const clean=await sharp(publishedPhoto.bytes).metadata();assert.ok(!clean.exif&&!clean.xmp&&!clean.icc&&!clean.orientation);
        for(const key of ['publisherId','datasetId','recordKey','evidenceRef','latitude','longitude'])assert.ok(!JSON.stringify(published.json).includes(key));
        assert.deepEqual(published.json.tip.display,tip.display);assert.deepEqual(published.json.tip.observation,tip.observation);
        assert.equal((await request(`${base}/a/${nativeProbe}`)).status,404);
        const counts=(await pool.query('SELECT (SELECT count(*)::int FROM devices) devices,(SELECT count(*)::int FROM animals) animals')).rows[0];
        check('external intake never writes native animals or impersonates a device',()=>assert.deepEqual(counts,{devices:1,animals:1}));
        await operate({tipId:id,action:'WITHDRAW'});
        check('withdrawn tip and photo become unreadable',()=>{});assert.equal((await request(`${base}/v1/public/tips/${id}`)).status,404);assert.equal((await request(`${base}/v1/public/tip-photos/${photograph.uploadId}`)).status,404);
        assert.deepEqual((await post(tip)).json.receipt,receipt);
        const changed=JSON.parse(JSON.stringify(tip));changed.display.title+=' changed';assert.equal((await post(changed)).status,409);
        const postNew=(payload,key)=>request(`${base}/v1/public/tips`,{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':key},body:JSON.stringify(payload)});
        const rejectedTip=c.caseTip('FOUND');const rejected=await postNew(rejectedTip,'synthetic_rejected_request_001');assert.equal(rejected.status,202);
        await operate({tipId:rejected.json.receipt.tipId,action:'REJECT'});
        assert.equal((await request(`${base}/v1/public/tips/${rejected.json.receipt.tipId}`)).status,404);
        check('rejected case cannot be approved by later replay',()=>{});
        assert.equal((await operate({tipId:rejected.json.receipt.tipId,action:'APPROVE',checks:Object.fromEntries(checks.map(key=>[key,true]))})).error,'REVIEW_TERMINAL');
        const sensitive=c.caseTip('SIGHTING');sensitive.source.recordKey='private_synthetic_sensitive_001';sensitive.location.sensitivity='HABITAT';sensitive.animal.kind='WILDLIFE';
        const held=await postNew(sensitive,'synthetic_sensitive_request_001');assert.equal(held.status,202);
        const heldReview=await operate({tipId:held.json.receipt.tipId,action:'APPROVE',checks:Object.fromEntries(checks.map(key=>[key,true]))});
        assert.equal(heldReview.status,'APPROVED_PRIVATE');assert.equal((await request(`${base}/v1/public/tips/${held.json.receipt.tipId}`)).status,404);
        check('wildlife or habitat case remains private after review',()=>assert.equal(heldReview.publicVisible,false));
        const revokedSource=c.caseTip('SIGHTING');revokedSource.source.recordKey='private_synthetic_revoked_source_001';
        const sourceReceipt=await postNew(revokedSource,'synthetic_revoked_source_001');assert.equal(sourceReceipt.status,202);
        service.policies[0].verified=false;
        const refusedSource=await operate({tipId:sourceReceipt.json.receipt.tipId,action:'APPROVE',checks:Object.fromEntries(checks.map(key=>[key,true]))});
        service.policies[0].verified=true;
        check('current source revocation blocks approval despite all manual checks',()=>assert.equal(refusedSource.error,'REVIEW_EVIDENCE_INVALID'));
        assert.equal((await request(`${base}/v1/public/tips/${sourceReceipt.json.receipt.tipId}`)).status,404);
        const revokedPhoto=c.caseTip('SIGHTING');revokedPhoto.source.recordKey='private_synthetic_revoked_photo_001';
        const proof=await service.addSyntheticPhoto(original,'image/png',{...grant,context:revokedPhoto.source},storage,sharp);assert.ok(proof.success);
        revokedPhoto.photos=[{uploadId:proof.uploadId,rights:proof.rights,caption:'自製測試像素，測試證據撤銷。'}];
        const photoReceipt=await postNew(revokedPhoto,'synthetic_revoked_photo_001');assert.equal(photoReceipt.status,202);
        await pool.query('DELETE FROM rebuild_external.photos WHERE id=$1',[proof.uploadId]);
        const refusedPhoto=await operate({tipId:photoReceipt.json.receipt.tipId,action:'APPROVE',checks:Object.fromEntries(checks.map(key=>[key,true]))});
        check('removed photo evidence blocks approval inside the database transaction',()=>assert.equal(refusedPhoto.error,'REVIEW_EVIDENCE_INVALID'));
        assert.equal((await request(`${base}/v1/public/tips/${photoReceipt.json.receipt.tipId}`)).status,404);
        assert.equal((await request(`${base}/v1/public/tip-photos/${proof.uploadId}`)).status,404);
        const nativeCountsAfter=(await pool.query('SELECT (SELECT count(*)::int FROM devices) devices,(SELECT count(*)::int FROM animals) animals')).rows[0];
        assert.deepEqual(nativeCountsAfter,{devices:1,animals:1});
        const result={success:true,simulation:true,node:process.version,nativeSourceFilesChanged:false,checks:assertions,
            database:'OWN_SYNTHETIC_POSTGIS_ONLY',nativeDeviceRowsFromFixtureOnly:1,externalNativeAnimalWrites:0,
            receipt,photoEvidence:photograph,nativeHealth:health.json,nativeTermsVersion:terms.json.terms,
            publicTipBeforeWithdrawal:published.json,publication:'NEW_ISOLATED_EXTERNAL_ROUTE_ONLY',
            nativeMapIntegrationVerified:false,semanticPhotoSafetyForRealImagesVerified:false,
            sourceRestored:false,productionEquivalent:false,signature:'UNSIGNED',productionWrites:0,
            limitations:['Original root config/lock/Git/build flags unknown; reconstructed separately',
                'Native device-bound model was not bypassed; no external native map integration',
                'No real NSFW/identity/wildlife-location or author-rights verification',
                'Local storage differs from production Flickr; no live credentials used']};
        write(runRoot,'RESULT.private.json',result);
        const summary={success:true,runRoot,checks:assertions.length,result:path.join(runRoot,'RESULT.private.json')};
        write(root,`INTEGRATION_RESULT-${runId}.private.json`,summary);
        fs.appendFileSync(path.join(root,'INTEGRATION_RESULTS.private.jsonl'),JSON.stringify(summary)+'\n',{mode:0o600});
        if(!fs.existsSync(path.join(root,'INTEGRATION_RESULT.private.json')))write(root,'INTEGRATION_RESULT.private.json',summary);
        console.log(JSON.stringify({success:true,runRoot,checks:assertions.length,node:process.version,productionWrites:0,nativeMapIntegration:false}));
    } catch(error) {
        write(runRoot,'FAILURE.private.json',{success:false,simulation:true,error:error.message,productionWrites:0});
        throw error;
    } finally {
        await close(operator);await close(gateway);if(app&&app.exitCode===null){app.kill('SIGTERM');await Promise.race([new Promise(resolve=>app.once('exit',resolve)),pause(3000)]);if(app.exitCode===null)app.kill('SIGKILL')}
        if(pool)await pool.end();
        const own=JSON.parse(cli(['inspect',name,'--format','{{json .Config.Labels}}']));
        if(own['stray-rebuild']===runId)cli(['stop','--time','5',name]);
        // Keep the stopped synthetic container/data as review evidence; never stop/remove another resource.
    }
}
if(require.main===module)main(process.argv[2]).catch(error=>{console.error(error.stack);process.exitCode=1});
module.exports={main,cleanEnv};
