require('./helpers/mock-setup');
const {Pool}=require('pg');
const {validateTip}=require('../../../tools/stray-map-intake/contract');
const {PendingService,digest}=require('../../../tools/stray-map-rebuild/pending-service.cjs');
const {NativeProjection,render,LABELS,install}=require('../../../tools/stray-map-rebuild/native-projection.cjs');
const {publicContent,validatePublicContent,privateText}=require('../../../tools/stray-map-rebuild/projection-contract.cjs');
const f=require('../../../tools/stray-map-intake/synthetic-fixtures'),c=require('../../../tools/stray-map-intake/case-fixtures');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
function fixture(type='FOUND'){
    const tip=c.caseTip(type),policy=tip.source.publisherId===f.policy.publisherId?f.policy:f.peerPolicy;
    const valid=validateTip(Buffer.from(JSON.stringify(tip)),{submittedAt:f.SUBMITTED,sourcePolicy:policy});
    expect(valid.success).toBe(true);
    return {tip,policy,row:{id:'tip_0123456789abcdef0123456789abcdef',public_id:'00000000-0000-4000-8000-000000000012',review:'APPROVED',map_policy:valid.review.mapPolicy,
        publisher:policy.publisherId,dataset:policy.datasetId,payload:valid.canonicalPayload,payload_hash:valid.payloadHash,public_content:publicContent(tip)}};
}
function setup(type='FOUND'){
    const {row,...data}=fixture(type),pool=new Pool();pool.query.mockImplementation(async sql=>({rows:sql.includes('SELECT t.*')?[row]:[],rowCount:0}));
    const service=new PendingService({pool,sourcePolicies:[{...f.policy},{...f.peerPolicy}],now:()=>f.SUBMITTED});
    return {...data,row,pool,service,projection:new NativeProjection(service,'http://127.0.0.1:12345')};
}
describe('reviewed native external view and public content',()=>{
    test.each(['LOST','FOUND','SIGHTING'])('%s preserves report/time/locale without fabricating a point',async type=>{
        const {projection,tip}=setup(type),list=await projection.list(),lead=list.externalLeads[0];
        expect(lead.report).toEqual(tip.report);expect(lead.observation).toEqual(validateTip(Buffer.from(JSON.stringify(tip)),{submittedAt:f.SUBMITTED,sourcePolicy:tip.source.publisherId===f.policy.publisherId?f.policy:f.peerPolicy}).canonicalPayload.observation);
        expect(lead.display).toEqual(tip.display);expect(lead.location.coordinates).toBeNull();expect(lead.mapMarkerEligible).toBe(false);expect(lead.careLocationInferred).toBe(false);expect(list.mapMarkers).toEqual([]);
    });
    test('withdrawn/rejected/pending filtering is required by list, share lookup and media',async()=>{
        const {projection,pool}=setup();pool.query.mockResolvedValue({rows:[],rowCount:0});
        expect((await projection.list()).externalLeads).toEqual([]);expect(await projection.one('00000000-0000-4000-8000-000000000012')).toBeNull();expect(await projection.photo('00000000-0000-4000-8000-000000000012','00000000-0000-4000-8000-000000000013')).toBeNull();
        for(const [sql]of pool.query.mock.calls.filter(([q])=>q.includes('SELECT t.*'))){expect(sql).toContain("t.review='APPROVED'");expect(sql).toContain("t.map_policy!='NEVER'");expect(sql).toContain('t.public_content IS NOT NULL');expect(sql).toContain('NOT EXISTS(SELECT 1 FROM animals');}
    });
    test.each(['source','payload','public_content'])('current %s revocation/tampering hides native reads',async kind=>{
        const {projection,service,row}=setup();if(kind==='source')service.policies.forEach(p=>p.verified=false);if(kind==='payload')row.payload_hash='0'.repeat(64);if(kind==='public_content')row.public_content.description='private@example.invalid';
        expect((await projection.list()).externalLeads).toEqual([]);expect(await projection.one(row.public_id)).toBeNull();
    });
    test('a database outage is an error, not a false empty list',async()=>{
        const {projection,pool}=setup();pool.query.mockRejectedValue(Error('synthetic outage'));await expect(projection.list()).rejects.toThrow('synthetic outage');
    });
    test('public projection excludes all raw private fields and raw descriptions',async()=>{
        const {projection,row}=setup();row.payload.display.description='PRIVATE_ADDRESS_CANARY private@example.invalid';
        row.payload_hash=validateTip(Buffer.from(JSON.stringify(row.payload)),{submittedAt:f.SUBMITTED,sourcePolicy:f.peerPolicy}).payloadHash;
        row.public_content.description='Reviewed coarse-region synthetic lead.';const value=JSON.stringify(await projection.list());
        for(const text of ['PRIVATE_ADDRESS_CANARY','private@example.invalid','publisherId','datasetId','recordKey','evidenceRef','latitude','longitude','lastSeenAt'])expect(value).not.toContain(text);
        expect(value).toContain('Reviewed coarse-region synthetic lead.');
    });
    test.each(['private@example.invalid','0912-345-678','https://example.invalid/private','@private_account','25.01234, 121.56789'])('public text refuses %s',text=>{
        const {tip,policy}=fixture();const content=publicContent(tip);content.description=text;
        expect(validatePublicContent(content,tip,{submittedAt:f.SUBMITTED,sourcePolicy:policy,verifiedUploads:[]}).success).toBe(false);
    });
    test('an original local ISO date in reviewed text is not mistaken for a phone',()=>expect(privateText('Seen on 2026-11-26 in the coarse region.')).toBe(false));
    test('locale changes and unknown public fields fail closed',()=>{
        const {tip,policy}=fixture();const options={submittedAt:f.SUBMITTED,sourcePolicy:policy,verifiedUploads:[]};
        expect(validatePublicContent({...publicContent(tip),locale:'zh-TW'},tip,options).success).toBe(false);
        expect(validatePublicContent({...publicContent(tip),privateSource:'canary'},tip,options).success).toBe(false);
    });
    test.each(Object.keys(LABELS))('%s share labels complete; original text is escaped and DATE not coerced',locale=>{
        const {projection,row}=setup(),lead=projection.project(row);lead.display.title='<script>private-test</script>';lead.display.description='Reviewed <b>text</b>';
        const html=render(lead,locale);expect(Object.keys(LABELS[locale]).sort()).toEqual(Object.keys(LABELS.en).sort());expect(html).not.toContain('<script>');expect(html).toContain('&lt;script&gt;');expect(html).toContain('data-time-precision="DATE"');expect(html).not.toContain('T00:00:00');expect(html).not.toContain('maps.google');expect(html).not.toContain('straymap://');
    });
});
describe('native route hooks preserve authentication boundaries',()=>{
    let dir,file,oldFlag;
    beforeEach(()=>{dir=fs.mkdtempSync(path.join(os.tmpdir(),'stray-native-test-'));file=path.join(dir,'fixture.json');oldFlag=process.env.STRAY_REBUILD_SYNTHETIC;process.env.STRAY_REBUILD_SYNTHETIC='1';fs.writeFileSync(file,JSON.stringify({kind:'SYNTHETIC_NATIVE_PROJECTION',sourcePolicies:[f.policy,f.peerPolicy],pixelHashes:[],submittedAt:f.SUBMITTED}));});
    afterEach(()=>{fs.rmSync(dir,{recursive:true,force:true});if(oldFlag===undefined)delete process.env.STRAY_REBUILD_SYNTHETIC;else process.env.STRAY_REBUILD_SYNTHETIC=oldFlag;});
    async function routes(){const pool=new Pool(),registered=[];let hook;const scope={removeContentTypeParser:jest.fn(),addContentTypeParser:jest.fn(),post:(url,...args)=>registered.push({url,args}),get:(url,...args)=>registered.push({url,args})};
        const app={register:async fn=>fn(scope),addHook:(name,fn)=>{expect(name).toBe('onRoute');hook=fn;}};
        await install(app,{pool,config:{API_PUBLIC_URL:'http://127.0.0.1:12345'},fixtureConfigPath:file});return {pool,registered,hook};}
    function reply(){const value={};for(const name of ['header','code','send'])value[name]=jest.fn().mockReturnValue(value);return value;}
    test.each(['GET','HEAD'])('%s explicit external view replies before native device handler while preserving existing hooks',async method=>{
        const {hook,pool}=await routes(),existing=jest.fn(),handler=jest.fn(),options={method,url:'/v1/animals',handler,onRequest:[existing]};hook(options);
        expect(options.handler).toBe(handler);expect(options.onRequest[0]).toBe(existing);const res=reply();
        await options.onRequest[1]({query:{view:'external-origin-v1'},headers:{'x-device-id':'ignored-public-input'}},res);
        expect(res.send).toHaveBeenCalledWith(expect.objectContaining({success:true,nativeIncluded:false,mapMarkers:[]}));expect(handler).not.toHaveBeenCalled();
        expect(pool.query.mock.calls.some(([sql])=>/INSERT INTO (devices|animals|sightings)/.test(sql))).toBe(false);
    });
    test('default/unknown view and native POST handler remain unchanged',async()=>{
        const {hook}=await routes();for(const view of [undefined,'unknown']){const handler=jest.fn(),options={method:'GET',url:'/v1/animals',handler};hook(options);const res=reply();await options.onRequest[0]({query:{view}},res);expect(res.send).not.toHaveBeenCalled();expect(options.handler).toBe(handler);}
        const options={method:'POST',url:'/v1/animals',handler:jest.fn()};const original=options.handler;hook(options);expect(options.handler).toBe(original);expect(options.onRequest).toBeUndefined();
    });
    test('only dedicated external mutation route is added, outside original /v1 middleware',async()=>{
        const {registered}=await routes();expect(registered.filter(x=>x.url.includes('tips')).map(x=>x.url)).toEqual(['/external-rebuild/v1/tips']);expect(registered.some(x=>x.url==='/v1/animals')).toBe(false);
    });
    test('native sharing collision including a deleted/native stub delegates to the original handler',async()=>{
        const {hook,pool}=await routes();pool.query.mockResolvedValue({rows:[{}],rowCount:1});const original=jest.fn().mockReturnValue('native-original'),options={method:'GET',url:'/a/:animalId',handler:original};hook(options);
        const result=await options.handler({params:{animalId:'00000000-0000-4000-8000-000000000012'},query:{}},reply());expect(result).toBe('native-original');expect(original).toHaveBeenCalled();expect(pool.query).toHaveBeenLastCalledWith('SELECT 1 FROM animals WHERE id=$1',['00000000-0000-4000-8000-000000000012']);
    });
});

test('zero independent source checks is UNKNOWN even if the public list is empty',async()=>{
    const {projection,pool}=setup();pool.query.mockImplementation(async sql=>({rows:sql.includes('SELECT t.*')?[]:sql.includes('source_checks')?[{total:0,current:0,usable:0,checked_at:null}]:[]}));
    const result=await projection.list();expect(result.externalLeads).toEqual([]);expect(result.dataQuality.sourceAvailability).toBe('UNKNOWN');expect(result.dataQuality.lastCheckedAt).toBeNull();
});
