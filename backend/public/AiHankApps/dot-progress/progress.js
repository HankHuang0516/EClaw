(function () {
  'use strict';
  const API = '/api/dot-progress';
  const state = { isAdmin: false, projects: [], filter: 'pending', epoch: 0, importData: null, importGeneration:0, checking: false, loggingOut:false, drafts:new Map(), frozenForms:0, pushes:new Map(), demo:null };
  const $ = id => document.getElementById(id);
  const tr = key => window.dotI18n.t('dot_progress_' + key);
  const text = (tag,value,className) => { const node=document.createElement(tag); node.textContent=value == null ? '' : String(value); if(className) node.className=className; return node; };
  const action = (key,handler,secondary=false) => { const node=text('button',tr(key),secondary?'secondary':'');node.type='button';if(handler)node.addEventListener('click',handler);return node; };
  const message = (node,key,error=false) => {node.textContent=key?tr(key):'';node.classList.toggle('error',error);node.classList.add('message');};
  function clearPrivate() {
    state.isAdmin=false;state.projects=[];state.importData=null;state.epoch++;state.importGeneration++;state.drafts.clear();state.pushes.clear();clearDemoShares();window.dotDecisions.clear();window.dotReview.clear();
    $('project-list').replaceChildren();$('import-preview').replaceChildren();$('import-form').reset();$('import-apply').hidden=true;$('import-message').textContent='';$('admin-message').textContent='';
    $('private-workspace').hidden=true;$('logout').hidden=true;$('gate').hidden=false;
  }
  async function request(path,options={},privateCall=false) {
    const epoch=state.epoch;
    if(privateCall&&!state.isAdmin) throw Object.assign(new Error('role'),{status:403});
    const abort=new AbortController();const timer=setTimeout(()=>abort.abort(),12000);
    try {
      const response=await fetch(path.startsWith('/api/')?path:API+path,{credentials:'same-origin',cache:'no-store',...options,headers:{'Content-Type':'application/json',...(options.headers||{})},signal:abort.signal});
      if((response.status===401||response.status===403)&&privateCall){clearPrivate();message($('gate-message'),response.status===401?'expires':'forbidden',true);$('login').hidden=false;$('return-hint').hidden=false;}
      let data;try{data=await response.json();}catch(_error){data={};}
      if(!response.ok)throw Object.assign(new Error('request_failed'),{status:response.status,code:typeof data.error==='string'&&/^[a-z_]+$/.test(data.error)?data.error:undefined});
      if(data.success===false)throw new Error('request_failed');
      if(privateCall&&(epoch!==state.epoch||!state.isAdmin))throw new Error('session_changed');
      return data;
    } finally {clearTimeout(timer);}
  }
  async function busy(button,work,statusNode) {
    if(button.disabled)return;button.disabled=true;
    try{await work();}catch(error){if(statusNode&&statusNode.isConnected)message(statusNode,error.status===409?'conflict':'error',true);}finally{if(button.isConnected)button.disabled=false;}
  }
  async function freeze(form, work) {
    state.frozenForms++;$('language').disabled=true;
    const controls=Array.from(form.querySelectorAll('input,textarea,select'));
    const disabled=controls.map(node=>node.disabled);controls.forEach(node=>node.disabled=true);
    try{return await work();}finally{controls.forEach((node,index)=>{if(node.isConnected)node.disabled=disabled[index];});state.frozenForms=Math.max(0,state.frozenForms-1);$('language').disabled=state.frozenForms>0;}
  }
  async function loadPublic() {
    $('public-retry').hidden=true;message($('public-message'),'loading');
    try {
      const data=await request('/public');const items=Array.isArray(data.projects)?data.projects:[];
      $('completed-list').replaceChildren();$('completed-count').textContent=String(items.length);
      items.forEach((item,index)=>{
        const card=text('article','', 'completion');card.append(text('span',String(index+1).padStart(2,'0'),'number'),text('h3',item.title),text('p',item.publicSummary));
        const date=text('time',item.completedAt);date.dateTime=item.completedAt;card.append(date);$('completed-list').append(card);
      });
      message($('public-message'),items.length?'':'empty_public');
    } catch(_error){message($('public-message'),'error',true);$('public-retry').hidden=false;}
  }
  async function checkSession() {
    if(state.checking||state.loggingOut)return;state.checking=true;
    const epoch=state.epoch;
    $('private-workspace').hidden=true;$('logout').hidden=true;$('gate').hidden=false;$('login').hidden=true;$('session-retry').hidden=true;message($('gate-message'),'checking');
    try {
      const role=await request('/session');
      if(epoch!==state.epoch)return;
      if(!role.authenticated||!role.isAdmin){clearPrivate();message($('gate-message'),role.authenticated?'forbidden':'login_needed');$('login').hidden=false;$('return-hint').hidden=false;return;}
      state.isAdmin=true;
      if(!state.projects.length){const result=await request('/projects',{},true);state.projects=result.projects||[];renderProjects();}
      $('private-workspace').hidden=false;$('gate').hidden=true;$('logout').hidden=false;
    } catch(error) {
      if(epoch!==state.epoch)return;
      clearPrivate();message($('gate-message'),error.status===401?'login_needed':'error',error.status!==401);$('login').hidden=false;$('return-hint').hidden=false;$('session-retry').hidden=false;
    } finally {state.checking=false;}
  }
  async function reloadProjects() {
    const result=await request('/projects',{},true);state.projects=result.projects||[];renderProjects();await loadPublic();
  }
  function field(form,key,value,{name=key,multiline=false,required=false,type='text',max=4000}={}) {
    const label=text('label','');label.append(text('span',tr(key)));const input=document.createElement(multiline?'textarea':'input');input.name=name;input.value=value||'';input.required=required;input.maxLength=max;if(!multiline)input.type=type;label.append(input);form.append(label);return input;
  }
  function section(key) {const details=document.createElement('details');details.append(text('summary',tr(key)));return details;}
  function row(key,value){const part=text('div','');part.append(text('strong',tr(key)),text('p',value||'—'));return part;}
  function formValues(form,keys){return Object.fromEntries(keys.map(key=>[key,form.elements.namedItem(key).value.trim()]));}
  function addConflictRecovery(card,form,errorNode,project) {
    let recovery=errorNode.nextElementSibling;
    if(recovery&&recovery.dataset.recovery)return;
    recovery=action('latest',()=>busy(recovery,async()=>{
      const response=await request('/projects',{},true);const latest=response.projects.find(item=>item.id===project.id);if(!latest)throw new Error('missing');
      project.version=latest.version;
      const current=text('div','', 'project-summary');current.append(text('strong',tr('latest')+' · '+tr('version')+' '+latest.version),text('p',[latest.title,tr('status')+': '+tr(latest.status),latest.summary,tr('blockers')+': '+latest.blockers,tr('completed_work')+': '+(latest.completedWork||tr('not_recorded')),tr('next')+': '+latest.nextStep,tr('public_title')+': '+latest.publicTitle,tr('public_summary')+': '+latest.publicSummary,tr('date')+': '+latest.completedAt].join('\n')));
      recovery.replaceWith(current);message(errorNode,'draft');
      // Explicit next submit applies the retained draft against the version displayed above.
    },errorNode),true);recovery.dataset.recovery='true';form.append(recovery);
  }
  function projectEditor(card,project) {
    const revision={...project};
    const detail=section('edit');detail.className='project-edit';const form=document.createElement('form');form.dataset.projectFormKey='edit';
    field(form,'project_title',project.title,{name:'title',required:true,max:160});
    const label=text('label','');label.append(text('span',tr('status')));const select=document.createElement('select');select.name='status';['active','blocked','paused','completed','cancelled','archived'].forEach(status=>{const option=text('option',tr(status));option.value=status;select.append(option);});select.value=project.status;label.append(select);form.append(label);
    field(form,'goal',project.summary,{name:'summary',multiline:true,max:4000});field(form,'completed_work',project.completedWork,{name:'completedWork',multiline:true,max:4000});field(form,'blockers',project.blockers,{multiline:true,max:4000});field(form,'next',project.nextStep,{name:'nextStep',multiline:true,max:4000});
    const save=action('save');save.type='submit';const status=text('p','');status.setAttribute('role','status');form.append(save,status);
    form.addEventListener('submit',event=>{event.preventDefault();busy(save,async()=>{
      try {await request('/projects/'+encodeURIComponent(project.id),{method:'PATCH',body:JSON.stringify({version:revision.version,...formValues(form,['title','status','summary','completedWork','blockers','nextStep'])})},true);await reloadProjects();}
      catch(error){if(error.status===409){message(status,'conflict',true);addConflictRecovery(card,form,status,revision);}else throw error;}
    },status);});detail.append(form);card.append(detail);
  }
  function publicationEditor(card,project) {
    const revision={...project};
    if(['cancelled','archived'].includes(project.status)){card.append(text('p',tr('decision_terminal'),'small'));return;}
    const detail=section('publication');detail.className='project-publication';detail.append(text('p',tr('publication_note'),'small'));const form=document.createElement('form');form.dataset.projectFormKey='publication';
    field(form,'public_title',project.publicTitle,{name:'publicTitle',required:true,max:160});field(form,'public_summary',project.publicSummary,{name:'publicSummary',required:true,multiline:true,max:400});field(form,'date',project.completedAt,{name:'completedAt',required:true,type:'date'});
    const buttons=text('div','', 'actions');const publish=action('publish');publish.type='submit';buttons.append(publish);const status=text('p','');status.setAttribute('role','status');
    if(project.publicSummary){const remove=action('unpublish',()=>busy(remove,async()=>{await request('/projects/'+encodeURIComponent(project.id),{method:'PATCH',body:JSON.stringify({version:revision.version,publicSummary:''})},true);await reloadProjects();},status),true);buttons.append(remove);}
    form.append(buttons,status);form.addEventListener('submit',event=>{event.preventDefault();busy(publish,async()=>{
      try{await request('/projects/'+encodeURIComponent(project.id),{method:'PATCH',body:JSON.stringify({version:revision.version,status:'completed',...formValues(form,['publicTitle','publicSummary','completedAt'])})},true);await reloadProjects();}
      catch(error){if(error.status===409){message(status,'conflict',true);addConflictRecovery(card,form,status,revision);}else throw error;}
    },status);});detail.append(form);card.append(detail);
  }
  function comments(card,project) {
    const detail=section('comments');detail.className='project-comments';const list=text('div','');const status=text('p','');status.setAttribute('role','status');const load=action('load',()=>busy(load,async()=>{
      const data=await request('/projects/'+encodeURIComponent(project.id)+'/comments',{},true);list.replaceChildren();
      if(!data.comments.length)list.append(text('p',tr('empty_comments'),'small'));
      data.comments.forEach(item=>{const entry=text('div','', 'comment');entry.append(text('p',item.body),text('time',formatTime(item.createdAt)));list.append(entry);});message(status,'');
    },status),true);
    detail.append(load,list);const form=document.createElement('form');form.dataset.projectFormKey='comments';const input=field(form,'comment_body','',{name:'body',required:true,multiline:true,max:4000});const send=action('send');send.type='submit';form.append(send,status);
    let requestId=null;
    input.addEventListener('input',()=>{requestId=null;});
    form.addEventListener('submit',event=>{event.preventDefault();busy(send,async()=>{
      if(!requestId)requestId=window.crypto.randomUUID();
      input.disabled=true;
      try{await request('/projects/'+encodeURIComponent(project.id)+'/comments',{method:'POST',body:JSON.stringify({body:input.value.trim(),requestId})},true);
      input.value='';requestId=null;message(status,'saved');load.click();}finally{input.disabled=false;}
    },status);});detail.append(form);card.append(detail);
  }
  function formatTime(value){const date=new Date(value);return Number.isNaN(date.getTime())?'':date.toLocaleString(window.dotI18n.locale);}
  function history(card,project) {
    const detail=section('history');detail.className='project-history';const list=text('div','');const status=text('p','');const load=action('load',()=>busy(load,async()=>{
      const data=await request('/projects/'+encodeURIComponent(project.id)+'/history',{},true);list.replaceChildren();
      if(!data.history.length)list.append(text('p',tr('empty_history'),'small'));
      data.history.forEach(item=>{
        const entry=text('div','', 'history-row');entry.append(text('strong',tr('version')+' '+item.version),text('time',' · '+formatTime(item.createdAt)));
        const after=item.changes&&item.changes.after;
        const before=item.changes&&item.changes.before;
        if(before){entry.append(text('p',tr('version')+' '+Math.max(0,item.version-1)+'\n'+[before.title,tr('status')+': '+tr(before.status),before.summary,tr('completed_work')+': '+(before.completedWork||tr('not_recorded')),tr('blockers')+': '+before.blockers,tr('next')+': '+before.nextStep].join('\n')));}
        entry.append(text('p',after?[after.title,tr('status')+': '+tr(after.status),after.summary,tr('completed_work')+': '+(after.completedWork||tr('not_recorded')),tr('blockers')+': '+after.blockers,tr('next')+': '+after.nextStep].join('\n'):tr('history_'+(item.action==='import'?'import':item.action==='seed'?'seed':'change'))));list.append(entry);
      });message(status,'');
    },status),true);detail.append(load,list,status);card.append(detail);
  }
  function rememberProjectForms() {
    $('project-list').querySelectorAll('.project').forEach(card=>{
      card.querySelectorAll('form[data-project-form-key]').forEach(form=>{
        const key=card.dataset.projectId+':'+card.dataset.projectVersion+':'+form.dataset.projectFormKey;
        state.drafts.set(key,Array.from(form.elements).filter(node=>node.name).map(node=>[node.name,node.value]));
      });
    });
  }
  function workflowBlock(key, value, className) {
    const block=text('section','', 'workflow-block '+className);
    block.append(text('h4',tr(key)),text('p',value ? String(value).slice(0,160)+(String(value).length>160?'…':'') : tr('not_recorded'),'workflow-preview'));
    return block;
  }
  function originalDetails(card, project) {
    const detail=section('original_detail');detail.className='project-original';
    detail.append(text('p',project.summary,'project-summary'));
    ['completedWork','blockers','nextStep'].forEach((name,index)=>detail.append(row(['completed_work','blockers','next'][index],project[name]||tr('not_recorded'))));
    card.append(detail);
  }
  function mountPush(card, project) {
    let op=state.pushes.get(project.id);
    const storedCount=Number.isSafeInteger(project.pushCount)&&project.pushCount>=0?project.pushCount:0;
    if(!op){op={queue:[],running:false,failed:false,count:storedCount,last:project.lastPushedAt||null,epoch:state.epoch,view:null};state.pushes.set(project.id,op);}
    else if(storedCount>op.count){op.count=storedCount;op.last=project.lastPushedAt||null;}
    project.pushCount=op.count;project.lastPushedAt=op.last;
    const bar=text('div','','push-bar');const push=action('push');push.className='push-button';
    const metrics=text('div','','push-metrics');const count=text('strong','');count.className='push-count';const last=text('span','','small push-last');metrics.append(count,last);
    const feedback=text('p','','message push-message');feedback.setAttribute('role','status');const retry=action('push_retry',()=>{if(op.running||!op.failed)return;op.failed=false;run();},true);retry.classList.add('push-retry');
    bar.append(push,metrics);card.append(bar,feedback,retry);op.view={count,last,feedback,retry};
    function paint(){
      if(op.epoch!==state.epoch||!state.isAdmin)return;
      const view=op.view;if(!view||!view.count.isConnected)return;
      view.count.textContent=tr('push_count')+' '+op.count;
      view.last.textContent=tr('push_last')+': '+(op.last?formatTime(op.last):tr('not_recorded'));
      view.retry.hidden=!op.failed;view.retry.disabled=op.running;
      view.feedback.textContent=op.failed?tr('push_uncertain'):op.queue.length?tr('push_waiting')+' '+op.queue.length:'';
      view.feedback.classList.toggle('error',op.failed);
    }
    async function run(){
      if(op.running||op.failed||op.epoch!==state.epoch||!state.isAdmin)return;
      op.running=true;paint();
      try{
        while(op.queue.length&&op.epoch===state.epoch&&state.isAdmin){
          const requestId=op.queue[0];
          try{
            const result=await request('/projects/'+encodeURIComponent(project.id)+'/push',{method:'POST',body:JSON.stringify({requestId})},true);
            if(!Number.isSafeInteger(result.pushCount)||result.pushCount<0||typeof result.lastPushedAt!=='string'||Number.isNaN(Date.parse(result.lastPushedAt)))throw new Error('invalid_push_receipt');
            if(result.pushCount>=op.count){op.count=result.pushCount;op.last=result.lastPushedAt;}
            const current=state.projects.find(row=>row.id===project.id);if(current){current.pushCount=op.count;current.lastPushedAt=op.last;}
            op.queue.shift();paint();
          }catch(_error){if(op.epoch===state.epoch&&state.isAdmin){op.failed=true;paint();}break;}
        }
      }finally{op.running=false;paint();}
    }
    push.addEventListener('click',()=>{
      if(!state.isAdmin||op.epoch!==state.epoch)return;
      // Every intentional click is a distinct operation; an uncertain retry keeps this original ID.
      op.queue.push(window.crypto.randomUUID());paint();run();
    });
    paint();
    // A remounted card points the existing operation at these new display nodes without resetting its queue.
    queueMicrotask(paint);
  }
  function clearDemoShares() {
    const demo=state.demo;
    if(demo){demo.link=null;demo.shares=[];demo.bundle=null;demo.requestId=null;demo.baseline.clear();demo.generation++;demo.fileGeneration++;}
    $('demo-share-content').querySelectorAll('form').forEach(form=>form.reset());
    state.demo=null;$('demo-share-content').replaceChildren();$('demo-share-panel').open=false;
  }
  function initDemoShares() {
    const base='/api/taaze-demo-share';
    const live=share=>!share.revokedAt&&(share.expiresAt===null||Date.parse(share.expiresAt)>Date.now());
    const expiryText=value=>value===null?tr('demo_no_expiry'):tr('demo_expires')+': '+formatTime(value);
    const label=(node,key)=>{node.dataset.i18n='dot_progress_'+key;node.textContent=tr(key);return node;};
    const button=(key,handler)=>label(action(key,handler,true),key);
    function valid(demo){return state.isAdmin&&state.demo===demo&&demo.epoch===state.epoch;}
    function status(demo,key,error=false){if(valid(demo)){demo.statusKey=key;demo.statusError=error;message(demo.status,key,error);}}
    function draw(demo){
      if(!valid(demo))return;
      if(demo.statusKey)message(demo.status,demo.statusKey,demo.statusError);
      demo.metadata.replaceChildren();
      demo.metadata.append(label(text('p','','small'),demo.bundle?'demo_ready':'demo_unavailable'));
      demo.issue.disabled=!demo.bundle||demo.uncertain||demo.working;
      demo.retry.hidden=!demo.uncertain;demo.retry.disabled=demo.working;
      const unknownActive=demo.shares.some(share=>!demo.baseline.has(share.id)&&live(share));
      demo.resolve.hidden=!demo.uncertain||!demo.refreshed||unknownActive;demo.resolve.disabled=demo.working;
      demo.links.replaceChildren();
      if(demo.link){
        const link=label(text('a','','button secondary'),'demo_open');link.href=demo.link.path;link.target='_blank';link.rel='noopener noreferrer';link.referrerPolicy='no-referrer';
        demo.links.append(link,text('p',expiryText(demo.link.expiresAt),'small'));
      }
      if(!demo.shares.length)demo.metadata.append(label(text('p','','small'),'demo_empty'));
      demo.shares.forEach(share=>{
        const entry=text('div','','demo-share-entry');entry.dataset.shareId=share.id;
        const expired=share.expiresAt!==null&&Date.parse(share.expiresAt)<=Date.now();const summary=text('p',share.id+' · '+tr(share.revokedAt?'demo_revoked':expired?'demo_expired':'demo_active'),'small');
        entry.append(summary,text('p',expiryText(share.expiresAt),'small'));
        if(share.revokedAt)entry.append(text('p',tr('demo_revoked')+': '+formatTime(share.revokedAt),'small'));
        else entry.append(button('demo_revoke',event=>busy(event.currentTarget,async()=>{
          demo.generation++;
          const result=await request(base+'/shares/'+encodeURIComponent(share.id)+'/revoke',{method:'POST',body:'{}'},true);
          if(!valid(demo))return;
          demo.generation++;const current=demo.shares.find(row=>row.id===share.id);if(current)current.revokedAt=result.share.revokedAt;if(demo.link&&demo.link.id===share.id)demo.link=null;draw(demo);status(demo,'demo_revoke_ok');
        },demo.status)));
        demo.metadata.append(entry);
      });
      window.dotI18n.apply($('demo-share-content'));
    }
    async function load(demo){
      if(!valid(demo)||demo.loading)return;demo.loading=true;demo.reload.disabled=true;const generation=demo.generation;
      try{
        const result=await request(base,{},true);
        if(!valid(demo)||generation!==demo.generation)return;
        demo.bundle=result.bundle||null;demo.shares=Array.isArray(result.shares)?result.shares:[];demo.loaded=true;demo.refreshed=demo.uncertain;
        draw(demo);if(!demo.uncertain)status(demo,'');
      }catch(_error){status(demo,'error',true);}
      finally{if(valid(demo)){demo.loading=false;demo.reload.disabled=false;}}
    }
    async function issue(demo,retry=false){
      if(!valid(demo)||demo.working||!demo.bundle||(!retry&&demo.uncertain))return;
      if(!retry){demo.requestId=window.crypto.randomUUID();demo.baseline=new Set(demo.shares.map(share=>share.id));}
      if(!demo.requestId)return;
      demo.working=true;demo.generation++;demo.refreshed=false;draw(demo);
      try{
        const result=await request(base+'/shares',{method:'POST',body:JSON.stringify({requestId:demo.requestId})},true);
        if(!valid(demo))return;
        const share=result.share;
        if(!share||typeof share.path!=='string'||!/^\/AiHankApps\/taaze-demo\/[A-Za-z0-9_-]{43}\/$/.test(share.path)||!share.id||(share.expiresAt!==null&&Number.isNaN(Date.parse(share.expiresAt))))throw new Error('invalid_share_receipt');
        // The capability is retained only for this authorized page session, never recovered from metadata.
        demo.generation++;demo.link={id:share.id,path:share.path,expiresAt:share.expiresAt};demo.shares.unshift({id:share.id,createdAt:share.createdAt,expiresAt:share.expiresAt,revokedAt:null});demo.requestId=null;demo.uncertain=false;status(demo,'demo_created');
      }catch(_error){if(valid(demo)){demo.uncertain=true;status(demo,'demo_uncertain',true);}}
      finally{if(valid(demo)){demo.working=false;draw(demo);}}
    }
    function build(){
      const demo={epoch:state.epoch,generation:0,loaded:false,loading:false,bundle:null,shares:[],link:null,requestId:null,uncertain:false,working:false,baseline:new Set(),refreshed:false,fileGeneration:0};state.demo=demo;
      const content=$('demo-share-content');content.append(label(text('p','','small'),'demo_note'));
      demo.status=text('p','','message');demo.status.setAttribute('role','status');demo.metadata=text('div','','demo-share-metadata');demo.links=text('div','','demo-share-links');
      demo.reload=button('demo_refresh',()=>load(demo));demo.issue=button('demo_create',()=>issue(demo));demo.issue.disabled=true;
      demo.retry=button('demo_retry',()=>issue(demo,true));demo.retry.hidden=true;
      demo.resolve=button('demo_resolve',()=>{if(!valid(demo)||!demo.refreshed||demo.working||demo.shares.some(share=>!demo.baseline.has(share.id)&&live(share)))return;demo.uncertain=false;demo.requestId=null;demo.refreshed=false;draw(demo);status(demo,'demo_resolved');});demo.resolve.hidden=true;
      const actions=text('div','','actions');actions.append(demo.reload,demo.issue,demo.retry,demo.resolve);
      const form=document.createElement('form');form.className='demo-share-import';const input=field(form,'demo_file','',{name:'bundle',type:'file',required:true});input.accept='application/json,.json';input.previousElementSibling.dataset.i18n='dot_progress_demo_file';
      const submit=button('demo_import');submit.type='submit';form.append(submit);input.addEventListener('change',()=>{demo.fileGeneration++;status(demo,'');});
      form.addEventListener('submit',event=>{event.preventDefault();busy(submit,()=>freeze(form,async()=>{
        if(!valid(demo))return;const file=input.files[0];if(!file||file.size>3*1024*1024){status(demo,'demo_invalid_file',true);return;}
        const generation=demo.fileGeneration;let payload;
        try{payload=JSON.parse(await file.text());}catch(_error){status(demo,'demo_invalid_file',true);return;}
        if(!valid(demo)||generation!==demo.fileGeneration)return;
        if(!payload||typeof payload.sourceArchiveBase64!=='string'||typeof payload.sourceCommit!=='string'||!Array.isArray(payload.files)){status(demo,'demo_invalid_file',true);return;}
        demo.generation++;
        const result=await request(base+'/bundle',{method:'POST',body:JSON.stringify(payload)},true);payload=null;
        if(!valid(demo)||generation!==demo.fileGeneration)return;
        demo.generation++;demo.bundle=result.bundle;form.reset();draw(demo);status(demo,'demo_imported');
      }),demo.status);});
      content.append(actions,demo.links,demo.status,demo.metadata,form);return demo;
    }
    $('demo-share-panel').addEventListener('toggle',()=>{if($('demo-share-panel').open&&state.isAdmin){const demo=state.demo||build();if(!demo.loaded)load(demo);}});
    return ()=>{if(state.demo)draw(state.demo);};
  }
  function updateVisibility() {
    let visible=0;
    $('project-list').querySelectorAll('.project').forEach(card=>{
      const project=state.projects.find(item=>item.id===card.dataset.projectId);
      const terminal=['completed','cancelled','archived'].includes(project.status);
      const show=state.filter==='all'||(state.filter==='completed'?project.status==='completed':state.filter==='terminal'?['cancelled','archived'].includes(project.status):state.filter==='decisions'?!['cancelled','archived'].includes(project.status)&&window.dotDecisions.hasPending(project.id):!terminal);
      card.hidden=!show;if(show)visible++;
    });
    message($('admin-message'),visible?'':'empty_projects');
  }
  function renderProjects() {
    rememberProjectForms();
    $('project-list').replaceChildren();
    state.projects.forEach(project=>{
      const card=text('article','', 'project');card.dataset.projectId=project.id;card.dataset.projectVersion=project.version;
      const heading=text('div','', 'toolbar project-heading');heading.append(text('h3',project.title),text('span',tr('phase')+': '+tr(project.status),'status '+project.status));card.append(heading);
      mountPush(card,project);
      const workflow=text('div','','project-workflow');workflow.append(workflowBlock('completed_work',project.completedWork,'workflow-completed'),workflowBlock('blockers',project.blockers,'workflow-blockers'),workflowBlock('next',project.nextStep,'workflow-next'));
      card.append(workflow);
      const decisions=text('div','','workflow-decisions');
      window.dotDecisions.mount(project,decisions,{request,tr,text,action,field,message,busy,freeze,formatTime,onChange:updateVisibility});card.append(decisions);
      const detailArea=text('div','','project-detail-area');originalDetails(detailArea,project);projectEditor(detailArea,project);publicationEditor(detailArea,project);comments(detailArea,project);history(detailArea,project);card.append(detailArea);
      card.querySelectorAll('form[data-project-form-key]').forEach(form=>{const values=state.drafts.get(project.id+':'+project.version+':'+form.dataset.projectFormKey);if(values)values.forEach(([name,value])=>{const node=form.elements.namedItem(name);if(node)node.value=value;});});
      $('project-list').append(card);
    });
    updateVisibility();
  }
  $('filters').addEventListener('click',async event=>{
    const button=event.target.closest('button[data-filter]');if(!button||button.disabled)return;
    if(button.dataset.filter==='decisions'){
      button.disabled=true;
      try{await Promise.all(state.projects.map(project=>window.dotDecisions.load(project.id)));}
      catch(_error){if(state.isAdmin)message($('admin-message'),'error',true);return;}
      finally{if(button.isConnected)button.disabled=false;}
      if(!state.isAdmin)return;
    }
    state.filter=button.dataset.filter;
    $('filters').querySelectorAll('button').forEach(item=>{item.classList.toggle('active',item===button);item.setAttribute('aria-pressed',String(item===button));});
    updateVisibility();
  });
  $('import-file').addEventListener('change',()=>{state.importGeneration++;state.importData=null;$('import-preview').replaceChildren();$('import-apply').hidden=true;message($('import-message'),'');});
  $('import-form').addEventListener('submit',event=>{event.preventDefault();const button=event.submitter;busy(button,async()=>{
    state.importData=null;$('import-apply').hidden=true;$('import-preview').replaceChildren();
    const generation=state.importGeneration;
    const file=$('import-file').files[0];if(!file||file.size>256*1024){message($('import-message'),'invalid_file',true);return;}
    let data;try{data=JSON.parse(await file.text());}catch(_error){message($('import-message'),'invalid_file',true);return;}
    if(generation!==state.importGeneration||!state.isAdmin)return;
    const preview=await request('/import',{method:'POST',body:JSON.stringify({mode:'preview',data})},true);
    if(generation!==state.importGeneration||!state.isAdmin)return;
    const list=document.createElement('ul');preview.projects.forEach(project=>{list.append(text('li',project.title+' · '+tr(project.status)));});$('import-preview').append(list);state.importData=data;$('import-apply').hidden=false;message($('import-message'),'import_ready');
  },$('import-message'));});
  $('import-apply').addEventListener('click',()=>busy($('import-apply'),async()=>{
    if(!state.importData)return;
    await request('/import',{method:'POST',body:JSON.stringify({mode:'apply',data:state.importData})},true);state.importData=null;$('import-apply').hidden=true;$('import-preview').replaceChildren();$('import-form').reset();await reloadProjects();message($('import-message'),'import_done');
  },$('import-message')));
  $('logout').addEventListener('click',async()=>{
    if(state.loggingOut)return;state.loggingOut=true;clearPrivate();message($('gate-message'),'session_changed');$('login').hidden=false;$('return-hint').hidden=false;
    let failed=false;
    try{await request('/api/auth/logout',{method:'POST',body:'{}'});}catch(_error){failed=true;}
    finally{clearPrivate();state.loggingOut=false;message($('gate-message'),failed?'error':'login_needed',failed);$('login').hidden=false;$('return-hint').hidden=false;$('session-retry').hidden=false;}
  });
  $('public-retry').addEventListener('click',loadPublic);$('session-retry').addEventListener('click',checkSession);
  $('language').addEventListener('change',event=>{window.dotI18n.setLocale(event.target.value);if(state.isAdmin){renderProjects();window.dotReview.translate();translateDemoShares();}loadPublic();});
  window.addEventListener('focus',checkSession);
  window.addEventListener('pageshow',event=>{if(event.persisted){clearPrivate();checkSession();}});
  window.addEventListener('beforeunload',event=>{
    if(state.isAdmin&&Array.from(state.pushes.values()).some(op=>op.queue.length)){event.preventDefault();event.returnValue='';}
  });
  window.addEventListener('pagehide',()=>{clearPrivate();});
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)checkSession();});
  const translateDemoShares=initDemoShares();
  window.dotReview.init({request,tr,text,action,field,message,busy,freeze,formatTime});
  window.dotI18n.apply();loadPublic();checkSession();
})();
