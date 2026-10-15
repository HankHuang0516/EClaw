const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.resolve(__dirname, '../../public/AiHankApps/projects/fraud-empire');
const plan = JSON.parse(fs.readFileSync(path.join(root, 'plan.json'), 'utf8'));
const config = JSON.parse(fs.readFileSync(path.join(root, 'demo-data.json'), 'utf8'));
const script = fs.readFileSync(path.join(root, 'demo.js'), 'utf8');

describe('Fraud Empire bounded static demonstration', () => {
  test('identifies the preview honestly and links delivered proposals without claiming runtime completion', () => {
    expect(config.status).toBe('靜態互動示意，非正式遊戲');
    expect(config.dataSources.portraits).toBe('art-catalog.json');
    expect(config.dataSources.dialogues).toBe('dialogue-proposals.json');
    expect(fs.existsSync(path.join(root, config.dataSources.portraits))).toBe(true);
    expect(fs.existsSync(path.join(root, config.dataSources.dialogues))).toBe(true);
    expect(config.completion).toContain('仍未完成');
    expect(config.completion).toContain('不是正式劇本');
    expect(script).not.toMatch(/localStorage|sessionStorage|indexedDB|method\s*:\s*['"]POST|sendBeacon/);
  });

  test('connects every representative step to controls, conditions, results and existing figures', () => {
    expect(plan.topics).toHaveLength(17);
    const steps = plan.topics.flatMap(topic => topic.steps);
    expect(steps).toHaveLength(119);
    for (const step of steps) {
      expect(step.instruction || step.action).toBeTruthy();
      expect(step.success_check).toBeTruthy();
      expect(step.feedback).toBeTruthy();
      expect(plan.figures.some(figure => figure.id === step.id && !figure.pendingReplacement)).toBe(true);
    }
    expect(script).toContain("'達成條件', step.success_check");
    expect(script).toContain("'操作後結果', step.visible_after");
    expect(script).toContain('上一步畫面');
    expect(script).toContain('下一步畫面');
  });

  test('keeps 16 gameplay categories and one prologue separate from 3-5 supervisor tasks', () => {
    expect(script).toContain("state.view === 'topic-overview'");
    expect(script).toContain('item.available_modes.includes(state.mode)).slice(0, state.count)');
    expect(script).toContain('Math.min(5, Math.max(3, Number(value)))');
    expect(script).toContain('不是全部內容的自由任務板');
    expect(script).toContain('重設');
    expect(script).toContain('返回完整企劃閱讀');
  });

  test('uses one corrected content-addressed image and retains archive labels', () => {
    const correction = plan.assetCorrections.find(item => item.id === 'ESC-S05-LIN');
    const asset = plan.figures.find(item => item.id === correction.id);
    expect(asset.src).toBe(correction.src);
    expect(asset.pendingReplacement).toBe(false);
    expect(crypto.createHash('sha256').update(fs.readFileSync(path.join(root, asset.src))).digest('hex')).toBe(correction.sha256);
    expect(JSON.stringify(plan)).not.toContain('ad76fd44a414ced913f8.webp');
    expect(plan.downloads.every(item => item.label.includes('歷史備份'))).toBe(true);
  });

  test('has no superseded satiety proposal and explicitly retains the new global-only rate', () => {
    const content = JSON.stringify(plan);
    expect(content).not.toMatch(/自然飽食每\s*60遊戲分[-−]4/);
    expect(content).toContain('清醒每30遊戲分減1');
    expect(content).toContain('整夜睡眠每120遊戲分減1');
    expect(content).toContain('全局只扣一次');
    expect(content).toContain('體力每10分回1');
  });
});
