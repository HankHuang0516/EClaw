package com.hank.clawlive

import com.hank.clawlive.engine.BroadcastFormationController
import com.hank.clawlive.engine.BroadcastFormationController.Participant
import kotlin.math.atan2
import kotlin.math.hypot
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Child T4 — broadcast formation geometry tests (spec §8.3 + §6).
 *
 * Pure-Kotlin: no Android surface. Screen is a 1080x2400 portrait phone; sprite width 120px
 * gives 1 entity-unit = 120 * 1.5 = 180px = 0.1667 of width. Spacing checks are done in
 * *visual* (aspect-corrected px) space, matching how the halo is actually rendered.
 */
class BroadcastFormationControllerTest {
    private val screenW = 1080f
    private val screenH = 2400f
    private val spriteW = 120f
    private val oneEntityUnitPx = spriteW * BroadcastFormationController.ENTITY_UNIT_SPRITE_MULTIPLIER

    private fun controller() = BroadcastFormationController()

    /** Visual pixel distance between two screen-percent slots (x already aspect-corrected at plan time). */
    private fun pxDistance(
        ax: Float, ay: Float, bx: Float, by: Float
    ): Float = hypot((ax - bx) * screenW, (ay - by) * screenH)

    private fun grid(ids: List<Int>): List<Participant> = ids.mapIndexed { i, id ->
        // spread starting positions around the screen so angular sort is meaningful
        Participant(id, xPct = 0.2f + 0.1f * i, yPct = 0.2f + 0.08f * i)
    }

    @Test
    fun senderTargetsScreenCenter() {
        val parts = grid(listOf(1, 2, 3, 4))
        val f = controller().plan(
            senderId = 1,
            participants = parts,
            senderSpriteWidthPx = spriteW,
            screenWidthPx = screenW,
            screenHeightPx = screenH,
            broadcastReceivedAtMs = 0L
        )
        assertEquals(1, f.senderSlot.entityId)
        assertEquals(BroadcastFormationController.CENTER_X, f.senderSlot.xPct, 1e-6f)
        assertEquals(BroadcastFormationController.CENTER_Y, f.senderSlot.yPct, 1e-6f)
    }

    @Test
    fun fourEntitiesGetThreeDistinctNonOverlappingSlots() {
        val parts = grid(listOf(1, 2, 3, 4))
        val f = controller().plan(1, parts, spriteW, screenW, screenH, 0L)

        assertEquals("sender excluded, 3 bystanders", 3, f.bystanderSlots.size)

        // distinct slot positions
        val keys = f.bystanderSlots.map { "${it.xPct},${it.yPct}" }.toSet()
        assertEquals("all slots distinct", 3, keys.size)

        // every bystander id present exactly once, sender absent
        val ids = f.bystanderSlots.map { it.entityId }.toSet()
        assertEquals(setOf(2, 3, 4), ids)

        // >= 1 entity-unit from each other and from the sender (center)
        assertSpacing(f)
    }

    @Test
    fun eightEntitiesHitCountScaledRadiusAndStayApart() {
        val parts = grid((1..8).toList())
        val f = controller().plan(1, parts, spriteW, screenW, screenH, 0L)

        assertEquals(7, f.bystanderSlots.size)
        // spec §6.1 count-scaled floor dominates for large n (0.18 + 0.012*7 = 0.264 > 1.5*eu pct)
        val euPct = oneEntityUnitPx / screenW
        assertTrue(
            "radius should hit count-scaled floor for n=7",
            f.radiusPct >= 0.18f + 0.012f * 7 - 1e-4f
        )
        assertTrue("radius respects sprite floor", f.radiusPct >= 1.5f * euPct - 1e-4f)
        assertSpacing(f)
    }

    @Test
    fun radiusIsCappedForVeryLargeCounts() {
        val parts = grid((1..40).toList())
        val f = controller().plan(1, parts, spriteW, screenW, screenH, 0L)
        assertTrue(
            "radius capped at ${BroadcastFormationController.MAX_RADIUS_PCT}",
            f.radiusPct <= BroadcastFormationController.MAX_RADIUS_PCT + 1e-6f
        )
    }

    @Test
    fun firstBystanderSitsAboveSender() {
        // single bystander -> theta = -pi/2 -> directly above center (12 o'clock), spec §6.2
        val parts = listOf(
            Participant(1, 0.3f, 0.3f),
            Participant(2, 0.8f, 0.8f)
        )
        val f = controller().plan(1, parts, spriteW, screenW, screenH, 0L)
        assertEquals(1, f.bystanderSlots.size)
        val slot = f.bystanderSlots[0]
        assertEquals("x at center column", BroadcastFormationController.CENTER_X, slot.xPct, 1e-4f)
        assertTrue("y above center (smaller y = higher)", slot.yPct < BroadcastFormationController.CENTER_Y)
    }

    @Test
    fun sleepingEntityExcludedFromHalo() {
        // spec §8.3 T4-3: 3 entities, one sleeping -> only 1 bystander at 12 o'clock
        val parts = listOf(
            Participant(1, 0.3f, 0.3f),                 // sender
            Participant(2, 0.7f, 0.7f),                 // awake bystander
            Participant(3, 0.6f, 0.6f, sleeping = true) // sleeping -> excluded
        )
        val f = controller().plan(1, parts, spriteW, screenW, screenH, 0L)
        assertEquals("sleeping not recruited", 1, f.bystanderSlots.size)
        assertEquals(2, f.bystanderSlots[0].entityId)
    }

    @Test
    fun zeroBystandersSenderStillGoesToCenter() {
        // spec X-3 / O-4
        val parts = listOf(Participant(1, 0.3f, 0.3f))
        val f = controller().plan(1, parts, spriteW, screenW, screenH, 0L)
        assertEquals(0, f.bystanderSlots.size)
        assertEquals(BroadcastFormationController.CENTER_X, f.senderSlot.xPct, 1e-6f)
        assertEquals(BroadcastFormationController.CENTER_Y, f.senderSlot.yPct, 1e-6f)
    }

    @Test
    fun formationHoldsForDwellWindowThenDismisses() {
        // spec §6.4: halo persists until halo_dwell_seconds elapses
        val ctrl = BroadcastFormationController(haloDwellSeconds = 6.0f)
        val parts = grid(listOf(1, 2, 3))
        val received = 10_000L
        val f = ctrl.plan(1, parts, spriteW, screenW, screenH, received)

        assertEquals(received + 6_000L, f.haloDismissAtMs)
        assertTrue("holds at t=0", !ctrl.shouldDismiss(f, received))
        assertTrue("holds mid-window", !ctrl.shouldDismiss(f, received + 5_999L))
        assertTrue("dismisses at window end", ctrl.shouldDismiss(f, received + 6_000L))
        assertTrue("dismisses after window", ctrl.shouldDismiss(f, received + 9_000L))
    }

    @Test
    fun slotAssignmentPreservesAngularOrderToAvoidCrossing() {
        // spec §6.3: bystanders are dropped onto ring slots in angular order of their current
        // position. The anti-crossing invariant is that walking the slot ring clockwise visits
        // entities in the same cyclic order as their origin angles around the sender.
        val parts = listOf(
            Participant(1, 0.5f, 0.5f),  // sender at center
            Participant(2, 0.9f, 0.6f),  // lower-right
            Participant(3, 0.1f, 0.6f),  // lower-left
            Participant(4, 0.9f, 0.4f),  // upper-right
            Participant(5, 0.1f, 0.4f)   // upper-left
        )
        val f = controller().plan(1, parts, spriteW, screenW, screenH, 0L)

        // origin angle around center for each bystander
        fun originAngle(id: Int): Double {
            val p = parts.first { it.entityId == id }
            return atan2((p.yPct - 0.5).toDouble(), (p.xPct - 0.5).toDouble())
        }
        // slots are emitted in ring order (clockwise from 12 o'clock). The entity ids in that
        // emission order must be a rotation of the ids sorted by origin angle.
        val emissionOrder = f.bystanderSlots.map { it.entityId }
        val byOriginAngle = emissionOrder.sortedBy { originAngle(it) }

        fun isRotationOf(a: List<Int>, b: List<Int>): Boolean {
            if (a.size != b.size) return false
            val doubled = b + b
            for (start in b.indices) {
                if (doubled.subList(start, start + a.size) == a) return true
            }
            return false
        }
        assertTrue(
            "emission order $emissionOrder must be a rotation of origin-angle order $byOriginAngle",
            isRotationOf(emissionOrder, byOriginAngle)
        )
    }

    /** Asserts every bystander slot is >= 1 entity-unit from each other and from the sender center. */
    private fun assertSpacing(f: BroadcastFormationController.Formation) {
        val center = f.senderSlot
        for (s in f.bystanderSlots) {
            val dCenter = pxDistance(s.xPct, s.yPct, center.xPct, center.yPct)
            assertTrue(
                "slot ${s.entityId} must be >= 1 entity-unit ($oneEntityUnitPx px) from sender; was $dCenter",
                dCenter >= oneEntityUnitPx - 1f
            )
        }
        for (i in f.bystanderSlots.indices) {
            for (j in i + 1 until f.bystanderSlots.size) {
                val a = f.bystanderSlots[i]
                val b = f.bystanderSlots[j]
                val d = pxDistance(a.xPct, a.yPct, b.xPct, b.yPct)
                assertTrue(
                    "slots ${a.entityId} & ${b.entityId} must be >= 1 entity-unit apart; was $d",
                    d >= oneEntityUnitPx - 1f
                )
            }
        }
    }
}
