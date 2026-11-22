#!/usr/bin/env node
'use strict';
// Private operator bridge. Upload URLs and cloud credentials never enter logs.
const fs = require('fs');
const crypto = require('crypto');
const { runRailway } = require('../aihankapps-gifts/lib/adapters/transport');
const { HUB, containerScript } = require('./triage');
function remote(request) {
    const r = runRailway(HUB, containerScript('aihankapps-hub-qa.js', request), { timeoutMs: 60000 });
    if (!r.value || !r.value.success) throw new Error(r.value && r.value.error || 'QA_REMOTE_FAILED');
    return r.value;
}
function alertSnapshot() {
    const r = runRailway(HUB, containerScript('aihankapps-hub-alerts.js'), { timeoutMs: 60000 });
    if (!r.value || !r.value.success) throw new Error('QA_ALERTS_FAILED');
    return r.value;
}
// Read both active AND cleared alerts' confirmations. Hank normally replies
// directly to the warning, so watching only the per-item comments loses work.
function collectUpdates(checkpoint = {}, { qaRead = remote, alertsRead = alertSnapshot } = {}) {
    const answer = alertsRead();
    const own = id => /^human-timehut-qa-review-/.test(id || '');
    const alerts = (answer.alerts || []).filter(a => own(a.id));
    const byId = new Map(alerts.map(a => [a.id, a]));
    const acks = new Map((answer.acks || []).filter(a => own(a.id)).map(a => [a.id, a]));
    for (const a of alerts) if (a.ack && !acks.has(a.id)) acks.set(a.id, { id: a.id, ...a.ack, active: true });
    const responses = [], states = [];
    for (const [id, a] of acks) {
        const signature = crypto.createHash('sha256').update(JSON.stringify([a.at || 0, a.planAt || 0, a.plan || ''])).digest('hex');
        const previous = (checkpoint.alertReplies || {})[id];
        if (!previous || previous.signature !== signature) responses.push({ id, signature, kind: a.plan ? 'plan' : 'confirmation_only', at: a.at || null, planAt: a.planAt || null, plan: a.plan || null, active: byId.has(id), answered: a.answered === true });
        else if (previous.status === 'IN_PROGRESS') responses.push({ id, signature, kind: 'resume_processing', at: a.at || null, planAt: a.planAt || null, plan: a.plan || null, active: byId.has(id), answered: a.answered === true });
    }
    const known = Object.keys(checkpoint.alertStates || {}).filter(own);
    if (own(checkpoint.warningRef)) known.push(checkpoint.warningRef);
    for (const id of new Set([...byId.keys(), ...acks.keys(), ...known])) {
        const a = byId.get(id), ack = acks.get(id);
        const state = { id, active: !!a, state: (a && a.triage && a.triage.state) || (ack && ack.triage && ack.triage.state) || null, confirmed: !!ack, at: ack && ack.at || null, planAt: ack && ack.planAt || null };
        state.signature = crypto.createHash('sha256').update(JSON.stringify(state)).digest('hex');
        state.changed = !checkpoint.alertStates || !checkpoint.alertStates[id] || checkpoint.alertStates[id].signature !== state.signature;
        states.push(state);
    }
    let cursor = String(checkpoint.lastFetchedCursor || '0'), page;
    const comments = [];
    do {
        page = qaRead({ action: 'read', after: cursor });
        comments.push(...page.comments);
        const next = String(page.nextCursor);
        if (page.hasMore && BigInt(next) <= BigInt(cursor)) throw new Error('QA_CURSOR_STALLED');
        cursor = next;
    } while (page.hasMore);
    // Reader never advances handled cursors or marks a plan answered. The agent
    // first saves the full private response, acts, then records the receipt.
    return { success: true, observedAt: new Date().toISOString(), alertResponses: responses, alertStates: states, comments, nextCursor: cursor, batchState: page.batch && page.batch.reviewState || 'active' };
}
async function main(argv = process.argv.slice(2)) {
    const [action, file] = argv;
    if (action === 'read') return remote({ action, after: file || '0' });
    if (action === 'updates') return collectUpdates(file ? JSON.parse(fs.readFileSync(file, 'utf8')) : {});
    if (!['upload', 'publish', 'result'].includes(action) || !file) throw new Error('Usage: qa.js upload FILES.json | publish BATCH.json | read AFTER_ID | result RESULT.json');
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (action === 'publish') return remote({ action, batch: value });
    if (action === 'result') return remote({ ...value, action });
    if (!Array.isArray(value) || value.length !== 10 || new Set(value.map(v => v.item)).size !== 10) throw new Error('QA_UPLOAD_LIST');
    const receipts = [];
    for (const v of value) {
        const bytes = fs.readFileSync(v.path);
        if (!/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii')) || bytes.length !== v.size || crypto.createHash('sha256').update(bytes).digest('hex') !== v.sha256) throw new Error('QA_LOCAL_CHANGED');
        const answer = remote({ action: 'prepare-media', item: v.item, sha256: v.sha256, size: bytes.length });
        const url = new URL(answer.media.url);
        if (url.protocol !== 'https:' || !url.hostname.endsWith('.r2.cloudflarestorage.com')) throw new Error('QA_UPLOAD_ORIGIN');
        const sent = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'image/gif' }, body: bytes, signal: AbortSignal.timeout(60000) });
        if (!sent.ok) throw new Error('QA_UPLOAD_HTTP_' + sent.status);
        receipts.push({ item: v.item, sha256: v.sha256, bytes: bytes.length, uploaded: true });
        process.stderr.write('Uploaded GIF ' + v.item + '\n');
    }
    return { success: true, receipts, note: 'Upload only; publish verifies every cloud GIF against the declared original before exposing the review.' };
}
if (require.main === module) main().then(v => process.stdout.write(JSON.stringify(v) + '\n')).catch(e => { process.stderr.write(JSON.stringify({ success: false, error: /^[A-Z0-9_]+$/.test(e.message) ? e.message : 'QA_OPERATOR_FAILED' }) + '\n'); process.exitCode = 1; });
module.exports = { main, remote, collectUpdates };
