'use strict';

const { createHash } = require('node:crypto');
const { LIMITS, LICENSES, MIME_TYPES, canonicalSourceURL, validateTip, parseBody } = require('../stray-map-intake/contract');
const { MAX_CASE_EVIDENCE_AGE_MS } = require('../stray-map-intake/scheduled-photo-contract.cjs');
const { SOURCE, allowPayload } = require('./dot-identity.cjs');

const BODY_LIMIT = 4 * Math.ceil(LIMITS.imageBytes / 3) + LIMITS.jsonBytes;
const sha = input => createHash('sha256').update(input).digest('hex');
const exact = (value, keys) => value && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const captureChecks = ['originalCapture', 'sameAnimalConfirmed', 'animalRecognizable', 'noFacesOrPlates', 'noPersonalData', 'noSensitiveVisualLocation'];
const denied = (error, status = 422) => ({ status, error });
const CASE_URL_PREFIX = `${SOURCE.origin}/resource/azpa-gwmk/`;
const SYSTEM_CASE_ID = /^row-[a-z\d]{4}-[a-z\d]{4}\.[a-z\d]{4}\.json$/;
const IDENTIFYING_FEATURES = Object.freeze({
    BLACK_COAT: 'Black coat', WHITE_COAT: 'White coat', BROWN_COAT: 'Brown coat', TAN_COAT: 'Tan coat',
    GRAY_COAT: 'Gray coat', ORANGE_COAT: 'Orange coat', BRINDLE_COAT: 'Brindle coat', TABBY_COAT: 'Tabby coat',
    WHITE_CHEST: 'White chest', WHITE_PAWS: 'White paws', WHITE_MUZZLE: 'White muzzle',
    DARK_MASK: 'Dark facial markings', MISMATCHED_EYES: 'Different eye colors',
});
const OFFICIAL_CLAIM_METHOD = 'KING_COUNTY_LOST_PET';

function isPublicCaseURL(url) {
    return typeof url === 'string' && url.startsWith(CASE_URL_PREFIX)
        && SYSTEM_CASE_ID.test(url.slice(CASE_URL_PREFIX.length)) && canonicalSourceURL(url) === url;
}

function isSourceCaseURL(url) {
    return isPublicCaseURL(url) || (typeof url === 'string' && url.startsWith(CASE_URL_PREFIX)
        && /^[-_a-z\d]+(?:\.json)?$/i.test(url.slice(CASE_URL_PREFIX.length)) && canonicalSourceURL(url) === url);
}

function validPublicDetails(details, caseUrl) {
    return exact(details, ['features', 'publishCaseLink', 'claimMethod'])
        && Array.isArray(details.features) && details.features.length <= 5
        && details.features.every(code => typeof code === 'string' && Object.hasOwn(IDENTIFYING_FEATURES, code))
        && new Set(details.features).size === details.features.length
        && (details.publishCaseLink === false || (details.publishCaseLink === true && isPublicCaseURL(caseUrl)))
        && (details.claimMethod === null || details.claimMethod === OFFICIAL_CLAIM_METHOD);
}

function readableAttribution(value) {
    return typeof value === 'string' && value === value.trim() && value.length >= 1 && value.length <= 100
        && /^[\p{L}\p{N}\p{M} .,'’&()–-]+$/u.test(value) && !/\d[\d .()-]{6,}\d/.test(value);
}

function validatePhotoSubmission(raw, { type = 'application/json', encoding = 'identity', now, key } = {}) {
    const parsed = parseBody(raw, type, encoding, BODY_LIMIT);
    if (!parsed.success) return denied(parsed.error, parsed.status);
    const hasPublicDetails = Object.hasOwn(parsed.value ?? {}, 'publicDetails');
    const envelope = ['tip', 'sourceEvidence', 'photo'];
    if (hasPublicDetails) envelope.push('publicDetails');
    if (!exact(parsed.value, envelope)) return denied('INVALID_PHOTO_SUBMISSION');
    const { tip, sourceEvidence, photo, publicDetails } = parsed.value;
    const checked = validateTip(Buffer.from(JSON.stringify(tip)), { submittedAt: now, sourcePolicy: SOURCE, verifiedUploads: [] });
    if (!checked.success) return denied(checked.error, checked.status);
    if (tip.schemaVersion !== 3 || tip.source.url !== null || tip.location.regionCode !== 'US-WA'
        || checked.review.mapPolicy === 'NEVER' || tip.photos.length || !allowPayload(checked.canonicalPayload)
        || key !== tip.source.recordKey) return denied('PHOTO_TIP_SCOPE_REJECTED', 403);

    if (!exact(sourceEvidence, ['status', 'checkedAt', 'caseUrl', 'recordKey']) || sourceEvidence.status !== 'ACTIVE'
        || sourceEvidence.recordKey !== tip.source.recordKey || !isSourceCaseURL(sourceEvidence.caseUrl)) return denied('SOURCE_ACTIVE_PROOF_REQUIRED', 403);
    const checkedAt = Date.parse(sourceEvidence.checkedAt), time = Date.parse(now);
    if (!Number.isFinite(checkedAt) || new Date(checkedAt).toISOString() !== sourceEvidence.checkedAt
        || checkedAt > time || time - checkedAt >= MAX_CASE_EVIDENCE_AGE_MS) return denied('SOURCE_ACTIVE_PROOF_EXPIRED', 403);
    if (hasPublicDetails && !validPublicDetails(publicDetails, sourceEvidence.caseUrl)) return denied('INVALID_PHOTO_PUBLIC_DETAILS');

    if (!exact(photo, ['content', 'mime', 'sha256', 'rights', 'verification']) || typeof photo.content !== 'string'
        || !MIME_TYPES.includes(photo.mime) || typeof photo.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(photo.sha256)) return denied('ORIGINAL_IMAGE_BYTES_REQUIRED');
    if (!exact(photo.verification, ['recordKey', 'originalSha256', ...captureChecks])
        || photo.verification.recordKey !== tip.source.recordKey || photo.verification.originalSha256 !== photo.sha256
        || !captureChecks.every(check => photo.verification[check] === true)) return denied('PHOTO_VERIFICATION_REQUIRED', 403);
    const rights = photo.rights;
    if (!exact(rights, ['license', 'credit', 'permissionUrl', 'creditUrl', 'permitsRedaction', 'creditApprovedForPublic'])
        || !LICENSES.includes(rights.license) || !readableAttribution(rights.credit)
        || typeof rights.permissionUrl !== 'string' || canonicalSourceURL(rights.permissionUrl) !== rights.permissionUrl
        || (rights.creditUrl !== null && (typeof rights.creditUrl !== 'string' || canonicalSourceURL(rights.creditUrl) !== rights.creditUrl))
        || (rights.license === 'CC_BY_4_0' && rights.creditUrl === null)
        || rights.permitsRedaction !== true || rights.creditApprovedForPublic !== true) return denied('PHOTO_REPUBLICATION_RIGHTS_REQUIRED', 403);
    const original = Buffer.from(photo.content, 'base64');
    if (!original.length || original.length > LIMITS.imageBytes || original.toString('base64') !== photo.content
        || sha(original) !== photo.sha256) return denied('ORIGINAL_IMAGE_HASH_MISMATCH');

    // Public details can change with newer source evidence without creating another case.
    const fingerprint = sha(JSON.stringify([checked.payloadHash, sourceEvidence.caseUrl, photo.sha256,
        rights.license, rights.credit, rights.permissionUrl, rights.creditUrl]));
    return { success: true, original, mime: photo.mime, fingerprint, picture: {
        originalSha256: photo.sha256, verification: photo.verification, rights, sourceEvidence,
        ...(hasPublicDetails && { publicDetails }),
    }, tip: checked.canonicalPayload, visibleUntil: new Date(checkedAt + MAX_CASE_EVIDENCE_AGE_MS).toISOString() };
}

module.exports = { BODY_LIMIT, IDENTIFYING_FEATURES, OFFICIAL_CLAIM_METHOD, validPublicDetails, validatePhotoSubmission, sha };
