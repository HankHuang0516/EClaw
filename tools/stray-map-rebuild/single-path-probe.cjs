'use strict';
// Fresh-process scheduler/receipt probe. Uses only the runner's synthetic DB and owned loopback native process.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {createRequire}=require('node:module');
const {PendingService}=require('./pending-service.cjs');
const {PgSchedulerBridge,withPgScheduledPass}=require('./pg-scheduler.cjs');
const {startLoopback}=require('../stray-map-intake/rehearsal');
async function main(file){
    const config=JSON.parse(fs.readFileSync(file));const url=new URL(process.env.DATABASE_URL);
    assert.equal(process.env.STRAY_REBUILD_SYNTHETIC,'1');assert.equal(config.kind,'SYNTHETIC_SINGLE_PATH_PROBE');
    assert.equal(url.hostname,'localhost');assert.equal(url.pathname,'/stray_map_synthetic');assert.equal(url.password,'');
    const localRequire=createRequire(path.join(config.workspace,'apps/api/package.json')),pool=new(localRequire('pg').Pool)({connectionString:url.href,ssl:false});
    let sourceRequests=0;const source=await startLoopback((req,res)=>{sourceRequests++;const policy=config.policies.find(p=>req.url===`/${p.publisherId}`);
        res.writeHead(policy?200:404,{'Content-Type':'application/json'});res.end(JSON.stringify({synthetic:true,records:policy?config.records.filter(t=>t.source.publisherId===policy.publisherId):[]}));});
    try{
        const bridge=new PgSchedulerBridge({pool,sourcePolicies:config.policies,now:()=>config.clock,syntheticDatabase:true});await bridge.init();
        const rounds=[];for(const policy of config.policies)rounds.push(await withPgScheduledPass({bridge,sourceURL:`${source.url}/${policy.publisherId}`,
            receiverURL:config.nativeURL,sourceScope:policy,jobId:'synthetic-single-path',nativeReceiverVerified:true}));
        const service=new PendingService({pool,sourcePolicies:config.policies,now:()=>config.clock,knownSyntheticPixelHashes:config.pixelHashes});
        const receipts=[];for(const expected of config.receipts){const found=await service.getReceipt(expected.tipId);assert.deepEqual(found.receipt,expected);receipts.push(found.receipt);}
        const counts=(await pool.query('SELECT (SELECT count(*)::int FROM devices) devices,(SELECT count(*)::int FROM animals) animals,(SELECT count(*)::int FROM sightings) sightings')).rows[0];
        assert.deepEqual(counts,{devices:0,animals:0,sightings:0});
        process.stdout.write(JSON.stringify({success:true,processId:process.pid,clock:config.clock,sourceRequests,rounds,receipts,nativeCounts:counts}));
    }finally{await source.close();await pool.end();}
}
if(require.main===module)main(process.argv[2]).catch(error=>{console.error(error.message);process.exitCode=1});
