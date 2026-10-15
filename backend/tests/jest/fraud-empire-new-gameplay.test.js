const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const root = path.resolve(__dirname, '../../public/AiHankApps/projects/fraud-empire');
const api = require(path.join(root, 'new-gameplay-proposals.js'));
const data = JSON.parse(fs.readFileSync(path.join(root, 'new-gameplay-proposals.json'), 'utf8'));

describe('Fraud Empire new 17 v2 proposals and six illustration-only previews', () => {
  test('retains all 17 complete proposals, six revisions and the unshortened source text', () => {
    expect(api.validate(data)).toBe(true);
    expect(data.plan.games.map(game => game.candidate_id)).toEqual(Array.from({ length: 17 }, (_, i) => 'MG-P' + String(i + 1).padStart(2, '0')));
    expect(data.plan.six_revisions).toHaveLength(6);
    expect(Buffer.byteLength(data.planMarkdown)).toBe(65822);
    expect(crypto.createHash('sha256').update(data.planMarkdown).digest('hex')).toBe(data.planMarkdownSha256);
    expect(data.plan.outside_minigame_count).toHaveLength(2);
    for (const game of data.plan.games) {
      expect(game.steps.length).toBeGreaterThan(0);
      expect(game.proposal_boundary).toBeTruthy();
      expect(game.balance_note).toContain('沒有另訂');
    }
  });
  test('renders every non-empty source line directly as safe readable HTML, not a summary', () => {
    const html = api.markdown(data.planMarkdown);
    expect((html.match(/data-new-candidate=/g) || [])).toHaveLength(17);
    for (const line of data.planMarkdown.split(/\r?\n/).filter(line => line.trim())) {
      const clean = line.trim().replace(/^#{1,3}\s+/, '').replace(/^(?:[-*]\s+|\d+\.\s+)/, '');
      expect(html).toContain(api.inlineText(clean));
    }
    expect(api.markdown('<script>alert(1)</script>')).not.toContain('<script>');
  });
  test('uses exactly the six locked original PNG versions and matching source bytes', () => {
    expect(data.demos.flatMap(demo => demo.frames).map(frame => frame.lockedVersion)).toEqual(['MG-P01-before-v2', 'MG-P01-action-v2', 'MG-P01-result-v1', 'MG-P02-before-v2', 'MG-P02-during-v1', 'MG-P02-result-v1']);
    for (const frame of data.demos.flatMap(demo => demo.frames)) {
      const bytes = fs.readFileSync(path.join(root, frame.src));
      expect(bytes.length).toBe(frame.bytes);
      expect(crypto.createHash('sha256').update(bytes).digest('hex')).toBe(frame.sha256);
      expect(bytes.readUInt32BE(16)).toBe(frame.width);
      expect(bytes.readUInt32BE(20)).toBe(frame.height);
      expect(frame.src).toMatch(/^proposal-demos\/[a-f0-9]{20}\.png$/);
    }
  });
  test('only moves between three illustrations and resets without carrying resource state', () => {
    const before = { candidateId: 'MG-P01', frame: 0, score: 900, minutes: 10 };
    const middle = api.previewState(before, { type: 'next' }, data.demos);
    expect(middle).toEqual({ candidateId: 'MG-P01', frame: 1 });
    expect(before.score).toBe(900);
    expect(api.previewState(middle, { type: 'frame', value: 99 }, data.demos).frame).toBe(2);
    expect(api.previewState(middle, { type: 'candidate', value: 'MG-P02' }, data.demos)).toEqual({ candidateId: 'MG-P02', frame: 0 });
    expect(api.previewState({ candidateId: 'MG-P02', frame: 2 }, { type: 'reset' }, data.demos)).toEqual({ candidateId: 'MG-P02', frame: 0 });
    expect(api.previewState(before, { type: 'previous' }, data.demos).frame).toBe(0);
  });
  test('does not mix new candidates into old topics, replace T03, or claim implemented mechanics', () => {
    const plan = JSON.parse(fs.readFileSync(path.join(root, 'plan.json'), 'utf8'));
    expect(plan.topics).toHaveLength(17);
    expect(plan.topics.some(topic => topic.id.startsWith('MG-P'))).toBe(false);
    expect(plan.topics.find(topic => topic.id === 'T02').supervisor_pool_eligible).toBe(false);
    expect(data.boundaries.originalIllustrationsUnchanged).toBe(true);
    expect(data.boundaries.realMechanicsImplemented).toBe(false);
    expect(data.notice).toContain('不連成連續日程');
    expect(data.demos[1].interactionNote).toContain('A／A／B');
    expect(data.demos[0].frames[2].state).toContain('朵娜沒有被寫成已付款');
  });
  test('rejects incomplete handoffs and adds no account, payment, tracking or persistence', () => {
    expect(api.validate({ ...data, demos: [] })).toBe(false);
    expect(api.validate({ ...data, boundaries: { ...data.boundaries, realMechanicsImplemented: true } })).toBe(false);
    expect(JSON.stringify(data)).not.toMatch(/\/Users\/|\/Volumes\/|\/mnt\/data\//);
    const script = fs.readFileSync(path.join(root, 'new-gameplay-proposals.js'), 'utf8');
    expect(script).not.toMatch(/localStorage|sessionStorage|indexedDB|sendBeacon|method\s*:\s*['"]POST|<iframe/);
  });
});
