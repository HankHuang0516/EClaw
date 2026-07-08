package com.hank.clawlive.data.repository

import com.hank.clawlive.data.model.CharacterState

/**
 * FSM Stage 3 — client-side activity-state policy (pure Kotlin, no Android deps).
 *
 * The activity state machine is SERVER-AUTHORITATIVE: ACTIVE(BUSY) / IDLE /
 * SLEEPING are decided ONLY by the backend's deterministic evaluator
 * (backend/lib/entity-activity.js `evaluateActivityState`) and arrive on the
 * `state` field of /api/status and /api/entities. The client renders that state;
 * it must NOT independently decide sleep/idle via its own timers or heuristics
 * ("睡覺以及 IDLE 的狀態都需要嚴謹的狀態機評估才能進入" — Hank).
 *
 * This object encodes the single client-side invariant that protects that
 * contract: a transport/poll FAILURE can never be the source of SLEEPING. The
 * old [StateRepository.getStatusFlow] mapped any network error → SLEEPING, so a
 * brief offline blip made an entity look asleep ("睡著了") even though the server
 * never evaluated it as SLEEPING. That is a false-sleep and is forbidden here.
 */
object ActivityStatePolicy {

    /**
     * The activity state to DISPLAY when a status poll fails.
     *
     * Rules:
     *  - Keep the last server-known state if we have one. If that happens to be
     *    [CharacterState.SLEEPING] it is legitimate — it came from the server's
     *    authoritative evaluation, not from this error.
     *  - With no prior server state (first poll already failed), fall back to a
     *    neutral, non-sleeping placeholder ([CharacterState.IDLE]).
     *  - A poll failure NEVER introduces [CharacterState.SLEEPING] on its own.
     *
     * @param lastKnown the most recent state the SERVER reported, or null if none
     *   has been received yet.
     */
    fun stateOnPollError(lastKnown: CharacterState?): CharacterState =
        lastKnown ?: CharacterState.IDLE
}
