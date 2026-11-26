'use strict';
// Owned, network-disabled containers only. This test driver is NOT part of the candidate artifact.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process'),{randomUUID}=require('node:crypto');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const docker=args=>execFileSync('docker',args,{encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024}).trim();
async function main(root){
    assert.equal(fs.realpathSync(root),root);assert.ok(root.startsWith('/Volumes/ProjectsData/portfolio-private-staging/'));
    const image='node@'+JSON.parse(fs.readFileSync(path.join(root,'BASE_IMAGE.private.json'))).amd64Digest;
    assert.ok(fs.existsSync(path.join(root,'candidate/apps/api/server.text-pilot.mjs')));
    const id=randomUUID().slice(0,8),run=path.join(root,`acceptance-${id}`);fs.mkdirSync(run,{mode:0o700});
    const put=(name,obj)=>fs.writeFileSync(path.join(run,name),JSON.stringify(obj,null,2)+'\n',{mode:0o600});
    const pgImage=JSON.parse(docker(['image','inspect','postgis/postgis:17-3.5','--format','{{json .}}']));
    const pgName=`stray-linux-pg-${id}`,names=[];
    const gates={profile:'TEXT_COARSE_PENDING_V1',intake:false,review:false,publicRead:false};put('gates.json',gates);
    fs.symlinkSync('/candidate/node_modules',path.join(run,'node_modules'));
    const native=fs.readFileSync(path.join(root,'candidate/apps/api/dist/server.js'),'utf8'),anchor='const deviceIdSchema = z.uuid();';assert.equal(native.split(anchor).length,2);
    const boot='// EXTERNAL TEST ENTRY ONLY; never included in candidate.\nconst activation=await import("/test/linux-pilot-test.cjs");\nawait activation.default.activate(app,pool);\n';
    fs.writeFileSync(path.join(run,'server.enabled.mjs'),native.replace(/from "\.\//g,'from "/candidate/apps/api/dist/').replace(anchor,boot+anchor));
    const baseArgs=['--platform','linux/amd64','--cap-drop=ALL','--security-opt=no-new-privileges','--read-only','--user',`${process.getuid()}:${process.getgid()}`,
        '--tmpfs',`/tmp:rw,nosuid,nodev,size=256m,uid=${process.getuid()},gid=${process.getgid()}`,
        '--mount',`type=bind,source=${path.join(root,'candidate')},target=/candidate,readonly`,
        '--mount',`type=bind,source=${__dirname},target=/test,readonly`,
        '--mount',`type=bind,source=${run},target=/test-runtime`,
        '--mount',`type=bind,source=${path.join(root,'../baseline/apps/api/migrations')},target=/native-migrations,readonly`,
        '-e','HOME=/tmp','-e','TMPDIR=/tmp','-e','NODE_ENV=test','-e','DATABASE_URL=postgresql://postgres@localhost:5432/stray_map_linux_pilot_test',
        '-e','STORAGE_PROVIDER=local','-e','UPLOAD_DIR=/tmp/uploads','-e','TRUST_PROXY=false','-e','RATE_LIMIT_MAX=1000',
        '-e','STRAY_REBUILD_SYNTHETIC=1','-e','STRAY_REBUILD_PORTS=5432,3161,3162,3163'];
    function runner(phase){const text=docker(['run','--rm',...baseArgs,'--network',`container:${pgName}`,image,'node','--require','/test/loopback-guard.cjs','/test/linux-pilot-test.cjs',phase]);
        fs.writeFileSync(path.join(run,`${phase}.private.log`),text+'\n');return JSON.parse(text.split('\n').at(-1));}
    function start(kind,port,entry){const name=`stray-linux-${kind}-${id}`;docker(['run','-d',...baseArgs,'--name',name,'--label',`stray-linux=${id}`,'--network',`container:${pgName}`,
        '-e',`PORT=${port}`,'-e',`API_PUBLIC_URL=http://127.0.0.1:${port}`,image,'node','--require','/test/loopback-guard.cjs',entry]);names.push(name);}
    try{
        docker(['run','-d','--pull=never','--platform',`linux/${pgImage.Architecture}`,'--name',pgName,'--label',`stray-linux=${id}`,'--network','none',
            '-e','POSTGRES_HOST_AUTH_METHOD=trust','-e','POSTGRES_DB=stray_map_linux_pilot_test',pgImage.Id,'postgres','-c','listen_addresses=localhost']);names.push(pgName);
        put('OWNERSHIP.private.json',{id,containers:names,hostPorts:[],network:'none + same isolated PG namespace',image,postgresImage:pgImage.Id,postgresArch:pgImage.Architecture});
        let ready=false;for(let n=0;n<60;n++){try{docker(['exec',pgName,'pg_isready','-h','127.0.0.1','-U','postgres','-d','stray_map_linux_pilot_test']);ready=true;break;}catch{await pause(500);}}assert.ok(ready);
        put('MIGRATIONS.private.json',runner('migrate'));
        start('legacy',3161,'/candidate/apps/api/dist/server.js');start('closed',3162,'/candidate/apps/api/server.text-pilot.mjs');
        put('DEFAULT_CLOSED.private.json',runner('default-closed'));
        start('enabled-test',3163,'/test-runtime/server.enabled.mjs');
        const result=runner('acceptance');assert.equal(result.success,true);const persistence=runner('persist');assert.equal(persistence.success,true);put('PERSISTENCE.private.json',persistence);
        put('RESULT.private.json',{...result,persistence,production:false,appUI:false,photos:false,points:false,productionIdentityVerified:false,candidateTestBindingsIncluded:false});
        console.log(JSON.stringify({success:true,run,checks:result.checks.length,artifact:'candidate',productionReady:false}));
    }catch(error){put('FAILURE.private.json',{error:error.message,productionWrites:0});throw error;}
    finally{for(const name of [...names].reverse()){const state=JSON.parse(docker(['inspect',name,'--format','{{json .}}']));assert.equal(state.Config.Labels['stray-linux'],id);
            if(name!==pgName)fs.writeFileSync(path.join(run,`${name}.private.log`),docker(['logs',name]));if(state.State.Running)docker(['stop','--time','5',name]);}
        put('CLEANUP.private.json',{containers:names,ownedContainersStopped:true,otherResourcesTouched:false,recordsRetained:true});}
}
if(require.main===module)main(process.argv[2]).catch(error=>{console.error(error.stack);process.exitCode=1});
