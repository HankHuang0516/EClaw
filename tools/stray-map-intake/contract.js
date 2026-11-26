'use strict';

// CONTRACT DRAFT ONLY. Pure functions; no HTTP route, fetch, DB, uploader or activation switch.
const { createHash } = require('node:crypto');
const { isIP } = require('node:net');

const DRAFT = Object.freeze({
    path: '/v1/public/tips', enabled: false, officialApiVerified: false, status: 'CONTRACT_DRAFT',
});
const LIMITS = Object.freeze({ jsonBytes: 16384, photos: 2, imageBytes: 5242880,
    totalImageBytes: 8388608, imagePixels: 16000000, imageDimension: 8192 });
const KINDS = Object.freeze(['DOG', 'CAT', 'OTHER_STRAY', 'WILDLIFE']);
const CONDITIONS = Object.freeze(['UNKNOWN', 'ROAMING', 'INJURED', 'DECEASED']);
const SENSITIVITIES = Object.freeze(['NONE', 'UNKNOWN', 'PROTECTED_SPECIES', 'NEST', 'HABITAT']);
const REGIONS = Object.freeze(['TW-CHA', 'TW-CYI', 'TW-CYQ', 'TW-HSQ', 'TW-HSZ', 'TW-HUA',
    'TW-ILA', 'TW-KEE', 'TW-KHH', 'TW-KIN', 'TW-LIE', 'TW-MIA', 'TW-NAN', 'TW-NWT',
    'TW-PEN', 'TW-PIF', 'TW-TAO', 'TW-TNN', 'TW-TPE', 'TW-TTT', 'TW-TXG', 'TW-YUN']);
const LICENSES = Object.freeze(['EXPLICIT_PERMISSION', 'CC_BY_4_0', 'CC0_1_0']);
const MIME_TYPES = Object.freeze(['image/jpeg', 'image/png', 'image/webp']);
const PUBLISHER = /^[a-z][a-z0-9-]{2,63}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{16,128}$/;
const UPLOAD_REF = /^up_[A-Za-z0-9_-]{8,64}$/;
const EVIDENCE_REF = /^ev_[A-Za-z0-9_-]{8,64}$/;
const CREDIT_REF = /^credit_[A-Za-z0-9_-]{8,64}$/;
const TIP_REF = /^tip_[A-Za-z0-9_-]{8,64}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const UTC_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

function fail(error, status = 400) { return { success: false, error, status }; }
function record(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        && Object.getPrototypeOf(value) === Object.prototype;
}
function exact(value, keys) {
    return record(value) && Object.keys(value).length === keys.length
        && keys.every(key => Object.hasOwn(value, key));
}
function matches(value, pattern) { return typeof value === 'string' && pattern.test(value); }
function canonicalTime(value) {
    if (!matches(value, UTC_TIME)) return null;
    const time = new Date(value);
    if (!Number.isFinite(time.getTime())) return null;
    const normalized = time.toISOString();
    return normalized === value.replace(/Z$/, value.includes('.') ? 'Z' : '.000Z') ? normalized : null;
}
function stableJSON(value) {
    if (Array.isArray(value)) return `[${value.map(stableJSON).join(',')}]`;
    if (record(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJSON(value[key])}`).join(',')}}`;
    return JSON.stringify(value);
}
function hash(value) { return createHash('sha256').update(stableJSON(value)).digest('hex'); }

// Called only after JSON.parse succeeds. Track keys per object, including escaped spellings.
function hasDuplicateKeys(text) {
    const stack = [];
    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        if (char === '{') stack.push(new Set());
        else if (char === '[') stack.push(null);
        else if (char === '}' || char === ']') stack.pop();
        else if (char === '"') {
            const start = i++;
            for (; i < text.length; i++) {
                if (text[i] === '\\') i++;
                else if (text[i] === '"') break;
            }
            let next = i + 1;
            while (/\s/.test(text[next] || '') && next < text.length) next++;
            if (text[next] === ':') {
                const key = JSON.parse(text.slice(start, i + 1));
                const keys = stack[stack.length - 1];
                if (keys.has(key)) return true;
                keys.add(key);
            }
        }
    }
    return false;
}

function parseBody(raw, contentType, contentEncoding) {
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)
        || contentEncoding !== 'identity') return fail('UNSUPPORTED_MEDIA_TYPE', 415);
    if (typeof raw !== 'string' && !Buffer.isBuffer(raw)) return fail('RAW_JSON_REQUIRED');
    if (Buffer.byteLength(raw) > LIMITS.jsonBytes) return fail('PAYLOAD_TOO_LARGE', 413);
    const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw, 'utf8');
    const text = bytes.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(bytes)) return fail('INVALID_UTF8');
    try {
        const value = JSON.parse(text);
        if (hasDuplicateKeys(text)) return fail('DUPLICATE_JSON_KEY');
        return { success: true, value };
    } catch { return fail('INVALID_JSON'); }
}

/** Syntactic normalization only: NEVER resolves DNS, follows redirects or retrieves a URL. */
function canonicalSourceURL(value) {
    if (typeof value !== 'string' || value.length > 1024 || /[\s\\\u0000-\u001f\u007f]/.test(value)
        || !/^https:\/\//i.test(value)) return null;
    try {
        const url = new URL(value);
        const host = url.hostname;
        if (url.protocol !== 'https:' || url.username || url.password || url.port
            || isIP(host) || host.includes(':') || host.endsWith('.')
            || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*$/.test(host)
            || /\.(?:localhost|local|internal|test)$/.test(host)) return null;
        // Tracking data and fragments are discarded. All other query keys are forbidden.
        for (const key of url.searchParams.keys()) {
            if (!/^utm_[a-z0-9_]+$/i.test(key) && !['fbclid', 'gclid'].includes(key)) return null;
        }
        const pathname = url.pathname.replace(/%([a-f0-9]{2})/gi, (encoded, hex) => {
            const char = String.fromCharCode(parseInt(hex, 16));
            return /[A-Za-z0-9_~.-]/.test(char) ? char : encoded;
        });
        if (!/^\/[A-Za-z0-9/_~.-]*$/.test(pathname) || pathname.includes('//')
            || pathname.split('/').some(part => part === '.' || part === '..')) return null;
        url.pathname = pathname;
        url.search = '';
        url.hash = '';
        return url.href;
    } catch { return null; }
}

function validateSource(source, policy) {
    if (!exact(source, ['publisherId', 'url', 'publishedAt']) || !matches(source.publisherId, PUBLISHER)) {
        return fail('INVALID_SOURCE');
    }
    const url = canonicalSourceURL(source.url);
    if (!url) return fail('INVALID_SOURCE_URL');
    // This registry is trusted server context, never a body field or a newly minted credential.
    if (!record(policy) || policy.verified !== true || source.publisherId !== policy.publisherId
        || typeof policy.origin !== 'string' || typeof policy.pathPrefix !== 'string'
        || !/^\/[A-Za-z0-9/_~-]+\/$/.test(policy.pathPrefix)
        || canonicalSourceURL(`${policy.origin}/`) !== `${policy.origin}/`
        || new URL(url).origin !== policy.origin || !new URL(url).pathname.startsWith(policy.pathPrefix)
        || new URL(url).pathname === policy.pathPrefix) return fail('SOURCE_NOT_VERIFIED', 403);
    return { success: true, url };
}

function validatePhotos(photos, source, verifiedUploads) {
    if (!Array.isArray(photos) || photos.length > LIMITS.photos) return fail('INVALID_PHOTOS');
    const seen = new Set();
    let totalBytes = 0;
    for (const photo of photos) {
        if (!exact(photo, ['uploadId', 'rights']) || !matches(photo.uploadId, UPLOAD_REF)
            || seen.has(photo.uploadId)) return fail('INVALID_PHOTO');
        seen.add(photo.uploadId);
        const rights = photo.rights;
        if (!exact(rights, ['license', 'evidenceRef', 'attributionRef', 'permitsRedaction'])
            || !LICENSES.includes(rights.license) || !matches(rights.evidenceRef, EVIDENCE_REF)
            || !matches(rights.attributionRef, CREDIT_REF) || rights.permitsRedaction !== true) {
            return fail('PHOTO_RIGHTS_REQUIRED');
        }
        const uploads = Array.isArray(verifiedUploads) ? verifiedUploads.filter(item => record(item) && item.uploadId === photo.uploadId) : [];
        const upload = uploads[0];
        if (uploads.length !== 1 || upload.publisherId !== source.publisherId || upload.sourceUrl !== source.url
            || upload.status !== 'VERIFIED_SAFE' || !matches(upload.sha256, SHA256)
            || stableJSON(upload.rights) !== stableJSON(rights)
            || !['reuseConsentVerified', 'exifRemoved', 'geoRemoved', 'manualRedactionConfirmed',
                'noFacesOrPlates', 'noPersonalData', 'noSensitiveVisualLocation', 'caseMatchConfirmed']
                .every(flag => upload[flag] === true)) return fail('PHOTO_NOT_VERIFIED');
        if (!Number.isSafeInteger(upload.byteLength) || upload.byteLength < 1 || upload.byteLength > LIMITS.imageBytes
            || !MIME_TYPES.includes(upload.mimeType)
            || ![upload.width, upload.height].every(n => Number.isSafeInteger(n) && n > 0 && n <= LIMITS.imageDimension)
            || upload.width * upload.height > LIMITS.imagePixels) return fail('PHOTO_LIMIT_EXCEEDED');
        totalBytes += upload.byteLength;
    }
    return totalBytes > LIMITS.totalImageBytes ? fail('PHOTO_LIMIT_EXCEEDED') : { success: true };
}

/**
 * Evaluate a synthetic/trusted draft input, never submit it. All context is server-owned.
 * No text, coordinate, identity, visibility, status or device-ID fields are accepted.
 */
function validateTip(raw, { submittedAt, sourcePolicy, verifiedUploads = [],
    contentType = 'application/json', contentEncoding = 'identity' } = {}) {
    const parsed = parseBody(raw, contentType, contentEncoding);
    if (!parsed.success) return parsed;
    const tip = parsed.value;
    if (!exact(tip, ['schemaVersion', 'thirdParty', 'selfWitness', 'source', 'observedAt', 'animal', 'location', 'photos'])
        || tip.schemaVersion !== 1 || tip.thirdParty !== true || tip.selfWitness !== false) return fail('INVALID_TIP');
    const source = validateSource(tip.source, sourcePolicy);
    if (!source.success) return source;
    const submitted = canonicalTime(submittedAt);
    if (!submitted) return fail('SERVER_CONTEXT_REQUIRED', 500);
    const published = canonicalTime(tip.source.publishedAt);
    const observed = tip.observedAt === null ? null : canonicalTime(tip.observedAt);
    if (!published || (tip.observedAt !== null && !observed)
        || published > submitted || (observed !== null && observed > published)) return fail('INVALID_TIMELINE');
    if (!exact(tip.animal, ['kind', 'count', 'condition']) || !KINDS.includes(tip.animal.kind)
        || !CONDITIONS.includes(tip.animal.condition) || (tip.animal.count !== null
            && (!Number.isSafeInteger(tip.animal.count) || tip.animal.count < 1 || tip.animal.count > 100))) return fail('INVALID_ANIMAL');
    if (!exact(tip.location, ['regionCode', 'sensitivity']) || !SENSITIVITIES.includes(tip.location.sensitivity)
        || (tip.location.regionCode !== null && !REGIONS.includes(tip.location.regionCode))) return fail('INVALID_LOCATION');
    const canonicalPayload = { ...tip, source: { ...tip.source, url: source.url, publishedAt: published }, observedAt: observed };
    const photos = validatePhotos(tip.photos, canonicalPayload.source, verifiedUploads);
    if (!photos.success) return photos;
    const mapPolicy = tip.animal.kind === 'WILDLIFE' || tip.location.sensitivity !== 'NONE'
        || tip.location.regionCode === null ? 'NEVER' : 'REVIEW_REQUIRED';
    // Deliberately coarse candidate signal, private and versioned; never an entity ID or merge key.
    const candidateFingerprint = mapPolicy === 'NEVER' || observed === null ? null
        : hash(['stray-case-v1', tip.animal.kind, tip.location.regionCode, observed.slice(0, 10)]);
    return { success: true, canonicalPayload, payloadHash: hash(canonicalPayload), candidateFingerprint,
        review: { status: 'PENDING', publicVisible: false, mapPolicy } };
}

/** Pure decision only. The future store MUST reserve (publisherId,key) atomically and commit with its receipt. */
function decideIdempotency({ publisherId, key, payloadHash, existing = null } = {}) {
    if (!matches(publisherId, PUBLISHER) || !matches(key, IDEMPOTENCY_KEY) || !matches(payloadHash, SHA256)) {
        return fail('INVALID_IDEMPOTENCY_INPUT');
    }
    const scopeKey = `${publisherId}:${key}`;
    if (existing === null) return { success: true, action: 'RESERVE', scopeKey, payloadHash };
    if (!record(existing) || existing.scopeKey !== scopeKey || !matches(existing.payloadHash, SHA256)) {
        return fail('IDEMPOTENCY_STATE_INVALID', 500);
    }
    if (existing.payloadHash !== payloadHash) return fail('IDEMPOTENCY_CONFLICT', 409);
    const receipt = existing.receipt;
    if (!exact(receipt, ['success', 'tipId', 'status', 'publicVisible', 'submittedAt'])
        || receipt.success !== true || !matches(receipt.tipId, TIP_REF) || receipt.status !== 'PENDING'
        || receipt.publicVisible !== false || !canonicalTime(receipt.submittedAt)) return fail('IDEMPOTENCY_STATE_INVALID', 500);
    return { success: true, action: 'REPLAY', scopeKey, receipt: { ...receipt } };
}

// Convenience for future aggregate adapters; no data is collected or statistics inferred here.
function countOrUnknown(value, { sourceAvailable = false } = {}) {
    return sourceAvailable === true && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

module.exports = { DRAFT, LIMITS, KINDS, CONDITIONS, SENSITIVITIES, REGIONS, LICENSES, MIME_TYPES,
    canonicalSourceURL, validateTip, decideIdempotency, countOrUnknown };
