require('./helpers/mock-setup');
const path = require('node:path');
const sharp = require('sharp');
const image = require('../../../tools/stray-map-intake/image-rehearsal');

let fixtures;
beforeAll(async () => {
    fixtures = Object.fromEntries(await Promise.all(['png', 'jpeg', 'webp'].map(async format => [format, await image.syntheticFixture(format)])));
});
function clone(fixture) {
    return { input: { ...fixture.input, bytes: Buffer.from(fixture.input.bytes), rights: { ...fixture.input.rights } },
        trusted: { synthetic: true, context: { ...fixture.trusted.context }, grant: { ...fixture.trusted.grant,
            context: { ...fixture.trusted.grant.context }, rights: { ...fixture.trusted.grant.rights } } } };
}
function bindBytes(fixture, bytes) {
    const f = clone(fixture); f.input.bytes = bytes; f.trusted.grant.originalSha256 = image.digest(bytes); return f;
}
const sanitize = (f, limits) => image.sanitizeImageBytes(f.input, f.trusted, limits);

describe('actual generated image bytes, existing pinned decoder and metadata removal', () => {
    test('uses the existing lockfile codec without adding a dependency', () => {
        expect(image.dependencyInfo()).toMatchObject({ sharp: '0.35.1', lockedSharp: '0.35.1', installedDependencies: false });
    });
    test.each(['png', 'jpeg', 'webp'])('%s contains real synthetic EXIF/GPS/XMP/ICC before a full decode/re-encode', async format => {
        const fixture = fixtures[format], proof = await image.fixtureProof(fixture);
        expect(proof).toMatchObject({ format, width: 128, height: 96, exif: true, gpsIFD: true, xmp: true, icc: true,
            markerPresent: true, pixelBytes: 128 * 96 * 3 });
        if (format === 'png') expect(proof.pngTextPresent).toBe(true);
        if (format === 'jpeg') expect(proof.jpegCommentPresent).toBe(true);
        const result = await sanitize(fixture);
        expect(result).toMatchObject({ success: true, simulation: true, state: 'SANITIZED_PRIVATE', publicVisible: false,
            semanticSafetyReviewed: false, mimeType: 'image/png', width: 128, height: 96,
            after: { exif: false, gpsIFD: false, xmp: false, icc: false, iptc: false, comments: false, orientation: null } });
        expect(result.bytes.includes(Buffer.from(image.MARKER))).toBe(false);
        expect(result.binding.originalSha256).toBe(image.digest(fixture.input.bytes));
        expect(result.binding.sanitizedSha256).toBe(image.digest(result.bytes));
        const beforePixels = await sharp(fixture.input.bytes).rotate().raw().toBuffer();
        const afterPixels = await sharp(result.bytes).raw().toBuffer();
        // Compare decoded pixels, including JPEG's already-decoded lossy pixels. PNG output is lossless.
        expect(afterPixels.equals(beforePixels)).toBe(true);
    });
    test('applies EXIF orientation before dropping the orientation and metadata', async () => {
        const f = await image.syntheticFixture('jpeg', { orientation: 6 });
        expect((await image.fixtureProof(f)).orientation).toBe(6);
        const result = await sanitize(f);
        expect(result).toMatchObject({ success: true, width: 96, height: 128, after: { orientation: null, exif: false } });
        expect((await sharp(result.bytes).raw().toBuffer()).equals(await sharp(f.input.bytes).rotate().raw().toBuffer())).toBe(true);
    });
});

describe('rights and same-case/source/image context remain bound', () => {
    test('missing rights is rejected before pixel work', async () => {
        const f = clone(fixtures.png); f.input.rights = null;
        expect(await sanitize(f)).toMatchObject({ success: false, error: 'PHOTO_RIGHTS_REQUIRED' });
    });
    test.each(['PUBLICLY_VISIBLE', 'ALL_RIGHTS_RESERVED', 'UNKNOWN', 'CC_BY_NC_4_0'])('unknown or unsupported licence %s is not public permission', async license => {
        const f = clone(fixtures.png); f.input.rights.license = license; f.trusted.grant.rights.license = license;
        expect(await sanitize(f)).toMatchObject({ success: false, error: 'PHOTO_LICENSE_NOT_ALLOWED' });
    });
    test.each(['EXPLICIT_PERMISSION', 'CC_BY_4_0', 'CC0_1_0'])('allowed synthetic licence %s still requires the matched server grant', async license => {
        const f = clone(fixtures.png); f.input.rights.license = license; f.trusted.grant.rights.license = license;
        expect((await sanitize(f)).success).toBe(true);
        f.trusted.grant.verified = false;
        expect(await sanitize(f)).toMatchObject({ success: false, error: 'PHOTO_CONTEXT_MISMATCH' });
    });
    test.each(['evidenceRef', 'attributionRef', 'permitsRedaction'])('missing %s is rejected even with a self-consistent grant', async key => {
        const f = clone(fixtures.png); delete f.input.rights[key]; delete f.trusted.grant.rights[key];
        expect(await sanitize(f)).toMatchObject({ success: false, error: 'PHOTO_RIGHTS_REQUIRED' });
    });
    test.each(['caseId', 'publisherId', 'datasetId', 'recordKey', 'sourceUrl'])('a grant from a different %s cannot authorize this case', async key => {
        const f = clone(fixtures.png); f.trusted.grant.context[key] = 'synthetic_mismatched_context';
        expect(await sanitize(f)).toMatchObject({ success: false, error: 'PHOTO_CONTEXT_MISMATCH', status: 403 });
    });
    test('reusing a good grant for different image bytes fails before codec acceptance', async () => {
        const f = clone(fixtures.png); f.input.bytes = fixtures.jpeg.input.bytes;
        expect(await sanitize(f)).toMatchObject({ success: false, error: 'PHOTO_BYTES_NOT_BOUND', status: 403 });
    });
    test('changed rights evidence cannot reuse an earlier grant', async () => {
        const f = clone(fixtures.png); f.input.rights.evidenceRef = 'ev_synthetic_different';
        expect(await sanitize(f)).toMatchObject({ success: false, error: 'PHOTO_CONTEXT_MISMATCH' });
    });
    test('context and MIME values are typed, not coerced from arrays', async () => {
        const f = clone(fixtures.png); f.trusted.context.caseId = [f.trusted.context.caseId];
        expect(await sanitize(f)).toMatchObject({ success: false, error: 'SYNTHETIC_CONTEXT_REQUIRED' });
        const g = clone(fixtures.png); g.input.declaredMime = ['image/png'];
        expect(await sanitize(g)).toMatchObject({ success: false, error: 'UNSUPPORTED_IMAGE_MIME' });
    });
});

describe('signature, actual decoder, truncation and size boundaries', () => {
    test.each(['png', 'jpeg', 'webp'])('%s declared as a different MIME is rejected', async format => {
        const f = clone(fixtures[format]); f.input.declaredMime = format === 'png' ? 'image/jpeg' : 'image/png';
        expect(await sanitize(f)).toMatchObject({ success: false, error: 'IMAGE_MIME_MISMATCH', status: 415 });
    });
    test.each(['png', 'jpeg', 'webp'])('%s signature spoof is rejected, not treated as verified metadata', async format => {
        let bytes;
        if (format === 'png') bytes = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('synthetic garbage')]);
        else if (format === 'jpeg') bytes = Buffer.from('ffd8ff73796e746865746963ffd9', 'hex');
        else { bytes = Buffer.alloc(12); bytes.write('RIFF'); bytes.writeUInt32LE(4, 4); bytes.write('WEBP', 8); }
        const result = await sanitize(bindBytes(fixtures[format], bytes));
        expect(result.success).toBe(false);
        expect(['INVALID_IMAGE_CONTAINER', 'IMAGE_DECODE_FAILED']).toContain(result.error);
    });
    test.each(['png', 'jpeg', 'webp'])('truncated %s bytes fail closed', async format => {
        const f = fixtures[format];
        expect(await sanitize(bindBytes(f, f.input.bytes.subarray(0, f.input.bytes.length - 7))))
            .toMatchObject({ success: false, error: 'INVALID_IMAGE_CONTAINER' });
    });
    test('a JPEG with a readable header and EOI but truncated scan fails full decode', async () => {
        const f = fixtures.jpeg, at = f.input.bytes.indexOf(Buffer.from('ffda', 'hex'));
        expect(at).toBeGreaterThan(0);
        const scan = at + 2 + f.input.bytes.readUInt16BE(at + 2);
        const bytes = Buffer.concat([f.input.bytes.subarray(0, scan + 8), Buffer.from('ffd9', 'hex')]);
        expect((await sharp(bytes).metadata()).width).toBe(128); // Header-only inspection would pass.
        expect(await sanitize(bindBytes(f, bytes))).toMatchObject({ success: false, error: 'IMAGE_DECODE_FAILED' });
    });
    test('PNG compressed data corruption fails its CRC', async () => {
        const f = fixtures.png, bytes = Buffer.from(f.input.bytes), at = bytes.indexOf(Buffer.from('IDAT')) + 4;
        bytes[at] ^= 0xff;
        expect(await sanitize(bindBytes(f, bytes))).toMatchObject({ success: false, error: 'INVALID_IMAGE_CONTAINER' });
    });
    test.each(['png', 'jpeg', 'webp'])('trailing data after complete %s container is rejected', async format => {
        expect((await sanitize(bindBytes(fixtures[format], Buffer.concat([fixtures[format].input.bytes, Buffer.from('unexpected tail')])))).success).toBe(false);
    });
    test('actual input byte count is enforced before decode', async () => {
        expect(await sanitize(fixtures.png, { imageBytes: fixtures.png.input.bytes.length - 1 })).toMatchObject({ error: 'IMAGE_BYTE_LIMIT', status: 413 });
    });
    test('expansion from JPEG into sanitized PNG cannot bypass the output byte cap', async () => {
        expect(await sanitize(fixtures.jpeg, { imageBytes: fixtures.jpeg.input.bytes.length }))
            .toMatchObject({ error: 'IMAGE_OUTPUT_LIMIT', status: 413 });
    });
    test('actual dimensions and decoded-pixel limits are enforced', async () => {
        expect(await sanitize(fixtures.png, { dimension: 127 })).toMatchObject({ error: 'IMAGE_DIMENSION_LIMIT', status: 413 });
        expect(await sanitize(fixtures.png, { pixels: 1000 })).toMatchObject({ error: 'IMAGE_DIMENSION_LIMIT', status: 413 });
        const wide = await image.syntheticFixture('png', { width: 8193, height: 1 });
        expect(await sanitize(wide)).toMatchObject({ error: 'IMAGE_DIMENSION_LIMIT', status: 413 });
    });
    test.each([{ imageBytes: image.LIMITS.imageBytes + 1 }, { pixels: 0 }, { unknown: 1 }])('a test override cannot loosen policy: %j', async limits => {
        expect(await sanitize(fixtures.png, limits)).toMatchObject({ error: 'INVALID_IMAGE_LIMITS' });
    });
});

describe('bounded same-case image set and isolation', () => {
    test('two real formats in the same synthetic case produce private sanitized bytes', async () => {
        const result = await image.sanitizeImageSet([fixtures.png, fixtures.jpeg]);
        expect(result).toMatchObject({ success: true, publicVisible: false, simulation: true });
        expect(result.images).toHaveLength(2);
        expect(new Set(result.images.map(item => item.binding.contextSha256)).size).toBe(1);
    });
    test('combined real byte size and photo count are bounded', async () => {
        expect(await image.sanitizeImageSet([fixtures.png, fixtures.jpeg], { totalImageBytes: fixtures.png.input.bytes.length + fixtures.jpeg.input.bytes.length - 1 }))
            .toMatchObject({ error: 'IMAGE_TOTAL_BYTE_LIMIT', status: 413 });
        expect(await image.sanitizeImageSet([fixtures.png, fixtures.jpeg, fixtures.webp])).toMatchObject({ error: 'IMAGE_COUNT_LIMIT' });
        expect(await image.sanitizeImageSet([])).toMatchObject({ error: 'IMAGE_COUNT_LIMIT' });
    });
    test('combined sanitized outputs are bounded as well as original inputs', async () => {
        expect(await image.sanitizeImageSet([fixtures.jpeg, fixtures.jpeg], { totalImageBytes: 2 * fixtures.jpeg.input.bytes.length }))
            .toMatchObject({ error: 'IMAGE_TOTAL_OUTPUT_LIMIT', status: 413 });
    });
    test('different cases cannot be mixed into one photo set', async () => {
        const f = clone(fixtures.jpeg); f.trusted.context.caseId = 'case_synthetic_other'; f.trusted.grant.context.caseId = 'case_synthetic_other';
        expect(await image.sanitizeImageSet([fixtures.png, f])).toMatchObject({ error: 'PHOTO_CONTEXT_MISMATCH' });
    });
    test.each(['https://image.example.invalid/photo.jpg', '/private/synthetic-photo.jpg'])('does not fetch or open a byte input string %s', async value => {
        const f = clone(fixtures.png); f.input.bytes = value;
        expect(await sanitize(f)).toMatchObject({ error: 'IMAGE_BYTES_ONLY' });
    });
    test('rejects URL fields and nonsynthetic context', async () => {
        const f = clone(fixtures.png); f.input.url = 'https://image.example.invalid/never-fetch';
        expect(await sanitize(f)).toMatchObject({ error: 'IMAGE_BYTES_ONLY' });
        const g = clone(fixtures.png); g.trusted.synthetic = false;
        expect(await sanitize(g)).toMatchObject({ error: 'SYNTHETIC_CONTEXT_REQUIRED' });
    });
    test('source file has no HTTP, uploader or existing receipt-store dependency', () => {
        const source = require('node:fs').readFileSync(path.resolve(__dirname, '../../../tools/stray-map-intake/image-rehearsal.js'), 'utf8');
        expect(source).not.toMatch(/fetch\(|node:https?|require\(['"]\.\/rehearsal|require\(['"]\.\/contract/);
    });
});
