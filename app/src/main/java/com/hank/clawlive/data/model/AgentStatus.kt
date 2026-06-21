package com.hank.clawlive.data.model

import java.util.Locale

data class AgentStatus(
    val name: String? = null,
    val character: String = "LOBSTER",
    val state: CharacterState = CharacterState.IDLE,
    val message: String = "Loading...",
    val parts: Map<String, Any>? = null,
    val lastUpdated: Long = System.currentTimeMillis(),
    val isBound: Boolean = false,
    val usage: UsageInfo? = null,
    val messageQueue: List<MessageQueueItem>? = null,
    val botSecret: String? = null,
    val healthChecking: Boolean = false,  // true while passive health-check/repair runs (held visible >=4.5s)
    val healthCheckingAt: Long? = null  // epoch ms the health-check flag was set (server-provided)
) {
    // All characters are now LOBSTER type (PIG removed)
    val baseShape: CharacterType
        get() = CharacterType.LOBSTER
}

enum class CharacterType {
    LOBSTER
}

enum class CharacterState(
    val serverValue: String,
    val wallpaperActionKey: String,
    val pausesAmbientWander: Boolean = false,
    val canUseAmbientWalkingAnimation: Boolean = false,
    val busyLike: Boolean = false,
    val excitedLike: Boolean = false
) {
    IDLE(
        serverValue = "IDLE",
        wallpaperActionKey = "idle",
        canUseAmbientWalkingAnimation = true
    ),
    BUSY(
        serverValue = "BUSY",
        wallpaperActionKey = "running",
        busyLike = true
    ),
    EATING(
        serverValue = "EATING",
        wallpaperActionKey = "idle"
    ),
    SLEEPING(
        serverValue = "SLEEPING",
        wallpaperActionKey = "waiting",
        pausesAmbientWander = true
    ),
    EXCITED(
        serverValue = "EXCITED",
        wallpaperActionKey = "jumping",
        excitedLike = true
    ),
    HAPPY(
        serverValue = "HAPPY",
        wallpaperActionKey = "waving",
        excitedLike = true
    ),
    WALKING(
        serverValue = "WALKING",
        wallpaperActionKey = "running-right",
        busyLike = true
    ),
    RUNNING(
        serverValue = "running",
        wallpaperActionKey = "running",
        busyLike = true
    ),
    RUNNING_RIGHT(
        serverValue = "running-right",
        wallpaperActionKey = "running-right",
        busyLike = true
    ),
    RUNNING_LEFT(
        serverValue = "running-left",
        wallpaperActionKey = "running-left",
        busyLike = true
    ),
    WAVING(
        serverValue = "waving",
        wallpaperActionKey = "waving",
        pausesAmbientWander = true,
        excitedLike = true
    ),
    JUMPING(
        serverValue = "jumping",
        wallpaperActionKey = "jumping",
        pausesAmbientWander = true,
        excitedLike = true
    ),
    FAILED(
        serverValue = "failed",
        wallpaperActionKey = "failed",
        pausesAmbientWander = true
    ),
    WAITING(
        serverValue = "waiting",
        wallpaperActionKey = "waiting",
        pausesAmbientWander = true
    ),
    REVIEW(
        serverValue = "review",
        wallpaperActionKey = "review",
        pausesAmbientWander = true
    );

    val usesDirectionalPetdexRow: Boolean
        get() = this == RUNNING_LEFT || this == RUNNING_RIGHT

    companion object {
        val petdexActionKeys: Set<String> = setOf(
            "idle",
            "running-right",
            "running-left",
            "waving",
            "jumping",
            "failed",
            "waiting",
            "running",
            "review"
        )

        fun fromWireValue(raw: String?): CharacterState {
            val value = raw?.trim()?.takeIf { it.isNotEmpty() } ?: return IDLE
            return when (value.lowercase(Locale.US).replace('_', '-')) {
                "idle" -> IDLE
                "busy" -> BUSY
                "eating" -> EATING
                "sleeping", "sleep" -> SLEEPING
                "excited" -> EXCITED
                "happy" -> HAPPY
                "walking", "walk" -> WALKING
                "running", "run" -> RUNNING
                "running-right", "run-right" -> RUNNING_RIGHT
                "running-left", "run-left" -> RUNNING_LEFT
                "waving", "wave" -> WAVING
                "jumping", "jump" -> JUMPING
                "failed", "fail" -> FAILED
                "waiting", "wait" -> WAITING
                "review", "reviewing" -> REVIEW
                else -> IDLE
            }
        }
    }
}
