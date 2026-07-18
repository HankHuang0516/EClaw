/**
 * Regression for #3985 — matrix runner left "(auto, safe to delete)" marker
 * cards behind when kanban_lifecycle's finally-cleanup hit a transient error.
 * The pre-run sweep must archive leftover marker cards from PREVIOUS runs,
 * skip the current run's own cards, and never throw (best-effort).
 */
'use strict';

const {
    sweepLeftoverMarkerCards,
    isLeftoverMarkerCard,
} = require('../e2e/matrix/sweep-leftovers.js');

const noop = () => {};

function jsonResponse(status, body) {
    return { status, json: async () => body };
}

describe('isLeftoverMarkerCard', () => {
    const runId = 'rcurrent1';

    it('matches a previous-run marker card', () => {
        expect(isLeftoverMarkerCard(
            { title: 'E2E-MATRIX rold123 desktop — kanban_lifecycle (auto, safe to delete)' },
            runId
        )).toBe(true);
    });

    it('skips the current run\'s own marker card', () => {
        expect(isLeftoverMarkerCard(
            { title: `E2E-MATRIX ${runId} desktop — kanban_lifecycle (auto, safe to delete)` },
            runId
        )).toBe(false);
    });

    it('ignores non-marker cards (no accidental archival of real cards)', () => {
        expect(isLeftoverMarkerCard({ title: '[P0][Security] real card' }, runId)).toBe(false);
        expect(isLeftoverMarkerCard({ title: 'E2E-MATRIX but no suffix' }, runId)).toBe(false);
        expect(isLeftoverMarkerCard({ title: 'something (auto, safe to delete)' }, runId)).toBe(false);
        expect(isLeftoverMarkerCard({}, runId)).toBe(false);
    });
});

describe('sweepLeftoverMarkerCards', () => {
    const base = 'https://example.test';
    const creds = { deviceId: 'dev-1', deviceSecret: 'sec-1' };

    it('archives previous-run marker cards and skips current-run + real cards', async () => {
        const deleted = [];
        const fetchImpl = async (url, opts) => {
            if (!opts || !opts.method) {
                return jsonResponse(200, { cards: [
                    { id: 'card_old', title: 'E2E-MATRIX rold desktop — kanban_lifecycle (auto, safe to delete)' },
                    { id: 'card_now', title: 'E2E-MATRIX rnow desktop — kanban_lifecycle (auto, safe to delete)' },
                    { id: 'card_real', title: '[P0] real work card' },
                ] });
            }
            deleted.push(url);
            return jsonResponse(200, { success: true });
        };
        const res = await sweepLeftoverMarkerCards({ base, ...creds, runId: 'rnow', fetchImpl, log: noop });
        expect(res).toEqual({ swept: 1, matched: 1, skipped: false });
        expect(deleted).toHaveLength(1);
        expect(deleted[0]).toContain('/api/mission/card/card_old');
        expect(deleted[0]).toContain('deviceId=dev-1');
    });

    it('skips entirely when creds are missing (auth-light runs)', async () => {
        const fetchImpl = jest.fn();
        const res = await sweepLeftoverMarkerCards({ base, fetchImpl, log: noop });
        expect(res.skipped).toBe(true);
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('never throws when the list call fails (best-effort, gate stays green)', async () => {
        const fetchImpl = async () => { throw new Error('ECONNRESET'); };
        const res = await sweepLeftoverMarkerCards({ base, ...creds, fetchImpl, log: noop });
        expect(res).toEqual({ swept: 0, matched: 0, skipped: false });
    });

    it('counts but does not throw on a failed DELETE', async () => {
        const fetchImpl = async (url, opts) => {
            if (!opts || !opts.method) {
                return jsonResponse(200, { cards: [
                    { id: 'card_a', title: 'E2E-MATRIX r1 mobile — kanban_lifecycle (auto, safe to delete)' },
                    { id: 'card_b', title: 'E2E-MATRIX r2 mobile — kanban_lifecycle (auto, safe to delete)' },
                ] });
            }
            if (url.includes('card_a')) return jsonResponse(503, { success: false });
            return jsonResponse(200, { success: true });
        };
        const res = await sweepLeftoverMarkerCards({ base, ...creds, runId: 'rnow', fetchImpl, log: noop });
        expect(res).toEqual({ swept: 1, matched: 2, skipped: false });
    });
});
