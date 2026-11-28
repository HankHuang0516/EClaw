'use strict';

// Synthetic, local bytes only. This module has no URL/path input or uploader/publication adapter.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const sharp = require(require.resolve('sharp', { paths: [path.resolve(__dirname, '../../backend')] }));

const LIMITS = Object.freeze({ imageBytes: 5 * 1024 * 1024, totalImageBytes: 8 * 1024 * 1024,
    images: 2, pixels: 16000000, dimension: 8192 });
const FORMATS = Object.freeze({ 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/webp': 'webp' });
const LICENSES = Object.freeze(['EXPLICIT_PERMISSION', 'CC_BY_4_0', 'CC0_1_0']);
const MARKER = 'SYNTHETIC_IMAGE_METADATA_ONLY';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const exact = (v, keys) => plain(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const stable = v => plain(v) ? JSON.stringify(Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]]))) : JSON.stringify(v);
const fail = (error, status = 400) => ({ success: false, error, status });

function dependencyInfo() {
    const lock = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../backend/package-lock.json'), 'utf8'));
    return { node: process.versions.node, sharp: sharp.versions.sharp, vips: sharp.versions.vips,
        png: sharp.versions.png, mozjpeg: sharp.versions.mozjpeg, webp: sharp.versions.webp,
        lockedSharp: lock.packages['node_modules/sharp'].version,
        source: 'backend/package.json + backend/package-lock.json; existing backend/node_modules/sharp', installedDependencies: false };
}

function safeContext(context) {
    if (!exact(context, ['caseId', 'publisherId', 'datasetId', 'recordKey', 'sourceUrl'])
        || !['caseId', 'publisherId', 'datasetId', 'recordKey'].every(k => typeof context[k] === 'string')
        || !/^case_synthetic_[A-Za-z0-9_-]{1,64}$/.test(context.caseId)
        || !/^synthetic-[a-z0-9-]{1,48}$/.test(context.publisherId)
        || !/^synthetic-[a-z0-9-]{1,48}$/.test(context.datasetId)
        || !/^synthetic_[A-Za-z0-9_-]{1,96}$/.test(context.recordKey)) return false;
    if (context.sourceUrl === null) return true;
    if (typeof context.sourceUrl !== 'string' || context.sourceUrl.length > 512) return false;
    try {
        const u = new URL(context.sourceUrl);
        return u.protocol === 'https:' && u.hostname.endsWith('.example.invalid') && !u.username && !u.password && !u.port && !u.search && !u.hash;
    } catch { return false; }
}

function effectiveLimits(overrides = {}) {
    if (!plain(overrides) || Object.keys(overrides).some(k => !Object.hasOwn(LIMITS, k))) return null;
    const limits = { ...LIMITS, ...overrides };
    return Object.keys(LIMITS).every(k => Number.isSafeInteger(limits[k]) && limits[k] > 0 && limits[k] <= LIMITS[k]) ? limits : null;
}

function validateGrant(input, trusted) {
    if (!exact(input, ['bytes', 'declaredMime', 'rights'])) return fail('IMAGE_BYTES_ONLY');
    if (!exact(trusted, ['synthetic', 'context', 'grant']) || trusted.synthetic !== true || !safeContext(trusted.context)) return fail('SYNTHETIC_CONTEXT_REQUIRED', 403);
    const rights = input.rights;
    if (!plain(rights)) return fail('PHOTO_RIGHTS_REQUIRED');
    if (!LICENSES.includes(rights.license)) return fail('PHOTO_LICENSE_NOT_ALLOWED');
    if (!exact(rights, ['license', 'evidenceRef', 'attributionRef', 'permitsRedaction'])
        || typeof rights.evidenceRef !== 'string' || typeof rights.attributionRef !== 'string'
        || !/^ev_synthetic_[A-Za-z0-9_-]{1,64}$/.test(rights.evidenceRef)
        || !/^credit_synthetic_[A-Za-z0-9_-]{1,64}$/.test(rights.attributionRef)
        || rights.permitsRedaction !== true) return fail('PHOTO_RIGHTS_REQUIRED');
    const grant = trusted.grant;
    if (!exact(grant, ['verified', 'context', 'rights', 'originalSha256']) || grant.verified !== true
        || stable(grant.context) !== stable(trusted.context) || stable(grant.rights) !== stable(rights)
        || !/^[a-f0-9]{64}$/.test(grant.originalSha256)) return fail('PHOTO_CONTEXT_MISMATCH', 403);
    if (!Buffer.isBuffer(input.bytes)) return fail('IMAGE_BYTES_ONLY');
    if (digest(input.bytes) !== grant.originalSha256) return fail('PHOTO_BYTES_NOT_BOUND', 403);
    return { success: true };
}

function crc32(bytes) {
    let c = 0xffffffff;
    for (const byte of bytes) {
        c ^= byte;
        for (let n = 0; n < 8; n++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0);
    }
    return (c ^ 0xffffffff) >>> 0;
}

function pngChunks(bytes) {
    const chunks = []; let at = 8;
    while (at < bytes.length) {
        if (at + 12 > bytes.length || chunks.length >= 10000) return null;
        const length = bytes.readUInt32BE(at), end = at + 12 + length;
        if (end > bytes.length) return null;
        const type = bytes.toString('ascii', at + 4, at + 8);
        if (crc32(bytes.subarray(at + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) return null;
        chunks.push({ type, at, end, length }); at = end;
    }
    return chunks.length && chunks[0].type === 'IHDR' && chunks[0].length === 13
        && chunks.filter(c => c.type === 'IHDR').length === 1 && chunks.filter(c => c.type === 'IEND').length === 1
        && chunks.at(-1).type === 'IEND' && chunks.at(-1).length === 0 ? chunks : null;
}

function containerFormat(bytes) {
    if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
        const chunks = pngChunks(bytes);
        if (!chunks || !chunks.some(c => c.type === 'IDAT')) return fail('INVALID_IMAGE_CONTAINER', 422);
        if (chunks.some(c => c.type === 'acTL')) return fail('ANIMATED_IMAGE_NOT_ALLOWED', 422);
        return { success: true, format: 'png' };
    }
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
        return bytes.length >= 4 && bytes.readUInt16BE(bytes.length - 2) === 0xffd9
            ? { success: true, format: 'jpeg' } : fail('INVALID_IMAGE_CONTAINER', 422);
    }
    if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
        return bytes.readUInt32LE(4) + 8 === bytes.length ? { success: true, format: 'webp' } : fail('INVALID_IMAGE_CONTAINER', 422);
    }
    return fail('UNSUPPORTED_IMAGE_SIGNATURE', 415);
}

// Inspect the actual TIFF GPS directory, not a coincidental word in a metadata string.
function hasGpsIFD(exif) {
    if (!Buffer.isBuffer(exif) || exif.length < 14) return false;
    try {
        const tiff = exif.toString('ascii', 0, 6) === 'Exif\0\0' ? exif.subarray(6) : exif;
        const byteOrder = tiff.toString('ascii', 0, 2);
        if (!['II', 'MM'].includes(byteOrder)) return false;
        const little = byteOrder === 'II';
        const u16 = at => little ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at);
        const u32 = at => little ? tiff.readUInt32LE(at) : tiff.readUInt32BE(at);
        if (u16(2) !== 42) return false;
        const first = u32(4); let gps = null;
        for (let i = 0; i < u16(first); i++) {
            const at = first + 2 + i * 12;
            if (u16(at) === 0x8825) gps = u32(at + 8);
        }
        if (gps === null) return false;
        const tags = new Set();
        for (let i = 0; i < u16(gps); i++) tags.add(u16(gps + 2 + i * 12));
        return [1, 2, 3, 4].every(tag => tags.has(tag));
    } catch { return false; }
}

function metadataSummary(meta) {
    return { format: meta.format, width: meta.width, height: meta.height,
        exif: !!meta.exif?.length, gpsIFD: hasGpsIFD(meta.exif), xmp: !!meta.xmp?.length,
        icc: !!meta.icc?.length, iptc: !!meta.iptc?.length, comments: !!meta.comments?.length,
        orientation: meta.orientation ?? null, pages: meta.pages ?? 1 };
}

async function sanitizeImageBytes(input, trusted, overrides = {}) {
    const limits = effectiveLimits(overrides);
    if (!limits) return fail('INVALID_IMAGE_LIMITS');
    if (!plain(input) || !Buffer.isBuffer(input.bytes)) return fail('IMAGE_BYTES_ONLY');
    if (!input.bytes.length || input.bytes.length > limits.imageBytes) return fail('IMAGE_BYTE_LIMIT', 413);
    const grant = validateGrant(input, trusted);
    if (!grant.success) return grant;
    if (typeof input.declaredMime !== 'string' || !Object.hasOwn(FORMATS, input.declaredMime)) return fail('UNSUPPORTED_IMAGE_MIME', 415);
    const container = containerFormat(input.bytes);
    if (!container.success) return container;
    if (container.format !== FORMATS[input.declaredMime]) return fail('IMAGE_MIME_MISMATCH', 415);
    try {
        const decoder = sharp(input.bytes, { failOn: 'warning', limitInputPixels: limits.pixels });
        const before = await decoder.metadata();
        if (before.format !== container.format) return fail('IMAGE_MIME_MISMATCH', 415);
        if (!Number.isSafeInteger(before.width) || !Number.isSafeInteger(before.height)
            || before.width < 1 || before.height < 1 || before.width > limits.dimension || before.height > limits.dimension
            || before.width * before.height > limits.pixels) return fail('IMAGE_DIMENSION_LIMIT', 413);
        if ((before.pages ?? 1) !== 1) return fail('ANIMATED_IMAGE_NOT_ALLOWED', 422);
        // Full pixel decode and encode. No keepMetadata/withExif/withXmp/withIccProfile on this pipeline.
        const output = await decoder.rotate().png({ compressionLevel: 6 }).toBuffer();
        if (output.length > limits.imageBytes) return fail('IMAGE_OUTPUT_LIMIT', 413);
        const after = await sharp(output, { failOn: 'warning', limitInputPixels: limits.pixels }).metadata();
        const summary = metadataSummary(after);
        if (summary.exif || summary.gpsIFD || summary.xmp || summary.icc || summary.iptc || summary.comments || summary.orientation !== null) return fail('METADATA_NOT_REMOVED', 422);
        // Decode the re-encoded output as pixels too; header-only parsing is not the acceptance gate.
        await sharp(output, { failOn: 'warning', limitInputPixels: limits.pixels }).raw().toBuffer();
        return { success: true, simulation: true, state: 'SANITIZED_PRIVATE', publicVisible: false,
            semanticSafetyReviewed: false, bytes: output, mimeType: 'image/png', byteLength: output.length,
            width: after.width, height: after.height, before: metadataSummary(before), after: summary,
            binding: { contextSha256: digest(stable(trusted.context)), rightsSha256: digest(stable(input.rights)),
                originalSha256: digest(input.bytes), sanitizedSha256: digest(output) } };
    } catch (error) {
        return /pixel limit/i.test(String(error.message)) ? fail('IMAGE_DIMENSION_LIMIT', 413) : fail('IMAGE_DECODE_FAILED', 422);
    }
}

async function sanitizeImageSet(items, overrides = {}) {
    const limits = effectiveLimits(overrides);
    if (!limits) return fail('INVALID_IMAGE_LIMITS');
    if (!Array.isArray(items) || !items.length || items.length > limits.images) return fail('IMAGE_COUNT_LIMIT', 413);
    if (items.some(item => !exact(item, ['input', 'trusted']) || !Buffer.isBuffer(item.input?.bytes))) return fail('IMAGE_BYTES_ONLY');
    if (items.reduce((sum, item) => sum + item.input.bytes.length, 0) > limits.totalImageBytes) return fail('IMAGE_TOTAL_BYTE_LIMIT', 413);
    const context = stable(items[0].trusted?.context);
    if (items.some(item => stable(item.trusted?.context) !== context)) return fail('PHOTO_CONTEXT_MISMATCH', 403);
    const images = [];
    let outputBytes = 0;
    for (const item of items) {
        const result = await sanitizeImageBytes(item.input, item.trusted, overrides);
        if (!result.success) return result;
        outputBytes += result.byteLength;
        if (outputBytes > limits.totalImageBytes) return fail('IMAGE_TOTAL_OUTPUT_LIMIT', 413);
        images.push(result);
    }
    return { success: true, simulation: true, state: 'SANITIZED_PRIVATE', publicVisible: false, images };
}

function pngText(bytes) {
    const payload = Buffer.from(`Comment\0${MARKER}`, 'utf8'), type = Buffer.from('tEXt');
    const chunk = Buffer.alloc(payload.length + 12);
    chunk.writeUInt32BE(payload.length); type.copy(chunk, 4); payload.copy(chunk, 8);
    chunk.writeUInt32BE(crc32(Buffer.concat([type, payload])), chunk.length - 4);
    const end = pngChunks(bytes).at(-1).at;
    return Buffer.concat([bytes.subarray(0, end), chunk, bytes.subarray(end)]);
}

async function syntheticFixture(format = 'png', { width = 128, height = 96, orientation = 1 } = {}) {
    if (!['png', 'jpeg', 'webp'].includes(format) || !Number.isSafeInteger(width) || !Number.isSafeInteger(height)
        || width < 1 || height < 1 || width * height > LIMITS.pixels + 1) throw new Error('INVALID_SYNTHETIC_FIXTURE');
    const raw = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const at = (y * width + x) * 3;
        raw[at] = (x * 7 + y * 3) % 256; raw[at + 1] = (x * 5 + y * 11) % 256; raw[at + 2] = (x ^ y) % 256;
    }
    const xmp = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/" dc:description="${MARKER}"/></rdf:RDF></x:xmpmeta>`;
    let pipeline = sharp(raw, { raw: { width, height, channels: 3 } })
        .withExif({ IFD0: { Artist: MARKER, ImageDescription: MARKER },
            IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '0/1 0/1 0/1', GPSLongitudeRef: 'E', GPSLongitude: '0/1 0/1 0/1' } })
        .withXmp(xmp).withIccProfile('srgb').withMetadata({ orientation });
    pipeline = format === 'jpeg' ? pipeline.jpeg({ quality: 90 }) : format === 'webp' ? pipeline.webp({ lossless: true }) : pipeline.png();
    let bytes = await pipeline.toBuffer();
    if (format === 'png') bytes = pngText(bytes);
    if (format === 'jpeg') {
        const text = Buffer.from(MARKER), comment = Buffer.alloc(text.length + 4);
        comment.writeUInt16BE(0xfffe); comment.writeUInt16BE(text.length + 2, 2); text.copy(comment, 4);
        bytes = Buffer.concat([bytes.subarray(0, 2), comment, bytes.subarray(2)]);
    }
    const rights = { license: 'EXPLICIT_PERMISSION', evidenceRef: 'ev_synthetic_pixels', attributionRef: 'credit_synthetic_pixels', permitsRedaction: true };
    const context = { caseId: 'case_synthetic_pixels', publisherId: 'synthetic-publisher', datasetId: 'synthetic-dataset',
        recordKey: 'synthetic_record_pixels', sourceUrl: 'https://pixels.example.invalid/synthetic/pixels' };
    return { input: { bytes, declaredMime: `image/${format}`, rights },
        trusted: { synthetic: true, context, grant: { verified: true, context: { ...context }, rights: { ...rights }, originalSha256: digest(bytes) } } };
}

async function fixtureProof(fixture) {
    const bytes = fixture.input.bytes, meta = await sharp(bytes, { failOn: 'warning' }).metadata();
    const summary = metadataSummary(meta);
    return { ...summary, markerPresent: bytes.includes(Buffer.from(MARKER)),
        pngTextPresent: meta.format === 'png' && pngChunks(bytes).some(chunk => chunk.type === 'tEXt'),
        jpegCommentPresent: meta.format === 'jpeg' && bytes.readUInt16BE(2) === 0xfffe,
        pixelBytes: (await sharp(bytes, { failOn: 'warning' }).rotate().raw().toBuffer()).length };
}

module.exports = { LIMITS, LICENSES, MARKER, dependencyInfo, sanitizeImageBytes, sanitizeImageSet,
    syntheticFixture, fixtureProof, digest };
