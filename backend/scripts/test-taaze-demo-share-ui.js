#!/usr/bin/env node
'use strict';
/* global document, window, Event, innerWidth, localStorage, sessionStorage */
// Fresh Chrome, only synthetic metadata and a synthetic owner-prepared payload.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const {chromium}=require('playwright');
const directory=path.resolve(__dirname,'../public/AiHankApps/dot-progress');
const chrome='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
let role='anonymous';let bundle=null;let shareDelay=160;let getDelay=0;let uncertain=false;let unsafePath=false;
const shares=[];const requests=[];const issued=new Set();
const api='/api/taaze-demo-share';
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');
  const send=(code,data)=>{res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
  if(url.pathname.startsWith('/api/')){
    let body='';for await(const part of req)body+=part;const data=body?JSON.parse(body):{};requests.push({method:req.method,path:url.pathname,data});
    if(url.pathname==='/api/dot-progress/session')return role==='anonymous'?send(401,{success:false}):send(200,{success:true,authenticated:true,isAdmin:role==='admin'});
    if(url.pathname==='/api/dot-progress/public')return send(200,{success:true,projects:[]});
    if(url.pathname==='/api/auth/logout'){role='anonymous';return send(200,{success:true});}
    if(role!=='admin')return send(role==='anonymous'?401:403,{success:false,error:'forbidden'});
    if(url.pathname==='/api/dot-progress/projects')return send(200,{success:true,projects:[]});
    if(url.pathname===api){const snapshot=JSON.parse(JSON.stringify({success:true,bundle,shares}));await new Promise(resolve=>setTimeout(resolve,getDelay));return send(200,snapshot);}
    if(url.pathname===api+'/bundle'){bundle={id:'synthetic-bundle',sourceSha256:'synthetic',bundleSha256:'fixture',fileCount:data.files.length};return send(200,{success:true,bundle});}
    if(url.pathname===api+'/shares'){
      if(!bundle)return send(409,{success:false,error:'bundle_required'});
      if(issued.has(data.requestId))return send(409,{success:false,error:'share_already_issued'});issued.add(data.requestId);
      const share={id:'00000000-0000-0000-0000-'+String(shares.length+1).padStart(12,'0'),createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+7*86400000).toISOString(),revokedAt:null};shares.unshift(share);
      await new Promise(resolve=>setTimeout(resolve,shareDelay));if(uncertain){uncertain=false;return send(503,{success:false,error:'demo_unavailable'});}return send(200,{success:true,share:{...share,path:unsafePath?'javascript:alert(1)':`/AiHankApps/taaze-demo/${String.fromCharCode(64+shares.length).repeat(43)}/`}});
    }
    if(url.pathname.endsWith('/revoke')){const id=url.pathname.split('/').at(-2);const share=shares.find(row=>row.id===id);share.revokedAt=new Date().toISOString();return send(200,{success:true,share:{id,revokedAt:share.revokedAt}});}
    return send(404,{success:false});
  }
  const filename=url.pathname.endsWith('/')?'index.html':path.basename(url.pathname);if(!fs.readdirSync(directory).includes(filename)){res.writeHead(404);res.end();return;}
  res.writeHead(200,{'Content-Type':filename.endsWith('.js')?'application/javascript':filename.endsWith('.css')?'text/css':'text/html'});res.end(fs.readFileSync(path.join(directory,filename)));
});
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
  const browser=await chromium.launch({headless:true,...(fs.existsSync(chrome)?{executablePath:chrome}:{})});
  try{
    const page=await browser.newPage({viewport:{width:390,height:844}});const errors=[];page.on('pageerror',error=>errors.push(error.message));
    const panel=page.locator('#demo-share-panel');const content=page.locator('#demo-share-content');const calls=()=>requests.filter(row=>row.path.startsWith(api));
    await page.goto(base+'/AiHankApps/dot-progress/');await page.locator('#login').waitFor({state:'visible'});assert.equal(calls().length,0);assert.equal(await panel.isVisible(),false);
    role='member';await page.locator('#session-retry').click();await page.getByText('此帳號沒有管理者權限，私有工作區未載入。').waitFor();assert.equal(calls().length,0);
    role='admin';await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await page.locator('#private-workspace').waitFor({state:'visible'});assert.equal(calls().length,0,'Admin panel is lazy');assert.equal(await panel.getAttribute('open'),null);
    await panel.locator(':scope > summary').click();await content.getByText('原始來源尚未匯入，分享尚不可用。').waitFor();assert.equal(calls().length,1);assert.equal(await content.getByRole('button',{name:'建立七天分享連結'}).isDisabled(),true);assert.equal(calls().filter(row=>row.method==='POST').length,0);
    const picker=content.locator('input[type=file]');await picker.setInputFiles({name:'bad.json',mimeType:'application/json',buffer:Buffer.from('{}')});await content.getByRole('button',{name:'確認匯入來源'}).click();await content.getByText('請選擇不超過 3 MB 的有效來源匯入 JSON。').waitFor();assert.equal(calls().filter(row=>row.method==='POST').length,0,'Malformed payload never writes');
    const payload={sourceArchiveBase64:'c3ludGhldGlj',sourceCommit:'synthetic-source-only',files:[{path:'index.html',archivePath:'source/index.html'}]};await picker.setInputFiles({name:'owner-prepared.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(payload))});assert.equal(calls().filter(row=>row.method==='POST').length,0,'Picking a file cannot auto-import');await content.getByRole('button',{name:'確認匯入來源'}).click();await content.getByText('來源已通過驗證並匯入。').waitFor();assert.deepEqual(calls().find(row=>row.path.endsWith('/bundle')).data,payload);assert.equal(await content.getByRole('button',{name:'建立七天分享連結'}).isDisabled(),false);
    getDelay=350;await content.getByRole('button',{name:'重新載入分享清單'}).click();
    const create=content.getByRole('button',{name:'建立七天分享連結'});await create.evaluate(button=>{button.click();button.click();});assert.equal(await create.isDisabled(),true);await content.getByRole('link',{name:'開啟新分享連結'}).waitFor();assert.equal(issued.size,1,'Repeated submit cannot issue two capabilities');await page.waitForTimeout(400);assert.equal(await content.locator('.demo-share-entry').count(),1,'Late pre-issuance GET cannot remove the newer share metadata');getDelay=0;assert.equal(await content.locator('.demo-share-links a').getAttribute('rel'),'noopener noreferrer');assert.equal(await content.locator('.demo-share-links a').getAttribute('referrerpolicy'),'no-referrer');assert.equal(await content.locator('.demo-share-metadata a').count(),0,'List metadata never recovers capability URLs');
    await page.locator('#language').selectOption('en');await content.getByRole('link',{name:'Open new share link'}).waitFor();assert.equal(await page.evaluate(()=>localStorage.length+sessionStorage.length),0,'No private browser storage');await page.locator('#language').selectOption('zh-TW');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await panel.screenshot({path:'/tmp/taaze-share-manager-390-fixture.png'});await page.setViewportSize({width:1280,height:900});await panel.screenshot({path:'/tmp/taaze-share-manager-1280-fixture.png'});await page.setViewportSize({width:390,height:844});
    await page.reload();await page.locator('#private-workspace').waitFor({state:'visible'});assert.equal(await panel.getAttribute('open'),null);await panel.locator(':scope > summary').click();await content.locator('.demo-share-entry').waitFor();assert.equal(await content.locator('.demo-share-links a').count(),0,'Refresh cannot recover one-time URL');assert.equal(await content.locator('.demo-share-metadata a').count(),0);
    await content.getByRole('button',{name:'撤銷連結'}).click();await content.getByText('連結已撤銷。',{exact:true}).waitFor();assert(shares[0].revokedAt);
    uncertain=true;await content.getByRole('button',{name:'建立七天分享連結'}).click();await content.getByRole('button',{name:'重試同一次建立'}).waitFor({state:'visible'});const uncertainId=calls().filter(row=>row.path===api+'/shares').at(-1).data.requestId;assert.equal(issued.size,2);assert.equal(await content.getByRole('button',{name:'建立七天分享連結'}).isDisabled(),true);await content.getByRole('button',{name:'重試同一次建立'}).click();await page.waitForTimeout(70);assert.equal(calls().filter(row=>row.path===api+'/shares').at(-1).data.requestId,uncertainId);assert.equal(issued.size,2,'Same issuance retry cannot mint another token');assert.equal(await content.getByRole('button',{name:'建立七天分享連結'}).isDisabled(),true);
    await content.getByRole('button',{name:'重新載入分享清單'}).click();await page.waitForFunction(()=>document.querySelectorAll('.demo-share-entry').length===2);assert.equal(await content.getByRole('button',{name:'結束這次嘗試'}).isVisible(),false,'Unknown active share must be revoked before resolving');assert.equal(await content.locator('.demo-share-links a').count(),0);await content.getByRole('button',{name:'撤銷連結'}).click();await content.getByRole('button',{name:'結束這次嘗試'}).waitFor({state:'visible'});await content.getByRole('button',{name:'結束這次嘗試'}).click();await content.getByRole('button',{name:'建立七天分享連結'}).click();await content.getByRole('link',{name:'開啟新分享連結'}).waitFor();assert.equal(issued.size,3);assert.notEqual(calls().filter(row=>row.path===api+'/shares').at(-1).data.requestId,uncertainId,'Only a fresh explicit action gets a new operation ID');
    unsafePath=true;await content.getByRole('button',{name:'建立七天分享連結'}).click();await content.getByRole('button',{name:'重試同一次建立'}).waitFor({state:'visible'});assert.equal(await content.locator('a[href^="javascript:"]').count(),0,'Unsafe returned path is never rendered');unsafePath=false;
    getDelay=350;await content.getByRole('button',{name:'重新載入分享清單'}).click();role='anonymous';await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await page.locator('#login').waitFor({state:'visible'});assert.equal(await content.locator('*').count(),0);await page.waitForTimeout(400);assert.equal(await content.locator('*').count(),0,'Late metadata cannot revive private DOM');getDelay=0;
    role='admin';await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await page.locator('#private-workspace').waitFor({state:'visible'});await panel.locator(':scope > summary').click();await content.locator('.demo-share-entry').first().waitFor();assert.equal(await content.locator('.demo-share-links a').count(),0,'Authorized return loads metadata only');shareDelay=400;await content.getByRole('button',{name:'建立七天分享連結'}).click();await page.locator('#logout').click();await page.locator('#login').waitFor({state:'visible'});await page.waitForTimeout(450);assert.equal(await content.locator('*').count(),0,'Late capability after logout cannot reappear');assert.equal(await panel.getAttribute('open'),null);assert.equal(await page.evaluate(()=>localStorage.length+sessionStorage.length),0);assert.deepEqual(errors,[]);
    console.log('PASS TAAZE Demo manager synthetic UI: lazy admin boundary, explicit import/issuance, double click, capability safety, locale, uncertain same-ID retry+revoke, metadata refresh, 390/1280, expiry and logout');
  }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error.stack);process.exitCode=1;server.close();});
