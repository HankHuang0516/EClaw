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
});
