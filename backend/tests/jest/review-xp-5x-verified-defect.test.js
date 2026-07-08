'use strict';

/**
 * card_1d071107 — review-economy: pay the reviewer base × 5 XP when an
 * INDEPENDENT review catches a REAL, verified defect.
 *
 * Hank directive 2026-07-05:「審查抓出問題可以獲得五倍的經驗值」.
 *
 * Two layers:
 *   1. Pure logic (review-xp.js): evaluateReviewDefectAward() qualifies the ×5
 *      iff (verdict DO-NOT-MERGE / request-changes / reject OR a confirmed
 *      HIGH/MED/CRITICAL finding) AND prSentBack === true AND not a self-review.
 *   2. Wiring (POST /card/:id/review-verdict): the reviewing entity is paid
 *      base × multiplier via the injected awardEntityXP; idempotent per
 *      (card, reviewer) so the ×5 cannot be double-awarded.
 *
 * RED→GREEN proof: on the OLD code neither review-xp.js nor the
 * /review-verdict route exists, so both the pure-logic assertions and the
 * behavioural route (404 → no award) fail; with the change they pass.
 */

const mockQuery = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });

jest.mock('pg', () => ({
    Pool: jest.fn().mockImplementation(() => ({
        query: mockQuery,
        connect: jest.fn().mockResolvedValue({
            query: jest.fn().mockResolvedValue({ rows: [] }),
            release: jest.fn(),
        }),
        end: jest.fn().mockResolvedValue(undefined),
    })),
}));

jest.mock('../../safe-equal', () => (a, b) => a === b);

const {
    evaluateReviewDefectAward,
    REVIEW_BASE_XP,
    REVIEW_VERIFIED_DEFECT_XP_MULTIPLIER,
} = require('../../review-xp');

const express = require('express');
const request = require('supertest');

// ════════════════════════════════════════════════════════════════
// Layer 1 — pure decision logic
// ════════════════════════════════════════════════════════════════
describe('evaluateReviewDefectAward (pure)', () => {
    const REVIEWER = 2;
    const AUTHOR = 3;

    it('multiplier is the named ×5 constant', () => {
        expect(REVIEW_VERIFIED_DEFECT_XP_MULTIPLIER).toBe(5);
    });

    it('DO-NOT-MERGE verdict + PR sent back → base × 5 to reviewer', () => {
        const r = evaluateReviewDefectAward({
            verdict: 'DO-NOT-MERGE', prSentBack: true,
            reviewerEntityId: REVIEWER, authorEntityId: AUTHOR,
        });
        expect(r.qualified).toBe(true);
        expect(r.multiplier).toBe(5);
        expect(r.awardXp).toBe(REVIEW_BASE_XP * 5);
    });

    it('confirmed HIGH finding + PR sent back → base × 5', () => {
        const r = evaluateReviewDefectAward({
            findings: [{ severity: 'HIGH', confirmed: true }], prSentBack: true,
            reviewerEntityId: REVIEWER, authorEntityId: AUTHOR,
        });
        expect(r.qualified).toBe(true);
        expect(r.awardXp).toBe(REVIEW_BASE_XP * 5);
    });

    it('severity=MED + PR sent back → base × 5', () => {
        const r = evaluateReviewDefectAward({
            severity: 'MED', prSentBack: true,
            reviewerEntityId: REVIEWER, authorEntityId: AUTHOR,
        });
        expect(r.qualified).toBe(true);
        expect(r.multiplier).toBe(5);
    });

    it('defect found but PR NOT sent back (merged as-is) → NO multiplier (base × 1)', () => {
        const r = evaluateReviewDefectAward({
            verdict: 'DO-NOT-MERGE', prSentBack: false,
            reviewerEntityId: REVIEWER, authorEntityId: AUTHOR,
        });
        expect(r.qualified).toBe(false);
        expect(r.multiplier).toBe(1);
        expect(r.awardXp).toBe(REVIEW_BASE_XP);
    });

    it('LOW / nit finding is NOT a real defect → base × 1', () => {
        const r = evaluateReviewDefectAward({
            findings: [{ severity: 'low', confirmed: true }], prSentBack: true,
            reviewerEntityId: REVIEWER, authorEntityId: AUTHOR,
        });
        expect(r.qualified).toBe(false);
        expect(r.multiplier).toBe(1);
    });

    it('UNCONFIRMED HIGH finding does NOT qualify (must be verified)', () => {
        const r = evaluateReviewDefectAward({
            findings: [{ severity: 'HIGH', confirmed: false }], prSentBack: true,
            reviewerEntityId: REVIEWER, authorEntityId: AUTHOR,
        });
        expect(r.qualified).toBe(false);
    });

    it('APPROVE / clean review → base × 1', () => {
        const r = evaluateReviewDefectAward({
            verdict: 'approve', prSentBack: false,
            reviewerEntityId: REVIEWER, authorEntityId: AUTHOR,
        });
        expect(r.qualified).toBe(false);
        expect(r.multiplier).toBe(1);
        expect(r.awardXp).toBe(REVIEW_BASE_XP);
    });

    it('self-review (reviewer === author) never earns the multiplier', () => {
        const r = evaluateReviewDefectAward({
            verdict: 'DO-NOT-MERGE', prSentBack: true,
            reviewerEntityId: REVIEWER, authorEntityId: REVIEWER,
        });
        expect(r.qualified).toBe(false);
        expect(r.reason).toBe('self_review_no_multiplier');
    });

    it('missing reviewer → awards nothing (multiplier 0)', () => {
        const r = evaluateReviewDefectAward({ verdict: 'DO-NOT-MERGE', prSentBack: true });
        expect(r.multiplier).toBe(0);
        expect(r.awardXp).toBe(0);
    });
});

// ════════════════════════════════════════════════════════════════
// Layer 2 — POST /card/:id/review-verdict wiring
// ════════════════════════════════════════════════════════════════
describe('POST /card/:id/review-verdict wiring', () => {
    let app;
    let awardSpy;

    const mockDevices = {
        'test-dev': {
            deviceSecret: 'test-secret',
            entities: {
                0: { isBound: true, botSecret: 'sec0', character: 'Bot0' },
                2: { isBound: true, botSecret: 'sec2', character: 'Reviewer' },
                3: { isBound: true, botSecret: 'sec3', character: 'Author' },
            },
        },
    };

    beforeAll(() => {
        app = express();
        app.use(express.json());
        awardSpy = jest.fn().mockResolvedValue({ xp: 100, level: 2, leveledUp: false });
        const kanbanModule = require('../../kanban')(mockDevices, {
            awardEntityXP: (...args) => awardSpy(...args),
        });
        app.use('/api/mission', kanbanModule.router);
    });

    beforeEach(() => {
        mockQuery.mockReset();
        mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
        awardSpy.mockReset();
        awardSpy.mockResolvedValue({ xp: 100, level: 2, leveledUp: false });
    });

    const post = (path) => request(app).post(path);
    // Reviewer (#2) is NOT one of the assignees ([3]) → an independent review.
    const AUTH = { deviceId: 'test-dev', deviceSecret: 'test-secret', reviewerEntityId: 2 };
    const flushAsync = () => new Promise((r) => setImmediate(r));

    function cardRow(overrides = {}) {
        return {
            id: 'card_x', device_id: 'test-dev', title: 'Some feature',
            description: 'desc', priority: 'P2', status: 'review',
            assigned_bots: [3], created_by: 3, reviewer_entity_id: 2,
            review_xp_awarded: {}, archived: false,
            created_at: new Date(), updated_at: new Date(),
            ...overrides,
        };
    }

    it('verified-defect review awards base × 5 to the REVIEWER (#2)', async () => {
        mockQuery
            .mockResolvedValueOnce({ rows: [cardRow()] }) // SELECT card
            .mockResolvedValue({ rows: [], rowCount: 1 }); // UPDATE ledger + addSystemComment

        const res = await post('/api/mission/card/card_x/review-verdict')
            .send({ ...AUTH, verdict: 'DO-NOT-MERGE', prSentBack: true, prNumber: '123' });

        expect(res.status).toBe(200);
        expect(res.body.qualified).toBe(true);
        expect(res.body.multiplier).toBe(5);
        expect(res.body.awardXp).toBe(REVIEW_BASE_XP * 5);

        await flushAsync();
        // awardEntityXP(deviceId, reviewerEntityId=2, base*5, reason)
        expect(awardSpy).toHaveBeenCalledTimes(1);
        const [dev, entityId, amount, reason] = awardSpy.mock.calls[0];
        expect(dev).toBe('test-dev');
        expect(entityId).toBe(2);
        expect(amount).toBe(REVIEW_BASE_XP * 5);
        expect(reason).toMatch(/review_verified_defect_x5/);
    });

    it('non-verified review (no defect, PR not sent back) does NOT get the multiplier', async () => {
        mockQuery
            .mockResolvedValueOnce({ rows: [cardRow()] })
            .mockResolvedValue({ rows: [], rowCount: 1 });

        const res = await post('/api/mission/card/card_x/review-verdict')
            .send({ ...AUTH, verdict: 'approve', prSentBack: false });

        expect(res.status).toBe(200);
        expect(res.body.qualified).toBe(false);
        expect(res.body.multiplier).toBe(1);
        expect(res.body.awardXp).toBe(REVIEW_BASE_XP);

        await flushAsync();
        const [, entityId, amount] = awardSpy.mock.calls[0];
        expect(entityId).toBe(2);
        expect(amount).toBe(REVIEW_BASE_XP); // base only, NOT ×5
    });

    it('a DO-NOT-MERGE finding whose PR was merged as-is (prSentBack:false) → base only', async () => {
        mockQuery
            .mockResolvedValueOnce({ rows: [cardRow()] })
            .mockResolvedValue({ rows: [], rowCount: 1 });

        const res = await post('/api/mission/card/card_x/review-verdict')
            .send({ ...AUTH, verdict: 'DO-NOT-MERGE', prSentBack: false });

        expect(res.body.qualified).toBe(false);
        expect(res.body.awardXp).toBe(REVIEW_BASE_XP);
    });

    it('double-award is prevented: same reviewer + same card cannot be paid the ×5 twice', async () => {
        // Card already has a ×5 ledger entry for reviewer #2.
        mockQuery.mockResolvedValueOnce({
            rows: [cardRow({
                review_xp_awarded: { 2: { xp: 50, multiplier: 5, at: '2026-07-05T00:00:00Z' } },
            })],
        });

        const res = await post('/api/mission/card/card_x/review-verdict')
            .send({ ...AUTH, verdict: 'DO-NOT-MERGE', prSentBack: true });

        expect(res.status).toBe(200);
        expect(res.body.awarded).toBe(false);
        expect(res.body.duplicate).toBe(true);

        await flushAsync();
        expect(awardSpy).not.toHaveBeenCalled(); // no second payout
    });

    it('self-review (reviewer is an assignee) earns no multiplier', async () => {
        // Reviewer #3 IS one of the assignees → self-review.
        mockQuery
            .mockResolvedValueOnce({ rows: [cardRow({ assigned_bots: [3] })] })
            .mockResolvedValue({ rows: [], rowCount: 1 });

        const res = await post('/api/mission/card/card_x/review-verdict')
            .send({ deviceId: 'test-dev', deviceSecret: 'test-secret', reviewerEntityId: 3, verdict: 'DO-NOT-MERGE', prSentBack: true });

        expect(res.body.qualified).toBe(false);
        expect(res.body.selfReview).toBe(true);
        expect(res.body.awardXp).toBe(REVIEW_BASE_XP);
    });
});
