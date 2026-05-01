'use strict';

const { runPortalSmokeCheck } = require('../../scripts/portal-smoke-check');

describe('portal critical page smoke check', () => {
    test('dashboard, chat, kanban, and Codex Channel docs keep critical assets and anchors intact', () => {
        const result = runPortalSmokeCheck();
        expect(result.errors).toEqual([]);
        expect(result.ok).toBe(true);
    });
});
