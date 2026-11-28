'use strict';

// Isolated scheduler adapter. Trust, durable slot reservation, the case ledger, and I/O belong to the harness.
const { createHash } = require('node:crypto');
const { INTERVAL_MS } = require('../stray-map-rebuild/pg-scheduler.cjs');
const { SOURCE } = require('./dot-identity.cjs');
const { prepare, sourceRecordKey } = require('./dot-submit.cjs');
const { validateScheduledPhotoTip } = require('../stray-map-intake/scheduled-photo-contract.cjs');

const MAX_SNAPSHOT = 1000;
const MAX_LEDGER = 4000;
const digest = value => createHash('sha256').update(value).digest('hex');
const status = reason => ({ submitted: false, reason });

function snapshotEntries(snapshot, now, scope) {
    if (snapshot?.synthetic !== true || snapshot.publisherId !== scope.publisherId || snapshot.datasetId !== scope.datasetId
        || snapshot.complete !== true || !Array.isArray(snapshot.records) || snapshot.records.length > MAX_SNAPSHOT) return null;
    const checkedAt = Date.parse(snapshot.checkedAt);
    if (!Number.isFinite(checkedAt) || new Date(checkedAt).toISOString() !== snapshot.checkedAt
        || checkedAt > now || now - checkedAt >= INTERVAL_MS) return null;
    const entries = new Map();
    for (const record of snapshot.records) {
        const key = sourceRecordKey(record?.row, scope);
        if (!key || entries.has(key) || !['ACTIVE', 'EXPLICIT_CLOSED', 'UNKNOWN'].includes(record.evidence)) return null;
        entries.set(key, record);
    }
    return { checkedAt, entries };
}

function pendingReceipt(response) {
    const receipt = response?.body?.receipt;
    return response?.status === 202 && response.body.success === true && typeof response.body.replay === 'boolean'
        && receipt?.status === 'PENDING' && receipt.publicVisible === false && /^tip_[a-f0-9]{32}$/.test(receipt.tipId)
        ? receipt : null;
}

async function scheduledIntakeTick({ isolated, enabled, reserve, readSource, loadLedger, saveLedger, send, loadPhotoAdmission,
    scope = SOURCE, now = Date.now }) {
    if (isolated !== true) throw Error('ISOLATED_INTAKE_ONLY');
    if (scope !== SOURCE && (!scope.verified || !/^synthetic-[a-z0-9-]+$/.test(scope.publisherId)
        || !/^synthetic-[a-z0-9-]+$/.test(scope.datasetId) || !/^https:\/\/[a-z0-9-]+\.example\.invalid$/.test(scope.origin))) {
        throw Error('ISOLATED_SOURCE_REGISTRATION_REQUIRED');
    }
    if (typeof loadPhotoAdmission !== 'function') throw Error('SCHEDULED_PHOTO_ADMISSION_REQUIRED');
    if (!enabled()) return status('DISABLED');
    const time = now();
    if (!Number.isSafeInteger(time) || time < 0) throw Error('INVALID_SCHEDULE_CLOCK');
    if (!await reserve(time, INTERVAL_MS)) return status('NOT_DUE');
    if (!enabled()) return status('DISABLED');

    let snapshot;
    try { snapshot = await readSource(); }
    catch { return status('SOURCE_UNAVAILABLE'); }
    if (!enabled()) return status('DISABLED');
    if (snapshot?.sourceMayBeReused !== true) return status('SOURCE_PERMISSION_UNVERIFIED');
    const checked = snapshotEntries(snapshot, now(), scope);
    if (!checked) return status('SOURCE_CHECK_INCOMPLETE');

    const ledger = await loadLedger();
    const initializing = ledger.lastCheckedAt === null;
    if (!initializing && checked.checkedAt <= ledger.lastCheckedAt) return status('SOURCE_CHECK_STALE');
    let newCount = 0;
    let held = 0;
    let next;
    for (const [key, record] of checked.entries) {
        let entry = ledger.records[key];
        if (!entry) {
            entry = { baseline: initializing, closed: false, receipt: null, payloadDigest: null };
            ledger.records[key] = entry;
            newCount++;
        }
        if (record.evidence === 'EXPLICIT_CLOSED') entry.closed = true;
        if (entry.baseline || entry.closed || entry.receipt) continue;
        const candidate = record.evidence === 'ACTIVE' ? prepare(record.row, scope) : null;
        if (!candidate) {
            held++;
            continue;
        }
        if (next) continue;
        let admission;
        try { admission = await loadPhotoAdmission(candidate.payload.source); }
        catch { held++; continue; }
        if (!enabled()) return status('DISABLED');
        const submittedAt = new Date(now()).toISOString();
        const photos = admission?.photos;
        if (!Array.isArray(photos) || photos.length < 1 || photos.length > 2) { held++; continue; }
        const valid = validateScheduledPhotoTip(Buffer.from(JSON.stringify({ ...candidate.payload, photos })), {
            submittedAt, sourcePolicy: scope, verifiedUploads: admission.verifiedUploads,
            caseEvidence: { ...candidate.payload.source, status: record.evidence, sourceMayBeReused: true, checkedAt: snapshot.checkedAt },
        });
        if (!valid.success) { held++; continue; }
        candidate.payload = valid.canonicalPayload;
        const payloadDigest = valid.payloadHash;
        if (entry.payloadDigest && entry.payloadDigest !== payloadDigest) {
            held++;
            continue;
        }
        next = { candidate, entry, payloadDigest };
    }
    if (Object.keys(ledger.records).length > MAX_LEDGER) return status('LEDGER_CAPACITY');
    ledger.lastCheckedAt = checked.checkedAt;
    if (next) next.entry.payloadDigest = next.payloadDigest;
    await saveLedger(ledger);
    if (initializing) return { ...status('BASELINE_RECORDED'), observed: newCount };
    if (!next) return { ...status('NO_ELIGIBLE_NEW_CASE'), held };
    if (!enabled()) return status('DISABLED');
    if (now() - checked.checkedAt >= INTERVAL_MS) return status('SOURCE_CHECK_STALE');
    let response;
    try { response = await send(next.candidate.payload, next.candidate.key); }
    catch { return status('ACKNOWLEDGEMENT_UNAVAILABLE'); }
    const receipt = pendingReceipt(response);
    if (!receipt) {
        if (response?.status === 429) return status('SOURCE_RATE_LIMIT');
        if (response?.status === 503 && response.body?.error === 'PILOT_CAPACITY') return status('PENDING_CAPACITY');
        return status('PENDING_RECEIPT_UNAVAILABLE');
    }
    next.entry.receipt = receipt;
    await saveLedger(ledger);
    return { submitted: true, status: 'PENDING', publicVisible: false, replay: response.body.replay, held,
        receipt: `masked-${digest(receipt.tipId).slice(0, 12)}` };
}

module.exports = { scheduledIntakeTick, INTERVAL_MS };
