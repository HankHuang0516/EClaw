package com.hank.clawlive.engine

import android.graphics.PointF
import com.hank.clawlive.data.model.EntityStatus
import kotlin.math.abs
import kotlin.math.hypot
import kotlin.math.min
import kotlin.random.Random

interface MotionController {
    fun position(entityId: Int): PointF
    fun motionState(entityId: Int): MotionState
    fun setTarget(entityId: Int, xPct: Float, yPct: Float, onArrive: (() -> Unit)? = null)
    fun stop(entityId: Int)
    fun clearStop(entityId: Int)
    fun resumeWander(entityId: Int)
}

enum class MotionState {
    WANDERING,
    MOVING_TO_TARGET,
    STOPPED,
    SLEEPING
}

enum class AmbientWanderGoal {
    RANDOM,
    VISIT_COMPANION,
    PATROL,
    RETURN_HOME
}

enum class WalkFacingDirection {
    LEFT,
    RIGHT
}

/**
 * Lightweight per-device wallpaper wander engine.
 *
 * The controller keeps only in-memory screen-percent positions/targets; the persisted
 * switch lives in LayoutPreferences so the feature remains device-level, not
 * per-entity. It is deterministic enough for tests via injectable time/random,
 * but cheap enough for the wallpaper draw loop (O(entityCount), no allocations
 * beyond the returned position list).
 */
class WallpaperWanderController(
    private val wanderSpeedPctPerSecond: Float = DEFAULT_WANDER_SPEED_PCT_PER_SECOND,
    private val targetSpeedPctPerSecond: Float = DEFAULT_TARGET_SPEED_PCT_PER_SECOND,
    private val random: Random = Random.Default
) : MotionController {
    private data class WanderState(
        var xPct: Float,
        var yPct: Float,
        var homeXPct: Float,
        var homeYPct: Float,
        var targetXPct: Float,
        var targetYPct: Float,
        var lastUpdateMs: Long,
        var idleUntilMs: Long,
        var retargetAtMs: Long,
        var moving: Boolean,
        var motionState: MotionState,
        var ambientGoal: AmbientWanderGoal,
        var ambientStep: Int,
        var facingDirection: WalkFacingDirection,
        var onArrive: (() -> Unit)? = null
    )

    private data class AmbientPeer(
        val entityId: Int,
        val xPct: Float,
        val yPct: Float
    )

    private val states = mutableMapOf<Int, WanderState>()

    fun reset() {
        states.clear()
    }

    fun isWalking(entityId: Int): Boolean = states[entityId]?.moving == true

    fun ambientGoal(entityId: Int): AmbientWanderGoal {
        return states[entityId]?.ambientGoal ?: AmbientWanderGoal.RANDOM
    }

    fun facingDirection(entityId: Int): WalkFacingDirection {
        return states[entityId]?.facingDirection ?: WalkFacingDirection.RIGHT
    }

    override fun position(entityId: Int): PointF {
        val state = states[entityId] ?: return PointF(0.5f, 0.5f)
        return PointF(state.xPct, state.yPct)
    }

    override fun motionState(entityId: Int): MotionState {
        return states[entityId]?.motionState ?: MotionState.STOPPED
    }

    override fun setTarget(entityId: Int, xPct: Float, yPct: Float, onArrive: (() -> Unit)?) {
        val state = commandState(entityId)
        state.targetXPct = xPct.coerceIn(MIN_X_PCT, MAX_X_PCT)
        state.targetYPct = yPct.coerceIn(MIN_Y_PCT, MAX_Y_PCT)
        state.motionState = MotionState.MOVING_TO_TARGET
        state.moving = false
        state.onArrive = onArrive
    }

    override fun stop(entityId: Int) {
        val state = commandState(entityId)
        state.motionState = MotionState.STOPPED
        state.moving = false
        state.onArrive = null
    }

    override fun clearStop(entityId: Int) {
        val state = states[entityId] ?: return
        if (state.motionState == MotionState.STOPPED) {
            state.motionState = MotionState.WANDERING
            state.idleUntilMs = 0L
        }
    }

    override fun resumeWander(entityId: Int) {
        val state = commandState(entityId)
        state.motionState = MotionState.WANDERING
        state.moving = false
        state.idleUntilMs = 0L
        state.onArrive = null
    }

    fun positionsFor(
        basePositions: List<Pair<Float, Float>>,
        entities: List<EntityStatus>,
        width: Float,
        height: Float,
        enabled: Boolean,
        purposeful: Boolean = true,
        nowMs: Long = System.currentTimeMillis(),
        conversationEntityIds: Set<Int> = emptySet(),
        entityUnitPx: Float = min(width, height) * DEFAULT_GATHER_SPACING_PCT
    ): List<Pair<Float, Float>> {
        if (!enabled || width <= 0f || height <= 0f) {
            states.clear()
            return basePositions
        }

        val activeIds = entities.map { it.entityId }.toSet()
        states.keys.toList().forEach { id -> if (id !in activeIds) states.remove(id) }
        val gatheringIds = conversationEntityIds.intersect(activeIds)
        val gatherTargets = if (gatheringIds.isNotEmpty()) {
            gatherTargetsFor(gatheringIds, width, height, entityUnitPx)
        } else {
            emptyMap()
        }

        return entities.mapIndexed { index, entity ->
            val base = basePositions.getOrNull(index) ?: (width / 2f to height / 2f)
            if (entity.state.pausesAmbientWander) {
                val state = stateFor(entity.entityId, base, width, height, nowMs)
                state.motionState = MotionState.SLEEPING
                state.moving = false
                state.xPct * width to state.yPct * height
            } else if (gatherTargets.isNotEmpty()) {
                advanceConversationTarget(entity, base, width, height, nowMs, gatherTargets[entity.entityId])
            } else {
                advanceHome(entity, base, width, height, nowMs)
            }
        }
    }

    private fun advanceConversationTarget(
        entity: EntityStatus,
        base: Pair<Float, Float>,
        width: Float,
        height: Float,
        nowMs: Long,
        gatherTarget: Pair<Float, Float>?
    ): Pair<Float, Float> {
        val state = stateFor(entity.entityId, base, width, height, nowMs)
        state.homeXPct = (base.first / width).coerceIn(MIN_X_PCT, MAX_X_PCT)
        state.homeYPct = (base.second / height).coerceIn(MIN_Y_PCT, MAX_Y_PCT)
        if (state.motionState == MotionState.SLEEPING) {
            state.motionState = MotionState.STOPPED
        }
        val target = gatherTarget ?: (state.homeXPct to state.homeYPct)
        return advanceTowardExplicitTarget(state, target.first, target.second, width, height, nowMs)
    }

    private fun advanceHome(
        entity: EntityStatus,
        base: Pair<Float, Float>,
        width: Float,
        height: Float,
        nowMs: Long
    ): Pair<Float, Float> {
        val state = stateFor(entity.entityId, base, width, height, nowMs)
        state.homeXPct = (base.first / width).coerceIn(MIN_X_PCT, MAX_X_PCT)
        state.homeYPct = (base.second / height).coerceIn(MIN_Y_PCT, MAX_Y_PCT)
        if (state.motionState == MotionState.SLEEPING) {
            state.motionState = MotionState.STOPPED
        }
        return advanceTowardExplicitTarget(state, state.homeXPct, state.homeYPct, width, height, nowMs)
    }

    private fun advanceTowardExplicitTarget(
        state: WanderState,
        targetXPct: Float,
        targetYPct: Float,
        width: Float,
        height: Float,
        nowMs: Long
    ): Pair<Float, Float> {
        val targetX = targetXPct.coerceIn(MIN_X_PCT, MAX_X_PCT)
        val targetY = targetYPct.coerceIn(MIN_Y_PCT, MAX_Y_PCT)
        val dtSeconds = ((nowMs - state.lastUpdateMs).coerceIn(0L, 1000L)) / 1000f
        state.lastUpdateMs = nowMs
        state.targetXPct = targetX
        state.targetYPct = targetY
        state.motionState = if (
            abs(state.xPct - targetX) * width < ARRIVAL_EPSILON_PX &&
            abs(state.yPct - targetY) * height < ARRIVAL_EPSILON_PX
        ) {
            MotionState.STOPPED
        } else {
            MotionState.MOVING_TO_TARGET
        }
        val arrived = moveTowardTarget(state, width, height, targetSpeedPctPerSecond, dtSeconds)
        if (arrived) {
            state.motionState = MotionState.STOPPED
            val callback = state.onArrive
            state.onArrive = null
            callback?.invoke()
        }
        return state.xPct * width to state.yPct * height
    }

    private fun gatherTargetsFor(
        entityIds: Set<Int>,
        width: Float,
        height: Float,
        entityUnitPx: Float
    ): Map<Int, Pair<Float, Float>> {
        val ids = entityIds.sorted()
        if (ids.isEmpty()) return emptyMap()
        val spacingX = (entityUnitPx / width).coerceAtLeast(DEFAULT_GATHER_SPACING_PCT)
        val spacingY = (entityUnitPx / height).coerceAtLeast(DEFAULT_GATHER_SPACING_PCT)
        val columns = kotlin.math.ceil(kotlin.math.sqrt(ids.size.toDouble())).toInt().coerceAtLeast(1)
        val rows = kotlin.math.ceil(ids.size.toDouble() / columns.toDouble()).toInt().coerceAtLeast(1)
        val startX = 0.5f - ((columns - 1) * spacingX) / 2f
        val startY = 0.5f - ((rows - 1) * spacingY) / 2f
        return ids.mapIndexed { index, id ->
            val row = index / columns
            val col = index % columns
            val rowCount = if (row == rows - 1) ids.size - row * columns else columns
            val rowStartX = 0.5f - ((rowCount - 1) * spacingX) / 2f
            id to safeTarget(
                rowStartX + col * spacingX,
                startY + row * spacingY
            )
        }.toMap()
    }

    private fun advance(
        entity: EntityStatus,
        base: Pair<Float, Float>,
        width: Float,
        height: Float,
        nowMs: Long,
        purposeful: Boolean,
        ambientPeers: List<AmbientPeer>
    ): Pair<Float, Float> {
        val entityId = entity.entityId
        val state = stateFor(entityId, base, width, height, nowMs)
        state.homeXPct = (base.first / width).coerceIn(MIN_X_PCT, MAX_X_PCT)
        state.homeYPct = (base.second / height).coerceIn(MIN_Y_PCT, MAX_Y_PCT)
        if (state.motionState == MotionState.SLEEPING) {
            state.motionState = MotionState.WANDERING
            state.idleUntilMs = 0L
        }

        val dtSeconds = ((nowMs - state.lastUpdateMs).coerceIn(0L, 1000L)) / 1000f
        state.lastUpdateMs = nowMs

        when (state.motionState) {
            MotionState.STOPPED,
            MotionState.SLEEPING -> {
                state.moving = false
                return state.xPct * width to state.yPct * height
            }
            MotionState.MOVING_TO_TARGET -> {
                val arrived = moveTowardTarget(state, width, height, targetSpeedPctPerSecond, dtSeconds)
                if (arrived) {
                    state.motionState = MotionState.STOPPED
                    val callback = state.onArrive
                    state.onArrive = null
                    callback?.invoke()
                }
                return state.xPct * width to state.yPct * height
            }
            MotionState.WANDERING -> Unit
        }

        if (nowMs < state.idleUntilMs) {
            state.moving = false
            return state.xPct * width to state.yPct * height
        }

        if (nowMs >= state.retargetAtMs) {
            retarget(state, nowMs, entity, purposeful, ambientPeers)
        }

        if (moveTowardTarget(state, width, height, wanderSpeedPctPerSecond, dtSeconds)) {
            state.moving = false
            state.idleUntilMs = nowMs + randomLong(0L, MAX_IDLE_MS)
            retarget(state, state.idleUntilMs, entity, purposeful, ambientPeers)
        }

        coerceToSafeBounds(state)
        return state.xPct * width to state.yPct * height
    }

    private fun stateFor(
        entityId: Int,
        base: Pair<Float, Float>,
        width: Float,
        height: Float,
        nowMs: Long
    ): WanderState {
        val state = states.getOrPut(entityId) {
            val x = (base.first / width).coerceIn(MIN_X_PCT, MAX_X_PCT)
            val y = (base.second / height).coerceIn(MIN_Y_PCT, MAX_Y_PCT)
            val target = randomTarget()
            WanderState(
                xPct = x,
                yPct = y,
                homeXPct = x,
                homeYPct = y,
                targetXPct = target.first,
                targetYPct = target.second,
                lastUpdateMs = nowMs,
                idleUntilMs = nowMs + randomLong(0L, MAX_IDLE_MS),
                retargetAtMs = nowMs + randomLong(MIN_RETARGET_MS, MAX_RETARGET_MS),
                moving = false,
                motionState = MotionState.WANDERING,
                ambientGoal = AmbientWanderGoal.RANDOM,
                ambientStep = 0,
                facingDirection = WalkFacingDirection.RIGHT
            )
        }
        coerceToSafeBounds(state)
        return state
    }

    private fun commandState(entityId: Int): WanderState {
        return states.getOrPut(entityId) {
            WanderState(
                xPct = 0.5f,
                yPct = 0.5f,
                homeXPct = 0.5f,
                homeYPct = 0.5f,
                targetXPct = 0.5f,
                targetYPct = 0.5f,
                lastUpdateMs = 0L,
                idleUntilMs = 0L,
                retargetAtMs = 0L,
                moving = false,
                motionState = MotionState.STOPPED,
                ambientGoal = AmbientWanderGoal.RANDOM,
                ambientStep = 0,
                facingDirection = WalkFacingDirection.RIGHT
            )
        }
    }

    private fun moveTowardTarget(
        state: WanderState,
        width: Float,
        height: Float,
        speedPctPerSecond: Float,
        dtSeconds: Float
    ): Boolean {
        val dxPx = (state.targetXPct - state.xPct) * width
        val dyPx = (state.targetYPct - state.yPct) * height
        if (abs(dxPx) > FACING_EPSILON_PX) {
            state.facingDirection = if (dxPx < 0f) WalkFacingDirection.LEFT else WalkFacingDirection.RIGHT
        }
        val distancePx = hypot(dxPx, dyPx)
        val stepPx = speedPctPerSecond * min(width, height) * dtSeconds

        if (distancePx <= stepPx || distancePx < ARRIVAL_EPSILON_PX) {
            state.xPct = state.targetXPct
            state.yPct = state.targetYPct
            state.moving = false
            return true
        }

        if (stepPx > 0f) {
            val fraction = (stepPx / distancePx).coerceAtMost(1f)
            state.xPct += (state.targetXPct - state.xPct) * fraction
            state.yPct += (state.targetYPct - state.yPct) * fraction
            state.moving = true
        }
        coerceToSafeBounds(state)
        return false
    }

    private fun retarget(
        state: WanderState,
        fromMs: Long,
        entity: EntityStatus,
        purposeful: Boolean,
        ambientPeers: List<AmbientPeer>
    ) {
        val target = if (purposeful) {
            purposefulTarget(state, entity, ambientPeers)
        } else {
            state.ambientGoal = AmbientWanderGoal.RANDOM
            randomTarget()
        }
        state.targetXPct = target.first
        state.targetYPct = target.second
        state.retargetAtMs = fromMs + randomLong(MIN_RETARGET_MS, MAX_RETARGET_MS)
    }

    private fun purposefulTarget(
        state: WanderState,
        entity: EntityStatus,
        ambientPeers: List<AmbientPeer>
    ): Pair<Float, Float> {
        val peers = ambientPeers.filter { it.entityId != entity.entityId }
        val step = state.ambientStep++
        val goal = when {
            peers.isNotEmpty() && entity.state.excitedLike -> AmbientWanderGoal.VISIT_COMPANION
            entity.state.busyLike -> if (step % 2 == 0) AmbientWanderGoal.PATROL else AmbientWanderGoal.RETURN_HOME
            peers.isNotEmpty() && step % 3 == 0 -> AmbientWanderGoal.VISIT_COMPANION
            step % 3 == 1 -> AmbientWanderGoal.PATROL
            else -> AmbientWanderGoal.RETURN_HOME
        }
        state.ambientGoal = goal

        return when (goal) {
            AmbientWanderGoal.VISIT_COMPANION -> companionVisitTarget(entity.entityId, peers)
            AmbientWanderGoal.PATROL -> patrolTarget(state, step)
            AmbientWanderGoal.RETURN_HOME -> nearHomeTarget(state)
            AmbientWanderGoal.RANDOM -> randomTarget()
        }
    }

    private fun companionVisitTarget(entityId: Int, peers: List<AmbientPeer>): Pair<Float, Float> {
        val peer = peers.random(random)
        val side = if ((entityId + peer.entityId) % 2 == 0) 1f else -1f
        val x = peer.xPct + side * randomFloat(SOCIAL_MIN_OFFSET_PCT, SOCIAL_MAX_OFFSET_PCT)
        val y = peer.yPct + randomFloat(-SOCIAL_Y_OFFSET_PCT, SOCIAL_Y_OFFSET_PCT)
        return safeTarget(x, y)
    }

    private fun patrolTarget(state: WanderState, step: Int): Pair<Float, Float> {
        val phase = step % 4
        val x = state.homeXPct + when (phase) {
            0 -> -PATROL_RADIUS_X_PCT
            1 -> PATROL_RADIUS_X_PCT
            2 -> PATROL_RADIUS_X_PCT * 0.5f
            else -> -PATROL_RADIUS_X_PCT * 0.5f
        }
        val y = state.homeYPct + when (phase) {
            0 -> -PATROL_RADIUS_Y_PCT
            1 -> -PATROL_RADIUS_Y_PCT * 0.4f
            2 -> PATROL_RADIUS_Y_PCT
            else -> PATROL_RADIUS_Y_PCT * 0.4f
        }
        return safeTarget(x, y)
    }

    private fun nearHomeTarget(state: WanderState): Pair<Float, Float> {
        return safeTarget(
            state.homeXPct + randomFloat(-HOME_RADIUS_PCT, HOME_RADIUS_PCT),
            state.homeYPct + randomFloat(-HOME_RADIUS_PCT, HOME_RADIUS_PCT)
        )
    }

    private fun safeTarget(xPct: Float, yPct: Float): Pair<Float, Float> {
        return xPct.coerceIn(MIN_X_PCT, MAX_X_PCT) to yPct.coerceIn(MIN_Y_PCT, MAX_Y_PCT)
    }

    private fun randomTarget(): Pair<Float, Float> {
        return randomFloat(MIN_X_PCT, MAX_X_PCT) to randomFloat(MIN_Y_PCT, MAX_Y_PCT)
    }

    private fun randomFloat(min: Float, max: Float): Float {
        if (max <= min) return min
        return min + random.nextFloat() * (max - min)
    }

    private fun randomLong(min: Long, max: Long): Long {
        if (max <= min) return min
        return min + random.nextLong(max - min + 1)
    }

    private fun coerceToSafeBounds(state: WanderState) {
        state.xPct = state.xPct.coerceIn(MIN_X_PCT, MAX_X_PCT)
        state.yPct = state.yPct.coerceIn(MIN_Y_PCT, MAX_Y_PCT)
    }

    companion object {
        const val DEFAULT_WANDER_SPEED_PCT_PER_SECOND = 0.04f
        const val DEFAULT_TARGET_SPEED_PCT_PER_SECOND = 0.12f
        const val DEFAULT_GATHER_SPACING_PCT = 0.18f
        private const val ARRIVAL_EPSILON_PX = 1f
        private const val FACING_EPSILON_PX = 0.5f
        private const val MAX_IDLE_MS = 3000L
        private const val MIN_RETARGET_MS = 3000L
        private const val MAX_RETARGET_MS = 8000L
        private const val MIN_X_PCT = 0.08f
        private const val MAX_X_PCT = 0.92f
        private const val MIN_Y_PCT = 0.12f
        private const val MAX_Y_PCT = 0.82f
        private const val SOCIAL_MIN_OFFSET_PCT = 0.06f
        private const val SOCIAL_MAX_OFFSET_PCT = 0.12f
        private const val SOCIAL_Y_OFFSET_PCT = 0.05f
        private const val PATROL_RADIUS_X_PCT = 0.16f
        private const val PATROL_RADIUS_Y_PCT = 0.08f
        private const val HOME_RADIUS_PCT = 0.05f
        const val WALKING_STATE_ASSET = "WALKING"
    }
}
