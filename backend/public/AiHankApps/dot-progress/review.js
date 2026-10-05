(function(root){
  'use strict';
  let h, panel, backdrop, list, trigger, creation, feedback, closed=true, entries=[], bound=false, generation=0, exit, reload;
  const drafts=new Map(), requests=new Map();
  function identifier(key,body){const fingerprint=JSON.stringify(body);const prior=requests.get(key);if(prior?.fingerprint===fingerprint)return prior.id;const id=root.crypto.randomUUID();requests.set(key,{fingerprint,id});return id;}
  function close(restoreFocus=true){const reading=h.captureReading();closed=true;panel.hidden=true;backdrop.hidden=true;document.body.classList.remove('review-open');trigger.setAttribute('aria-expanded','false');if(restoreFocus!==false&&trigger.isConnected&&!trigger.closest('[hidden]'))trigger.focus({preventScroll:true});h.restoreReading(reading);}
  function clear(){generation++;entries=[];drafts.clear();requests.clear();if(panel){close(false);conceal(false);list.replaceChildren();creation.reset();feedback.textContent='';}}
  function render(){
    list.replaceChildren();
    if(!entries.length)list.append(h.text('p',h.tr('review_empty'),'small'));
    entries.forEach(entry=>{
      const item=h.text('article','','review-entry');item.dataset.reviewId=entry.id;
      item.append(h.text('span',h.tr('review_kind_'+entry.kind),'pill'),h.text('h3',entry.title),h.text('p',entry.body,'review-original'));
      const meta=h.text('dl','','review-meta');
      [['review_date_label',entry.occurredAt],['review_source',entry.source],['review_scope',entry.scope],['decision_actor',entry.actorId],['decision_at',h.formatTime(entry.createdAt)]].forEach(([key,value])=>{meta.append(h.text('dt',h.tr(key)),h.text('dd',value));});item.append(meta);
      const comments=h.text('div','','review-corrections');comments.append(h.text('h4',h.tr('review_corrections')));
      (entry.comments||[]).forEach(comment=>{const row=h.text('div','','comment');row.append(h.text('p',comment.body),h.text('span',comment.actorId+' · '+h.formatTime(comment.createdAt),'small'));comments.append(row);});
      const form=document.createElement('form');const body=h.field(form,'review_correction','',{name:'body',multiline:true,required:true,max:4000});body.value=drafts.get(entry.id)||'';body.addEventListener('input',()=>drafts.set(entry.id,body.value));
      const send=h.action('review_send_correction');send.type='submit';const status=h.text('p','');status.setAttribute('role','status');form.append(send,status);comments.append(form);item.append(comments);list.append(item);
      form.addEventListener('submit',event=>{event.preventDefault();h.busy(send,async()=>{
        const payload={body:body.value.trim()};body.disabled=true;
        try{const result=await h.request('/review/'+encodeURIComponent(entry.id)+'/comments',{method:'POST',body:JSON.stringify({...payload,requestId:identifier(entry.id,payload)})},true);drafts.delete(entry.id);requests.delete(entry.id);install(result.entry);}
        finally{if(body.isConnected)body.disabled=false;}
      },status);});
    });
  }
  function install(entry){generation++;const index=entries.findIndex(item=>item.id===entry.id);if(index>=0)entries[index]=entry;else entries.unshift(entry);render();}
  async function load(){const current=generation;const result=await h.request('/review',{},true);if(current!==generation)return;entries=result.entries||[];render();}
  function init(helpers){
    h=helpers;trigger=document.getElementById('review-toggle');
    panel=document.createElement('aside');panel.id='project-review';panel.className='review-panel';panel.hidden=true;panel.setAttribute('aria-label',h.tr('review_title'));
    backdrop=h.text('div','','review-backdrop');backdrop.hidden=true;backdrop.addEventListener('click',close);
    const head=h.text('div','','toolbar');head.append(h.text('h2',h.tr('review_title')));exit=h.action('review_close',close,true);head.append(exit);panel.append(head,h.text('p',h.tr('review_note'),'small'));
    reload=h.action('retry',()=>h.busy(reload,load,feedback),true);panel.append(reload);
    feedback=h.text('p','');feedback.setAttribute('role','status');panel.append(feedback);
    const create=document.createElement('details');create.append(h.text('summary',h.tr('review_add')));creation=document.createElement('form');
    const kindLabel=h.text('label','');kindLabel.append(h.text('span',h.tr('review_kind')));const kind=document.createElement('select');kind.name='kind';['permission','decision','change'].forEach(value=>{const option=h.text('option',h.tr('review_kind_'+value));option.value=value;kind.append(option);});kindLabel.append(kind);creation.append(kindLabel);
    h.field(creation,'review_entry_title','',{name:'title',required:true,max:160});h.field(creation,'review_original','',{name:'body',multiline:true,required:true,max:4000});const occurred=h.field(creation,'review_date','',{name:'occurredAt',required:true,max:40});occurred.placeholder=h.tr('review_date_hint');h.field(creation,'review_source','',{name:'source',required:true,max:500});h.field(creation,'review_scope','',{name:'scope',required:true,max:500});
    const save=h.action('review_save');save.type='submit';const status=h.text('p','');status.setAttribute('role','status');creation.append(save,status);create.append(creation);panel.append(create);
    list=h.text('div','','review-list');panel.append(list);document.body.append(backdrop,panel);
    creation.addEventListener('submit',event=>{event.preventDefault();h.busy(save,async()=>{
      const fields=Object.fromEntries(Array.from(creation.elements).filter(node=>node.name).map(node=>[node.name,node.value.trim()]));
      const result=await h.freeze(creation,()=>h.request('/review',{method:'POST',body:JSON.stringify({...fields,requestId:identifier('create',fields)})},true));requests.delete('create');creation.reset();install(result.entry);h.message(status,'saved');
    },status);});
    trigger.setAttribute('aria-controls',panel.id);trigger.setAttribute('aria-expanded','false');
    if(!bound){bound=true;trigger.addEventListener('click',()=>{
      if(!closed){close();return;}
      const reading=h.captureReading();root.dotTimeline.close(false);closed=false;panel.hidden=false;backdrop.hidden=false;document.body.classList.add('review-open');h.restoreReading(reading);trigger.setAttribute('aria-expanded','true');exit.focus({preventScroll:true});h.busy(reload,load,feedback);
    });
    document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!closed){event.preventDefault();close();}});}
  }
  function translate(){
    // Rebuild the shell only when explicitly switching languages; retain user-entered text and correction drafts.
    if(!panel)return;
    const values=Array.from(creation.elements).filter(node=>node.name).map(node=>[node.name,node.value]);const wasOpen=!closed;
    panel.remove();backdrop.remove();
    init(h);values.forEach(([name,value])=>{const node=creation.elements.namedItem(name);if(node)node.value=value;});if(wasOpen){closed=false;panel.hidden=false;backdrop.hidden=false;document.body.classList.add('review-open');}render();
  }
  function conceal(value){if(panel){panel.style.visibility=backdrop.style.visibility=value?'hidden':'';panel.inert=backdrop.inert=value;}}
  root.dotReview={init,clear,translate,close,conceal};
})(window);
