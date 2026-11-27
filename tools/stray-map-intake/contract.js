'use strict';

// CONTRACT DRAFT ONLY. No production route, fetch, uploader or activation switch.
const { createHash } = require('node:crypto');
const { isIP } = require('node:net');

const DRAFT = Object.freeze({
    path: '/v1/public/tips', enabled: false, officialApiVerified: false, status: 'CONTRACT_DRAFT',
});
const LIMITS = Object.freeze({ jsonBytes: 16384, photos: 2, imageBytes: 5242880,
    totalImageBytes: 8388608, imagePixels: 16000000, imageDimension: 8192 });
const KINDS = Object.freeze(['DOG', 'CAT', 'OTHER_STRAY', 'WILDLIFE']);
const CONDITIONS = Object.freeze(['UNKNOWN', 'ROAMING', 'INJURED', 'DECEASED']); // v2 legacy
const HEALTH_CONDITIONS = Object.freeze(['UNKNOWN', 'HEALTHY', 'INJURED', 'SICK', 'DECEASED']);
const REPORT_TYPES = Object.freeze(['LOST', 'FOUND', 'SIGHTING']);
const SENSITIVITIES = Object.freeze(['NONE', 'UNKNOWN', 'PROTECTED_SPECIES', 'NEST', 'HABITAT']);
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

function parseBody(raw, contentType, contentEncoding, maxBytes = LIMITS.jsonBytes) {
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)
        || contentEncoding !== 'identity') return fail('UNSUPPORTED_MEDIA_TYPE', 415);
    if (typeof raw !== 'string' && !Buffer.isBuffer(raw)) return fail('RAW_JSON_REQUIRED');
    if (Buffer.byteLength(raw) > maxBytes) return fail('PAYLOAD_TOO_LARGE', 413);
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

function boundedText(value, min, max) {
    return typeof value === 'string' && Array.from(value).length >= min && Array.from(value).length <= max
        && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
}
const timeFormats = new Map();
function zonedParts(time, zone) {
    try {
        if (!timeFormats.has(zone)) timeFormats.set(zone, new Intl.DateTimeFormat('en-CA', { timeZone: zone,
            era: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
            second: '2-digit', hourCycle: 'h23' }));
        const p = Object.fromEntries(timeFormats.get(zone).formatToParts(time).map(item => [item.type, item.value]));
        if (p.era === 'BC') p.year = String(1 - Number(p.year));
        return p;
    } catch { return null; }
}
function localParts(time, zone) {
    const p = zonedParts(time, zone);
    return p ? `${p.year.padStart(4, '0')}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}` : null;
}
function dateBounds(value, zone) {
    const nominal = Date.parse(`${value}T00:00:00Z`), day = 86400000;
    const offsetAt = ms => {
        const p = zonedParts(new Date(ms), zone);
        const local = new Date(0);
        local.setUTCFullYear(Number(p.year), Number(p.month) - 1, Number(p.day));
        local.setUTCHours(Number(p.hour), Number(p.minute), Number(p.second), 0);
        return +local - Math.floor(ms / 1000) * 1000;
    };
    // Split UTC by offset transitions, rather than assume local dates are monotonic.
    // A midnight rollback can leave a date with multiple disjoint UTC intervals.
    const windowStart = nominal - 3 * day, windowEnd = nominal + 3 * day;
    const segments = []; let start = windowStart, previous = windowStart, offset = offsetAt(start);
    for (let point = windowStart + 900000; point <= windowEnd; point += 900000) {
        const nextOffset = offsetAt(point);
        if (nextOffset !== offset) {
            let lo = previous, hi = point;
            while (lo < hi) {
                const mid = Math.floor((lo + hi) / 2);
                if (offsetAt(mid) === offset) lo = mid + 1; else hi = mid;
            }
            segments.push([start, lo, offset]); start = lo; offset = nextOffset;
        }
        previous = point;
    }
    segments.push([start, windowEnd, offset]);
    const intervals = segments.map(([lo, hi, shift]) => [Math.max(lo, nominal - shift), Math.min(hi, nominal + day - shift)])
        .filter(([lo, hi]) => lo < hi);
    return intervals.length ? [Math.min(...intervals.map(item => item[0])), Math.max(...intervals.map(item => item[1])) - 1] : null;
}
function temporal(value) {
    if (!exact(value, ['precision', 'value', 'timeZone'])) return null;
    if (value.precision === 'UNKNOWN') return value.value === null && value.timeZone === null ? { ...value } : null;
    if (typeof value.timeZone !== 'string' || value.timeZone.length > 80
        || !localParts(new Date(0), value.timeZone)) return null;
    if (value.precision === 'DATE') {
        if (!matches(value.value, /^\d{4}-\d{2}-\d{2}$/)) return null;
        const d = new Date(`${value.value}T00:00:00Z`);
        return Number.isFinite(+d) && d.toISOString().slice(0, 10) === value.value
            && dateBounds(value.value, value.timeZone) !== null ? { ...value } : null;
    }
    if (value.precision !== 'INSTANT' || !matches(value.value,
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/)) return null;
    const d = new Date(value.value);
    return Number.isFinite(+d) && localParts(d, value.timeZone) === value.value.slice(0, 19) ? { ...value } : null;
}
// Compare only what the supplied precision proves. A date never becomes a guessed midnight instant.
function temporalBounds(value) {
    if (value.precision === 'UNKNOWN') return null;
    return value.precision === 'INSTANT' ? [Date.parse(value.value), Date.parse(value.value)] : dateBounds(value.value, value.timeZone);
}
function definitelyAfter(a, b) {
    const left = temporalBounds(a), right = temporalBounds(b);
    return left !== null && right !== null && left[0] > right[1];
}
function validateSource(source, policy) {
    if (!exact(source, ['publisherId', 'datasetId', 'recordKey', 'url', 'publishedAt'])
        || !matches(source.publisherId, PUBLISHER) || !matches(source.datasetId, PUBLISHER)
        || !matches(source.recordKey, IDEMPOTENCY_KEY)) return fail('INVALID_SOURCE');
    const url = source.url === null ? null : canonicalSourceURL(source.url);
    if (source.url !== null && !url) return fail('INVALID_SOURCE_URL');
    if (!record(policy) || policy.verified !== true || source.publisherId !== policy.publisherId
        || source.datasetId !== policy.datasetId || !Array.isArray(policy.allowedRegions)
        || !policy.allowedRegions.length || !policy.allowedRegions.every(region => matches(region, /^[A-Z]{2}-[A-Z0-9]{1,3}$/))
        || typeof policy.origin !== 'string' || typeof policy.pathPrefix !== 'string'
        || !/^\/[A-Za-z0-9/_~-]+\/$/.test(policy.pathPrefix)
        || canonicalSourceURL(`${policy.origin}/`) !== `${policy.origin}/`
        || (url !== null && (new URL(url).origin !== policy.origin
            || !new URL(url).pathname.startsWith(policy.pathPrefix)
            || new URL(url).pathname === policy.pathPrefix))) return fail('SOURCE_NOT_VERIFIED', 403);
    return { success: true, url };
}

function validatePhotos(photos, source, verifiedUploads) {
    if (!Array.isArray(photos) || photos.length > LIMITS.photos) return fail('INVALID_PHOTOS');
    const seen = new Set();
    let totalBytes = 0;
    for (const photo of photos) {
        if (!exact(photo, ['uploadId', 'rights', 'caption']) || !matches(photo.uploadId, UPLOAD_REF)
            || !boundedText(photo.caption, 1, 240) || seen.has(photo.uploadId)) return fail('INVALID_PHOTO');
        seen.add(photo.uploadId);
        const rights = photo.rights;
        if (!exact(rights, ['license', 'evidenceRef', 'attributionRef', 'permitsRedaction'])
            || !LICENSES.includes(rights.license) || !matches(rights.evidenceRef, EVIDENCE_REF)
            || !matches(rights.attributionRef, CREDIT_REF) || rights.permitsRedaction !== true) {
            return fail('PHOTO_RIGHTS_REQUIRED');
        }
        const uploads = Array.isArray(verifiedUploads) ? verifiedUploads.filter(item => record(item) && item.uploadId === photo.uploadId) : [];
        const upload = uploads[0];
        if (uploads.length !== 1 || upload.publisherId !== source.publisherId || upload.datasetId !== source.datasetId || upload.recordKey !== source.recordKey || upload.sourceUrl !== source.url
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

function reportSemantics(tip) {
    return tip.schemaVersion === 3 ? tip.report : { type: 'UNSPECIFIED_LEGACY', locationMeaning: 'UNSPECIFIED_LEGACY',
        custody: { status: 'UNKNOWN', asOf: { precision: 'UNKNOWN', value: null, timeZone: null } } };
}
function validateReport(report, published, observed, now) {
    if (!exact(report, ['type', 'locationMeaning', 'custody']) || !REPORT_TYPES.includes(report.type)
        || report.locationMeaning !== { LOST: 'LAST_KNOWN', FOUND: 'FOUND_AT', SIGHTING: 'OBSERVED_AT' }[report.type]
        || !exact(report.custody, ['status', 'asOf']) || !['UNKNOWN', 'IN_CARE', 'NOT_IN_CARE'].includes(report.custody.status)) return false;
    const asOf = temporal(report.custody.asOf);
    if (!asOf || definitelyAfter(asOf, published) || definitelyAfter(asOf, now)) return false;
    if (report.custody.status === 'UNKNOWN') return asOf.precision === 'UNKNOWN';
    return report.type === 'FOUND' && asOf.precision !== 'UNKNOWN' && !definitelyAfter(observed, asOf);
}

/** All review context is server-owned. Text stays private until explicit operator review. */
function validateTip(raw, { submittedAt, sourcePolicy, verifiedUploads = [],
    contentType = 'application/json', contentEncoding = 'identity' } = {}) {
    const parsed = parseBody(raw, contentType, contentEncoding);
    if (!parsed.success) return parsed;
    const tip = parsed.value;
    const keys = ['schemaVersion', 'thirdParty', 'selfWitness', 'source', 'observation', 'animal', 'location', 'display', 'photos'];
    if (record(tip) && tip.schemaVersion === 3) keys.push('report');
    if (!exact(tip, keys) || ![2, 3].includes(tip.schemaVersion) || tip.thirdParty !== true || tip.selfWitness !== false) return fail('INVALID_TIP');
    const source = validateSource(tip.source, sourcePolicy);
    if (!source.success) return source;
    const submitted = canonicalTime(submittedAt);
    if (!submitted) return fail('SERVER_CONTEXT_REQUIRED', 500);
    const published = temporal(tip.source.publishedAt);
    const observed = temporal(tip.observation);
    const now = { precision: 'INSTANT', value: submitted, timeZone: 'UTC' };
    if (!published || !observed || definitelyAfter(published, now) || definitelyAfter(observed, now)
        || definitelyAfter(observed, published)) return fail('INVALID_TIMELINE');
    if (tip.schemaVersion === 3 && !validateReport(tip.report, published, observed, now)) return fail('INVALID_REPORT');
    if (!exact(tip.animal, ['kind', 'count', 'condition']) || !KINDS.includes(tip.animal.kind)
        || !(tip.schemaVersion === 3 ? HEALTH_CONDITIONS : CONDITIONS).includes(tip.animal.condition) || (tip.animal.count !== null
            && (!Number.isSafeInteger(tip.animal.count) || tip.animal.count < 1 || tip.animal.count > 100))) return fail('INVALID_ANIMAL');
    if (!exact(tip.location, ['countryCode', 'regionCode', 'sensitivity']) || !SENSITIVITIES.includes(tip.location.sensitivity)
        || !matches(tip.location.countryCode, /^[A-Z]{2}$/)
        || !sourcePolicy.allowedRegions.some(region => region.startsWith(`${tip.location.countryCode}-`))
        || (tip.location.regionCode !== null && (!sourcePolicy.allowedRegions.includes(tip.location.regionCode)
            || !tip.location.regionCode.startsWith(`${tip.location.countryCode}-`)))) return fail('INVALID_LOCATION');
    if (!exact(tip.display, ['locale', 'title', 'description']) || !boundedText(tip.display.title, 1, 120)
        || !boundedText(tip.display.description, 1, 1000) || !matches(tip.display.locale, /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-[A-Z]{2})?$/)) return fail('INVALID_DISPLAY');
    try { if (Intl.getCanonicalLocales(tip.display.locale)[0] !== tip.display.locale) return fail('INVALID_DISPLAY'); }
    catch { return fail('INVALID_DISPLAY'); }
    const canonicalPayload = { ...tip, source: { ...tip.source, url: source.url, publishedAt: published }, observation: observed };
    const photos = validatePhotos(tip.photos, canonicalPayload.source, verifiedUploads);
    if (!photos.success) return photos;
    const mapPolicy = tip.animal.kind === 'WILDLIFE' || tip.location.sensitivity !== 'NONE'
        || tip.location.regionCode === null ? 'NEVER' : 'REVIEW_REQUIRED';
    const localDate = observed.precision === 'DATE' ? observed.value
        : observed.precision === 'INSTANT' ? localParts(new Date(observed.value), observed.timeZone).slice(0, 10) : null;
    const candidateFingerprint = mapPolicy === 'NEVER' || localDate === null ? null
        : tip.schemaVersion === 2 ? hash(['stray-case-v2', tip.animal.kind, tip.location.countryCode, tip.location.regionCode, localDate])
            : hash(['stray-case-v3', tip.animal.kind, tip.report.type, tip.location.countryCode, tip.location.regionCode, localDate]);
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

module.exports = { DRAFT, LIMITS, KINDS, CONDITIONS, HEALTH_CONDITIONS, REPORT_TYPES, SENSITIVITIES, LICENSES, MIME_TYPES,
    canonicalSourceURL, validateTip, decideIdempotency, countOrUnknown, temporal, definitelyAfter, reportSemantics, temporalBounds, parseBody };
