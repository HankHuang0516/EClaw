'use strict';
require('./helpers/mock-setup');
jest.mock('../../../tools/aihankapps-gifts/lib/adapters/transport', () => ({ runRailway: jest.fn() }));
jest.mock('../../../tools/aihankapps-hub/triage', () => ({ HUB: {}, containerScript: (_script, request) => JSON.stringify(request) }));
const fs = require('fs');
const crypto = require('crypto');
const { runRailway } = require('../../../tools/aihankapps-gifts/lib/adapters/transport');
const operator = require('../../../tools/aihankapps-hub/qa');
const qa = require('../../aihankapps-hub-qa');
const { run } = require('../../scripts/aihankapps-hub-qa');
const pool = require('../../db')._mockPool;
const legacy = 'timehut-batch01', next = 'timehut-batch02';
const gif = Buffer.from('GIF89a' + '0'.repeat(8));
const sha256 = crypto.createHash('sha256').update(gif).digest('hex');
const success = { success: true };
function requests() { return runRailway.mock.calls.map(call => JSON.parse(call[1])); }
function input(value) { jest.spyOn(fs, 'readFileSync').mockImplementation(file => file === 'input.json' ? JSON.stringify(value) : gif); }
function uploads(batch) {
    return Array.from({ length: 10 }, (_, n) => ({ item: String(n + 1).padStart(2, '0'), path: 'original.gif', size: gif.length, sha256, ...(batch === undefined ? {} : { batch }) }));
}
beforeEach(() => { runRailway.mockReset(); runRailway.mockReturnValue({ value: success }); });

test('read 0 keeps the legacy envelope; selected reads forward batch without changing the cursor', async () => {
    await expect(operator.main(['read', '0'])).resolves.toEqual(success);
    await operator.main(['read', '123', next]);
    expect(requests()).toEqual([{ action: 'read', after: '0' }, { action: 'read', after: '123', batch: next }]);
    const read = jest.spyOn(qa, 'read').mockResolvedValue(success);
    await run(pool, { action: 'read', after: 0 });
    expect(read).toHaveBeenLastCalledWith(pool, { after: '0', limit: 500 });
    await run(pool, { action: 'read', after: '123', batch: next, limit: 2 });
    expect(read).toHaveBeenLastCalledWith(pool, { after: '123', batch: next, limit: 2 });
});

test.each([null, '', 'timehut-batch00', 'timehut-batch000000', 'timehut-batch1', 'timehut-batch1234567', '../timehut-batch02', 2])('explicit invalid read batch is rejected before transport: %p', async batch => {
    await expect(operator.main(['read', '0', batch])).rejects.toThrow('QA_BATCH');
    expect(runRailway).not.toHaveBeenCalled();
});

test.each([legacy, next, 'timehut-batch000001', 'timehut-batch999999', undefined])('upload binds every original to its batch, defaulting only absent batch: %p', async batch => {
    input(uploads(batch));
    const url = 'https://synthetic.r2.cloudflarestorage.com/private?signature=synthetic';
    runRailway.mockReturnValue({ value: { success: true, media: { key: 'private', url } } });
    const send = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true });
    const stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const answer = await operator.main(['upload', 'input.json']);
    expect(requests()).toEqual(uploads(batch).map(v => ({ action: 'prepare-media', batch: batch === undefined ? legacy : batch, item: v.item, sha256, size: gif.length })));
    expect(answer.receipts).toHaveLength(10);
    expect(answer.receipts.every(r => r.batch === (batch === undefined ? legacy : batch) && r.uploaded)).toBe(true);
    expect(send).toHaveBeenCalledTimes(10);
    expect(send.mock.calls[0][1]).toMatchObject({ method: 'PUT', body: gif, headers: { 'Content-Type': 'image/gif' } });
    expect(JSON.stringify([answer, stdout.mock.calls, stderr.mock.calls])).not.toMatch(/signature=|cloudflarestorage|private/);
});

test.each([null, '', false, 2, 'timehut-batch00', 'timehut-batch1234567'])('invalid explicit upload batch never silently becomes legacy: %p', async batch => {
    const list = uploads(next); list[9].batch = batch; input(list);
    await expect(operator.main(['upload', 'input.json'])).rejects.toThrow('QA_BATCH');
    expect(runRailway).not.toHaveBeenCalled();
});

test('upload uses each entry batch rather than a file-wide or active batch', async () => {
    const list = uploads(next); delete list[0].batch; list[1].batch = 'timehut-batch03'; input(list);
    runRailway.mockReturnValue({ value: { success: true, media: { url: 'https://synthetic.r2.cloudflarestorage.com/x' } } });
    jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true });
    jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const answer = await operator.main(['upload', 'input.json']);
    const batches = [legacy, 'timehut-batch03', ...Array(8).fill(next)];
    expect(requests().map(r => r.batch)).toEqual(batches);
    expect(answer.receipts.map(r => r.batch)).toEqual(batches);
});

test('upload preserves list and changed-original guards before requesting a capability', async () => {
    input([]); await expect(operator.main(['upload', 'input.json'])).rejects.toThrow('QA_UPLOAD_LIST');
    fs.readFileSync.mockRestore();
    const list = uploads(next); list[0].sha256 = '0'.repeat(64); input(list);
    await expect(operator.main(['upload', 'input.json'])).rejects.toThrow('QA_LOCAL_CHANGED');
    expect(runRailway).not.toHaveBeenCalled();
});

test.each(['http://synthetic.r2.cloudflarestorage.com/x', 'https://example.invalid/x'])('upload rejects a capability outside the HTTPS R2 origin: %s', async url => {
    input(uploads(next)); runRailway.mockReturnValue({ value: { success: true, media: { url } } });
    const send = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('NETWORK_FORBIDDEN'));
    await expect(operator.main(['upload', 'input.json'])).rejects.toThrow('QA_UPLOAD_ORIGIN');
    expect(send).not.toHaveBeenCalled();
});

test('upload stops on HTTP failure without returning a capability', async () => {
    input(uploads(next)); runRailway.mockReturnValue({ value: { success: true, media: { url: 'https://synthetic.r2.cloudflarestorage.com/x' } } });
    jest.spyOn(global, 'fetch').mockResolvedValue({ ok: false, status: 403 });
    await expect(operator.main(['upload', 'input.json'])).rejects.toThrow('QA_UPLOAD_HTTP_403');
    expect(runRailway).toHaveBeenCalledTimes(1);
});

test('publish preserves the exact snapshot ID and archive payload through both bridges', async () => {
    const batch = { id: next, app: 'timehut', reviewState: 'archived', items: [] };
    input(batch); await operator.main(['publish', 'input.json']);
    expect(requests()).toEqual([{ action: 'publish', batch }]);
    const publish = jest.spyOn(qa, 'publish').mockResolvedValue(success);
    await run(pool, requests()[0]); expect(publish).toHaveBeenCalledWith(pool, batch);
});

test.each([undefined, next])('results preserve optional batch and exact globally unique key: %p', async batch => {
    const value = { key: 'batch02-fix-01', item: '01', commentId: '123', body: 'Synthetic result', ...(batch === undefined ? {} : { batch }) };
    input(value); await operator.main(['result', 'input.json']);
    expect(requests()).toEqual([{ ...value, action: 'result' }]);
    const result = jest.spyOn(qa, 'result').mockResolvedValue(success);
    await run(pool, requests()[0]); expect(result).toHaveBeenCalledWith(pool, { ...value, action: 'result' });
});

test('container prepare-media preserves batch and returns capabilities only to the bridge', async () => {
    const value = { action: 'prepare-media', batch: next, item: '01', sha256, size: gif.length };
    const media = { key: 'synthetic', url: 'https://synthetic.invalid/signed' };
    const prepare = jest.spyOn(qa, 'prepareMedia').mockResolvedValue(media);
    await expect(run(pool, value)).resolves.toEqual({ success: true, media });
    expect(prepare).toHaveBeenCalledWith(value);
});

test('backend batch conflicts propagate unchanged through the operator', async () => {
    input({ id: next }); runRailway.mockReturnValue({ value: { success: false, error: 'QA_ACTIVE_BATCH_CONFLICT' } });
    await expect(operator.main(['publish', 'input.json'])).rejects.toThrow('QA_ACTIVE_BATCH_CONFLICT');
    expect(pool.query).not.toHaveBeenCalled();
});

test('updates paginates ALL batches and retains active/cleared direct replies and checkpoint semantics', () => {
    const active = 'human-timehut-qa-review-batch02', closed = 'human-timehut-qa-review-batch01';
    const checkpoint = { batch: next, lastFetchedCursor: '4', lastFullyHandledCursor: '3' };
    const before = JSON.stringify(checkpoint);
    const qaRead = jest.fn()
        .mockReturnValueOnce({ success: true, batch: { id: next, reviewState: 'active' }, comments: [{ id: '5', batch: legacy }], nextCursor: '5', hasMore: true })
        .mockReturnValueOnce({ success: true, batch: { id: next, reviewState: 'active' }, comments: [{ id: '6', batch: next }], nextCursor: '6', hasMore: false });
    const answer = operator.collectUpdates(checkpoint, { qaRead, alertsRead: () => ({ alerts: [{ id: active, ack: { at: 20, planAt: 21, plan: 'Active reply' } }], acks: [{ id: closed, at: 10, planAt: 11, plan: 'Closed reply' }] }) });
    expect(qaRead.mock.calls.map(c => c[0])).toEqual([{ action: 'read', after: '4' }, { action: 'read', after: '5' }]);
    expect(answer.comments.map(c => [c.id, c.batch])).toEqual([['5', legacy], ['6', next]]);
    expect(answer.alertResponses).toEqual(expect.arrayContaining([expect.objectContaining({ id: active, active: true, plan: 'Active reply' }), expect.objectContaining({ id: closed, active: false, plan: 'Closed reply' })]));
    expect(answer.nextCursor).toBe('6'); expect(answer.batchState).toBe('active');
    expect(JSON.stringify(checkpoint)).toBe(before);
});

const ref = n => 'human-timehut-qa-review-' + String(n).padStart(4, '0');
const commentPage = { success: true, batch: null, comments: [], nextCursor: '0', hasMore: false };
function snapshotTransport(snapshot, pages) {
    runRailway.mockImplementation((_target, payload) => {
        if (payload === undefined) return { value: snapshot };
        const request = JSON.parse(payload);
        if (request.action !== 'alert-replies') throw new Error('UNEXPECTED_ACTION');
        return { value: pages(request) };
    });
}

test('supplement pages over 500 old acknowledgements and finds a late changed plan on a closed review', () => {
    const now = 2000000000000, oldAt = now - 90 * 86400000;
    const acks = Array.from({ length: 502 }, (_, n) => ({ id: ref(n), at: oldAt, planAt: n === 501 ? now : oldAt, plan: n === 501 ? 'Late changed closed plan' : 'Current plan ' + n, title: 'Synthetic', triage: null, answered: false }));
    const snapshot = { success: true, computedAt: now - 1, alerts: [{ id: ref(0), severity: 'high', ack: { at: oldAt, planAt: oldAt, plan: 'Stale active plan' } }],
        acks: [{ id: ref(0), at: oldAt, planAt: oldAt, plan: 'Stale active plan', extra: 'retained' }, { id: 'other-app', plan: 'Unrelated' }] };
    const observed = [];
    snapshotTransport(snapshot, request => {
        observed.push(request);
        const start = request.after === '' ? 0 : Number(request.after.slice(-4)) + 1;
        const rows = acks.slice(start, start + request.limit);
        return { success: true, acks: rows, nextCursor: rows.at(-1).id, hasMore: rows.length === request.limit };
    });
    const cp = { lastFetchedCursor: '0', lastFullyHandledCursor: '0', alertReplies: { [ref(501)]: { signature: 'previous-plan-signature', status: 'DONE' } } };
    const before = JSON.stringify(cp), original = JSON.stringify(snapshot);
    const answer = operator.collectUpdates(cp, { qaRead: () => commentPage });
    expect(observed).toEqual(['', ref(99), ref(199), ref(299), ref(399), ref(499)].map(after => ({ action: 'alert-replies', after, limit: 100 })));
    expect(answer.alertReplySource).toEqual({ mode: 'timehut-paginated', complete: true, pages: 6 });
    expect(answer.alertResponses).toHaveLength(502);
    expect(answer.alertResponses).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: ref(0), active: true, plan: 'Current plan 0' }),
        expect.objectContaining({ id: ref(501), active: false, at: oldAt, planAt: now, plan: 'Late changed closed plan', answered: false })
    ]));
    expect(JSON.stringify(cp)).toBe(before); expect(JSON.stringify(snapshot)).toBe(original);
    const merged = operator.alertSnapshot();
    expect(merged.acks.find(a => a.id === ref(0))).toMatchObject({ extra: 'retained', plan: 'Current plan 0' });
    expect(merged.acks.find(a => a.id === 'other-app')).toEqual(snapshot.acks[1]);
    expect(merged.alerts[0]).toMatchObject({ id: ref(0), severity: 'high', ack: { plan: 'Current plan 0' } });
});

test('completed supplement is authoritative for removed ack facts without removing an active warning', () => {
    const snapshot = { success: true, alerts: [{ id: ref(1), triage: { state: 'human' }, ack: { at: 1, plan: 'Removed plan' } }], acks: [{ id: ref(1), at: 1, plan: 'Removed plan' }] };
    snapshotTransport(snapshot, () => ({ success: true, acks: [], nextCursor: '', hasMore: false }));
    const merged = operator.alertSnapshot();
    expect(merged.alerts[0]).toMatchObject({ id: ref(1), ack: null, triage: { state: 'human' } });
    expect(merged.acks).toEqual([]);
    const answer = operator.collectUpdates({}, { qaRead: () => commentPage });
    expect(answer.alertResponses).toEqual([]);
    expect(answer.alertStates).toEqual([expect.objectContaining({ id: ref(1), active: true, confirmed: false })]);
});

test('supplement bounds long UTF-8 plans and notes below the transport stdout buffer per page', () => {
    snapshotTransport({ success: true }, request => {
        expect(request.limit).toBe(100);
        const rows = request.after === '' ? Array.from({ length: request.limit }, (_, n) => ({ id: ref(n), at: 1, planAt: 2, title: '題'.repeat(200), plan: '策'.repeat(1000), triage: { state: 'done', note: '註'.repeat(1000), at: 3 }, answered: true })) : [];
        const page = { success: true, acks: rows, nextCursor: rows.length ? rows.at(-1).id : request.after, hasMore: rows.length === request.limit };
        expect(Buffer.byteLength('GIFT_RESULT ' + JSON.stringify(page))).toBeLessThan(1024 * 1024);
        return page;
    });
    expect(operator.alertSnapshot().acks).toHaveLength(100);
});

test('current production unknown action keeps the legacy snapshot and discloses incomplete late-reply coverage', () => {
    const snapshot = { success: true, alerts: [{ id: ref(1), ack: { at: 1, plan: 'Legacy active reply' } }], acks: [{ id: ref(2), at: 2, plan: 'Legacy closed reply' }] };
    snapshotTransport(snapshot, () => ({ success: false, error: 'QA_ACTION' }));
    const answer = operator.collectUpdates({}, { qaRead: () => commentPage });
    expect(answer.alertReplySource).toEqual({ mode: 'legacy-alerts', complete: false, reason: 'QA_ACTION' });
    expect(answer.alertResponses).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: ref(1), active: true, plan: 'Legacy active reply' }),
        expect.objectContaining({ id: ref(2), active: false, plan: 'Legacy closed reply' })
    ]));
});

test.each(['QA_ALERT_CURSOR', 'QA_OPERATOR_FAILED', 'QA_REMOTE_FAILED', 'DB_UNAVAILABLE'])('supplement error propagates without pretending legacy coverage: %s', error => {
    snapshotTransport({ success: true, alerts: [], acks: [] }, () => ({ success: false, error }));
    const qaRead = jest.fn();
    expect(() => operator.collectUpdates({}, { qaRead })).toThrow(error);
    expect(qaRead).not.toHaveBeenCalled();
});

test('failure after a successful page aborts rather than returning partial acknowledgement history', () => {
    snapshotTransport({ success: true, alerts: [], acks: [] }, request => request.after === ''
        ? { success: true, acks: [{ id: ref(1), at: 1 }], nextCursor: ref(1), hasMore: true }
        : { success: false, error: 'QA_OPERATOR_FAILED' });
    expect(() => operator.alertSnapshot()).toThrow('QA_OPERATOR_FAILED');
});

test('repeated reply cursor is detected before polling another page', () => {
    snapshotTransport({ success: true, alerts: [], acks: [] }, () => ({ success: true, acks: [{ id: ref(1) }], nextCursor: ref(1), hasMore: true }));
    expect(() => operator.alertSnapshot()).toThrow('QA_ALERT_CURSOR_STALLED');
    expect(runRailway).toHaveBeenCalledTimes(3);
});

test('empty unfinished page cannot stall the reply scan', () => {
    snapshotTransport({ success: true }, () => ({ success: true, acks: [], nextCursor: '', hasMore: true }));
    expect(() => operator.alertSnapshot()).toThrow('QA_ALERT_CURSOR_STALLED');
});

test.each([
    { acks: null, nextCursor: '', hasMore: false },
    { acks: [{ id: 'other-app' }], nextCursor: 'other-app', hasMore: false },
    { acks: [{ id: ref(1) }], nextCursor: ref(2), hasMore: false },
    { acks: [], nextCursor: '', hasMore: 'true' }
])('malformed supplement page fails closed: %p', page => {
    snapshotTransport({ success: true }, () => ({ success: true, ...page }));
    expect(() => operator.alertSnapshot()).toThrow('QA_ALERT_REPLY_PAGE');
});

test('failed global alert snapshot does not trigger a supplement or a degraded success', () => {
    runRailway.mockReturnValue({ value: { success: false, error: 'ALERTS_FAILED' } });
    expect(() => operator.alertSnapshot()).toThrow('QA_ALERTS_FAILED');
    expect(runRailway).toHaveBeenCalledTimes(1);
});

test.each([{}, { after: ref(2), limit: 2 }, { after: null, limit: 0 }])('container alert-replies forwards explicit values and only defaults omissions: %p', options => {
    const answer = { success: true, acks: [], nextCursor: '', hasMore: false };
    const read = jest.spyOn(qa, 'alertReplies').mockResolvedValue(answer);
    return run(pool, { action: 'alert-replies', ...options }).then(value => {
        expect(value).toEqual(answer);
        expect(read).toHaveBeenCalledWith(pool, { after: options.after === undefined ? '' : options.after, limit: options.limit === undefined ? 500 : options.limit });
        expect(pool.query).not.toHaveBeenCalled();
    });
});
