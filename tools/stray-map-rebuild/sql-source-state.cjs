'use strict';
// Isolated synthetic source lifecycle. Closure is authoritative, while absence/outage are availability only.
const {createHash,randomUUID}=require('node:crypto');
const {validateSourceEvent}=require('../stray-map-intake/case-semantics');
const {definitelyAfter,temporal}=require('../stray-map-intake/contract');
const UNKNOWN={precision:'UNKNOWN',value:null,timeZone:null};
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail=(error,status=400)=>({success:false,error,status});
async function init(pool){
    await pool.query(`ALTER TABLE rebuild_external.tips ADD COLUMN IF NOT EXISTS source_case_status text NOT NULL DEFAULT 'NOT_CONFIRMED_CLOSED';
        ALTER TABLE rebuild_external.tips ADD COLUMN IF NOT EXISTS source_availability text NOT NULL DEFAULT 'UNVERIFIED';
        ALTER TABLE rebuild_external.tips ADD COLUMN IF NOT EXISTS source_changed_at jsonb NOT NULL DEFAULT '{"precision":"UNKNOWN","value":null,"timeZone":null}';
        ALTER TABLE rebuild_external.tips ADD COLUMN IF NOT EXISTS source_checked_at timestamptz;
        ALTER TABLE rebuild_external.tips ADD COLUMN IF NOT EXISTS source_closure_evidence jsonb;
        CREATE TABLE IF NOT EXISTS rebuild_external.source_events(
          publisher text NOT NULL,dataset text NOT NULL,event_key text NOT NULL,payload_hash text NOT NULL,
          tip_id text NOT NULL REFERENCES rebuild_external.tips(id),receipt jsonb NOT NULL,
          PRIMARY KEY(publisher,dataset,event_key));
        CREATE TABLE IF NOT EXISTS rebuild_external.source_gates(
          publisher text NOT NULL,dataset text NOT NULL,blocked boolean NOT NULL,reason text NOT NULL,
          PRIMARY KEY(publisher,dataset));
        CREATE TABLE IF NOT EXISTS rebuild_external.source_checks(
          publisher text NOT NULL,dataset text NOT NULL,availability text NOT NULL,
          checked_at timestamptz NOT NULL,complete_snapshot boolean NOT NULL,PRIMARY KEY(publisher,dataset))`);
}
async function noteAccepted(client,id,now){await client.query("UPDATE rebuild_external.tips SET source_availability='PRESENT',source_checked_at=$2 WHERE id=$1",[id,now]);}
// Use in every public reader. Missing/unknown state is not assumed current; a blocked source is never visible.
function visibleSQL(alias='t'){
    if(!/^[a-z]$/.test(alias))throw Error('INVALID_SQL_ALIAS');
    return `${alias}.source_case_status!='CLOSED_BY_SOURCE' AND ${alias}.source_availability='PRESENT'
        AND NOT EXISTS(SELECT 1 FROM rebuild_external.source_gates sg WHERE sg.publisher=${alias}.publisher AND sg.dataset=${alias}.dataset AND sg.blocked=true)`;
}
class SqlSourceState{
    constructor({pool,sourcePolicies,now,eventLimit=2000}){
        if(!Array.isArray(sourcePolicies)||!sourcePolicies.length||sourcePolicies.some(p=>!p.verified||!p.publisherId.startsWith('synthetic-')||!new URL(p.origin).hostname.endsWith('.example.invalid'))
            ||typeof now!=='function'||!Number.isSafeInteger(eventLimit)||eventLimit<1||eventLimit>2000)throw Error('SYNTHETIC_SOURCE_STATE_ONLY');
        this.pool=pool;this.policies=sourcePolicies;this.now=now;this.limit=eventLimit;
    }
    async event(event,{completeSnapshot=false}={},transactionClient=null){
        const now=this.now(),policy=this.policies.find(p=>p.publisherId===event?.publisherId&&p.datasetId===event?.datasetId);
        if(!temporal({precision:'INSTANT',value:now,timeZone:'UTC'})||!validateSourceEvent(event,policy,now))return fail('INVALID_SOURCE_EVENT');
        if(event.type==='ABSENT'&&completeSnapshot!==true)return fail('INCOMPLETE_SNAPSHOT',409);
        const canonical={...Object.fromEntries(Object.keys(event).sort().map(key=>[key,event[key]])),sourceChangedAt:Object.fromEntries(Object.keys(event.sourceChangedAt).sort().map(key=>[key,event.sourceChangedAt[key]]))};
        const hash=digest(canonical),owns=!transactionClient,client=transactionClient||await this.pool.connect();
        const finish=async sql=>{if(owns)await client.query(sql);};
        try{
            if(owns)await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[event.publisherId]);
            const existing=(await client.query('SELECT payload_hash,receipt FROM rebuild_external.source_events WHERE publisher=$1 AND dataset=$2 AND event_key=$3',[event.publisherId,event.datasetId,event.eventKey])).rows[0];
            if(existing){await finish('COMMIT');return existing.payload_hash===hash?{success:true,replay:true,eventReceipt:existing.receipt}:fail('SOURCE_EVENT_CONFLICT',409);}
            const row=(await client.query('SELECT * FROM rebuild_external.tips WHERE publisher=$1 AND dataset=$2 AND record_key=$3 FOR UPDATE',[event.publisherId,event.datasetId,event.recordKey])).rows[0];
            if(!row){await finish('ROLLBACK');return fail('NOT_FOUND',404);}
            const count=(await client.query('SELECT count(*)::int n FROM rebuild_external.source_events WHERE publisher=$1 AND dataset=$2',[event.publisherId,event.datasetId])).rows[0].n;
            if(!Number.isSafeInteger(count)||count<0)throw Error('INVALID_SOURCE_EVENT_COUNT');
            if(count>=this.limit){
                await client.query(`INSERT INTO rebuild_external.source_gates VALUES($1,$2,true,'SOURCE_EVENT_CAPACITY')
                    ON CONFLICT(publisher,dataset) DO UPDATE SET blocked=true,reason='SOURCE_EVENT_CAPACITY'`,[event.publisherId,event.datasetId]);
                await finish('COMMIT');return fail('SOURCE_EVENT_CAPACITY',503);
            }
            if(definitelyAfter(row.source_changed_at||UNKNOWN,event.sourceChangedAt)){await finish('ROLLBACK');return fail('STALE_SOURCE_EVENT',409);}
            const state=event.type==='EXPLICIT_CLOSED'?'CLOSED_BY_SOURCE':row.source_case_status;
            const availability={EXPLICIT_CLOSED:'PRESENT',PRESENT:'PRESENT',ABSENT:'ABSENT',TEMPORARY_FAILURE:'UNAVAILABLE'}[event.type];
            const changed=event.sourceChangedAt.precision==='UNKNOWN'?(row.source_changed_at||UNKNOWN):event.sourceChangedAt;
            const closure=event.type==='EXPLICIT_CLOSED'?(row.source_closure_evidence||{receivedAt:now,sourceChangedAt:event.sourceChangedAt,reunionVerified:false}):row.source_closure_evidence;
            await client.query(`UPDATE rebuild_external.tips SET source_case_status=$2,source_availability=$3,source_changed_at=$4,
                source_checked_at=$5,source_closure_evidence=$6 WHERE id=$1`,[row.id,state,availability,changed,now,closure||null]);
            const receipt={eventId:`sourceevt_${randomUUID().replaceAll('-','')}`,tipId:row.id,type:event.type,receivedAt:now,reunionVerified:false};
            const saved=await client.query('INSERT INTO rebuild_external.source_events VALUES($1,$2,$3,$4,$5,$6) RETURNING receipt',[event.publisherId,event.datasetId,event.eventKey,hash,row.id,receipt]);
            if(count+1>=this.limit)await client.query(`INSERT INTO rebuild_external.source_gates VALUES($1,$2,true,'SOURCE_EVENT_CAPACITY')
                ON CONFLICT(publisher,dataset) DO UPDATE SET blocked=true,reason='SOURCE_EVENT_CAPACITY'`,[event.publisherId,event.datasetId]);
            await finish('COMMIT');return {success:true,replay:false,eventReceipt:saved.rows[0].receipt};
        }catch(error){await finish('ROLLBACK').catch(()=>{});throw error;}finally{if(owns)client.release();}
    }
    async availability(scope,{seenKeys=[],acceptedKeys=[],completeSnapshot=false,unavailable=false,jobId}={}){
        const policy=this.policies.find(p=>p.verified&&p.publisherId===scope?.publisherId&&p.datasetId===scope?.datasetId);
        if(!policy||typeof jobId!=='string'||!/^[a-z0-9-]{3,64}$/.test(jobId)||![seenKeys,acceptedKeys].every(v=>Array.isArray(v)&&v.length<=20&&v.every(k=>typeof k==='string')))return fail('INVALID_SOURCE_SCOPE');
        const now=this.now(),client=await this.pool.connect();
        try{
            await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[policy.publisherId]);
            const rows=(await client.query('SELECT id,record_key FROM rebuild_external.tips WHERE publisher=$1 AND dataset=$2 FOR UPDATE',[policy.publisherId,policy.datasetId])).rows;
            const seen=new Set(seenKeys),accepted=new Set(acceptedKeys),results=[];
            for(const row of rows){const type=unavailable||(seen.has(row.record_key)&&!accepted.has(row.record_key))?'TEMPORARY_FAILURE':accepted.has(row.record_key)?'PRESENT':completeSnapshot?'ABSENT':null;
                if(!type)continue;results.push(await this.event({publisherId:policy.publisherId,datasetId:policy.datasetId,recordKey:row.record_key,
                    eventKey:digest(['source-check-v1',jobId,now,row.record_key,type]),type,sourceChangedAt:{...UNKNOWN}},{completeSnapshot},client));}
            const success=results.every(v=>v.success);
            if(!success)await client.query(`INSERT INTO rebuild_external.source_gates VALUES($1,$2,true,'SOURCE_CHECK_FAILED')
                ON CONFLICT(publisher,dataset) DO UPDATE SET blocked=true,
                reason=CASE WHEN source_gates.reason='SOURCE_EVENT_CAPACITY' THEN source_gates.reason ELSE 'SOURCE_CHECK_FAILED' END`,[policy.publisherId,policy.datasetId]);
            else await client.query("DELETE FROM rebuild_external.source_gates WHERE publisher=$1 AND dataset=$2 AND reason='SOURCE_CHECK_FAILED'",[policy.publisherId,policy.datasetId]);
            const coverage=unavailable||!success?'UNAVAILABLE':seenKeys.length!==acceptedKeys.length||!completeSnapshot||results.some(v=>v.eventReceipt?.type==='ABSENT')?'PARTIAL':'AVAILABLE';
            await client.query(`INSERT INTO rebuild_external.source_checks VALUES($1,$2,$3,$4,$5)
                ON CONFLICT(publisher,dataset) DO UPDATE SET availability=$3,checked_at=$4,complete_snapshot=$5`,[policy.publisherId,policy.datasetId,coverage,now,completeSnapshot]);
            await client.query('COMMIT');return {success,applied:true,results};
        }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
    }
}
module.exports={init,noteAccepted,visibleSQL,SqlSourceState};
