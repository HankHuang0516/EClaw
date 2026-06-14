package com.hank.clawlive.data.model

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

enum class CharacterState {
    IDLE,       // Default state
    BUSY,       // Working on something
    EATING,     // Eating noodles/food
    SLEEPING,   // Night time or inactive
    EXCITED     // New task or user interaction
}
