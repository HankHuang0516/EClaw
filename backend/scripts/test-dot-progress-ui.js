#!/usr/bin/env node
'use strict';
/* global document, innerWidth, window, Event */
// Fresh browser and synthetic API fixtures; never uses an existing signed-in profile.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const {chromium}=require('playwright');
const STATIC=path.resolve(__dirname,'../public/AiHankApps/dot-progress');
const CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
let role='anonymous';let conflict=false;let updates=0;let imports=0;let commentWrites=0;let calls=[];let previewDelay=0;
const initial={id:'fixture-project',title:'Synthetic admin task',status:'active',summary:'PRIVATE_GOAL_SENTINEL',blockers:'PRIVATE_BLOCKER_SENTINEL',nextStep:'Verify the UI',publicTitle:'',publicSummary:'',completedAt:'',version:1};
let project={...initial};const comments=[];
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');
  const send=(code,data)=>{res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
  if(url.pathname.startsWith('/api/')){
    let body='';for await(const chunk of req)body+=chunk;
    const data=body?JSON.parse(body):{};calls.push({path:url.pathname,method:req.method,data});
    if(url.pathname==='/api/dot-progress/session')return role==='anonymous'?send(401,{success:false,error:'unauthorized'}):send(200,{success:true,authenticated:true,isAdmin:role==='admin'});
    if(url.pathname==='/api/dot-progress/public')return send(200,{success:true,projects:[{title:'Completed <script>bad()</script>',publicSummary:'Publicly verified result',completedAt:'2026-10-04'},{title:'Synthetic display verification',publicSummary:'A completed public fixture for layout review.',completedAt:'2026-10-03'},{title:'Synthetic archive review',publicSummary:'A dated result used only in this test.',completedAt:'2026-10-02'}]});
    if(url.pathname==='/api/auth/logout'){await new Promise(resolve=>setTimeout(resolve,150));role='anonymous';return send(200,{success:true});}
    if(role!=='admin')return send(role==='anonymous'?401:403,{success:false,error:'forbidden'});
    if(url.pathname==='/api/dot-progress/projects')return send(200,{success:true,projects:[project]});
    if(url.pathname.endsWith('/comments')){
      if(req.method==='POST'){if(!comments.some(c=>c.requestId===data.requestId)){comments.push({id:'comment-1',body:data.body,requestId:data.requestId,createdAt:new Date().toISOString()});commentWrites++;}await new Promise(resolve=>setTimeout(resolve,100));return send(201,{success:true});}
      return send(200,{success:true,comments});
    }
    if(url.pathname.endsWith('/history'))return send(200,{success:true,history:[{version:project.version,action:'update',createdAt:new Date().toISOString(),changes:{before:initial,after:project}}]});
    if(url.pathname==='/api/dot-progress/import'){if(data.mode==='apply')imports++;else if(previewDelay)await new Promise(resolve=>setTimeout(resolve,previewDelay));return send(200,{success:true,mode:data.mode,count:1,projects:data.data.projects});}
    if(req.method==='PATCH'){
      if(conflict||data.version!==project.version){conflict=false;project.version++;return send(409,{success:false,error:'version_conflict'});}
      updates++;project={...project,...data,version:project.version+1};await new Promise(resolve=>setTimeout(resolve,100));return send(200,{success:true,project});
    }
    return send(404,{success:false,error:'not_found'});
  }
  const filename=url.pathname==='/AiHankApps/dot-progress/'?'index.html':path.basename(url.pathname);
  const file=path.join(STATIC,filename);
  if(!['index.html','i18n.js','progress.js','progress.css'].includes(filename)){res.writeHead(404);res.end();return;}
  res.writeHead(200,{'Content-Type':filename.endsWith('.js')?'application/javascript':filename.endsWith('.css')?'text/css':'text/html'});res.end(fs.readFileSync(file));
});
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  const browser=await chromium.launch({headless:true,...(process.env.DOT_CHROME_PATH?{executablePath:process.env.DOT_CHROME_PATH}:fs.existsSync(CHROME)?{executablePath:CHROME}:{})});
  try{
    const page=await browser.newPage({viewport:{width:390,height:844}});const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(base+'/AiHankApps/dot-progress/');await page.locator('#login').waitFor({state:'visible'});
    assert.equal(calls.filter(c=>c.path==='/api/dot-progress/projects').length,0,'Anonymous visitors must not request private records');
    assert(!await page.locator('body').innerText().then(t=>t.includes('PRIVATE_')));
    assert.equal(await page.locator('#completed-list script').count(),0,'Public strings must not become executable HTML');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'390px must not overflow');
    await page.screenshot({path:'/tmp/dot-progress-fixture-public-390.png',fullPage:true});
    role='member';await page.locator('#session-retry').click();await page.getByText('此帳號沒有管理者權限，私有工作區未載入。').waitFor();
    assert.equal(calls.filter(c=>c.path==='/api/dot-progress/projects').length,0,'Nonadmin must not request private records');
    role='admin';await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await page.locator('#private-workspace').waitFor({state:'visible'});
    assert(await page.locator('body').innerText().then(t=>t.includes('PRIVATE_GOAL_SENTINEL')));
    const editor=page.locator('.project details').nth(0);await editor.locator('summary').click();await editor.locator('[name=summary]').fill('User edited goal');
    const save=editor.getByRole('button',{name:'儲存修改'});await save.evaluate(button=>{button.click();button.click();button.click();});await page.waitForFunction(()=>document.querySelector('.project-summary').textContent==='User edited goal');assert.equal(updates,1,'Repeated save must make one mutation');
    const stale=page.locator('.project details').nth(0);await stale.locator('summary').click();await stale.locator('[name=summary]').fill('Retained conflict draft');conflict=true;await stale.getByRole('button',{name:'儲存修改'}).click();await stale.getByRole('button',{name:'載入最新版本'}).waitFor();assert.equal(await stale.locator('[name=summary]').inputValue(),'Retained conflict draft');assert.equal(updates,1,'409 must not overwrite');
    await stale.getByRole('button',{name:'載入最新版本'}).click();await stale.getByText('保留的草稿',{exact:true}).waitFor();assert.equal(await stale.locator('[name=summary]').inputValue(),'Retained conflict draft');
    const thread=page.locator('.project details').nth(2);await thread.locator('summary').click();await thread.locator('[name=body]').fill('A persisted synthetic comment');await thread.getByRole('button',{name:'送出留言'}).evaluate(button=>{button.click();button.click();});await thread.getByText('A persisted synthetic comment',{exact:true}).waitFor();assert.equal(commentWrites,1);
    await thread.getByRole('button',{name:'載入',exact:true}).click();await thread.getByText('A persisted synthetic comment',{exact:true}).waitFor();assert.equal(await thread.locator('.comment').count(),1,'Comment readback must not duplicate');
    const history=page.locator('.project details').nth(3);await history.locator('summary').click();await history.getByRole('button',{name:'載入',exact:true}).click();await history.locator('.history-row').waitFor();
    await page.locator('.import-panel summary').click();previewDelay=150;const fixture={name:'records.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({projects:[project]}))};await page.locator('#import-file').setInputFiles(fixture);await page.locator('#import-form button').click();await page.waitForTimeout(40);await page.locator('#import-file').setInputFiles({name:'replacement.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({projects:[]}))});await page.waitForTimeout(200);assert.equal(await page.locator('#import-apply').isVisible(),false,'Late preview must not reinstate a replaced file');assert.equal(await page.locator('#import-preview li').count(),0);previewDelay=0;
    await page.locator('#import-file').setInputFiles(fixture);await page.locator('#import-form button').click();await page.locator('#import-apply').waitFor({state:'visible'});assert.equal(imports,0,'Preview must not commit');await page.locator('#import-apply').click();await page.getByText('已匯入，最新項目已重新載入。',{exact:true}).waitFor();assert.equal(imports,1);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'390px admin workspace must not overflow');
    await page.screenshot({path:process.env.DOT_UI_SCREENSHOT||'/tmp/dot-progress-fixture-mobile.png',fullPage:true});
    const publication=page.locator('.project details').nth(1);await publication.locator('summary').click();await publication.locator('[name=publicTitle]').fill('Safe completed fixture');await publication.locator('[name=publicSummary]').fill('A safe explicit public summary.');await publication.locator('[name=completedAt]').fill('2026-10-04');await publication.getByRole('button',{name:'發布完成摘要'}).click();await page.getByText('這個分類目前沒有項目。',{exact:true}).waitFor();const published=calls.filter(c=>c.method==='PATCH').at(-1).data;assert.equal(published.status,'completed');assert(!Object.hasOwn(published,'summary'),'Publish must not reuse private summary');await page.locator('#filters [data-filter=completed]').click();await page.locator('.project').waitFor();
    role='anonymous';await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await page.locator('#login').waitFor({state:'visible'});assert.equal(await page.locator('.project').count(),0,'Expired session must clear private DOM');
    role='admin';await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await page.locator('#logout').waitFor({state:'visible'});await page.locator('#logout').click();assert.equal(await page.locator('.project').count(),0,'Logout clears private DOM immediately');const before=calls.filter(c=>c.path==='/api/dot-progress/session').length;await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await page.waitForTimeout(50);assert.equal(calls.filter(c=>c.path==='/api/dot-progress/session').length,before,'Focus must not check the still-valid cookie while logout is pending');await page.waitForTimeout(180);assert.equal(await page.locator('.project').count(),0);await page.reload();await page.locator('#login').waitFor({state:'visible'});assert.equal(await page.locator('.project').count(),0);
    await page.locator('#language').selectOption('en');await page.getByRole('heading',{name:'Turning progress into finished work.'}).waitFor();
    assert.deepEqual(errors,[],'No browser exceptions');
    console.log('PASS dot progress UI: anonymous/nonadmin boundaries, 390px, HTML escaping, admin edits, repeated click, retained 409 draft, comments readback, history, import preview/apply, session expiry, logout+refresh, locale switch');
  }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error.message);process.exitCode=1;server.close();});
