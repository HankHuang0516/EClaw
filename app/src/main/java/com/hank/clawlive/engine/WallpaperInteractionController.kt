package com.hank.clawlive.engine

import com.hank.clawlive.data.model.CharacterState
import com.hank.clawlive.data.model.EntityStatus
import kotlin.math.PI
import kotlin.math.hypot
import kotlin.math.min
import kotlin.math.sin

class WallpaperInteractionController(
    private val collisionDistancePct: Float = DEFAULT_COLLISION_DISTANCE_PCT,
    private val cooldownMs: Long = DEFAULT_COOLDOWN_MS,
    private val effectDurationMs: Long = DEFAULT_EFFECT_DURATION_MS
) {
    enum class InteractionKind {
        GREETING,
        SPARK,
        BUMP
    }

    data class InteractionEffect(
        val firstEntityId: Int,
        val secondEntityId: Int,
        val kind: InteractionKind,
        val centerX: Float,
        val centerY: Float,
        val startedAtMs: Long,
        val expiresAtMs: Long
    ) {
        fun progress(nowMs: Long): Float {
            val duration = (expiresAtMs - startedAtMs).coerceAtLeast(1L)
            return ((nowMs - startedAtMs).toFloat() / duration.toFloat()).coerceIn(0f, 1f)
        }

        fun alpha(nowMs: Long): Float {
            return sin((progress(nowMs) * PI).toFloat()).coerceIn(0f, 1f)
        }

        fun scale(nowMs: Long): Float {
            return 0.8f + 0.35f * alpha(nowMs)
        }

        val label: String
            get() = when (kind) {
                InteractionKind.GREETING -> "hi"
                InteractionKind.SPARK -> "*"
                InteractionKind.BUMP -> "!"
            }
    }

    data class RenderState(
        val positions: List<Pair<Float, Float>>,
        val effects: List<InteractionEffect>,
        val posesByEntity: Map<Int, InteractionPose> = emptyMap(),
        val actionStatesByEntity: Map<Int, CharacterState> = emptyMap()
    )

    data class InteractionPose(
        val liftPx: Float = 0f,
        val facingDirection: WalkFacingDirection? = null
    )

    private data class PairKey(val first: Int, val second: Int) {
        companion object {
            fun of(a: Int, b: Int): PairKey {
                return if (a <= b) PairKey(a, b) else PairKey(b, a)
            }
        }
    }

    private data class ActiveInteraction(
        val key: PairKey,
        val kind: InteractionKind,
        val actionState: CharacterState,
        val unitX: Float,
        val unitY: Float,
        val startedAtMs: Long,
        val expiresAtMs: Long
    )

    private val active = mutableMapOf<PairKey, ActiveInteraction>()
    private val lastTriggeredAt = mutableMapOf<PairKey, Long>()

    fun reset() {
        active.clear()
        lastTriggeredAt.clear()
    }

    fun apply(
        positions: List<Pair<Float, Float>>,
        entities: List<EntityStatus>,
        width: Float,
        height: Float,
        enabled: Boolean,
        nowMs: Long,
        reactionDurationMs: Long = effectDurationMs
    ): RenderState {
        if (!enabled || width <= 0f || height <= 0f || positions.size < 2 || entities.size < 2) {
            active.clear()
            return RenderState(positions, emptyList())
        }

        val entityIds = entities.map { it.entityId }.toSet()
        val sleepingIds = entities.filter { it.state.pausesAmbientWander }.map { it.entityId }.toSet()
        active.keys.toList().forEach { key ->
            val expired = active[key]?.expiresAtMs?.let { nowMs >= it } ?: true
            val missing = key.first !in entityIds || key.second !in entityIds
            val sleeping = key.first in sleepingIds || key.second in sleepingIds
            if (expired || missing || sleeping) active.remove(key)
        }

        detectCollisions(positions, entities, width, height, nowMs, sleepingIds, reactionDurationMs)

        val indexById = entities.mapIndexed { index, entity -> entity.entityId to index }.toMap()
        val adjusted = positions.toMutableList()
        val posesByEntity = mutableMapOf<Int, InteractionPose>()
        val actionStatesByEntity = mutableMapOf<Int, CharacterState>()
        active.values.forEach { interaction ->
            val firstIndex = indexById[interaction.key.first] ?: return@forEach
            val secondIndex = indexById[interaction.key.second] ?: return@forEach
            val progress = interactionProgress(interaction, nowMs)
            val pulse = sin((progress * PI).toFloat()).coerceIn(0f, 1f)
            val bouncePx = min(width, height) * BOUNCE_DISTANCE_PCT * pulse
            val hopPx = min(width, height) * HOP_DISTANCE_PCT * pulse

            adjusted[firstIndex] = adjusted[firstIndex].offset(
                -interaction.unitX * bouncePx,
                -interaction.unitY * bouncePx,
                width,
                height
            )
            adjusted[secondIndex] = adjusted[secondIndex].offset(
                interaction.unitX * bouncePx,
                interaction.unitY * bouncePx,
                width,
                height
            )
            val firstFacing = if (interaction.unitX >= 0f) WalkFacingDirection.RIGHT else WalkFacingDirection.LEFT
            val secondFacing = if (interaction.unitX >= 0f) WalkFacingDirection.LEFT else WalkFacingDirection.RIGHT
            posesByEntity[interaction.key.first] = posesByEntity[interaction.key.first].merge(
                InteractionPose(liftPx = hopPx, facingDirection = firstFacing)
            )
            posesByEntity[interaction.key.second] = posesByEntity[interaction.key.second].merge(
                InteractionPose(liftPx = hopPx, facingDirection = secondFacing)
            )
            actionStatesByEntity[interaction.key.first] = interaction.actionState
            actionStatesByEntity[interaction.key.second] = interaction.actionState
        }

        val effects = active.values.mapNotNull { interaction ->
            val firstIndex = indexById[interaction.key.first] ?: return@mapNotNull null
            val secondIndex = indexById[interaction.key.second] ?: return@mapNotNull null
            val first = adjusted[firstIndex]
            val second = adjusted[secondIndex]
            InteractionEffect(
                firstEntityId = interaction.key.first,
                secondEntityId = interaction.key.second,
                kind = interaction.kind,
                centerX = (first.first + second.first) / 2f,
                centerY = (first.second + second.second) / 2f - min(width, height) * EFFECT_FLOAT_PCT,
                startedAtMs = interaction.startedAtMs,
                expiresAtMs = interaction.expiresAtMs
            )
        }

        return RenderState(adjusted, effects, posesByEntity, actionStatesByEntity)
    }

    private fun detectCollisions(
        positions: List<Pair<Float, Float>>,
        entities: List<EntityStatus>,
        width: Float,
        height: Float,
        nowMs: Long,
        sleepingIds: Set<Int>,
        reactionDurationMs: Long
    ) {
        val collisionDistancePx = min(width, height) * collisionDistancePct
        val durationMs = reactionDurationMs.coerceIn(MIN_REACTION_DURATION_MS, MAX_REACTION_DURATION_MS)
        for (i in 0 until minOf(entities.size, positions.size)) {
            val first = entities[i]
            if (first.entityId in sleepingIds) continue
            for (j in i + 1 until minOf(entities.size, positions.size)) {
                val second = entities[j]
                if (second.entityId in sleepingIds) continue
                val key = PairKey.of(first.entityId, second.entityId)
                if (active.containsKey(key)) continue
                val last = lastTriggeredAt[key]
                if (last != null && nowMs - last < cooldownMs) continue

                val firstPos = positions[i]
                val secondPos = positions[j]
                val dx = secondPos.first - firstPos.first
                val dy = secondPos.second - firstPos.second
                val distance = hypot(dx, dy)
                if (distance > collisionDistancePx) continue

                val safeDistance = distance.coerceAtLeast(1f)
                val unitX = if (distance < 1f) {
                    if (first.entityId <= second.entityId) 1f else -1f
                } else {
                    dx / safeDistance
                }
                val unitY = if (distance < 1f) 0f else dy / safeDistance
                val interaction = ActiveInteraction(
                    key = key,
                    kind = kindFor(key, nowMs),
                    actionState = actionFor(key, nowMs),
                    unitX = unitX,
                    unitY = unitY,
                    startedAtMs = nowMs,
                    expiresAtMs = nowMs + durationMs
                )
                active[key] = interaction
                lastTriggeredAt[key] = nowMs
            }
        }
    }

    private fun kindFor(key: PairKey, nowMs: Long): InteractionKind {
        return when (((key.first * 31) + (key.second * 17) + (nowMs / cooldownMs).toInt()) % 3) {
            0 -> InteractionKind.GREETING
            1 -> InteractionKind.SPARK
            else -> InteractionKind.BUMP
        }
    }

    private fun actionFor(key: PairKey, nowMs: Long): CharacterState {
        val index = (((key.first * 37) + (key.second * 19) + (nowMs / cooldownMs).toInt()) %
            REACTION_ACTIONS.size).let { if (it < 0) it + REACTION_ACTIONS.size else it }
        return REACTION_ACTIONS[index]
    }

    private fun interactionProgress(interaction: ActiveInteraction, nowMs: Long): Float {
        val duration = (interaction.expiresAtMs - interaction.startedAtMs).coerceAtLeast(1L)
        return ((nowMs - interaction.startedAtMs).toFloat() / duration.toFloat()).coerceIn(0f, 1f)
    }

    private fun Pair<Float, Float>.offset(dx: Float, dy: Float, width: Float, height: Float): Pair<Float, Float> {
        return (first + dx).coerceIn(0f, width) to (second + dy).coerceIn(0f, height)
    }

    private fun InteractionPose?.merge(other: InteractionPose): InteractionPose {
        if (this == null) return other
        return InteractionPose(
            liftPx = maxOf(liftPx, other.liftPx),
            facingDirection = other.facingDirection ?: facingDirection
        )
    }

    companion object {
        private const val DEFAULT_COLLISION_DISTANCE_PCT = 0.12f
        private const val DEFAULT_COOLDOWN_MS = 8_000L
        private const val DEFAULT_EFFECT_DURATION_MS = 1_200L
        private const val BOUNCE_DISTANCE_PCT = 0.035f
        private const val HOP_DISTANCE_PCT = 0.025f
        private const val EFFECT_FLOAT_PCT = 0.06f
        private const val MIN_REACTION_DURATION_MS = 1_000L
        private const val MAX_REACTION_DURATION_MS = 20_000L
        private val REACTION_ACTIONS = listOf(
            CharacterState.WAVING,
            CharacterState.JUMPING,
            CharacterState.FAILED,
            CharacterState.REVIEW
        )
    }
}
