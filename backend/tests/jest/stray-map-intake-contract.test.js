/** Synthetic pure contracts only: no HTTP, DB, real image, source collection or production pins. */
require('./helpers/mock-setup');
const Ajv = require('ajv'); // Already installed with the existing backend tooling; no new dependency.
const spec = require('../../../docs/stray-map-external-intake.openapi.json');
const contract = require('../../../tools/stray-map-intake/contract');
const { DRAFT, LIMITS, validateTip, canonicalSourceURL, decideIdempotency, countOrUnknown } = contract;

const SUBMITTED = '2026-11-26T03:00:00.000Z';
const policy = { verified: true, publisherId: 'synthetic-a', origin: 'https://news.example.invalid', pathPrefix: '/public-tips/' };
const rights = { license: 'EXPLICIT_PERMISSION', evidenceRef: 'ev_synthetic001',
    attributionRef: 'credit_synthetic001', permitsRedaction: true };
const safeFlags = ['reuseConsentVerified', 'exifRemoved', 'geoRemoved', 'manualRedactionConfirmed',
    'noFacesOrPlates', 'noPersonalData', 'noSensitiveVisualLocation', 'caseMatchConfirmed'];

function tip() {
    return { schemaVersion: 1, thirdParty: true, selfWitness: false,
        source: { publisherId: 'synthetic-a', url: 'https://news.example.invalid/public-tips/synthetic001', publishedAt: '2026-11-26T02:00:00Z' },
        observedAt: '2026-11-26T01:00:00Z', animal: { kind: 'DOG', count: null, condition: 'ROAMING' },
        location: { regionCode: 'TW-TPE', sensitivity: 'NONE' }, photos: [] };
}
function evaluate(body = tip(), context = {}) {
    return validateTip(JSON.stringify(body), { submittedAt: SUBMITTED, sourcePolicy: policy, ...context });
}
function photoFixture() {
    const body = tip();
    body.photos = [{ uploadId: 'up_synthetic001', rights: { ...rights } }];
    const upload = { uploadId: 'up_synthetic001', publisherId: policy.publisherId, sourceUrl: body.source.url,
        status: 'VERIFIED_SAFE', sha256: 'a'.repeat(64), byteLength: 1024, mimeType: 'image/jpeg',
        width: 100, height: 100, rights: { ...rights }, ...Object.fromEntries(safeFlags.map(flag => [flag, true])) };
    return { body, upload };
}
function reverseKeys(value) {
    if (Array.isArray(value)) return value.map(reverseKeys);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).reverse().map(([key, v]) => [key, reverseKeys(v)]));
    return value;
}
const definitions = JSON.parse(JSON.stringify(spec.components.schemas).replace(/#\/components\/schemas\//g, '#/definitions/'));
const ajv = new Ajv({ allErrors: true });
const schemaTip = ajv.compile({ definitions, $ref: '#/definitions/Tip' });
const schemaReceipt = ajv.compile({ definitions, $ref: '#/definitions/PendingReceipt' });
const schemaError = ajv.compile({ definitions, $ref: '#/definitions/Error' });

describe('disabled source-independent draft and schema agreement', () => {
    test('contains no activation option or claim of an official API', () => {
        expect(DRAFT).toEqual({ path: '/v1/public/tips', enabled: false, officialApiVerified: false, status: 'CONTRACT_DRAFT' });
        expect(Object.isFrozen(DRAFT)).toBe(true);
        expect(spec['x-default-enabled']).toBe(false);
        expect(spec['x-official-api-verified']).toBe(false);
        expect(spec['x-terms-approval']).toBe('PENDING_HANK_APPROVAL');
        expect(Object.keys(spec.paths)).toEqual([DRAFT.path]);
        expect(spec.servers[0].url).toBe('https://api.example.invalid');
        expect(spec.paths[DRAFT.path].post.security).toEqual([]);
    });
    test('documents the same required fields, enums, limits and null semantics', () => {
        const schemas = spec.components.schemas;
        expect(schemas.Tip.required.sort()).toEqual(Object.keys(tip()).sort());
        expect(schemas.Animal.properties.kind.enum).toEqual(contract.KINDS);
        expect(schemas.Animal.properties.condition.enum).toEqual(contract.CONDITIONS);
        expect(schemas.Location.properties.sensitivity.enum).toEqual(contract.SENSITIVITIES);
        expect(schemas.Location.properties.regionCode.enum).toEqual([...contract.REGIONS, null]);
        expect(schemas.Rights.properties.license.enum).toEqual(contract.LICENSES);
        expect(spec['x-request-max-bytes']).toBe(LIMITS.jsonBytes);
        expect(schemas.Tip.properties.photos.maxItems).toBe(LIMITS.photos);
        expect(spec['x-safe-uploader-required']).toMatchObject({ implemented: false, maximumImageBytes: LIMITS.imageBytes,
            maximumCombinedBytes: LIMITS.totalImageBytes, maximumDecodedPixels: LIMITS.imagePixels,
            maximumDimension: LIMITS.imageDimension, mimeTypes: contract.MIME_TYPES });
        const count = ajv.compile(schemas.NullableCount);
        for (const n of [null, 0, 12]) expect(count(n)).toBe(true);
        for (const n of [-1, '0', 1.2]) expect(count(n)).toBe(false);
    });
    test('accepts the synthetic OpenAPI example as a photo-less private pending evaluation', () => {
        const body = spec.paths[DRAFT.path].post.requestBody.content['application/json'].example;
        expect(schemaTip(body)).toBe(true);
        const result = evaluate(body);
        expect(result.success).toBe(true);
        expect(result.canonicalPayload.photos).toEqual([]);
        expect(result.canonicalPayload.observedAt).toBe('2026-11-26T01:00:00.000Z');
        expect(result.review).toEqual({ status: 'PENDING', publicVisible: false, mapPolicy: 'REVIEW_REQUIRED' });
        expect(result).not.toHaveProperty('tipId'); // No real submission/receipt was created.
    });
    test.each(['status', 'approved', 'published', 'publicVisible', 'deviceId', 'deviceSecret', 'submittedAt',
        'latitude', 'longitude', 'address', 'name', 'socialHandle', 'phone', 'summary', 'sourcePolicy', 'verifiedUploads'])
    ('rejects client authority, identity and free-text top-level field %s', key => {
        const body = { ...tip(), [key]: 'synthetic-private-value' };
        expect(schemaTip(body)).toBe(false);
        expect(evaluate(body)).toEqual({ success: false, error: 'INVALID_TIP', status: 400 });
    });
    test.each(['schemaVersion', 'thirdParty', 'selfWitness', 'source', 'observedAt', 'animal', 'location', 'photos'])
    ('rejects missing required field %s in both implementations', key => {
        const body = tip(); delete body[key];
        expect(schemaTip(body)).toBe(false);
        expect(evaluate(body).success).toBe(false);
    });
    test.each([{ schemaVersion: 2 }, { thirdParty: false }, { selfWitness: true }])('rejects false provenance %j', change => {
        expect(evaluate({ ...tip(), ...change }).error).toBe('INVALID_TIP');
        expect(schemaTip({ ...tip(), ...change })).toBe(false);
    });
});

describe('bounded raw JSON and errors', () => {
    const context = { submittedAt: SUBMITTED, sourcePolicy: policy };
    test('checks byte cap at the boundary, counts whitespace and UTF-8 bytes', () => {
        const raw = JSON.stringify(tip());
        const exact = raw + ' '.repeat(LIMITS.jsonBytes - Buffer.byteLength(raw));
        expect(validateTip(Buffer.from(exact), context).success).toBe(true);
        expect(validateTip(exact + ' ', context)).toEqual({ success: false, error: 'PAYLOAD_TOO_LARGE', status: 413 });
        const multibyte = '"' + 'é'.repeat(8200) + '"';
        expect(multibyte.length).toBeLessThan(LIMITS.jsonBytes);
        expect(validateTip(multibyte, context).status).toBe(413);
    });
    test.each(['text/plain', 'application/json; charset=iso-8859-1', 'application/json; extra=true'])('rejects media type %s', contentType => {
        expect(evaluate(tip(), { contentType }).status).toBe(415);
    });
    test('allows UTF-8 JSON and rejects compressed bodies', () => {
        expect(evaluate(tip(), { contentType: 'application/json; charset=UTF-8' }).success).toBe(true);
        expect(evaluate(tip(), { contentEncoding: 'gzip' }).status).toBe(415);
    });
    test('rejects objects, malformed JSON/UTF-8 and non-object JSON', () => {
        expect(validateTip(tip(), context).error).toBe('RAW_JSON_REQUIRED');
        expect(validateTip('{', context).error).toBe('INVALID_JSON');
        expect(validateTip(Buffer.from([0xc3, 0x28]), context).error).toBe('INVALID_UTF8');
        for (const raw of ['null', '[]', 'true', '1', '"synthetic"']) expect(validateTip(raw, context).error).toBe('INVALID_TIP');
    });
    test('rejects duplicate keys, including escaped nested spellings', () => {
        const raw = JSON.stringify(tip());
        expect(validateTip(raw.replace('"selfWitness":false', '"selfWitness":false,"selfWitness":false'), context).error).toBe('DUPLICATE_JSON_KEY');
        expect(validateTip(raw.replace('"kind":"DOG"', '"kind":"DOG","k\\u0069nd":"DOG"'), context).error).toBe('DUPLICATE_JSON_KEY');
        expect(evaluate().success).toBe(true); // Repeated names in separate objects are not duplicates.
    });
    test('returns only bounded codes and status, never rejected source/personal values', () => {
        const result = evaluate({ ...tip(), name: 'synthetic-private-value' });
        expect(JSON.stringify(result)).not.toContain('synthetic-private-value');
        expect(Object.keys(result).sort()).toEqual(['error', 'status', 'success']);
        expect(schemaError({ success: result.success, error: result.error })).toBe(true);
    });
});

describe('private source URL normalization without fetching', () => {
    test('normalizes host/default port/unreserved escapes/tracking/fragments without losing post identity', () => {
        const original = 'https://news.example.invalid/public-tips/synthetic001';
        const url = 'HTTPS://NEWS.EXAMPLE.INVALID:443/public-tips/%73ynthetic001?utm_source=synthetic&fbclid=synthetic#fragment';
        expect(canonicalSourceURL(url)).toBe(original);
        const body = tip(); body.source.url = url;
        expect(schemaTip(body)).toBe(true);
        expect(evaluate(body).success).toBe(true);
        expect(canonicalSourceURL(original + '/')).toBe(original + '/');
        expect(canonicalSourceURL(original.replace('synthetic001', 'Synthetic001'))).not.toBe(original);
    });
    test.each(['http://news.example.invalid/public-tips/synthetic001', 'https://user:pass@news.example.invalid/public-tips/synthetic001',
        'https://news.example.invalid:8443/public-tips/synthetic001', 'https://news.example.invalid./public-tips/synthetic001',
        'https://news.example.invalid/public-tips/synthetic001?phone=synthetic', 'https://news.example.invalid/public-tips/%2Fsecret',
        'https://news.example.invalid/public-tips/%ZZ', 'https://news.example.invalid/public-tips/a,b',
        'https://news.example.invalid/public-tips/with space', 'https://news.example.invalid\\public-tips/synthetic001'])
    ('rejects unsafe/unsupported syntax %s', url => {
        expect(canonicalSourceURL(url)).toBeNull();
        const body = tip(); body.source.url = url;
        expect(evaluate(body).error).toBe('INVALID_SOURCE_URL');
    });
    test('requires trusted publisher/origin/path context; client claims cannot create it', () => {
        expect(evaluate(tip(), { sourcePolicy: undefined }).error).toBe('SOURCE_NOT_VERIFIED');
        expect(evaluate(tip(), { sourcePolicy: { ...policy, verified: false } }).status).toBe(403);
        for (const change of [{ publisherId: 'synthetic-b' }, { url: 'https://other.example.invalid/public-tips/synthetic001' },
            { url: 'https://news.example.invalid/profiles/synthetic001' }, { url: 'https://news.example.invalid/public-tips/' },
            { extra: true }, { publisherId: 'SYNTHETIC' }]) {
            const body = tip(); Object.assign(body.source, change);
            expect(evaluate(body).success).toBe(false);
        }
        expect(evaluate(tip(), { sourcePolicy: { ...policy, pathPrefix: '/public-tips' } }).success).toBe(false);
    });
});

describe('time, animal types and sensitive coarse regions', () => {
    test('unknown observation stays null and has no candidate fingerprint', () => {
        const body = tip(); body.observedAt = null;
        expect(schemaTip(body)).toBe(true);
        expect(evaluate(body)).toMatchObject({ success: true, canonicalPayload: { observedAt: null }, candidateFingerprint: null });
    });
    test.each(['2026-11-26T02:00:01Z', '2026-02-30T01:00:00Z', '2026-11-26', '2026-11-26T01:00:00+00:00', 'synthetic', 0])
    ('rejects unknown/malformed/after-publication observation %s', time => {
        const body = tip(); body.observedAt = time;
        expect(evaluate(body).error).toBe('INVALID_TIMELINE');
    });
    test('rejects future publication and invalid/missing server time, permits equal and historical times', () => {
        const body = tip(); body.source.publishedAt = '2026-11-26T03:00:01Z';
        expect(evaluate(body).error).toBe('INVALID_TIMELINE');
        body.source.publishedAt = SUBMITTED; body.observedAt = SUBMITTED;
        expect(evaluate(body).success).toBe(true);
        body.observedAt = '2020-01-01T00:00:00Z';
        expect(evaluate(body).success).toBe(true);
        expect(evaluate(tip(), { submittedAt: undefined }).status).toBe(500);
    });
    test.each(contract.KINDS)('keeps every animal kind pending: %s', kind => {
        const body = tip(); body.animal.kind = kind;
        expect(schemaTip(body)).toBe(true);
        expect(evaluate(body).review).toMatchObject({ status: 'PENDING', publicVisible: false });
    });
    test.each([{ kind: 'HUMAN' }, { count: 0 }, { count: -1 }, { count: 101 }, { count: 1.5 }, { count: '1' },
        { condition: 'APPROVED' }, { name: 'synthetic' }])('rejects unsupported animal data %j', change => {
        const body = tip(); Object.assign(body.animal, change);
        expect(schemaTip(body)).toBe(false);
        expect(evaluate(body).error).toBe('INVALID_ANIMAL');
    });
    test.each(contract.SENSITIVITIES.filter(s => s !== 'NONE'))('never produces a public pin/candidate for sensitivity %s', sensitivity => {
        const body = tip(); body.location.sensitivity = sensitivity;
        expect(evaluate(body)).toMatchObject({ success: true, candidateFingerprint: null,
            review: { status: 'PENDING', publicVisible: false, mapPolicy: 'NEVER' } });
    });
    test('wildlife remains map NEVER even when client claims NONE; unknown region also fails closed', () => {
        const body = tip(); body.animal.kind = 'WILDLIFE';
        expect(evaluate(body).review.mapPolicy).toBe('NEVER');
        expect(evaluate(body).candidateFingerprint).toBeNull();
        body.animal.kind = 'DOG'; body.location.regionCode = null;
        expect(evaluate(body).review.mapPolicy).toBe('NEVER');
        expect(evaluate(body).candidateFingerprint).toBeNull();
    });
    test.each([{ regionCode: 'TW-TPE-district' }, { regionCode: 'synthetic-address' }, { sensitivity: 'SAFE' },
        { latitude: 25 }, { geohash: 'synthetic' }, { address: 'synthetic' }])('rejects precise/unsupported location %j', change => {
        const body = tip(); Object.assign(body.location, change);
        expect(schemaTip(body)).toBe(false);
        expect(evaluate(body).error).toBe('INVALID_LOCATION');
    });
});

describe('photos: verified private metadata only, never download or byte safety claims', () => {
    test('requires trusted safe-uploader data; photo-less clues still remain pending', () => {
        const { body, upload } = photoFixture();
        expect(schemaTip(body)).toBe(true);
        expect(evaluate(body).error).toBe('PHOTO_NOT_VERIFIED');
        expect(evaluate(body, { verifiedUploads: [upload] }).review).toMatchObject({ status: 'PENDING', publicVisible: false });
        expect(evaluate().canonicalPayload.photos).toEqual([]);
    });
    test.each(['url', 'remoteUrl', 'dataUrl', 'base64', 'bytes', 'filePath', 'approved', 'publicVisible'])('rejects photo field %s', key => {
        const { body, upload } = photoFixture(); body.photos[0][key] = 'https://image.example.invalid/synthetic001';
        expect(schemaTip(body)).toBe(false);
        expect(evaluate(body, { verifiedUploads: [upload] }).error).toBe('INVALID_PHOTO');
    });
    test.each([{ license: 'PUBLICLY_VISIBLE' }, { license: 'CC_BY_NC_4_0' }, { evidenceRef: '' },
        { attributionRef: 'synthetic-author-name' }, { permitsRedaction: false }, { authorName: 'synthetic' }])
    ('rejects missing/unsupported reuse permission %j', change => {
        const { body, upload } = photoFixture(); Object.assign(body.photos[0].rights, change);
        expect(schemaTip(body)).toBe(false);
        expect(evaluate(body, { verifiedUploads: [upload] }).error).toBe('PHOTO_RIGHTS_REQUIRED');
    });
    test.each(safeFlags)('fails closed without trusted uploader safety flag %s', flag => {
        const { body, upload } = photoFixture(); upload[flag] = false;
        expect(evaluate(body, { verifiedUploads: [upload] }).error).toBe('PHOTO_NOT_VERIFIED');
    });
    test.each([{ publisherId: 'synthetic-b' }, { sourceUrl: 'https://news.example.invalid/public-tips/different001' },
        { status: 'PENDING' }, { sha256: 'synthetic' }, { rights: { ...rights, evidenceRef: 'ev_different001' } }])
    ('rejects wrong owner/source/rights/safety metadata %j', change => {
        const { body, upload } = photoFixture(); Object.assign(upload, change);
        expect(evaluate(body, { verifiedUploads: [upload] }).error).toBe('PHOTO_NOT_VERIFIED');
    });
    test.each([{ byteLength: 0 }, { byteLength: LIMITS.imageBytes + 1 }, { byteLength: 1.5 },
        { mimeType: 'image/svg+xml' }, { mimeType: 'image/gif' }, { width: 0 }, { height: LIMITS.imageDimension + 1 },
        { width: 5000, height: 5000 }])('rejects unbounded/unsupported metadata %j', change => {
        const { body, upload } = photoFixture(); Object.assign(upload, change);
        expect(evaluate(body, { verifiedUploads: [upload] }).error).toBe('PHOTO_LIMIT_EXCEEDED');
    });
    test('rejects duplicate references/ambiguous records and enforces count plus combined image-byte limit', () => {
        const { body, upload } = photoFixture();
        expect(evaluate(body, { verifiedUploads: [upload, upload] }).error).toBe('PHOTO_NOT_VERIFIED');
        body.photos.push({ ...body.photos[0] });
        expect(evaluate(body, { verifiedUploads: [upload] }).error).toBe('INVALID_PHOTO');
        body.photos[1] = { ...body.photos[0], uploadId: 'up_synthetic002' };
        const uploads = [upload, { ...upload, uploadId: 'up_synthetic002' }].map(u => ({ ...u, byteLength: LIMITS.totalImageBytes / 2 }));
        expect(evaluate(body, { verifiedUploads: uploads }).success).toBe(true);
        uploads[0].byteLength++;
        expect(evaluate(body, { verifiedUploads: uploads }).error).toBe('PHOTO_LIMIT_EXCEEDED');
        body.photos.push({ ...body.photos[0], uploadId: 'up_synthetic003' });
        expect(schemaTip(body)).toBe(false);
        expect(evaluate(body).error).toBe('INVALID_PHOTOS');
    });
});

describe('canonical payload retry decisions and suspected-case signals, no persistence', () => {
    const key = 'synthetic_retry_key_001';
    const receipt = { success: true, tipId: 'tip_synthetic001', status: 'PENDING', publicVisible: false, submittedAt: SUBMITTED };
    function input(value = evaluate()) { return { publisherId: policy.publisherId, key, payloadHash: value.payloadHash }; }
    function stored(value = evaluate()) { return { scopeKey: `${policy.publisherId}:${key}`, payloadHash: value.payloadHash, receipt: { ...receipt } }; }
    test('stable sorted keys/canonical URL/time yield one payload hash; server receipt time is excluded', () => {
        const body = reverseKeys(tip()); body.source.url += '?utm_source=synthetic#fragment';
        body.source.publishedAt = '2026-11-26T02:00:00.000Z';
        expect(evaluate(body, { submittedAt: '2026-11-26T04:00:00.000Z' }).payloadHash).toBe(evaluate().payloadHash);
    });
    test('RESERVE is only a pure decision; exact repeat with a committed stand-in receipt replays stable original fields', () => {
        const args = input(); const existing = stored();
        expect(decideIdempotency(args)).toEqual({ success: true, action: 'RESERVE', scopeKey: existing.scopeKey, payloadHash: args.payloadHash });
        expect(decideIdempotency(args).action).toBe('RESERVE'); // No durable key was actually reserved.
        const replay = decideIdempotency({ ...args, existing });
        expect(replay).toMatchObject({ success: true, action: 'REPLAY', receipt });
        expect(decideIdempotency({ ...args, existing })).toEqual(replay);
        expect(schemaReceipt(replay.receipt)).toBe(true);
        replay.receipt.status = 'PUBLISHED';
        expect(existing.receipt.status).toBe('PENDING');
    });
    test('same-key semantic payload conflict never overwrites original', () => {
        const body = tip(); body.animal.count = 2;
        const existing = stored(); const before = JSON.stringify(existing);
        expect(decideIdempotency({ ...input(evaluate(body)), existing })).toEqual({ success: false, error: 'IDEMPOTENCY_CONFLICT', status: 409 });
        expect(JSON.stringify(existing)).toBe(before);
        const { body: photoBody, upload } = photoFixture();
        const first = evaluate(photoBody, { verifiedUploads: [upload] });
        photoBody.photos[0].rights.evidenceRef = 'ev_different001'; upload.rights = { ...photoBody.photos[0].rights };
        expect(evaluate(photoBody, { verifiedUploads: [upload] }).payloadHash).not.toBe(first.payloadHash);
    });
    test.each(['short', 'x'.repeat(129), 'synthetic retry key', null])('rejects malformed idempotency key %s', invalid => {
        expect(decideIdempotency({ ...input(), key: invalid }).error).toBe('INVALID_IDEMPOTENCY_INPUT');
    });
    test('rejects invalid internal state and client publication-shaped receipts rather than leaking them', () => {
        expect(decideIdempotency().error).toBe('INVALID_IDEMPOTENCY_INPUT');
        expect(decideIdempotency({ ...input(), payloadHash: 'bad' }).error).toBe('INVALID_IDEMPOTENCY_INPUT');
        for (const existing of [{}, { ...stored(), scopeKey: 'synthetic-b:other' },
            { ...stored(), receipt: { ...receipt, status: 'PUBLISHED' } },
            { ...stored(), receipt: { ...receipt, publicVisible: true } },
            { ...stored(), receipt: { ...receipt, secret: 'synthetic-private-value' } }]) {
            const result = decideIdempotency({ ...input(), existing });
            expect(result.error).toBe('IDEMPOTENCY_STATE_INVALID');
            expect(JSON.stringify(result)).not.toContain('synthetic-private-value');
        }
    });
    test('different publishers have independent retry scope but can be suspected-case candidates without merging', () => {
        const first = evaluate(); const body = tip();
        body.source.publisherId = 'synthetic-b'; body.source.url = 'https://other.example.invalid/public-tips/synthetic002';
        const second = evaluate(body, { sourcePolicy: { ...policy, publisherId: 'synthetic-b', origin: 'https://other.example.invalid' } });
        expect(second.success).toBe(true);
        expect(second.payloadHash).not.toBe(first.payloadHash);
        expect(second.candidateFingerprint).toBe(first.candidateFingerprint);
        expect(first.review.status).toBe('PENDING'); expect(second.review.status).toBe('PENDING');
        const otherScope = decideIdempotency({ ...input(second), publisherId: 'synthetic-b' });
        expect(otherScope.scopeKey).not.toBe(stored().scopeKey);
        expect(otherScope.action).toBe('RESERVE');
        expect(decideIdempotency({ ...input(second), publisherId: 'synthetic-b', existing: stored() }).success).toBe(false);
    });
    test('candidate collisions are deliberately coarse, and unknown observation must not use publication time', () => {
        const body = tip(); body.animal.count = 10; body.animal.condition = 'INJURED';
        expect(evaluate(body).candidateFingerprint).toBe(evaluate().candidateFingerprint);
        body.observedAt = null;
        expect(evaluate(body).candidateFingerprint).toBeNull();
        body.observedAt = '2026-11-25T01:00:00Z';
        expect(evaluate(body).candidateFingerprint).not.toBe(evaluate().candidateFingerprint);
    });
});

describe('unknown aggregates versus real zero — no data collection', () => {
    test('unavailable/missing source never becomes zero, available real zero is preserved', () => {
        expect(countOrUnknown(0)).toBeNull();
        expect(countOrUnknown(0, { sourceAvailable: false })).toBeNull();
        expect(countOrUnknown(0, { sourceAvailable: true })).toBe(0);
        expect(countOrUnknown(12, { sourceAvailable: true })).toBe(12);
    });
    test.each([undefined, null, '0', '', false, -1, Infinity, NaN, 1.5, Number.MAX_SAFE_INTEGER + 1])
    ('does not invent a count for invalid/missing value %s', value => {
        expect(countOrUnknown(value, { sourceAvailable: true })).toBeNull();
    });
});
