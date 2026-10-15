const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '../../public/AiHankApps/projects/fraud-empire');
const plan = JSON.parse(fs.readFileSync(path.join(root, 'plan.json'), 'utf8'));
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

describe('Fraud Empire public v4 design reader', () => {
    test('retains all chapters, topics, representative steps and narrative collections', () => {
        expect(plan.chapters).toHaveLength(7);
        expect(plan.topics).toHaveLength(17);
        expect(plan.topics.reduce((sum, item) => sum + item.steps.length, 0)).toBe(119);
        expect(plan.narrative.main_events).toHaveLength(14);
        expect(plan.narrative.branches).toHaveLength(36);
        expect(plan.narrative.romance_events).toHaveLength(8);
        expect(plan.narrative.endings).toHaveLength(2);
        expect(plan.maps.scenes).toHaveLength(10);
        plan.chapters.forEach(chapter => expect(chapter.content_markdown.length).toBeGreaterThan(500));
        plan.topics.forEach(topic => {
            expect(topic.designAssessment.immersion.問題).toBeTruthy();
            expect(topic.designAssessment.logic.設計說明).toBeTruthy();
            expect(topic.designAssessment.feedback.即時回饋).toBeTruthy();
            expect(topic.designAssessment.feedback.待確認).toContain('尚待試玩');
        });
    });
    test('maps every representative step and approved global UX to an existing complete image', () => {
        expect(plan.figures).toHaveLength(330);
        expect(new Set(plan.figures.map(f => f.src)).size).toBe(319);
        const ids = new Set(plan.figures.map(f => f.id));
        plan.topics.forEach(topic => topic.steps.forEach(step => expect(ids.has(step.id)).toBe(true)));
        ['UX01', 'UX02', 'UX03', 'UX04'].forEach(id => expect(ids.has(id)).toBe(true));
        plan.figures.forEach(f => {
            expect(f.src).toMatch(/^images\/[a-f0-9]{20}\.webp$/);
            expect(fs.existsSync(path.join(root, f.src))).toBe(true);
            expect(f.width).toBeGreaterThan(0);
            expect(f.height).toBeGreaterThan(0);
        });
    });
    test('excludes internal review objects, paths, transcript handles and raw source archives', () => {
        expect(JSON.stringify(plan)).not.toMatch(/\/Users\/|\/Volumes\/|\/mnt\/data\/|Sentinel_|PR-20\d{6}|單一整合者|自審|"(?:immersion_review|logic_review|reward_review)"/);
        expect(fs.readdirSync(root)).not.toEqual(expect.arrayContaining(['image_slots.json', 'chapters.json', 'publication-audit.json']));
        expect(fs.readdirSync(root).some(file => /\.(?:zip|docx)$/i.test(file))).toBe(false);
    });
    test('offers only reviewed backup files and never creates fictional store downloads', () => {
        expect(plan.downloads).toHaveLength(6);
        plan.downloads.forEach(d => {
            expect([2, 4, 5]).toContain(d.volume);
            expect(d.src).toMatch(/^downloads\/volume-[245]-(?:full|reading)\.pdf$/);
            expect(fs.statSync(path.join(root, d.src)).size).toBe(d.bytes);
        });
        expect(plan.heldDownloadVolumes).toEqual([1, 3]);
        expect(html).not.toMatch(/https:\/\/(?:play\.google\.com|apps\.apple\.com)/);
        expect(html).toContain('不是正式遊戲或可安裝 APP');
        expect(html).toContain('靜態互動示意');
        expect(html).toContain('設計確認稿／開發中');
    });
    test('has direct HTML reading, accessible navigation and a secondary backup section', () => {
        ['reader', 'topics', 'story', 'maps', 'gallery', 'art-overview', 'decisions', 'backups'].forEach(id => expect(html).toContain(`id="${id}"`));
        expect(html).not.toMatch(/<iframe|<embed|<object/i);
        expect(html).toContain('width=device-width');
        expect(html).toContain('href="../../"');
        expect(html).toContain('<dialog');
    });
    test('contains the latest rule clarifications and no unresolved image replacement', () => {
        ['T17', 'T04', 'ESC-S08'].forEach(id => expect(plan.decisions.some(d => (d.references || []).includes(id))).toBe(true));
        expect(plan.figures.filter(f => f.pendingReplacement)).toEqual([]);
    });
});
