'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function build(root,{write=false}={}){
const read=name=>fs.readFileSync(path.join(root,name)),json=name=>JSON.parse(read(name).toString('utf8'));
const release=json('release.json'),context=json('player-release-context.json'),cache=JSON.parse(read('player-cache-manifest.js').toString('utf8').replace(/^self\.FraudPlayerCacheManifest=/,'').replace(/;\s*$/,''));
if(typeof release.version!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{2,120}$/.test(release.version))throw Error('Invalid canonical release version');
const version=release.version,outputs=new Map(),put=(name,value)=>outputs.set(name,Buffer.from(value));
const bootstrap=read('player-bootstrap.js').toString('utf8'),pattern=/const runningVersion=['"][^'"]+['"];/g;
if((bootstrap.match(pattern)||[]).length!==1)throw Error('One generated runningVersion required');
put('player-bootstrap.js',bootstrap.replace(pattern,"const runningVersion='"+version+"';"));
const entry=read('player-entry-link.js').toString('utf8'),releasePattern=/\brelease=['"][^'"]+['"]/g;
if((entry.match(releasePattern)||[]).length!==1)throw Error('One entry release identity required');
put('player-entry-link.js',entry.replace(releasePattern,"release='"+version+"'"));
put('index.html',read('index.html').toString('utf8').replace(/player-entry-link\.js\?v=[^"']+/g,'player-entry-link.js?v='+version));
const extras=release.playerSlice?.additionalRuntimeAssets||[];
if(!Array.isArray(extras)||extras.some(p=>typeof p!=='string'||p.startsWith('/')||p.includes('..')))throw Error('Unsafe runtime asset path');
const paths=[...new Set([...context.assets.map(a=>a.path),...extras])];
const privatePreview=['player-route-preview.js','player-route-preview.css','player-route-preview-data.json'];
const coreOnly=release.publicationScope?.kind==='completed-ui-core';
if(coreOnly&&paths.some(p=>privatePreview.includes(p)))throw Error('Private full-route preview excluded from completed UI core runtime');
for(const name of paths)if(['release.json','player-release-context.json','player-cache-manifest.js','player-service-worker.js'].includes(name))throw Error('Circular runtime asset');
const bytes=name=>outputs.get(name)||read(name);
context.version=version;context.assets=paths.map(name=>{const b=bytes(name);return{path:name,bytes:b.length,sha256:sha(b)};});context.contentHash=sha(JSON.stringify(context.assets));
put('player-release-context.json',JSON.stringify(context,null,2)+'\n');
cache.release=version;cache.assets=[...context.assets,{path:'player-release-context.json',bytes:bytes('player-release-context.json').length,sha256:sha(bytes('player-release-context.json'))}].map(a=>({url:cache.scope+a.path,bytes:a.bytes,sha256:a.sha256}));
if(cache.assets.reduce((s,a)=>s+a.bytes,0)>50*1024*1024)throw Error('Runtime cache exceeds reviewed 50 MiB cap');
put('player-cache-manifest.js','self.FraudPlayerCacheManifest='+JSON.stringify(cache)+';\n');
const names=[...new Set([...release.assets.map(a=>a.path),...(release.playerSlice?.additionalPublicAssets||[])])];
if(coreOnly&&names.some(p=>privatePreview.includes(p)))throw Error('Private full-route preview excluded from completed UI core public assets');
release.assets=names.map(name=>{const b=bytes(name);return{path:name,bytes:b.length,sha256:sha(b)};});release.contentHash=sha(JSON.stringify(release.assets));release.playerSlice.runtimeContentHash=context.contentHash;
release.buildPolicy={versionSource:'release.json#version',generator:'backend/scripts/build-fraud-player-release.cjs',runningVersion:'generated into the actual bootstrap bytes; never fetched from latest network metadata',workerVersion:'player-cache-manifest.js#release',settingsVersion:'actual document.dataset.playerBuild'};
put('release.json',JSON.stringify(release,null,2)+'\n');
const mismatches=[...outputs].filter(([name,b])=>!b.equals(read(name))).map(([name])=>name);
if(write)for(const[name,b]of outputs)fs.writeFileSync(path.join(root,name),b);
return{version,contentHash:context.contentHash,projectContentHash:release.contentHash,runtimeFiles:context.assets.length,publicFiles:release.assets.length,mismatches,outputs,context,cache,release};
}
module.exports={build};
if(require.main===module){const root=path.resolve(__dirname,'../public/AiHankApps/projects/fraud-empire'),write=process.argv.includes('--write'),out=build(root,{write});process.stdout.write(JSON.stringify({version:out.version,contentHash:out.contentHash,runtimeFiles:out.runtimeFiles,publicFiles:out.publicFiles,write,mismatches:out.mismatches})+'\n');if(!write&&out.mismatches.length)process.exitCode=1;}
