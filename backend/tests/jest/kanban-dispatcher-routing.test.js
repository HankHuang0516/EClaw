'use strict';

/**
 * card_e9379868 — kanban dispatcher routing hint.
 *
 * Regression: a kanban notification is a SYSTEM event with no sender entity,
 * so an assigned bot's chat reply ("task done") fail-safes to a human and the
 * DISPATCHER never receives it (2026-07-02: #6's completion report for
 * card_2b0cffd6 routed to Hank, not #2). These tests exercise the directive
 * builder that fixes it: they FAIL on pre-fix code (no directive at all) and
 * PASS once the dispatcher hint is emitted.
 */

const {
    buildDispatcherRoutingDirective,
} = require('../../lib/kanban-dispatcher-routing');

describe('buildDispatcherRoutingDirective', () => {
    test('emits both same-device @#N and cross-device @publicCode tokens', () => {
        const out = buildDispatcherRoutingDirective({
            dispatcherMeta: { entityId: 2, publicCode: 'abc123' },
            recipientEntityId: 6,
            cardId: 'card_x',
        });
        expect(out).toMatch(/\[ROUTING — WHERE YOUR REPLY GOES\]/);
        expect(out).toMatch(/dispatched by #2/);
        expect(out).toContain('@#2');
        expect(out).toContain('@abc123');
        expect(out).toContain('card_x');
    });

    test('the exact incident shape (#6 notified, dispatcher #2) gets a route back to #2', () => {
        const out = buildDispatcherRoutingDirective({
            dispatcherMeta: { entityId: 2, publicCode: 'lobbb2' },
            recipientEntityId: 6,
            cardId: 'card_2b0cffd6',
        });
        expect(out).toContain('@#2');
        expect(out).toContain('card_2b0cffd6');
        // Preferred path is card comment + move (reaches dispatcher automatically).
        expect(out).toMatch(/POST a comment/i);
    });

    test('falls back to @#N only when publicCode is unavailable', () => {
        const out = buildDispatcherRoutingDirective({
            dispatcherMeta: { entityId: 2, publicCode: null },
            recipientEntityId: 6,
            cardId: 'card_x',
        });
        expect(out).toContain('@#2');
        expect(out).not.toMatch(/@[a-z0-9]{6}\b/); // no publicCode token
    });

    test('emits NOTHING when the recipient IS the dispatcher (self-assigned card)', () => {
        const out = buildDispatcherRoutingDirective({
            dispatcherMeta: { entityId: 2, publicCode: 'abc123' },
            recipientEntityId: 2,
            cardId: 'card_x',
        });
        expect(out).toBe('');
    });

    test('emits NOTHING for system/cron cards (no dispatcher / created_by=0)', () => {
        expect(buildDispatcherRoutingDirective({ dispatcherMeta: null, recipientEntityId: 6 })).toBe('');
        expect(buildDispatcherRoutingDirective({ dispatcherMeta: { entityId: 0, publicCode: null }, recipientEntityId: 6 })).toBe('');
        expect(buildDispatcherRoutingDirective({})).toBe('');
    });
});

describe('kanban.js wiring (dispatcherEntityId threaded through all dispatch sites)', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'kanban.js'), 'utf8');

    test('notifyEntities destructures dispatcherEntityId and resolves dispatcherMeta', () => {
        expect(src).toMatch(/dispatcherEntityId\s*\}\s*=\s*options/);
        expect(src).toMatch(/dispatcherMeta/);
        expect(src).toMatch(/buildDispatcherRoutingDirective\(/);
    });

    test('all three dispatch callers pass dispatcherEntityId', () => {
        // create dispatch (createdBy), move/reassign (card.created_by), edit-add (updated.created_by)
        expect(src).toMatch(/dispatcherEntityId:\s*createdBy/);
        expect(src).toMatch(/dispatcherEntityId:\s*card\.created_by/);
        expect(src).toMatch(/dispatcherEntityId:\s*updated\.created_by/);
    });
});
