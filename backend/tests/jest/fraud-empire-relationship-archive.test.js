const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.join(__dirname, '../../public/AiHankApps/projects/fraud-empire');
const model = require(path.join(root, 'relationship-model.js'));
const read = name => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
const data = read('relationship-data.json'), enrichment = read('branch-enrichment-proposals.json'), corrections = read('branch-logic-corrections.json'), bundle = read('dialogue-proposals.json'), plan = read('plan.json');
const index = model.makeIndex(data);
const prototypeHashes = [
  {
    "path": "interactive-prototype-data.json",
    "sha256": "53cb2eaa02bbd2003c6566e1d42f0b088771342950290e25fc9ded020ec8bbea"
  },
  {
    "path": "interactive-prototype-model.js",
    "sha256": "71f3d926baf1478e3f5c55ae0f583d30947a2b91ff049982974456cf8888a268"
  },
  {
    "path": "interactive-prototype.css",
    "sha256": "cb5173b8d8c14e6c054831ba1733f7d5457d5c3c7d29c1db32f28f1816f312f3"
  },
  {
    "path": "interactive-prototype.js",
    "sha256": "6a5c8b876ab108cba0897d6b19b42441e1fb634f9517317d14ddeb766c756c29"
  },
  {
    "path": "proposal-demos/17727e3739a457a26aa6.png",
    "sha256": "17727e3739a457a26aa6f905da5c3a75fab09c1d974d3d4f7b86bf8eb55d0888"
  },
  {
    "path": "proposal-demos/354d7dfb83e67cc0fe8f.png",
    "sha256": "354d7dfb83e67cc0fe8f43f83fe74da6943e935bd5c2dd7b5e5d356d02bbb7ce"
  },
  {
    "path": "proposal-demos/5feaace11e62f93d06d1.png",
    "sha256": "5feaace11e62f93d06d1832c4ca5da0323b017caa33d6e80ffb3b428354c4417"
  },
  {
    "path": "proposal-demos/70c7a29e9c144633ddbd.png",
    "sha256": "70c7a29e9c144633ddbda2a1d7d87b2c8e6d6a880a822a406ee192104c6f074b"
  },
  {
    "path": "proposal-demos/8194977330733cfdc9fb.png",
    "sha256": "8194977330733cfdc9fbed67ab0af838108e823b6328688b148be5cb67906a91"
  },
  {
    "path": "proposal-demos/c6ff98fce82e920bb3c6.png",
    "sha256": "c6ff98fce82e920bb3c6e60bed619f29676b1d55b7db1c2f8c02bea407eea62b"
  }
];


// B04 may add only these exact, position-bound bridges and their lint declaration.
// Undo them solely for comparison with the unchanged historical UI digest.
const approvedPrototypeBridgePatches = [
  {
    "name": "CustomEvent lint declaration",
    "after": "/* global document, window, fetch, Image, MutationObserver, performance, CustomEvent */",
    "before": "/* global document, window, fetch, Image, MutationObserver, performance */"
  },
  {
    "name": "allowlisted opener at existing entry boundary",
    "after": "  function enter(id) { if (!states) return; if (id && states[id]) game = id; entering = true; document.getElementById('demoEnter').click(); entering = false; show(); panel.querySelector('select')?.focus({ preventScroll: true }); panel.scrollIntoView({ block: 'start' }); }\n  document.addEventListener('fraud:interactive-open', event => { if (['MG-P01', 'MG-P02'].includes(event.detail?.game)) enter(event.detail.game); });\n  document.getElementById('demoEnter').addEventListener('click', () => { if (!entering) leave(); });",
    "before": "  function enter(id) { if (!states) return; if (id && states[id]) game = id; entering = true; document.getElementById('demoEnter').click(); entering = false; show(); panel.querySelector('select')?.focus({ preventScroll: true }); panel.scrollIntoView({ block: 'start' }); }\n  document.getElementById('demoEnter').addEventListener('click', () => { if (!entering) leave(); });"
  },
  {
    "name": "ready event after readonly snapshot publication",
    "after": "    document.documentElement.dataset.interactiveReady = 'true';\n    document.dispatchEvent(new CustomEvent('fraud:interactive-ready'));\n  }).catch(() => { loadNote.textContent = '互動原型資料或美術未能完整載入，不以空白或換圖冒稱可玩；原有六圖參考與閱讀仍可使用。'; loadNote.setAttribute('role', 'alert'); document.documentElement.dataset.interactiveReady = 'false'; });",
    "before": "    document.documentElement.dataset.interactiveReady = 'true';\n  }).catch(() => { loadNote.textContent = '互動原型資料或美術未能完整載入，不以空白或換圖冒稱可玩；原有六圖參考與閱讀仍可使用。'; loadNote.setAttribute('role', 'alert'); document.documentElement.dataset.interactiveReady = 'false'; });"
  }
];
function assertPreservedPrototypeAsset(asset, bytes) {
  let original = bytes;
  if (asset.path === 'interactive-prototype.js') {
    let text = bytes.toString('utf8');
    for (const patch of approvedPrototypeBridgePatches) {
      if (text.split(patch.after).length !== 2) throw new Error('Unexpected prototype bridge: ' + patch.name);
      text = text.replace(patch.after, patch.before);
    }
    original = Buffer.from(text, 'utf8');
  }
  if (crypto.createHash('sha256').update(original).digest('hex') !== asset.sha256) {
    throw new Error('Unexpected preserved prototype change: ' + asset.path);
  }
}

describe('fraud empire relationship archive and branch editorial integration', () => {
  test('keeps 39 canonical identities, 55 graph edges and 214 source events with no dangling references', () => {
    expect(model.validate(data, enrichment, corrections)).toBe(true);
    expect(index.nodes.size).toBe(39); expect(index.edges.size).toBe(55); expect(index.events.size).toBe(214);
    for (const node of data.nodes) { for (const id of node.linked_event_ids) expect(index.events.has(id)).toBe(true); for (const id of node.relationship_edge_ids) expect(index.edges.has(id)).toBe(true); }
    for (const edge of data.edges) { expect(index.nodes.has(edge.from)).toBe(true); expect(index.nodes.has(edge.to)).toBe(true); for (const id of edge.linked_event_ids) expect(index.events.has(id)).toBe(true); }
    expect(new Set(data.navigation_tree.groups.flatMap(group => group.children.map(child => child.node_ref))).size).toBe(39);
  });
  test('H001 and Tang remain one identity, the postcard owner is Kai, and functional aliases never get human faces', () => {
    expect(model.resolve(index, 'H001')).toBe(model.resolve(index, 'tang'));
    expect(model.resolve(index, 'SPK-TANG-CHENG').id).toBe('tang'); expect(model.resolve(index, 'role_owner').id).toBe('kai');
    const functional = data.nodes.filter(node => node.entity_type === 'anonymous_account_role'); expect(functional).toHaveLength(4);
    expect(functional.every(node => model.visibleNode(node, true).cell === null)).toBe(true);
  });
  test('default projections and search do not reveal Tang, hidden outcomes or face alt text', () => {
    const tang = index.nodes.get('tang'); expect(model.label(tang)).toBe('匿名回聲 H001'); expect(model.visibleNode(tang).cell).toBeNull();
    expect(model.nodeMatches(tang, '唐澄')).toBe(false); expect(model.nodeMatches(tang, 'H001')).toBe(true); expect(model.nodeMatches(tang, '唐澄', true)).toBe(true);
    expect(model.visibleNode(tang, true).cell.src).toMatch(/^portraits\//);
    const serialized = JSON.stringify({ person: model.visibleNode(tang), edges: model.nodeEdges(index, 'tang').map(edge => model.edgeLabel(index, edge)), event: model.eventLabel(data.events.I01) });
    expect(serialized).not.toMatch(/唐澄|tang_expressions|自願署名/);
    expect(model.eventMatches(data.events.I01, '唐澄')).toBe(false);
  });
  test('preserves every original trigger and the exact ALL / ANY / NOT distinction without evaluating eligibility', () => {
    const digest = crypto.createHash('sha256').update(JSON.stringify(Object.entries(data.events).map(([id,event])=>[id,event.trigger]))).digest('hex');
    expect(digest).toBe('ce46645447255b2fc9e4e55c7b2d770c041ef364ce1744c58fde0fefa851f574');
    const br07 = model.conditionGroups(data.events.BR07); expect(br07.all).toContain('day>=12'); expect(br07.all).toContain('rank>=3'); expect(br07.any).toEqual(['F_lin>=35','wisdom>=45']); expect(br07.not).toEqual(['finale_committed']); expect(br07.evaluateEligibility).toBe(false);
    expect(model.conditionGroups(data.events.BR35).any).toEqual([]); expect(model.conditionGroups(data.events.BR35).emptyAnyMeans).toContain('沒有額外 OR');
    expect(model.conditionGroups(data.events.IT01).sourceOnly).toBe(true);
  });
  test('does not apply whole-event rewards to unspecified choices or unblock deferred Lin intimacy', () => {
    expect(model.choiceResult({id:'unknown'})).toContain('不能套用整個事件獎勵');
    expect(data.events.BR34.choices.find(choice=>choice.id==='BR34_C01').label).toBe('普通休息');
    expect(data.events.BR34.pending_variants.find(variant=>variant.id==='BR34_lin_intimacy_pending').playable).toBe(false);
    expect(data.events.BR34.presentation_variants.some(variant=>variant.id==='BR34_lin_companionship')).toBe(true);
  });
  test('keeps IT01 present and absent dialogue in exclusive, disjoint timelines', () => {
    const present=model.timelineLines(bundle,'present'), absent=model.timelineLines(bundle,'absent'); expect(present.length).toBeGreaterThan(0); expect(absent.length).toBeGreaterThan(0);
    expect(model.timelineLines(bundle,null)).toEqual([]); expect(absent.some(line=>['kai','role_owner'].includes(line.speaker_id))).toBe(false);
    expect(present.every(line=>!absent.some(other=>other.stable_id===line.stable_id))).toBe(true);
  });
  test('keeps all 10 arcs / 111 supplied proposal lines outside the original 1885-line pool and 3 new branches unadopted', () => {
    const lines=enrichment.arcs.flatMap(arc=>arc.scene_extensions.flatMap(scene=>scene.lines)); expect(lines).toHaveLength(111); expect(new Set(lines.map(line=>line.stable_id)).size).toBe(111);
    expect(bundle.lines).toHaveLength(1885); expect(bundle.entries).toHaveLength(259); expect(bundle.lines.some(line=>line.stable_id.startsWith('ENR-'))).toBe(false);
    for(const arc of enrichment.arcs)for(const id of arc.event_ids)expect(index.events.has(id)).toBe(true);
    expect(enrichment.new_optional_branches).toHaveLength(3); for(const branch of enrichment.new_optional_branches){expect(branch.canonical).toBe(false);expect(branch.rewards).toBeNull();expect(branch.duration_minutes).toBeNull();expect(index.events.has(branch.id)).toBe(false);expect(plan.narrative.branches.some(event=>event.id===branch.id)).toBe(false);}
  });
  test('integrates 25 verified text revisions without copying the private frozen narrative into public schema', () => {
    expect(data.website_revision.matched_text_revisions).toBe(25); expect(data.website_revision.deferred_text_revisions).toBe(0); expect(data.website_revision.mechanics_changed).toBe(false); expect(data.website_revision.deferred_reason).toBeUndefined();
    expect(corrections.corrections).toHaveLength(28); expect(corrections.corrections.find(item=>item.id==='LOG-23').website_integration).toContain('已核對'); expect(corrections.corrections.find(item=>item.id==='LOG-23').revision_direction).toBe("只培養T13可完成援助：初始智慧10先依學習規則達T13所需25，R2起正常派工建立帳號並累積S13>=10（每日同類上限6，至少跨兩日）；D10/R3/MS07及T13帳號俱備才觸發MS08。四主題各15，或任一主題後BR29每日5至60，再依MS09/MS10及原日期條件取得電話與安排逃離。不需智慧40或T14，不保證D12已完成。"); expect(plan.topics.find(topic=>topic.id==='T13').wisdom_min).toBe(25); expect(plan.topics.find(topic=>topic.id==='T13').rank_min).toBe(2);
    expect(plan.narrative.reachability_checks).toBeUndefined();
    const publicData=JSON.stringify({data,enrichment,corrections,bundle});expect(publicData).not.toMatch(/branch_logic_exact_patches|integration_only_do_not_publish|"expected_old"|"proposed_new"|"json_pointer"|\/Users\/|\/Volumes\//);
  });
  test('synchronizes corrected narrative, map, chapter and dialogue snapshots without changing conditions', () => {
    expect(plan.narrative.branches.find(event=>event.id==='BR07').miss_recovery).toBe(data.events.BR07.recovery); expect(data.events.BR07.recovery).toContain('ESC-S06');
    expect(plan.narrative.intel[0].use).toBe(data.events.I01.outcome); expect(data.events.I01.outcome).toContain('非MS09援助硬門檻');
    expect(plan.maps.scenes[3].hotspots[0].acquisition[0].repeat).toContain('確認兌換後消耗');
    expect(plan.narrative.branches.find(event=>event.id==='BR35').repeat).toBe(data.events.BR35.repeat); expect(data.events.BR36.repeat).toContain('餘額0再訪不扣錢');
    expect(bundle.entries.find(event=>event.id==='BR29').structure.source_snapshot.dialogue_and_actions).toBe(plan.narrative.branches.find(event=>event.id==='BR29').dialogue_and_actions);
    expect(plan.chapters.find(chapter=>chapter.id==='narrative').content_markdown).toContain('上次的話');
    expect(bundle.lines.find(line=>line.stable_id==='I07.opening.base.01').text).toBe('這是資料裡那個援助標誌。先記住它的樣子。');
  });
  test('conditional text requires an explicit exclusive presentation and never writes a formal flag', () => {
    const lines=bundle.lines.filter(line=>line.presentation_variants);expect(lines).toHaveLength(4);
    for(const line of lines){expect(model.variantText(line,undefined)).toBeNull();expect(line.presentation_variants.exclusive).toBe(true);expect(line.presentation_variants.formalStateMutation).toBe(false);for(const variant of line.presentation_variants.variants)expect(model.variantText(line,variant.id)).toBe(variant.text);}
    const br30=lines.filter(line=>line.source_event==='BR30');expect(br30).toHaveLength(2);expect(new Set(br30.map(line=>line.presentation_variants.group)).size).toBe(1);
    expect(model.variantText(br30[0],'not_ready')).not.toContain('電話');
    const lin=lines.find(line=>line.stable_id==='E_BOSS__lin.closing.base.01');expect(model.variantText(lin,'no_date')).not.toContain('日期過了');
    const xiaoyu=lines.find(line=>line.stable_id==='E_BOSS__xiaoyu.opening.base.01');expect(model.variantText(xiaoyu,'no_photo')).not.toContain('合照');
  });
  test('keeps T02 a one-time prologue and supplies actual core/dialogue navigation references', () => {
    expect(data.events.T02.category).toBe('main_prologue');expect(data.events.T02.supervisor_pool_eligible).toBe(false);
    expect(plan.topics.find(topic=>topic.id==='T02').mode).toBeNull();expect(plan.topics.find(topic=>topic.id==='T02').supervisor_pool_eligible).toBe(false);
    for(const id of Object.keys(data.events))expect(data.core_links[id]).toBeDefined();
    const ids=new Set(bundle.entries.map(entry=>entry.id));for(const links of Object.values(data.dialogue_links))for(const link of links)expect(ids.has(link.id)).toBe(true);
  });
  test('preserves v4.3 prototype bytes except the exact approved B04 bridges and retains all six exact PNGs', () => {
    expect(prototypeHashes).toHaveLength(10);for(const asset of prototypeHashes){assertPreservedPrototypeAsset(asset,fs.readFileSync(path.join(root,asset.path)));}
    const ui=fs.readFileSync(path.join(root,'relationship-archive.js'),'utf8');expect(ui).not.toMatch(/localStorage|sessionStorage|indexedDB|sendBeacon|method\s*:\s*['"]POST|eval\(/);
  });
  test.each([
    ['unrelated UI body change', text => text.replace('function enter(id)', 'function enter(unexpectedId)')],
    ['extra UI content', text => text + '\n// unauthorized UI change'],
    ['broadened opener allowlist', text => text.replace("['MG-P01', 'MG-P02']", "['MG-P01', 'MG-P02', 'MG-P03']")],
    ['missing opener', text => text.replace(approvedPrototypeBridgePatches[1].after, approvedPrototypeBridgePatches[1].before)],
    ['missing ready event', text => text.replace(approvedPrototypeBridgePatches[2].after, approvedPrototypeBridgePatches[2].before)],
    ['duplicate opener', text => text + '\n' + approvedPrototypeBridgePatches[1].after],
    ['duplicate ready event', text => text + '\n' + approvedPrototypeBridgePatches[2].after],
    ['moved opener', text => text.replace(approvedPrototypeBridgePatches[1].after, approvedPrototypeBridgePatches[1].before) + '\n' + approvedPrototypeBridgePatches[1].after.split('\n')[1]],
    ['moved ready event', text => text.replace(approvedPrototypeBridgePatches[2].after, approvedPrototypeBridgePatches[2].before) + '\n' + approvedPrototypeBridgePatches[2].after.split('\n')[1]],
    ['unapproved globals', text => text.replace(approvedPrototypeBridgePatches[0].after, approvedPrototypeBridgePatches[0].after.replace('CustomEvent', 'CustomEvent, UnapprovedGlobal'))],
  ])('rejects %s rather than weakening the original UI guard', (_name, mutate) => {
    const asset = prototypeHashes.find(item => item.path === 'interactive-prototype.js');
    const actual = fs.readFileSync(path.join(root, asset.path), 'utf8');
    const changed = mutate(actual);
    expect(changed).not.toBe(actual);
    expect(() => assertPreservedPrototypeAsset(asset, Buffer.from(changed, 'utf8'))).toThrow(/Unexpected/);
  });
  test.each(prototypeHashes.filter(asset => asset.path !== 'interactive-prototype.js'))('rejects changed preserved bytes in $path', asset => {
    const changed = Buffer.from(fs.readFileSync(path.join(root, asset.path)));
    changed[0] ^= 1;
    expect(() => assertPreservedPrototypeAsset(asset, changed)).toThrow(/Unexpected preserved prototype change/);
  });

});
