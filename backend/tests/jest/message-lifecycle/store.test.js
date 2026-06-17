'use strict';

// DB-backed lifecycle store tests against an in-memory Postgres (pg-mem).
//
// Card: card_1b1c13225f10e8a803cef532 (Phase 2 Step 3 — dual-write store).
// Spec: docs/specs/message-lifecycle-spec.md §9 acceptance scenarios.
//
// Coverage of the spec §9 scenarios:
//   9.1  Idempotent transition                 — here (idempotent_noop audit)
//   9.2  Monotonic — late event rejected        — here (rejected_late audit)
//   9.3  Out-of-order — skip intermediate state — here (skipped_states + late reject)
//   9.4  Unknown stays unknown — backfilled row  — here (backfill+link, SLO numerator)
//   9.5  Heuristic backfill flagged             — here (backfill+heuristic last_error)
//   9.6  Stuck alert + cooldown                  — sweeper-policy test (here, via store + wheel)
//   9.7  Timeout NEVER folds into user_seen      — here (real_user_seen_rate SQL)
//   9.8  Reply-chain link integrity             — here (outbound row + inbound advance)
//   9.9  Redis lost — cold start                 — deadline-wheel.test.js (Step 2)
//   9.10 Dual-write divergence detector          — here (recordDivergence + summary)

const { newDb } = require('pg-mem');

function makePool() {
    const db = newDb();
    const { Pool } = db.adapters.createPg();
    return new Pool();
}

// Fresh store module + pool per test so module-level `pool` never leaks.
function freshStore() {
    jest.resetModules();
    const store = require('../../../lib/message-lifecycle/store');
    const pool = makePool();
    return { store, pool };
}

const ISO = (s) => new Date(s);

describe('lifecycle store (pg-mem)', () => {
    let store, pool;

    beforeEach(async () => {
        ({ store, pool } = freshStore());
        await store.initTable(pool);
    });

    async function seedInbound(messageId, opts = {}) {
        return store.transition({
            messageId,
            targetState: 'inbound_seen',
            eventAt: opts.eventAt || ISO('2026-06-16T00:00:00Z'),
            source: opts.source || 'trackOutbound',
            create: {
                deviceId: opts.deviceId || 'd1',
                entityId: opts.entityId ?? 2,
                tenantId: opts.deviceId || 'd1',
                direction: 'inbound',
            },
            rowSource: opts.rowSource,
        });
    }

    test('§9.1 idempotent transition — second apply is idempotent_noop', async () => {
        await seedInbound('m1');
        const a = await store.transition({ messageId: 'm1', targetState: 'bot_acked', eventAt: ISO('2026-06-16T00:00:30Z'), source: 'markReplyReceived' });
        const b = await store.transition({ messageId: 'm1', targetState: 'bot_acked', eventAt: ISO('2026-06-16T00:00:30Z'), source: 'markReplyReceived' });
        expect(a.applied).toBe('accepted');
        expect(b.applied).toBe('idempotent_noop');

        const row = await store.getLifecycle('m1');
        expect(row.state).toBe('bot_acked');
        expect(row.bot_acked_at).toBeTruthy();

        const log = await store.getEventLog('m1');
        const acked = log.filter(e => e.attempted_state === 'bot_acked');
        expect(acked.map(e => e.applied).sort()).toEqual(['accepted', 'idempotent_noop']);
    });

    test('§9.2 monotonic — late bot_acked after the row advanced past it is rejected_late, *_at not overwritten', async () => {
        // Spec §9.2: the row is at push_delivered; a bot_acked event arrives
        // late. Per §2.3 rule 3 the row reached push_delivered by SKIPPING
        // bot_acked (push delivered before the bot_acked signal landed), so
        // bot_acked_at is NULL and the late event must be rejected, NOT
        // backfilled. (If bot_acked_at were already set the correct verdict is
        // idempotent_noop — covered in §9.1.)
        await seedInbound('m2');
        await store.transition({ messageId: 'm2', targetState: 'push_delivered', eventAt: ISO('2026-06-16T00:01:00Z'), source: 's' });

        const before = await store.getLifecycle('m2');
        expect(before.state).toBe('push_delivered');
        expect(before.bot_acked_at).toBeNull(); // skipped

        const late = await store.transition({ messageId: 'm2', targetState: 'bot_acked', eventAt: ISO('2026-06-16T00:02:00Z'), source: 's' });
        const after = await store.getLifecycle('m2');

        expect(late.applied).toBe('rejected_late');
        expect(after.state).toBe('push_delivered');
        expect(after.bot_acked_at).toBeNull(); // NEVER backfilled

        const log = await store.getEventLog('m2');
        const lateRows = log.filter(e => e.attempted_state === 'bot_acked' && e.applied === 'rejected_late');
        expect(lateRows).toHaveLength(1);
    });

    test('§9.3 out-of-order — inbound_seen → user_seen skips, intermediate *_at stay NULL, later bot_acked rejected', async () => {
        await seedInbound('m3');
        const jump = await store.transition({ messageId: 'm3', targetState: 'user_seen', eventAt: ISO('2026-06-16T00:00:10Z'), source: 'chat_read' });
        expect(jump.applied).toBe('accepted');

        const row = await store.getLifecycle('m3');
        expect(row.state).toBe('user_seen');
        expect(row.skipped_states.sort()).toEqual(['bot_acked', 'push_delivered']);
        expect(row.bot_acked_at).toBeNull();
        expect(row.push_delivered_at).toBeNull();
        expect(row.user_seen_at).toBeTruthy();

        const late = await store.transition({ messageId: 'm3', targetState: 'bot_acked', eventAt: ISO('2026-06-16T00:01:00Z'), source: 's' });
        expect(late.applied).toBe('rejected_late');
        const after = await store.getLifecycle('m3');
        expect(after.bot_acked_at).toBeNull(); // NEVER backfilled
    });

    test('§9.4 backfill+link — bot_acked set, push/user NULL, counts in denominator not numerator', async () => {
        const fetchInbound = async () => ({ device_id: 'd1', entity_id: 2, created_at: ISO('2026-06-16T00:00:00Z'), is_from_user: true });
        const findReply = async () => ({ created_at: ISO('2026-06-16T00:00:20Z') });
        const row = await store.backfillLifecycle('m4', { fetchInbound, findReply });

        expect(row.state).toBe('bot_acked');
        expect(row.bot_acked_at).toBeTruthy();
        expect(row.push_delivered_at).toBeNull();
        expect(row.user_seen_at).toBeNull();
        expect(row.source).toBe('backfill+link');

        // SLO: real_user_seen_rate numerator requires user_seen_at IS NOT NULL.
        // COUNT(col) counts only non-null values — the standard-SQL spelling of
        // the §6.2 numerator (no COALESCE permitted, constraint #2).
        const r = await pool.query(`
            SELECT COUNT(user_seen_at)::int AS num, COUNT(*)::int AS den
            FROM message_lifecycle WHERE message_id = 'm4'`);
        expect(r.rows[0].num).toBe(0); // counted as a miss
        expect(r.rows[0].den).toBe(1);
    });

    test('§9.5 heuristic backfill — source flagged + non-null last_error', async () => {
        const fetchInbound = async () => ({ device_id: 'd1', entity_id: 2, created_at: ISO('2026-06-16T00:00:00Z'), is_from_user: true });
        const findReply = async () => null; // no explicit link
        const findNearestOutbound = async () => ({ created_at: ISO('2026-06-16T00:01:30Z') }); // 90s later
        const row = await store.backfillLifecycle('m5', { fetchInbound, findReply, findNearestOutbound });

        expect(row.state).toBe('bot_acked');
        expect(row.source).toBe('backfill+heuristic');
        expect(row.last_error).toBeTruthy();
        expect(row.push_delivered_at).toBeNull();
        expect(row.user_seen_at).toBeNull();
    });

    test('§9.5b backfill of a non-inbound message returns null (never fabricates)', async () => {
        const fetchInbound = async () => ({ device_id: 'd1', entity_id: 2, created_at: ISO('2026-06-16T00:00:00Z'), is_from_user: false });
        const row = await store.backfillLifecycle('m5b', { fetchInbound });
        expect(row).toBeNull();
    });

    test('§9.7 timeout NEVER folds into user_seen success — 50/30/20 split → rate = 0.5', async () => {
        // 50 user_seen, 30 stuck at push_delivered, 20 stuck at bot_acked.
        let n = 0;
        for (let i = 0; i < 50; i++) {
            const id = `seen_${i}`; n++;
            await seedInbound(id, { eventAt: ISO('2026-06-16T00:00:00Z') });
            await store.transition({ messageId: id, targetState: 'bot_acked', eventAt: ISO('2026-06-16T00:00:10Z'), source: 's' });
            await store.transition({ messageId: id, targetState: 'push_delivered', eventAt: ISO('2026-06-16T00:00:20Z'), source: 's' });
            await store.transition({ messageId: id, targetState: 'user_seen', eventAt: ISO('2026-06-16T00:00:30Z'), source: 's' });
        }
        for (let i = 0; i < 30; i++) {
            const id = `pd_${i}`;
            await seedInbound(id, { eventAt: ISO('2026-06-16T00:00:00Z') });
            await store.transition({ messageId: id, targetState: 'bot_acked', eventAt: ISO('2026-06-16T00:00:10Z'), source: 's' });
            await store.transition({ messageId: id, targetState: 'push_delivered', eventAt: ISO('2026-06-16T00:00:20Z'), source: 's' });
        }
        for (let i = 0; i < 20; i++) {
            const id = `ba_${i}`;
            await seedInbound(id, { eventAt: ISO('2026-06-16T00:00:00Z') });
            await store.transition({ messageId: id, targetState: 'bot_acked', eventAt: ISO('2026-06-16T00:00:10Z'), source: 's' });
        }

        const r = await pool.query(`
            SELECT COUNT(user_seen_at)::int AS num, COUNT(*)::int AS den
            FROM message_lifecycle`);
        const rate = r.rows[0].num / r.rows[0].den;
        expect(r.rows[0].den).toBe(100);
        expect(r.rows[0].num).toBe(50);
        expect(rate).toBe(0.5);
    });

    test('§9.8 reply-chain — outbound row created with reply_to; inbound advances to bot_acked', async () => {
        await seedInbound('m7_in');
        // Outbound reply recorded as its own lifecycle row (direction=outbound).
        await store.transition({
            messageId: 'm7_out',
            targetState: 'inbound_seen', // an outbound row also starts at its own creation
            eventAt: ISO('2026-06-16T00:00:40Z'),
            source: 'transform',
            create: { deviceId: 'd1', entityId: 2, tenantId: 'd1', direction: 'outbound', replyToMessageId: 'm7_in' },
        });
        // The inbound advances to bot_acked at the outbound's creation time.
        await store.transition({ messageId: 'm7_in', targetState: 'bot_acked', eventAt: ISO('2026-06-16T00:00:40Z'), source: 'transform' });

        const inbound = await store.getLifecycle('m7_in');
        const outbound = await store.getLifecycle('m7_out');
        expect(inbound.state).toBe('bot_acked');
        expect(outbound.direction).toBe('outbound');
        expect(outbound.reply_to_message_id).toBe('m7_in');
    });

    test('§9.10 dual-write divergence — recorded + surfaced by summary gate', async () => {
        await store.recordDivergence({
            messageId: 'm8', deviceId: 'd1', entityId: 2,
            legacyCounter: 'chat_no_reply', direction: 'lifecycle_skipped',
            reason: 'legacy ticked, lifecycle missing',
        });
        const summary = await store.divergenceSummary({ windowHours: 168, newAlertVolume: 80, legacyAlertVolume: 100 });
        expect(summary.divergenceEvents).toBe(1);
        expect(summary.ratio).toBeCloseTo(0.8, 5);
        expect(summary.withinGate).toBe(false); // 0.8 is outside ±10%

        const ok = await store.divergenceSummary({ windowHours: 168, newAlertVolume: 95, legacyAlertVolume: 100 });
        expect(ok.withinGate).toBe(true); // 0.95 within ±10%
    });

    test('rejected_unknown_message — later state with no row never fabricates inbound', async () => {
        const v = await store.transition({ messageId: 'ghost', targetState: 'push_delivered', source: 's' });
        expect(v.applied).toBe('rejected_unknown_message');
        const row = await store.getLifecycle('ghost');
        expect(row).toBeNull();
    });
});

describe('§9.6 stuck alert + cooldown (sweeper policy over store + wheel)', () => {
    const { createWheel, createInMemoryClient } = require('../../../lib/message-lifecycle/deadline-wheel');

    let store, pool, wheel;

    beforeEach(async () => {
        ({ store, pool } = freshStore());
        await store.initTable(pool);
        wheel = createWheel({ redisClient: createInMemoryClient() });
        store.setWheel(wheel);
    });

    // Reproduce the boot onDue policy (index.js) against the store + wheel so
    // the cooldown contract in spec §9.6 is verified without a live server.
    function makeOnDue(nowRef) {
        return async (messageId) => {
            const row = await store.getLifecycle(messageId);
            if (!row || row.state === 'user_seen') return;
            const cooldownMs = 60_000;
            const now = nowRef.now;
            const alertedAt = row.alerted_at ? new Date(row.alerted_at).getTime() : 0;
            let alerted = false;
            if (!alertedAt || (now - alertedAt) > cooldownMs) {
                if (row.state !== 'push_delivered') {
                    alerted = true;
                    await pool.query(
                        `UPDATE message_lifecycle SET alerted_at = $2 WHERE message_id = $1`,
                        [messageId, new Date(now).toISOString()]
                    );
                }
            }
            await wheel.requeue(messageId, now + cooldownMs);
            return alerted;
        };
    }

    test('alert fires, suppressed within cooldown, re-fires after cooldown, resets on advance', async () => {
        const nowRef = { now: ISO('2026-06-16T00:03:20Z').getTime() }; // 200s after inbound
        await store.transition({
            messageId: 'm6', targetState: 'inbound_seen', eventAt: ISO('2026-06-16T00:00:00Z'),
            source: 'trackOutbound', create: { deviceId: 'd1', entityId: 2, tenantId: 'd1', direction: 'inbound' },
        });
        await store.transition({ messageId: 'm6', targetState: 'bot_acked', eventAt: ISO('2026-06-16T00:00:00Z'), source: 's' });

        const onDue = makeOnDue(nowRef);

        // First sweep: bot_acked stuck → alert.
        const a1 = await onDue('m6');
        expect(a1).toBe(true);
        let row = await store.getLifecycle('m6');
        expect(row.alerted_at).toBeTruthy();

        // 30s later (< 60s cooldown): no re-alert.
        nowRef.now += 30_000;
        const a2 = await onDue('m6');
        expect(a2).toBe(false);

        // 90s after first alert (> cooldown): re-alert.
        nowRef.now += 60_000; // total +90s
        const a3 = await onDue('m6');
        expect(a3).toBe(true);

        // push_delivered arrives → advance, alerted_at reset, deadline cancel+rearm.
        await store.transition({ messageId: 'm6', targetState: 'push_delivered', eventAt: new Date(nowRef.now), source: 'channel_callback' });
        row = await store.getLifecycle('m6');
        expect(row.state).toBe('push_delivered');
        expect(row.alerted_at).toBeNull();

        // Now stuck at push_delivered → never pages (spec §6.4).
        nowRef.now += 1000;
        const a4 = await onDue('m6');
        expect(a4).toBe(false);
    });
});
