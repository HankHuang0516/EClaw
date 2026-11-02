import {readFile,stat} from 'node:fs/promises';
import {resolve,dirname,join,relative} from 'node:path';
import vm from 'node:vm';
const root=resolve(process.argv[2]||'backend/public/AiHankApps');
const catalog=JSON.parse(await readFile(join(root,'app-catalog.json'),'utf8'));
const coverage=JSON.parse(await readFile(join(root,'portfolio-coverage.json'),'utf8'));
const errors=[];const ids=new Set();const seen=new Set();let resources=0;
const script=await readFile(join(root,'app-catalog.js'),'utf8');
const scriptCatalog=JSON.parse(script.slice(script.indexOf('=')+1).trim().replace(/;$/,''));
if(JSON.stringify(scriptCatalog)!==JSON.stringify(catalog))errors.push('Catalog JSON/JS drift');
const home=await readFile(join(root,'index.html'),'utf8');
const match=home.match(/const appList = (\[[\s\S]*?\n\s*\]);/);
const inline=match?vm.runInNewContext('('+match[1]+')',{}, {timeout:1000}):[];
const community=await readFile(join(root,'community-v6.js'),'utf8');
const communityApps=vm.runInNewContext('('+community.match(/const apps = (\{[\s\S]*?\n  \});/)[1]+')',{}, {timeout:1000});
const guideFor=app=>{const value=Object.values(communityApps).find(x=>x.id===app.communityId)?.guide||app.guide||app.projectUrl;return value?new URL(value,'https://eclawbot.com/AiHankApps/').href:null;};
const identity=apps=>apps.map(a=>({id:a.communityId,name:a.name,guide:a.guide||null,officialUrl:a.officialUrl||null,webUrl:a.webUrl||null,publicGoogle:a.publicGoogle===true,publicApple:a.publicApple===true,publicWeb:a.publicWeb===true,publicWebsite:a.publicWebsite===true})).sort((a,b)=>a.id.localeCompare(b.id));
if(JSON.stringify(identity(inline))!==JSON.stringify(identity(catalog.apps)))errors.push('Homepage/catalog identity or entry drift');
if(new Set(coverage.apps.map(a=>a.id)).size!==coverage.apps.length)errors.push('Duplicate coverage APP ID');
async function exists(file,label){try{await stat(file);return true;}catch{errors.push('Missing '+label+': '+relative(root,file));return false;}}
async function checkHtml(file){
 if(seen.has(file)||!await exists(file,'introduction'))return;seen.add(file);
 const html=await readFile(file,'utf8');
 if(!html.includes('data-intro-toolbar')&&!file.includes('/tools/')&&!file.includes('/projects/'))errors.push('Missing persistent actions: '+relative(root,file));
 for(const match of html.matchAll(/<(img|script|link|iframe)\b[^>]*?\b(?:src|href)=["']([^"']+)["'][^>]*>/gi)){
  const url=match[2];if(/^(?:https?:|data:|#|\/\/)/i.test(url))continue;
  const path=decodeURIComponent(url.split(/[?#]/)[0]);if(!path)continue;
  let target=path.startsWith('/AiHankApps/')?join(root,path.slice('/AiHankApps/'.length)):path.startsWith('/')?join(root,'..',path):resolve(dirname(file),path);
  if(path.endsWith('/'))target=join(target,'index.html');
  resources++;await exists(target,'introduction asset');
 }
}
for(const app of catalog.apps){
 if(!app.communityId||ids.has(app.communityId))errors.push('Missing/duplicate stable APP ID');ids.add(app.communityId);
 const row=coverage.apps.find(row=>row.id===app.communityId);
 if(!row){errors.push('APP has no audited coverage row: '+app.communityId);continue;}
 if(row.name!==app.name||Boolean(row.publicGoogle)!==Boolean(app.publicGoogle)||Boolean(row.publicApple)!==Boolean(app.publicApple))errors.push('Stale identity/platform coverage: '+app.communityId);
 for(const [key,expected] of [['introUrl',guideFor(app)],['officialUrl',app.publicWebsite===true?app.officialUrl:null],['webUrl',app.publicWeb===true?app.webUrl:null]])if((row[key]||null)!==(expected||null))errors.push('Stale '+key+' coverage: '+app.communityId);
 if((app.publicGoogle||app.publicApple)&&!row.introUrl)errors.push('Public APP has no introduction: '+app.communityId);
 if(app.publicWeb===true&&!/^https:\/\//.test(app.webUrl||''))errors.push('Public Web entry missing HTTPS: '+app.communityId);
 if(app.publicWebsite===true&&!/^https:\/\//.test(app.officialUrl||''))errors.push('Official website missing HTTPS: '+app.communityId);
 for(const key of ['icon','promo'])if(app[key]&&!/^https?:/.test(app[key]))await exists(join(root,app[key]),'catalog '+key);
 if(row.introUrl){const u=new URL(row.introUrl);if(u.origin==='https://eclawbot.com'&&u.pathname.toLowerCase().startsWith('/aihankapps/'))await checkHtml(join(root,u.pathname.slice('/AiHankApps/'.length),'index.html'));}
}
for(const row of coverage.apps)if(!ids.has(row.id))errors.push('Coverage contains removed/unknown APP: '+row.id);
const result={apps:ids.size,introductions:seen.size,resources,issues:errors};console.log(JSON.stringify(result,null,2));if(errors.length)process.exitCode=1;
