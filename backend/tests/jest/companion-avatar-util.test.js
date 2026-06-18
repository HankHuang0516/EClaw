/**
 * companion-avatar-util — extractFrameZero (Plaza Plan-3 Phase 3)
 *
 * Pure image util; uses real sharp (no mock-setup). Builds synthetic sprite
 * sheets so the crop math is verifiable: frame 0 is one colour, every other
 * frame is a different colour, so a correct frame-0 crop is uniformly the
 * frame-0 colour and a wrong/over-wide crop bleeds the neighbour colour in.
 */

const sharp = require('sharp');
const { extractFrameZero, unwrapAsset } = require('../../companion-avatar-util');

const RED = { r: 220, g: 30, b: 30 };
const BLUE = { r: 30, g: 30, b: 220 };

// Build a cols×rows sheet where frame 0 (top-left fw×fh) is RED and the rest BLUE.
async function buildSheet(fw, fh, cols, rows) {
    const W = fw * cols;
    const H = fh * rows;
    const base = sharp({ create: { width: W, height: H, channels: 3, background: BLUE } });
    const frame0 = await sharp({ create: { width: fw, height: fh, channels: 3, background: RED } })
        .png().toBuffer();
    return base.composite([{ input: frame0, left: 0, top: 0 }]).png().toBuffer();
}

// Mean RGB of a (decoded) image buffer.
async function meanRgb(buf) {
    const { data } = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    let r = 0, g = 0, b = 0;
    const px = data.length / 3;
    for (let i = 0; i < data.length; i += 3) { r += data[i]; g += data[i + 1]; b += data[i + 2]; }
    return { r: r / px, g: g / px, b: b / px };
}

describe('extractFrameZero', () => {
    it('crops frame 0 to a 256×256 WebP (8×8 grid, 64px frames)', async () => {
        const sheet = await buildSheet(64, 64, 8, 8); // 512×512
        const out = await extractFrameZero(sheet, { asset: { frameWidth: 64, frameHeight: 64 } });

        expect(out.mime).toBe('image/webp');
        expect(out.width).toBe(256);
        expect(out.height).toBe(256);

        const meta = await sharp(out.buffer).metadata();
        expect(meta.format).toBe('webp');
        expect(meta.width).toBe(256);
        expect(meta.height).toBe(256);

        // Must be the frame-0 colour (RED-dominant), with no BLUE neighbour bleed.
        const m = await meanRgb(out.buffer);
        expect(m.r).toBeGreaterThan(150);
        expect(m.b).toBeLessThan(90);
    });

    it('works with 256px frames too', async () => {
        const sheet = await buildSheet(256, 256, 8, 9); // canonical PETDX-ish grid
        const out = await extractFrameZero(sheet, { asset: { frameWidth: 256, frameHeight: 256 } });
        const m = await meanRgb(out.buffer);
        expect(m.r).toBeGreaterThan(150);
        expect(m.b).toBeLessThan(90);
    });

    it('unwraps a nested descriptor.descriptor.asset', async () => {
        const sheet = await buildSheet(64, 64, 8, 8);
        const out = await extractFrameZero(sheet, { descriptor: { asset: { frameWidth: 64, frameHeight: 64 } } });
        const m = await meanRgb(out.buffer);
        expect(m.r).toBeGreaterThan(150);
        expect(m.b).toBeLessThan(90);
    });

    it('falls back to the default frame size when descriptor omits dims', async () => {
        // Sheet whose frame 0 is exactly the 256 default; rest BLUE.
        const sheet = await buildSheet(256, 256, 2, 2); // 512×512
        const out = await extractFrameZero(sheet, {}); // no asset → DEFAULT_FRAME (256)
        const m = await meanRgb(out.buffer);
        expect(m.r).toBeGreaterThan(150);
        expect(m.b).toBeLessThan(90);
    });

    it('clamps the extract window to the image (mis-stated frame size never throws)', async () => {
        const sheet = await buildSheet(64, 64, 1, 1); // single 64×64 RED frame
        // Descriptor claims 999px frames — must clamp, not throw extract_area.
        const out = await extractFrameZero(sheet, { asset: { frameWidth: 999, frameHeight: 999 } });
        expect(out.width).toBe(256);
        const m = await meanRgb(out.buffer);
        expect(m.r).toBeGreaterThan(150);
    });

    it('throws a clear error on non-Buffer input', async () => {
        await expect(extractFrameZero('not-a-buffer', {})).rejects.toThrow(/Buffer/);
    });
});

describe('unwrapAsset', () => {
    it('returns top-level asset', () => {
        expect(unwrapAsset({ asset: { frameWidth: 64 } })).toEqual({ frameWidth: 64 });
    });
    it('returns nested descriptor.asset', () => {
        expect(unwrapAsset({ descriptor: { asset: { frameWidth: 32 } } })).toEqual({ frameWidth: 32 });
    });
    it('returns {} for junk input', () => {
        expect(unwrapAsset(null)).toEqual({});
        expect(unwrapAsset(42)).toEqual({});
        expect(unwrapAsset({})).toEqual({});
    });
});
