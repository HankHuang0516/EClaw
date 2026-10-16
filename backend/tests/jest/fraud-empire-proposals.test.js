const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const root = path.resolve(__dirname, '../../public/AiHankApps/projects/fraud-empire');
const model = require(path.join(root, 'proposal-model.js'));
const bundle = JSON.parse(fs.readFileSync(path.join(root, 'dialogue-proposals.json'), 'utf8'));
const art = JSON.parse(fs.readFileSync(path.join(root, 'art-catalog.json'), 'utf8'));
const index = model.makeIndex(bundle);
const entry = id => bundle.entries.find(e => e.id === id);

describe('Fraud Empire proposed dialogue, expressions and connected presentation', () => {
  test('preserves original IDs with exact proposed patches and 120 supplied supervisor lines', () => {
    expect(bundle.lines).toHaveLength(1885);
    expect(index.size).toBe(1885);
    const digest = crypto.createHash('sha256').update(JSON.stringify(bundle.lines.map(l => [l.stable_id, l.speaker_id, l.expression, l.text]).sort((a, b) => a[0].localeCompare(b[0])))).digest('hex');
    expect(digest).toBe('01f6bbd418a80e552ffd436d7d7943636a2367ace3eaa65aa73f2b3e1afa110c');
    const referenced = new Set(bundle.entries.flatMap(e => model.groupsFor(e, index).flatMap(g => g.lines.map(l => l.stable_id))));
    expect(referenced.size).toBe(1885);
    expect(bundle.entries.filter(e => e.kind === 'gameplay_step')).toHaveLength(112);
    expect(bundle.entries).toHaveLength(259);
  });
  test('keeps system prompts separate and preserves every required variant family', () => {
    for (const e of bundle.entries) for (const group of model.groupsFor(e, index)) expect(group.system).toBe(group.lines.every(l => l.speaker_id === 'system'));
    const serialized = JSON.stringify(bundle.entries);
    for (const field of ['context_variants', 'response_variants', 'repair_dialogue', 'commit_dialogue', 'middle', 'photo_variants']) expect(serialized).toContain('"' + field + '"');
    expect(bundle.entries.some(e => e.kind === 'pending' && e.sourceId === 'T17')).toBe(true);
  });
  test('IT01 uses exactly one present/absent timeline and no invented owner', () => {
    const e = entry('IT01');
    expect(model.queueFor(e, index, {}).needsContext).toBe(true);
    expect(model.queueFor(e, index, { contextIndex: 999 }).needsContext).toBe(true);
    const absent = model.queueFor(e, index, { contextIndex: 1, choiceIndex: 0 }).lines;
    const present = model.queueFor(e, index, { contextIndex: 0, choiceIndex: 0 }).lines;
    expect(absent.some(l => l.speaker_id === 'kai' || l.speaker_id === 'role_owner')).toBe(false);
    expect(absent.some(l => l.stable_id === 'IT01.context.absent.01')).toBe(true);
    expect(present.some(l => l.stable_id === 'IT01.context.present.02')).toBe(true);
    expect(present.some(l => l.stable_id.includes('.absent.'))).toBe(false);
    expect(art.portraits.some(p => p.aliases.includes('role_owner'))).toBe(false);
    expect(model.portraitFor(art.portraits, 'role_owner', 'neutral').kind).toBe('unavailable');
  });
  test('commit, repair and mutually exclusive photos are never automatically conflated', () => {
    expect(model.queueFor(entry('MS12'), index, { choiceIndex: 1 }).needsConfirm).toBe(true);
    expect(model.queueFor(entry('MS12'), index, { choiceIndex: 1, confirmed: true }).lines.some(l => l.stage === 'commit')).toBe(true);
    expect(model.queueFor(entry('ROM03'), index, { repair: true }).lines.every(l => l.stage === 'repair')).toBe(true);
    const e = entry('E_ESCAPE__xiaoyu');
    expect(model.queueFor(e, index, {}).needsPhoto).toBe(true);
    for (const variant of ['has', 'absent']) {
      const lines = model.queueFor(e, index, { photoVariant: variant }).lines.filter(l => l.stage === 'photo');
      expect(lines).toHaveLength(1);
      expect(lines[0].stable_id).toContain('.photo.' + variant + '.');
    }
  });
  test('deferred Lin intimacy cannot play; ordinary rest remains distinct', () => {
    const e = entry('BR34');
    expect(e.structure.deferred_variants[0].demo_playable).toBe(false);
    expect(e.structure.deferred_variants[0].lines).toBeUndefined();
    const groups = model.groupsFor(e, index, true);
    expect(groups.some(g => g.lines.some(l => /BR34_lin_consent|BR34_lin_nextday/.test(l.stable_id)))).toBe(false);
    const ordinary = model.queueFor(e, index, { choiceIndex: 0, responseVariant: 'BR34_lin_companionship' });
    expect(ordinary.lines.some(l => l.stable_id === 'BR34.companionship_lin.BR34_C01.01')).toBe(true);
    expect(model.queueFor(e, index, { choiceIndex: 1, responseVariant: 'BR34_lin_companionship' }).variantConflict).toBe(true);
  });
  test('H001 is one identity and remains faceless before explicit reveal; unknown faces stay proposals', () => {
    const hidden = model.portraitFor(art.portraits, 'H001', 'neutral');
    expect(hidden.kind).toBe('anonymous');
    expect(hidden.cell).toBeUndefined();
    expect(model.portraitFor(art.portraits, 'tang', 'neutral', { revealed: true }).kind).toBe('image');
    expect(art.portraits.filter(p => p.id === 'tang')).toHaveLength(1);
    for (const id of ['role_boss', 'role_aid_operator', 'role_police', 'SPK-DUO-NA']) expect(model.portraitFor(art.portraits, id, 'neutral').kind).toBe('proposal-only');
  });
  test('replay retains the first choice and unavailable T17 media never becomes a win', () => {
    const first = model.rememberChoice(null, 0); const replay = model.rememberChoice(first, 1);
    expect(replay).toEqual({ committed: 0, viewed: 1, replay: true });
    expect(model.mediaGuard({ topicId: 'T17', stepId: 'T17-S03', view: 'task' })).toBe(true);
    expect(model.mediaGuard({ topicId: 'T17', view: 'result' })).toBe(true);
    expect(model.mediaGuard({ topicId: 'T01', view: 'result' })).toBe(false);
    const pending = bundle.entries.find(e => e.kind === 'pending');
    expect(model.groupsFor(pending, index).flatMap(g => g.lines).every(l => l.speaker_id === 'system')).toBe(true);
  });
  test('keeps 283 records, 59 groups, 2640 uses, 280 cells and 8 original cards as separate counts', () => {
    expect(art.items).toHaveLength(283); expect(art.groups).toHaveLength(59);
    expect(art.items.every(item => typeof item.source_id === 'string' && item.source_id.length > 0)).toBe(true);
    expect(art.items.reduce((n, i) => n + i.requirements.length, 0)).toBe(2640);
    expect(art.portraits).toHaveLength(39);
    expect(art.portraits.filter(p => !p.functional).flatMap(p => p.cells)).toHaveLength(280);
    const functional = art.portraits.filter(p => p.functional); expect(functional).toHaveLength(4);
    expect(new Set(functional.map(p => p.cells[0].src)).size).toBe(1);
    expect(functional.every(p => p.cells[0].wholeReference)).toBe(true);
    const dona = art.portraits.find(p => p.id === 'SPK-DUO-NA');
    expect(dona.cells.every(c => Math.abs(c.width / c.height - 1) < 0.01)).toBe(true);
    expect(art.references).toHaveLength(8);
    expect(art.references.find(r => r.id === 'REF-CHAR-07').sourceSha256).toBe('704852a743095e5b1496f3aa0c551ec46b502c892cde61a9a6ed131e963d1ed3');
    expect(art.assets['ESC-S05-LIN'].src).toBe('images/760a8fa6fb9ea536ba60.webp');
    for (const p of art.portraits) for (const cell of p.cells) expect(fs.existsSync(path.join(root, cell.src))).toBe(true);
    for (const r of art.references) expect(fs.existsSync(path.join(root, r.src))).toBe(true);
  });
  test('pins the whole 654-asset release to exact content hashes', () => {
    const release = JSON.parse(fs.readFileSync(path.join(root, 'release.json'), 'utf8'));
    expect(release.version).toBe('v4.12-phone-voice-candidates-20261017-r1');
    expect(release.assets).toHaveLength(704);
    expect(new Set(release.assets.map(asset => asset.path)).size).toBe(704);
    expect(crypto.createHash('sha256').update(JSON.stringify(release.assets)).digest('hex')).toBe(release.contentHash);
    for (const asset of release.assets) {
      const bytes = fs.readFileSync(path.join(root, asset.path));
      expect(bytes.length).toBe(asset.bytes);
      expect(crypto.createHash('sha256').update(bytes).digest('hex')).toBe(asset.sha256);
    }
  });
  test('does not expose local paths or obsolete reference versions, mutate source data or add persistence', () => {
    const serialized = JSON.stringify({ bundle, art });
    expect(serialized).not.toMatch(/\/Users\/|\/Volumes\/|\/mnt\/data\/|Sentinel_|db3e04dc912e4d341a7dc3a707b6cb88dcf2a54ebb6676d1c212ae3734215e29/);
    const before = JSON.stringify(bundle); model.queueFor(entry('IT01'), index, { contextIndex: 1, choiceIndex: 0 }); expect(JSON.stringify(bundle)).toBe(before);
    const script = fs.readFileSync(path.join(root, 'proposals.js'), 'utf8');
    expect(script).not.toMatch(/localStorage|sessionStorage|indexedDB|sendBeacon|method\s*:\s*['"]POST/);
  });

  test('T02 remains a seven-part prologue, never a supervisor task or repeat reward', () => {
    const plan = JSON.parse(fs.readFileSync(path.join(root, 'plan.json'), 'utf8'));
    const t02 = plan.topics.find(t => t.id === 'T02');
    expect(t02.content_class).toBe('main_story_prologue');
    expect(t02.supervisor_pool_eligible).toBe(false);
    expect(t02.mode).toBeNull(); expect(t02.available_modes).toEqual([]);
    expect(t02.base_score).toBe(0); expect(t02.steps).toHaveLength(7);
    expect(t02.repeat_policy).toBe('once_per_timeline; replay_read_only');
    expect(bundle.entries.filter(e => e.kind === 'prologue_step')).toHaveLength(7);
    expect(entry('T02-RESULT').kind).toBe('prologue_result');
    for (const rank of [1,2,3,4,5]) expect(model.supervisorEntryForContext(bundle, {view:'result',topicId:'T02',rank})).toBeNull();
    expect(plan.prologue.planning_scope).toContain('不是未來上限');
    expect(plan.prologue.pending).toHaveLength(4);
  });
  test('five exact ranks select only one supplied tone and never overwrite grave or topic results', () => {
    expect(bundle.originalLineCount).toBe(1765); expect(bundle.proposedTextPatchIds).toHaveLength(12);
    expect(bundle.entries.filter(e => e.kind === 'supervisor')).toHaveLength(40);
    expect(bundle.lines.filter(l => l.stable_id.startsWith('SUP-R'))).toHaveLength(120);
    for (const rank of [1,2,3,4,5]) for (const context of ['opening','assignment','selection','success','failure','rest','chat','promotion']) {
      const e = model.supervisorEntryForContext(bundle,{view:'supervisor',rank,supervisorContext:context});
      expect(e.id).toBe('SUP-R'+rank+'-'+context);
      const lines = model.queueFor(e,index).lines;
      expect(lines).toHaveLength(3);
      expect(lines.filter(l => l.speaker_id !== 'protagonist').every(l => l.speaker_id === (rank===1?'hou':'lin'))).toBe(true);
    }
    expect(model.entryForContext(bundle,{view:'dispatch',rank:5}).id).toBe('SUP-R5-assignment');
    expect(model.entryForContext(bundle,{view:'tasks',rank:2}).id).toBe('SUP-R2-selection');
    expect(model.supervisorEntryForContext(bundle,{view:'supervisor',rank:6,supervisorContext:'chat'})).toBeNull();
    expect(model.entryForContext(bundle,{view:'story',eventId:'MS05',rank:5}).id).toBe('MS05');
    expect(model.entryForContext(bundle,{view:'result',topicId:'T16',rank:5}).id).toBe('T16-RESULT');
  });
});
