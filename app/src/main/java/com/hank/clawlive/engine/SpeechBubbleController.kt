package com.hank.clawlive.engine

/**
 * Pure-Kotlin state machine + coordinate math for Walking System child T2:
 * speech bubbles anchored to an entity sprite (see
 * docs/specs/wallpaper-walking-system-architecture.md §5).
 *
 * Design goals (mirrors [WallpaperWanderController]):
 *  - All positions are screen-percent floats in [0..1] so bubbles survive
 *    orientation change / surface re-creation. Pixel coords are derived on-render
 *    by the (thin) drawing hook, never stored here.
 *  - The bubble RE-ANCHORS every frame while visible: [placementFor] reads the
 *    entity's *current* wander position each call, so the bubble trails a walking
 *    sprite. It never snapshots the anchor at show-time.
 *  - Fade is a deterministic timer driven by an injectable `nowMs`, so the whole
 *    lifecycle is unit-testable without Android / a Choreographer.
 *
 * Rendering stays thin: a drawer asks [placementFor] for the percent anchor +
 * alpha, multiplies by the surface width/height, and blits the bubble. This class
 * owns no Bitmap/Canvas/Paint.
 */
class SpeechBubbleController(
    private val defaultTtlMs: Long = DEFAULT_TTL_MS,
    private val fadeOutMs: Long = DEFAULT_FADE_OUT_MS,
    /** Gap between the sprite top and the bubble tail, as a fraction of screen height. */
    private val gapPctOfHeight: Float = DEFAULT_GAP_PCT_OF_HEIGHT
) {
    /** A live bubble's immutable spec. Position is resolved per-frame, not stored here. */
    private data class Bubble(
        val text: String,
        val shownAtMs: Long,
        val expiresAtMs: Long
    )

    private val bubbles = mutableMapOf<Int, Bubble>()

    /**
     * Anchor + visibility result for one entity's bubble, in screen-percent.
     *
     * @param anchorXPct horizontal center of the bubble tail, [0..1]
     * @param anchorYPct vertical position of the bubble tail, [0..1]
     * @param flippedBelow true when the entity is too near the top edge, so the
     *        bubble is rendered *below* the sprite (tail points up) per §5.4
     * @param alpha fade alpha in [0..1]; 1 while live, ramping to 0 over [fadeOutMs]
     */
    data class BubblePlacement(
        val text: String,
        val anchorXPct: Float,
        val anchorYPct: Float,
        val flippedBelow: Boolean,
        val alpha: Float
    )

    /** True if this entity currently has a (not-yet-expired) bubble. */
    fun isVisible(entityId: Int, nowMs: Long): Boolean {
        val bubble = bubbles[entityId] ?: return false
        if (nowMs >= bubble.expiresAtMs) {
            bubbles.remove(entityId)
            return false
        }
        return true
    }

    /** Number of live bubbles (after pruning expired ones). */
    fun activeCount(nowMs: Long): Int {
        prune(nowMs)
        return bubbles.size
    }

    /** Expiry timestamp for a live bubble, or null if absent/expired. */
    fun expiresAt(entityId: Int, nowMs: Long): Long? {
        val bubble = bubbles[entityId] ?: return null
        if (nowMs >= bubble.expiresAtMs) {
            bubbles.remove(entityId)
            return null
        }
        return bubble.expiresAtMs
    }

    fun reset() = bubbles.clear()

    /**
     * Show (or refresh) a bubble for [entityId]. TTL = the user's preferred dwell
     * (honored up to the 10-min slider ceiling), or the long-text auto-extension
     * (0.06s/char, itself capped at 20s) — whichever is larger.
     * [ttlMsOverride] remains an exact escape hatch for deterministic tests.
     * A new message resets the TTL (rapid-fire chat, open question O-7).
     * Blank text clears any existing bubble.
     */
    fun show(
        entityId: Int,
        text: String,
        nowMs: Long,
        ttlMsOverride: Long? = null,
        preferredTtlMs: Long? = null
    ) {
        if (text.isBlank()) {
            bubbles.remove(entityId)
            return
        }
        val ttl = ttlMsOverride ?: ttlForText(text, preferredTtlMs ?: defaultTtlMs)
        bubbles[entityId] = Bubble(
            text = text,
            shownAtMs = nowMs,
            expiresAtMs = nowMs + ttl
        )
    }

    /** Explicitly clear a bubble (e.g. conversation ended). */
    fun clear(entityId: Int) {
        bubbles.remove(entityId)
    }

    /**
     * Resolve the bubble placement for [entityId] at the entity's *current*
     * position (re-anchored every frame so the bubble follows a walking sprite).
     *
     * Position is supplied as screen-percent so this works identically whether the
     * entity is WANDERING (T1 animated position) or STOPPED / reduce-motion
     * (static base position) — both anchor through the same formula.
     *
     * @param entityXPct sprite center X in screen-percent [0..1]
     * @param entityYPct sprite center Y in screen-percent [0..1]
     * @param spriteHeightPct sprite bounding-box height as a fraction of screen height
     * @return placement, or null when no live bubble exists
     */
    fun placementFor(
        entityId: Int,
        entityXPct: Float,
        entityYPct: Float,
        spriteHeightPct: Float,
        nowMs: Long
    ): BubblePlacement? {
        val bubble = bubbles[entityId] ?: return null
        if (nowMs >= bubble.expiresAtMs) {
            bubbles.remove(entityId)
            return null
        }

        val halfSprite = spriteHeightPct * 0.5f
        // §5.1 anchor: above the sprite top by `gap`. §5.4: flip below if too near top.
        val topAnchorY = entityYPct - halfSprite - gapPctOfHeight
        val flippedBelow = topAnchorY < TOP_EDGE_FLIP_THRESHOLD_PCT
        val anchorY = if (flippedBelow) {
            entityYPct + halfSprite + gapPctOfHeight
        } else {
            topAnchorY
        }

        val anchorX = entityXPct.coerceIn(0f, 1f)
        val anchorYClamped = anchorY.coerceIn(0f, 1f)

        return BubblePlacement(
            text = bubble.text,
            anchorXPct = anchorX,
            anchorYPct = anchorYClamped,
            flippedBelow = flippedBelow,
            alpha = alphaFor(bubble, nowMs)
        )
    }

    private fun alphaFor(bubble: Bubble, nowMs: Long): Float {
        val remaining = bubble.expiresAtMs - nowMs
        if (remaining <= 0L) return 0f
        if (fadeOutMs <= 0L || remaining >= fadeOutMs) return 1f
        return (remaining.toFloat() / fadeOutMs.toFloat()).coerceIn(0f, 1f)
    }

    private fun ttlForText(text: String, preferredTtlMs: Long): Long {
        // card_c421110c: the user-configured dwell is AUTHORITATIVE. Honor it up to
        // the 10-min slider ceiling (MAX_USER_TTL_MS). The old code did
        // `maxOf(preferred, scaled).coerceAtMost(MAX_TTL_MS)` with MAX_TTL_MS = 20s,
        // which silently capped EVERY bubble at 20s — so the slider (raised to 10 min)
        // had no runtime effect (set 3 min → got 20s). The 20s cap belongs ONLY to the
        // long-text auto-extension, never to the user's explicit preference.
        val preferred = preferredTtlMs.coerceIn(MIN_TTL_MS, MAX_USER_TTL_MS)
        // Auto-extend short dwells so a long message stays readable, but cap that
        // auto-extension at MAX_AUTO_SCALE_TTL_MS so a giant message can't pin a bubble
        // forever. This never shrinks a larger user preference (we take the max).
        val scaled = (PER_CHAR_MS * text.length).coerceIn(MIN_TTL_MS, MAX_AUTO_SCALE_TTL_MS)
        return maxOf(preferred, scaled)
    }

    private fun prune(nowMs: Long) {
        val expired = bubbles.filterValues { nowMs >= it.expiresAtMs }.keys.toList()
        expired.forEach { bubbles.remove(it) }
    }

    companion object {
        /** Default preferred TTL for short wallpaper bubbles. */
        const val DEFAULT_TTL_MS = 5_000L
        /** Floor for any message bubble (§5.3). */
        const val MIN_TTL_MS = 1_000L
        /**
         * Ceiling for the user-configured dwell preference. Matches the wallpaper
         * bubble-duration slider max (LayoutPreferences.WALLPAPER_BUBBLE_DURATION_MAX_SECONDS
         * = 600s = 10 min, card_c421110c). The user's explicit setting is honored up to here.
         */
        const val MAX_USER_TTL_MS = 600_000L
        /**
         * Cap for the long-text AUTO-extension only (§5.3) — NOT a ceiling on the user's
         * explicit dwell setting. Bounds how long a very long message can self-extend so it
         * can't pin a bubble forever when the user left the dwell short.
         */
        const val MAX_AUTO_SCALE_TTL_MS = 20_000L
        /** Per-character contribution to TTL (§5.3: 0.06s/char). */
        const val PER_CHAR_MS = 60L
        /** Fade-out ramp window at the end of life. */
        const val DEFAULT_FADE_OUT_MS = 600L
        /** Gap above the sprite, ~ default 8dp expressed as a small fraction of height. */
        const val DEFAULT_GAP_PCT_OF_HEIGHT = 0.02f
        /** Practical top gutter: flip before the bubble gets pinned to the top edge. */
        const val TOP_EDGE_FLIP_THRESHOLD_PCT = 0.08f
    }
}
