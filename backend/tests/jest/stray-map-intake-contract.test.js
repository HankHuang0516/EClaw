/** Synthetic draft only; no production connection. */
require('./helpers/mock-setup');
const Ajv = require('ajv');
const spec = require('../../../docs/stray-map-external-intake.openapi.json');
const c = require('../../../tools/stray-map-intake/contract');
const f = require('../../../tools/stray-map-intake/synthetic-fixtures');
const evaluate = (body = f.taiwan(), context = {}) => c.validateTip(JSON.stringify(body), { submittedAt: f.SUBMITTED, sourcePolicy: f.policy, ...context });
const schemas = JSON.parse(JSON.stringify(spec.components.schemas).replace(/#\/components\/schemas\//g, '#/definitions/'));
const ajv = new Ajv({ allErrors: true });
const schema = ajv.compile({ definitions: schemas, $ref: '#/definitions/Tip' });

describe('draft v2 global precision and locale contract', () => {
    test('stays disabled and has no official activation path', () => {
        expect(c.DRAFT.enabled).toBe(false); expect(c.DRAFT.officialApiVerified).toBe(false);
        expect(spec['x-default-enabled']).toBe(false); expect(spec['x-terms-approval']).toBe('PENDING_HANK_APPROVAL');
        expect(spec.servers[0].url).toBe('https://api.example.invalid');
    });
    test.each([f.taiwan, f.washington])('schema and executable accept supported synthetic local data', factory => {
        const body = factory(); expect(schema(body)).toBe(true); const result = evaluate(body);
        expect(result.success).toBe(true); expect(result.review.publicVisible).toBe(false);
        expect(result.canonicalPayload.observation).toEqual(body.observation);
        expect(result.canonicalPayload.display).toEqual(body.display);
    });
    test('date-only US case has no invented UTC instant and no photo requirement', () => {
        const result = evaluate(f.washington());
        expect(result.canonicalPayload.observation.value).toBe('2026-11-25');
        expect(result.canonicalPayload.source.publishedAt.precision).toBe('DATE');
        expect(result.canonicalPayload.photos).toEqual([]);
    });
    test('unknown precision stays unknown; URL-less verified datasets have stable private identity', () => {
        const b = f.taiwan(); b.observation = f.unknown(); b.source.publishedAt = f.unknown();
        const r = evaluate(b); expect(r.success).toBe(true); expect(r.candidateFingerprint).toBeNull();
        expect(r.canonicalPayload.source.url).toBeNull();
        b.source.recordKey = ''; expect(evaluate(b).success).toBe(false);
    });
    test.each(['status', 'approved', 'publicVisible', 'deviceId', 'deviceSecret', 'latitude', 'longitude', 'address', 'phone', 'sourcePolicy'])('rejects injected top-level %s', key => {
        const b = { ...f.taiwan(), [key]: 'private-value' }; expect(evaluate(b).error).toBe('INVALID_TIP'); expect(schema(b)).toBe(false);
    });
    test.each(Object.keys(f.taiwan()))('rejects missing %s', key => {
        const b = f.taiwan(); delete b[key]; expect(evaluate(b).success).toBe(false); expect(schema(b)).toBe(false);
    });
    test.each([{ schemaVersion: 1 }, { thirdParty: false }, { selfWitness: true }])('rejects false provenance %j', delta => {
        expect(evaluate({ ...f.taiwan(), ...delta }).success).toBe(false);
    });
});
describe('time precision and language boundaries', () => {
    test.each([
        { precision: 'DATE', value: '2026-02-30', timeZone: 'America/Los_Angeles' },
        { precision: 'DATE', value: '2026-11-25T00:00:00Z', timeZone: 'America/Los_Angeles' },
        { precision: 'DATE', value: '2026-11-25', timeZone: null },
        { precision: 'INSTANT', value: '2026-11-25T12:00:00', timeZone: 'UTC' },
        { precision: 'INSTANT', value: '2026-11-25T12:00:00+08:00', timeZone: 'America/Los_Angeles' },
        { precision: 'UNKNOWN', value: '2026-11-25', timeZone: null },
        { precision: 'DATE', value: '2026-11-25', timeZone: 'not-a-zone' },
    ])('rejects invalid temporal %j', value => { const b = f.taiwan(); b.observation = value; expect(evaluate(b).error).toBe('INVALID_TIMELINE'); });
    test('future instants, local future dates and observed-after-source are rejected', () => {
        for (const field of ['observation', 'publishedAt']) {
            const b = f.taiwan(); if (field === 'observation') b.observation = f.instant('2027-01-01T12:00:00Z', 'UTC');
            else b.source.publishedAt = f.instant('2027-01-01T12:00:00Z', 'UTC');
            expect(evaluate(b).error).toBe('INVALID_TIMELINE');
        }
        const b = f.washington(); b.observation = f.date('2027-01-01'); expect(evaluate(b).error).toBe('INVALID_TIMELINE');
    });
    test.each(['', 'EN_us', 'zh_TW', 'en-US<script>'])('rejects invalid display locale %s', locale => {
        const b = f.taiwan(); b.display.locale = locale; expect(evaluate(b).error).toBe('INVALID_DISPLAY');
    });
    test.each([['title', ''], ['title', 'x'.repeat(121)], ['description', 'x'.repeat(1001)], ['description', 'a\nb']])('bounds reviewed text %s', (key, value) => {
        const b = f.taiwan(); b.display[key] = value; expect(evaluate(b).error).toBe('INVALID_DISPLAY');
    });
    test.each(['latitude', 'longitude', 'address', 'preciseLocation'])('rejects location detail %s', key => {
        const b = f.taiwan(); b.location[key] = 'private'; expect(evaluate(b).error).toBe('INVALID_LOCATION');
    });
    test.each([{ countryCode: 'US', regionCode: 'TW-TPE' }, { countryCode: 'CA', regionCode: 'CA-BC' }, { countryCode: 'TW', regionCode: 'US-WA' }])('enforces trusted regional scope %j', location => {
        const b = f.taiwan(); Object.assign(b.location, location); expect(evaluate(b).error).toBe('INVALID_LOCATION');
    });
    test.each(['WILDLIFE', 'UNKNOWN', 'NEST', 'PROTECTED_SPECIES', 'HABITAT', null])('sensitive/unknown region never maps: %s', value => {
        const b = f.taiwan(); if (value === 'WILDLIFE') b.animal.kind = value;
        else if (value === null) b.location.regionCode = null; else b.location.sensitivity = value;
        const r = evaluate(b); expect(r.success).toBe(true); expect(r.review.mapPolicy).toBe('NEVER');
    });
});
describe('bounded JSON, source policy and image evidence', () => {
    test('limits UTF-8 bytes and rejects duplicate/invalid JSON', () => {
        const raw = JSON.stringify(f.taiwan()); const exact = raw + ' '.repeat(c.LIMITS.jsonBytes - Buffer.byteLength(raw));
        expect(c.validateTip(exact, { submittedAt: f.SUBMITTED, sourcePolicy: f.policy }).success).toBe(true);
        expect(c.validateTip(exact + ' ', {}).status).toBe(413);
        for (const input of ['{', Buffer.from([0xc3, 0x28]), '[]', raw.replace('"selfWitness":false', '"selfWitness":false,"selfWitness":false')]) {
            expect(c.validateTip(input, {}).success).toBe(false);
        }
    });
    test.each([{ contentType: 'text/html' }, { contentEncoding: 'gzip' }])('rejects wrong media %j', context => { expect(evaluate(f.taiwan(), context).status).toBe(415); });
    test.each(['https://127.0.0.1/a', 'http://news.example.invalid/a', 'https://x:y@news.example.invalid/a', 'https://news.example.invalid/a?secret=1'])('rejects arbitrary source URL %s', url => { expect(c.canonicalSourceURL(url)).toBeNull(); });
    test.each([{}, { ...f.policy, verified: false }, { ...f.policy, datasetId: 'wrong-dataset' }])('rejects unverified source policy', sourcePolicy => { expect(evaluate(f.taiwan(), { sourcePolicy }).status).toBe(403); });
    test('photo captions/rights bind to the exact private dataset case', () => {
        const { body, upload } = f.photoFixture(); expect(evaluate(body, { verifiedUploads: [upload] }).success).toBe(true);
        expect(evaluate(body).error).toBe('PHOTO_NOT_VERIFIED');
        body.photos[0].caption = ''; expect(evaluate(body, { verifiedUploads: [upload] }).error).toBe('INVALID_PHOTO');
    });
    test.each(f.safeFlags)('requires trusted photo flag %s', flag => {
        const { body, upload } = f.photoFixture(); upload[flag] = false;
        expect(evaluate(body, { verifiedUploads: [upload] }).error).toBe('PHOTO_NOT_VERIFIED');
    });
    test.each(['publisherId', 'datasetId', 'recordKey', 'sourceUrl', 'sha256'])('rejects mismatched photo context %s', key => {
        const { body, upload } = f.photoFixture(); upload[key] = 'wrong'; expect(evaluate(body, { verifiedUploads: [upload] }).success).toBe(false);
    });
    test.each([{ byteLength: c.LIMITS.imageBytes + 1 }, { byteLength: 0 }, { width: 100000 }, { height: 100000 }, { mimeType: 'image/svg+xml' }])('bounds image metadata %j', delta => {
        const { body, upload } = f.photoFixture(); Object.assign(upload, delta); expect(evaluate(body, { verifiedUploads: [upload] }).error).toBe('PHOTO_LIMIT_EXCEEDED');
    });
    test.each(['ALL_RIGHTS_RESERVED', 'CC_BY_NC_4_0', 'PUBLICLY_VISIBLE'])('rejects unauthorised licence %s', license => {
        const { body, upload } = f.photoFixture(); body.photos[0].rights.license = license;
        expect(evaluate(body, { verifiedUploads: [upload] }).error).toBe('PHOTO_RIGHTS_REQUIRED');
    });
});
describe('durable adapter decisions stay pure', () => {
    test('hashes retain local language and precision; candidate buckets are not unique case IDs', () => {
        const a = f.washington(); const b = f.clone(a); b.source.recordKey = 'private_synthetic_wa_002'; b.display.title = 'Another independent synthetic dog';
        expect(evaluate(a).candidateFingerprint).toBe(evaluate(b).candidateFingerprint);
        expect(evaluate(a).payloadHash).not.toBe(evaluate(b).payloadHash);
    });
    test('idempotent receipt replay is stable and conflicts are rejected', () => {
        const input = { publisherId: 'synthetic-a', key: 'synthetic_key_001', payloadHash: 'a'.repeat(64) };
        const receipt = { success: true, tipId: 'tip_synthetic001', status: 'PENDING', publicVisible: false, submittedAt: f.SUBMITTED };
        const decision = c.decideIdempotency(input); expect(decision.action).toBe('RESERVE');
        const existing = { scopeKey: decision.scopeKey, payloadHash: input.payloadHash, receipt };
        expect(c.decideIdempotency({ ...input, existing }).receipt).toEqual(receipt);
        expect(c.decideIdempotency({ ...input, payloadHash: 'b'.repeat(64), existing }).status).toBe(409);
        expect(c.countOrUnknown(0)).toBeNull(); expect(c.countOrUnknown(0, { sourceAvailable: true })).toBe(0);
    });
});

test('reviewed Unicode text uses JSON Schema character counts without rewriting it', () => {
    const b = f.washington(); b.display.title = '🐕'.repeat(120);
    expect(schema(b)).toBe(true); expect(evaluate(b).canonicalPayload.display.title).toBe(b.display.title);
    b.display.title += '🐕'; expect(schema(b)).toBe(false); expect(evaluate(b).success).toBe(false);
});

describe('mixed precision, DST and unchanged guard regressions', () => {
    test.each([
        [f.date('2026-11-25'), f.instant('2026-11-25T00:00:00Z', 'UTC'), true],
        [f.instant('2026-11-26T01:00:00Z', 'UTC'), f.date('2026-11-25'), false],
        [{ precision: 'DATE', value: '2026-11-26', timeZone: 'Asia/Taipei' }, f.date('2026-11-25'), false],
        [{ precision: 'DATE', value: '2026-11-29', timeZone: 'Asia/Taipei' }, f.date('2026-11-25'), true],
        [f.unknown(), f.date('2026-11-25'), false],
    ])('does not invent an order for overlapping date intervals', (a, b, expected) => {
        expect(c.definitelyAfter(a, b)).toBe(expected);
    });
    test('DST gap is invalid and both explicit offsets in the repeated hour remain distinct', () => {
        expect(c.temporal(f.instant('2026-03-08T02:30:00-08:00', 'America/Los_Angeles'))).toBeNull();
        for (const offset of ['-07:00', '-08:00']) {
            const t = f.instant(`2026-11-01T01:30:00${offset}`, 'America/Los_Angeles'); expect(c.temporal(t)).toEqual(t);
        }
        expect(c.temporal({ precision: 'DATE', value: '2024-02-29', timeZone: 'UTC' }).value).toBe('2024-02-29');
    });
    test('normalizes source URL syntax without network or changing stable record identity', () => {
        const canonical = 'https://news.example.invalid/public-tips/A';
        expect(c.canonicalSourceURL('HTTPS://NEWS.EXAMPLE.INVALID:443/public-tips/%41?utm_source=x#fragment')).toBe(canonical);
        const body = f.taiwan(); body.source.url = canonical;
        expect(evaluate(body).success).toBe(true);
        body.source.url = 'https://news.example.invalid/wrong-path/A'; expect(evaluate(body).status).toBe(403);
    });
    test('rejects escaped duplicate nested JSON keys', () => {
        const raw = JSON.stringify(f.taiwan()).replace('"kind":"DOG"', '"kind":"DOG","k\\u0069nd":"DOG"');
        expect(c.validateTip(raw, {}).error).toBe('DUPLICATE_JSON_KEY');
    });
    test('rejects missing server clock rather than using the execution date', () => {
        expect(evaluate(f.taiwan(), { submittedAt: undefined }).status).toBe(500);
    });
    test('combined image cap, duplicates and arbitrary remote photo fields remain blocked', () => {
        const { body, upload } = f.photoFixture();
        body.photos.push({ ...f.clone(body.photos[0]), uploadId: 'up_synthetic002' });
        const second = { ...f.clone(upload), uploadId: 'up_synthetic002', byteLength: 5 * 1024 * 1024 };
        upload.byteLength = 5 * 1024 * 1024;
        expect(evaluate(body, { verifiedUploads: [upload, second] }).error).toBe('PHOTO_LIMIT_EXCEEDED');
        body.photos[1].uploadId = body.photos[0].uploadId; expect(evaluate(body, { verifiedUploads: [upload] }).error).toBe('INVALID_PHOTO');
        body.photos = [{ ...body.photos[0], url: 'https://image.example.invalid/a.jpg' }]; expect(evaluate(body).error).toBe('INVALID_PHOTO');
    });
});

test('known timezone day intervals reject definitely later observations without changing DATE precision', () => {
    const b = f.washington();
    b.source.publishedAt = f.date('2026-11-23');
    b.observation = { precision: 'DATE', value: '2026-11-25', timeZone: 'Asia/Taipei' };
    expect(evaluate(b).error).toBe('INVALID_TIMELINE');
    expect(c.temporal({ precision: 'DATE', value: '2011-12-30', timeZone: 'Pacific/Apia' })).toBeNull();
});

test('midnight date rollback retains the early reentry interval', () => {
    const observation = { precision: 'DATE', value: '2006-10-29', timeZone: 'America/St_Johns' };
    const publication = f.instant('2006-10-29T03:00:00Z', 'UTC');
    expect(c.definitelyAfter(observation, publication)).toBe(false);
    const b = f.washington(); b.observation = observation; b.source.publishedAt = publication;
    expect(evaluate(b).success).toBe(true); expect(evaluate(b).canonicalPayload.observation).toEqual(observation);
});
