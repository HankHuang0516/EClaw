'use strict';

/**
 * card_errctr — Entity error counters: current (resettable) vs historical
 * (monotonic) + persisted error-event history (歷史紀錄).
 *
 * Owner P0 (2026-06-27): the single error counter must split into
 *   - 當下累計 / current cumulative  → `count`            (resettable)
 *   - 歷史累計 / historical cumulative → `historicalCount` (never resets)
 *   - 歷史紀錄 / history record        → entity_error_events timeline
 *
 * Each test below exercises a FAILURE PATH that FAILS on the pre-change code:
 *   - accumulate            → old getCounters had no historicalCount field
 *   - reset-keeps-historical→ old code had no resetCurrentCounters at all
 *   - history-write         → old code never persisted per-tick error events
 *   - history-survives-reset→ the core owner requirement (reset must not lose history)
 */

const fs = require('fs');
const path = require('path');
const entityStatus = require('../../entity-status');

// ────────────────────────────────────────────────────────────────────────────
// Stateful in-memory mock pool. Interprets just the queries this module issues
// against entity_error_counters / entity_error_events / outbound_msg_pending so
// the accumulate → reset → history semantics can be asserted end to end.
// ────────────────────────────────────────────────────────────────────────────
function makeStatefulPool() {
    const counters = new Map(); // `${device}|${entity}|${axis}` -> row
    let events = [];            // entity_error_events rows
    let pending = [];           // outbound_msg_pending rows
    let nextEventId = 1;
    const key = (d, e, a) => `${d}|${e}|${a}`;

    const pool = {
        // expose internals for test seeding/inspection
        _counters: counters,
        _events: () => events,
        _pending: pending,
        seedPending(row) {
            pending.push(Object.assign({
                id: pending.length + 1,
                dispatched_at: new Date(),
                expires_at: new Date(Date.now() - 1000), // already expired
            }, row));
        },
        async query(rawSql, params) {
            const sql = String(rawSql).replace(/\s+/g, ' ').trim();
            params = params || [];

            // initTable DDL (CREATE TABLE ... + ALTER ... + backfill UPDATE in
            // one combined string) — short-circuit so it doesn't match the
            // behavioral UPDATE/SELECT branches below.
            if (sql.includes('CREATE TABLE')) return { rows: [] };

            // UPSERT a counter (both incrementCounter + sweepExpired use this).
            if (sql.includes('INSERT INTO entity_error_counters')) {
                const [d, e, a] = params;
                const k = key(d, e, a);
                const existing = counters.get(k);
                if (existing) {
                    existing.count += 1;
                    existing.historical_count += 1;
                    existing.last_event_at = new Date();
                } else {
                    counters.set(k, {
                        device_id: d, entity_id: e, axis: a,
                        count: 1, historical_count: 1,
                        last_event_at: new Date(), current_reset_at: null,
                    });
                }
                return { rows: [], rowCount: 1 };
            }

            // INSERT an error event into the history timeline.
            if (sql.includes('INSERT INTO entity_error_events')) {
                const [d, e, a, et, sender, snippet, occ] = params;
                events.push({
                    id: nextEventId++,
                    device_id: d, entity_id: e, axis: a,
                    event_type: et, sender_entity_id: sender,
                    payload_snippet: snippet,
                    occurred_at: occ ? new Date(occ) : new Date(),
                });
                return { rows: [], rowCount: 1 };
            }

            // Prune: keep newest `cap` events per (device, entity).
            if (sql.includes('DELETE FROM entity_error_events')) {
                const [d, e, cap] = params;
                const mine = events
                    .filter(ev => ev.device_id === d && ev.entity_id === e)
                    .sort((x, y) => y.id - x.id);
                const keepIds = new Set(mine.slice(0, Number(cap)).map(ev => ev.id));
                const before = events.length;
                events = events.filter(ev =>
                    !(ev.device_id === d && ev.entity_id === e) || keepIds.has(ev.id));
                return { rows: [], rowCount: before - events.length };
            }

            // Reset current counters (count -> 0), historical untouched.
            if (sql.includes('UPDATE entity_error_counters')) {
                const d = params[0], e = params[1];
                const axisFilter = sql.includes('axis = $') ? params[2] : null;
                let n = 0;
                for (const row of counters.values()) {
                    if (row.device_id === d && row.entity_id === e
                        && (!axisFilter || row.axis === axisFilter)) {
                        row.count = 0;
                        row.current_reset_at = new Date();
                        n += 1;
                    }
                }
                return { rows: [], rowCount: n };
            }

            // getCounters main SELECT.
            if (sql.includes('FROM entity_error_counters')) {
                const [d, e] = params;
                const rows = [];
                for (const row of counters.values()) {
                    if (row.device_id === d && row.entity_id === e) {
                        rows.push({
                            axis: row.axis,
                            count: row.count,
                            historical_count: row.historical_count,
                            last_event_at: row.last_event_at,
                            current_reset_at: row.current_reset_at,
                        });
                    }
                }
                return { rows };
            }

            // getCounters open-count grouping.
            if (sql.includes('FROM outbound_msg_pending') && sql.includes('open_count')) {
                const [d, e] = params;
                const grouped = new Map();
                for (const p of pending) {
                    if (p.device_id === d && p.recipient_entity_id === e) {
                        grouped.set(p.axis, (grouped.get(p.axis) || 0) + 1);
                    }
                }
                return { rows: Array.from(grouped, ([axis, open_count]) => ({ axis, open_count })) };
            }

            // sweepExpired SELECT of expired pending rows.
            if (sql.includes('FROM outbound_msg_pending') && sql.includes('expires_at <= NOW()')) {
                const now = Date.now();
                return {
                    rows: pending
                        .filter(p => new Date(p.expires_at).getTime() <= now)
                        .map(p => ({
                            id: p.id, device_id: p.device_id,
                            recipient_entity_id: p.recipient_entity_id, axis: p.axis,
                            event_type: p.event_type, sender_entity_id: p.sender_entity_id,
                            payload_snippet: p.payload_snippet,
                        })),
                };
            }

            // sweepExpired DELETE by id list.
            if (sql.includes('DELETE FROM outbound_msg_pending')) {
                const ids = new Set((params[0] || []).map(Number));
                const before = pending.length;
                pending = pending.filter(p => !ids.has(Number(p.id)));
                return { rows: [], rowCount: before - pending.length };
            }

            // getErrorHistory SELECT.
            if (sql.includes('FROM entity_error_events')) {
                const d = params[0], e = params[1];
                let idx = 2;
                const axisFilter = sql.includes('axis = $') ? params[idx++] : null;
                const beforeId = sql.includes('id < $') ? params[idx++] : null;
                const limit = Number(params[idx]);
                let mine = events.filter(ev => ev.device_id === d && ev.entity_id === e);
                if (axisFilter) mine = mine.filter(ev => ev.axis === axisFilter);
                if (beforeId) mine = mine.filter(ev => ev.id < Number(beforeId));
                mine.sort((x, y) => y.id - x.id);
                return {
                    rows: mine.slice(0, limit).map(ev => ({
                        id: ev.id, axis: ev.axis, event_type: ev.event_type,
                        sender_entity_id: ev.sender_entity_id,
                        payload_snippet: ev.payload_snippet, occurred_at: ev.occurred_at,
                    })),
                };
            }

            return { rows: [] };
        },
    };
    return pool;
}

const DEVICE = 'devX';
const ENTITY = 2;
const findAxis = (counters, axis) => counters.find(c => c.axis === axis);

describe('entity error counters — current vs historical + history', () => {
    test('accumulate: each error bumps BOTH current (count) and historical (historicalCount)', async () => {
        const pool = makeStatefulPool();
        entityStatus.initTable(pool);
        await entityStatus.incrementCounter(DEVICE, ENTITY, 'a2a_no_reply');
        await entityStatus.incrementCounter(DEVICE, ENTITY, 'a2a_no_reply');

        const counters = await entityStatus.getCounters(DEVICE, ENTITY);
        const row = findAxis(counters, 'a2a_no_reply');
        // FAILS on old code: getCounters returned no historicalCount field.
        expect(row.count).toBe(2);
        expect(row.historicalCount).toBe(2);
    });

    test('reset clears CURRENT only — historical total + history record survive', async () => {
        const pool = makeStatefulPool();
        entityStatus.initTable(pool);
        for (let i = 0; i < 3; i++) {
            await entityStatus.incrementCounter(DEVICE, ENTITY, 'a2a_no_reply');
        }

        // FAILS on old code: resetCurrentCounters did not exist.
        const affected = await entityStatus.resetCurrentCounters(DEVICE, ENTITY);
        expect(affected).toBeGreaterThanOrEqual(1);

        const counters = await entityStatus.getCounters(DEVICE, ENTITY);
        const row = findAxis(counters, 'a2a_no_reply');
        expect(row.count).toBe(0);            // current cleared
        expect(row.historicalCount).toBe(3);  // historical preserved
        expect(row.currentResetAt).toBeTruthy();

        const hist = await entityStatus.getErrorHistory(DEVICE, ENTITY, {});
        expect(hist.items).toHaveLength(3);   // history untouched by reset
    });

    test('history-write: every increment appends a reviewable error event', async () => {
        const pool = makeStatefulPool();
        entityStatus.initTable(pool);
        await entityStatus.incrementCounter(DEVICE, ENTITY, 'chat_no_reply', {
            eventType: 'push_failure', payloadSnippet: 'push failed: push_timeout',
        });

        // FAILS on old code: getErrorHistory / entity_error_events did not exist.
        const hist = await entityStatus.getErrorHistory(DEVICE, ENTITY, {});
        expect(hist.items).toHaveLength(1);
        expect(hist.items[0].axis).toBe('chat_no_reply');
        expect(hist.items[0].eventType).toBe('push_failure');
        expect(hist.items[0].payloadSnippet).toContain('push_timeout');
        expect(hist.items[0].occurredAt).toBeTruthy();
    });

    test('sweepExpired: a silent recipient ticks BOTH counters AND writes history', async () => {
        const pool = makeStatefulPool();
        entityStatus.initTable(pool);
        pool.seedPending({
            device_id: DEVICE, sender_entity_id: 1, recipient_entity_id: ENTITY,
            event_type: 'entity_message', axis: 'a2a_no_reply',
            payload_snippet: 'hi from #1',
        });

        const res = await entityStatus.sweepExpired();
        expect(res.tickedCount).toBe(1);

        const counters = await entityStatus.getCounters(DEVICE, ENTITY);
        const row = findAxis(counters, 'a2a_no_reply');
        expect(row.count).toBe(1);
        expect(row.historicalCount).toBe(1);  // FAILS on old: only count ticked

        const hist = await entityStatus.getErrorHistory(DEVICE, ENTITY, {});
        expect(hist.items).toHaveLength(1);    // FAILS on old: sweep never wrote events
        expect(hist.items[0].axis).toBe('a2a_no_reply');
        expect(hist.items[0].senderEntityId).toBe(1);
        expect(hist.items[0].payloadSnippet).toBe('hi from #1');
    });

    test('core requirement: history record survives a current-counter reset, then keeps growing', async () => {
        const pool = makeStatefulPool();
        entityStatus.initTable(pool);
        await entityStatus.incrementCounter(DEVICE, ENTITY, 'a2a_no_reply');
        await entityStatus.incrementCounter(DEVICE, ENTITY, 'a2a_no_reply');
        await entityStatus.resetCurrentCounters(DEVICE, ENTITY);
        await entityStatus.incrementCounter(DEVICE, ENTITY, 'a2a_no_reply');

        const counters = await entityStatus.getCounters(DEVICE, ENTITY);
        const row = findAxis(counters, 'a2a_no_reply');
        expect(row.count).toBe(1);            // current restarted after reset
        expect(row.historicalCount).toBe(3);  // historical never reset

        const hist = await entityStatus.getErrorHistory(DEVICE, ENTITY, {});
        expect(hist.items).toHaveLength(3);    // all 3 events retained across the reset
    });

    test('getErrorHistory honours the axis filter', async () => {
        const pool = makeStatefulPool();
        entityStatus.initTable(pool);
        await entityStatus.incrementCounter(DEVICE, ENTITY, 'a2a_no_reply');
        await entityStatus.incrementCounter(DEVICE, ENTITY, 'chat_no_reply');

        const onlyChat = await entityStatus.getErrorHistory(DEVICE, ENTITY, { axis: 'chat_no_reply' });
        expect(onlyChat.items).toHaveLength(1);
        expect(onlyChat.items[0].axis).toBe('chat_no_reply');
    });
});

// ────────────────────────────────────────────────────────────────────────────
// Frontend contract (static analysis) — the panel must surface BOTH numbers
// (當下/歷史, EN+ZH), a reset affordance for the current counter, and a way to
// view the history. Mirrors the existing achievements UI contract test.
// ────────────────────────────────────────────────────────────────────────────
describe('entity-status-panel — current/historical/history UI contract', () => {
    const panelSrc = fs.readFileSync(
        path.join(__dirname, '..', '..', 'public', 'portal', 'shared', 'entity-status-panel.js'),
        'utf8'
    );

    test('renders both current and historical cumulative numbers from the API', () => {
        expect(panelSrc).toMatch(/historicalCount/);
        // bilingual labels for the two cumulative numbers (matches the section's
        // existing inline-bilingual pattern).
        expect(panelSrc).toMatch(/當下/);
        expect(panelSrc).toMatch(/歷史/);
    });

    test('has a reset affordance that POSTs the current-counter reset route', () => {
        expect(panelSrc).toMatch(/counter\/reset/);
        expect(panelSrc).toMatch(/reset-counters|resetCurrent|data-action="reset/);
    });

    test('fetches + renders the error history timeline', () => {
        expect(panelSrc).toMatch(/\/errors\?/);
        expect(panelSrc).toMatch(/error-history|errorHistory|歷史紀錄/);
    });

    test('error history section has an accessible collapsed dropdown toggle', () => {
        expect(panelSrc).toMatch(/data-action="toggle-error-history"/);
        expect(panelSrc).toMatch(/aria-expanded="false"/);
        expect(panelSrc).toMatch(/aria-controls="\$\{historyListId\}"/);
        expect(panelSrc).toMatch(/data-role="error-history-list" hidden/);
        expect(panelSrc).toMatch(/entityStatus\.historyExpanded\.\$\{eid\}/);
        expect(panelSrc).toMatch(/applyInitialErrorHistoryState\(root, eid\)/);
        expect(panelSrc).toMatch(/max-height 0\.2s ease/);
        expect(panelSrc).toMatch(/prefers-reduced-motion: reduce/);
        expect(panelSrc).toMatch(/function toggleErrorHistory\(/);
    });
});
