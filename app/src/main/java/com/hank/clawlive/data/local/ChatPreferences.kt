package com.hank.clawlive.data.local

import android.content.Context
import android.content.SharedPreferences

/**
 * Manages chat-related preferences for widget display
 */
class ChatPreferences private constructor(context: Context) {

    private val prefs: SharedPreferences = context.getSharedPreferences(
        PREFS_NAME, Context.MODE_PRIVATE
    )

    /**
     * Last sent message text
     */
    var lastMessage: String?
        get() = prefs.getString(KEY_LAST_MESSAGE, null)
        set(value) {
            prefs.edit().putString(KEY_LAST_MESSAGE, value).apply()
        }

    /**
     * Timestamp of last sent message
     */
    var lastMessageTimestamp: Long
        get() = prefs.getLong(KEY_LAST_TIMESTAMP, 0L)
        set(value) {
            prefs.edit().putLong(KEY_LAST_TIMESTAMP, value).apply()
        }

    /**
     * Entity IDs the last message was sent to (comma-separated)
     */
    var lastMessageEntityIds: String?
        get() = prefs.getString(KEY_LAST_ENTITY_IDS, null)
        set(value) {
            prefs.edit().putString(KEY_LAST_ENTITY_IDS, value).apply()
        }

    /**
     * Save message with metadata
     */
    fun saveLastMessage(message: String, entityIds: List<Int>) {
        lastMessage = message
        lastMessageTimestamp = System.currentTimeMillis()
        lastMessageEntityIds = entityIds.joinToString(",")
    }

    /**
     * Get formatted display text for widget
     */
    fun getWidgetDisplayText(): String {
        val msg = lastMessage
        return if (msg.isNullOrEmpty()) {
            DEFAULT_PLACEHOLDER
        } else {
            if (msg.length > 40) msg.take(37) + "..." else msg
        }
    }

    /**
     * Clear chat history
     */
    fun clear() {
        prefs.edit()
            .remove(KEY_LAST_MESSAGE)
            .remove(KEY_LAST_TIMESTAMP)
            .remove(KEY_LAST_ENTITY_IDS)
            .apply()
    }

    /**
     * Unsent draft for AI chat input
     */
    var aiChatDraft: String?
        get() = prefs.getString(KEY_AI_CHAT_DRAFT, null)
        set(value) {
            if (value.isNullOrEmpty()) prefs.edit().remove(KEY_AI_CHAT_DRAFT).apply()
            else prefs.edit().putString(KEY_AI_CHAT_DRAFT, value).apply()
        }

    companion object {
        private const val PREFS_NAME = "chat_prefs"
        private const val KEY_LAST_MESSAGE = "last_message"
        private const val KEY_LAST_TIMESTAMP = "last_timestamp"
        private const val KEY_LAST_ENTITY_IDS = "last_entity_ids"
        private const val KEY_AI_CHAT_DRAFT = "ai_chat_draft"
        const val DEFAULT_PLACEHOLDER = "Tap to chat with entities..."

        @Volatile
        private var instance: ChatPreferences? = null

        fun getInstance(context: Context): ChatPreferences {
            return instance ?: synchronized(this) {
                instance ?: ChatPreferences(context.applicationContext).also { instance = it }
            }
        }
    }
}
