'use strict';
// Private Linux build driver. Never deployed or packaged with the candidate; no live configuration is read.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {createHash}=require('node:crypto'),{spawnSync}=require('node:child_process');
const {manifests,seedLock,compareProduction}=require('./prepare-lock');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex'),read=p=>JSON.parse(fs.readFileSync(p));
const write=(root,name,value)=>fs.writeFileSync(path.join(root,name),JSON.stringify(value,null,2)+'\n',{mode:0o600});
function commands(root,cwd,label,args){
    const home=path.join(root,'empty-home'),cache=path.join(root,'npm-cache');fs.mkdirSync(home,{recursive:true});
    const globalConfig=path.join(home,'global.npmrc');fs.writeFileSync(globalConfig,'');
    const result=spawnSync('/usr/local/bin/node',['/usr/local/lib/node_modules/npm/bin/npm-cli.js',...args],{cwd,timeout:600000,maxBuffer:8*1024*1024,
        env:{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:home,TMPDIR:'/tmp',TZ:'UTC',LANG:'C.UTF-8',NPM_CONFIG_USERCONFIG:'/dev/null',NPM_CONFIG_GLOBALCONFIG:globalConfig,
            NPM_CONFIG_REGISTRY:'https://registry.npmjs.org/',NPM_CONFIG_CACHE:cache,NPM_CONFIG_IGNORE_SCRIPTS:'true',NPM_CONFIG_AUDIT:'false',NPM_CONFIG_FUND:'false',NPM_CONFIG_UPDATE_NOTIFIER:'false'}});
    fs.writeFileSync(path.join(root,`${label}.private.log`),(result.stdout||'')+(result.stderr||''));
    if(result.error||result.status!==0)throw Error(`${label}_FAILED_SEE_PRIVATE_LOG`);
}
function outputs(root){const result={};for(const prefix of ['apps/api/dist','packages/contracts/dist'])walk(path.join(root,prefix),name=>{result[path.relative(root,name)]=sha(fs.readFileSync(name));});return result;}
function walk(root,fn){for(const item of fs.readdirSync(root,{withFileTypes:true})){const p=path.join(root,item.name);if(item.isDirectory())walk(p,fn);else if(item.isFile())fn(p);else throw Error('UNEXPECTED_SOURCE_LINK');}}
function setup(inputs,root,name){
    const target=path.join(root,name);assert.ok(!fs.existsSync(target),'BUILD_DIRECTORY_ALREADY_EXISTS');fs.mkdirSync(target,{mode:0o700});
    const baseline=path.join(inputs,'baseline'),manifest=read(path.join(inputs,'BASELINE_MANIFEST.private.json'));
    for(const item of manifest.files){assert.ok(/^(apps\/api\/(src|migrations|content)\/[\w/.-]+|apps\/api\/(package|tsconfig)\.json|packages\/contracts\/[\w/.-]+|package\.json)$/.test(item.path)&&!item.path.split('/').includes('..'));
        const src=path.join(baseline,item.path);assert.ok(fs.lstatSync(src).isFile());assert.equal(sha(fs.readFileSync(src)),item.sha256);
        const dst=path.join(target,item.path);fs.mkdirSync(path.dirname(dst),{recursive:true});fs.copyFileSync(src,dst,fs.constants.COPYFILE_EXCL);}
    const generated=manifests(baseline,read(path.join(inputs,'runtime-capture.private.json')));
    for(const[name,data]of [['package.json',generated.root],['apps/api/package.json',generated.api],['packages/contracts/package.json',generated.contracts]])fs.writeFileSync(path.join(target,name),JSON.stringify(data,null,2)+'\n');
    fs.writeFileSync(path.join(target,'tsconfig.base.json'),JSON.stringify({_reconstruction:'REWRITTEN_UNKNOWN_ORIGINAL',compilerOptions:{target:'ES2022',module:'ESNext',moduleResolution:'Bundler',strict:true,esModuleInterop:true,skipLibCheck:true,resolveJsonModule:true,forceConsistentCasingInFileNames:true,noEmitOnError:true,types:['node']}}));
    fs.writeFileSync(path.join(target,'package-lock.json'),JSON.stringify(seedLock(read(path.join(inputs,'runtime-hidden-lock.raw.private.json')),generated),null,2)+'\n');
    write(root,`${name}-selection.private.json`,generated);return target;
}
function compile(inputs,root){
    const primary=setup(inputs,root,'primary');commands(root,primary,'linux-install',['install','--ignore-scripts']);commands(root,primary,'linux-clean-ci',['ci','--ignore-scripts']);
    for(const kind of ['contracts','api'])commands(root,primary,`linux-primary-${kind}`,['run',`build:${kind}`,'--ignore-scripts']);
    const first=outputs(primary),lockHash=sha(fs.readFileSync(path.join(primary,'package-lock.json')));write(root,'LINUX_FIRST_OUTPUTS.private.json',first);
    const repeat=setup(inputs,root,'repeat');fs.copyFileSync(path.join(primary,'package-lock.json'),path.join(repeat,'package-lock.json'));
    commands(root,repeat,'linux-repeat-ci',['ci','--ignore-scripts']);for(const kind of ['contracts','api'])commands(root,repeat,`linux-repeat-${kind}`,['run',`build:${kind}`,'--ignore-scripts']);
    assert.deepEqual(outputs(repeat),first);assert.equal(sha(fs.readFileSync(path.join(repeat,'package-lock.json'))),lockHash);
    fs.copyFileSync(path.join(inputs,'runtime-hidden-lock.raw.private.json'),path.join(root,'runtime-hidden-lock.raw.private.json'));
    const comparison=compareProduction(primary,read(path.join(inputs,'runtime-capture.private.json')),read(path.join(primary,'package-lock.json')));write(root,'LINUX_DEPENDENCIES.private.json',comparison);
    assert.equal(comparison.mismatched.length,0);assert.equal(comparison.missing.length,0);
    const codec=spawnSync('/usr/local/bin/node',['-e',"const s=require('sharp');(async()=>{const b=await s({create:{width:3,height:2,channels:3,background:{r:12,g:34,b:56}}}).png().toBuffer();const m=await s(b).metadata();if(m.width!==3||m.height!==2)throw Error('CODEC');console.log(JSON.stringify({sharp:s.versions.sharp,vips:s.versions.vips,width:m.width,height:m.height}));})()"],{cwd:primary,encoding:'utf8',env:{PATH:'/usr/local/bin:/usr/bin:/bin'},timeout:30000});assert.equal(codec.status,0,codec.stderr);
    write(root,'LINUX_BUILD_RESULT.private.json',{success:true,node:process.version,platform:process.platform,arch:process.arch,glibc:process.report.getReport().header.glibcVersionRuntime,
        compiledFiles:Object.keys(first).length,repeatOutputsIdentical:true,repeatLockUnchanged:true,lockHash,codec:JSON.parse(codec.stdout),unsigned:true,originalSourceRestored:false,
        dependencyCounts:Object.fromEntries(['matched','mismatched','missing','platformOmitted','optionalOmitted','selectedDevelopmentChanges','added'].map(k=>[k,comparison[k].length])),productionEquivalent:false});
    console.log(JSON.stringify({success:true,phase:'compile',platform:process.platform,arch:process.arch,outputs:Object.keys(first).length}));
}
function candidate(root,pilotRoot,contractFile){
    const source=path.join(root,'primary'),target=path.join(root,'candidate');assert.ok(!fs.existsSync(target));fs.mkdirSync(target,{mode:0o700});
    for(const name of ['package.json','package-lock.json','apps/api/package.json','packages/contracts/package.json']){const dst=path.join(target,name);fs.mkdirSync(path.dirname(dst),{recursive:true});fs.copyFileSync(path.join(source,name),dst);}
    for(const[name,start]of [['package.json','node apps/api/server.text-pilot.mjs'],['apps/api/package.json','node server.text-pilot.mjs']]){
        const file=path.join(target,name),manifest=read(file);manifest.scripts={start};fs.writeFileSync(file,JSON.stringify(manifest,null,2)+'\n');}
    const excluded=[];
    for(const name of ['apps/api/dist','apps/api/content','packages/contracts/dist'])fs.cpSync(path.join(source,name),path.join(target,name),{recursive:true,errorOnExist:true,force:false,
        filter:src=>{const omit=/\.test\.js$/.test(src)||['migrate.js','flickr-auth.js'].includes(path.basename(src));if(omit)excluded.push(path.relative(source,src));return !omit;}});
    const integration=path.join(target,'apps/api/integrations/stray-map-pilot');fs.mkdirSync(integration,{recursive:true});
    fs.writeFileSync(path.join(target,'apps/api/integrations/package.json'),JSON.stringify({type:'commonjs'})+'\n');
    for(const name of ['pilot.cjs','store.cjs'])fs.copyFileSync(path.join(pilotRoot,name),path.join(integration,name));
    fs.mkdirSync(path.join(target,'apps/api/integrations/stray-map-intake'));fs.copyFileSync(contractFile,path.join(target,'apps/api/integrations/stray-map-intake/contract.js'));
    const native=fs.readFileSync(path.join(source,'apps/api/dist/server.js'),'utf8'),anchor='const deviceIdSchema = z.uuid();';assert.equal(native.split(anchor).length,2);
    const boot='// NEW candidate extension; no identity binding is supplied or inferred. All pilot operations stay closed.\nconst pilot=await import("./integrations/stray-map-pilot/pilot.cjs");\nawait pilot.default.install(app,{pool});\n';
    const entry=native.replace(/from "\.\//g,'from "./dist/').replace(anchor,boot+anchor);fs.writeFileSync(path.join(target,'apps/api/server.text-pilot.mjs'),entry);
    commands(root,target,'linux-candidate-production-ci',['ci','--omit=dev','--ignore-scripts']);
    const inventory=[];function list(dir){for(const item of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,item.name),relative=path.relative(target,p);
        if(item.isDirectory())list(p);else if(item.isSymbolicLink()){const real=fs.realpathSync(p);assert.ok(real.startsWith(target+'/'));inventory.push({path:relative,symlink:fs.readlinkSync(p)});}else{assert.ok(item.isFile());
            if(!relative.startsWith('node_modules/'))assert.ok(!/\.env|fixture|rehearsal|rebuild|socket|READY\.private|\.private\./i.test(relative));
            inventory.push({path:relative,bytes:fs.statSync(p).size,sha256:sha(fs.readFileSync(p))});}}}list(target);
    write(root,'CANDIDATE_INVENTORY.private.json',{kind:'UNSIGNED_LINUX_AMD64_TEXT_PILOT_CANDIDATE',files:inventory,entry:'apps/api/server.text-pilot.mjs',originalEntryHash:sha(native),candidateEntryHash:sha(entry),
        productionIdentityWired:false,reviewerWired:false,defaultIntake:false,defaultReview:false,defaultPublicRead:false,photos:false,points:false,fixturesPackaged:false,unixSocketPackaged:false,
        excludedCompiledToolsAndTests:excluded,packageScriptsRewritten:'start only; candidate entry; dependencies unchanged'});
    console.log(JSON.stringify({success:true,phase:'candidate',files:inventory.length,identityWired:false,productionReady:false}));
}
function main(inputs,root,phase,pilotRoot,contractFile){assert.equal(process.platform,'linux');assert.equal(process.arch,'x64');assert.equal(process.version,'v22.23.3');
    assert.equal(inputs,'/inputs');assert.equal(root,'/output');assert.equal(fs.realpathSync(root),root);
    if(phase==='compile')compile(inputs,root);else if(phase==='candidate')candidate(root,pilotRoot,contractFile);else throw Error('UNKNOWN_PHASE');}
if(require.main===module)try{main(...process.argv.slice(2));}catch(error){console.error(error.message);process.exitCode=1;}
