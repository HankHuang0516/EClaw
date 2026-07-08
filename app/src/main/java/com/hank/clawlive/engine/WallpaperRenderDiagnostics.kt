package com.hank.clawlive.engine

/**
 * Lightweight, in-memory feedback loop for the live wallpaper renderer.
 *
 * It intentionally records only counts and entity ids. No message text, tokens,
 * URLs, or device identifiers are stored here.
 */
class WallpaperRenderDiagnostics(
    private val reduceEffectsThreshold: Int = DEFAULT_REDUCE_EFFECTS_THRESHOLD
) {
    enum class CompanionDrawOutcome {
        DRAWN,
        LOADING,
        UNSUPPORTED,
        ERROR
    }

    data class Snapshot(
        val framesDrawn: Int,
        val lastWalkingEntityCount: Int,
        val lastActiveBubbleCount: Int,
        val spritesheetUnsupportedByEntity: Map<Int, Int>,
        val spritesheetErrorsByEntity: Map<Int, Int>,
        val reducedEffectsEntityIds: Set<Int>
    )

    private var framesDrawn = 0
    private var lastWalkingEntityCount = 0
    private var lastActiveBubbleCount = 0
    private val unsupportedByEntity = mutableMapOf<Int, Int>()
    private val errorsByEntity = mutableMapOf<Int, Int>()

    fun recordFrame(walkingEntityCount: Int, activeBubbleCount: Int) {
        framesDrawn += 1
        lastWalkingEntityCount = walkingEntityCount.coerceAtLeast(0)
        lastActiveBubbleCount = activeBubbleCount.coerceAtLeast(0)
    }

    fun recordCompanionDraw(entityId: Int, outcome: CompanionDrawOutcome) {
        when (outcome) {
            CompanionDrawOutcome.DRAWN -> clearEntity(entityId)
            CompanionDrawOutcome.LOADING -> Unit
            CompanionDrawOutcome.UNSUPPORTED -> {
                unsupportedByEntity[entityId] = (unsupportedByEntity[entityId] ?: 0) + 1
            }
            CompanionDrawOutcome.ERROR -> {
                errorsByEntity[entityId] = (errorsByEntity[entityId] ?: 0) + 1
            }
        }
    }

    fun shouldReduceEffects(entityId: Int): Boolean {
        return ((unsupportedByEntity[entityId] ?: 0) + (errorsByEntity[entityId] ?: 0)) >= reduceEffectsThreshold
    }

    fun snapshot(): Snapshot {
        val reduced = (unsupportedByEntity.keys + errorsByEntity.keys)
            .filter { shouldReduceEffects(it) }
            .toSet()
        return Snapshot(
            framesDrawn = framesDrawn,
            lastWalkingEntityCount = lastWalkingEntityCount,
            lastActiveBubbleCount = lastActiveBubbleCount,
            spritesheetUnsupportedByEntity = unsupportedByEntity.toMap(),
            spritesheetErrorsByEntity = errorsByEntity.toMap(),
            reducedEffectsEntityIds = reduced
        )
    }

    private fun clearEntity(entityId: Int) {
        unsupportedByEntity.remove(entityId)
        errorsByEntity.remove(entityId)
    }

    companion object {
        const val DEFAULT_REDUCE_EFFECTS_THRESHOLD = 3
    }
}
