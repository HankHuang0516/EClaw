// Companion avatar derivation utilities (Plaza Plan-3 Phase 3).
//
// Pure, dependency-light helpers for turning a PETDX-style sprite sheet into a
// single-frame avatar image. No DB, no network — callers pass in the sheet
// bytes and the descriptor; this module only does the pixel work via sharp.
//
// Contract: docs/specs/companion-avatar-url-store-on-create.md §2.2
//   spritesheet → crop frame 0 (top-left cell) → encode WebP ≤ 512×512.

const sharp = require('sharp');

// Output avatar dimensions (square, ≤512 per the spec). 256 keeps avatars
// crisp on retina without bloating R2.
const OUTPUT_SIZE = 256;
// Fallback frame size when the descriptor omits frame dimensions.
const DEFAULT_FRAME = 256;

// A descriptor may arrive either as the raw descriptor (`{ asset: {...} }`) or
// wrapped one level deeper (`{ descriptor: { asset: {...} } }`) depending on the
// call site — mirror the unwrap pattern used elsewhere for petdx descriptors.
function unwrapAsset(descriptor) {
    if (!descriptor || typeof descriptor !== 'object') return {};
    if (descriptor.descriptor && descriptor.descriptor.asset) return descriptor.descriptor.asset;
    if (descriptor.asset && typeof descriptor.asset === 'object') return descriptor.asset;
    return {};
}

function positiveIntOr(value, fallback) {
    const n = Math.floor(Number(value));
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Crop frame 0 (top-left cell of the grid) out of a sprite sheet and return a
// square WebP avatar. Returns { buffer, mime, width, height }.
async function extractFrameZero(spritesheetBuffer, descriptor = {}) {
    if (!Buffer.isBuffer(spritesheetBuffer)) {
        throw new TypeError('extractFrameZero: spritesheetBuffer must be a Buffer');
    }
    const asset = unwrapAsset(descriptor);
    const frameWidth = positiveIntOr(asset.frameWidth, DEFAULT_FRAME);
    const frameHeight = positiveIntOr(asset.frameHeight, DEFAULT_FRAME);

    // Clamp the extract window to the actual image so a mis-stated frame size
    // (or a single-frame image) can never throw sharp's "extract_area" error.
    const meta = await sharp(spritesheetBuffer).metadata();
    const width = Math.min(frameWidth, meta.width || frameWidth);
    const height = Math.min(frameHeight, meta.height || frameHeight);

    const buffer = await sharp(spritesheetBuffer)
        .extract({ left: 0, top: 0, width, height })
        .resize(OUTPUT_SIZE, OUTPUT_SIZE, { fit: 'cover' })
        .webp({ quality: 90 })
        .toBuffer();

    return { buffer, mime: 'image/webp', width: OUTPUT_SIZE, height: OUTPUT_SIZE };
}

module.exports = { extractFrameZero, unwrapAsset, OUTPUT_SIZE, DEFAULT_FRAME };
