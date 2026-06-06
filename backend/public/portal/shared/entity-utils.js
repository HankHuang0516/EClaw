// Shared entity avatar/name/label resolution
// Replaces duplicated ENTITY_CHARS across all portal pages
// Fixes #77 and #76: entity IDs 4+ showed '?' emoji

// Character → default emoji. Mirrors backend _getCharacterDefaultAvatar.
const CHARACTER_EMOJI = {
    LOBSTER: '\u{1F99E}',
    PIG: '\u{1F437}'
};
const DEFAULT_CHARACTER_EMOJI = CHARACTER_EMOJI.LOBSTER;
const CHARACTER_DEFAULT_AVATARS = new Set(Object.values(CHARACTER_EMOJI));

// Retained as a last-resort visual fallback when neither live character nor
// any avatar source is known — never used to override a server-supplied character.
const ENTITY_CHARS_DEFAULT = {
    0: { name: 'Lobster', emoji: CHARACTER_EMOJI.LOBSTER },
    1: { name: 'Lobster', emoji: CHARACTER_EMOJI.LOBSTER },
    2: { name: 'Lobster', emoji: CHARACTER_EMOJI.LOBSTER },
    3: { name: 'Lobster', emoji: CHARACTER_EMOJI.LOBSTER }
};

// Shared state - populated by each page's entity load
let _entityAvatarMap = {};
let _entityNameMap = {};
let _entityCharacterMap = {};
let _entityPetdxAvatarMap = {};

/**
 * Port of backend _isCharacterDefaultAvatar (see backend/index.js +
 * backend/petdx-phase0-hook.js). Used to enforce the §0.4 invariant:
 * default emojis must NOT populate _entityAvatarMap so they can never
 * beat the petdx avatar.png URL.
 */
function _isCharacterDefaultAvatar(avatar) {
    if (avatar === null || avatar === undefined || avatar === '') return true;
    return CHARACTER_DEFAULT_AVATARS.has(avatar);
}

/**
 * Call after fetching entities from API to populate shared maps.
 * Per Phase 0 amendment §0.4 invariant: _entityAvatarMap only stores
 * explicit non-default avatars (URL or user-set non-default emoji).
 * Default-emoji avatars are intentionally dropped from the map so they
 * cannot win over the petdx avatar.png URL further down the chain.
 *
 * @param {Array} entities - array of entity objects from /api/entities
 */
function updateEntityMaps(entities) {
    _entityAvatarMap = {};
    _entityNameMap = {};
    _entityCharacterMap = {};
    _entityPetdxAvatarMap = {};
    (entities || []).forEach(e => {
        if (e.avatar && !_isCharacterDefaultAvatar(e.avatar)) {
            _entityAvatarMap[e.entityId] = e.avatar;
        }
        if (e.name) _entityNameMap[e.entityId] = e.name;
        if (e.character) _entityCharacterMap[e.entityId] = e.character;
        if (e.petdxAvatarUrl) _entityPetdxAvatarMap[e.entityId] = e.petdxAvatarUrl;
    });
}

function _characterEmoji(entityId) {
    const c = _entityCharacterMap[entityId];
    return c ? (CHARACTER_EMOJI[c] || DEFAULT_CHARACTER_EMOJI) : null;
}

function _petdxAvatarUrl(entityId) {
    return _entityPetdxAvatarMap[entityId] || null;
}

function _petdxDescriptorAvatarUrl(entityId) {
    if (typeof window === 'undefined' || !window.AvatarPetdx) return null;
    const ap = window.AvatarPetdx;
    if (typeof ap.descriptorAvatarUrl === 'function') return ap.descriptorAvatarUrl(entityId) || null;
    return null;
}

/**
 * Get the avatar for an entity, per the §0.4 priority chain.
 *
 * Originally Phase 0 placed the /api/entities enrichment URL ahead of the
 * live descriptor URL on the assumption that the enrichment ALWAYS reflects
 * the current companion selection — but `/api/companion/select` updates the
 * companion-current table without writing back to PETDX_AVATAR_<id>, so the
 * vault enrichment quickly goes stale once a user borrows or switches
 * companions through the marketplace. The dashboard then keeps painting the
 * Phase-0 default lobster even when the entity is wearing a rented sprite
 * companion (see card_44017ea5 follow-up + Hank's morning report).
 *
 * Live descriptor URL is now ahead of vault enrichment. The vault entry stays
 * in the chain as a fast-paint fallback for the brief window before
 * AvatarPetdx.preload() resolves.
 *
 *   1. _entityAvatarMap (explicit non-default avatar — URL or user-set emoji)
 *   2. localStorage user override
 *   3. AvatarPetdx.descriptorAvatarUrl(entityId) — live cached companion URL
 *   4. _entityPetdxAvatarMap (PETDX_AVATAR_<id> from /api/entities enrichment) — fast-paint fallback
 *   5. live character → emoji (PR #3027 stopgap, kept until §0.6 quarantine ends)
 *   6. legacy ENTITY_CHARS_DEFAULT
 *   7. final emoji fallback
 */
function getAvatarForEntity(entityId) {
    if (_entityAvatarMap[entityId]) return _entityAvatarMap[entityId];
    const saved = localStorage.getItem('eclaw_avatar_' + entityId);
    if (saved) return saved;
    const fromDescriptor = _petdxDescriptorAvatarUrl(entityId);
    if (fromDescriptor) return fromDescriptor;
    const fromEnrichment = _petdxAvatarUrl(entityId);
    if (fromEnrichment) return fromEnrichment;
    const fromCharacter = _characterEmoji(entityId);
    if (fromCharacter) return fromCharacter;
    const char = ENTITY_CHARS_DEFAULT[entityId];
    if (char) return char.emoji;
    return ENTITY_CHARS_DEFAULT[entityId % 4]?.emoji || DEFAULT_CHARACTER_EMOJI;
}

/**
 * Get the display name for an entity.
 * Priority: server name > live character > legacy default > parity fallback
 */
function getEntityDisplayName(entityId) {
    if (_entityNameMap[entityId]) return _entityNameMap[entityId];
    const c = _entityCharacterMap[entityId];
    if (c) {
        return c.charAt(0) + c.slice(1).toLowerCase();
    }
    const char = ENTITY_CHARS_DEFAULT[entityId];
    if (char) return char.name;
    return 'Lobster';
}

/**
 * Check if an avatar value is an image URL (not an emoji).
 */
function isAvatarUrl(avatar) {
    return avatar && typeof avatar === 'string' && /^(https?:\/\/|\/)/.test(avatar);
}

/**
 * Render an avatar as HTML. Returns an <img> tag for URLs, or emoji text for emoji avatars.
 *
 * If `entityId` is provided AND `window.AvatarPetdx` has a cached
 * companion descriptor for that entity AND that descriptor has a
 * renderable spritesheet asset, emits a placeholder canvas so
 * AvatarPetdx.mount() can animate it. Pages should call
 * AvatarPetdx.preload(...) once on init, then AvatarPetdx.mount(root)
 * after each batch of markup that contains these placeholders.
 *
 * Procedural-only descriptors (e.g. the Phase 0 petdx-lobster-default,
 * which carries `asset.renderer: 'lobster-procedural'` but no
 * spritesheet) intentionally fall through to the URL/emoji path, since
 * PetdxRenderer can't draw them yet (Phase 0.1 follow-up). Without
 * this guard the canvas placeholder is emitted and stays blank, which
 * the user sees as a ❓ on the dashboard chip — exactly the bug
 * card_44017ea5 captured the morning after PR #3032 backfilled
 * default petdx companions for every entity.
 *
 * @param {string} avatar - emoji string or image URL
 * @param {number} [size=48] - size in px (for image avatars)
 * @param {number} [entityId] - optional entityId to consider for petdx render
 */
function _petdxCanRenderCanvas(entityId) {
    if (typeof window === 'undefined' || !window.AvatarPetdx) return false;
    if (!window.AvatarPetdx.hasDescriptor(entityId)) return false;
    if (typeof window.AvatarPetdx.getDescriptor !== 'function') return false;
    const d = window.AvatarPetdx.getDescriptor(entityId);
    if (!d) return false;
    // Spritesheet renderer is the only path PetdxRenderer.createRenderer
    // currently knows how to draw end-to-end. Procedural descriptors are
    // recorded in the descriptor cache for future Phase 0.1 use but must
    // not win the canvas branch today (the lobster-procedural drawer
    // exists, but the mount → createRenderer wiring still needs work —
    // tracked separately).
    //
    // Defense in depth (per #6 review on PR #3044): also require a sheet
    // URL on the descriptor. A "tagged spritesheet but no URL" descriptor
    // — possible during transient API failures — would otherwise emit a
    // canvas that PetdxRenderer can't draw, reproducing the same ❓ bug.
    const inner = d.descriptor || d;
    const node = inner && inner.assetType === 'spritesheet' ? inner
        : d.assetType === 'spritesheet' ? d
        : null;
    if (!node) return false;
    const sheetUrl = (node.asset && node.asset.url) || node.assetUrl;
    return typeof sheetUrl === 'string' && sheetUrl.length > 0;
}
function renderAvatarHtml(avatar, size, entityId) {
    size = size || 48;
    const eidAttr = entityId != null ? ' data-entity-id="' + Number(entityId) + '"' : '';
    if (entityId != null && _petdxCanRenderCanvas(entityId)) {
        // imageRendering keeps the spritesheet pixel-art crisp at small sizes;
        // matches PetdxRenderer's ctx.imageSmoothingEnabled = false.
        return '<canvas class="entity-avatar-canvas"' + eidAttr
            + ' data-petdx-entity-id="' + Number(entityId) + '"'
            + ' width="' + size + '" height="' + size + '"'
            + ' style="width:' + size + 'px;height:' + size + 'px;'
            + 'image-rendering:pixelated;border-radius:50%;vertical-align:middle;"'
            + ' aria-label="entity avatar"></canvas>';
    }
    if (isAvatarUrl(avatar)) {
        return '<img src="' + avatar + '" class="entity-avatar-img"' + eidAttr +
            ' style="width:' + size + 'px;height:' + size + 'px;" alt="avatar" loading="lazy">';
    }
    // Emoji fallback — wrap in a span so the click delegate can resolve entityId.
    if (entityId != null) {
        return '<span class="entity-avatar-emoji"' + eidAttr + '>' + (avatar || '\u{1F99E}') + '</span>';
    }
    return avatar || '\u{1F99E}';
}

/**
 * Get an avatar as plain text (emoji only, no HTML).
 * For URL avatars, returns the default emoji fallback.
 */
function getAvatarText(entityId) {
    const avatar = getAvatarForEntity(entityId);
    if (isAvatarUrl(avatar)) {
        // URL avatar → use live-character emoji, then legacy default, then fallback
        const fromCharacter = _characterEmoji(entityId);
        if (fromCharacter) return fromCharacter;
        const char = ENTITY_CHARS_DEFAULT[entityId] || ENTITY_CHARS_DEFAULT[entityId % 4];
        return char?.emoji || DEFAULT_CHARACTER_EMOJI;
    }
    return avatar || DEFAULT_CHARACTER_EMOJI;
}

/**
 * Get a full label like "🦞 Lobster (#4)" for an entity — HTML version.
 * Contains <img> tags for URL avatars. Use in innerHTML contexts only.
 * Uses the page's local escapeHtml/esc function if available.
 */
function getEntityLabel(entityId) {
    const avatar = getAvatarForEntity(entityId);
    const name = getEntityDisplayName(entityId);
    // Use whichever escape function is available on the page
    const escapeFn = typeof escapeHtml === 'function' ? escapeHtml
        : typeof esc === 'function' ? esc
        : (s) => s;
    return `${renderAvatarHtml(avatar, 20, entityId)} ${escapeFn(name)} (#${entityId})`;
}

/**
 * Get a full label like "🦞 Lobster (#4)" as plain text (no HTML).
 * Safe for use in text fields, schedule messages, task descriptions, etc.
 */
function getEntityLabelText(entityId) {
    const emoji = getAvatarText(entityId);
    const name = getEntityDisplayName(entityId);
    return `${emoji} ${name} (#${entityId})`;
}

/**
 * Attach a delegated click handler to `container` that fires `onClick(entityId)`
 * whenever the user clicks any element with `data-entity-id` (covers canvas /
 * img / emoji-span avatars rendered by renderAvatarHtml).
 *
 * Skip dashboard surfaces — they own the avatar-change UX; per Hank 2026-06-06
 * 19:40 TW directive, every OTHER surface opens the entity status drawer.
 *
 * Returns the listener so callers can detach if needed.
 */
function attachAvatarClickHandler(container, onClick) {
    if (!container || typeof onClick !== 'function') return null;
    const listener = (e) => {
        const el = e.target.closest('[data-entity-id]');
        if (!el || !container.contains(el)) return;
        const eid = parseInt(el.dataset.entityId, 10);
        if (!Number.isFinite(eid) || eid < 0) return;
        e.preventDefault();
        e.stopPropagation();
        onClick(eid, el);
    };
    container.addEventListener('click', listener);
    return listener;
}
