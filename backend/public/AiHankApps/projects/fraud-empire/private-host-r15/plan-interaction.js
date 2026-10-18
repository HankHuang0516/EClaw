/* global window, document, fetch */
(function () {
  'use strict';
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  async function boot(options = {}) {
    const host = options.host || document.getElementById('planInteractionHost');
    if (!host) return;
    try {
      let data=options.data,coverage=options.coverage;if(!data||!coverage){const responses=await Promise.all(['plan-interaction-data.json','interaction-coverage.json'].map(src=>fetch(src,{cache:'no-cache'})));if(responses.some(r=>!r.ok))throw Error('互動來源無法讀取');[data,coverage]=await Promise.all(responses.map(r=>r.json()));}
      const model = window.FraudPlanInteractionModel;
      if (!model || !model.validateData(data)) throw new Error('互動來源未通過完整性檢查');
      const commands=[];let state=model.createState();if(options.initialLog){if(!Array.isArray(options.initialLog)||options.initialLog.length>500)throw Error('invalid-preview-log');for(const command of options.initialLog){const out=model.transition(state,command,data);if(!out.changed)throw Error('incompatible-preview-log');state=out.state;commands.push(JSON.parse(JSON.stringify(command)));}}
      let message = options.preview ? (state.complete?'本預覽的七段操作已保存；未提交正式遊戲或獎勵。':commands.length?'已還原本段已保存的預覽操作；請接續畫面上的可用操作。':'先點門內站位。操作只保存在獨立流程預覽，不接正式遊戲資源。') : '先點門內站位。這是獨立的前端提案試玩，不接全局資源或正式存檔。';
      let artOpen = window.matchMedia('(min-width: 900px)').matches;
      const button = (type, label, value = '', options = {}) => `<button type="button" data-pi-action="${escape(type)}" data-pi-value="${escape(value)}" data-pi-key="${escape(type + ':' + value)}"${options.disabled ? ' disabled' : ''}${options.pressed === undefined ? '' : ` aria-pressed="${options.pressed}"`}${options.primary ? ' class="pi-primary"' : ''}>${label}</button>`;
      function controls() {
        if (state.mode === 'review') return `<p class="pi-state">只讀回顧 ${state.reviewIndex + 1}/7。原時間線不改寫，也不重播獎勵。</p><div class="pi-controls">${button('review-previous', '上一段回顧', '', { disabled: state.reviewIndex === 0 })}${button('review-next', '下一段回顧', '', { disabled: state.reviewIndex === 6 })}${button('review-exit', '返回完成紀錄')}</div>`;
        if (state.complete) return `<div class="pi-complete"><strong>T02 已在本時間線完成一次。</strong><br>自己的行李已安置，兩段記憶已保存；沒有睡眠效果或全局資源變動。</div><div class="pi-controls">${button('review-start', '回顧已完成序章', '', { primary: true })}${button('reset', '重開獨立提案試玩')}</div>`;
        let html = '';
        if (state.step === 0) html = `<div class="pi-rail" data-location="${state.location}" aria-label="主角站位操作示意"><span class="pi-actor">主角</span><span class="pi-outside">門外</span><span class="pi-inside">門內站位</span></div><p class="pi-caption">只示意站位改變，不代表新增場景布局。不可操作車或保全設備。</p><div class="pi-controls">${button('walk-inside', '門內站位', '', { pressed: state.location === 'inside' })}</div>`;
        if (state.step === 1) html = `<div class="pi-objects">${button('room-view', '住宿承諾', 'promise', { pressed: state.roomView === 'promise' })}${button('room-view', '眼前房間', 'reality', { pressed: state.roomView === 'reality' })}</div><p class="pi-state">${state.roomView === 'promise' ? '記憶：單人房。' : state.roomView === 'reality' ? '眼前：多人床位。' : '點兩個熱點可切換視角，不新增宿舍擺設或布局。'} 已查看 ${state.inspectedViews.length}/2；先看過兩處，兩種回應都可繼續。</p><div class="pi-controls">${button('room-response', '詢問住處', 'ask', { disabled: state.inspectedViews.length !== 2, pressed: state.roomChoice === 'ask' })}${button('room-response', '先沉默', 'silent', { disabled: state.inspectedViews.length !== 2, pressed: state.roomChoice === 'silent' })}</div>`;
        if (state.step === 2) html = `<div class="pi-objects">${button('bag-pick', '<span class="pi-bag" aria-hidden="true"></span> 自己的藍行李', 'blue', { pressed: state.bag !== 'floor' })}${button('bag-pick', '<span class="pi-bag pi-bag-red" aria-hidden="true"></span> 紅行李：他人所有', 'red')}</div><div class="pi-controls">${button('bag-place', '床邊：放置自己的行李', '', { pressed: state.bag === 'bedside' })}</div><p class="pi-state">自己的行李：${({ floor: '仍在地上', held: '已拿起，待放置', bedside: '已放到床邊' })[state.bag]}。這是操作托盤，不是宿舍平面圖。</p>`;
        if (state.step === 3) html = `<div class="pi-controls">${button('npc-approach', '小雨：走近對話', '', { pressed: state.npcApproached })}</div><p class="pi-state">小雨為成年角色（24 歲）。${state.npcApproached ? '已走近，可以選擇分享或保留個人細節。' : '先走近，對話還未開啟。'}</p><div class="pi-controls">${button('npc-response', '說出剛來', 'open', { disabled: !state.npcApproached, pressed: state.npcChoice === 'open' })}${button('npc-response', '暫不多談', 'private', { disabled: !state.npcApproached, pressed: state.npcChoice === 'private' })}</div>`;
        if (state.step === 4) html = `<div class="pi-controls">${button('exit-open', '出口：查看受困資訊')}${button('exit-return', '回床邊')}</div><p class="pi-state">${state.exitViewed ? '出口已查看。來源的短片尚未提供，沒有播放完成紀錄。' : '主角可退回床邊；不提供躲避、對抗或保全操作。'}${state.exitSkipped ? ' 已明確選擇略過演出並保留故事資訊。' : ''}</p><div class="pi-controls">${button('exit-skip', '略過壓迫演出，保留故事資訊', '', { pressed: state.exitSkipped })}</div><p>來源已允許略過；這不是替 T17 或 MG-P15 發明等價影片。此處不生成影片。</p>`;
        if (state.step === 5) html = `<div class="pi-objects">${button('memory-toggle', '到場記憶：自己走入門口', 'arrival', { pressed: state.selectedMemories.includes('arrival') })}${button('memory-toggle', '住宿記憶：承諾與眼前不同', 'room', { pressed: state.selectedMemories.includes('room') })}</div><p class="pi-state">已選 ${state.selectedMemories.length}/2；故事簿已保存 ${state.savedMemories.length}/2。</p><div class="pi-controls">${button('memory-save', '保存兩段已親歷記憶', '', { primary: true })}</div><p>只保留自己的經歷，不要求搜查他人或取得證件。</p>`;
        if (state.step === 6) html = `<p class="pi-state">自己的行李：已放置。到場與住宿記憶：已保存。完成安置不是小睡，不套睡眠恢復。</p><div class="pi-controls">${button('settle', '完成安置', '', { primary: true })}</div><p>來源把此動作列為 4 遊戲分鐘提案；本批不接全局時鐘、自然耗損或跨日。</p>`;
        if (state.step < 6) html += `<div class="pi-controls">${button('continue', '保存本段，進入下一段', '', { disabled: !model.canContinue(state), primary: true })}</div>`;
        return html;
      }
      function render(focusKey, previousStep) {
        const oldArt = host.querySelector('.pi-art');
        if (oldArt) artOpen = oldArt.open;
        const index = state.mode === 'review' ? state.reviewIndex : Math.min(state.step, 6);
        const step = data.steps[index];
        const image = /^images\/[a-f0-9]{20}\.webp$/.test(step.art.src) ? `<img src="${escape(step.art.src)}" alt="${escape(step.id + ' ' + step.title + ' 原AI示意圖')}" loading="lazy" width="${step.art.width}" height="${step.art.height}">` : '<p>素材未提供，不建立假圖片。</p>';
        host.innerHTML = `<p class="pi-notice">第一批只接入 <strong>1 個獨立序章、7 段互動</strong>，不是整份企劃已完成。原有兩款提案原型保留。${options.preview?'本入口會保存獨立預覽；可用本頁頂部的預覽保存／讀取按鈕，重新整理會還原已保存的操作，不改原遊戲存檔。':'重新整理會清除本批前端演示狀態；不是正式存檔。'}</p><div class="pi-hud" aria-label="本次前端演示狀態"><span>時間線 <b>${state.timeline}／獨立試玩</b></span><span>已保存進度 <b>${state.records.length}/7 段</b></span><span>本序章所得 <b>業績 0／XP 0／培養點 0</b></span></div><ol class="pi-steps" aria-label="T02七段互動進度">${data.steps.map((s, i) => `<li data-done="${state.records.includes(s.id)}"${i === index ? ' aria-current="step"' : ''}>${escape(s.id)}<br>${escape(s.title)}</li>`).join('')}</ol><div class="pi-workspace"><article class="pi-stage" aria-labelledby="planStageTitle"><h3 id="planStageTitle" tabindex="-1">${escape(step.title)}${state.mode === 'review' ? '／只讀回顧' : ''}</h3><p>${escape(step.action)}</p>${controls()}<output class="pi-status" role="status" aria-live="polite" aria-atomic="true">${escape(message)}</output></article><aside class="pi-journal" aria-label="來源與本次紀錄"><details class="pi-art"${artOpen ? ' open' : ''}><summary>對照原 AI 示意圖，不裁切</summary><figure>${image}<figcaption>${escape(step.art.status)}；互動托盤不是核准的新宿舍布局。</figcaption></figure></details><h4>本時間線的完成紀錄</h4><ol>${state.records.map(id => `<li>${escape(id)}</li>`).join('') || '<li>尚未保存段落</li>'}</ol><p>全局時間未接入；沒有套用心情、飽食或睡眠效果。</p><small>來源動作時間累計提案：${state.proposedActionMinutes} 分鐘。這不是已採納的全局耗時。</small></aside></div><details class="pi-coverage"><summary>完整企劃覆蓋與後續批次</summary><p>${coverage.totalRecords} 筆來源對照含 ${coverage.chapterHeadings} 筆章節標題、${coverage.legacySteps} 個舊步驟；不是已完成的功能數。</p><ol>${coverage.batches.map(b => `<li><strong>${escape(b.id + ' ' + b.name)}</strong>：${escape(b.scope)}<br>本批狀態：${escape(b.displayStatus || '尚未實作／未驗收，不標完成')}</li>`).join('')}</ol><p>新 17 款仍為提案；T02／T16 不加入派工池。智慧分段、正式解鎖門檻與 MG-P15 媒體替代未定。</p><a href="interaction-coverage.json" target="_blank" rel="noopener">查看來源覆蓋資料（企劃內容可能含劇透）</a></details>`;
        if (focusKey) {
          const same = [...host.querySelectorAll('[data-pi-key]')].find(el => el.dataset.piKey === focusKey);
          const target = previousStep === state.step && same && !same.disabled ? same : host.querySelector('#planStageTitle');
          target.focus({ preventScroll: true });
          target.scrollIntoView({ block: 'nearest' });
        }
      }
      host.addEventListener('click', event => {
        const control = event.target.closest('button[data-pi-action]');
        if (!control || !host.contains(control) || control.disabled) return;
        if (control.dataset.piAction === 'reset' && !window.confirm('重開一條獨立前端提案試玩？不會合併原時間線，並非正式存檔服務。')) return;
        const previousStep = state.step;
        const result = model.transition(state, { type: control.dataset.piAction, value: control.dataset.piValue, step: state.step }, data);
        state = result.state; message = result.message;if(result.changed){commands.push({type:control.dataset.piAction,value:control.dataset.piValue,step:previousStep});options.onState?.(commands.slice(),model.snapshot(state));}
        render(control.dataset.piKey, previousStep);
        window.dispatchEvent(new window.CustomEvent('fraud-plan-preview-change'));
      });
      window.FraudPlanInteraction = Object.freeze({ getSnapshot: () => model.snapshot(state), getScope: () => ({ module: 'T02', currentBatch: 'B01', fullPlanComplete: false, globalClockApplied: false, formalSaveService: false }) });
      render();options.onState?.(commands.slice(),model.snapshot(state));
      window.dispatchEvent(new window.CustomEvent('fraud-plan-preview-change'));return window.FraudPlanInteraction;
    } catch (error) {
      host.textContent = '互動來源載入失敗，未建立或改寫進度。' + error.message;
    }
  }
  window.FraudPlanInteractionMount=boot;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
