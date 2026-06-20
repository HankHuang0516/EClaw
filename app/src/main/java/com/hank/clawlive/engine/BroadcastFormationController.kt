package com.hank.clawlive.engine

import kotlin.math.PI
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.sin

/**
 * Child T4 — Broadcast formation geometry.
 *
 * On a broadcast event (speakTo all / @all) the **sender** does an accelerated walk to
 * screen center (0.5, 0.5) and every non-sleeping **bystander** moves toward the sender
 * and forms an evenly-distributed halo ring around it. The halo holds until the next
 * state change (a new broadcast/speakTo cancels it, or [haloDwellSeconds] elapses).
 *
 * This is pure, side-effect-free geometry: it computes screen-percent targets and steps
 * entities toward them. The wallpaper service wires the output into
 * [WallpaperWanderController.setTarget] for the sender and each bystander so the existing
 * draw-loop animation handles the actual walk. Keeping it pure makes the §6 spec testable
 * without an Android surface.
 *
 * Coordinate contract (matches T1 + spec §3/§4):
 *  - All positions are screen-fraction floats in [0,1]; x is corrected by aspect ratio so
 *    the halo looks visually circular on portrait phones.
 *  - 1 entity-unit = sprite_width * [ENTITY_UNIT_SPRITE_MULTIPLIER] (spec §3, default 1.5).
 *    Halo radius keeps every bystander >= 1 entity-unit from each other and the sender.
 *
 * @see docs/specs/wallpaper-walking-system-architecture.md §6
 */
class BroadcastFormationController(
    /** Halo persistence after the broadcast is received (spec §6.4, O-6). */
    private val haloDwellSeconds: Float = DEFAULT_HALO_DWELL_SECONDS
) {
    /** A computed screen-percent target plus the participant it belongs to. */
    data class Slot(
        val entityId: Int,
        val xPct: Float,
        val yPct: Float
    )

    /**
     * Result of planning a broadcast formation: where the sender goes and where each
     * non-sleeping bystander goes. [haloDismissAtMs] is when the formation should release
     * back to wander (spec §6.4).
     */
    data class Formation(
        val senderSlot: Slot,
        val bystanderSlots: List<Slot>,
        val radiusPct: Float,
        val haloDismissAtMs: Long
    )

    /**
     * Position of one participant in screen-fraction coordinates. [sleeping] participants
     * are excluded from halo recruitment per spec §7.1 (not counted in `n`, no slot).
     */
    data class Participant(
        val entityId: Int,
        val xPct: Float,
        val yPct: Float,
        val sleeping: Boolean = false
    )

    /**
     * Plan the formation for a broadcast originating from [senderId].
     *
     * @param senderId the entity that broadcast.
     * @param participants current positions of all entities (including the sender).
     * @param senderSpriteWidthPx sender sprite width in device px (focal point for entity-unit; spec §3.2).
     * @param screenWidthPx surface width in px (for entity-unit -> percent + aspect correction).
     * @param screenHeightPx surface height in px (for aspect correction).
     * @param broadcastReceivedAtMs timestamp the broadcast arrived (drives [Formation.haloDismissAtMs]).
     */
    fun plan(
        senderId: Int,
        participants: List<Participant>,
        senderSpriteWidthPx: Float,
        screenWidthPx: Float,
        screenHeightPx: Float,
        broadcastReceivedAtMs: Long
    ): Formation {
        require(screenWidthPx > 0f && screenHeightPx > 0f) { "screen dimensions must be positive" }

        val senderSlot = Slot(senderId, CENTER_X, CENTER_Y)
        val dismissAt = broadcastReceivedAtMs + (haloDwellSeconds * 1000f).toLong()

        // Non-sleeping bystanders only (spec §6 step 2/3, §7.1).
        val bystanders = participants.filter { it.entityId != senderId && !it.sleeping }
        val n = bystanders.size
        if (n == 0) {
            // Spec O-4 / X-3: sender still walks to center, halo timer still ticks.
            return Formation(senderSlot, emptyList(), 0f, dismissAt)
        }

        val radiusPct = haloRadiusPct(n, senderSpriteWidthPx, screenWidthPx)
        val aspect = screenHeightPx / screenWidthPx // §6.2 x-correction so the ring is visually circular

        // §6.3 assignment: order bystanders by the angle from screen-center to their current
        // position, then drop them onto evenly-spaced ring slots starting at 12 o'clock,
        // clockwise. This minimizes total walking distance and avoids the X-crossing tangle.
        val ordered = bystanders.sortedBy { angleFromCenter(it) }

        val slots = ordered.mapIndexed { i, b ->
            val theta = THETA_OFFSET + 2.0 * PI * i / n
            val x = (CENTER_X + radiusPct * cos(theta).toFloat() * aspect)
                .coerceIn(MIN_PCT, MAX_PCT)
            val y = (CENTER_Y + radiusPct * sin(theta).toFloat())
                .coerceIn(MIN_PCT, MAX_PCT)
            Slot(b.entityId, x, y)
        }

        return Formation(senderSlot, slots, radiusPct, dismissAt)
    }

    /**
     * Halo radius in screen-percent (spec §6.1).
     *
     *   radius = max(1.5 * entityUnitPct, 0.18 + 0.012 * n)  capped at 0.42
     *
     * The count-scaled floor prevents many bystanders from crushing together; the cap keeps
     * the halo on-screen on small phones.
     */
    fun haloRadiusPct(n: Int, senderSpriteWidthPx: Float, screenWidthPx: Float): Float {
        val entityUnitPct = (senderSpriteWidthPx * ENTITY_UNIT_SPRITE_MULTIPLIER) / screenWidthPx
        val countScaledFloor = COUNT_FLOOR_BASE + COUNT_FLOOR_PER_ENTITY * n
        return max(SPRITE_RADIUS_FACTOR * entityUnitPct, countScaledFloor).coerceAtMost(MAX_RADIUS_PCT)
    }

    /**
     * True once the halo dwell window has elapsed; the service should then
     * [WallpaperWanderController.resumeWander] every participant (spec §6.4).
     */
    fun shouldDismiss(formation: Formation, nowMs: Long): Boolean = nowMs >= formation.haloDismissAtMs

    private fun angleFromCenter(p: Participant): Float =
        atan2((p.yPct - CENTER_Y).toDouble(), (p.xPct - CENTER_X).toDouble()).toFloat()

    companion object {
        const val CENTER_X = 0.5f
        const val CENTER_Y = 0.5f

        /** Spec §3: 1 entity-unit = sprite_width * 1.5. */
        const val ENTITY_UNIT_SPRITE_MULTIPLIER = 1.5f

        /** Spec §6.1 radius terms. */
        const val SPRITE_RADIUS_FACTOR = 1.5f
        const val COUNT_FLOOR_BASE = 0.18f
        const val COUNT_FLOOR_PER_ENTITY = 0.012f
        const val MAX_RADIUS_PCT = 0.42f

        /** Spec §6.2: first bystander at 12 o'clock (above sender). */
        const val THETA_OFFSET = -PI / 2.0

        const val DEFAULT_HALO_DWELL_SECONDS = 6.0f

        // Keep ring slots inside the visible surface (mirrors T1 safe-bound intent).
        private const val MIN_PCT = 0.05f
        private const val MAX_PCT = 0.95f
    }
}
