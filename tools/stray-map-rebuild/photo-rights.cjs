'use strict';
// Private synthetic author evidence ledger. No remote fetching, real-author claim, credentials or public write route.
const {randomUUID,createHash}=require('node:crypto');
const {validateTip}=require('../stray-map-intake/contract');
const hash=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const scope=c=>({publisherId:c.publisherId,datasetId:c.datasetId,recordKey:c.recordKey});
const same=(a,b)=>a&&b&&a.publisherId===b.publisherId&&a.datasetId===b.datasetId&&a.recordKey===b.recordKey;
const PROOF_KEYS=['kind','creator','purpose','originalHash','scope','license','mayRepublish','mayRedact','caseBindingReviewed'];
const canonical=proof=>Object.fromEntries(PROOF_KEYS.map(k=>[k,k==='scope'?scope(proof.scope):proof[k]]));
const fail=(error,status=403)=>({success:false,error,status});
async function init(pool){await pool.query(`CREATE TABLE IF NOT EXISTS rebuild_external.photo_rights_grants(
    id text PRIMARY KEY,publisher text NOT NULL,dataset text NOT NULL,record_key text NOT NULL,original_hash text NOT NULL,
    proof_hash text NOT NULL,proof jsonb NOT NULL,rights jsonb NOT NULL,state text NOT NULL CHECK(state IN ('ACTIVE','REVOKED')),
    created_at timestamptz NOT NULL,revoked_at timestamptz,UNIQUE(publisher,dataset,record_key,original_hash));
    ALTER TABLE rebuild_external.photos ADD COLUMN IF NOT EXISTS grant_id text REFERENCES rebuild_external.photo_rights_grants(id)`);}
class PhotoRights{
    constructor({pool,sourcePolicies,knownSyntheticPixelHashes,now}){
        if(!Array.isArray(sourcePolicies)||!sourcePolicies.length||sourcePolicies.some(p=>!p.verified||!p.publisherId.startsWith('synthetic-')||!new URL(p.origin).hostname.endsWith('.example.invalid'))
            ||!Array.isArray(knownSyntheticPixelHashes)||typeof now!=='function')throw Error('SYNTHETIC_PHOTO_LEDGER_ONLY');
        this.pool=pool;this.policies=sourcePolicies;this.hashes=new Set(knownSyntheticPixelHashes);this.now=now;}
    async register({context,originalHash,proof}){
        const p=this.policies.find(v=>v.verified&&same({...v,recordKey:context?.recordKey},context));
        const keys=PROOF_KEYS;
        if(!p||!this.hashes.has(originalHash)||!proof||typeof proof!=='object'||Array.isArray(proof)||Object.keys(proof).length!==keys.length||!keys.every(k=>Object.hasOwn(proof,k))
            ||proof.kind!=='SELF_MADE_SYNTHETIC_PIXELS'||proof.creator!=='REPO_SYNTHETIC_GENERATOR'||proof.purpose!=='ISOLATED_QA_ONLY'
            ||proof.originalHash!==originalHash||!same(proof.scope,context)||Object.keys(proof.scope).length!==3||proof.license!=='EXPLICIT_PERMISSION'
            ||proof.mayRepublish!==true||proof.mayRedact!==true||proof.caseBindingReviewed!==true)return fail('PHOTO_EVIDENCE_NOT_ADMISSIBLE');
        const evidence=canonical(proof),proofHash=hash(evidence),client=await this.pool.connect();
        try{await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[context.publisherId]);
            const prior=(await client.query('SELECT * FROM rebuild_external.photo_rights_grants WHERE publisher=$1 AND dataset=$2 AND record_key=$3 AND original_hash=$4',
                [context.publisherId,context.datasetId,context.recordKey,originalHash])).rows[0];
            if(prior){await client.query('COMMIT');return this.validRecord(prior)&&prior.proof_hash===proofHash?{success:true,grantId:prior.id,rights:prior.rights,replay:true}:fail('PHOTO_EVIDENCE_CONFLICT_OR_REVOKED',409);}
            const id=`grant_${randomUUID().replaceAll('-','')}`,rights={license:'EXPLICIT_PERMISSION',evidenceRef:`ev_${randomUUID().replaceAll('-','')}`,attributionRef:`credit_${randomUUID().replaceAll('-','')}`,permitsRedaction:true};
            const saved=await client.query(`INSERT INTO rebuild_external.photo_rights_grants(id,publisher,dataset,record_key,original_hash,proof_hash,proof,rights,state,created_at)
                VALUES($1,$2,$3,$4,$5,$6,$7,$8,'ACTIVE',$9) RETURNING id,rights`,[id,context.publisherId,context.datasetId,context.recordKey,originalHash,proofHash,evidence,rights,this.now()]);
            await client.query('COMMIT');return {success:true,grantId:saved.rows[0].id,rights:saved.rows[0].rights,replay:false};
        }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
    }
    async find(grantId,context,originalHash){
        if(typeof grantId!=='string'||!/^grant_[a-f0-9]{32}$/.test(grantId))return null;
        const row=(await this.pool.query("SELECT * FROM rebuild_external.photo_rights_grants WHERE id=$1 AND state='ACTIVE'",[grantId])).rows[0];
        return row&&this.validRecord(row)&&same({publisherId:row.publisher,datasetId:row.dataset,recordKey:row.record_key},context)&&row.original_hash===originalHash?row:null;
    }
    validRecord(row){
        const proof=row?.proof,context={publisherId:row?.publisher,datasetId:row?.dataset,recordKey:row?.record_key};
        return !!(row&&row.state==='ACTIVE'&&this.hashes.has(row.original_hash)&&this.policies.some(p=>p.verified&&p.publisherId===row.publisher&&p.datasetId===row.dataset)
            &&proof&&typeof proof==='object'&&!Array.isArray(proof)&&Object.keys(proof).length===PROOF_KEYS.length&&PROOF_KEYS.every(k=>Object.hasOwn(proof,k))
            &&proof.kind==='SELF_MADE_SYNTHETIC_PIXELS'&&proof.creator==='REPO_SYNTHETIC_GENERATOR'&&proof.purpose==='ISOLATED_QA_ONLY'
            &&proof.originalHash===row.original_hash&&same(proof.scope,context)&&Object.keys(proof.scope).length===3&&proof.license==='EXPLICIT_PERMISSION'
            &&proof.mayRepublish===true&&proof.mayRedact===true&&proof.caseBindingReviewed===true&&hash(canonical(proof))===row.proof_hash
            &&row.rights&&typeof row.rights==='object'&&Object.keys(row.rights).length===4
            &&/^ev_[a-f0-9]{32}$/.test(row.rights.evidenceRef)&&/^credit_[a-f0-9]{32}$/.test(row.rights.attributionRef)
            &&row.rights?.license==='EXPLICIT_PERMISSION'&&row.rights?.permitsRedaction===true);
    }
    async revoke(grantId){if(typeof grantId!=='string'||!/^grant_[a-f0-9]{32}$/.test(grantId))return fail('INVALID_GRANT');
        const rows=(await this.pool.query("UPDATE rebuild_external.photo_rights_grants SET state='REVOKED',revoked_at=COALESCE(revoked_at,$2) WHERE id=$1 RETURNING id",[grantId,this.now()])).rows;
        return rows.length?{success:true,grantId,state:'REVOKED'}:fail('NOT_FOUND',404);}
    async admit(tip,candidates,verifiedUploads){
        if(!Array.isArray(candidates)||candidates.length>10)return fail('INVALID_IMAGE_CANDIDATES',400);
        const base={...tip,photos:[]},basePolicy=this.policies.find(p=>p.publisherId===tip?.source?.publisherId&&p.datasetId===tip?.source?.datasetId);
        const baseCheck=validateTip(Buffer.from(JSON.stringify(base)),{submittedAt:this.now(),sourcePolicy:basePolicy,verifiedUploads});
        if(!baseCheck.success)return baseCheck;
        const accepted=[],omitted=[],seen=new Set();
        for(const candidate of candidates){
            if(candidate&&typeof candidate==='object'&&Object.hasOwn(candidate,'url')){omitted.push({reason:'UNVERIFIED_REMOTE_URL',privateReferenceHash:hash(String(candidate.url))});continue;}
            if(candidate?.uploadId&&seen.has(candidate.uploadId)){omitted.push({reason:'DUPLICATE_IMAGE_REFERENCE'});continue;}
            const probe={...tip,photos:[candidate]},policy=this.policies.find(p=>p.publisherId===tip.source.publisherId&&p.datasetId===tip.source.datasetId);
            const result=validateTip(Buffer.from(JSON.stringify(probe)),{submittedAt:this.now(),sourcePolicy:policy,verifiedUploads});
            if(result.success&&accepted.length<2){accepted.push(candidate);seen.add(candidate.uploadId);}else omitted.push({reason:'PHOTO_NOT_ADMITTED'});
        }
        // Canonical immutable intake uses only admitted photos; rejected candidates never cause a server image fetch.
        const policy=this.policies.find(p=>p.publisherId===tip.source.publisherId&&p.datasetId===tip.source.datasetId);
        while(accepted.length){const result={...tip,photos:[...accepted]},validated=validateTip(Buffer.from(JSON.stringify(result)),{submittedAt:this.now(),sourcePolicy:policy,verifiedUploads});
            if(validated.success)return {success:true,tip:result,omitted,remoteRequests:0};accepted.pop();omitted.push({reason:'COMBINED_IMAGE_LIMIT'});}
        return {success:true,tip:base,omitted,remoteRequests:0};
    }
}
function selfMadeProof(context,originalHash){return {kind:'SELF_MADE_SYNTHETIC_PIXELS',creator:'REPO_SYNTHETIC_GENERATOR',purpose:'ISOLATED_QA_ONLY',originalHash,
    scope:scope(context),license:'EXPLICIT_PERMISSION',mayRepublish:true,mayRedact:true,caseBindingReviewed:true};}
module.exports={PhotoRights,init,selfMadeProof};
