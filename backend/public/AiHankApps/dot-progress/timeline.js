(function(root){
  'use strict';
  const types=['implementation','validation','routine','waiting','blocked'];
  const drafts=new Map(), operations=new Map(), knownLabels=new Set();
  let h, ui, entries=[], generation=0, loadGeneration=0, closed=true, nextOffset=null, total=0, importRows=null, importIndex=0, fileGeneration=0, loadedDate='';
  const path='/timeline';
  const entryOrder=(a,b)=>(a.startedAt||a.endedAt).localeCompare(b.startedAt||b.endedAt)||a.id.localeCompare(b.id);
  const context=()=>h.session();
  const token=()=>({epoch:context().epoch,generation});
  const valid=t=>context().isAdmin&&t.epoch===context().epoch&&t.generation===generation;
  function label(tag,key,className){const node=h.text(tag,h.tr(key),className);node.dataset.timelineKey=key;return node;}
  function button(key,handler,secondary=true){const node=h.action(key,handler,secondary);node.dataset.timelineKey=key;return node;}
  function detail(key,className){const node=document.createElement('details');if(className)node.className=className;node.append(label('summary',key));return node;}
  function field(form,key,value,options){const input=h.field(form,key,value,options);input.previousElementSibling.dataset.timelineKey=key;return input;}
  function select(form,key,name,options,value){const wrap=h.text('label','');wrap.append(label('span',key));const input=document.createElement('select');input.name=name;options.forEach(([id,text])=>{const option=h.text('option',text);option.value=id;input.append(option);});input.value=value||'';wrap.append(input);form.append(wrap);return input;}
  function identifier(key,payload){const fingerprint=JSON.stringify(payload);const prior=operations.get(key);if(prior&&prior.fingerprint===fingerprint)return prior.id;const id=root.crypto.randomUUID();operations.set(key,{fingerprint,id});return id;}
  function safeURL(value){
    if(typeof value!=='string'||value!==value.trim()||value.length>500||!/^https:\/\/github\.com\/HankHuang0516\/EClaw\/(?:pull\/[1-9]\d*|actions\/runs\/[1-9]\d*|commit\/[a-fA-F0-9]{7,40})$/.test(value))return false;
    try{const url=new URL(value);return url.protocol==='https:'&&url.hostname==='github.com'&&!url.username&&!url.password&&!url.port&&!url.search&&!url.hash&&/^\/HankHuang0516\/EClaw\/(?:pull\/[1-9]\d*|actions\/runs\/[1-9]\d*|commit\/[a-fA-F0-9]{7,40})\/?$/.test(url.pathname);}catch(_error){return false;}
  }
  function timeInput(value){const time=Date.parse(value);return Number.isFinite(time)?new Date(time+8*3600000).toISOString().slice(0,23):'';}
  function parseTime(value){
    if(typeof value!=='string'||value!==value.trim())throw new Error('invalid_time');
    const match=value.match(/^([1-9]\d{3})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/);
    if(!match)throw new Error('invalid_time');
    const [year,month,day,hour,minute,second]=match.slice(1,7).map(Number);const calendar=new Date(Date.UTC(year,month-1,day));
    if(calendar.getUTCFullYear()!==year||calendar.getUTCMonth()!==month-1||calendar.getUTCDate()!==day||hour>23||minute>59||second>59)throw new Error('invalid_time');
    const parsed=Date.parse(value);if(!Number.isFinite(parsed))throw new Error('invalid_time');return parsed;
  }
  function iso(value){if(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value))value+=':00';return new Date(parseTime(value+'+08:00')).toISOString();}
  function time(value){const date=new Date(value);return Number.isNaN(date.getTime())?'':new Intl.DateTimeFormat(root.dotI18n.locale,{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(date);}
  function rangeText(entry){return (entry.startedAt?time(entry.startedAt):h.tr('timeline_start_unknown'))+' — '+time(entry.endedAt)+' · UTC+08:00';}
  function rangeNode(tag,entry){const node=h.text(tag,rangeText(entry),'small');node.dataset.timelineStart=entry.startedAt||'';node.dataset.timelineEnd=entry.endedAt;return node;}
  function auditNode(tag,version,actor,at,className='small'){const node=h.text(tag,'',className);if(version!==null)node.dataset.timelineVersion=version;if(actor)node.dataset.timelineActor=actor;if(at)node.dataset.timelineAt=at;paintAudit(node);return node;}
  function paintAudit(node){const parts=[];if(node.dataset.timelineVersion)parts.push(h.tr('version')+' '+node.dataset.timelineVersion);if(node.dataset.timelineActor)parts.push(node.dataset.timelineActor);if(node.dataset.timelineAt)parts.push(time(node.dataset.timelineAt));node.textContent=parts.join(' · ');}
  function values(form){return Object.fromEntries(Array.from(form.elements).filter(node=>node.name).map(node=>[node.name,node.type==='checkbox'?node.checked:node.value]));}
  function remember(key,form){drafts.set(key,values(form));}
  function restore(key,form){const saved=drafts.get(key);if(saved)Object.entries(saved).forEach(([name,value])=>{const node=form.elements.namedItem(name);if(node){if(node.type==='checkbox')node.checked=value===true;else node.value=value;}});}
  function track(key,form){restore(key,form);form.addEventListener('input',()=>remember(key,form));form.addEventListener('change',()=>remember(key,form));}
  function normalize(row,includeRequest=false){
    if(!row||typeof row!=='object'||Array.isArray(row))throw new Error('invalid');
    const allowed=['startedAt','endedAt','projectId','projectLabel','workType','goal','actions','result','blockers','nextStep','evidence',...(includeRequest?['requestId']:[])];
    if(Object.keys(row).some(key=>!allowed.includes(key)))throw new Error('invalid');
    const start=row.startedAt===null?null:parseTime(row.startedAt),end=parseTime(row.endedAt);
    if(start!==null&&(end<start||end-start>7*86400000))throw new Error('invalid');
    if(!types.includes(row.workType)||!(row.projectId===null||context().projects.some(project=>project.id===row.projectId)))throw new Error('invalid');
    for(const [key,max,required] of [['projectLabel',160,true],['actions',4000,true],['result',4000,true],['blockers',4000,false],['nextStep',4000,false]])if(typeof row[key]!=='string'||row[key].length>max||(required&&!row[key].trim()))throw new Error('invalid');
    if(Object.prototype.hasOwnProperty.call(row,'goal')&&(typeof row.goal!=='string'||!row.goal.trim()||row.goal.length>4000))throw new Error('invalid');
    if(!Array.isArray(row.evidence)||row.evidence.length>10||row.evidence.some(item=>!item||Object.keys(item).some(key=>!['label','url'].includes(key))||typeof item.label!=='string'||!item.label.trim()||item.label.length>160||!safeURL(item.url)))throw new Error('invalid');
    if(includeRequest&&(typeof row.requestId!=='string'||!/^[A-Za-z0-9_-]{8,100}$/.test(row.requestId)))throw new Error('invalid');
    return {...row,startedAt:start===null?null:new Date(start).toISOString(),endedAt:new Date(end).toISOString(),evidence:row.evidence.map(item=>({...item}))};
  }
  function payload(form){
    const data=values(form);const evidence=data.evidence.trim()?data.evidence.trim().split('\n').map(line=>{const at=line.indexOf('|');if(at<1)throw new Error('invalid');return {label:line.slice(0,at).trim(),url:line.slice(at+1).trim()};}):[];
    return normalize({startedAt:data.startUnknown?null:iso(data.startedAt),endedAt:iso(data.endedAt),projectId:data.projectId||null,projectLabel:data.projectLabel.trim(),workType:data.workType,...(data.goal.trim()?{goal:data.goal.trim()}:{}),actions:data.actions.trim(),result:data.result.trim(),blockers:data.blockers.trim(),nextStep:data.nextStep.trim(),evidence});
  }
  function projectChoices(){return [['',h.tr('timeline_project_other')],...context().projects.map(project=>[project.id,project.title])];}
  function updateProjectChoices(){if(!ui)return;for(const form of ui.panel.querySelectorAll('.timeline-form')){const input=form.elements.projectId,value=input.value;input.replaceChildren();projectChoices().forEach(([id,title])=>{const option=h.text('option',title);option.value=id;input.append(option);});input.value=Array.from(input.options).some(option=>option.value===value)?value:'';}}
  function buildForm(entry,key){
    const form=document.createElement('form');form.className='timeline-form';form.dataset.timelineForm=key;
    const times=h.text('div','','timeline-times');const start=field(times,'timeline_start',timeInput(entry.startedAt),{name:'startedAt',type:'datetime-local',required:true});const end=field(times,'timeline_end',timeInput(entry.endedAt),{name:'endedAt',type:'datetime-local',required:true});start.step=end.step='0.001';form.append(label('p','timeline_zone','small'),times);const unknown=document.createElement('input');unknown.type='checkbox';unknown.name='startUnknown';unknown.checked=entry.startedAt===null;const unknownLabel=h.text('label','','timeline-start-unknown');unknownLabel.append(unknown,label('span','timeline_start_unknown'));form.append(unknownLabel);const syncStart=()=>{start.disabled=unknown.checked;start.required=!unknown.checked;};unknown.addEventListener('change',()=>{syncStart();remember(key,form);});
    const project=select(form,'timeline_project','projectId',projectChoices(),entry.projectId);const name=field(form,'timeline_project_label',entry.projectLabel,{name:'projectLabel',required:true,max:160});
    project.addEventListener('change',()=>{const selected=context().projects.find(item=>item.id===project.value);if(selected){name.value=selected.title;remember(key,form);}});
    select(form,'timeline_type','workType',types.map(type=>[type,h.tr('timeline_'+type)]),entry.workType||'implementation');
    for(const [keyName,nameName] of [['timeline_goal','goal'],['timeline_actions','actions'],['timeline_result','result'],['timeline_blockers','blockers'],['timeline_next','nextStep']])field(form,keyName,entry[nameName],{name:nameName,multiline:true,required:['actions','result'].includes(nameName),max:4000});
    field(form,'timeline_evidence',(entry.evidence||[]).map(item=>item.label+' | '+item.url).join('\n'),{name:'evidence',multiline:true,max:7000});form.append(label('p','timeline_evidence_hint','small'),label('p','timeline_privacy','small'));
    const save=button('save');save.type='submit';const status=h.text('p','','message');status.setAttribute('role','status');form.append(save,status);track(key,form);syncStart();
    let revision=entry.version||null;
    form.addEventListener('submit',event=>{event.preventDefault();h.busy(save,async()=>{
      let body;try{body=payload(form);}catch(_error){h.message(status,'timeline_invalid',true);return;}
      if(entry.id)body={...body,version:revision};body.requestId=identifier(key,body);const current=token();
      try{
        const response=await h.freeze(form,()=>h.request(entry.id?path+'/'+encodeURIComponent(entry.id):path,{method:entry.id?'PATCH':'POST',body:JSON.stringify(body)},true));
        if(!valid(current))return;drafts.delete(key);operations.delete(key);if(!entry.id){form.reset();syncStart();}install(response.entry);h.message(status,'saved');h.message(ui.status,'saved');await refreshTotals();
      }catch(error){
        if(!valid(current))return;
        if(error.status!==409)throw error;h.message(status,'timeline_conflict',true);
        if(!entry.id||status.nextElementSibling)return;
        const latest=button('timeline_load_latest',()=>h.busy(latest,async()=>{
          const response=await h.request(path+'/'+encodeURIComponent(entry.id)+'/history',{},true);if(!valid(current))return;
          const after=response.history.reduce((found,row)=>row.version>(found?.version||0)?row.changes?.after||found:found,null);if(!after)throw new Error('missing');
          revision=after.version;const shown=h.text('section','','timeline-latest');shown.append(label('strong','timeline_latest_note'),auditNode('p',after.version,after.actorId,after.updatedAt));appendContent(shown,after);latest.replaceWith(shown);
          // The retained draft is applied only on the user's next explicit save, against the displayed version.
        },status));status.after(latest);
      }
    },status);});return form;
  }
  function appendContent(node,entry){
    node.append(rangeNode('p',entry),h.text('p',entry.projectLabel),label('p','timeline_'+entry.workType,'pill'));const goal=h.text('div','','timeline-prose');goal.append(label('strong','timeline_goal'),entry.goal?h.text('p',entry.goal):label('p','timeline_goal_missing'));node.append(goal);
    for(const [key,name] of [['timeline_actions','actions'],['timeline_result','result'],['timeline_blockers','blockers'],['timeline_next','nextStep']]){const group=h.text('div','','timeline-prose');group.append(label('strong',key),h.text('p',entry[name]||'—'));node.append(group);}
    const links=h.text('div','','timeline-evidence');links.append(label('strong','timeline_evidence'));
    (entry.evidence||[]).forEach(item=>{const link=h.text(safeURL(item.url)?'a':'span',item.label);if(safeURL(item.url)){link.href=item.url;link.target='_blank';link.rel='noopener noreferrer';link.referrerPolicy='no-referrer';}links.append(link);});node.append(links);
  }
  function renderEntry(entry){
    const card=h.text('article','','timeline-entry');card.dataset.timelineId=entry.id;card.append(label('span','timeline_'+entry.workType,'pill'),h.text('h3',entry.projectLabel));
    const date=rangeNode('time',entry);date.dateTime=entry.startedAt||entry.endedAt;card.append(date,h.text('p',entry.result,'timeline-result'),auditNode('p',entry.version,entry.actorId,entry.updatedAt,'small timeline-meta'));
    const content=detail('original_detail','timeline-content');appendContent(content,entry);card.append(content);
    const edit=detail('timeline_edit','timeline-edit');edit.addEventListener('toggle',()=>{if(edit.open&&!edit.querySelector('form'))edit.append(buildForm(entry,'edit:'+entry.id+':'+entry.version));});card.append(edit);
    const history=detail('timeline_history','timeline-history');const revisions=h.text('div','','timeline-revisions');const feedback=h.text('p','');feedback.setAttribute('role','status');let offset=0;
    const load=button('load',()=>h.busy(load,async()=>{
      const current=token();const response=await h.request(path+'/'+encodeURIComponent(entry.id)+'/history?offset='+offset,{},true);if(!valid(current)||!card.isConnected)return;
      if(offset===0)revisions.replaceChildren();
      response.history.forEach(row=>{const revision=h.text('section','','history-row');revision.append(auditNode('strong',row.version,null,null,''),auditNode('p',null,row.actorId,row.createdAt));if(row.changes?.before){const before=detail('decision_before');appendContent(before,row.changes.before);revision.append(before);}const after=detail('decision_after');appendContent(after,row.changes.after);revision.append(after);revisions.append(revision);});
      offset=response.nextOffset;load.hidden=offset===null;if(offset!==null){load.dataset.timelineKey='timeline_more';load.textContent=h.tr('timeline_more');}h.message(feedback,response.history.length?'':'empty_history');
    },feedback));history.append(load,revisions,feedback);card.append(history);return card;
  }
  function taipeiToday(){const parts=new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());return ['year','month','day'].map(type=>parts.find(part=>part.type===type).value).join('-');}
  function renderGantt(){
    if(!ui)return;const date=loadedDate||taipeiToday(),start=Date.parse(date+'T00:00:00+08:00'),end=start+86400000;
    ui.gantt.replaceChildren();ui.gantt.append(h.text('h3',h.tr('timeline_gantt')+' · '+date),label('p','timeline_gantt_note','small'),h.text('p',h.tr('timeline_count')+': '+entries.length+' / '+total,'small timeline-gantt-count'));
    const rows=entries.filter(entry=>{const from=Date.parse(entry.startedAt||entry.endedAt),to=Date.parse(entry.endedAt);return from<end&&(to>start||(from===to&&from>=start));});
    if(!rows.length){if(entries.length>=total)ui.gantt.append(h.text('p',date+' · '+h.tr('timeline_empty'),'small timeline-gantt-empty'));return;}
    const axis=h.text('div','','timeline-gantt-axis');['00:00','06:00','12:00','18:00','24:00'].forEach(value=>axis.append(h.text('span',value)));ui.gantt.append(axis);
    const list=h.text('ol','','timeline-gantt-rows');
    rows.forEach(entry=>{
      const from=Date.parse(entry.startedAt||entry.endedAt),to=Date.parse(entry.endedAt),point=from===to,milestone=entry.startedAt===null;const row=h.text('li','','timeline-gantt-row');row.dataset.ganttId=entry.id;
      row.append(h.text('strong',entry.projectLabel),label('span','timeline_'+entry.workType,'small'),h.text('p',h.tr('timeline_goal')+': '+(entry.goal||h.tr('timeline_goal_missing')),'small timeline-gantt-goal'),rangeNode('p',entry),h.text('p',entry.result,'small'));
      const track=h.text('div','','timeline-gantt-track');const bar=h.text('span','','timeline-gantt-bar');bar.dataset.workType=entry.workType;bar.classList.toggle('timeline-gantt-point',point);bar.style.left=((Math.max(start,from)-start)/86400000*100)+'%';bar.style.width=((Math.min(end,to)-Math.max(start,from))/86400000*100)+'%';
      bar.setAttribute('role','img');bar.setAttribute('aria-label',entry.projectLabel+' · '+h.tr('timeline_'+entry.workType)+' · '+rangeText(entry)+(point?' · '+h.tr(milestone?'timeline_milestone':'timeline_gantt_point'):''));track.append(bar);row.append(track);if(point)row.append(label('span',milestone?'timeline_milestone':'timeline_gantt_point','small'));list.append(row);
    });ui.gantt.append(list);
  }
  function renderList(){const scroll=ui.panel.scrollTop;ui.list.replaceChildren();if(!entries.length)ui.list.append(label('p','timeline_empty','small'));entries.forEach(entry=>ui.list.append(renderEntry(entry)));ui.panel.scrollTop=scroll;ui.count.textContent=h.tr('timeline_count')+': '+entries.length+' / '+total;ui.more.hidden=nextOffset===null;renderGantt();}
  function projectFilter(){const value=ui.project.value;const names=new Set([...context().projects.map(project=>project.title),...knownLabels]);if(value)names.add(value);ui.project.replaceChildren(h.text('option',h.tr('all')));ui.project.firstElementChild.value='';Array.from(names).sort().forEach(name=>{const option=h.text('option',name);option.value=name;ui.project.append(option);});ui.project.value=value;}
  async function load(more=false){
    if(!context().isAdmin)return;const current=token();const serial=++loadGeneration;ui.reload.disabled=ui.more.disabled=true;h.message(ui.status,'loading');
    const date=ui.date.value;const query=new URLSearchParams();if(date)query.set('date',date);if(ui.project.value)query.set('project',ui.project.value);if(more&&nextOffset!==null)query.set('offset',nextOffset);
    try{const response=await h.request(path+(query.size?'?'+query:''),{},true);if(!valid(current)||serial!==loadGeneration)return;entries=more?[...entries,...response.entries.filter(row=>!entries.some(existing=>existing.id===row.id))]:response.entries;entries.forEach(entry=>knownLabels.add(entry.projectLabel));total=response.total;nextOffset=response.nextOffset;loadedDate=date;projectFilter();renderList();h.message(ui.status,'');}
    catch(error){if(valid(current)&&serial===loadGeneration)h.message(ui.status,'error',true);}
    finally{if(valid(current)&&serial===loadGeneration){ui.reload.disabled=ui.more.disabled=false;}}
  }
  function matches(entry){if(ui.project.value&&ui.project.value!==entry.projectLabel)return false;if(ui.date.value){const start=parseTime(ui.date.value+'T00:00:00+08:00'),from=Date.parse(entry.startedAt||entry.endedAt),to=Date.parse(entry.endedAt);return from<start+86400000&&(to>start||(to===from&&from>=start));}return true;}
  function install(entry){
    const index=entries.findIndex(row=>row.id===entry.id);if(index>=0&&entries[index].version>entry.version)return;
    loadGeneration++;ui.reload.disabled=ui.more.disabled=false;knownLabels.add(entry.projectLabel);
    const prior=Array.from(ui.list.children).find(row=>row.dataset.timelineId===entry.id);
    if(!matches(entry)){if(index>=0){entries.splice(index,1);total=Math.max(0,total-1);if(prior)prior.remove();}if(!entries.length&&!ui.list.firstElementChild)ui.list.append(label('p','timeline_empty','small'));if(nextOffset!==null)nextOffset=0;ui.more.hidden=nextOffset===null;projectFilter();ui.count.textContent=h.tr('timeline_count')+': '+entries.length+' / '+total;renderGantt();return;}
    if(index>=0)entries[index]=entry;else{entries.push(entry);total=Math.max(total,entries.length);}entries.sort(entryOrder);
    if(prior){const replacement=renderEntry(entry);for(const name of ['timeline-content','timeline-edit','timeline-history'])if(prior.querySelector('.'+name)?.open)replacement.querySelector('.'+name).open=true;prior.replaceWith(replacement);}else{
      if(ui.list.firstElementChild?.classList.contains('small'))ui.list.replaceChildren();const card=renderEntry(entry);const following=Array.from(ui.list.children).find(node=>{const row=entries.find(item=>item.id===node.dataset.timelineId);return row&&entryOrder(row,entry)>0;});ui.list.insertBefore(card,following||null);
    }
    // Existing offsets are positional; refresh from the start before requesting another page after mutations.
    if(nextOffset!==null){nextOffset=0;}
    projectFilter();ui.count.textContent=h.tr('timeline_count')+': '+entries.length+' / '+total;ui.more.hidden=nextOffset===null;renderGantt();
  }
  async function refreshTotals(){
    const current=token(),serial=loadGeneration;const query=new URLSearchParams();if(ui.date.value)query.set('date',ui.date.value);if(ui.project.value)query.set('project',ui.project.value);
    try{const response=await h.request(path+(query.size?'?'+query:''),{},true);if(!valid(current)||serial!==loadGeneration)return;total=response.total;nextOffset=entries.length<total?0:null;ui.count.textContent=h.tr('timeline_count')+': '+entries.length+' / '+total;ui.more.hidden=nextOffset===null;renderGantt();}
    catch(_error){if(valid(current))h.message(ui.status,'error',true);}
  }
  function close(restoreFocus=true){if(!ui)return;const reading=h.captureReading();closed=true;ui.panel.hidden=ui.backdrop.hidden=true;document.body.classList.remove('timeline-open');ui.trigger.setAttribute('aria-expanded','false');if(restoreFocus!==false&&ui.trigger.isConnected&&!ui.trigger.closest('[hidden]'))ui.trigger.focus({preventScroll:true});h.restoreReading(reading);}
  function clear(){generation++;loadGeneration++;fileGeneration++;entries=[];drafts.clear();operations.clear();knownLabels.clear();importRows=null;importIndex=0;nextOffset=null;total=0;loadedDate='';if(ui){close(false);ui.list.replaceChildren();ui.gantt.replaceChildren();ui.preview.replaceChildren();ui.creation.reset();ui.creation.elements.startedAt.required=true;ui.importForm.reset();ui.date.value='';ui.project.replaceChildren();const other=h.text('option',h.tr('timeline_project_other'));other.value='';ui.creation.elements.projectId.replaceChildren(other);ui.status.textContent=ui.importStatus.textContent=ui.count.textContent='';ui.apply.hidden=true;ui.panel.querySelectorAll('input,textarea,select,button').forEach(node=>node.disabled=false);}}
  function init(helpers){
    h=helpers;const trigger=document.getElementById('timeline-toggle');const panel=h.text('aside','','timeline-panel');panel.id='project-timeline';panel.hidden=true;panel.setAttribute('aria-label',h.tr('timeline_title'));const backdrop=h.text('div','','timeline-backdrop');backdrop.hidden=true;backdrop.addEventListener('click',()=>close());
    const head=h.text('div','','toolbar');const exit=button('timeline_close',()=>close());head.append(label('h2','timeline_title'),exit);panel.append(head,label('p','timeline_note','small'));
    const filters=document.createElement('form');filters.className='timeline-filters';const date=field(filters,'timeline_date','',{name:'date',type:'date'});const project=select(filters,'timeline_project','project',[['',h.tr('all')]],'');const reload=button('timeline_filter');reload.type='submit';const today=button('timeline_today',()=>{date.value=taipeiToday();load();});filters.append(reload,today);panel.append(filters);
    const status=h.text('p','','message');status.setAttribute('role','status');const count=h.text('p','','small');panel.append(status,count);const gantt=h.text('section','','timeline-gantt');panel.append(gantt);
    const create=detail('timeline_create','timeline-create');const creation=buildForm({},'create');create.append(creation);panel.append(create);
    const importer=detail('timeline_import','timeline-import');importer.append(label('p','timeline_import_note','small'),label('p','timeline_privacy','small'));const importForm=document.createElement('form');const file=field(importForm,'import_file','',{name:'file',type:'file',required:true});file.accept='application/json,.json';const previewButton=button('preview');previewButton.type='submit';importForm.append(previewButton);const preview=h.text('div','','timeline-import-preview');const apply=button('apply');apply.hidden=true;const importStatus=h.text('p','','message');importStatus.setAttribute('role','status');importer.append(importForm,preview,apply,importStatus);panel.append(importer);
    const list=h.text('div','','timeline-list');const more=button('timeline_more',()=>load(true));more.hidden=true;panel.append(list,more);document.getElementById('private-workspace').append(backdrop,panel);
    ui={trigger,panel,backdrop,exit,date,project,reload,status,count,gantt,creation,importForm,file,previewButton,preview,apply,importStatus,list,more};trigger.setAttribute('aria-controls',panel.id);trigger.setAttribute('aria-expanded','false');
    trigger.addEventListener('click',()=>{if(!context().isAdmin)return;if(!closed){close();return;}const reading=h.captureReading();root.dotReview.close(false);closed=false;panel.hidden=backdrop.hidden=false;document.body.classList.add('timeline-open');trigger.setAttribute('aria-expanded','true');projectFilter();updateProjectChoices();exit.focus({preventScroll:true});h.restoreReading(reading);load();});
    filters.addEventListener('submit',event=>{event.preventDefault();load();});
    document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!closed){event.preventDefault();close();}});
    file.addEventListener('change',()=>{fileGeneration++;importRows=null;importIndex=0;preview.replaceChildren();apply.hidden=true;importStatus.textContent='';});
    importForm.addEventListener('submit',event=>{event.preventDefault();h.busy(previewButton,async()=>{
      const current=token(),serial=fileGeneration;importRows=null;importIndex=0;apply.hidden=true;preview.replaceChildren();const selected=file.files[0];
      try{if(!selected||selected.size>256*1024)throw new Error('invalid');const data=JSON.parse(await selected.text());if(!valid(current)||serial!==fileGeneration)return;if(data.schemaVersion!==1||!Array.isArray(data.entries)||!data.entries.length||data.entries.length>100||Object.keys(data).some(key=>!['schemaVersion','entries'].includes(key)))throw new Error('invalid');const ids=new Set();const rows=data.entries.map(row=>{const result=normalize({projectId:null,blockers:'',nextStep:'',evidence:[],...row},true);if(ids.has(result.requestId))throw new Error('invalid');ids.add(result.requestId);return result;});if(!valid(current)||serial!==fileGeneration)return;importRows=rows;const ul=document.createElement('ul');rows.forEach(row=>ul.append(h.text('li',rangeText(row)+' · '+row.projectLabel+' · '+h.tr('timeline_'+row.workType)+' · '+h.tr('timeline_goal')+': '+(row.goal||h.tr('timeline_goal_missing'))+' · '+row.result)));preview.append(ul);apply.dataset.timelineKey='apply';apply.textContent=h.tr('apply');apply.hidden=false;h.message(importStatus,'import_ready');}
      catch(_error){if(valid(current)&&serial===fileGeneration)h.message(importStatus,'timeline_import_invalid',true);}
    },importStatus);});
    apply.addEventListener('click',()=>h.busy(apply,async()=>{
      if(!importRows)return;const current=token(),serial=fileGeneration;const rows=importRows;file.disabled=previewButton.disabled=true;
      try{while(importIndex<rows.length){const response=await h.request(path,{method:'POST',body:JSON.stringify(rows[importIndex])},true);if(!valid(current)||serial!==fileGeneration)return;install(response.entry);importIndex++;importStatus.textContent=h.tr('timeline_import_progress')+': '+importIndex+' / '+rows.length;}importRows=null;apply.hidden=true;h.message(importStatus,'timeline_import_done');await refreshTotals();}
      catch(error){if(valid(current)&&serial===fileGeneration){apply.dataset.timelineKey='timeline_import_retry';apply.textContent=h.tr('timeline_import_retry');h.message(importStatus,error.status===409?'timeline_import_invalid':'error',true);}}
      finally{if(valid(current)){file.disabled=previewButton.disabled=false;}}
    },importStatus));
  }
  function translate(){if(!ui)return;ui.panel.querySelectorAll('[data-timeline-key]').forEach(node=>node.textContent=h.tr(node.dataset.timelineKey));ui.panel.querySelectorAll('[data-timeline-start]').forEach(node=>node.textContent=rangeText({startedAt:node.dataset.timelineStart||null,endedAt:node.dataset.timelineEnd}));ui.panel.querySelectorAll('[data-timeline-version],[data-timeline-at]').forEach(paintAudit);ui.panel.setAttribute('aria-label',h.tr('timeline_title'));projectFilter();updateProjectChoices();for(const form of ui.panel.querySelectorAll('.timeline-form')){const type=form.elements.workType;for(const option of type.options)option.textContent=h.tr('timeline_'+option.value);}ui.count.textContent=h.tr('timeline_count')+': '+entries.length+' / '+total;renderGantt();}
  root.dotTimeline={init,clear,close,translate};
})(window);
