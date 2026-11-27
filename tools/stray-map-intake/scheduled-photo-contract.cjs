'use strict';

const { validateTip } = require('./contract');

const MAX_CASE_EVIDENCE_AGE_MS = 15 * 60 * 1000;
const fail = error => ({ success: false, error, status: 403 });
const PHOTO_PROVENANCE = ['originalCaptureConfirmed', 'sameAnimalIdentifiable', 'authorAttributionPreserved'];

function activeEvidence(evidence, source, submittedAt) {
    if (!evidence || evidence.status !== 'ACTIVE' || evidence.sourceMayBeReused !== true
        || !['publisherId', 'datasetId', 'recordKey'].every(key => evidence[key] === source[key])) return false;
    const checkedAt = Date.parse(evidence.checkedAt), now = Date.parse(submittedAt);
    return Number.isFinite(checkedAt) && new Date(checkedAt).toISOString() === evidence.checkedAt
        && now >= checkedAt && now - checkedAt < MAX_CASE_EVIDENCE_AGE_MS;
}

/** Both evidence inputs must come from the receiver's verified registries. Request data cannot assert either. */
function validateScheduledPhotoTip(raw, { submittedAt, sourcePolicy, verifiedUploads, caseEvidence } = {}) {
    const current = validateTip(raw, { submittedAt, sourcePolicy, verifiedUploads });
    if (!current.success) return current;
    const tip = current.canonicalPayload;
    if (tip.schemaVersion !== 3 || current.review.mapPolicy === 'NEVER' || tip.observation.precision === 'UNKNOWN') {
        return fail('SCHEDULED_CASE_NOT_SAFE');
    }
    if (!activeEvidence(caseEvidence, tip.source, submittedAt)) return fail('SCHEDULED_CASE_NOT_CONFIRMED_ACTIVE');
    if (!tip.photos.length) return fail('SCHEDULED_ORIGINAL_PHOTO_REQUIRED');
    const strictUploads = new Map(verifiedUploads.map(upload => [upload.uploadId, upload]));
    if (tip.photos.some(photo => !PHOTO_PROVENANCE.every(flag => strictUploads.get(photo.uploadId)?.[flag] === true))) {
        return fail('SCHEDULED_PHOTO_PROVENANCE_UNVERIFIED');
    }
    return current;
}

module.exports = { validateScheduledPhotoTip, MAX_CASE_EVIDENCE_AGE_MS };
