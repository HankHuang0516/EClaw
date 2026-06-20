package com.hank.clawlive.engine

import com.hank.clawlive.data.model.CharacterState
import com.hank.clawlive.data.model.EntityStatus
import kotlin.math.hypot
import kotlin.random.Random

/**
 * Lightweight per-device wallpaper wander engine.
 *
 * The controller keeps only in-memory pixel positions/targets; the persisted
 * switch lives in LayoutPreferences so the feature remains device-level, not
 * per-entity. It is deterministic enough for tests via injectable time/random,
 * but cheap enough for the wallpaper draw loop (O(entityCount), no allocations
 * beyond the returned position list).
 */
class WallpaperWanderController(
    private val speedPxPerSecond: Float = DEFAULT_SPEED_PX_PER_SECOND,
    private val random: Random = Random.Default
) {
    private data class WanderState(
        var x: Float,
        var y: Float,
        var targetX: Float,
        var targetY: Float,
        var lastUpdateMs: Long,
        var idleUntilMs: Long,
        var retargetAtMs: Long,
        var moving: Boolean
    )

    private val states = mutableMapOf<Int, WanderState>()

    fun reset() {
        states.clear()
    }

    fun isWalking(entityId: Int): Boolean = states[entityId]?.moving == true

    fun positionsFor(
        basePositions: List<Pair<Float, Float>>,
        entities: List<EntityStatus>,
        width: Float,
        height: Float,
        enabled: Boolean,
        nowMs: Long = System.currentTimeMillis()
    ): List<Pair<Float, Float>> {
        if (!enabled || width <= 0f || height <= 0f) {
            states.clear()
            return basePositions
        }

        val activeIds = entities.map { it.entityId }.toSet()
        states.keys.toList().forEach { id -> if (id !in activeIds) states.remove(id) }

        return entities.mapIndexed { index, entity ->
            val base = basePositions.getOrNull(index) ?: (width / 2f to height / 2f)
            if (entity.state == CharacterState.SLEEPING) {
                val state = stateFor(entity.entityId, base, width, height, nowMs)
                state.moving = false
                state.x to state.y
            } else {
                advance(entity.entityId, base, width, height, nowMs)
            }
        }
    }

    private fun advance(
        entityId: Int,
        base: Pair<Float, Float>,
        width: Float,
        height: Float,
        nowMs: Long
    ): Pair<Float, Float> {
        val state = stateFor(entityId, base, width, height, nowMs)
        val dtSeconds = ((nowMs - state.lastUpdateMs).coerceIn(0L, 1000L)) / 1000f
        state.lastUpdateMs = nowMs

        if (nowMs < state.idleUntilMs) {
            state.moving = false
            return state.x to state.y
        }

        if (nowMs >= state.retargetAtMs) {
            retarget(state, width, height, nowMs)
        }

        val dx = state.targetX - state.x
        val dy = state.targetY - state.y
        val distance = hypot(dx, dy)
        val step = speedPxPerSecond * dtSeconds

        if (distance <= step || distance < ARRIVAL_EPSILON_PX) {
            state.x = state.targetX
            state.y = state.targetY
            state.moving = false
            state.idleUntilMs = nowMs + randomLong(0L, MAX_IDLE_MS)
            retarget(state, width, height, state.idleUntilMs)
        } else if (step > 0f) {
            state.x += dx / distance * step
            state.y += dy / distance * step
            state.moving = true
        }

        state.x = state.x.coerceIn(minX(width), maxX(width))
        state.y = state.y.coerceIn(minY(height), maxY(height))
        return state.x to state.y
    }

    private fun stateFor(
        entityId: Int,
        base: Pair<Float, Float>,
        width: Float,
        height: Float,
        nowMs: Long
    ): WanderState {
        return states.getOrPut(entityId) {
            val x = base.first.coerceIn(minX(width), maxX(width))
            val y = base.second.coerceIn(minY(height), maxY(height))
            val target = randomTarget(width, height)
            WanderState(
                x = x,
                y = y,
                targetX = target.first,
                targetY = target.second,
                lastUpdateMs = nowMs,
                idleUntilMs = nowMs + randomLong(0L, MAX_IDLE_MS),
                retargetAtMs = nowMs + randomLong(MIN_RETARGET_MS, MAX_RETARGET_MS),
                moving = false
            )
        }
    }

    private fun retarget(state: WanderState, width: Float, height: Float, fromMs: Long) {
        val target = randomTarget(width, height)
        state.targetX = target.first
        state.targetY = target.second
        state.retargetAtMs = fromMs + randomLong(MIN_RETARGET_MS, MAX_RETARGET_MS)
    }

    private fun randomTarget(width: Float, height: Float): Pair<Float, Float> {
        return randomFloat(minX(width), maxX(width)) to randomFloat(minY(height), maxY(height))
    }

    private fun randomFloat(min: Float, max: Float): Float {
        if (max <= min) return min
        return min + random.nextFloat() * (max - min)
    }

    private fun randomLong(min: Long, max: Long): Long {
        if (max <= min) return min
        return min + random.nextLong(max - min + 1)
    }

    private fun minX(width: Float): Float = width * 0.08f
    private fun maxX(width: Float): Float = width * 0.92f
    private fun minY(height: Float): Float = height * 0.12f
    private fun maxY(height: Float): Float = height * 0.82f

    companion object {
        const val DEFAULT_SPEED_PX_PER_SECOND = 10f
        private const val ARRIVAL_EPSILON_PX = 1f
        private const val MAX_IDLE_MS = 3000L
        private const val MIN_RETARGET_MS = 3000L
        private const val MAX_RETARGET_MS = 8000L
        const val WALKING_STATE_ASSET = "WALKING"
    }
}
