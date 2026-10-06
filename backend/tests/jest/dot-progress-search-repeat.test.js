require('./helpers/mock-setup');
const express=require('express'),request=require('supertest');
const {newDb,DataType}=require('pg-mem');
const progress=require('../../dot-progress');
const base='/api/dot-progress',admin=call=>call.set('x-test-role','admin');let sequence=0;
const nonce=()=>`synthetic-search-repeat-${++sequence}`;
function setup(override){
 const db=newDb({noAstCoverageCheck:true});db.public.registerFunction({name:'pg_advisory_xact_lock',args:[DataType.integer],returns:DataType.integer,implementation:()=>1});db.public.registerFunction({name:'clock_timestamp',args:[],returns:DataType.timestamptz,impure:true,implementation:()=>new Date()});
 // pg-mem lacks PostgreSQL's timestamp-to-json conversion; native coverage below exercises the real function.
 db.public.registerFunction({name:'to_jsonb',args:[DataType.timestamptz],returns:DataType.jsonb,implementation:value=>new Date(value).toISOString()});
 const {Pool}=db.adapters.createPg();const memory=new Pool(),connect=memory.connect.bind(memory);memory.connect=async()=>{const client=await connect(),query=client.query.bind(client);client.query=(sql,params)=>sql.startsWith('SET TRANSACTION')?Promise.resolve({rows:[]}):query(sql,params);return client;};
 const pool=override||memory,auth={authMiddleware(req,res,next){if(!req.get('x-test-role'))return res.status(401).json({success:false});req.user={userId:'synthetic-admin'};next();},adminMiddleware(req,res,next){if(req.get('x-test-role')!=='admin')return res.status(403).json({success:false});next();}};
 const app=express();app.use(base,progress.createRouter(()=>pool,auth));return{app,pool};
}
const plan=delta=>({id:'synthetic-daily-rule',projectId:null,projectLabel:'Synthetic project',goal:'Synthetic recurring objective',plannedStart:null,plannedEnd:null,status:'planned',actualIds:[],...delta});
const repeat={frequency:'daily',from:'2040-07-20',until:null};
const call=(app,path)=>admin(request(app).get(base+path));
async function put(app,date,rows,version=0){return admin(request(app).put(base+'/schedule/'+date)).send({requestId:nonce(),version,rows,rowOrder:rows.map(row=>row.id)});}
async function actual(app,endedAt,startedAt=null){const response=await admin(request(app).post(base+'/timeline')).send({requestId:nonce(),projectId:null,projectLabel:'Synthetic needle actual',goal:'Synthetic needle goal',workType:'validation',startedAt,endedAt,actions:'Synthetic needle actions',result:'Synthetic needle result'});expect(response.status).toBe(200);return response.body.entry;}
async function snapshot(pool){return Promise.all(['dot_progress_projects','dot_progress_history','dot_progress_comments','dot_progress_timeline','dot_progress_timeline_revisions','dot_progress_timeline_requests','dot_progress_push_state','dot_progress_push_requests'].map(table=>pool.query(`SELECT * FROM ${table} ORDER BY 1`).then(result=>result.rows)));}

test('newest sidebar order uses item time, while omitted order preserves the existing journal shape',async()=>{
 const {app}=setup();const a=await actual(app,'2040-07-20T11:00:00+08:00'),b=await actual(app,'2040-07-21T11:00:00+08:00'),c=await actual(app,'2040-07-22T11:00:00+08:00','2040-07-19T11:00:00+08:00');
 expect((await call(app,'/timeline?order=newest')).body.entries.map(row=>row.id)).toEqual([b.id,a.id,c.id]);
 expect((await call(app,'/timeline')).body.entries.map(row=>row.id)).toEqual([c.id,a.id,b.id]);
 expect((await call(app,'/timeline?order=unknown')).status).toBe(400);
 const reviews=[];for(const day of ['2040-07-22','2040-07-20','2040-07-21']){const r=await admin(request(app).post(base+'/review')).send({requestId:nonce(),kind:'change',title:day,body:'Synthetic review',occurredAt:day,source:'Synthetic owner',scope:'Synthetic scope'});expect(r.status).toBe(200);reviews.push(r.body.entry);}
 expect((await call(app,'/review')).body.entries.map(row=>row.title)).toEqual(['2040-07-22','2040-07-21','2040-07-20']);
 for(const stamp of ['2040-07-23','2040-07-22T20:00:00Z'])expect((await admin(request(app).post(base+'/review')).send({requestId:nonce(),kind:'change',title:stamp,body:'Synthetic date boundary',occurredAt:stamp,source:'Synthetic owner',scope:'Synthetic scope'})).status).toBe(200);
 expect((await call(app,'/review')).body.entries.slice(0,2).map(row=>row.title)).toEqual(['2040-07-22T20:00:00Z','2040-07-23']);
});

test('one stored rule expands to stable unique day/week/month plans without copying its total goal or actual records',async()=>{
 const {app,pool}=setup();const total=plan({id:'synthetic-preserved-total',goal:'Synthetic original total'}),rule=plan({repeat});
 const saved=await put(app,'2040-07-19',[total,rule]);expect(saved.status).toBe(200);const before=await snapshot(pool),scheduleBefore=(await call(app,'/schedule?date=2040-07-19')).body;
 const month=(await call(app,'/schedule-period?date=2040-07-20&view=month')).body;expect(month.occurrences).toHaveLength(12);expect(new Set(month.occurrences.map(row=>row.ownerDate)).size).toBe(12);expect(month.schedules[0].matchingRowIds).toEqual([total.id]);
 const day=(await call(app,'/schedule-period?date=2040-07-20&view=day')).body;const week=(await call(app,'/schedule-period?date=2040-07-20&view=week')).body;
 expect(day.occurrences[0]).toEqual(month.occurrences.find(row=>row.ownerDate==='2040-07-20'));expect(week.occurrences.find(row=>row.ownerDate==='2040-07-20')).toEqual(day.occurrences[0]);
 expect(month.occurrences.every(row=>row.status==='planned'&&row.plannedStart===null&&row.plannedEnd===null&&row.actualIds.length===0)).toBe(true);
 expect((await call(app,'/schedule-period?date=2040-07-18&view=day')).body.occurrences).toBeUndefined();expect((await call(app,'/schedule?date=2040-07-20')).body.schedule.version).toBe(0);
 expect((await call(app,'/schedule?date=2040-07-19')).body).toEqual(scheduleBefore);expect(await snapshot(pool)).toEqual(before);
});

test('repeat validation rejects fake spans, completion, attached actuals and invalid dates before writing',async()=>{
 const {app}=setup();await call(app,'/projects');
 for(const row of [plan({repeat,status:'done'}),plan({repeat,plannedStart:'2040-07-19T01:00:00+08:00',plannedEnd:'2040-07-19T02:00:00+08:00'}),plan({repeat,actualIds:['synthetic-actual']}),plan({repeat:{...repeat,from:'2040-02-30'}}),plan({repeat:{...repeat,until:'2040-07-18'}}),plan({repeat:{...repeat,frequency:'weekly'}}),plan({repeat:{...repeat,extra:true}})])expect((await put(app,'2040-07-19',[row])).status).toBe(400);
 expect((await call(app,'/schedule?date=2040-07-19')).body.schedule.version).toBe(0);
});

test('archive, restore, receipts and full snapshot Undo preserve the original total and recurrence identity',async()=>{
 const {app}=setup(),date='2040-07-19',rows=[plan({id:'synthetic-total',goal:'Synthetic total'}),plan({repeat:{...repeat,until:'2040-07-22'}})];
 expect((await put(app,date,rows)).status).toBe(200);const initial=(await call(app,'/schedule-period?date=2040-07-20&view=month')).body.occurrences;
 const archived=[rows[0],{...rows[1],archived:true}];expect((await put(app,date,archived,1)).status).toBe(200);expect((await call(app,'/schedule-period?date=2040-07-20&view=month')).body.occurrences.every(row=>row.archived)).toBe(true);
 expect((await put(app,date,rows,2)).status).toBe(200);expect((await call(app,'/schedule-period?date=2040-07-20&view=month')).body.occurrences).toEqual(initial);expect((await call(app,'/schedule?date='+date)).body.schedule.rows[0]).toEqual(rows[0]);expect((await call(app,'/schedule/'+date+'/history')).body.total).toBe(3);
});

test('recurring-rule growth is bounded without silently truncating a period',async()=>{
 const {app}=setup();const rows=Array.from({length:50},(_,i)=>plan({id:'synthetic-rule-'+i,repeat}));
 expect((await put(app,'2040-07-19',rows)).status).toBe(200);expect((await put(app,'2040-07-18',rows)).status).toBe(200);expect((await put(app,'2040-07-17',[plan({repeat})])).status).toBe(409);
 const month=await call(app,'/schedule-period?date=2040-07-20&view=month');expect(month.status).toBe(200);expect(month.body.occurrences).toHaveLength(1200);expect(new Set(month.body.occurrences.map(row=>row.id+'|'+row.ownerDate)).size).toBe(1200);
});

test('search covers every original/comment/revision source and returns the exact retained record on demand',async()=>{
 const {app}=setup();const project=(await call(app,'/projects')).body.projects[0];
 expect((await admin(request(app).patch(base+'/projects/'+project.id)).send({version:project.version,title:'Synthetic needle project'})).status).toBe(200);
 expect((await admin(request(app).post(base+'/projects/'+project.id+'/comments')).send({requestId:nonce(),body:'Synthetic needle comment'})).status).toBe(200);
 const decision=await admin(request(app).post(base+'/projects/'+project.id+'/decisions')).send({requestId:nonce(),question:'Synthetic needle decision',recommendation:'Synthetic needle recommendation'});expect(decision.status).toBe(200);
 expect((await admin(request(app).post(base+'/projects/'+project.id+'/decisions/'+decision.body.decision.id+'/comments')).send({requestId:nonce(),version:1,recommendationVersion:1,body:'Synthetic needle clarification'})).status).toBe(200);
 const review=await admin(request(app).post(base+'/review')).send({requestId:nonce(),kind:'change',title:'Synthetic needle review',body:'Synthetic needle original',occurredAt:'2040-07-19',source:'Synthetic owner',scope:'Synthetic scope'});expect(review.status).toBe(200);
 expect((await admin(request(app).post(base+'/review/'+review.body.entry.id+'/comments')).send({requestId:nonce(),body:'Synthetic needle correction'})).status).toBe(200);
 await actual(app,'2040-07-19T11:00:00+08:00');expect((await put(app,'2040-07-19',[plan({goal:'Synthetic needle plan'})])).status).toBe(200);
 const result=await call(app,'/search?query=NEEDLE');expect({status:result.status,body:result.body}).toMatchObject({status:200});
 expect(new Set(result.body.entries.map(row=>row.kind))).toEqual(new Set(['project','comment','project_history','decision','decision_comment','decision_history','review','review_comment','timeline','timeline_history','schedule','schedule_history']));
 for(const entry of result.body.entries){expect(entry.snippet.length).toBeLessThanOrEqual(282);const detail=await call(app,'/search-item?'+new URLSearchParams({kind:entry.kind,id:entry.id}));if(detail.status!==200)throw new Error(JSON.stringify({kind:entry.kind,id:entry.id,status:detail.status,error:detail.body.error}));expect(detail.body.entry.kind).toBe(entry.kind);expect((detail.body.entry.title+' '+detail.body.entry.content).toLowerCase()).toContain('needle');}
});

test('search pagination is explicit and all private query/detail gates fail closed',async()=>{
 const {app,pool}=setup();const project=(await call(app,'/projects')).body.projects[0];
 for(let i=0;i<61;i++)await pool.query('INSERT INTO dot_progress_comments(project_id,author_id,request_id,body) VALUES($1,$2,$3,$4)',[project.id,'synthetic-admin',nonce(),'Synthetic page-needle '+i]);
 const first=await call(app,'/search?query=page-needle');expect(first.status).toBe(200);expect(first.body).toMatchObject({total:61,limit:50,nextOffset:50});const second=await call(app,'/search?query=page-needle&offset=50');expect(second.body.entries).toHaveLength(11);expect(second.body.nextOffset).toBeNull();expect(new Set([...first.body.entries,...second.body.entries].map(row=>row.kind+row.id)).size).toBe(61);
 for(const route of ['/search?query=page-needle','/search-item?kind=comment&id=1','/timeline/synthetic-entry','/review/synthetic-entry']){expect((await request(app).get(base+route)).status).toBe(401);expect((await request(app).get(base+route).set('x-test-role','member')).status).toBe(403);}
 for(const suffix of ['','?query=','?query='+('x'.repeat(201)),'?query=a&unexpected=b','?query=a&query=b'])expect((await call(app,'/search'+suffix)).status).toBe(400);
 expect((await call(app,'/search-item?kind=accounts&id=1')).status).toBe(400);expect((await call(app,'/search-item?kind=timeline&id=missing')).status).toBe(404);expect(first.headers['cache-control']).toBe('no-store');
});

const realPg=process.env.DOT_PROGRESS_TEST_PG==='1'?test:test.skip;
realPg('native PostgreSQL search literal matching and recurring reads preserve 39 actuals across restart and Undo',async()=>{
 const {Pool}=jest.requireActual('pg'),name=`dot_search_repeat_${process.pid}_${Date.now()}`,config={host:'127.0.0.1',port:55414,database:'postgres',user:'progress_test',connectionTimeoutMillis:2000,statement_timeout:4000};const owner=new Pool(config);await owner.query(`CREATE SCHEMA ${name}`);const pool=new Pool({...config,options:`-c search_path=${name}`});
 try{const {app}=setup(pool),entry=await actual(app,'2040-07-19T11:00:00+08:00');for(let i=0;i<38;i++)await pool.query('INSERT INTO dot_progress_timeline(id,project_label,started_at,ended_at,data,actor_id) VALUES($1,$2,$3,$4,$5::jsonb,$6)',[`synthetic-kept-${i}`,entry.projectLabel,null,entry.endedAt,JSON.stringify(entry),'synthetic-admin']);const rows=[plan({id:'synthetic-original-total',goal:'Synthetic total %_ literal'}),plan({repeat})];expect((await put(app,'2040-07-19',rows)).status).toBe(200);const before=await snapshot(pool);
 const literal=await call(app,'/search?'+new URLSearchParams({query:'%_'}));expect(literal.status).toBe(200);expect(literal.body.entries.every(row=>row.snippet.includes('%_'))).toBe(true);expect(literal.body.total).toBe(2);
 const projection=(await call(app,'/schedule-period?date=2040-07-20&view=month')).body;expect(projection.occurrences).toHaveLength(12);expect((await call(app,'/timeline?order=newest')).body.total).toBe(39);const searched=await call(app,'/search?query=needle');expect(searched.status).toBe(200);const found=searched.body.entries.filter(row=>row.kind==='timeline');expect(found).toHaveLength(39);expect(found.every(row=>typeof row.id==='string')).toBe(true);const detail=await call(app,'/search-item?'+new URLSearchParams({kind:found[0].kind,id:found[0].id}));expect(detail.status).toBe(200);expect(detail.body.entry.content.toLowerCase()).toContain('needle');expect(await snapshot(pool)).toEqual(before);
 const restarted=setup(pool);expect((await call(restarted.app,'/schedule-period?date=2040-07-20&view=month')).body).toEqual(projection);expect((await put(app,'2040-07-19',[rows[0]],1)).status).toBe(200);expect((await put(app,'2040-07-19',rows,2)).status).toBe(200);expect((await call(app,'/schedule-period?date=2040-07-20&view=month')).body.occurrences).toEqual(projection.occurrences);expect(await snapshot(pool)).toEqual(before);
 }finally{await pool.end();await owner.query(`DROP SCHEMA ${name} CASCADE`);await owner.end();}
},30000);
