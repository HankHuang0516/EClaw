/**
 * Backend usage-api aggregateOverRange — card_694be9fe79a3bf28c11a4a67.
 *
 * The daemon pushes a full 24h cumulative-sessions snapshot every minute,
 * so summing every row over a range double-counted each session by the
 * snapshot count. Production was showing ~881x overcount on Today
 * (claude.today.sum_input_tokens + sum_output_tokens ≈ 27.05B vs the
 * true ~30.68M). The new aggregateOverRange takes the latest row only;
 * snapshot_count remains exposed for diagnostics.
 */
'use strict';

const usageApi = require('../../usage-api');
const { aggregateOverRange } = usageApi({})._internal;

const mkRow = (claudeSessions, codexSessions) => ({
    claude_json: { sessions: claudeSessions },
    codex_json: { sessions: codexSessions },
});

const session = (input, output, cost) => ({
    input_tokens: input, output_tokens: output, cost_usd: cost,
});

describe('aggregateOverRange — cumulative-snapshot dedup (card_694be9fe...)', () => {
    test('empty input returns zeroed shape with snapshot_count=0', () => {
        const r = aggregateOverRange([]);
        expect(r).toEqual({
            claude: { session_count: 0, sum_input_tokens: 0, sum_output_tokens: 0, sum_cost_usd: 0 },
            codex:  { session_count: 0, sum_input_tokens: 0, sum_output_tokens: 0, sum_cost_usd: 0 },
            snapshot_count: 0,
        });
    });

    test('non-array input returns zeroed shape (defensive)', () => {
        const r = aggregateOverRange(null);
        expect(r.snapshot_count).toBe(0);
        expect(r.claude.sum_input_tokens).toBe(0);
        expect(r.codex.sum_input_tokens).toBe(0);
    });

    test('single row returns that snapshot summed across its sessions', () => {
        const rows = [mkRow(
            [session(100, 200, 0.5), session(50, 75, 0.25)],
            [session(1000, 2000, 1.5)],
        )];
        const r = aggregateOverRange(rows);
        expect(r.claude.session_count).toBe(2);
        expect(r.claude.sum_input_tokens).toBe(150);
        expect(r.claude.sum_output_tokens).toBe(275);
        expect(r.claude.sum_cost_usd).toBeCloseTo(0.75, 6);
        expect(r.codex.session_count).toBe(1);
        expect(r.codex.sum_input_tokens).toBe(1000);
        expect(r.codex.sum_output_tokens).toBe(2000);
        expect(r.snapshot_count).toBe(1);
    });

    test('1186 identical cumulative snapshots — no overcount, returns latest only', () => {
        // Simulate the production state #6 found: 1186 snapshots each with
        // the same 24h-cumulative session list. The bug would multiply by
        // 1186; the fix keeps the totals to the latest row's content.
        const claudeSessions = [
            session(10_000, 5_000, 0.25),
            session(3_000_000, 800_000, 5.10),
        ];
        const codexSessions = [session(25_000_000, 3_800_000, 12.50)];
        const rows = Array.from({ length: 1186 }, () => mkRow(claudeSessions, codexSessions));

        const r = aggregateOverRange(rows);
        expect(r.claude.session_count).toBe(2);
        expect(r.claude.sum_input_tokens).toBe(3_010_000);
        expect(r.claude.sum_output_tokens).toBe(805_000);
        expect(r.codex.session_count).toBe(1);
        expect(r.codex.sum_input_tokens).toBe(25_000_000);
        expect(r.codex.sum_output_tokens).toBe(3_800_000);
        // snapshot_count is preserved for diagnostics — confirms the dedup happened.
        expect(r.snapshot_count).toBe(1186);
    });

    test('latest snapshot wins when sessions evolve across rows (ASC ordering assumption)', () => {
        // Earlier snapshot: 1 session.
        // Later snapshot: that session grew + a new session appeared.
        // We want the later state, not the earlier or the sum.
        const earlier = mkRow([session(100, 50, 0.1)], []);
        const later = mkRow([
            session(500, 200, 0.4),
            session(80, 30, 0.05),
        ], []);
        const r = aggregateOverRange([earlier, later]);
        expect(r.claude.session_count).toBe(2);
        expect(r.claude.sum_input_tokens).toBe(580);
        expect(r.claude.sum_output_tokens).toBe(230);
        expect(r.claude.sum_cost_usd).toBeCloseTo(0.45, 6);
        // earlier snapshot must NOT contribute (no 600 = 500+100, no 250 = 200+50)
        expect(r.claude.sum_input_tokens).not.toBe(600);
    });
});
