package com.hank.clawlive

import com.hank.clawlive.data.model.CharacterState
import com.hank.clawlive.data.repository.ActivityStatePolicy
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

/**
 * FSM Stage 3 (client) unit tests — pure JVM, no Android instrumentation.
 *
 * Two guarantees, both proven fail-on-old:
 *
 *  (a) A poll/transport ERROR must NOT produce SLEEPING. The pre-fix
 *      StateRepository.getStatusFlow mapped every network error →
 *      CharacterState.SLEEPING (false-sleep). Restoring that — i.e. making
 *      [ActivityStatePolicy.stateOnPollError] return SLEEPING — makes
 *      [pollErrorNeverProducesSleepingFromNoState] /
 *      [pollErrorNeverUpgradesActiveToSleeping] FAIL.
 *
 *  (b) The client HONORS the server-authoritative activity states. The backend
 *      (backend/lib/entity-activity.js) emits ACTIVE→"BUSY", IDLE→"IDLE",
 *      SLEEPING→"SLEEPING" on the wire; the client must map each to the matching
 *      CharacterState and must render canonical ACTIVE as busy-like (not the
 *      IDLE fallback). Reverting the `"active" -> BUSY` wire alias makes
 *      [honorsServerActiveAsBusy] FAIL.
 */
class ActivityStatePolicyTest {

    // ---- (a) poll error never synthesizes SLEEPING ----

    @Test
    fun pollErrorNeverProducesSleepingFromNoState() {
        // First poll already failed → no server state yet. Must be a neutral,
        // non-sleeping placeholder. (Old error→SLEEPING behavior fails here.)
        val result = ActivityStatePolicy.stateOnPollError(null)
        assertNotEquals(
            "a poll failure with no prior state must NOT be SLEEPING",
            CharacterState.SLEEPING,
            result
        )
        assertEquals("neutral fallback is IDLE", CharacterState.IDLE, result)
    }

    @Test
    fun pollErrorNeverUpgradesActiveToSleeping() {
        // Server last said ACTIVE(BUSY); a transient network error must keep that
        // last-known state, never flip it to SLEEPING.
        val result = ActivityStatePolicy.stateOnPollError(CharacterState.BUSY)
        assertNotEquals(
            "a poll failure must not turn an ACTIVE entity to SLEEPING",
            CharacterState.SLEEPING,
            result
        )
        assertEquals("keeps the last server-known ACTIVE/BUSY state", CharacterState.BUSY, result)
    }

    @Test
    fun pollErrorKeepsLastKnownIdle() {
        assertEquals(
            "a poll failure keeps the last server-known IDLE state",
            CharacterState.IDLE,
            ActivityStatePolicy.stateOnPollError(CharacterState.IDLE)
        )
    }

    @Test
    fun pollErrorPreservesLegitimateServerSleeping() {
        // SLEEPING that the SERVER already evaluated is legitimate and must be
        // preserved across a blip — the rule forbids *synthesizing* sleep, not
        // showing server-authoritative sleep.
        assertEquals(
            "a server-sourced SLEEPING is preserved across a poll error",
            CharacterState.SLEEPING,
            ActivityStatePolicy.stateOnPollError(CharacterState.SLEEPING)
        )
    }

    // ---- (b) client honors server-authoritative wire states ----

    @Test
    fun honorsServerSleeping() {
        assertEquals(CharacterState.SLEEPING, CharacterState.fromWireValue("SLEEPING"))
    }

    @Test
    fun honorsServerIdle() {
        assertEquals(CharacterState.IDLE, CharacterState.fromWireValue("IDLE"))
    }

    @Test
    fun honorsServerActiveAsBusy() {
        // Backend wire value for canonical ACTIVE.
        assertEquals(CharacterState.BUSY, CharacterState.fromWireValue("BUSY"))
        // Canonical ACTIVE name must also render busy-like, NOT fall back to IDLE.
        // (Pre-fix fromWireValue had no "active" branch → returned IDLE → FAIL.)
        assertEquals(CharacterState.BUSY, CharacterState.fromWireValue("ACTIVE"))
        assertNotEquals(
            "ACTIVE must not map to the IDLE fallback",
            CharacterState.IDLE,
            CharacterState.fromWireValue("ACTIVE")
        )
    }
}
