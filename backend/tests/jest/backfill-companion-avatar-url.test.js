/**
 * backfill-companion-avatar-url — Plaza Plan-3 Phase 5
 *
 * Unit test with injected fake pg pool + fake R2 (no network/DB). A real
 * sharp-built sprite sheet feeds the real extractFrameZero, so the derive path
 * is exercised end-to-end in-memory.
 */

const sharp = require('sharp');
const {
    runBackfill, slugFromUrl, SELECT_SQL,
} = require('../../scripts/backfill-companion-avatar-url');

// Fake @aws-sdk command classes (tagged so the fake client can route).
class GetObjectCommand { constructor(input) { this.input = input; this.__t = 'get'; } }
class PutObjectCommand { constructor(input) { this.input = input; this.__t = 'put'; } }

async function makeSprite() {
    // 8×9 grid, 64px frames; frame 0 RED on BLUE rest (matches petdx layout shape).
    const fw = 64, fh = 64, cols = 8, rows = 9;
    const base = sharp({ create: { width: fw * cols, height: fh * rows, channels: 3, background: { r: 220, g: 30, b: 30 } } });
    // whole sheet red so any crop is red — we only assert the avatar is a valid webp here
    return base.webp().toBuffer();
}

function makeFakePool(rows) {
    const updates = [];
    return {
        updates,
        async query(sql, params) {
            if (/^SELECT/i.test(sql)) return { rows };
            if (/^UPDATE/i.test(sql)) { updates.push({ sql, params }); return { rowCount: 1 }; }
            return { rows: [] };
        },
    };
}

function makeFakeR2(spriteBuf) {
    const puts = [];
    return {
        puts,
        async send(cmd) {
            if (cmd.__t === 'get') {
                return { Body: { transformToByteArray: async () => spriteBuf } };
            }
            if (cmd.__t === 'put') { puts.push(cmd.input); return {}; }
            throw new Error('unknown command');
        },
    };
}

const DESC = { asset: { frameWidth: 64, frameHeight: 64, cols: 8, rows: 9 } };

describe('slugFromUrl', () => {
    it('extracts slug from a petdx sprite proxy URL', () => {
        expect(slugFromUrl('/api/petdx/zoro/sprite.webp')).toBe('zoro');
        expect(slugFromUrl('https://eclawbot.com/api/petdx/tomori-2/sprite.webp')).toBe('tomori-2');
    });
    it('returns null for non-matching / junk', () => {
        expect(slugFromUrl('/api/petdx/zoro/avatar.webp')).toBeNull();
        expect(slugFromUrl('whatever')).toBeNull();
        expect(slugFromUrl(null)).toBeNull();
    });
});

describe('SELECT_SQL is idempotent by construction', () => {
    it('only targets spritesheet rows whose avatar_url still references a sprite sheet', () => {
        expect(SELECT_SQL).toMatch(/asset_type\s*=\s*'spritesheet'/);
        expect(SELECT_SQL).toMatch(/avatar_url LIKE '%sprite\.webp%'/);
    });
});

describe('runBackfill', () => {
    const baseDeps = () => ({ GetObjectCommand, PutObjectCommand, bucket: 'test-bucket', logger: () => {} });

    it('dry-run plans without any R2 put or DB update', async () => {
        const pool = makeFakePool([
            { id: 'petdx-zoro', descriptor: DESC, asset_url: '/api/petdx/zoro/sprite.webp', avatar_url: '/api/petdx/zoro/sprite.webp' },
        ]);
        const r2 = makeFakeR2(await makeSprite());
        const s = await runBackfill({ ...baseDeps(), pool, r2, dryRun: true });
        expect(s.scanned).toBe(1);
        expect(s.migrated).toBe(1); // "would migrate"
        expect(r2.puts).toHaveLength(0);
        expect(pool.updates).toHaveLength(0);
        expect(s.rows[0]).toMatchObject({ action: 'would-migrate', slug: 'zoro', newAvatarUrl: '/api/petdx/zoro/avatar.webp' });
    });

    it('commit derives frame 0, uploads avatar.webp, and repoints avatar_url', async () => {
        const pool = makeFakePool([
            { id: 'petdx-zoro', descriptor: DESC, asset_url: '/api/petdx/zoro/sprite.webp', avatar_url: '/api/petdx/zoro/sprite.webp' },
        ]);
        const r2 = makeFakeR2(await makeSprite());
        const s = await runBackfill({ ...baseDeps(), pool, r2, dryRun: false });

        expect(s.migrated).toBe(1);
        expect(s.failed).toBe(0);
        // uploaded to the avatar key with webp content-type + immutable cache
        expect(r2.puts).toHaveLength(1);
        expect(r2.puts[0].Key).toBe('petdx-sprites/zoro/avatar.webp');
        expect(r2.puts[0].ContentType).toBe('image/webp');
        expect(r2.puts[0].CacheControl).toMatch(/immutable/);
        expect(Buffer.isBuffer(r2.puts[0].Body)).toBe(true);
        // and it's a real webp (sharp can read it back as 256×256)
        const meta = await sharp(r2.puts[0].Body).metadata();
        expect(meta.format).toBe('webp');
        expect(meta.width).toBe(256);
        // avatar_url repointed
        expect(pool.updates).toHaveLength(1);
        expect(pool.updates[0].params).toEqual(['/api/petdx/zoro/avatar.webp', 'petdx-zoro']);
    });

    it('skips a row whose URL has no derivable slug (no write, counted skipped)', async () => {
        const pool = makeFakePool([
            { id: 'weird', descriptor: DESC, asset_url: 'sprite.webp', avatar_url: 'sprite.webp' },
        ]);
        const r2 = makeFakeR2(await makeSprite());
        const s = await runBackfill({ ...baseDeps(), pool, r2, dryRun: false });
        expect(s.skipped).toBe(1);
        expect(s.migrated).toBe(0);
        expect(r2.puts).toHaveLength(0);
        expect(pool.updates).toHaveLength(0);
    });

    it('records a failure (and continues) when R2 get throws, without updating the row', async () => {
        const pool = makeFakePool([
            { id: 'petdx-zoro', descriptor: DESC, asset_url: '/api/petdx/zoro/sprite.webp', avatar_url: '/api/petdx/zoro/sprite.webp' },
        ]);
        const r2 = { puts: [], async send() { throw new Error('NoSuchKey'); } };
        const s = await runBackfill({ ...baseDeps(), pool, r2, dryRun: false });
        expect(s.failed).toBe(1);
        expect(s.migrated).toBe(0);
        expect(pool.updates).toHaveLength(0);
    });
});
