'use strict';
const fs=require('node:fs'),path=require('node:path'),net=require('node:net'),assert=require('node:assert/strict');
const {spawn,execFileSync}=require('node:child_process');
const {createRequire}=require('node:module');
const {randomUUID}=require('node:crypto');
const {digest}=require('./pending-service.cjs');
const {cleanEnv}=require('./integration.cjs');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const docker=args=>execFileSync('docker',args,{encoding:'utf8',timeout:30000}).trim();
const write=(root,file,value)=>fs.writeFileSync(path.join(root,file),JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:'wx'});
async function freePort(){const server=net.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;}
async function request(url,options={}){
    const u=new URL(url);if(u.protocol!=='http:'||u.hostname!=='127.0.0.1')throw Error('LOCAL_HTTP_ONLY');
    const response=await fetch(url,{...options,redirect:'error',headers:{...options.headers,Connection:'close'},signal:AbortSignal.timeout(10000)});
    const bytes=Buffer.from(await response.arrayBuffer());return {status:response.status,type:response.headers.get('content-type'),headers:Object.fromEntries(response.headers),bytes,
        json:response.headers.get('content-type')?.includes('json')&&bytes.length?JSON.parse(bytes):null};
}
async function create(root,{evidenceRoot=root,kind='single-path'}={}){
    assert.equal(process.versions.node,'22.23.3');assert.ok(path.isAbsolute(root)&&fs.realpathSync(root)===root);
    const prep=JSON.parse(fs.readFileSync(path.join(root,'PREPARE_RESULT.private.json')));assert.equal(prep.readyForSyntheticIntegration,true);
    const workspace=prep.paths.workspace;assert.equal(workspace,path.join(root,'workspace'));
    const outputs=JSON.parse(fs.readFileSync(path.join(root,'FIRST_BUILD_OUTPUTS.private.json')));
    for(const [relative,hash] of Object.entries(outputs)){assert.ok(/^(apps\/api|packages\/contracts)\/dist\/[\w./-]+$/.test(relative)&&!relative.includes('..'));assert.equal(digest(fs.readFileSync(path.join(workspace,relative))),hash);}
    const localRequire=createRequire(path.join(workspace,'apps/api/package.json')), {Pool}=localRequire('pg'), sharp=localRequire('sharp');
    assert.ok(JSON.parse(docker(['context','inspect','--format','{{json .Endpoints.docker.Host}}'])).startsWith('unix://'));
    assert.match(JSON.parse(docker(['info','--format','{{json .OperatingSystem}}'])),/Docker Desktop/i);
    const image=JSON.parse(docker(['image','inspect','postgis/postgis:17-3.5','--format','{{json .}}']));
    assert.ok(['single-path','readiness'].includes(kind)&&path.isAbsolute(evidenceRoot)&&fs.realpathSync(evidenceRoot)===evidenceRoot);
    const runId=randomUUID().slice(0,8),name=`stray-single-${runId}`,network=`stray-single-net-${runId}`,runRoot=path.join(evidenceRoot,`${kind}-${runId}`);
    fs.mkdirSync(runRoot,{mode:0o700});const directories={};for(const key of ['empty-home','tmp','native-uploads','private-photos']){directories[key]=path.join(runRoot,key);fs.mkdirSync(directories[key],{mode:0o700});}
    docker(['network','create','--driver','bridge','--opt','com.docker.network.bridge.enable_ip_masquerade=false','--opt','com.docker.network.bridge.enable_icc=false','--label',`stray-single=${runId}`,network]);
    const id=docker(['run','-d','--pull=never','--platform',`linux/${image.Architecture}`,'--name',name,'--network',network,'--label',`stray-single=${runId}`,
        '-e','POSTGRES_HOST_AUTH_METHOD=trust','-e','POSTGRES_DB=stray_map_synthetic','-p','127.0.0.1::5432',image.Id]);
    write(runRoot,'RESOURCE_OWNERSHIP.private.json',{runId,name,id,network,imageId:image.Id,loopbackOnly:true,newCredentials:false});
    const resource={root,runRoot,runId,name,network,workspace,sharp,localRequire,directories,child:null,pool:null};
    try{
        let ready=false;for(let i=0;i<60;i++){try{docker(['exec',name,'pg_isready','-h','127.0.0.1','-U','postgres','-d','stray_map_synthetic']);ready=true;break}catch{await pause(500)}}assert.ok(ready);
        const binding=docker(['port',name,'5432/tcp']);assert.match(binding,/^127\.0\.0\.1:\d+$/);resource.dbPort=Number(binding.split(':').pop());
        resource.dsn=`postgresql://postgres@localhost:${resource.dbPort}/stray_map_synthetic`;resource.pool=new Pool({connectionString:resource.dsn,ssl:false,max:8});
        await resource.pool.query('CREATE TABLE schema_migrations(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())');
        const migrations=fs.readdirSync(path.join(workspace,'apps/api/migrations')).filter(n=>n.endsWith('.sql')).sort();assert.equal(migrations.length,12);
        for(const file of migrations){await resource.pool.query(fs.readFileSync(path.join(workspace,'apps/api/migrations',file),'utf8'));await resource.pool.query('INSERT INTO schema_migrations(name) VALUES($1)',[file]);}
        write(runRoot,'DATABASE.private.json',{synthetic:true,migrations:12,version:(await resource.pool.query('SELECT version(),PostGIS_Version() postgis')).rows[0]});
        return resource;
    }catch(error){await stop(resource);throw error;}
}
function environment(resource,extra={}){return cleanEnv({HOME:resource.directories['empty-home'],TMPDIR:resource.directories.tmp,
    NODE_ENV:'test',DATABASE_URL:resource.dsn,STORAGE_PROVIDER:'local',UPLOAD_DIR:resource.directories['native-uploads'],TRUST_PROXY:'false',
    STRAY_REBUILD_SYNTHETIC:'1',STRAY_REBUILD_PORTS:[resource.dbPort,resource.nativePort].filter(Boolean).join(','),...extra});}
async function start(resource,entry){
    resource.nativePort=await freePort();resource.base=`http://127.0.0.1:${resource.nativePort}`;
    const log=fs.openSync(path.join(resource.runRoot,'native-server.private.log'),'wx',0o600);
    resource.child=spawn(process.execPath,['--require',path.join(__dirname,'loopback-guard.cjs'),entry],{
        cwd:resource.workspace,env:environment(resource,{PORT:String(resource.nativePort),API_PUBLIC_URL:resource.base,RATE_LIMIT_MAX:'200'}),stdio:['ignore',log,log]});fs.closeSync(log);
    const deadline=Date.now()+120000;while(Date.now()<deadline){if(resource.child.exitCode!==null)throw Error('NATIVE_EXTENSION_EXITED_SEE_PRIVATE_LOG');
        try{const health=await request(`${resource.base}/health`);if(health.status===200){assert.deepEqual(health.json,{ok:true});return resource.base;}}catch{}await pause(250);}
    throw Error('NATIVE_EXTENSION_STARTUP_TIMEOUT');
}
async function stop(resource){
    if(resource.child&&resource.child.exitCode===null){resource.child.kill('SIGTERM');await Promise.race([new Promise(resolve=>resource.child.once('exit',resolve)),pause(3000)]);if(resource.child.exitCode===null)resource.child.kill('SIGKILL');}
    if(resource.pool)await resource.pool.end();
    const own=JSON.parse(docker(['inspect',resource.name,'--format','{{json .}}']));
    if(own.Config.Labels['stray-single']!==resource.runId)throw Error('RESOURCE_OWNER_CHANGED');
    if(own.State.Running)docker(['stop','--time','5',resource.name]);
    write(resource.runRoot,'CLEANUP.private.json',{ownContainerStopped:true,nativeProcessStopped:true,otherResourcesTouched:false,privateEvidenceRetained:true});
}
module.exports={create,start,stop,environment,request,write};
