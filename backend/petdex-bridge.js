/**
 * Petdex Bridge — mirrors crafter-station/petdex public gallery into our
 * companions table as `scope='community'` rows with `asset_type='spritesheet'`.
 *
 * Why: 自有目錄只有 5 隻 (3 物種)；對接 Petdex 1779 隻可一次補滿瀏覽量。Petdex
 * 是 MIT-licensed 公開 gallery (https://github.com/crafter-station/petdex).
 *
 * Phase 2 (PR #3176 spec) — sprite binaries are self-hosted in EClaw R2 at
 * `petdx-sprites/{slug}/sprite.webp`, served from a public proxy at
 * `/api/petdx/:slug/sprite.webp`. The upstream raillyhugo Worker is no
 * longer a runtime dependency — bridge fetches at sync time, caches the
 * bytes on our R2, and writes the EClaw-owned URL into the descriptor.
 *
 * Sprite convention (from crafter-station/petdex packages/petdex-desktop/src/main.zig):
 *   - Sheet 1536×1872, COLS=8 ROWS=9, every frame 192×208.
 *   - Row 0 idle (variable), row 1 running-right (8f), row 2 running-left (8f),
 *     row 3 waving (4f), row 4 jumping (5f), row 5 failed (8f),
 *     row 6 waiting (6f), row 7 running (6f), row 8 review (6f).
 *
 * Our state mapping (EClaw companion state → Petdex animation row):
 *   IDLE → 0(idle), BUSY → 7(running), WALKING → 1(running-right),
 *   SLEEPING → 6(waiting), EXCITED → 4(jumping), HAPPY → 3(waving).
 */

const MANIFEST_URL = 'https://petdex.crafter.run/api/manifest';
const R2_KEY_PREFIX = 'petdx-sprites';
const PROXY_PATH_PREFIX = '/api/petdx';

// Animation table — rows + per-frame durations in milliseconds. The idle row
// uses variable durations per frame (matches petdex desktop); all other rows
// use a single `dur` plus an optional `last` for the trailing frame.
const PETDEX_ANIMATIONS = {
    idle:           { row: 0, frames: [280, 110, 110, 140, 140, 320] },
    'running-right':{ row: 1, count: 8, dur: 120, last: 220 },
    'running-left': { row: 2, count: 8, dur: 120, last: 220 },
    waving:         { row: 3, count: 4, dur: 140, last: 280 },
    jumping:        { row: 4, count: 5, dur: 140, last: 280 },
    failed:         { row: 5, count: 8, dur: 140, last: 240 },
    waiting:        { row: 6, count: 6, dur: 150, last: 260 },
    running:        { row: 7, count: 6, dur: 120, last: 220 },
    review:         { row: 8, count: 6, dur: 150, last: 280 },
};

const STATE_TO_ANIMATION = {
    IDLE:     'idle',
    BUSY:     'running',
    WALKING:  'running-right',
    SLEEPING: 'waiting',
    EXCITED:  'jumping',
    HAPPY:    'waving',
};

const KIND_TO_CATEGORY = {
    creature:  'animal',
    character: 'human',
    object:    'mascot',
};

const SHEET_COLS = 8;
const SHEET_ROWS = 9;
const FRAME_WIDTH = 192;
const FRAME_HEIGHT = 208;

async function fetchPetdexManifest() {
    const res = await fetch(MANIFEST_URL, {
        headers: { 'Accept': 'application/json', 'User-Agent': 'EClaw-petdex-bridge/1.0' },
    });
    if (!res.ok) {
        throw new Error(`Petdex manifest fetch failed: HTTP ${res.status}`);
    }
    const data = await res.json();
    if (!data || !Array.isArray(data.pets)) {
        throw new Error('Petdex manifest shape invalid (expected .pets array)');
    }
    return data.pets;
}

function buildDescriptor(pet) {
    const animations = {};
    for (const [name, anim] of Object.entries(PETDEX_ANIMATIONS)) {
        animations[name] = { row: anim.row };
        if (Array.isArray(anim.frames)) {
            animations[name].frames = anim.frames;
        } else {
            animations[name].count = anim.count;
            animations[name].dur = anim.dur;
            if (anim.last != null) animations[name].last = anim.last;
        }
    }

    const stateAssets = {};
    for (const [state, animName] of Object.entries(STATE_TO_ANIMATION)) {
        stateAssets[state] = { animation: animName, loop: true };
    }

    return {
        id: `petdex-${pet.slug}`,
        name: pet.displayName,
        kind: pet.kind || 'object',
        assetType: 'spritesheet',
        asset: {
            url: pet.spritesheetUrl,
            cols: SHEET_COLS,
            rows: SHEET_ROWS,
            frameWidth: FRAME_WIDTH,
            frameHeight: FRAME_HEIGHT,
            animations,
        },
        supportedStates: Object.keys(STATE_TO_ANIMATION),
        stateAssets,
        sourceAttribution: {
            project: 'crafter-station/petdex',
            license: 'MIT',
            slug: pet.slug,
            submittedBy: pet.submittedBy || null,
            petJsonUrl: pet.petJsonUrl || null,
            zipUrl: pet.zipUrl || null,
        },
    };
}

// Phase 2 (#3176 spec §3.3): fetch sprite bytes from upstream + cache in EClaw R2.
// Returns { ok, cached, status, bytes } so the caller can distinguish a true
// upstream not-found from an R2 auth/config failure (per #1 sign-off guardrail).
async function fetchAndUploadSprite({ r2, bucket, slug, upstreamUrl, log }) {
    const key = `${R2_KEY_PREFIX}/${slug}/sprite.webp`;
    if (!r2 || !bucket) {
        return { ok: false, reason: 'r2_unconfigured', key };
    }

    // Idempotency: HEAD R2 first. Distinguish true 404 (NotFound / NoSuchKey)
    // from auth/config failure so we never silently mistake bad creds for a
    // cache miss + write garbage.
    try {
        const { HeadObjectCommand } = require('@aws-sdk/client-s3');
        await r2.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return { ok: true, cached: true, key };
    } catch (err) {
        const code = err && (err.name || err.Code);
        const status = err && err.$metadata && err.$metadata.httpStatusCode;
        const isNotFound = code === 'NotFound' || code === 'NoSuchKey' || status === 404;
        if (!isNotFound) {
            log('error', 'petdex-bridge', `[Petdex] R2 HEAD ${key} failed (not 404): ${code || status || err.message}`);
            return { ok: false, reason: 'r2_head_failed', key };
        }
    }

    let upstream;
    try {
        // Petdex's raillyhugo Worker enforces a Referer allowlist matching the
        // origin scheme + host + trailing slash. The CLI sends exactly this
        // header (see crafter-station/petdex packages/petdex-cli function wF).
        // Without the trailing slash the Worker returns 403; with it, 200.
        // We mirror the CLI so the bridge sees the same surface as a user
        // running `npx petdex install <slug>`.
        upstream = await fetch(upstreamUrl, {
            headers: {
                'User-Agent': 'EClaw-petdex-bridge/2.0',
                'Referer': 'https://petdex.crafter.run/',
            },
        });
    } catch (err) {
        return { ok: false, reason: 'upstream_fetch_error', key, error: err.message };
    }
    if (!upstream.ok) {
        return { ok: false, reason: 'upstream_not_ok', key, status: upstream.status };
    }
    const buf = Buffer.from(await upstream.arrayBuffer());

    try {
        const { PutObjectCommand } = require('@aws-sdk/client-s3');
        await r2.send(new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: buf,
            ContentType: 'image/webp',
            CacheControl: 'public, max-age=31536000, immutable',
        }));
    } catch (err) {
        log('error', 'petdex-bridge', `[Petdex] R2 PUT ${key} failed: ${err.message}`);
        return { ok: false, reason: 'r2_put_failed', key };
    }
    return { ok: true, cached: false, key, bytes: buf.length };
}

function spriteProxyUrl(apiBase, slug) {
    return `${apiBase}${PROXY_PATH_PREFIX}/${slug}/sprite.webp`;
}

async function upsertPetdexCompanion(pool, pet, { r2, bucket, apiBase, log }) {
    const id = `petdex-${pet.slug}`;
    const category = KIND_TO_CATEGORY[pet.kind] || 'mascot';
    const supportedStates = Object.keys(STATE_TO_ANIMATION);
    const tags = ['petdex', pet.kind || 'creature'];
    const now = Date.now();

    // Phase 2: try to self-host the sprite. On success, the descriptor + DB
    // columns point at the EClaw-owned proxy URL. On any failure, fall back
    // to the upstream URL so the Phase 1 renderer emoji fallback still fires.
    const upload = await fetchAndUploadSprite({
        r2, bucket, slug: pet.slug, upstreamUrl: pet.spritesheetUrl, log,
    });
    const url = upload.ok ? spriteProxyUrl(apiBase, pet.slug) : pet.spritesheetUrl;
    const needsRecovery = !upload.ok;
    const descriptor = buildDescriptor({ ...pet, spritesheetUrl: url });

    await pool.query(
        `INSERT INTO companions (
            id, name, version, author_entity_id, device_id,
            descriptor, asset_type, asset_url, avatar_url, thumbnail_url,
            supported_states, scope, status, license, category,
            mood, color, tags, needs_recovery,
            created_at, updated_at, published_at
        ) VALUES (
            $1, $2, '1.0.0', NULL, NULL,
            $3::jsonb, 'spritesheet', $4, $5, $5,
            $6::jsonb, 'community', 'published', 'MIT', $7,
            NULL, NULL, $8::jsonb, $10,
            $9, $9, $9
        )
        ON CONFLICT (id) DO UPDATE SET
            name = EXCLUDED.name,
            descriptor = EXCLUDED.descriptor,
            asset_url = EXCLUDED.asset_url,
            avatar_url = EXCLUDED.avatar_url,
            thumbnail_url = EXCLUDED.thumbnail_url,
            supported_states = EXCLUDED.supported_states,
            category = EXCLUDED.category,
            tags = EXCLUDED.tags,
            needs_recovery = EXCLUDED.needs_recovery,
            updated_at = EXCLUDED.updated_at
        `,
        [
            id,
            pet.displayName || pet.slug,
            JSON.stringify(descriptor),
            url,
            url,
            JSON.stringify(supportedStates),
            category,
            JSON.stringify(tags),
            now,
            needsRecovery,
        ],
    );
    return upload;
}

// Lazy default-construct an R2 client from env if the caller didn't pass one.
// Keeps backward-compat with the original (pool, logger) signature and lets
// existing prod callers in companion-api.js work without any change.
function defaultR2Client() {
    try {
        const { S3Client } = require('@aws-sdk/client-s3');
        return new S3Client({
            region: 'auto',
            endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
            credentials: {
                accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
                secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
            },
        });
    } catch (_) {
        return null;
    }
}

async function syncPetdexCatalog(pool, options = {}) {
    // Old positional shape: syncPetdexCatalog(pool, logger). New shape:
    // syncPetdexCatalog(pool, { r2, bucket, apiBase, serverLog }).
    if (typeof options === 'function') options = { serverLog: options };
    const log = typeof options.serverLog === 'function' ? options.serverLog : console.log;
    const r2 = options.r2 || defaultR2Client();
    const bucket = options.bucket || process.env.R2_BUCKET_NAME || 'eclaw-files';
    const apiBase = options.apiBase
        || process.env.PUBLIC_BASE_URL
        || process.env.BASE_URL
        || process.env.API_BASE
        || 'https://eclawbot.com';

    let inserted = 0;
    let failed = 0;
    let needsRecovery = 0;
    let cached = 0;
    let total = 0;
    try {
        const pets = await fetchPetdexManifest();
        total = pets.length;
        log('info', 'petdex-bridge', `[Petdex] fetched ${total} pets from manifest`);
        for (const pet of pets) {
            if (!pet || !pet.slug || !pet.spritesheetUrl) {
                failed++;
                continue;
            }
            try {
                const result = await upsertPetdexCompanion(pool, pet, { r2, bucket, apiBase, log });
                inserted++;
                if (result.cached) cached++;
                if (!result.ok) needsRecovery++;
            } catch (err) {
                failed++;
                if (failed <= 3) {
                    log('warn', 'petdex-bridge', `[Petdex] upsert ${pet.slug} failed: ${err.message}`);
                }
            }
        }
        log('info', 'petdex-bridge', `[Petdex] sync complete — ok=${inserted} cached=${cached} needs_recovery=${needsRecovery} failed=${failed} total=${total}`);
    } catch (err) {
        log('error', 'petdex-bridge', `[Petdex] sync failed: ${err.message}`);
    }
    return { total, inserted, failed, needsRecovery, cached };
}

module.exports = {
    syncPetdexCatalog,
    fetchPetdexManifest,
    fetchAndUploadSprite,
    upsertPetdexCompanion,
    spriteProxyUrl,
    buildDescriptor,
    PETDEX_ANIMATIONS,
    STATE_TO_ANIMATION,
    KIND_TO_CATEGORY,
    SHEET_COLS,
    SHEET_ROWS,
    FRAME_WIDTH,
    FRAME_HEIGHT,
    MANIFEST_URL,
    R2_KEY_PREFIX,
    PROXY_PATH_PREFIX,
};
