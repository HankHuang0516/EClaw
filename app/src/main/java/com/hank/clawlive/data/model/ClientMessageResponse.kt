package com.hank.clawlive.data.model

/**
 * Response from /api/client/speak endpoint
 * Includes push notification status for each target entity
 */
data class ClientMessageResponse(
    val success: Boolean,
    val message: String,
    val targets: List<MessageTarget> = emptyList(),
    val broadcast: Boolean = false,
    val source: String? = null,
    val command: String? = null,
    val needsConfirmation: Boolean = false,
    val confirmCommand: String? = null
)

data class MessageTarget(
    val entityId: Int,
    val pushed: Boolean,
    val mode: String, // "push" or "polling"
    val reason: String? = null, // "ok", "no_webhook", "push_failed", etc.
    val bindingType: String? = null // "free", "personal", or null (custom)
)
