package com.hank.clawlive.data.local.database

import androidx.room.Entity
import androidx.room.PrimaryKey

/**
 * Message types for chat history display
 */
enum class MessageType {
    USER_TO_ENTITY,      // User sends to single entity (RIGHT side)
    USER_BROADCAST,      // User sends to multiple entities (RIGHT side)
    ENTITY_RESPONSE,      // Entity's message from /api/status (LEFT side)
    ENTITY_TO_ENTITY,    // source = "entity:{ID}:{CHARACTER}" (LEFT side)
    ENTITY_BROADCAST     // Entity broadcast via messageQueue (LEFT side)
}

/**
 * Chat message entity for Room database
 */
@Entity(tableName = "chat_messages")
data class ChatMessage(
    @PrimaryKey(autoGenerate = true)
    val id: Long = 0,

    /** Message text content */
    val text: String,

    /** Timestamp in milliseconds */
    val timestamp: Long = System.currentTimeMillis(),

    /** true = RIGHT side (user sent), false = LEFT side (received from entity) */
    val isFromUser: Boolean,

    /** Message type for categorization */
    val messageType: MessageType,

    /** For user messages: source identifier (android_widget, android_main, etc.) */
    val source: String? = null,

    /** For user messages: target entity IDs (comma-separated for broadcast, e.g., "0,1,2") */
    val targetEntityIds: String? = null,

    /** For entity messages: which entity sent it (0-3) */
    val fromEntityId: Int? = null,

    /** For entity messages: entity name */
    val fromEntityName: String? = null,

    /** For entity messages: entity character type (LOBSTER, PIG, etc.) */
    val fromEntityCharacter: String? = null,

    /** Deduplication key: entityId + messageHash + timestampBucket */
    val deduplicationKey: String? = null,

    /** true after API confirms message was sent successfully */
    val isSynced: Boolean = true,

    /** true when push notification was delivered to bot(s) */
    val isDelivered: Boolean = false,

    /** Which entity IDs confirmed delivery (comma-separated, e.g., "0,1") */
    val deliveredTo: String? = null,

    /** Media type: null (text-only), "photo", "voice" */
    val mediaType: String? = null,

    /** Media URL: Flickr URL for photos, base64 data URI for voice */
    val mediaUrl: String? = null,

    /** Schedule label when source='scheduled' (from schedule_label field) */
    val scheduleLabel: String? = null
) {
    /**
     * Get display name for the message sender
     */
    fun getSenderDisplayName(): String {
        return if (isFromUser) {
            "You"
        } else {
            fromEntityName ?: "Entity #$fromEntityId"
        }
    }

    /**
     * Get target entity IDs as a list
     */
    fun getTargetEntityIdList(): List<Int> {
        return targetEntityIds?.split(",")?.mapNotNull { it.trim().toIntOrNull() } ?: emptyList()
    }
}
