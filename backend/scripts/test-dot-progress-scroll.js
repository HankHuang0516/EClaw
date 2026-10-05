#!/usr/bin/env node
'use strict';
/* global document, window, Event */
const rawAssert=require('node:assert/strict');
let checks=0;
const assert=(value,message)=>{checks++;rawAssert(value,message);};
for(const name of ['equal','deepEqual'])assert[name]=(...args)=>{checks++;return rawAssert[name](...args);};
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const {chromium}=require('playwright');
const directory=path.resolve(__dirname,'../public/AiHankApps/dot-progress');
const record=process.argv.includes('--record');
let role='admin';let publicDelay=0;let projectsDelay=120;
const projects=Array.from({length:24},(_,index)=>({id:'synthetic-'+index,title:'Synthetic project '+index,status:index%5===0?'completed':'active',summary:'Synthetic goal '+index,completedWork:'Synthetic completed work.\n'.repeat(3),blockers:'Synthetic blocker notes.\n'.repeat(3),nextStep:'Synthetic next step.\n'.repeat(3),publicTitle:'',publicSummary:'',completedAt:'',version:1,pushCount:0,lastPushedAt:null}));
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');
  const send=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
  if(url.pathname.startsWith('/api/')){
    let body='';for await(const chunk of req)body+=chunk;const input=body?JSON.parse(body):{};
    if(url.pathname==='/api/dot-progress/session'){await new Promise(resolve=>setTimeout(resolve,160));return role==='admin'?send(200,{success:true,authenticated:true,isAdmin:true}):send(401,{success:false,error:'unauthorized'});}
    if(url.pathname==='/api/dot-progress/public'){if(publicDelay)await new Promise(resolve=>setTimeout(resolve,publicDelay));return send(200,{success:true,projects:[{title:'Synthetic public outcome',publicSummary:'Synthetic completed summary.',completedAt:'2026-10-05'}]});}
    if(url.pathname==='/api/auth/logout'){role='anonymous';return send(200,{success:true});}
    if(role!=='admin')return send(401,{success:false,error:'unauthorized'});
    if(req.method==='GET'&&url.pathname==='/api/dot-progress/schedule-period'){
      const day=url.searchParams.get('date'),start=Date.parse(day+'T00:00:00+08:00'),end=start+86400000;
      return send(200,{success:true,period:{date:day,view:'day',from:day,to:new Date(end+28800000).toISOString().slice(0,10),startAt:new Date(start).toISOString(),endAt:new Date(end).toISOString()},schedules:[]});
    }
    if(req.method==='GET'&&url.pathname==='/api/dot-progress/schedule')return send(200,{success:true,schedule:{date:url.searchParams.get('date'),version:0,rows:[],updatedAt:null}});
    if(req.method==='GET'&&url.pathname==='/api/dot-progress/timeline')return send(200,{success:true,entries:[],total:0,limit:500,offset:0,nextOffset:null});
    if(url.pathname==='/api/dot-progress/projects'){if(projectsDelay)await new Promise(resolve=>setTimeout(resolve,projectsDelay));return send(200,{success:true,projects});}
    if(url.pathname.endsWith('/decisions'))return send(200,{success:true,decisions:[]});
    if(url.pathname.endsWith('/push')){const project=projects.find(row=>url.pathname.includes('/'+row.id+'/'));project.pushCount++;project.lastPushedAt=new Date().toISOString();await new Promise(resolve=>setTimeout(resolve,80));return send(200,{success:true,pushCount:project.pushCount,lastPushedAt:project.lastPushedAt});}
    if(url.pathname.endsWith('/comments'))return send(200,{success:true,comments:[]});
    if(url.pathname.endsWith('/history'))return send(200,{success:true,history:[]});
    if(req.method==='PATCH'){const project=projects.find(row=>url.pathname.endsWith('/'+row.id));Object.assign(project,input,{version:project.version+1});return send(200,{success:true,project});}
    return send(200,{success:true,entries:[]});
  }
  if(url.pathname==='/other'){res.writeHead(200,{'Content-Type':'text/html'});res.end('<!doctype html><title>Synthetic navigation</title><a href="/AiHankApps/dot-progress/">Return</a>');return;}
  const name=url.pathname.endsWith('/')?'index.html':path.basename(url.pathname);
  if(!fs.existsSync(path.join(directory,name))){res.writeHead(404);res.end();return;}
  res.writeHead(200,{'Content-Type':name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html'});res.end(fs.readFileSync(path.join(directory,name)));
});
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({headless:true,executablePath:process.env.DOT_CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
  const evidence=[];
  try{
    for(const width of [390,1280]){
      role='admin';const page=await browser.newPage({viewport:{width,height:900}});const errors=[];page.on('framenavigated',frame=>{if(frame===page.mainFrame()&&!frame.url().startsWith('http://127.0.0.1:')&&frame.url()!=='about:blank')errors.push('Unexpected non-fixture navigation');});page.on('pageerror',error=>errors.push(error.message));
      await page.goto('http://127.0.0.1:'+server.address().port+'/AiHankApps/dot-progress/');await page.locator('#private-workspace').waitFor({state:'visible'});
      const anchor=page.locator('[data-project-id="synthetic-18"] .workflow-next');
      async function position(){await anchor.evaluate(node=>window.scrollTo(0,node.getBoundingClientRect().top+window.scrollY-120));await page.waitForTimeout(60);return page.evaluate(()=>window.scrollY);}
      async function sample(label,action){const before=await position();await action();await page.waitForTimeout(40);const during=await page.evaluate(()=>window.scrollY);await page.waitForTimeout(230);const after=await page.evaluate(()=>window.scrollY);const top=await anchor.evaluate(node=>node.getBoundingClientRect().top);evidence.push({width,label,before,during,after,anchorTop:top});if(!record){assert(Math.abs(top-120)<3,label+' must preserve logical reading anchor');assert(Math.abs(after-before)<3,label+' must preserve scroll');}}
      await sample('focus-return',()=>page.evaluate(()=>window.dispatchEvent(new Event('focus'))));
      await sample('visibility-return',()=>page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange'))));
      await position();const beforePush=await page.evaluate(()=>window.scrollY);await page.locator('[data-project-id="synthetic-18"] .push-button').evaluate(node=>node.click());await page.waitForTimeout(200);const afterPush=await page.evaluate(()=>window.scrollY);evidence.push({width,label:'push-receipt',before:beforePush,after:afterPush});if(!record)assert(Math.abs(afterPush-beforePush)<50,'Push receipt must not jump to the top');
      await position();await page.locator('#language').evaluate(node=>{node.value='en';node.dispatchEvent(new Event('change',{bubbles:true}));});await page.waitForTimeout(200);const localeTop=await anchor.evaluate(node=>node.getBoundingClientRect().top);evidence.push({width,label:'locale-rerender',after:await page.evaluate(()=>window.scrollY),anchorTop:localeTop});if(!record)assert(Math.abs(localeTop-120)<3,'Language refresh preserves logical anchor: '+localeTop);
      const comments=page.locator('[data-project-id="synthetic-18"] .project-comments');await comments.locator('summary').evaluate(node=>node.click());await comments.locator('textarea').fill('SYNTHETIC_READING_DRAFT');await comments.locator('textarea').evaluate(node=>node.focus({preventScroll:true}));await page.waitForTimeout(20);const focusedBefore=await page.evaluate(()=>document.activeElement.name);await page.locator('#language').evaluate(node=>{node.value='zh-TW';node.dispatchEvent(new Event('change',{bubbles:true}));});await page.waitForTimeout(150);if(!record){assert.equal(await page.evaluate(()=>document.activeElement.name),focusedBefore,'Rerender preserves focused control');assert.equal(await comments.evaluate(node=>node.open),true,'Rerender preserves expanded detail');assert.equal(await comments.locator('textarea').inputValue(),'SYNTHETIC_READING_DRAFT','Rerender retains draft');}
      evidence.push({width,label:'detail-rerender',focusedBefore,focusedAfter:await page.evaluate(()=>document.activeElement.name||document.activeElement.tagName),open:await comments.evaluate(node=>node.open),draft:await comments.locator('textarea').inputValue(),after:await page.evaluate(()=>window.scrollY)});
      await position();const navigationBefore=await page.evaluate(()=>window.scrollY);await page.goto('http://127.0.0.1:'+server.address().port+'/other');await page.goBack();await page.locator('#private-workspace').waitFor({state:'visible'});await page.waitForTimeout(230);const navigationAfter=await page.evaluate(()=>window.scrollY);evidence.push({width,label:'back-navigation',before:navigationBefore,after:navigationAfter});if(!record)assert(Math.abs(navigationAfter-navigationBefore)<3,'History return restores reading position after delayed auth');
      if(!record){
        assert.equal(await comments.evaluate(node=>node.open),true,'History return restores expanded details without storing draft content');
        assert.equal(await comments.locator('textarea').inputValue(),'','History stores no private draft');
      }
      await page.goForward();await page.waitForFunction(()=>document.title==='Synthetic navigation');assert.equal(await page.title(),'Synthetic navigation');
      await page.waitForURL('**/other');await page.getByRole('link',{name:'Return',exact:true}).click();await page.locator('#private-workspace').waitFor({state:'visible'});await page.waitForTimeout(200);
      if(!record)assert.equal(await page.evaluate(()=>window.scrollY),0,'Fresh link navigation starts at top');
      await position();const forwardBefore=await page.evaluate(()=>window.scrollY);await page.goBack();await page.waitForFunction(()=>document.title==='Synthetic navigation');await page.goForward();await page.locator('#private-workspace').waitFor({state:'visible'});await page.waitForTimeout(100);if(!record)assert(Math.abs(await page.evaluate(()=>window.scrollY)-forwardBefore)<3,'Forward restores progress history entry after auth/data');
      const historyData=await page.evaluate(()=>window.history.state.dotProgressReading);
      assert.equal(/Synthetic|synthetic-|SYNTHETIC_READING_DRAFT/.test(JSON.stringify(historyData)),false,'History contains no project titles, IDs or private drafts');
      assert.deepEqual(Object.keys(historyData).sort(),['anchor','details','filter','private','y'],'History geometry has a bounded explicit shape');
      await position();const filterBefore=await page.evaluate(()=>window.scrollY);await page.locator('[data-filter=all]').evaluate(node=>node.click());
      const filterAfter=await page.evaluate(()=>window.scrollY);evidence.push({width,label:'filter-interaction',before:filterBefore,after:filterAfter});if(!record)assert(Math.abs(await anchor.evaluate(node=>node.getBoundingClientRect().top)-120)<3,'Filter preserves browser reading anchor while changing visibility');
      const original=page.locator('[data-project-id="synthetic-18"] .project-original');await original.locator('summary').evaluate(node=>node.click());await page.waitForTimeout(50);if(!record)assert(await page.evaluate(()=>window.scrollY)>1000,'Expanding details does not reset to top');await original.locator('summary').evaluate(node=>node.click());
      await position();role='anonymous';await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await page.waitForTimeout(210);
      assert.equal(await page.locator('#project-list').textContent(),'','Expired role clears private content');assert.equal(await page.locator('#private-workspace').isVisible(),false,'Expired role removes reserved private geometry');
      role='admin';await page.locator('#session-retry').evaluate(node=>node.click());await page.locator('#private-workspace').waitFor({state:'visible'});
      await position();publicDelay=400;await page.locator('#public-retry').evaluate(node=>node.click());await page.waitForTimeout(80);await page.evaluate(()=>window.scrollBy(0,200));const userTop=await anchor.evaluate(node=>node.getBoundingClientRect().top);await page.waitForTimeout(450);const refreshedTop=await anchor.evaluate(node=>node.getBoundingClientRect().top);evidence.push({width,label:'scroll-during-refresh',beforeTop:userTop,afterTop:refreshedTop});if(!record)assert(Math.abs(refreshedTop-userTop)<3,'Async public refresh preserves the new user reading position');publicDelay=0;
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false,'No mobile overflow');
      await position();projectsDelay=400;await page.goto('http://127.0.0.1:'+server.address().port+'/other');await page.goBack();await page.waitForTimeout(50);await page.evaluate(()=>{window.dispatchEvent(new Event('wheel'));window.scrollBy(0,20);});await page.locator('#private-workspace').waitFor({state:'visible'});await page.waitForTimeout(150);if(!record)assert(await anchor.evaluate(node=>node.getBoundingClientRect().top)>500,'User scrolling cancels pending return restoration');projectsDelay=120;
      await position();await page.screenshot({path:'/tmp/dot-progress-scroll-'+width+'-fixture.png'});
      assert.deepEqual(errors,[]);await page.close();
    }
    fs.writeFileSync(process.env.DOT_SCROLL_EVIDENCE||'/tmp/dot-progress-scroll-evidence.json',JSON.stringify(evidence,null,2));console.log(JSON.stringify({checks,measurements:evidence}));
  }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error.message);process.exitCode=1;server.close();});
