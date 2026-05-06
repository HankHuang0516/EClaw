'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const kanbanHtml = fs.readFileSync(path.join(ROOT, 'public', 'portal', 'kanban.html'), 'utf8');

describe('kanban automation dispatch mode UX', () => {
    test('create automation form exposes idle_only dispatch mode', () => {
        expect(kanbanHtml).toContain('id="newDispatchMode"');
        expect(kanbanHtml).toContain('<option value="idle_only">Idle only</option>');
        expect(kanbanHtml).toMatch(/body\.dispatchMode\s*=\s*document\.getElementById\('newDispatchMode'\)\.value === 'idle_only'/);
    });

    test('edit automation form exposes and persists dispatch mode', () => {
        expect(kanbanHtml).toContain('id="editDispatchMode"');
        expect(kanbanHtml).toContain('setAutoDispatchMode');
        expect(kanbanHtml).toMatch(/cardBody\.dispatchMode\s*=\s*dispatchMode/);
    });

    test('card detail displays dispatch mode state', () => {
        expect(kanbanHtml).toContain('🚦 dispatch: <code>${dispatchLabel}</code>');
    });

    test('schedule tab exposes dispatch mode control', () => {
        expect(kanbanHtml).toContain('id="sp-dispatch-mode"');
        expect(kanbanHtml).toMatch(/assignedBots, dispatchMode/);
    });

    test('automation list and timeline surface dispatch mode without opening edit form', () => {
        expect(kanbanHtml).toContain('🚦 ${c.dispatchMode');
        expect(kanbanHtml).toContain('🚦 ${dispatchMode}');
    });
});
