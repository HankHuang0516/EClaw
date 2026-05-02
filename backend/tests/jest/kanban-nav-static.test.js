'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const kanbanHtml = fs.readFileSync(path.join(ROOT, 'public', 'portal', 'kanban.html'), 'utf8');
const missionHtml = fs.readFileSync(path.join(ROOT, 'public', 'portal', 'mission.html'), 'utf8');
const navJs = fs.readFileSync(path.join(ROOT, 'public', 'portal', 'shared', 'nav.js'), 'utf8');

describe('portal top navigation active page mapping', () => {
    test('shared nav exposes separate Mission and Kanban top-level entries', () => {
        expect(navJs).toContain("id: 'mission'");
        expect(navJs).toContain("href: 'mission.html'");
        expect(navJs).toContain("id: 'kanban'");
        expect(navJs).toContain("href: 'kanban.html'");
    });

    test('kanban.html highlights Kanban, not Mission', () => {
        expect(kanbanHtml).toContain("renderNav('kanban')");
        expect(kanbanHtml).not.toContain("renderNav('mission')");
    });

    test('mission.html still highlights Mission', () => {
        expect(missionHtml).toContain("renderNav('mission')");
    });
});
