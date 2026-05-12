/**
 * Petdex Bridge — mirrors crafter-station/petdex public gallery into our
 * companions table as `scope='community'` rows with `asset_type='spritesheet'`.
 *
 * Why: 自有目錄只有 5 隻 (3 物種)；對接 Petdex 1779 隻可一次補滿瀏覽量。Petdex
 * 是 MIT-licensed 公開 gallery (https://github.com/crafter-station/petdex)，
 * 圖檔 hot-link 自其 R2 bucket，本表只存 URL + descriptor，不複製二進位資產。
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

async function upsertPetdexCompanion(pool, pet) {
    const id = `petdex-${pet.slug}`;
    const descriptor = buildDescriptor(pet);
    const category = KIND_TO_CATEGORY[pet.kind] || 'mascot';
    const supportedStates = Object.keys(STATE_TO_ANIMATION);
    const tags = ['petdex', pet.kind || 'creature'];
    const now = Date.now();

    await pool.query(
        `INSERT INTO companions (
            id, name, version, author_entity_id, device_id,
            descriptor, asset_type, asset_url, avatar_url, thumbnail_url,
            supported_states, scope, status, license, category,
            mood, color, tags,
            created_at, updated_at, published_at
        ) VALUES (
            $1, $2, '1.0.0', NULL, NULL,
            $3::jsonb, 'spritesheet', $4, $5, $5,
            $6::jsonb, 'community', 'published', 'MIT', $7,
            NULL, NULL, $8::jsonb,
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
            updated_at = EXCLUDED.updated_at
        `,
        [
            id,
            pet.displayName || pet.slug,
            JSON.stringify(descriptor),
            pet.spritesheetUrl,
            pet.spritesheetUrl,
            JSON.stringify(supportedStates),
            category,
            JSON.stringify(tags),
            now,
        ],
    );
}

async function syncPetdexCatalog(pool, serverLog = console.log) {
    const log = typeof serverLog === 'function' ? serverLog : () => {};
    let inserted = 0;
    let failed = 0;
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
                await upsertPetdexCompanion(pool, pet);
                inserted++;
            } catch (err) {
                failed++;
                if (failed <= 3) {
                    log('warn', 'petdex-bridge', `[Petdex] upsert ${pet.slug} failed: ${err.message}`);
                }
            }
        }
        log('info', 'petdex-bridge', `[Petdex] sync complete — ok=${inserted} failed=${failed} total=${total}`);
    } catch (err) {
        log('error', 'petdex-bridge', `[Petdex] sync failed: ${err.message}`);
    }
    return { total, inserted, failed };
}

module.exports = {
    syncPetdexCatalog,
    fetchPetdexManifest,
    buildDescriptor,
    PETDEX_ANIMATIONS,
    STATE_TO_ANIMATION,
    KIND_TO_CATEGORY,
    SHEET_COLS,
    SHEET_ROWS,
    FRAME_WIDTH,
    FRAME_HEIGHT,
    MANIFEST_URL,
};
