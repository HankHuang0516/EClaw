'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const REPO_ROOT = path.join(ROOT, '..');
const kanbanJs = fs.readFileSync(path.join(ROOT, 'kanban.js'), 'utf8');
const schema = fs.readFileSync(path.join(ROOT, 'kanban_schema.sql'), 'utf8');
const kanbanHtml = fs.readFileSync(path.join(ROOT, 'public', 'portal', 'kanban.html'), 'utf8');
const spec = fs.readFileSync(path.join(REPO_ROOT, 'docs', 'mission-v2-kanban-spec.md'), 'utf8');

const reopenStart = kanbanJs.indexOf("router.post('/card/:id/reopen'");
const reopenEnd = reopenStart >= 0 ? kanbanJs.indexOf("// ============================================\n    // GET /card/:id/comments", reopenStart) : -1;
const reopenBlock = reopenStart >= 0 ? kanbanJs.slice(reopenStart, reopenEnd > reopenStart ? reopenEnd : reopenStart + 6500) : '';

describe('Kanban Done-card explicit reopen flow', () => {
    test('keeps /move Done guard and adds explicit /reopen endpoint', () => {
        expect(kanbanJs).toMatch(/if \(oldStatus === 'done'\) \{[\s\S]{0,240}Done cards cannot be moved/);
        expect(reopenStart).toBeGreaterThan(-1);
        expect(kanbanJs).toContain("POST /card/:id/reopen");
    });

    test('validates source, target, archived state, reason, and no time lock', () => {
        expect(reopenBlock).toContain('archived = false');
        expect(reopenBlock).toContain("card.status !== 'done'");
        expect(reopenBlock).toContain("STATUSES.filter(s => s !== 'done' && s !== 'backlog')");
        expect(reopenBlock).toContain('Reopen reason is required');
        expect(reopenBlock).not.toMatch(/7\s*days?|604800000|done_retention_ms|retention|older than|created_at\s*[<>=]/i);
    });

    test('uses constrained permissions and does not default to assignedBots', () => {
        expect(reopenBlock).toContain('REOPEN_SUPERVISOR_ENTITY_IDS');
        expect(reopenBlock).toContain('isCreator');
        expect(reopenBlock).toContain('isReviewer');
        expect(reopenBlock).toContain('isDeviceOwner');
        expect(reopenBlock).toContain('p0OrPrRework');
        expect(reopenBlock).toContain('allowedForStrictCard');
        expect(reopenBlock).not.toMatch(/assigned_bots[\s\S]{0,500}(allowed|authorized|permission|isOwner)/i);
    });

    test('persists audit/rework fields and writes system audit comment', () => {
        for (const column of ['reopened_at', 'reopened_by', 'reopen_reason', 'requires_pr_rework', 'rework_pr_number']) {
            expect(schema).toContain(column);
            expect(kanbanJs).toContain(column);
        }
        expect(reopenBlock).toMatch(/addSystemComment[\s\S]*REOPENED from Done ->/);
        expect(kanbanJs).toContain('REWORK_PR_REQUIRED');
    });

    test('UI disables Done dragging and exposes modal-based reopen path', () => {
        expect(kanbanHtml).toContain("card.archived || card.status === 'done'");
        expect(kanbanHtml).toContain('openReopenDialog');
        expect(kanbanHtml).toContain('submitReopenCard');
        expect(kanbanHtml).toContain('apiReopenCard');
        expect(kanbanHtml).toContain('Reopen reason is required');
    });

    test('spec documents no-time-lock explicit reopen semantics', () => {
        expect(spec).toContain('Done 卡重新打開');
        expect(spec).toContain('不設時間鎖');
        expect(spec).toContain('POST /api/mission/card/:id/reopen');
        expect(spec).toContain('一般 `/move` 仍禁止 `done -> non-done`');
    });
});
