(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FraudRelationshipModel = factory();
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const clone = value => JSON.parse(JSON.stringify(value));
  const kinds = { main: '主線', main_event: '主線', branch: '支線', romance: '關係事件', intel: '情報', item: '道具', ending: '結局', main_prologue: '一次性序章', prologue_segment: '序章分段', gameplay_step: '舊玩法步驟', legacy_theme: '舊題材來源' };
  function validate(data, enrichment, corrections) {
    if (!data || data.nodes?.length !== 39 || data.edges?.length !== 55 || Object.keys(data.events || {}).length !== 214) return false;
    const ids = new Set(data.nodes.map(node => node.id));
    if (ids.size !== 39 || data.edges.some(edge => !ids.has(edge.from) || !ids.has(edge.to))) return false;
    const leaves = data.navigation_tree?.groups?.flatMap(group => group.children.map(child => child.node_ref)) || [];
    if (leaves.length !== 39 || new Set(leaves).size !== 39 || leaves.some(id => !ids.has(id))) return false;
    if (Object.values(data.alias_index || {}).some(id => !ids.has(id))) return false;
    if (data.alias_index.H001 !== 'tang' || data.alias_index.role_owner !== 'kai') return false;
    if (enrichment && (enrichment.arcs?.length !== 10 || enrichment.arcs.flatMap(arc => arc.scene_extensions.flatMap(scene => scene.lines)).length !== 111 || enrichment.new_optional_branches?.length !== 3 || enrichment.new_optional_branches.some(branch => branch.canonical !== false))) return false;
    if (corrections && corrections.corrections?.length !== 28) return false;
    return true;
  }
  function makeIndex(data) {
    return { data, nodes: new Map(data.nodes.map(node => [node.id, node])), edges: new Map(data.edges.map(edge => [edge.id, edge])), events: new Map(Object.entries(data.events)), aliases: new Map(Object.entries(data.alias_index)) };
  }
  function resolve(index, alias) { return index.nodes.get(index.aliases.get(alias) || alias) || null; }
  function label(node, spoilers = false) { return node.id === 'tang' && !spoilers ? '匿名回聲 H001' : node.name; }
  function visibleNode(node, spoilers = false) {
    return { id: node.id, name: label(node, spoilers), functional: node.entity_type === 'anonymous_account_role', anonymous: node.id === 'tang' && !spoilers, cell: node.id === 'tang' && !spoilers || node.entity_type === 'anonymous_account_role' ? null : node.display_cell, age: node.age };
  }
  function nodeMatches(node, query, spoilers = false) {
    const q = query.trim().toLocaleLowerCase();
    const terms = node.id === 'tang' && !spoilers ? ['匿名回聲', 'H001'] : [node.name, node.id, ...node.aliases];
    return !q || terms.join(' ').toLocaleLowerCase().includes(q);
  }
  function eventLabel(event, spoilers = false) { return spoilers ? event.id + ' · ' + event.title : event.id + ' · ' + (kinds[event.category] || '事件來源') + '（詳情含劇透）'; }
  function eventMatches(event, query, spoilers = false) {
    const safe = spoilers ? eventLabel(event, true) + ' ' + (event.linked_character_ids || []).join(' ') : event.id;
    return !query.trim() || safe.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  }
  function conditionGroups(event) {
    const source = event.trigger?.conditions;
    return { sourceOnly: source == null, all: clone(source?.all || []), any: clone(source?.any || []), not: clone(source?.not || []), emptyAnyMeans: '沒有額外 OR 限制；不是永遠不能觸發。', evaluateEligibility: false };
  }
  function choiceResult(choice) { return choice.consequence || '來源尚未逐項指定本選項結果；不能套用整個事件獎勵。'; }
  function nodeEvents(index, nodeId) {
    return (index.nodes.get(nodeId)?.linked_event_ids || []).map(id => index.events.get(id)).filter(Boolean);
  }
  function nodeEdges(index, nodeId) { return index.data.edges.filter(edge => edge.from === nodeId || edge.to === nodeId); }
  function edgeLabel(index, edge, spoilers = false) {
    if (spoilers) return edge.label;
    if (edge.from === 'tang' || edge.to === 'tang') return '匿名聯絡；完整關聯尚未揭露';
    return index.data.legend[edge.relation_class] || '既有來源關聯';
  }
  function variantText(line, selection) {
    const presentation = line.presentation_variants;
    if (!presentation) return line.text;
    return presentation.variants.find(variant => variant.id === selection)?.text || null;
  }
  function timelineLines(bundle, timeline) {
    if (!['present', 'absent'].includes(timeline)) return [];
    return bundle.lines.filter(line => line.stable_id.startsWith('IT01.context.' + timeline + '.'));
  }
  return { clone, validate, makeIndex, resolve, label, visibleNode, nodeMatches, eventLabel, eventMatches, conditionGroups, choiceResult, nodeEvents, nodeEdges, edgeLabel, variantText, timelineLines };
});
