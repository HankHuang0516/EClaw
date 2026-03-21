package com.hank.clawlive.data.model

/**
 * Status for a single entity in multi-entity mode.
 * Similar to AgentStatus but includes entityId.
 */
data class EntityStatus(
    val entityId: Int = 0,
    val name: String? = null,
    val character: String = "LOBSTER",
    val state: CharacterState = CharacterState.IDLE,
    val message: String = "Loading...",
    val parts: Map<String, Any>? = null,
    val lastUpdated: Long = System.currentTimeMillis(),
    val isBound: Boolean = false,
    val usage: UsageInfo? = null,
    val messageQueue: List<MessageQueueItem>? = null,
    val botSecret: String? = null,  // For bot polling API calls
    val avatar: String? = null,  // User-chosen emoji avatar (synced from server)
    val xp: Int = 0,
    val level: Int = 1,
    val publicCode: String? = null,  // Cross-device messaging code
    val bindingType: String? = null,  // "channel" = OpenClaw channel plugin, null = direct binding
    val encryptionStatus: String? = null  // "e2ee" | "transport" | null (Issue #212)
) {
    // All characters are now LOBSTER type (PIG removed)
    val baseShape: CharacterType
        get() = CharacterType.LOBSTER

    /**
     * Convert to legacy AgentStatus for backward compatibility
     */
    fun toAgentStatus(): AgentStatus = AgentStatus(
        name = name,
        character = character,
        state = state,
        message = message,
        parts = parts,
        lastUpdated = lastUpdated,
        usage = usage,
        messageQueue = messageQueue,
        botSecret = botSecret
    )

    companion object {
        /**
         * Create EntityStatus from AgentStatus
         */
        fun fromAgentStatus(agentStatus: AgentStatus, entityId: Int = 0): EntityStatus = EntityStatus(
            entityId = entityId,
            name = agentStatus.name,
            character = agentStatus.character,
            state = agentStatus.state,
            message = agentStatus.message,
            parts = agentStatus.parts,
            lastUpdated = agentStatus.lastUpdated,
            isBound = agentStatus.isBound,
            usage = agentStatus.usage,
            messageQueue = agentStatus.messageQueue,
            botSecret = agentStatus.botSecret
        )
    }
}

/**
 * Message queue item from entity broadcasts
 */
data class MessageQueueItem(
    val text: String?,
    val from: String,
    val fromEntityId: Int,
    val fromCharacter: String,
    val timestamp: Long,
    val read: Boolean = false,
    val delivered: Boolean = false
)
