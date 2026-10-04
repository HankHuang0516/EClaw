(function () {
  'use strict';
  const API = '/api/dot-progress';
  const state = { isAdmin: false, projects: [], filter: 'pending', epoch: 0, importData: null, importGeneration:0, checking: false, loggingOut:false };
  const $ = id => document.getElementById(id);
  const tr = key => window.dotI18n.t('dot_progress_' + key);
  const text = (tag,value,className) => { const node=document.createElement(tag); node.textContent=value == null ? '' : String(value); if(className) node.className=className; return node; };
  const action = (key,handler,secondary=false) => { const node=text('button',tr(key),secondary?'secondary':'');node.type='button';if(handler)node.addEventListener('click',handler);return node; };
  const message = (node,key,error=false) => {node.textContent=key?tr(key):'';node.classList.toggle('error',error);node.classList.add('message');};
  function clearPrivate() {
    state.isAdmin=false;state.projects=[];state.importData=null;state.epoch++;state.importGeneration++;
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
      if(!response.ok)throw Object.assign(new Error('request_failed'),{status:response.status});
      const data=await response.json();
      if(data.success===false)throw new Error('request_failed');
      if(privateCall&&(epoch!==state.epoch||!state.isAdmin))throw new Error('session_changed');
      return data;
    } finally {clearTimeout(timer);}
  }
  async function busy(button,work,statusNode) {
    if(button.disabled)return;button.disabled=true;
    try{await work();}catch(error){if(statusNode&&statusNode.isConnected)message(statusNode,error.status===409?'conflict':'error',true);}finally{if(button.isConnected)button.disabled=false;}
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
      const current=text('div','', 'project-summary');current.append(text('strong',tr('latest')+' · '+tr('version')+' '+latest.version),text('p',[latest.title,tr('status')+': '+tr(latest.status),latest.summary,tr('blockers')+': '+latest.blockers,tr('next')+': '+latest.nextStep,tr('public_title')+': '+latest.publicTitle,tr('public_summary')+': '+latest.publicSummary,tr('date')+': '+latest.completedAt].join('\n')));
      recovery.replaceWith(current);message(errorNode,'draft');
      // Explicit next submit applies the retained draft against the version displayed above.
    },errorNode),true);recovery.dataset.recovery='true';form.append(recovery);
  }
  function projectEditor(card,project) {
    const revision={...project};
    const detail=section('edit');const form=document.createElement('form');
    field(form,'project_title',project.title,{name:'title',required:true,max:160});
    const label=text('label','');label.append(text('span',tr('status')));const select=document.createElement('select');select.name='status';['active','blocked','paused','completed'].forEach(status=>{const option=text('option',tr(status));option.value=status;select.append(option);});select.value=project.status;label.append(select);form.append(label);
    field(form,'goal',project.summary,{name:'summary',multiline:true,max:4000});field(form,'blockers',project.blockers,{multiline:true,max:4000});field(form,'next',project.nextStep,{name:'nextStep',multiline:true,max:4000});
    const save=action('save');save.type='submit';const status=text('p','');status.setAttribute('role','status');form.append(save,status);
    form.addEventListener('submit',event=>{event.preventDefault();busy(save,async()=>{
      try {await request('/projects/'+encodeURIComponent(project.id),{method:'PATCH',body:JSON.stringify({version:revision.version,...formValues(form,['title','status','summary','blockers','nextStep'])})},true);await reloadProjects();}
      catch(error){if(error.status===409){message(status,'conflict',true);addConflictRecovery(card,form,status,revision);}else throw error;}
    },status);});detail.append(form);card.append(detail);
  }
  function publicationEditor(card,project) {
    const revision={...project};
    const detail=section('publication');detail.append(text('p',tr('publication_note'),'small'));const form=document.createElement('form');
    field(form,'public_title',project.publicTitle,{name:'publicTitle',required:true,max:160});field(form,'public_summary',project.publicSummary,{name:'publicSummary',required:true,multiline:true,max:400});field(form,'date',project.completedAt,{name:'completedAt',required:true,type:'date'});
    const buttons=text('div','', 'actions');const publish=action('publish');publish.type='submit';buttons.append(publish);const status=text('p','');status.setAttribute('role','status');
    if(project.publicSummary){const remove=action('unpublish',()=>busy(remove,async()=>{await request('/projects/'+encodeURIComponent(project.id),{method:'PATCH',body:JSON.stringify({version:revision.version,publicSummary:''})},true);await reloadProjects();},status),true);buttons.append(remove);}
    form.append(buttons,status);form.addEventListener('submit',event=>{event.preventDefault();busy(publish,async()=>{
      try{await request('/projects/'+encodeURIComponent(project.id),{method:'PATCH',body:JSON.stringify({version:revision.version,status:'completed',...formValues(form,['publicTitle','publicSummary','completedAt'])})},true);await reloadProjects();}
      catch(error){if(error.status===409){message(status,'conflict',true);addConflictRecovery(card,form,status,revision);}else throw error;}
    },status);});detail.append(form);card.append(detail);
  }
  function comments(card,project) {
    const detail=section('comments');const list=text('div','');const status=text('p','');status.setAttribute('role','status');const load=action('load',()=>busy(load,async()=>{
      const data=await request('/projects/'+encodeURIComponent(project.id)+'/comments',{},true);list.replaceChildren();
      if(!data.comments.length)list.append(text('p',tr('empty_comments'),'small'));
      data.comments.forEach(item=>{const entry=text('div','', 'comment');entry.append(text('p',item.body),text('time',formatTime(item.createdAt)));list.append(entry);});message(status,'');
    },status),true);
    detail.append(load,list);const form=document.createElement('form');const input=field(form,'comment_body','',{name:'body',required:true,multiline:true,max:4000});const send=action('send');send.type='submit';form.append(send,status);
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
    const detail=section('history');const list=text('div','');const status=text('p','');const load=action('load',()=>busy(load,async()=>{
      const data=await request('/projects/'+encodeURIComponent(project.id)+'/history',{},true);list.replaceChildren();
      if(!data.history.length)list.append(text('p',tr('empty_history'),'small'));
      data.history.forEach(item=>{
        const entry=text('div','', 'history-row');entry.append(text('strong',tr('version')+' '+item.version),text('time',' · '+formatTime(item.createdAt)));
        const after=item.changes&&item.changes.after;
        const before=item.changes&&item.changes.before;
        if(before){entry.append(text('p',tr('version')+' '+Math.max(0,item.version-1)+'\n'+[before.title,tr('status')+': '+tr(before.status),before.summary,tr('blockers')+': '+before.blockers,tr('next')+': '+before.nextStep].join('\n')));}
        entry.append(text('p',after?[after.title,tr('status')+': '+tr(after.status),after.summary,tr('blockers')+': '+after.blockers,tr('next')+': '+after.nextStep].join('\n'):tr('history_'+(item.action==='import'?'import':item.action==='seed'?'seed':'change'))));list.append(entry);
      });message(status,'');
    },status),true);detail.append(load,list,status);card.append(detail);
  }
  function renderProjects() {
    $('project-list').replaceChildren();
    const projects=state.projects.filter(project=>state.filter==='all'||(state.filter==='completed'?project.status==='completed':project.status!=='completed'));
    message($('admin-message'),projects.length?'':'empty_projects');
    projects.forEach(project=>{
      const card=text('article','', 'project');const heading=text('div','', 'toolbar');heading.append(text('h3',project.title),text('span',tr(project.status),'status '+project.status));card.append(heading,text('p',project.summary,'project-summary'));
      const meta=text('div','', 'project-meta');meta.append(row('blockers',project.blockers),row('next',project.nextStep));card.append(meta);projectEditor(card,project);publicationEditor(card,project);comments(card,project);history(card,project);$('project-list').append(card);
    });
  }
  $('filters').addEventListener('click',event=>{const button=event.target.closest('button[data-filter]');if(!button)return;state.filter=button.dataset.filter;$('filters').querySelectorAll('button').forEach(item=>{item.classList.toggle('active',item===button);item.setAttribute('aria-pressed',String(item===button));});renderProjects();});
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
  $('language').addEventListener('change',event=>{window.dotI18n.setLocale(event.target.value);if(state.isAdmin)renderProjects();loadPublic();});
  window.addEventListener('focus',checkSession);
  window.addEventListener('pageshow',event=>{if(event.persisted){clearPrivate();checkSession();}});
  window.addEventListener('pagehide',()=>{clearPrivate();});
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)checkSession();});
  window.dotI18n.apply();loadPublic();checkSession();
})();
