'use strict';
// NEW LOCAL RECONSTRUCTION ADAPTER. It does not write native animals/devices or run in production.
const { createHash, randomUUID } = require('node:crypto');
const { validateTip } = require('../stray-map-intake/contract');
const { publicSemantics } = require('../stray-map-intake/case-semantics');
const { validatePublicContent } = require('./projection-contract.cjs');
const sourceState = require('./sql-source-state.cjs');
const photoRights = require('./photo-rights.cjs');
const dedup = require('./sql-dedup.cjs');
const digest = value => createHash('sha256').update(value).digest('hex');
const sameRights=(a,b)=>a&&b&&['license','evidenceRef','attributionRef','permitsRedaction'].every(key=>a[key]===b[key]);
const fail = (error, status = 400) => ({ success: false, error, status });
const checks = ['contentReviewed', 'localLanguageReviewed', 'privacyReviewed', 'sourceVerified', 'rightsReviewed', 'locationSafe'];
class PendingService {
    constructor({ pool, sourcePolicies, now, knownSyntheticPixelHashes = [], requirePersistentPhotoRights = false, enablePersistentDedup = false }) {
        if (!Array.isArray(sourcePolicies) || !sourcePolicies.length || sourcePolicies.some(policy => !policy?.verified
            || typeof policy.publisherId !== 'string' || !policy.publisherId.startsWith('synthetic-')
            || !/^https:\/\/[^/]+\.example\.invalid\/?$/.test(policy.origin))) throw new Error('SYNTHETIC_POLICIES_ONLY');
        this.pool = pool; this.policies = sourcePolicies; this.now = now;
        this.syntheticHashes = new Set(knownSyntheticPixelHashes.filter(hash => /^[a-f0-9]{64}$/.test(hash)));
        if(typeof requirePersistentPhotoRights!=='boolean')throw Error('INVALID_PHOTO_ADMISSION_MODE');
        this.requirePersistentPhotoRights=requirePersistentPhotoRights;
        if(typeof enablePersistentDedup!=='boolean')throw Error('INVALID_DEDUP_MODE');this.enablePersistentDedup=enablePersistentDedup;
        this.photoRights=new photoRights.PhotoRights({pool,sourcePolicies,knownSyntheticPixelHashes,now});
    }
    async init() {
        await this.pool.query(`CREATE SCHEMA IF NOT EXISTS rebuild_external;
            CREATE TABLE IF NOT EXISTS rebuild_external.tips(
              id text PRIMARY KEY, publisher text NOT NULL, dataset text NOT NULL, record_key text NOT NULL,
              payload_hash text NOT NULL, payload jsonb NOT NULL, receipt jsonb NOT NULL, map_policy text NOT NULL,
              review text NOT NULL DEFAULT 'PENDING', UNIQUE(publisher,dataset,record_key));
            CREATE TABLE IF NOT EXISTS rebuild_external.requests(
              publisher text NOT NULL, request_key text NOT NULL, payload_hash text NOT NULL,
              tip_id text NOT NULL REFERENCES rebuild_external.tips(id), PRIMARY KEY(publisher,request_key));
            CREATE TABLE IF NOT EXISTS rebuild_external.photos(
              id text PRIMARY KEY,publisher text NOT NULL,dataset text NOT NULL,record_key text NOT NULL,
              original_hash text NOT NULL,sanitized_hash text NOT NULL,rights jsonb NOT NULL,
              bytes bytea NOT NULL,width integer NOT NULL,height integer NOT NULL,
              verification text NOT NULL CHECK(verification='KNOWN_SYNTHETIC_PIXELS_ONLY'));
            ALTER TABLE rebuild_external.tips ADD COLUMN IF NOT EXISTS public_id uuid NOT NULL DEFAULT gen_random_uuid();
            ALTER TABLE rebuild_external.tips ADD COLUMN IF NOT EXISTS public_content jsonb;
            CREATE UNIQUE INDEX IF NOT EXISTS external_public_id ON rebuild_external.tips(public_id)`);
        await sourceState.init(this.pool);await photoRights.init(this.pool);
        await dedup.init(this.pool);
    }
    async uploads(client = this.pool) {
        const rows = (await client.query(this.requirePersistentPhotoRights
            ? `SELECT p.*,row_to_json(g) grant_record FROM rebuild_external.photos p JOIN rebuild_external.photo_rights_grants g ON g.id=p.grant_id
                AND g.publisher=p.publisher AND g.dataset=p.dataset AND g.record_key=p.record_key AND g.original_hash=p.original_hash AND g.rights=p.rights
                WHERE g.state='ACTIVE' FOR SHARE OF p,g`
            : 'SELECT * FROM rebuild_external.photos FOR SHARE')).rows;
        return rows.filter(row => (!this.requirePersistentPhotoRights||this.photoRights.validRecord(row.grant_record))
            &&row.verification === 'KNOWN_SYNTHETIC_PIXELS_ONLY' && this.syntheticHashes.has(row.original_hash)
            && digest(row.bytes) === row.sanitized_hash).map(row => ({ uploadId: row.id, publisherId: row.publisher, datasetId: row.dataset, recordKey: row.record_key,
            sourceUrl: null, status: 'VERIFIED_SAFE', sha256: row.sanitized_hash, byteLength: row.bytes.length,
            mimeType: 'image/jpeg', width: row.width, height: row.height, rights: row.rights,
            reuseConsentVerified: true, exifRemoved: true, geoRemoved: true, manualRedactionConfirmed: true,
            noFacesOrPlates: true, noPersonalData: true, noSensitiveVisualLocation: true, caseMatchConfirmed: true }));
        // These flags apply only to hash-allowlisted self-made QA pixels, never real photo moderation.
    }
    async addSyntheticPhoto(bytes, declaredMime, grant, storage, sharp) {
        if (!grant || grant.synthetic !== true || grant.license !== 'EXPLICIT_PERMISSION'
            || !grant.context || !this.policies.some(p => p.publisherId === grant.context.publisherId && p.datasetId === grant.context.datasetId)
            || !Buffer.isBuffer(bytes) || digest(bytes) !== grant.originalHash
            || !this.syntheticHashes.has(grant.originalHash)) return fail('PHOTO_RIGHTS_OR_BINDING_REQUIRED', 403);
        if (declaredMime !== 'image/png' || !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return fail('IMAGE_MIME_MISMATCH', 415);
        if (bytes.length > 5242880) return fail('IMAGE_BYTE_LIMIT', 413);
        const evidence=this.requirePersistentPhotoRights?await this.photoRights.find(grant.grantId,grant.context,grant.originalHash):null;
        if(this.requirePersistentPhotoRights&&!evidence)return fail('PERSISTENT_PHOTO_PERMISSION_REQUIRED',403);
        const stored = await storage.putImage({ bytes, mimeType: declaredMime });
        const sanitized = await storage.getImage(stored.storageKey); const metadata = await sharp(sanitized).metadata();
        if (metadata.exif || metadata.xmp || metadata.icc || metadata.orientation || metadata.width * metadata.height > 16000000) return fail('PHOTO_NOT_SANITIZED');
        const uploadId = `up_${randomUUID().replace(/-/g, '')}`;
        const rights = evidence?.rights||{ license: grant.license, evidenceRef: 'ev_synthetic001', attributionRef: 'credit_synthetic001', permitsRedaction: true };
        await this.pool.query(`INSERT INTO rebuild_external.photos(id,publisher,dataset,record_key,original_hash,sanitized_hash,rights,bytes,width,height,verification,grant_id)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'KNOWN_SYNTHETIC_PIXELS_ONLY',$11)`,
            [uploadId, grant.context.publisherId, grant.context.datasetId, grant.context.recordKey, grant.originalHash,
                digest(sanitized), rights, sanitized, metadata.width, metadata.height,evidence?.id||null]);
        return { success: true, uploadId, rights, state: 'SANITIZED_PRIVATE', semanticSafetyVerifiedForRealPhotos: false,
            sourceStorageUrlNotPublished: true, sanitizedHash: digest(sanitized), beforeMime: declaredMime, afterMime: metadata.format };
    }
    async accept(raw, requestKey) {
        if (typeof requestKey !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(requestKey)) return fail('INVALID_IDEMPOTENCY_KEY');
        if (!Buffer.isBuffer(raw) || raw.length > 16384) return fail('PAYLOAD_TOO_LARGE', 413);
        let policy;
        try { const source = JSON.parse(raw.toString()).source;
            policy = this.policies.find(item => item.publisherId === source?.publisherId && item.datasetId === source?.datasetId);
        } catch { /* canonical validator returns the bounded parse failure */ }
        const result = validateTip(raw, { submittedAt: this.now(), sourcePolicy: policy, verifiedUploads: await this.uploads() });
        if (!result.success) return result;
        const p = result.canonicalPayload, client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            // One publisher's keys/record identity are reserved transactionally, not a cooldown approximation.
            await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [p.source.publisherId]);
            const replay = (await client.query(`SELECT r.payload_hash,t.receipt FROM rebuild_external.requests r JOIN rebuild_external.tips t ON t.id=r.tip_id
                WHERE r.publisher=$1 AND r.request_key=$2`, [p.source.publisherId, requestKey])).rows[0];
            if (replay) { await client.query('COMMIT'); return replay.payload_hash === result.payloadHash
                ? { success: true, receipt: replay.receipt, replay: true, status: 202 } : fail('IDEMPOTENCY_CONFLICT', 409); }
            const prior = (await client.query('SELECT * FROM rebuild_external.tips WHERE publisher=$1 AND dataset=$2 AND record_key=$3',
                [p.source.publisherId, p.source.datasetId, p.source.recordKey])).rows[0];
            if (prior && prior.payload_hash !== result.payloadHash) { await client.query('ROLLBACK'); return fail('SOURCE_RECORD_CONFLICT', 409); }
            const id = prior?.id || `tip_${randomUUID().replace(/-/g, '')}`;
            let receipt = prior?.receipt || { success: true, tipId: id, status: 'PENDING', publicVisible: false, submittedAt: this.now() };
            if (!prior) {
                const count = (await client.query(`SELECT count(*)::int n FROM rebuild_external.tips WHERE publisher=$1
                    AND (receipt->>'submittedAt')::timestamptz > $2::timestamptz-interval '1 hour'`, [p.source.publisherId, this.now()])).rows[0].n;
                if (count >= 10) { await client.query('ROLLBACK'); return fail('SOURCE_RATE_LIMIT', 429); }
                const stored = await client.query('INSERT INTO rebuild_external.tips(id,publisher,dataset,record_key,payload_hash,payload,receipt,map_policy) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING receipt',
                    [id,p.source.publisherId,p.source.datasetId,p.source.recordKey,result.payloadHash,p,receipt,result.review.mapPolicy]);
                // Send the committed JSONB representation from the first response onward, including stable key order.
                receipt = stored.rows[0].receipt;
                await sourceState.noteAccepted(client,id,this.now());
                if(this.enablePersistentDedup)await dedup.noteAccepted(client,{id,publisher:p.source.publisherId,dataset:p.source.datasetId,recordKey:p.source.recordKey,
                    payloadHash:result.payloadHash,candidateFingerprint:result.candidateFingerprint,payload:p,now:this.now()});
            }
            await client.query('INSERT INTO rebuild_external.requests VALUES($1,$2,$3,$4)', [p.source.publisherId,requestKey,result.payloadHash,id]);
            await client.query('COMMIT'); return { success: true, receipt, replay: !!prior, status: 202 };
        } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    }
    async decide(id, action, reviewChecks, publicContent = null) {
        if (!['APPROVE','REJECT','WITHDRAW'].includes(action)) return fail('INVALID_DECISION');
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN'); const row = (await client.query('SELECT * FROM rebuild_external.tips WHERE id=$1 FOR UPDATE',[id])).rows[0];
            if (!row) { await client.query('ROLLBACK'); return fail('NOT_FOUND',404); }
            if (action !== 'WITHDRAW' && row.review !== 'PENDING') { await client.query('ROLLBACK'); return fail('REVIEW_TERMINAL',409); }
            if (action === 'APPROVE' && !checks.every(key => reviewChecks?.[key] === true)) { await client.query('ROLLBACK'); return fail('REVIEW_CHECKS_REQUIRED',403); }
            if (action === 'APPROVE') {
                const policy = this.policies.find(item => item.publisherId === row.publisher && item.datasetId === row.dataset);
                const uploads = await this.uploads(client);
                const valid = validateTip(Buffer.from(JSON.stringify(row.payload)), { submittedAt: this.now(), sourcePolicy: policy,
                    verifiedUploads: uploads });
                if (!valid.success || valid.payloadHash !== row.payload_hash || valid.review.mapPolicy !== row.map_policy) {
                    await client.query('ROLLBACK'); return fail('REVIEW_EVIDENCE_INVALID',403);
                }
                if(publicContent!==null) {
                    const reviewed=validatePublicContent(publicContent,row.payload,{submittedAt:this.now(),sourcePolicy:policy,verifiedUploads:uploads});
                    if(!reviewed.success){await client.query('ROLLBACK');return reviewed;}
                    await client.query('UPDATE rebuild_external.tips SET public_content=$2 WHERE id=$1',[id,reviewed.content]);
                }
            }
            const state = action === 'APPROVE' ? row.map_policy === 'NEVER' ? 'APPROVED_PRIVATE' : 'APPROVED' : action === 'REJECT' ? 'REJECTED' : 'WITHDRAWN';
            await client.query('UPDATE rebuild_external.tips SET review=$2 WHERE id=$1',[id,state]); await client.query('COMMIT');
            return { success: true, status: state, publicVisible: state === 'APPROVED' };
        } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    }
    async getReceipt(id) {
        const row = (await this.pool.query('SELECT receipt,review FROM rebuild_external.tips WHERE id=$1',[id])).rows[0];
        return row ? { success: true, receipt: row.receipt, review: row.review } : fail('NOT_FOUND',404);
    }
    async publicTip(id) {
        const row = (await this.pool.query(`SELECT t.* FROM rebuild_external.tips t WHERE t.id=$1 AND t.review='APPROVED' AND t.map_policy!='NEVER' AND ${sourceState.visibleSQL('t')} AND ${dedup.visibleSQL('t')}`,[id])).rows[0];
        if (!row) return fail('NOT_FOUND',404);
        const p = row.payload;
        return { success: true, simulation: true, tip: { id,thirdParty:true,selfWitness:false,animal:p.animal,
            location:p.location,observation:p.observation,display:p.display,...publicSemantics(p),
            photos:p.photos.map(photo=>({id:photo.uploadId,caption:photo.caption})) } };
    }
    async publicPhoto(id) {
        const row = (await this.pool.query(`SELECT p.bytes,p.original_hash,p.sanitized_hash,p.publisher,p.dataset,p.record_key,p.rights,
            ${this.requirePersistentPhotoRights?'(SELECT row_to_json(g) FROM rebuild_external.photo_rights_grants g WHERE g.id=p.grant_id) grant_record':'NULL grant_record'}
            FROM rebuild_external.photos p JOIN rebuild_external.tips t
            ON t.payload->'photos' @> jsonb_build_array(jsonb_build_object('uploadId',p.id))
            WHERE p.id=$1 AND t.review='APPROVED' AND t.map_policy!='NEVER' AND ${sourceState.visibleSQL('t')}
            AND ${dedup.visibleSQL('t')}
            AND t.publisher=p.publisher AND t.dataset=p.dataset AND t.record_key=p.record_key
            ${this.requirePersistentPhotoRights?"AND EXISTS(SELECT 1 FROM rebuild_external.photo_rights_grants g WHERE g.id=p.grant_id AND g.state='ACTIVE')":''} LIMIT 1`,[id])).rows[0];
        if(this.requirePersistentPhotoRights&&row){const grant=row.grant_record;
            if(!this.photoRights.validRecord(grant)||grant.publisher!==row.publisher||grant.dataset!==row.dataset||grant.record_key!==row.record_key
                ||grant.original_hash!==row.original_hash||!sameRights(grant.rights,row.rights)
                ||digest(row.bytes)!==row.sanitized_hash)return null;}
        return row?.bytes || null;
    }
}
module.exports = { PendingService, checks, digest };
