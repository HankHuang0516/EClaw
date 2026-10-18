/* Pure presentation helpers. No game state, persistence or rewards. */
((root, factory) => {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FraudProposalModel = api;
})(globalThis, () => {
  'use strict';
  const words = { opening: '開場', closing: '收束', middle: '中段', choices: '選項回應', lines: '角色台詞', states: '狀態提示', system_prompts: '系統提示', system_prompt: '系統提示', context_variants: '互斥時間線', response_variants: '指定回答情境', repair_dialogue: '修復對話', commit_dialogue: '明確確認', photo_variants: '互斥照片情境', outcome_lines: '結果情境', actions: '來源操作', pending_confirmations: '待確認', feedback: '回饋', unavailable: '尚未符合', later: '稍後', replay: '回顧', review: '回顧', success: '成功情境', failure: '失敗情境', failure_or_partial: '未完整完成情境', return: '返回情境' };
  function asText(value) {
    if (value === null || value === undefined) return '';
    if (Array.isArray(value)) return value.map(asText).join('；');
    if (typeof value === 'object') return Object.entries(value).map(([k, v]) => `${({ all: '同時符合', any: '至少一項', not: '不得存在', condition: '適用情境', quote: '來源說明', source_field: '來源欄位' })[k] || k}：${asText(v)}`).join('；');
    return String(value);
  }
  function makeIndex(bundle) { return new Map(bundle.lines.map(line => [line.stable_id, line])); }
  function groupsFor(entry, index, demo = false) {
    const groups = [];
    function walk(value, path = [], meta = {}, blocked = false) {
      if (Array.isArray(value)) {
        if (value.length && value.every(item => item && typeof item.lineRef === 'string')) {
          const buckets = new Map();
          for (const item of value) {
            const line = index.get(item.lineRef);
            if (!line) continue;
            const condition = asText(line.trigger || meta.condition);
            const photo = path.includes('photo_variants') ? (line.stable_id.includes('.photo.has.') ? '持有 IT08' : '沒有 IT08') : '';
            const key = `${line.stage || ''}|${condition}|${photo}|${line.speaker_id === 'system' ? 'system' : 'speech'}`;
            if (!buckets.has(key)) buckets.set(key, { lines: [], condition, photo, stage: line.stage });
            buckets.get(key).lines.push(line);
          }
          for (const bucket of buckets.values()) {
            if (demo && blocked) continue;
            const label = [meta.label, ...path.filter(x => typeof x === 'string' && words[x]).map(x => words[x]), words[bucket.stage] || '', bucket.photo].filter(Boolean).filter((v, i, arr) => arr.indexOf(v) === i).join('／');
            groups.push({ id: `${entry.id}:${path.join('.')}:${groups.length}`, label: label || '對話段落', path: path.join('.'), lines: bucket.lines, condition: bucket.condition, blocked, choiceId: meta.choiceId || bucket.lines[0].choice, variantId: meta.variantId, system: bucket.lines.every(line => line.speaker_id === 'system') });
          }
        } else value.forEach((item, i) => walk(item, path.concat(i), meta, blocked));
      } else if (value && typeof value === 'object') {
        if (value.lineRef) { walk([value], path, meta, blocked); return; }
        const next = { ...meta, condition: value.presentation_condition || value.context_note || value.trigger || meta.condition, label: value.label || (path.includes('response_variants') ? value.id : meta.label), choiceId: path.includes('choices') && value.id ? value.id : meta.choiceId, variantId: path.includes('response_variants') && value.id ? value.id : meta.variantId };
        for (const [key, item] of Object.entries(value)) walk(item, path.concat(key), next, blocked || value.demo_playable === false || path.includes('deferred_variants'));
      }
    }
    walk(entry.structure);
    return groups;
  }
  const refs = (value, index) => (Array.isArray(value) ? value : []).map(item => index.get(item.lineRef)).filter(Boolean);
  function queueFor(entry, index, options = {}) {
    const data = entry.structure;
    if (entry.kind === 'supervisor') return { lines: refs(data.lines, index), mode: '獨立職階語氣提案；不提交升階或結算' };
    if (options.repair) return { lines: refs(data.repair_dialogue, index), mode: '獨立修復情境；不新增遊戲旗標' };
    const queue = refs(data.opening, index);
    const contexts = data.context_variants || [];
    if (contexts.length && !contexts[options.contextIndex]) return { lines: queue, needsContext: true };
    if (contexts[options.contextIndex]) queue.push(...refs(contexts[options.contextIndex].lines, index));
    const choices = data.choices || [];
    const selected = choices[options.choiceIndex];
    if (choices.length && !selected) return { lines: queue, needsChoice: true };
    if (selected) queue.push(...refs(selected.lines, index));
    const response = (data.response_variants || []).find(item => item.id === options.responseVariant);
    if (response) {
      const rows = refs(response.lines, index);
      if (rows.some(line => line.choice && line.choice !== selected?.id)) return { lines: queue, variantConflict: true };
      queue.push(...rows);
    }
    const commit = refs(data.commit_dialogue, index).filter(line => !line.choice || line.choice === selected?.id);
    if (commit.length && !options.confirmed) return { lines: queue, needsConfirm: true };
    if (options.confirmed) queue.push(...commit);
    queue.push(...refs(data.middle, index));
    if ((data.photo_variants || []).length) {
      if (!['has', 'absent'].includes(options.photoVariant)) return { lines: queue, needsPhoto: true };
      queue.push(...refs(data.photo_variants, index).filter(line => line.stable_id.includes(`.photo.${options.photoVariant}.`)));
    }
    queue.push(...refs(data.closing, index));
    return { lines: queue };
  }
  function rememberChoice(previous, next) { return { committed: previous?.committed ?? next, viewed: next, replay: previous?.committed !== undefined && previous.committed !== next }; }
  function portraitFor(portraits, speaker, expression, options = {}) {
    if (['system', 'narrator'].includes(speaker)) return { kind: 'text', name: speaker === 'system' ? '系統提示' : '旁白' };
    const person = portraits.find(p => p.id === speaker || p.aliases.includes(speaker));
    if (!person || speaker === 'role_owner') return { kind: 'unavailable', name: '未指定身份', reason: '沒有可確認的角色映射，不借用其他人的臉。' };
    if (person.id === 'tang' && !options.revealed && !options.design) return { kind: 'anonymous', name: '匿名回聲 H001', person, reason: 'MS08 尚未揭露身份，不顯示真人表情。' };
    if (person.functional) return { kind: 'functional', name: person.name, person, reason: '功能化名不是角色臉；合圖未拆成獨立圖示。' };
    if (person.displayConditions.design_overview_only && !options.design) return { kind: 'proposal-only', name: person.name, person, reason: '新外觀僅供設計總覽預覽，未當成正式場景角色臉。' };
    const cell = person.cells.find(c => c.key === expression);
    if (!cell) return { kind: 'unavailable', name: person.name, person, reason: '來源表情尚未交付，不換成另一個表情冒充。' };
    return { kind: 'image', name: person.name, person, cell };
  }
  function entryForContext(bundle, context) {
    const supervisor = supervisorEntryForContext(bundle, context);
    if (supervisor) return supervisor;
    if (context.view === 'task') return bundle.entries.find(e => e.id === context.stepId);
    if (context.view === 'result') return bundle.entries.find(e => e.id === context.topicId + '-RESULT');
    if (!context.eventId) return null;
    const variant = context.group === 'endings' ? context.eventId + '__' + (context.companion || 'single') : context.eventId;
    return bundle.entries.find(e => e.id === variant);
  }
  function supervisorEntryForContext(bundle, context) {
    const slot = context.view === 'supervisor' ? context.supervisorContext : context.view === 'dispatch' ? 'assignment' : context.view === 'tasks' ? 'selection' : null;
    if (!slot || !Number.isInteger(context.rank) || context.rank < 1 || context.rank > 5) return null;
    return bundle.entries.find(e => e.kind === 'supervisor' && e.rank === context.rank && e.context === slot) || null;
  }
  function mediaGuard(context) { return context.topicId === 'T17' && (['T17-S03', 'T17-S05'].includes(context.stepId) || context.view === 'result'); }
  return { asText, makeIndex, groupsFor, queueFor, rememberChoice, portraitFor, entryForContext, supervisorEntryForContext, mediaGuard, words };
});
