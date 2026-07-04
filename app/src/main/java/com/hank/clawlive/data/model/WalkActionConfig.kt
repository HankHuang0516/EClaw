package com.hank.clawlive.data.model

import java.util.Locale

data class WalkActionConfigResponse(
    val success: Boolean = false,
    val entityId: Int? = null,
    val weights: Map<String, Float> = emptyMap(),
    val allowNegative: Boolean = false,
    val negativeActions: List<String> = emptyList(),
    val error: String? = null
) {
    fun toConfig(): WalkActionConfig = WalkActionConfig(
        weights = weights,
        allowNegative = allowNegative,
        negativeActions = negativeActions
    )
}

data class WalkActionConfig(
    val weights: Map<String, Float> = emptyMap(),
    val allowNegative: Boolean = false,
    val negativeActions: List<String> = emptyList()
) {
    fun weightedActionKeys(): List<Pair<String, Float>> {
        val source = if (weights.isEmpty()) {
            DEFAULT_NEUTRAL_ACTIONS.associateWith { 1f }
        } else {
            weights
        }
        val negativeSet = effectiveNegativeActions().map { canonicalNegativeAction(it) }.toSet()
        val aggregate = linkedMapOf<String, Float>()

        source.forEach { (rawAction, rawWeight) ->
            val weight = rawWeight
                .takeIf { !it.isNaN() && !it.isInfinite() && it > 0f }
                ?.coerceAtMost(MAX_WEIGHT)
                ?: return@forEach
            if (!allowNegative && canonicalNegativeAction(rawAction) in negativeSet) {
                return@forEach
            }
            val actionKey = wallpaperActionKey(rawAction) ?: return@forEach
            aggregate[actionKey] = (aggregate[actionKey] ?: 0f) + weight
        }

        return aggregate.map { it.key to it.value }.ifEmpty {
            DEFAULT_NEUTRAL_ACTIONS.mapNotNull { action ->
                wallpaperActionKey(action)?.let { it to 1f }
            }
        }
    }

    private fun effectiveNegativeActions(): List<String> {
        return negativeActions.ifEmpty { DEFAULT_NEGATIVE_ACTIONS }
    }

    companion object {
        val DEFAULT_NEUTRAL_ACTIONS = listOf("idle", "walk", "sit", "look", "sleep", "eat")
        val DEFAULT_NEGATIVE_ACTIONS = listOf("fail", "sad", "sick", "angry")
        private const val MAX_WEIGHT = 1000f

        fun wallpaperActionKey(raw: String?): String? {
            val key = canonicalAction(raw) ?: return null
            return when (key) {
                "walk", "walking" -> "running"
                "run" -> "running"
                "run-right" -> "running-right"
                "run-left" -> "running-left"
                "wave" -> "waving"
                "jump" -> "jumping"
                "fail", "failure" -> "failed"
                "sleep" -> "waiting"
                else -> key
            }
        }

        private fun canonicalNegativeAction(raw: String?): String? {
            return when (wallpaperActionKey(raw)) {
                "failed" -> "fail"
                else -> canonicalAction(raw)
            }
        }

        private fun canonicalAction(raw: String?): String? {
            val key = raw
                ?.trim()
                ?.lowercase(Locale.US)
                ?.replace('_', '-')
                ?.takeIf { it.isNotBlank() }
                ?: return null
            return key
        }
    }
}
