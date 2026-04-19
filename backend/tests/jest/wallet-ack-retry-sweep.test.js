/**
 * Tests for ack-retry-sweep.js — the P2 revenue-leak backstop that retries
 * Google Play `:acknowledge` calls for topup_orders whose fire-and-forget
 * ack from /topup/verify-google silently failed.
 *
 * Strategy: exercise `runAckRetrySweep` directly with a hand-rolled in-
 * memory pg pool. We mock `acknowledgeGooglePurchase` so we can script
 * success / failure / throw on a per-order basis, then assert the
 * resulting (ack_state, ack_attempts, ack_at) on each row.
 *
 * Coverage (matches spec):
 *   1. Success on first try
 *   2. Success on retry (after previous failures)
 *   3. 3 failures → ack_state='failed' + audit warn ("speakTo")
 *   4. No pending rows → no-op (scanned=0)
 *   5. >72h old row → skipped (outside Google refund window)
 *   6. Row already acked → skipped by query filter
 *   7. Row missing purchaseToken/packageName in external_raw → skipped
 *      (pre-feature row, can't retry)
 *   8. Batch run: mix of success + failure + exhaust in one pass
 */

'use strict';

const { runAckRetrySweep, MAX_ATTEMPTS, REFUND_WINDOW_MS } =
    require('../../ack-retry-sweep');

// ── In-memory topup_orders store ────────────────────────────────────────

function makeOrder(overrides = {}) {
    return {
        id: overrides.id || `order-${Math.random().toString(36).slice(2, 8)}`,
        user_id: overrides.user_id || '11111111-1111-1111-1111-111111111111',
        channel: 'google_play',
        status: 'paid',
        external_txn_id: overrides.external_txn_id || 'GPA.TEST-0001',
        external_raw: overrides.external_raw || {
            productId: 'ec.topup.starter',
            purchaseToken: 'tok-abcdefg-12345',
            packageName: 'com.hank.clawlive',
        },
        ack_state: overrides.ack_state || 'pending',
        ack_attempts: overrides.ack_attempts || 0,
        ack_at: overrides.ack_at || null,
        created_at: overrides.created_at || new Date(),
    };
}

/**
 * Minimal fake pg pool backed by an in-memory array. Supports just the
 * SQL shapes the sweep issues:
 *   - SELECT ... FROM topup_orders WHERE channel='google_play' AND ack_state <> 'acked' AND status='paid' AND created_at >= $1 ORDER BY created_at ASC LIMIT $2
 *   - UPDATE topup_orders SET ack_state='acked', ack_at=NOW(), ack_attempts=ack_attempts+1 WHERE id=$1 AND ack_state <> 'acked'
 *   - UPDATE topup_orders SET ack_attempts=ack_attempts+1, ack_state = CASE WHEN $2::boolean THEN 'failed' ELSE ack_state END WHERE id=$1 AND ack_state <> 'acked'
 */
function makePool(orders) {
    return {
        orders,
        async query(sql, params = []) {
            const norm = sql.replace(/\s+/g, ' ').trim();

            if (/^SELECT .* FROM topup_orders WHERE channel = 'google_play'/i.test(norm)) {
                const [windowStart, limit] = params;
                const matched = orders
                    .filter(o => o.channel === 'google_play'
                              && o.ack_state !== 'acked'
                              && o.status === 'paid'
                              && new Date(o.created_at) >= new Date(windowStart))
                    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
                    .slice(0, limit)
                    .map(o => ({
                        id: o.id,
                        user_id: o.user_id,
                        external_txn_id: o.external_txn_id,
                        external_raw: o.external_raw,
                        ack_attempts: o.ack_attempts,
                    }));
                return { rows: matched, rowCount: matched.length };
            }

            if (/^UPDATE topup_orders SET ack_state = 'acked'/i.test(norm)) {
                const [id] = params;
                const o = orders.find(x => x.id === id);
                if (!o || o.ack_state === 'acked') return { rows: [], rowCount: 0 };
                o.ack_state = 'acked';
                o.ack_at = new Date();
                o.ack_attempts += 1;
                return { rows: [], rowCount: 1 };
            }

            if (/^UPDATE topup_orders SET ack_attempts = ack_attempts \+ 1/i.test(norm)) {
                const [id, shouldFail] = params;
                const o = orders.find(x => x.id === id);
                if (!o || o.ack_state === 'acked') return { rows: [], rowCount: 0 };
                o.ack_attempts += 1;
                if (shouldFail) o.ack_state = 'failed';
                return { rows: [], rowCount: 1 };
            }

            throw new Error(`[fake-pg] unhandled SQL: ${norm}`);
        },
    };
}

// ── Shared scaffolding ──────────────────────────────────────────────────

function makeAudit() {
    const entries = [];
    const fn = (level, tag, msg, meta) => entries.push({ level, tag, msg, meta });
    fn.entries = entries;
    return fn;
}

const DEFAULT_PKG = 'com.hank.clawlive';

// ── Tests ────────────────────────────────────────────────────────────────

describe('ack-retry-sweep: runAckRetrySweep', () => {
    test('case 1: success on first try → ack_state=acked, ack_at set, attempts=1', async () => {
        const orders = [makeOrder({ id: 'o1' })];
        const pool = makePool(orders);
        const audit = makeAudit();
        const ackMock = jest.fn().mockResolvedValue({ ok: true });

        const stats = await runAckRetrySweep({
            pool, audit,
            acknowledgeGooglePurchase: ackMock,
            packageName: DEFAULT_PKG,
        });

        expect(ackMock).toHaveBeenCalledTimes(1);
        expect(ackMock).toHaveBeenCalledWith(
            'com.hank.clawlive', 'ec.topup.starter', 'tok-abcdefg-12345'
        );
        expect(stats).toMatchObject({ scanned: 1, acked: 1, failed: 0, exhausted: 0, skipped: 0 });

        const after = orders[0];
        expect(after.ack_state).toBe('acked');
        expect(after.ack_attempts).toBe(1);
        expect(after.ack_at).toBeInstanceOf(Date);
    });

    test('case 2: success on retry (row already had 1 failed attempt)', async () => {
        const orders = [makeOrder({ id: 'o2', ack_attempts: 1 })];
        const pool = makePool(orders);
        const audit = makeAudit();
        const ackMock = jest.fn().mockResolvedValue({ ok: true });

        const stats = await runAckRetrySweep({
            pool, audit,
            acknowledgeGooglePurchase: ackMock,
            packageName: DEFAULT_PKG,
        });

        expect(stats.acked).toBe(1);
        expect(orders[0].ack_state).toBe('acked');
        // attempts should increment from 1 → 2 on this successful retry
        expect(orders[0].ack_attempts).toBe(2);
    });

    test('case 3: 3 consecutive failures → ack_state=failed + audit warn with result=exhausted', async () => {
        // Simulate the final run. Row has already failed twice (ack_attempts=2);
        // this third-strike failure should flip the row to 'failed'.
        const orders = [makeOrder({ id: 'o3', ack_attempts: 2 })];
        const pool = makePool(orders);
        const audit = makeAudit();
        const ackMock = jest.fn().mockResolvedValue({ ok: false, error: 'ack_http_500' });

        const stats = await runAckRetrySweep({
            pool, audit,
            acknowledgeGooglePurchase: ackMock,
            packageName: DEFAULT_PKG,
        });

        expect(stats).toMatchObject({ scanned: 1, exhausted: 1 });
        expect(orders[0].ack_state).toBe('failed');
        expect(orders[0].ack_attempts).toBe(3);

        // Audit warn with result=exhausted (the "speakTo" escalation).
        const exhaustedWarn = audit.entries.find(
            e => e.level === 'warn' && e.meta && e.meta.result === 'exhausted'
        );
        expect(exhaustedWarn).toBeDefined();
        expect(exhaustedWarn.msg).toMatch(/EXHAUSTED/);
        expect(exhaustedWarn.meta.metadata.attempts).toBe(3);
        expect(exhaustedWarn.meta.metadata.last_error).toBe('ack_http_500');
    });

    test('case 3b: first failure only → ack_state stays pending, attempts=1, retry_failed audit', async () => {
        const orders = [makeOrder({ id: 'o3b', ack_attempts: 0 })];
        const pool = makePool(orders);
        const audit = makeAudit();
        const ackMock = jest.fn().mockResolvedValue({ ok: false, error: 'ack_http_502' });

        const stats = await runAckRetrySweep({
            pool, audit,
            acknowledgeGooglePurchase: ackMock,
            packageName: DEFAULT_PKG,
        });

        expect(stats).toMatchObject({ failed: 1, exhausted: 0 });
        expect(orders[0].ack_state).toBe('pending'); // still retryable next tick
        expect(orders[0].ack_attempts).toBe(1);

        const retryWarn = audit.entries.find(
            e => e.level === 'warn' && e.meta && e.meta.result === 'retry_failed'
        );
        expect(retryWarn).toBeDefined();
    });

    test('case 4: no pending rows → no-op (all stats zero, ack never called)', async () => {
        const orders = [
            makeOrder({ id: 'o4a', ack_state: 'acked' }),  // excluded by filter
            makeOrder({ id: 'o4b', ack_state: 'failed' }), // excluded (wait — failed IS != acked, so this ISN'T excluded)
        ];
        // The sweep does re-pick 'failed' rows (ack_state <> 'acked'). For a
        // true no-op we need all acked:
        orders[1].ack_state = 'acked';

        const pool = makePool(orders);
        const audit = makeAudit();
        const ackMock = jest.fn().mockResolvedValue({ ok: true });

        const stats = await runAckRetrySweep({
            pool, audit,
            acknowledgeGooglePurchase: ackMock,
            packageName: DEFAULT_PKG,
        });

        expect(stats).toMatchObject({ scanned: 0, acked: 0, failed: 0, exhausted: 0, skipped: 0 });
        expect(ackMock).not.toHaveBeenCalled();
    });

    test('case 5: row older than 72h window → skipped entirely (not scanned)', async () => {
        const fourDaysAgo = new Date(Date.now() - (4 * 24 * 60 * 60 * 1000));
        const orders = [
            makeOrder({ id: 'o5-old', created_at: fourDaysAgo }),  // outside window
            makeOrder({ id: 'o5-fresh' }),                          // inside window
        ];
        const pool = makePool(orders);
        const audit = makeAudit();
        const ackMock = jest.fn().mockResolvedValue({ ok: true });

        const stats = await runAckRetrySweep({
            pool, audit,
            acknowledgeGooglePurchase: ackMock,
            packageName: DEFAULT_PKG,
        });

        expect(stats.scanned).toBe(1);
        expect(ackMock).toHaveBeenCalledTimes(1);
        // The old row is untouched (still pending), fresh row is acked.
        expect(orders[0].ack_state).toBe('pending');
        expect(orders[1].ack_state).toBe('acked');
    });

    test('case 6: row missing purchaseToken in external_raw → skipped audit, ack never called', async () => {
        const orders = [makeOrder({
            id: 'o6',
            external_raw: { productId: 'ec.topup.starter' /* no purchaseToken, no packageName */ },
        })];
        const pool = makePool(orders);
        const audit = makeAudit();
        const ackMock = jest.fn().mockResolvedValue({ ok: true });

        const stats = await runAckRetrySweep({
            pool, audit,
            acknowledgeGooglePurchase: ackMock,
            packageName: DEFAULT_PKG,
        });

        expect(stats).toMatchObject({ scanned: 1, skipped: 1, acked: 0 });
        expect(ackMock).not.toHaveBeenCalled();
        expect(orders[0].ack_state).toBe('pending');
        expect(orders[0].ack_attempts).toBe(0);

        const skippedWarn = audit.entries.find(
            e => e.level === 'warn' && e.meta && e.meta.result === 'missing_fields'
        );
        expect(skippedWarn).toBeDefined();
    });

    test('case 7: ack throws (not rejects) → treated as failure, attempts bumped', async () => {
        const orders = [makeOrder({ id: 'o7' })];
        const pool = makePool(orders);
        const audit = makeAudit();
        const ackMock = jest.fn().mockRejectedValue(new Error('network_down'));

        const stats = await runAckRetrySweep({
            pool, audit,
            acknowledgeGooglePurchase: ackMock,
            packageName: DEFAULT_PKG,
        });

        expect(stats.failed).toBe(1);
        expect(orders[0].ack_state).toBe('pending');
        expect(orders[0].ack_attempts).toBe(1);

        const warn = audit.entries.find(
            e => e.level === 'warn' && e.meta && e.meta.result === 'retry_failed'
        );
        expect(warn.meta.metadata.last_error).toBe('network_down');
    });

    test('case 8: batch run — mix of success, first-failure, and exhaust in one pass', async () => {
        const orders = [
            makeOrder({ id: 'ok',     external_raw: { productId: 'p1', purchaseToken: 't1', packageName: 'pkg' } }),
            makeOrder({ id: 'first',  external_raw: { productId: 'p2', purchaseToken: 't2', packageName: 'pkg' } }),
            makeOrder({ id: 'final',  ack_attempts: 2, external_raw: { productId: 'p3', purchaseToken: 't3', packageName: 'pkg' } }),
        ];
        const pool = makePool(orders);
        const audit = makeAudit();

        // Script per-token behavior
        const ackMock = jest.fn().mockImplementation(async (_pkg, _pid, token) => {
            if (token === 't1') return { ok: true };
            if (token === 't2') return { ok: false, error: 'ack_http_503' };
            if (token === 't3') return { ok: false, error: 'ack_http_403' };
            throw new Error(`unexpected token ${token}`);
        });

        const stats = await runAckRetrySweep({
            pool, audit,
            acknowledgeGooglePurchase: ackMock,
            packageName: DEFAULT_PKG,
        });

        expect(stats).toMatchObject({ scanned: 3, acked: 1, failed: 1, exhausted: 1, skipped: 0 });
        expect(orders.find(o => o.id === 'ok').ack_state).toBe('acked');
        expect(orders.find(o => o.id === 'first').ack_state).toBe('pending');
        expect(orders.find(o => o.id === 'first').ack_attempts).toBe(1);
        expect(orders.find(o => o.id === 'final').ack_state).toBe('failed');
        expect(orders.find(o => o.id === 'final').ack_attempts).toBe(3);
    });

    test('uses row.external_raw.packageName when present, falls back to packageName arg', async () => {
        const orders = [
            makeOrder({ id: 'row-pkg', external_raw: {
                productId: 'ec.topup.starter',
                purchaseToken: 'tok-row-pkg',
                packageName: 'com.historic.bundle',  // different from current deploy
            }}),
            makeOrder({ id: 'no-pkg', external_raw: {
                productId: 'ec.topup.starter',
                purchaseToken: 'tok-fallback',
                // no packageName → should use the arg fallback
            }}),
        ];
        const pool = makePool(orders);
        const audit = makeAudit();
        const ackMock = jest.fn().mockResolvedValue({ ok: true });

        await runAckRetrySweep({
            pool, audit,
            acknowledgeGooglePurchase: ackMock,
            packageName: 'com.hank.clawlive',
        });

        expect(ackMock).toHaveBeenCalledWith('com.historic.bundle', 'ec.topup.starter', 'tok-row-pkg');
        expect(ackMock).toHaveBeenCalledWith('com.hank.clawlive',   'ec.topup.starter', 'tok-fallback');
    });

    test('throws when pool or ack helper is missing', async () => {
        await expect(runAckRetrySweep({})).rejects.toThrow('pool_required');
        await expect(runAckRetrySweep({ pool: { query: () => {} } }))
            .rejects.toThrow('acknowledgeGooglePurchase_required');
    });

    test('MAX_ATTEMPTS is 3 and REFUND_WINDOW_MS is 72h', () => {
        expect(MAX_ATTEMPTS).toBe(3);
        expect(REFUND_WINDOW_MS).toBe(72 * 60 * 60 * 1000);
    });
});
