'use strict';
// Managed headless browser verification of a NON-FORMAL client specimen. No real App/build/signing operation.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium}=require('../../backend/node_modules/playwright');
async function main(file){
    assert.ok(path.isAbsolute(file)&&fs.realpathSync(file)===file);const config=JSON.parse(fs.readFileSync(file)),base=new URL(config.baseURL);
    assert.equal(config.kind,'NON_FORMAL_CLIENT_READINESS');assert.equal(base.hostname,'127.0.0.1');assert.equal(base.protocol,'http:');assert.ok(/^\/tmp\/stray-readiness-[a-f0-9]{8}\.sock$/.test(config.operatorSocket));
    const output=path.join(config.runRoot,'client-evidence');fs.mkdirSync(output,{mode:0o700});
    const checks=[],screenshots=[];let browser,external=0,mutations=0;
    const check=(name,fn)=>{fn();checks.push({name,passed:true});};
    const operator=action=>new Promise((resolve,reject)=>{const req=http.request({socketPath:config.operatorSocket,path:'/',method:'POST',headers:{'Content-Type':'application/json',Connection:'close'}},res=>{let body='';res.on('data',v=>body+=v);res.on('end',()=>{try{const data=JSON.parse(body);if(!data.success)throw Error(data.error||'PRIVATE_FIXTURE_ACTION_FAILED');resolve(data);}catch(error){reject(error);}});});req.on('error',reject);req.setTimeout(30000,()=>req.destroy(Error('FIXTURE_ACTION_TIMEOUT')));req.end(JSON.stringify({action}));});
    const photoCode=async()=>{const r=await fetch(config.photoURL,{redirect:'error',headers:{Connection:'close'}});await r.arrayBuffer();return r.status;};
    try{
        const executablePath=[process.env.HUB_TEST_CHROME_BIN,chromium.executablePath(),'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean).find(p=>fs.existsSync(p));if(!executablePath)throw Error('EXISTING_BROWSER_NOT_AVAILABLE');
        browser=await chromium.launch({headless:true,executablePath,args:['--disable-background-networking','--disable-component-update','--disable-sync','--no-first-run']});
        const context=await browser.newContext({viewport:{width:1280,height:900},serviceWorkers:'block'});await context.route('**/*',async route=>{const req=route.request(),u=new URL(req.url());if(u.origin!==base.origin){external++;return route.abort();}if(!['GET','HEAD'].includes(req.method())){mutations++;return route.abort();}return route.continue();});
        const page=await context.newPage();
        async function settled(){await page.waitForFunction(()=>window.__CLIENT_SPECIMEN__&&['AVAILABLE','UNAVAILABLE'].includes(window.__CLIENT_SPECIMEN__.status));}
        async function load(locale='zh-TW'){await page.goto(`${base.origin}/prototype-client/?lang=${locale}`,{waitUntil:'networkidle'});await settled();}
        async function refresh(){await Promise.all([page.waitForResponse(r=>r.url().includes('/v1/animals?view=external-origin-v1')),page.locator('#reload').click()]);await settled();}
        async function ids(){return page.locator('.lead-card').evaluateAll(nodes=>nodes.map(n=>n.dataset.id).sort());}
        async function expectIds(expected){const wanted=[...expected].sort();await page.waitForFunction(w=>JSON.stringify(window.__CLIENT_SPECIMEN__.visible.slice().sort())===JSON.stringify(w),wanted);assert.deepEqual(await ids(),wanted);}
        async function screenshot(name,width){await page.setViewportSize({width,height:width<600?844:900});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1));const target=path.join(output,`${name}-${width}.png`);await page.screenshot({path:target,fullPage:true});screenshots.push(target);}
        await load();await expectIds([]);check('permanent non-formal banner and pending cards absent',()=>assert.equal(config.sourceAudit,'APP_SOURCE_AND_AUTHORIZED_BUILD_UNAVAILABLE'));
        assert.ok((await page.locator('#notice').innerText()).includes('不是浪浪地圖 App'));await screenshot('pending',390);
        let state=await operator('APPROVE');await refresh();await expectIds(['lost','found','duplicate','sighting','unlicensed'].map(name=>config.publicIds[name]));
        check('client reads actual reviewed API, not an embedded dataset',()=>assert.equal(state.view.externalLeads.length,5));
        const recommendations=await operator('CONFIRM_DUPLICATE');await refresh();await expectIds(['lost','found','sighting','unlicensed'].map(name=>config.publicIds[name]));
        check('persistent manual duplicate decision hides one source only; lost/found remain distinct',()=>assert.equal(recommendations.decisions.length,1));
        const foundCard=page.locator(`[data-id="${config.publicIds.found}"]`),lostCard=page.locator(`[data-id="${config.publicIds.lost}"]`);
        assert.equal(await foundCard.getAttribute('lang'),'en-US');assert.equal(await page.locator(`[data-id="${config.publicIds.sighting}"]`).getAttribute('lang'),'zh-TW');
        assert.ok((await foundCard.innerText()).includes(config.sourceFields.foundObservation.value));assert.ok((await lostCard.innerText()).includes(config.sourceFields.lostObservation.value));
        assert.ok((await foundCard.innerText()).includes(config.sourceFields.foundCustody.asOf.value));assert.equal(await foundCard.locator('[data-precision="DATE"]').count(),1);
        await page.waitForFunction(id=>{const image=document.querySelector(`[data-id="${id}"] img`);return image&&image.complete&&image.naturalWidth>0;},config.publicIds.found);assert.equal(await photoCode(),200);
        check('source language, DATE precision, care-asOf and actual admitted image survive client rendering',()=>assert.equal(config.sourceFields.foundObservation.precision,'DATE'));
        const body=await page.locator('body').innerText();for(const forbidden of ['private@example','publisherId','datasetId','recordKey','evidenceRef','T00:00:00','latitude','longitude'])assert.ok(!body.includes(forbidden));
        assert.equal(await page.locator(`[data-id="${config.publicIds.unlicensed}"] img`).count(),0);
        check('unlicensed image is omitted while its reviewed text clue remains',()=>assert.equal(state.imageFetches,0));
        for(const locale of ['en','zh-TW','zh-CN','ja','ko']){await load(locale);assert.equal(await page.locator('html').getAttribute('lang'),locale);assert.equal(await page.locator(`[data-id="${config.publicIds.found}"]`).getAttribute('lang'),'en-US');}
        await load('zh-TW');await screenshot('approved',1280);await screenshot('approved',390);
        const metrics=await page.evaluate(()=>window.__CLIENT_SPECIMEN__);assert.equal(metrics.pins,0);assert.deepEqual(metrics.coordinates,[]);assert.equal(await page.locator('.map-pin,[data-latitude],[data-longitude]').count(),0);
        check('mobile/desktop region cards have no fabricated coordinates, pins or inferred care location',()=>assert.equal(config.trustedPointAvailable,false));
        state=await operator('ABSENT');await refresh();await expectIds(['found','sighting','unlicensed'].map(name=>config.publicIds[name]));let lost=state.rows.find(r=>r.id===config.privateIds.lost);
        check('complete missing snapshot hides client card without closing the source case',()=>{assert.equal(lost.source_availability,'ABSENT');assert.equal(lost.source_case_status,'NOT_CONFIRMED_CLOSED');});assert.equal(state.view.dataQuality.sourceAvailability,'PARTIAL');
        state=await operator('OUTAGE_PEER');await refresh();await expectIds(['lost','sighting','unlicensed'].map(name=>config.publicIds[name]));const found=state.rows.find(r=>r.id===config.privateIds.found);
        check('temporary source outage hides card and image but does not claim closure or reunion',()=>{assert.equal(found.source_availability,'UNAVAILABLE');assert.equal(found.source_case_status,'NOT_CONFIRMED_CLOSED');});assert.equal(await photoCode(),404);await screenshot('source-gap',390);
        state=await operator('PRESENT');await refresh();await expectIds(['lost','found','sighting','unlicensed'].map(name=>config.publicIds[name]));
        check('source recovery restores permitted cards without changing date/care precision',()=>assert.deepEqual(state.view.externalLeads.find(v=>v.id===config.publicIds.found).report.custody,config.sourceFields.foundCustody));
        state=await operator('CLOSE');await refresh();await expectIds(['found','sighting','unlicensed'].map(name=>config.publicIds[name]));lost=state.rows.find(r=>r.id===config.privateIds.lost);
        check('explicit source closure persists its own evidence and never claims reunion',()=>{assert.equal(lost.source_case_status,'CLOSED_BY_SOURCE');assert.equal(lost.source_closure_evidence.reunionVerified,false);assert.equal(lost.source_closure_evidence.sourceChangedAt.precision,'DATE');});
        state=await operator('PRESENT');await refresh();await expectIds(['found','sighting','unlicensed'].map(name=>config.publicIds[name]));check('subsequent presence cannot reopen source-closed case',()=>assert.equal(state.rows.find(r=>r.id===config.privateIds.lost).source_case_status,'CLOSED_BY_SOURCE'));
        state=await operator('REVOKE_PHOTO');await refresh();await expectIds(['sighting','unlicensed'].map(name=>config.publicIds[name]));assert.equal(await photoCode(),404);
        check('persisted author permission revocation removes image and its unsafe projection',()=>assert.equal(state.grants[0].state,'REVOKED'));
        state=await operator('WITHDRAW');await refresh();await expectIds([config.publicIds.unlicensed]);check('manual withdrawal disappears from client after reload',()=>assert.equal(state.rows.find(r=>r.id===config.privateIds.sighting).review,'WITHDRAWN'));
        state=await operator('OUTAGE_ALL');await refresh();await page.waitForFunction(()=>window.__CLIENT_SPECIMEN__.status==='UNAVAILABLE');await expectIds([]);assert.equal(await page.locator('#count').innerText(),'—');
        check('all sources unavailable shows unknown count, not a fabricated zero',()=>assert.equal(state.view.dataQuality.sourceAvailability,'UNAVAILABLE'));await screenshot('unavailable',390);
        state=await operator('PRESENT');await refresh();await expectIds([config.publicIds.unlicensed]);
        check('replay/recovery cannot undo closure, duplicate exclusion, rights revocation or withdrawal',()=>assert.equal(state.decisions.length,1));
        const persistence=await operator('PERSIST');assert.ok(persistence.probe.success);assert.equal(persistence.probe.grants[0].state,'REVOKED');assert.equal(persistence.probe.decisions.length,1);assert.deepEqual(persistence.probe.native,{devices:0,animals:0,sightings:0});
        check('source receipts/states, duplicate decision and author evidence survive fresh process',()=>assert.equal(persistence.probe.rows.length,8));
        for(const type of ['EXPLICIT_CLOSED','ABSENT','TEMPORARY_FAILURE','PRESENT'])assert.ok(persistence.probe.events.some(e=>e.type===type));
        assert.equal(await page.locator('#point-layer .map-pin').count(),0);await screenshot('final',1280);check('browser is GET/HEAD-only, own-origin only and all native rows remain zero',()=>{assert.equal(external,0);assert.equal(mutations,0);});
        fs.writeFileSync(path.join(output,'RESULT.private.json'),JSON.stringify({success:true,prototypeOnly:true,realAppVerified:false,checks,screenshots,externalRequests:external,mutations,mapPins:0,trustedPointAvailable:false,
            pointLayerPositiveTest:'NOT_RUN_NO_VERIFIED_APPROVED_SOURCE_POINT',productionWrites:0,sourcePersistenceProcess:persistence.probe.processId},null,2)+'\n',{mode:0o600,flag:'wx'});
        console.log(JSON.stringify({success:true,checks:checks.length,screenshots:screenshots.length,output,prototypeOnly:true,realApp:false,productionWrites:0}));
    }catch(error){fs.writeFileSync(path.join(output,'FAILURE.private.json'),JSON.stringify({success:false,error:error.message,checks},null,2)+'\n',{mode:0o600,flag:'wx'});throw error;}
    finally{if(browser)await browser.close();await operator('STOP').catch(()=>{});}
}
if(require.main===module)main(process.argv[2]).catch(error=>{console.error(error.stack);process.exitCode=1});
module.exports={main};
