'use strict';
const { collectUpdates } = require('../../../tools/aihankapps-hub/qa');
const ref = 'human-timehut-qa-review-next58-r1';
const page = { success: true, batch: { reviewState: 'archived' }, comments: [], nextCursor: '0', hasMore: false };
const ack = { id: ref, at: 1000, planAt: 1000, plan: '已處理，移除舊項並進入下一階段', active: false, answered: false, triage: { state: 'done' } };
const read = (checkpoint, answers) => collectUpdates(checkpoint, { qaRead: () => page, alertsRead: () => ({ alerts: [], acks: answers }) });
test('reads direct alert replies even when their warning has cleared', () => {
    const r = read({}, [ack]); expect(r.alertResponses).toHaveLength(1); expect(r.alertResponses[0]).toMatchObject({ id: ref, kind: 'plan', active: false, plan: ack.plan }); expect(r.batchState).toBe('archived');
});
test('deduplicates completed responses but resumes an interrupted operation', () => {
    const first = read({}, [ack]).alertResponses[0];
    const cp = { alertReplies: { [ref]: { signature: first.signature, status: 'DONE' } } };
    expect(read(cp, [ack]).alertResponses).toEqual([]);
    cp.alertReplies[ref].status = 'IN_PROGRESS'; expect(read(cp, [ack]).alertResponses[0].kind).toBe('resume_processing');
});
test('updated text is detected even if timestamps match; confirmation alone is never approval', () => {
    const first = read({}, [ack]).alertResponses[0]; const cp = { alertReplies: { [ref]: { signature: first.signature, status: 'DONE' } } };
    expect(read(cp, [{ ...ack, plan: '先不要處理' }]).alertResponses).toHaveLength(1);
    expect(read({}, [{ ...ack, plan: null, planAt: null }]).alertResponses[0].kind).toBe('confirmation_only');
});
test('tracks acknowledgement and warning state changes including a known vanished warning', () => {
    const cp = { warningRef: ref }; const first = read(cp, [ack]); cp.alertStates = { [ref]: first.alertStates[0] };
    expect(read(cp, [ack]).alertStates[0].changed).toBe(false);
    const cleared = read(cp, []).alertStates[0]; expect(cleared.active).toBe(false); expect(cleared.confirmed).toBe(false); expect(cleared.changed).toBe(true);
});
test('uses an active warning acknowledgement when the separate list lacks it, and excludes other apps', () => {
    const r = collectUpdates({}, { qaRead: () => page, alertsRead: () => ({ alerts: [{ id: ref, ack }, { id: 'other-app', ack: { plan: 'private' } }], acks: [{ ...ack, id: 'other-app' }] }) });
    expect(r.alertResponses.map(x => x.id)).toEqual([ref]); expect(JSON.stringify(r)).not.toContain('private');
});
test('reads every comment page without advancing the input checkpoint', () => {
    const cp = { lastFetchedCursor: '0', lastFullyHandledCursor: '0' }, calls = [];
    const r = collectUpdates(cp, { alertsRead: () => ({ alerts: [], acks: [] }), qaRead: q => { calls.push(q.after); return q.after === '0' ? { ...page, comments: [{ id: '1' }], nextCursor: '1', hasMore: true } : { ...page, comments: [{ id: '2' }], nextCursor: '2' }; } });
    expect(calls).toEqual(['0', '1']); expect(r.comments.map(c => c.id)).toEqual(['1', '2']); expect(r.nextCursor).toBe('2'); expect(cp.lastFullyHandledCursor).toBe('0'); expect(cp.lastFetchedCursor).toBe('0');
    expect(() => collectUpdates({}, { alertsRead: () => ({ alerts: [], acks: [] }), qaRead: () => ({ ...page, hasMore: true }) })).toThrow('QA_CURSOR_STALLED');
});
