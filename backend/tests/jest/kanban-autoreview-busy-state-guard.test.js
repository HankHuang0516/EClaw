'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const indexSrc = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8');
const channelSrc = fs.readFileSync(path.join(ROOT, 'channel-api.js'), 'utf8');

function expectBusyGuard(src) {
    expect(src).toMatch(/kanbanBusyStates\s*=\s*new Set\(\[([^\]]+)/);
    expect(src).toMatch(/'BUSY'/);
    expect(src).toMatch(/'PROCESSING'/);
    expect(src).toMatch(/'WORKING'/);
    expect(src).toMatch(/String\(state \|\| ''\)\.trim\(\)\.toUpperCase\(\)/);
    expect(src).toMatch(/!isKanbanBusyState[\s\S]*autoReviewOnTransform|!isKanbanBusyState[\s\S]*kanbanAutoReview/);
}

describe('kanban auto-review busy-state guard', () => {
    test('/api/transform does not auto-close cards for BUSY/PROCESSING/WORKING progress heartbeats', () => {
        expectBusyGuard(indexSrc);
        expect(indexSrc).not.toMatch(/state !== 'BUSY' && finalMessage[\s\S]*autoReviewOnTransform/);
    });

    test('channel transform mirrors the same busy-state guard', () => {
        expectBusyGuard(channelSrc);
        expect(channelSrc).not.toMatch(/state !== 'BUSY' && message[\s\S]*kanbanAutoReview/);
    });
});
