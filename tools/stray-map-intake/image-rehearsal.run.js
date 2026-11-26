#!/usr/bin/env node
'use strict';

// Writes only newly generated synthetic evidence to a new private run directory. No network or uploader.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
const image = require('./image-rehearsal');

function changedBytes(fixture, bytes) {
    return { input: { ...fixture.input, bytes }, trusted: { ...fixture.trusted,
        grant: { ...fixture.trusted.grant, originalSha256: image.digest(bytes) } } };
}
const write = (root, name, bytes) => fs.writeFileSync(path.join(root, name), bytes, { mode: 0o600, flag: 'wx' });

async function run(base) {
    if (!path.isAbsolute(base)) throw new Error('ABSOLUTE_PRIVATE_EVIDENCE_DIRECTORY_REQUIRED');
    fs.mkdirSync(base, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(base).isSymbolicLink() || (fs.statSync(base).mode & 0o077)) throw new Error('PRIVATE_REAL_DIRECTORY_REQUIRED');
    const root = path.join(fs.realpathSync(base), 'image-bytes-' + randomUUID());
    fs.mkdirSync(root, { mode: 0o700 });
    const report = { kind: 'synthetic-image-bytes-isolated-rehearsal', success: false, simulation: true,
        dependencies: image.dependencyInfo(), limits: image.LIMITS, fixtures: [], rejections: [],
        semanticSafetyReviewed: false, officialApiVerified: false, uploaderIntegrated: false,
        productionWrites: 0, realPhotosRead: 0, networkRequests: 0, productAsset: false, iconWatermark: 'NOT_APPLICABLE' };
    const reject = async (name, fixture, expected, limits) => {
        const result = await image.sanitizeImageBytes(fixture.input, fixture.trusted, limits);
        report.rejections.push({ name, passed: !result.success && result.error === expected,
            expected, actual: result.error || null, status: result.status || null });
        assert.equal(result.success, false, name); assert.equal(result.error, expected, name);
    };
    try {
        const fixtures = {};
        for (const format of ['png', 'jpeg', 'webp']) {
            const fixture = await image.syntheticFixture(format); fixtures[format] = fixture;
            const proof = await image.fixtureProof(fixture);
            assert.ok(proof.exif && proof.gpsIFD && proof.xmp && proof.icc && proof.markerPresent);
            const result = await image.sanitizeImageBytes(fixture.input, fixture.trusted);
            assert.equal(result.success, true);
            assert.equal(result.bytes.includes(Buffer.from(image.MARKER)), false);
            const inputName = `synthetic-input.${format === 'jpeg' ? 'jpg' : format}`;
            const outputName = `synthetic-sanitized-from-${format}.png`;
            write(root, inputName, fixture.input.bytes); write(root, outputName, result.bytes);
            report.fixtures.push({ format, inputName, outputName, inputBytes: fixture.input.bytes.length,
                outputBytes: result.byteLength, before: proof, after: result.after, binding: result.binding,
                state: result.state, publicVisible: result.publicVisible });
            write(root, `synthetic-grant-${format}.private.json`, JSON.stringify(fixture.trusted, null, 2) + '\n');
            await reject(`${format}-wrong-mime`, { ...fixture, input: { ...fixture.input, declaredMime: format === 'png' ? 'image/jpeg' : 'image/png' } }, 'IMAGE_MIME_MISMATCH');
            await reject(`${format}-truncated`, changedBytes(fixture, fixture.input.bytes.subarray(0, fixture.input.bytes.length - 7)), 'INVALID_IMAGE_CONTAINER');
        }
        const png = fixtures.png, jpeg = fixtures.jpeg;
        await reject('missing-rights', { ...png, input: { ...png.input, rights: null } }, 'PHOTO_RIGHTS_REQUIRED');
        await reject('unknown-license', { ...png, input: { ...png.input, rights: { ...png.input.rights, license: 'PUBLICLY_VISIBLE' } } }, 'PHOTO_LICENSE_NOT_ALLOWED');
        await reject('spoofed-png', changedBytes(png, Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('synthetic garbage')])), 'INVALID_IMAGE_CONTAINER');
        await reject('input-byte-limit', png, 'IMAGE_BYTE_LIMIT', { imageBytes: png.input.bytes.length - 1 });
        await reject('pixel-limit', png, 'IMAGE_DIMENSION_LIMIT', { pixels: 1000 });
        await reject('dimension-limit', png, 'IMAGE_DIMENSION_LIMIT', { dimension: 127 });
        await reject('output-expansion-limit', jpeg, 'IMAGE_OUTPUT_LIMIT', { imageBytes: jpeg.input.bytes.length });
        const mismatch = { ...png, trusted: { ...png.trusted, grant: { ...png.trusted.grant,
            context: { ...png.trusted.grant.context, caseId: 'case_synthetic_different' } } } };
        await reject('different-case-grant', mismatch, 'PHOTO_CONTEXT_MISMATCH');
        report.checkedAt = new Date().toISOString(); report.success = true;
    } catch (error) {
        report.error = 'IMAGE_REHEARSAL_ASSERTION_FAILED';
        throw error;
    } finally {
        write(root, 'image-bytes-result.private.json', JSON.stringify(report, null, 2) + '\n');
    }
    return { success: report.success, simulation: true, formats: report.fixtures.length,
        rejectionCases: report.rejections.length, evidenceDirectory: root };
}

if (require.main === module) {
    if (process.argv.length !== 3) { console.error('Usage: node tools/stray-map-intake/image-rehearsal.run.js /absolute/private/evidence-base'); process.exitCode = 1; }
    else run(process.argv[2]).then(value => console.log(JSON.stringify(value))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { run };
