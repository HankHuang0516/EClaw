/**
 * Phase 4 #9 — public roadmap manifest + tracker payload builder.
 * Card: card_5ac74610cbf1f89440427809
 */
'use strict';

const {
    KANBAN_TO_PUBLIC,
    PUBLIC_STATUSES,
    toPublicStatus,
    ROADMAP_ITEMS,
    buildTrackerPayload,
} = require('../../agent-improvement/roadmap-manifest');

describe('toPublicStatus()', () => {
    test('collapses kanban statuses into the 3 public words', () => {
        expect(toPublicStatus('backlog')).toBe('todo');
        expect(toPublicStatus('todo')).toBe('todo');
        expect(toPublicStatus('in_progress')).toBe('in_progress');
        expect(toPublicStatus('review')).toBe('in_progress');
        expect(toPublicStatus('done')).toBe('shipped');
        expect(toPublicStatus('blocked')).toBe('todo');
    });
    test('unknown status defaults to todo', () => {
        expect(toPublicStatus('weird')).toBe('todo');
        expect(toPublicStatus(undefined)).toBe('todo');
    });
    test('every mapping target is a valid public status', () => {
        for (const v of Object.values(KANBAN_TO_PUBLIC)) {
            expect(PUBLIC_STATUSES).toContain(v);
        }
    });
});

describe('ROADMAP_ITEMS', () => {
    test('has exactly 9 items, one per OODA-R roadmap number', () => {
        expect(ROADMAP_ITEMS).toHaveLength(9);
        expect(ROADMAP_ITEMS.map(i => i.num)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    });
    test('every item carries a cardId, title, and valid fallbackStatus', () => {
        for (const it of ROADMAP_ITEMS) {
            expect(typeof it.cardId).toBe('string');
            expect(it.cardId.length).toBeGreaterThan(0);
            expect(typeof it.title).toBe('string');
            expect(PUBLIC_STATUSES).toContain(it.fallbackStatus);
        }
    });
    test('item ids are unique (DOM/i18n anchors must not collide)', () => {
        const ids = ROADMAP_ITEMS.map(i => i.id);
        expect(new Set(ids).size).toBe(ids.length);
    });
    test('is frozen so the route layer cannot mutate it', () => {
        expect(Object.isFrozen(ROADMAP_ITEMS)).toBe(true);
    });
});

describe('buildTrackerPayload()', () => {
    test('uses fallbackStatus and live=false when no card data supplied', () => {
        const { items, generatedAt } = buildTrackerPayload({});
        expect(items).toHaveLength(9);
        for (const it of items) {
            expect(it.live).toBe(false);
            expect(it.updatedAt).toBeNull();
            expect(PUBLIC_STATUSES).toContain(it.status);
        }
        expect(() => new Date(generatedAt)).not.toThrow();
        expect(Number.isNaN(Date.parse(generatedAt))).toBe(false);
    });

    test('live status overrides fallback when the card is found', () => {
        const target = ROADMAP_ITEMS.find(i => i.num === 5); // p2 offline, fallback todo
        const ts = '2026-06-15T00:00:00.000Z';
        const { items } = buildTrackerPayload({
            [target.cardId]: { status: 'in_progress', updatedAt: ts },
        });
        const got = items.find(i => i.cardId === target.cardId);
        expect(got.status).toBe('in_progress');
        expect(got.live).toBe(true);
        expect(got.updatedAt).toBe(ts);
    });

    test('Date updatedAt is serialized to ISO', () => {
        const target = ROADMAP_ITEMS[0];
        const d = new Date('2026-06-16T12:34:56.000Z');
        const { items } = buildTrackerPayload({
            [target.cardId]: { status: 'done', updatedAt: d },
        });
        const got = items.find(i => i.cardId === target.cardId);
        expect(got.status).toBe('shipped');
        expect(got.updatedAt).toBe('2026-06-16T12:34:56.000Z');
    });

    test('card present but no status string → falls back', () => {
        const target = ROADMAP_ITEMS[0];
        const { items } = buildTrackerPayload({ [target.cardId]: {} });
        const got = items.find(i => i.cardId === target.cardId);
        expect(got.live).toBe(false);
        expect(got.status).toBe(target.fallbackStatus);
    });

    test('payload carries no secret-shaped fields (only public card data)', () => {
        const { items } = buildTrackerPayload({});
        const json = JSON.stringify(items);
        // no botSecret / deviceSecret / 32-hex token leakage
        expect(/botSecret|deviceSecret|Bearer\s/i.test(json)).toBe(false);
        expect(/\b[a-f0-9]{32,}\b/i.test(json)).toBe(false);
    });
});
