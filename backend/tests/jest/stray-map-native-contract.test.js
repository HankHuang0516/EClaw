require('./helpers/mock-setup');
const Ajv=require('ajv');
const schema=require('../../../docs/stray-map-native-external-view.schema.json');
const source=require('../../../docs/stray-map-external-intake.openapi.json');
const {NativeProjection}=require('../../../tools/stray-map-rebuild/native-projection.cjs');
const {publicContent}=require('../../../tools/stray-map-rebuild/projection-contract.cjs');
const c=require('../../../tools/stray-map-intake/case-fixtures');
const ajv=new Ajv({allErrors:true});ajv.addSchema(source,'stray-map-external-intake.openapi.json');const valid=ajv.compile(schema);
function response(type='FOUND'){
    const payload=c.caseTip(type),row={public_id:'00000000-0000-4000-8000-000000000011',payload,public_content:publicContent(payload)};
    const projection=new NativeProjection({},'http://127.0.0.1:12345');
    return {success:true,schemaVersion:1,view:'external-origin-v1',nativeIncluded:false,mapMarkers:[],externalLeads:[projection.project(row)]};
}
test.each(['LOST','FOUND','SIGHTING'])('documented native %s projection validates without inventing a legacy point or instant',type=>{
    const value=response(type);expect(valid(value)).toBe(true);expect(value.externalLeads[0].location.coordinates).toBeNull();
});
test.each([
 ['private key',v=>v.externalLeads[0].recordKey='private_source_canary'],
 ['raw payload',v=>v.externalLeads[0].payload={private:'canary'}],
 ['native rows',v=>v.nativeIncluded=true],
 ['unknown view',v=>v.view='legacy'],
 ['point',v=>v.externalLeads[0].location.coordinates={latitude:0,longitude:0}],
 ['pin',v=>v.mapMarkers=[{latitude:0,longitude:0}]],
 ['invented lastSeenAt',v=>v.externalLeads[0].lastSeenAt='2026-11-25T00:00:00Z'],
 ['precision coercion',v=>v.externalLeads[0].observation={precision:'INSTANT',value:'2026-11-25',timeZone:'America/Los_Angeles'}],
 ['unknown location field',v=>v.externalLeads[0].location.street='private street'],
 ['unreviewed native flag',v=>v.externalLeads[0].selfWitness=true],
 ['new sighting pin',v=>v.externalLeads[0].mapMarkerEligible=true],
])('schema rejects %s in external native view',(_name,change)=>{const value=response();change(value);expect(valid(value)).toBe(false);});
