const fs = require('fs');
const path = require('path');
const seed = require('../../dot-progress-seed.json');

test('the public repository seed contains only approved completed summaries', () => {
    expect(seed).toHaveLength(3);
    for (const row of seed) {
        expect(row.status).toBe('completed');
        expect(row.summary).toBeTruthy();
        expect(row.publicSummary).toBeTruthy();
        expect(row.blockers).toBe('');
        expect(row.nextStep).toBe('');
    }
});

test('static progress bundle obtains private content only through the protected API', () => {
    const directory = path.join(__dirname, '../../public/AiHankApps/dot-progress');
    const names = fs.readdirSync(directory);
    expect(names.sort()).toEqual(['i18n.js', 'index.html', 'progress.css', 'progress.js']);
    const script = fs.readFileSync(path.join(directory, 'progress.js'), 'utf8');
    expect(script).toContain("request('/projects'");
    expect(script).not.toContain('dot-progress-seed');
    expect(script).not.toMatch(/(?:deviceSecret|botSecret|channelApiKey|localStorage)/);
});
