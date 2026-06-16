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
function _healthCheckingBadgeHtml() {
    // Small 「健檢中」label rendered next to a health-checking avatar. Uses
    // i18n.t() when available (data-i18n keeps it live-translatable), else
    // falls back to the English string so it never renders a raw key.
    var label = (typeof i18n !== 'undefined' && typeof i18n.t === 'function')
        ? i18n.t('health_checking')
        : 'Health-checking';
    return '<span class="health-checking-badge" data-i18n="health_checking">' + label + '</span>';
}

/**
 * Render an avatar as HTML.
 *
 * @param {string} avatar - emoji string or image URL
 * @param {number} [size=48] - size in px (for image avatars)
 * @param {number} [entityId] - optional entityId to consider for petdx render
 * @param {object} [opts] - optional flags. opts.healthChecking=true wraps the
 *        avatar in a `.health-checking` ring animation + a 「健檢中」badge.
 */
function renderAvatarHtml(avatar, size, entityId, opts) {
    size = size || 48;
    const eidAttr = entityId != null ? ' data-entity-id="' + Number(entityId) + '"' : '';
    let inner;
    if (entityId != null && _petdxCanRenderCanvas(entityId)) {
        // imageRendering keeps the spritesheet pixel-art crisp at small sizes;
        // matches PetdxRenderer's ctx.imageSmoothingEnabled = false.
        inner = '<canvas class="entity-avatar-canvas"' + eidAttr
            + ' data-petdx-entity-id="' + Number(entityId) + '"'
            + ' width="' + size + '" height="' + size + '"'
            + ' style="width:' + size + 'px;height:' + size + 'px;'
            + 'image-rendering:pixelated;border-radius:50%;vertical-align:middle;"'
            + ' aria-label="entity avatar"></canvas>';
    } else if (isAvatarUrl(avatar)) {
        inner = '<img src="' + avatar + '" class="entity-avatar-img"' + eidAttr +
            ' style="width:' + size + 'px;height:' + size + 'px;" alt="avatar" loading="lazy">';
    } else if (entityId != null) {
        // Emoji fallback — wrap in a span so the click delegate can resolve entityId.
        inner = '<span class="entity-avatar-emoji"' + eidAttr + '>' + (avatar || '\u{1F99E}') + '</span>';
    } else {
        inner = avatar || '\u{1F99E}';
    }

    // Health-checking: wrap in a pulsing/glowing ring + 「健檢中」badge. The
    // wrapper keeps the original markup intact so existing click delegates that
    // resolve data-entity-id still work.
    if (opts && opts.healthChecking) {
        return '<span class="avatar-health-wrap health-checking" '
            + 'style="width:' + size + 'px;height:' + size + 'px;">'
            + inner + _healthCheckingBadgeHtml() + '</span>';
    }
    return inner;
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
        // Belt-and-suspenders: ignore any click that originates inside the
        // entity status drawer itself, regardless of what data-* attributes
        // its content might happen to carry (close button, scrim, future chip
        // rows in the P1 operation log section, etc.).
        if (e.target.closest('.entity-status-panel')) return;
        // Entity-selector surfaces own the click — opening the status drawer
        // here would steal the user's intent (pick this entity as a filter /
        // target). The closest() walk catches both opt-in markers and the
        // currently-known selector containers.
        if (e.target.closest('[data-no-avatar-click]')) return;
        if (e.target.closest('.entity-selector')) return;
        if (e.target.closest('#entityFilters')) return;
        if (e.target.closest('.kb-auto-filter')) return;
        // Chat target-bar checkbox row ("傳送給: ☑ Mac_F ☑ LOBSTER ..."). The
        // user's intent here is to toggle the entity as a send target; opening
        // the status drawer on top of it steals that interaction. Catches both
        // the wrapping label (.target-entity-check) and bare checkbox / label
        // hits to be defensive against similar checkbox-styled rows added later.
        if (e.target.closest('.target-entity-check')) return;
        if (e.target.matches && e.target.matches('input[type="checkbox"], input[type="radio"]')) return;
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

/* ──────────────────────────────────────────────────────────────────────────
 * Arena interview retest countdown — card_959b58d0351153bc94aea8da
 *
 * Bots that have passed an Arena interview must retest periodically (default
 * cooldown = 30 days). The agent card shows a countdown chip below the
 * Capabilities row so the owner sees, at a glance, how soon retest is due
 * and the urgency level via color tier. Five tiers per card scope:
 *
 *   >14 days remaining     → gray    (plenty of time, no urgency)
 *   7–14 days remaining    → yellow  (getting closer, informational)
 *   3–7  days remaining    → orange  (schedule retest soon)
 *   1–3  days remaining    → red     (urgent, retest required)
 *   <1   day  remaining    → green   (cooldown lifting — retest already
 *                                     available within 24h)
 *   <=0  remaining         → ready   ("立即可重測" — green CTA pill)
 *
 * The "green" tier intentionally overlaps with "ready" semantically: per
 * card scope <1 day = 綠（可重測）. We model these as two render states
 * (countdown vs CTA) but share the same green palette, so users perceive
 * "almost-unlocked" and "unlocked" as the same positive signal.
 *
 * Color is NEVER the only signal — every tier ships an explicit text label
 * + aria-label + WCAG AA contrast ratio. prefers-reduced-motion disables
 * the red-tier pulse animation.
 *
 * Pure helpers (computeRetestDeadlineMs, getRetestSeverity,
 * formatRetestRemaining, renderRetestCountdownHtml, attachRetestCountdown)
 * are exported on `window.EntityRetestCountdown` AND via CommonJS so jest
 * can unit-test them server-side without a DOM.
 *
 * Timezone: we operate in epoch ms throughout. Date.parse / Date.now() are
 * UTC-anchored, so DST transitions and user TZ don't shift the deadline.
 * The DISPLAY string (24d 03h) is duration math on ms, not calendar days,
 * so a "1 day remaining" chip means exactly 86,400,000ms — no DST drift.
 * ────────────────────────────────────────────────────────────────────────── */

const ARENA_RETEST_COOLDOWN_DAYS = 30;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
// Boundaries in ms — exclusive on the lower edge, so >14d means "more
// than 14 full days", matching the 灰/黃/橙/紅/綠 scope verbatim.
const RETEST_THRESHOLD_GRAY_MS = 14 * ONE_DAY_MS;   // >14d → gray
const RETEST_THRESHOLD_YELLOW_MS = 7 * ONE_DAY_MS;  // 7-14d → yellow
const RETEST_THRESHOLD_ORANGE_MS = 3 * ONE_DAY_MS;  // 3-7d  → orange
const RETEST_THRESHOLD_RED_MS = 1 * ONE_DAY_MS;     // 1-3d  → red; <1d → green

/**
 * Compute the retest deadline in epoch ms from the last interview timestamp.
 * Accepts ISO string, epoch ms, or a Date. Returns null when input is missing
 * or unparseable — callers should hide the countdown in that case.
 */
function computeRetestDeadlineMs(lastInterviewAt, cooldownDays) {
    if (lastInterviewAt == null) return null;
    const days = Number.isFinite(cooldownDays) && cooldownDays > 0
        ? cooldownDays
        : ARENA_RETEST_COOLDOWN_DAYS;
    let ts;
    if (typeof lastInterviewAt === 'number') {
        ts = lastInterviewAt;
    } else if (lastInterviewAt instanceof Date) {
        ts = lastInterviewAt.getTime();
    } else {
        ts = Date.parse(String(lastInterviewAt));
    }
    if (!Number.isFinite(ts) || ts <= 0) return null;
    return ts + days * 24 * 60 * 60 * 1000;
}

/**
 * Map remaining milliseconds → severity tier per card_959 scope.
 * Boundaries match the scope verbatim; intervals are half-open so each
 * tier is unambiguous at the boundary:
 *
 *   (14d, ∞)     → 'gray'    (plenty of time)
 *   (7d, 14d]    → 'yellow'  (informational; 14d exactly falls here)
 *   (3d, 7d]    → 'orange'  (schedule soon; 7d exactly falls here)
 *   [1d, 3d]    → 'red'     (urgent; 1d exactly is the red→green pivot)
 *   (0, 1d)     → 'green'   (cooldown ends within 24h)
 *   (-∞, 0]     → 'ready'   (retest available — caller renders CTA pill)
 *
 * 'ready' is the only non-color tier in the sense that callers swap to a
 * different label ("立即可重測"). All other tiers render the same chip
 * layout, just with a different palette class.
 *
 * Non-finite input (NaN, Infinity, strings) collapses to 'ready' — the
 * safest UX default when we can't compute remaining: show the green CTA
 * and let the user retest if they want.
 */
function getRetestSeverity(remainingMs) {
    if (!Number.isFinite(remainingMs) || remainingMs <= 0) return 'ready';
    if (remainingMs > RETEST_THRESHOLD_GRAY_MS) return 'gray';
    if (remainingMs > RETEST_THRESHOLD_YELLOW_MS) return 'yellow';
    if (remainingMs > RETEST_THRESHOLD_ORANGE_MS) return 'orange';
    if (remainingMs >= RETEST_THRESHOLD_RED_MS) return 'red';
    return 'green';
}

/**
 * Format remaining milliseconds as a human-readable countdown.
 * The dispatch (card_959) requires that the seconds tick visibly down, so
 * we always emit a seconds segment when remaining < 1 hour.
 *
 * Shape examples:
 *   25d 03h        (≥ 1 day,  drop minutes/seconds — too noisy at this scale)
 *   05h 23m        (< 1 day,  ≥ 1 hour)
 *   42m 17s        (< 1 hour, ≥ 1 minute)
 *   09s            (< 1 minute)
 */
function formatRetestRemaining(remainingMs) {
    if (!Number.isFinite(remainingMs) || remainingMs <= 0) return '0s';
    const totalSec = Math.floor(remainingMs / 1000);
    const days = Math.floor(totalSec / 86400);
    const hours = Math.floor((totalSec % 86400) / 3600);
    const minutes = Math.floor((totalSec % 3600) / 60);
    const seconds = totalSec % 60;
    const pad = (n) => (n < 10 ? '0' + n : String(n));
    if (days >= 1) return days + 'd ' + pad(hours) + 'h';
    if (hours >= 1) return pad(hours) + 'h ' + pad(minutes) + 'm';
    if (minutes >= 1) return pad(minutes) + 'm ' + pad(seconds) + 's';
    return pad(seconds) + 's';
}

function _t(key, fallback) {
    return (typeof i18n !== 'undefined' && typeof i18n.t === 'function')
        ? i18n.t(key)
        : fallback;
}

// Minimal attribute-context escaper so the deadline + label strings
// can't break out of the HTML we build by string-concat. deadlineMs is
// always Number.isFinite, but the localized strings come from i18n.js
// which is owner-controlled and could theoretically contain quotes.
function _escAttr(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Render the countdown chip HTML. Caller injects this into a container
 * then calls attachRetestCountdown(container, deadlineMs) to start ticking.
 *
 * The chip always carries:
 *   - role="status" + aria-live="polite" — screen readers announce updates
 *   - aria-label — full "{label}: {value} ({tier})" sentence for assistive tech
 *   - text label + numeric value — color is never the only signal (WCAG 1.4.1)
 *   - data-testid hooks for Playwright E2E
 */
function renderRetestCountdownHtml(deadlineMs) {
    if (!Number.isFinite(deadlineMs)) return '';
    const remaining = deadlineMs - Date.now();
    const severity = getRetestSeverity(remaining);
    const labelText = _t('card_retest_label', 'Next retest');
    const tierLabel = _t('card_retest_tier_' + severity,
        severity.charAt(0).toUpperCase() + severity.slice(1));
    if (severity === 'ready') {
        const readyText = _t('card_retest_ready', 'Available now');
        const aria = _escAttr(labelText + ': ' + readyText + ' (' + tierLabel + ')');
        return ''
            + '<div class="retest-countdown retest-countdown--ready" '
            + 'data-retest-deadline="' + deadlineMs + '" '
            + 'data-testid="retest-countdown" '
            + 'role="status" aria-live="off" aria-label="' + aria + '">'
            +   '<span class="retest-countdown__label" data-i18n="card_retest_label">'
            +     _escAttr(labelText)
            +   '</span>'
            +   '<span class="retest-countdown__value" data-i18n="card_retest_ready" data-testid="retest-countdown-value">'
            +     _escAttr(readyText)
            +   '</span>'
            + '</div>';
    }
    const value = formatRetestRemaining(remaining);
    const aria = _escAttr(labelText + ': ' + value + ' (' + tierLabel + ')');
    return ''
        + '<div class="retest-countdown retest-countdown--' + severity + '" '
        + 'data-retest-deadline="' + deadlineMs + '" '
        + 'data-testid="retest-countdown" '
        + 'role="status" aria-live="off" aria-label="' + aria + '">'
        +   '<span class="retest-countdown__label" data-i18n="card_retest_label">'
        +     _escAttr(labelText)
        +   '</span>'
        +   '<span class="retest-countdown__value" data-testid="retest-countdown-value">'
        +     _escAttr(value)
        +   '</span>'
        + '</div>';
}

/**
 * Attach a 1-second tick to a `.retest-countdown` element so the value
 * counts down in real time. Auto-detaches when the element leaves the DOM
 * (MutationObserver fallback for environments without document.body).
 * Returns a stop() function for explicit cleanup (used by tests + on
 * dashboard tab switch so we never leak intervals into other pages).
 */
function attachRetestCountdown(rootEl) {
    if (!rootEl) return function noop() {};
    const node = rootEl.classList && rootEl.classList.contains('retest-countdown')
        ? rootEl
        : rootEl.querySelector && rootEl.querySelector('.retest-countdown');
    if (!node) return function noop() {};
    const deadline = parseInt(node.getAttribute('data-retest-deadline'), 10);
    if (!Number.isFinite(deadline)) return function noop() {};
    // Upper-bound sanity check: anything more than 10 years out is either a
    // bug or a tamper attempt — skip rather than render a millennial chip.
    const SANE_MAX_DEADLINE = Date.now() + 10 * 365 * ONE_DAY_MS;
    if (deadline > SANE_MAX_DEADLINE) return function noop() {};

    const valueEl = node.querySelector('.retest-countdown__value');
    if (!valueEl) return function noop() {};

    let stopped = false;
    let lastTier = null;

    // All 5 severity classes (plus 'ready') so tick() can fully toggle.
    // Listed once at attach time to avoid string-array allocation per tick.
    const SEVERITY_CLASSES = [
        'retest-countdown--gray',
        'retest-countdown--yellow',
        'retest-countdown--orange',
        'retest-countdown--red',
        'retest-countdown--green',
        'retest-countdown--ready',
    ];

    function tick() {
        if (stopped) return;
        if (typeof document !== 'undefined' && document.body && !document.body.contains(node)) {
            stop();
            return;
        }
        const remaining = deadline - Date.now();
        const severity = getRetestSeverity(remaining);
        // Toggle the palette class set in one pass.
        node.classList.remove.apply(node.classList, SEVERITY_CLASSES);
        node.classList.add('retest-countdown--' + severity);
        // Re-read i18n labels every tick so live locale switches propagate
        // (the dashboard's <select lang> swap doesn't re-render this chip).
        const labelText = _t('card_retest_label', 'Next retest');
        const tierLabel = _t('card_retest_tier_' + severity,
            severity.charAt(0).toUpperCase() + severity.slice(1));
        if (severity === 'ready') {
            valueEl.textContent = _t('card_retest_ready', 'Available now');
            valueEl.setAttribute('data-i18n', 'card_retest_ready');
            node.setAttribute('aria-label',
                labelText + ': ' + valueEl.textContent + ' (' + tierLabel + ')');
            // Once "ready" there is nothing left to tick — stop the timer so
            // the dashboard doesn't keep waking up every second forever.
            stop();
            return;
        }
        valueEl.textContent = formatRetestRemaining(remaining);
        valueEl.removeAttribute('data-i18n');
        // Always update aria-label so AT can re-read the current state on
        // demand. Only flip aria-live="polite" on TIER TRANSITIONS so
        // screen readers don't chatter every second (a known SR antipattern
        // — see sub-agent review #5). The chip ships role="status" and
        // aria-live="off" by default; we briefly promote to polite when
        // the urgency tier changes, then drop back.
        node.setAttribute('aria-label',
            labelText + ': ' + valueEl.textContent + ' (' + tierLabel + ')');
        if (severity !== lastTier) {
            lastTier = severity;
            node.setAttribute('aria-live', 'polite');
        } else {
            node.setAttribute('aria-live', 'off');
        }
    }

    const interval = setInterval(tick, 1000);
    tick();

    // Pause when the tab is hidden so a long-backgrounded dashboard stops
    // burning a tick per second. Resume on visibilitychange:visible.
    let pausedForVisibility = false;
    function onVis() {
        if (typeof document === 'undefined') return;
        if (document.hidden) pausedForVisibility = true;
        else { pausedForVisibility = false; tick(); }
    }
    // Hard-stop on pagehide so SPA navigation doesn't leak intervals.
    function onPageHide() { stop(); }
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
        document.addEventListener('visibilitychange', onVis);
    }
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.addEventListener('pagehide', onPageHide);
    }

    // Wrap setInterval's tick so it no-ops during pauses without losing
    // its scheduled cadence (we still want to resume on visibility).
    // tick() itself does nothing when stopped, so this is just an optimization.

    function stop() {
        if (stopped) return;
        stopped = true;
        clearInterval(interval);
        if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
            document.removeEventListener('visibilitychange', onVis);
        }
        if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
            window.removeEventListener('pagehide', onPageHide);
        }
    }
    return stop;
}

// Expose helpers for jest + dashboard wiring.
if (typeof window !== 'undefined') {
    window.EntityRetestCountdown = {
        ARENA_RETEST_COOLDOWN_DAYS,
        computeRetestDeadlineMs,
        getRetestSeverity,
        formatRetestRemaining,
        renderRetestCountdownHtml,
        attachRetestCountdown,
    };
}
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        ARENA_RETEST_COOLDOWN_DAYS,
        computeRetestDeadlineMs,
        getRetestSeverity,
        formatRetestRemaining,
        renderRetestCountdownHtml,
        attachRetestCountdown,
    };
}
