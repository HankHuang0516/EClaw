/* global window, document, fetch */
(function () {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  async function boot(options = {}) {
    const host = options.host || document.getElementById('campInteractionHost');
    if (!host) return;
    try {
      let data=options.data;if(!data){const response=await fetch('camp-interaction-data.json',{cache:'no-cache'});if(!response.ok)throw Error('無法讀取場景資料');data=await response.json();}
      const model = window.FraudCampInteractionModel;
      if (!model || !model.validate(data)) throw new Error('場景資料不完整');
      const commands=[];let state=model.create(null,options.preview===true);if(options.initialLog){if(!Array.isArray(options.initialLog)||options.initialLog.length>1000)throw Error('invalid-preview-log');for(const command of options.initialLog){const out=model.transition(state,command,data);if(!out.changed)throw Error('incompatible-preview-log');state=out.state;commands.push(JSON.parse(JSON.stringify(command)));}}
      let message = options.preview?'獨立流程預覽：只試走來源連線，沒有授予序章完成、正式入場或獎勵。':'先完成 T02 的安置。';
      let artOpen = false;
      const fullDesign = () => Boolean(window.FraudRelationshipArchive?.getView?.().spoilers);
      const button = (action, label, value = '', disabled = false, current = false) => `<button type="button" data-camp-action="${esc(action)}" data-camp-value="${esc(value)}" data-camp-key="${esc(action + ':' + value)}"${disabled ? ' disabled' : ''}${current ? ' aria-current="location"' : ''}>${esc(label)}</button>`;
      const label = hotspot => fullDesign() ? hotspot.label : hotspot.kind + '熱點 ' + hotspot.id.split('-').pop();
      function render(focusKey, changedScene = false) {
        const oldArt = host.querySelector('.pi-art');
        if (oldArt) artOpen = oldArt.open;
        const scene = data.scenes.find(s => s.scene_id === state.sceneId);
        const selected = scene.hotspots.find(h => h.id === state.selectedHotspot);
        const frame = /^images\/[a-f0-9]{20}\.webp$/.test(scene.visual) ? `<img src="${esc(scene.visual)}" alt="${esc(scene.scene_id + ' ' + scene.name + ' 原AI場景示意')}" loading="lazy">` : '<p>沒有可用場景圖。</p>';
        const detail = selected ? `<section class="camp-detail" aria-label="熱點資料"><h4 tabindex="-1" id="campDetailTitle">${esc(label(selected))}</h4><p>已走近並查看。背包與筆記沒有增加。</p>${selected.acquisition.length ? (fullDesign() ? selected.acquisition.map(a => `<details><summary>${esc(a.registry_id + ' ' + a.registry_name)}／來源條件</summary><p>${esc(a.prerequisite)}</p><pre>${esc(JSON.stringify(a.source_events, null, 2))}</pre><p>${esc(a.latestUse)}</p>${a.sourceDifference ? `<p class="camp-warning">${esc(a.sourceDifference)}</p>` : ''}</details>`).join('') : '<p>未發現的物品不先公布名稱。要核對完整來源，可到關係圖明確開啟完整企劃模式。</p><a href="#story">前往人物與故事</a>') + '<p class="camp-warning">取物提交尚未接入，這一項未完成。不能用「看過了」代替領取條件。</p>' : '<p>此熱點沒有可自動發放的物品。</p>'}<div class="pi-controls">${button('claim', '收下：尚未接入事件提交', '', true)}${button('close', '收起資料')}</div></section>` : '';
        host.innerHTML = `<p class="pi-notice">這一批可核對來源連線並試走 <strong>9 個場景</strong>，不是正式場景解鎖。宿舍只保留參照；取物與劇情提交尚未接入，不標完成。</p><div class="camp-toolbar"><label for="campSceneSelect">場景提案預覽<select id="campSceneSelect"${state.ready ? '' : ' disabled'}>${data.scenes.map(s => `<option value="${esc(s.scene_id)}"${s.scene_id === state.sceneId ? ' selected' : ''}>${esc(s.scene_id + ' ' + s.name + (s.routeHold ? '／布局待確認' : ''))}</option>`).join('')}</select></label><p>${options.preview?'獨立流程預覽；不代表序章已完成或正式入場。':state.ready ? '本時間線已完成安置。' : '先在上方完成 T02，這裡才開放試走。'}</p></div><div class="camp-shortcuts" role="group" aria-label="場景預覽快捷選擇">${data.scenes.map(s => button('preview-scene', s.scene_id + ' ' + s.name, s.scene_id, !state.ready, s.scene_id === state.sceneId)).join('')}</div><div class="pi-workspace"><article class="pi-stage"><h3 id="campStageTitle" tabindex="-1">${esc(scene.name)}／路徑試走</h3><p class="camp-position"><strong>${state.nodeId ? '目前站位：' + esc(state.nodeId) : '尚未設定試走起點'}</strong>這是來源連線的前端演示，不是正式入場位置；不套日期、時間或資源。</p>${scene.routeHold ? '<p class="camp-warning">宿舍布局還沒確認。這裡不畫新平面、不新增擺設，也不開放試走。</p>' : `<p>先點一個來源站位作為試走起點，再點其他站位。</p><div class="camp-nodes" role="group" aria-label="來源可走站位">${scene.nodes.map(n => button('move', n.id, n.id, !state.ready, n.id === state.nodeId)).join('')}</div><p class="camp-path">本次路徑：${state.lastPath.length ? state.lastPath.map(esc).join(' → ') : '尚未移動'}</p><h4>走近後再查看</h4><ul class="camp-hotspots">${scene.hotspots.map(h => `<li><strong>${esc(label(h))}</strong><br><small>站位 ${esc(h.node_id)}</small><div class="pi-controls">${button('approach', '走近', h.id, !state.ready || !state.nodeId)}${button('inspect', '查看', h.id, !state.ready || state.nodeId !== h.node_id)}</div></li>`).join('')}</ul>`}${detail}<output class="pi-status" role="status" aria-live="polite" aria-atomic="true">${esc(message)}</output></article><aside class="pi-journal"><details class="pi-art"${artOpen ? ' open' : ''}><summary>對照原 AI 場景圖</summary>${frame}<p><small>完整保留原圖。歷史點位與連通資料不是這張圖的像素對齊，也不是核准的新布局。</small></p></details><details><summary>正式進入條件／尚未接入</summary><p>${esc(scene.unlock_rule)}</p><p>切換此處預覽不會授予這些條件。</p></details><h4>本時間線查看紀錄</h4><ol class="camp-journal">${state.inspected.map(id => `<li>${esc(id)}</li>`).join('') || '<li>尚未查看</li>'}</ol><p>背包：0；筆記：0。沒有發分數、好感或物品。</p><p>一般場景返回總覽、出差回程與終局入口的正式流程留待後續串接，不由這個預覽代替。</p></aside></div>`;
        if (focusKey) {
          const same = [...host.querySelectorAll('[data-camp-key]')].find(el => el.dataset.campKey === focusKey);
          const target = changedScene || !same || same.disabled ? host.querySelector('#campStageTitle') : same;
          target.focus({ preventScroll: true }); target.scrollIntoView({ block: 'nearest' });
        }
      }
      function ownerChanged() {
        if(options.preview)return;
        const owner = window.FraudPlanInteraction?.getSnapshot?.();
        const next = model.syncOwner(state, owner);
        if (next !== state) { state = next; message = state.ready ? '可以選試走場景了。' : '先完成 T02 的安置。'; render(); }
      }
      host.addEventListener('click', event => {
        const control = event.target.closest('[data-camp-action]');
        if (!control || !host.contains(control) || control.disabled) return;
        const result = model.transition(state, { type: control.dataset.campAction, value: control.dataset.campValue, scene: state.sceneId }, data);
        state = result.state; message = result.message;if(result.changed){commands.push({type:control.dataset.campAction,value:control.dataset.campValue,scene:state.sceneId});options.onState?.(commands.slice(),model.snapshot(state));}render(control.dataset.campKey);
      });
      host.addEventListener('change', event => {
        if (event.target.id !== 'campSceneSelect') return;
        const result = model.transition(state, { type: 'preview-scene', value: event.target.value }, data);
        state = result.state; message = result.message;if(result.changed){commands.push({type:'preview-scene',value:event.target.value,scene:state.sceneId});options.onState?.(commands.slice(),model.snapshot(state));}render('scene-change', true);
      });
      window.addEventListener('fraud-plan-preview-change', ownerChanged);
      const hashChanged=()=>render();window.addEventListener('hashchange',hashChanged);
      window.FraudCampInteraction = Object.freeze({ getSnapshot: () => model.snapshot(state), getScope: () => ({ batch: 'B02-routes', scenePreviews: 10, routableScenes: 9, acquisitionImplemented: false, formalSceneAccess: false, wholePlanComplete: false }), dispose(){window.removeEventListener('fraud-plan-preview-change',ownerChanged);window.removeEventListener('hashchange',hashChanged);} });
      ownerChanged(); render();options.onState?.(commands.slice(),model.snapshot(state));return window.FraudCampInteraction;
    } catch (error) { host.textContent = '園區互動尚未載入，進度沒有改變。' + error.message; }
  }
  window.FraudCampInteractionMount=boot;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
