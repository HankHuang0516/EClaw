'use strict';
// Deterministic labelled extension of the checked emitted entry. Never alters baseline/server.js.
const fs=require('node:fs'),path=require('node:path');
const {pathToFileURL}=require('node:url');
const {digest}=require('./pending-service.cjs');
function buildNativeEntry(root,runId,fixtureConfigPath){
    if(!/^[a-f0-9]{8}$/.test(runId))throw Error('INVALID_PRIVATE_RUN_ID');
    const prep=JSON.parse(fs.readFileSync(path.join(root,'PREPARE_RESULT.private.json')));if(!prep.readyForSyntheticIntegration)throw Error('VERIFIED_PREPARATION_REQUIRED');
    const outputs=JSON.parse(fs.readFileSync(path.join(root,'FIRST_BUILD_OUTPUTS.private.json')));
    const workspace=path.join(root,'workspace'),source=fs.readFileSync(path.join(workspace,'apps/api/dist/server.js'),'utf8');
    if(digest(source)!==outputs['apps/api/dist/server.js'])throw Error('NATIVE_ENTRY_DRIFT');
    const anchor='const deviceIdSchema = z.uuid();';if(source.split(anchor).length!==2)throw Error('NATIVE_ENTRY_ANCHOR_DRIFT');
    const boot=`// NEW UNSIGNED ISOLATED EXTERNAL-ORIGIN EXTENSION\nconst externalRebuild=await import(${JSON.stringify(pathToFileURL(path.join(__dirname,'native-projection.cjs')).href)});\nawait externalRebuild.default.install(app,{pool,config,fixtureConfigPath:${JSON.stringify(fixtureConfigPath)}});\n`;
    const rewritten=source.replace(/from "\.\//g,'from "./dist/').replace(anchor,boot+anchor);
    const entry=path.join(workspace,'apps/api',`server.external-${runId}.mjs`);fs.writeFileSync(entry,rewritten,{mode:0o600,flag:'wx'});
    return {entry,originalEntryHash:digest(source),extendedEntryHash:digest(rewritten),unsigned:true,
        changes:['relative imports rebased to unchanged dist/','new external-origin installer before unchanged device hook'],originalEntryChanged:false};
}
module.exports={buildNativeEntry};
