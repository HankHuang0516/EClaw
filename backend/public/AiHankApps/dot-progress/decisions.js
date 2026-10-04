(function (root) {
  'use strict';
  // All records and drafts live only in this signed-in page. They are never persisted in browser storage.
  let helpers;
  const records = new Map();
  const drafts = new Map();
  const pendingLoads = new Map();
  const generations = new Map();
  const requestIds = new Map();
  const terminal = status => ['cancelled', 'archived'].includes(status);
  const path = projectId => '/projects/' + encodeURIComponent(projectId) + '/decisions';
  const hasPending = projectId => (records.get(projectId) || []).some(item => item.state === 'pending' || item.state === 'clarification');
  function clear() { records.clear(); drafts.clear(); pendingLoads.clear(); requestIds.clear(); generations.clear(); }
  function requestId(key, body) {
    const fingerprint=JSON.stringify(body);
    const prior=requestIds.get(key);
    if(prior?.fingerprint===fingerprint)return prior.id;
    const id=root.crypto.randomUUID();requestIds.set(key,{fingerprint,id});return id;
  }
  async function load(projectId) {
    if (pendingLoads.has(projectId)) return pendingLoads.get(projectId);
    const generation=generations.get(projectId)||0;
    const work = helpers.request(path(projectId), {}, true).then(result => {
      if((generations.get(projectId)||0)!==generation)return records.get(projectId)||[];
      records.set(projectId, result.decisions || []);
      return records.get(projectId);
    });
    pendingLoads.set(projectId, work);
    try { return await work; } finally { if (pendingLoads.get(projectId) === work) pendingLoads.delete(projectId); }
  }
  function remember(id, form) {
    const values = Object.fromEntries(Array.from(form.elements).filter(node => node.name).map(node => [node.name, node.type === 'checkbox' ? node.checked : node.value]));
    drafts.set(id, values);
  }
  function restore(id, form) {
    const values = drafts.get(id);
    if (!values) return;
    for (const [name, value] of Object.entries(values)) {
      const node = form.elements.namedItem(name);
      if (node) { if (node.type === 'checkbox') node.checked = value; else node.value = value; }
    }
  }
  function track(id, form) { restore(id, form); form.addEventListener('input', () => remember(id, form)); }
  function install(projectId, decision) {
    generations.set(projectId,(generations.get(projectId)||0)+1);
    const list = records.get(projectId) || [];
    const index = list.findIndex(item => item.id === decision.id);
    if (index >= 0) list[index] = decision; else list.push(decision);
    records.set(projectId, list);
    helpers.onChange();
  }
  function badge(key, value) {
    const {text, tr} = helpers;
    const node = text('p', '', 'small');
    node.append(text('strong', tr(key) + ': '), text('span', value));
    return node;
  }
  function renderDecision(project, decision, list) {
    const {text, tr, action, field, message, busy, freeze, request, formatTime} = helpers;
    const snapshot = {version: decision.version, recommendationVersion: decision.recommendationVersion};
    const item = text('article', '', 'decision');
    item.dataset.decisionId = decision.id;
    const head = text('div', '', 'toolbar');
    head.append(text('h4', decision.question), text('span', tr('decision_' + decision.state), 'status ' + decision.state));
    item.append(head, badge('decision_rv', decision.recommendationVersion), text('strong', tr('decision_recommendation')), text('p', decision.recommendation, 'project-summary'));
    if (decision.adoption && decision.adopted) {
      item.append(badge('decision_actor', decision.adoption.actorId), badge('decision_at', formatTime(decision.adoption.at)));
    }
    if(!decision.adopted&&decision.events?.length){const latest=decision.events.at(-1);item.append(badge('decision_actor',latest.actorId||'—'),badge('decision_at',formatTime(latest.createdAt||latest.at)));}
    item.append(text('p', tr('decision_no_action'), 'small'));
    const choice = document.createElement('form');
    choice.className = 'decision-choice';
    const label = text('label', '', 'switch-label');
    const toggle = document.createElement('input');
    toggle.type = 'checkbox'; toggle.name = 'adopted'; toggle.setAttribute('role', 'switch');
    toggle.setAttribute('aria-label', tr('decision_adopt'));
    // A persisted adoption applies only to the exact current recommendation revision.
    toggle.checked = decision.adopted === true && decision.adoption?.recommendationVersion === snapshot.recommendationVersion;
    label.append(toggle, text('span', tr('decision_adopt')));
    const feedback = text('p', ''); feedback.setAttribute('role', 'status');
    choice.append(label, feedback);item.append(choice);
    const revision = document.createElement('details'); revision.append(text('summary', tr('decision_edit')));
    const edit = document.createElement('form');
    const editKey = 'edit:' + decision.id;
    field(edit, 'decision_question', decision.question, {name:'question', multiline:true, required:true, max:1000});
    field(edit, 'decision_recommendation', decision.recommendation, {name:'recommendation', multiline:true, required:true, max:4000});
    track(editKey, edit);
    const editSave = action('decision_save_revision'); editSave.type = 'submit';
    const editStatus = text('p', ''); editStatus.setAttribute('role', 'status'); edit.append(editSave, editStatus); revision.append(edit); item.append(revision);
    const comments = text('div', '', 'decision-comments'); comments.append(text('h5', tr('decision_comments')));
    (decision.comments || []).forEach(comment => {
      const row = text('div', '', 'comment');
      row.append(text('p', comment.body), text('time', formatTime(comment.createdAt)), badge('decision_actor', comment.actorId), badge(comment.recommendationVersion === snapshot.recommendationVersion ? 'decision_rv' : 'decision_old_rv', comment.recommendationVersion));
      comments.append(row);
    });
    const alternative = document.createElement('form');
    const commentKey = 'comment:' + decision.id;
    const input = field(alternative, 'decision_alternative', '', {name:'body', required:true, multiline:true, max:4000});
    track(commentKey, alternative);
    alternative.append(text('p', tr('decision_clarification_note'), 'small'));
    const send = action('decision_send_alternative'); send.type = 'submit';
    const commentStatus = text('p', ''); commentStatus.setAttribute('role', 'status'); alternative.append(send, commentStatus); comments.append(alternative); item.append(comments);
    const audit = document.createElement('details'); audit.append(text('summary', tr('decision_audit')));
    (decision.events || []).forEach(event => {
      const row = text('div', '', 'history-row');
      const actionKey=['created','revised','adopted','withdrawn','clarification_comment'].includes(event.action)?'decision_event_'+event.action:'decision_audit_entry';
      row.append(text('p', tr(actionKey)), badge('decision_actor', event.actorId || '—'), badge('decision_at', formatTime(event.at || event.createdAt)), badge('decision_rv', event.recommendationVersion || '—'));
      function snapshotContent(key,value){if(!value)return;const group=document.createElement('details');group.append(text('summary',tr(key)),badge('decision_question',value.question||''),badge('decision_recommendation',value.recommendation||''));if(value.adoption){group.append(badge('decision_actor',value.adoption.actorId),badge('decision_at',formatTime(value.adoption.at)),badge('decision_rv',value.adoption.recommendationVersion));}row.append(group);}
      if(event.action==='created')snapshotContent('decision_original',event.data);
      if(event.action==='revised'){snapshotContent('decision_before',event.data?.before);snapshotContent('decision_after',event.data?.after);}
      audit.append(row);
    }); item.append(audit);
    if (decision.state === 'clarification') item.insertBefore(text('p', tr('decision_clarification_note'), 'message'), choice);
    if (terminal(project.status)) {
      toggle.disabled=!decision.adopted;
      editSave.disabled=true;edit.querySelectorAll('textarea').forEach(node=>node.disabled=true);
      item.insertBefore(text('p', tr('decision_terminal'), 'small'), choice);
    }
    function contradiction(node) {
      if (toggle.checked && input.value.trim()) { message(node, 'decision_contradiction', true); return true; }
      return false;
    }
    function replace(next) {
      // The old switch is intentionally never replayed after a new server version/recommendation.
      remember(editKey, edit); remember(commentKey, alternative);
      install(project.id, next);
      const replacement = renderDecision(project, next, list);
      item.replaceWith(replacement);
    }
    function conflict(node, error) {
      message(node, error.code === 'clarification_required' ? 'decision_clarification_note' : error.code==='project_inactive'?'decision_terminal':'decision_stale', true);
      if (node.parentElement.querySelector('[data-decision-reload]')) return;
      toggle.disabled=true;
      const reload = action('decision_reload', () => busy(reload, async () => {
        const latest = (await load(project.id)).find(row => row.id === decision.id);
        if (!latest) throw new Error('missing_decision');
        replace(latest);
      }, node), true);
      reload.dataset.decisionReload='true';node.after(reload);
    }
    async function mutate(button, status, url, body, after) {
      await busy(button, async () => {
        try { const result=await freeze(alternative,()=>request(url, {method:'POST',body:JSON.stringify(body)},true)); if(after)after();replace(result.decision); }
        catch(error) { if(error.status===409)conflict(status,error);else throw error; }
      }, status);
    }
    const persistedChoice=toggle.checked;let staleChoice=false;
    if(decision.state==='clarification')toggle.disabled=true;
    toggle.addEventListener('change',async()=>{
      if(staleChoice){toggle.checked=persistedChoice;return;}
      const adopted=toggle.checked;
      if(contradiction(feedback)){toggle.checked=persistedChoice;return;}
      if((terminal(project.status)&&adopted)||(decision.state==='clarification'&&adopted)){
        toggle.checked=persistedChoice;message(feedback,terminal(project.status)?'decision_terminal':'decision_clarification_note',true);return;
      }
      await busy(toggle,async()=>{
        try{const result=await freeze(choice,()=>request(path(project.id)+'/'+encodeURIComponent(decision.id)+'/adoption',{method:'POST',body:JSON.stringify({...snapshot,adopted})},true));replace(result.decision);}
        catch(error){toggle.checked=persistedChoice;if(error.status===409){staleChoice=true;conflict(feedback,error);}else throw error;}
      },feedback);
      if(staleChoice&&toggle.isConnected)toggle.disabled=true;
    });
    edit.addEventListener('submit', event => {
      event.preventDefault();if(terminal(project.status)){message(editStatus,'decision_terminal',true);return;}
      busy(editSave, async () => {
        try {
          const payload={version:snapshot.version,question:edit.elements.question.value.trim(),recommendation:edit.elements.recommendation.value.trim()};
          const result=await freeze(edit,()=>request(path(project.id)+'/'+encodeURIComponent(decision.id), {method:'PATCH',body:JSON.stringify(payload)},true));
          drafts.delete(editKey);
          // Keep alternative draft, but revised recommendations always start with the switch off.
          install(project.id,result.decision);item.replaceWith(renderDecision(project,result.decision,list));
        } catch(error){if(error.status===409)conflict(editStatus,error);else throw error;}
      },editStatus);
    });
    alternative.addEventListener('submit', event => {
      event.preventDefault();
      const body=input.value.trim();
      mutate(send,commentStatus,path(project.id)+'/'+encodeURIComponent(decision.id)+'/comments',{...snapshot,body,requestId:requestId(commentKey,{body})},()=>{input.value='';drafts.delete(commentKey);requestIds.delete(commentKey);});
    });
    return item;
  }
  function mount(project, card, shared) {
    helpers=shared;
    const {text,tr,field,action,busy,freeze,message,request}=shared;
    const section=document.createElement('details');section.className='decision-section';section.append(text('summary',tr('decisions')));
    const list=text('div','','decision-list');section.append(list);
    const status=text('p','');status.setAttribute('role','status');
    function render() {
      list.replaceChildren();const items=records.get(project.id)||[];
      if(!items.length)list.append(text('p',tr('decision_empty'),'small'));
      items.forEach(decision=>list.append(renderDecision(project,decision,list)));
    }
    const reload=action('load',()=>busy(reload,async()=>{await load(project.id);render();shared.onChange();message(status,'');},status),true);
    section.append(reload,status);
    let loaded=records.has(project.id);
    if(loaded)render();
    section.addEventListener('toggle',()=>{if(section.open&&!loaded){loaded=true;reload.click();}});
    const create=document.createElement('details');create.append(text('summary',tr('decision_new')));const form=document.createElement('form');
    field(form,'decision_question','',{name:'question',required:true,multiline:true,max:1000});field(form,'decision_recommendation','',{name:'recommendation',required:true,multiline:true,max:4000});
    const createKey='create:'+project.id;track(createKey,form);
    const button=action('decision_create');button.type='submit';const createStatus=text('p','');createStatus.setAttribute('role','status');form.append(button,createStatus);create.append(form);section.append(create);
    form.addEventListener('submit',event=>{event.preventDefault();busy(button,async()=>{
      const body={question:form.elements.question.value.trim(),recommendation:form.elements.recommendation.value.trim()};
      const result=await freeze(form,()=>request(path(project.id),{method:'POST',body:JSON.stringify({...body,requestId:requestId(createKey,body)})},true));
      form.reset();drafts.delete(createKey);requestIds.delete(createKey);install(project.id,result.decision);render();message(createStatus,'decision_saved');
    },createStatus);});card.append(section);
    if(terminal(project.status)){button.disabled=true;form.querySelectorAll('textarea').forEach(node=>node.disabled=true);}
  }
  root.dotDecisions={mount,load,hasPending,clear};
})(window);
