'use strict';
// NEW isolated native Fastify extension. No native row/device mutations; legacy defaults remain untouched.
const fs=require('node:fs');
const {validateTip}=require('../stray-map-intake/contract');
const {reportSemantics}=require('../stray-map-intake/case-semantics');
const {PendingService}=require('./pending-service.cjs');
const {VIEW,validatePublicContent,isUuid,photoUuid}=require('./projection-contract.cjs');
const LABELS={
 en:{thirdParty:'Third-party public lead',LOST:'Lost',FOUND:'Found',SIGHTING:'Sighting',LAST_KNOWN:'Last known region',FOUND_AT:'Found region',OBSERVED_AT:'Observed region',time:'Source observation time',care:'Source-reported care status',careTime:'Care report time',unknown:'Unknown',coarse:'Only the country and coarse region are available. No map pin or present care location is inferred.',IN_CARE:'In care',NOT_IN_CARE:'Not in care',UNKNOWN:'Unknown'},
 'zh-TW':{thirdParty:'第三方公開線索',LOST:'走失',FOUND:'拾獲',SIGHTING:'目擊',LAST_KNOWN:'最後已知區域',FOUND_AT:'拾獲區域',OBSERVED_AT:'目擊區域',time:'來源觀察時間',care:'來源記載照管狀態',careTime:'照管記載時間',unknown:'未知',coarse:'僅有國別與粗粒度區域，不推算圖釘或目前照管位置。',IN_CARE:'照管中',NOT_IN_CARE:'未照管',UNKNOWN:'未知'},
 'zh-CN':{thirdParty:'第三方公开线索',LOST:'走失',FOUND:'拾获',SIGHTING:'目击',LAST_KNOWN:'最后已知区域',FOUND_AT:'拾获区域',OBSERVED_AT:'目击区域',time:'来源观察时间',care:'来源记载照管状态',careTime:'照管记载时间',unknown:'未知',coarse:'仅有国别与粗粒度区域，不推算图钉或当前照管位置。',IN_CARE:'照管中',NOT_IN_CARE:'未照管',UNKNOWN:'未知'},
 ja:{thirdParty:'第三者の公開情報',LOST:'迷子',FOUND:'保護',SIGHTING:'目撃',LAST_KNOWN:'最後に確認された地域',FOUND_AT:'発見地域',OBSERVED_AT:'目撃地域',time:'情報源の観察時刻',care:'情報源が報告した保護状況',careTime:'保護状況の報告時刻',unknown:'不明',coarse:'国と広域の地域のみを表示します。地図のピンや現在の保護場所は推測しません。',IN_CARE:'保護中',NOT_IN_CARE:'保護していない',UNKNOWN:'不明'},
 ko:{thirdParty:'제3자 공개 제보',LOST:'실종',FOUND:'발견',SIGHTING:'목격',LAST_KNOWN:'마지막으로 알려진 지역',FOUND_AT:'발견 지역',OBSERVED_AT:'목격 지역',time:'출처의 관찰 시간',care:'출처가 보고한 보호 상태',careTime:'보호 상태 보고 시간',unknown:'알 수 없음',coarse:'국가와 넓은 지역만 표시합니다. 지도 핀이나 현재 보호 장소를 추정하지 않습니다.',IN_CARE:'보호 중',NOT_IN_CARE:'보호하지 않음',UNKNOWN:'알 수 없음'}
};
for(const labels of Object.values(LABELS))labels.UNSPECIFIED_LEGACY=labels.unknown;
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const dateText=(time,t)=>time.precision==='UNKNOWN'?t.unknown:`${time.value} (${time.timeZone})`;
function render(lead,lang) {
    const locale=Object.hasOwn(LABELS,lang)?lang:lead.display.locale.startsWith('zh')?'zh-TW':'en',t=LABELS[locale];
    return `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(lead.display.title)}</title><link rel="stylesheet" href="/share/styles.css"></head><body><main><section class="hero"><p>${escape(t.thirdParty)} · ${escape(t[lead.report.type])}</p><article lang="${escape(lead.display.locale)}"><h1>${escape(lead.display.title)}</h1><p class="description">${escape(lead.display.description)}</p></article><p>${escape(t[lead.report.locationMeaning])}: ${escape(lead.location.countryCode)} · ${escape(lead.location.regionCode??t.unknown)}</p><p data-time-precision="${lead.observation.precision}">${escape(t.time)}: ${escape(dateText(lead.observation,t))}</p><p>${escape(t.care)}: ${escape(t[lead.report.custody.status])}</p><p data-care-time-precision="${lead.report.custody.asOf.precision}">${escape(t.careTime)}: ${escape(dateText(lead.report.custody.asOf,t))}</p><p>${escape(t.coarse)}</p></section>${lead.photos.map(photo=>`<figure class="card"><img src="${escape(photo.url)}" alt="${escape(photo.caption)}"><figcaption lang="${escape(lead.display.locale)}">${escape(photo.caption)}</figcaption></figure>`).join('')}</main></body></html>`;
}
function headers(reply,type) {return reply.header('Content-Type',type).header('Cache-Control','no-store').header('X-Content-Type-Options','nosniff')
    .header('Referrer-Policy','no-referrer').header('X-Frame-Options','DENY')
    .header('Content-Security-Policy',"default-src 'none'; img-src 'self'; style-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");}
class NativeProjection {
    constructor(service,baseURL){const url=new URL(baseURL);if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password)throw Error('LOOPBACK_PROJECTION_ONLY');this.service=service;this.base=url.origin;}
    async rows(id=null) {
        const rows=(await this.service.pool.query(`SELECT t.* FROM rebuild_external.tips t WHERE t.review='APPROVED' AND t.map_policy!='NEVER'
            AND t.public_content IS NOT NULL AND ($1::uuid IS NULL OR t.public_id=$1)
            AND NOT EXISTS(SELECT 1 FROM animals a WHERE a.id=t.public_id) ORDER BY t.public_id LIMIT 1000`,[id])).rows;
        const uploads=await this.service.uploads();
        return rows.filter(row=>{
            const policy=this.service.policies.find(p=>p.publisherId===row.publisher&&p.datasetId===row.dataset);
            const options={submittedAt:this.service.now(),sourcePolicy:policy,verifiedUploads:uploads};
            const valid=validateTip(Buffer.from(JSON.stringify(row.payload)),options);
            return valid.success && valid.payloadHash===row.payload_hash && valid.review.mapPolicy===row.map_policy
                && validatePublicContent(row.public_content,row.payload,options).success;
        });
    }
    project(row) {
        const p=row.payload,content=row.public_content;
        return {id:row.public_id,origin:'EXTERNAL_PUBLIC_LEAD',thirdParty:true,selfWitness:false,animal:p.animal,
            display:{locale:content.locale,title:content.title,description:content.description},report:reportSemantics(p),
            observation:p.observation,location:{countryCode:p.location.countryCode,regionCode:p.location.regionCode,precision:'REGION',coordinates:null},
            mapMarkerEligible:false,mapExclusionReason:p.report?.type==='SIGHTING'?'NO_TRUSTED_POINT':'NOT_A_NEW_SIGHTING',careLocationInferred:false,
            photos:p.photos.map((photo,index)=>({id:photoUuid(photo.uploadId),url:`${this.base}/external-media/${row.public_id}/${photoUuid(photo.uploadId)}`,
                caption:content.photoCaptions[index].caption}))};
    }
    async list(){return {success:true,schemaVersion:1,view:VIEW,externalLeads:(await this.rows()).map(row=>this.project(row)),mapMarkers:[],nativeIncluded:false};}
    async one(id){if(!isUuid(id))return null;const row=(await this.rows(id))[0];return row?this.project(row):null;}
    async photo(id,photoId){const lead=await this.one(id);if(!lead||!lead.photos.some(photo=>photo.id===photoId))return null;
        const uploadId=`up_${photoId.replaceAll('-','')}`;return this.service.publicPhoto(uploadId);}
}
async function install(app,{pool,config,fixtureConfigPath}) {
    if(process.env.STRAY_REBUILD_SYNTHETIC!=='1')throw Error('SYNTHETIC_NATIVE_EXTENSION_ONLY');
    const fixture=JSON.parse(fs.readFileSync(fixtureConfigPath,'utf8'));
    if(fixture.kind!=='SYNTHETIC_NATIVE_PROJECTION')throw Error('INVALID_NATIVE_FIXTURE_CONTEXT');
    const service=new PendingService({pool,sourcePolicies:fixture.sourcePolicies,knownSyntheticPixelHashes:fixture.pixelHashes,now:()=>fixture.submittedAt});
    await service.init();const projection=new NativeProjection(service,config.API_PUBLIC_URL);
    // Dedicated path is outside the native /v1 device hook. No old route/auth exception is added.
    await app.register(async scope=>{
        scope.removeContentTypeParser('application/json');scope.addContentTypeParser('application/json',{parseAs:'buffer'},(_req,body,done)=>done(null,body));
        scope.post('/external-rebuild/v1/tips',{bodyLimit:16384},async(req,reply)=>{
            if(!/^application\/json(?:;\s*charset=utf-8)?$/i.test(req.headers['content-type']||''))return reply.code(415).send({success:false,error:'JSON_CONTENT_TYPE_REQUIRED'});
            const result=await service.accept(req.body,req.headers['idempotency-key']);return reply.code(result.status||202).send(result);
        });
        scope.get('/external-rebuild/v1/receipts/:tipId',async(req,reply)=>{const result=await service.getReceipt(req.params.tipId);return reply.code(result.status||200).header('Cache-Control','no-store').send(result);});
        scope.get('/external-media/:publicId/:photoId',async(req,reply)=>{
            const bytes=await projection.photo(req.params.publicId,req.params.photoId);if(!bytes)return reply.code(404).header('Cache-Control','no-store').send({success:false,error:'NOT_FOUND'});
            return headers(reply,'image/jpeg').send(bytes);
        });
    });
    app.addHook('onRoute',options=>{
        const methods=Array.isArray(options.method)?options.method:[options.method];if(!methods.some(method=>['GET','HEAD'].includes(method)))return;
        if(options.url==='/v1/animals'){
            const existing=options.onRequest?Array.isArray(options.onRequest)?options.onRequest:[options.onRequest]:[];
            options.onRequest=[...existing,async function(req,reply){
                if(req.query?.view!==VIEW)return;
                if(Object.keys(req.query).some(key=>key!=='view'))return reply.code(400).send({success:false,error:'INVALID_EXTERNAL_VIEW_QUERY'});
                return headers(reply,'application/json').send(await projection.list());
            }];
        }
        if(options.url==='/a/:animalId'){
            const original=options.handler;options.handler=async function(req,reply){
                const id=req.params.animalId;if(!isUuid(id))return original.call(this,req,reply);
                const native=await pool.query('SELECT 1 FROM animals WHERE id=$1',[id]);if(native.rowCount)return original.call(this,req,reply);
                const lead=await projection.one(id);if(!lead)return original.call(this,req,reply);
                return headers(reply,'text/html; charset=utf-8').send(render(lead,req.query?.lang));
            };
        }
    });
}
module.exports={NativeProjection,install,render,LABELS,headers};
