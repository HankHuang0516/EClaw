'use strict';
// Separate process, read-only SQL on the exact disposable database. No migrations or App/user identity.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');const {createRequire}=require('node:module');
async function main(file){const config=JSON.parse(fs.readFileSync(file)),u=new URL(process.env.DATABASE_URL);
    assert.equal(process.env.STRAY_REBUILD_SYNTHETIC,'1');assert.equal(config.kind,'READINESS_SYNTHETIC_PROBE');assert.equal(u.hostname,'localhost');assert.equal(u.pathname,'/stray_map_synthetic');assert.equal(u.username,'postgres');assert.equal(u.password,'');
    const local=createRequire(path.join(config.workspace,'apps/api/package.json')),pool=new(local('pg').Pool)({connectionString:u.href,ssl:false});
    try{const rows=(await pool.query('SELECT id,receipt,review,source_case_status,source_availability,source_closure_evidence FROM rebuild_external.tips ORDER BY id')).rows;
        for(const expected of config.receipts)assert.deepEqual(rows.find(row=>row.id===expected.tipId).receipt,expected);
        const grants=(await pool.query('SELECT id,state,proof_hash FROM rebuild_external.photo_rights_grants ORDER BY id')).rows;
        const decisions=(await pool.query('SELECT id,target_id FROM rebuild_external.duplicate_decisions ORDER BY id')).rows;
        const links=(await pool.query('SELECT kind,count(*)::int n FROM rebuild_external.candidate_links GROUP BY kind ORDER BY kind')).rows;
        const events=(await pool.query("SELECT receipt->>'type' type,count(*)::int n FROM rebuild_external.source_events GROUP BY receipt->>'type' ORDER BY type")).rows;
        const native=(await pool.query('SELECT (SELECT count(*)::int FROM devices) devices,(SELECT count(*)::int FROM animals) animals,(SELECT count(*)::int FROM sightings) sightings')).rows[0];assert.deepEqual(native,{devices:0,animals:0,sightings:0});
        process.stdout.write(JSON.stringify({success:true,processId:process.pid,rows,grants,decisions,links,events,native}));
    }finally{await pool.end();}}
if(require.main===module)main(process.argv[2]).catch(error=>{console.error(error.message);process.exitCode=1});
