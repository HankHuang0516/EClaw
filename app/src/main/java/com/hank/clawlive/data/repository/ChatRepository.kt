package com.hank.clawlive.data.repository

import android.content.Context
import com.hank.clawlive.data.local.database.ChatDatabase
import com.hank.clawlive.data.local.database.ChatMessage
import com.hank.clawlive.data.local.database.ChatMessageDao
import com.hank.clawlive.data.local.database.MessageType
import com.hank.clawlive.data.model.EntityStatus
import com.hank.clawlive.data.remote.ChatHistoryMessage
import com.hank.clawlive.data.remote.ClawApiService
import kotlinx.coroutines.flow.Flow
import timber.log.Timber
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone

/**
 * Repository for managing chat message history
 */
class ChatRepository private constructor(
    private val chatDao: ChatMessageDao
) {
    companion object {
        @Volatile
        private var INSTANCE: ChatRepository? = null

        fun getInstance(context: Context): ChatRepository {
            return INSTANCE ?: synchronized(this) {
                INSTANCE ?: ChatRepository(
                    ChatDatabase.getDao(context)
                ).also { INSTANCE = it }
            }
        }

        /** Deduplication time window in milliseconds (5 minutes) */
        private const val DEDUP_WINDOW_MS = 5 * 60 * 1000L

        /** If local DB has fewer than this many messages, trigger a full cloud sync */
        private const val FULL_SYNC_THRESHOLD = 5
    }

    // ===== Message Flows for UI =====

    /**
     * Get all messages (newest first) as Flow
     */
    fun getRecentMessages(limit: Int = 100): Flow<List<ChatMessage>> {
        return chatDao.getRecentMessages(limit)
    }

    /**
     * Get messages in ascending order (oldest first) for chat display
     */
    fun getMessagesAscending(limit: Int = 500): Flow<List<ChatMessage>> {
        return chatDao.getMessagesAscending(limit)
    }

    /**
     * Get messages for a specific entity
     */
    fun getMessagesForEntity(entityId: Int, limit: Int = 50): Flow<List<ChatMessage>> {
        return chatDao.getMessagesForEntity(entityId, limit)
    }

    /**
     * Get only user-sent messages
     */
    fun getUserMessages(limit: Int = 50): Flow<List<ChatMessage>> {
        return chatDao.getUserMessages(limit)
    }

    /**
     * Get distinct entity IDs that have messages (for smart filter chips)
     */
    fun getDistinctEntityIds(): Flow<List<Int>> {
        return chatDao.getDistinctEntityIds()
    }

    // ===== Outgoing Messages (User -> Entity) =====

    /**
     * Save outgoing user message BEFORE sending to API
     * Returns the inserted message ID for tracking sync status
     */
    suspend fun saveOutgoingMessage(
        text: String,
        entityIds: List<Int>,
        source: String = "android_widget",
        mediaType: String? = null,
        mediaUrl: String? = null
    ): Long {
        val messageType = if (entityIds.size > 1) {
            MessageType.USER_BROADCAST
        } else {
            MessageType.USER_TO_ENTITY
        }

        val message = ChatMessage(
            text = text,
            isFromUser = true,
            messageType = messageType,
            source = source,
            targetEntityIds = entityIds.joinToString(","),
            isSynced = false, // Will be marked true after API success
            mediaType = mediaType,
            mediaUrl = mediaUrl
        )

        val id = chatDao.insert(message)
        Timber.d("Saved outgoing message (id=$id): ${text.take(30)}...")
        return id
    }

    /**
     * Mark message as synced after API call succeeds
     */
    suspend fun markMessageSynced(messageId: Long) {
        chatDao.markSynced(messageId)
        Timber.d("Message $messageId marked as synced")
    }

    /**
     * Mark message as delivered with entity IDs that confirmed receipt
     */
    suspend fun markMessageDelivered(messageId: Long, entityIds: List<Int>) {
        val deliveredTo = entityIds.joinToString(",")
        chatDao.markDelivered(messageId, deliveredTo)
        Timber.d("Message $messageId delivered to entities: $deliveredTo")
    }

    // ===== Cross-Device Messages =====

    /**
     * Save outgoing cross-device message for optimistic UI display.
     */
    suspend fun saveCrossDeviceMessage(
        text: String,
        fromPublicCode: String,
        targetPublicCode: String,
        fromCharacter: String? = null
    ): Long {
        val message = ChatMessage(
            text = text,
            isFromUser = true,
            messageType = MessageType.CROSS_DEVICE_SENT,
            fromPublicCode = fromPublicCode,
            targetPublicCode = targetPublicCode,
            fromEntityCharacter = fromCharacter,
            isSynced = false
        )
        val id = chatDao.insert(message)
        Timber.d("Saved cross-device message to $targetPublicCode: ${text.take(30)}...")
        return id
    }

    // ===== Incoming Messages (Entity -> User) =====

    /**
     * Process incoming entity message from status polling
     * Uses deduplication to avoid storing the same message twice
     */
    suspend fun processEntityMessage(entity: EntityStatus) {
        // Skip if message is empty, default, passive state, or system echo
        val passiveMessages = listOf(
            "Loading...",
            "No message",
            "Waiting...",
            "Zzz...",
            "Ready",
            "Idle",
            "Standing by"
        )

        if (entity.message.isBlank() ||
            passiveMessages.any { entity.message.contains(it, ignoreCase = true) } ||
            entity.message.startsWith("Received:") ||       // Backend echo of client message
            entity.message.startsWith("[SYSTEM:")) {         // System markers (WEBHOOK_ERROR, HANDSHAKE_TEST, etc.)
            return
        }

        // Skip all entity-to-entity messages (broadcast + speak-to).
        // Format: "entity:{ID}:{CHAR}: ..." — these are set on RECEIVING entities by the backend.
        // The actual message is already tracked via syncFromBackend() as a single record
        // under the SENDER entity with correct fromEntityId and delivery tracking.
        // Note: must use DOT_MATCHES_ALL because A2A messages can be multi-line.
        if (entity.message.matches(Regex("^entity:\\d+:[^:]+:.*", RegexOption.DOT_MATCHES_ALL))) {
            Timber.d("[A2A_POLL_ENTITY_SKIP] Skipping entity-to-entity msg on Entity${entity.entityId}: ${entity.message.take(60)}")
            return
        }

        // Generate deduplication key: entityId + message hash + timestamp bucket
        val timestampBucket = entity.lastUpdated / DEDUP_WINDOW_MS
        val deduplicationKey = "${entity.entityId}:${entity.message.hashCode()}:$timestampBucket"

        // Check if we already have this message (same dedup key)
        if (chatDao.existsByDeduplicationKey(deduplicationKey)) {
            return
        }

        // Cross-source dedup: also check if syncFromBackend() already stored this message
        // (same text + same entity within the dedup window, but with a different key like "backend_123")
        val (_, cleanedTextForCheck) = parseEntityMessage(entity.message)
        val sinceTimestamp = entity.lastUpdated - DEDUP_WINDOW_MS
        if (chatDao.existsByContentAndEntity(entity.entityId, cleanedTextForCheck, sinceTimestamp)) {
            Timber.d("Skipping duplicate entity message (already synced from backend): Entity ${entity.entityId}")
            return
        }

        // Detect message type based on source pattern
        val (messageType, cleanedText) = parseEntityMessage(entity.message)

        val message = ChatMessage(
            text = cleanedText,
            timestamp = entity.lastUpdated,
            isFromUser = false,
            messageType = messageType,
            fromEntityId = entity.entityId,
            fromEntityName = entity.name,
            fromEntityCharacter = entity.character,
            deduplicationKey = deduplicationKey,
            isSynced = true
        )

        chatDao.insert(message)
        Timber.d("Saved entity message from Entity ${entity.entityId}: ${cleanedText.take(30)}...")

        // Periodically prune old messages to prevent database bloat
        pruneOldMessages()
    }

    /**
     * Parse entity message to detect type and clean up text
     * Pattern for entity-to-entity: "entity:{ID}:{CHARACTER}: {message}"
     */
    private fun parseEntityMessage(message: String): Pair<MessageType, String> {
        // Check for entity-to-entity pattern: "entity:0:LOBSTER: Hello"
        // Use DOT_MATCHES_ALL so .* matches multi-line messages; [^:]+ for any character name
        val entityPattern = Regex("^entity:(\\d+):([^:]+):\\s*(.*)$", RegexOption.DOT_MATCHES_ALL)
        val match = entityPattern.find(message)

        return if (match != null) {
            // Entity-to-entity message
            val actualMessage = match.groupValues[3]
            Pair(MessageType.ENTITY_TO_ENTITY, actualMessage)
        } else {
            // Regular entity response
            Pair(MessageType.ENTITY_RESPONSE, message)
        }
    }

    // ===== Maintenance =====

    /**
     * Get last N messages for widget (async)
     */
    suspend fun getLastMessagesForWidget(limit: Int = 5): List<ChatMessage> {
        return chatDao.getLastMessages(limit)
    }

    /**
     * Get recent messages synchronously for widget (called with runBlocking)
     * Returns messages in descending order (newest first)
     */
    suspend fun getRecentMessagesSync(limit: Int = 5): List<ChatMessage> {
        return chatDao.getLastMessages(limit)
    }

    /**
     * Get total message count
     */
    suspend fun getMessageCount(): Int {
        return chatDao.getMessageCount()
    }

    /**
     * Prune old messages to prevent database bloat
     * Keeps the last 500 messages by default
     */
    suspend fun pruneOldMessages(keepCount: Int = 500) {
        val currentCount = chatDao.getMessageCount()
        if (currentCount > keepCount) {
            chatDao.pruneOldMessages(keepCount)
            Timber.d("Pruned messages: kept last $keepCount of $currentCount")
        }
    }

    /**
     * Clear all messages (for testing/reset)
     */
    suspend fun clearAllMessages() {
        chatDao.clearAll()
        Timber.d("Cleared all chat messages")
    }

    /**
     * Add message queue item (entity broadcast or entity-to-entity) to chat history.
     * When [targetEntityId] is provided and differs from [fromEntityId], the message
     * is treated as an entity-to-entity speak-to (ENTITY_TO_ENTITY type).
     */
    suspend fun addMessageQueueItem(
        text: String,
        fromEntityId: Int,
        fromCharacter: String,
        timestamp: Long,
        targetEntityId: Int? = null
    ) {
        // Create deduplication key
        val deduplicationKey = "mq_${fromEntityId}_${timestamp}"

        // Check if already exists
        if (chatDao.existsByDeduplicationKey(deduplicationKey)) {
            return
        }

        // Determine message type: entity-to-entity speak-to vs broadcast
        val isEntityToEntity = targetEntityId != null && targetEntityId != fromEntityId
        val msgType = if (isEntityToEntity) MessageType.ENTITY_TO_ENTITY else MessageType.ENTITY_BROADCAST
        val targets = if (isEntityToEntity) targetEntityId.toString() else null

        val message = ChatMessage(
            text = text,
            timestamp = timestamp,
            isFromUser = false,
            messageType = msgType,
            fromEntityId = fromEntityId,
            fromEntityCharacter = fromCharacter,
            targetEntityIds = targets,
            deduplicationKey = deduplicationKey,
            isSynced = true
        )

        chatDao.insert(message)
        Timber.d("[A2A_MSG_QUEUE] type=$msgType from=Entity$fromEntityId target=${targets ?: "broadcast"} text=${text.take(60)}")

        pruneOldMessages()
    }

    // ============================================
    // BACKEND CHAT HISTORY SYNC
    // ============================================

    /**
     * Sync messages from backend PostgreSQL chat_messages table into Room DB.
     * This ensures bot responses appear in Chat regardless of wallpaper state.
     * Returns the number of new messages added.
     */
    suspend fun syncFromBackend(messages: List<ChatHistoryMessage>): Int {
        var addedCount = 0

        for (msg in messages) {
            // Generate deduplication key from backend message ID
            val deduplicationKey = "backend_${msg.id}"

            if (chatDao.existsByDeduplicationKey(deduplicationKey)) {
                // Message already exists — but delivery status may have been updated
                // (broadcast pushes are fire-and-forget, so is_delivered may change after initial sync)
                if (msg.is_delivered && !msg.delivered_to.isNullOrBlank()) {
                    chatDao.updateDeliveryByDedupKey(deduplicationKey, true, msg.delivered_to)
                }
                continue
            }

            // Skip user messages that Android already saved locally when sent.
            // Messages from other platforms (web_chat, widget, client) must be synced.
            val androidLocalSources = setOf("android_chat", "android_widget")
            if (msg.is_from_user && msg.source in androidLocalSources) {
                continue
            }

            // Parse timestamp from ISO string
            val timestamp = parseIsoTimestamp(msg.created_at)

            // Cross-source dedup: check if processEntityMessage() already stored this message
            // (same text + same entity within the dedup window, but with a different key format)
            if (!msg.is_from_user && msg.entity_id != null) {
                val sinceTimestamp = timestamp - DEDUP_WINDOW_MS
                if (chatDao.existsByContentAndEntity(msg.entity_id, msg.text, sinceTimestamp)) {
                    // Update backendId AND deduplicationKey so ChatIntegrityValidator can find
                    // this message by its backend key ("backend_${id}") and reactions work.
                    chatDao.setBackendIdByContentMatch(msg.entity_id, msg.text, sinceTimestamp, msg.id, "backend_${msg.id}")
                    Timber.d("[A2A_DEDUP_CROSS] Skipping backend message (already stored from entity polling/mq): entity_id=${msg.entity_id} source=${msg.source} text=${msg.text.take(60)}")
                    continue
                }
            }

            // Detect entity-to-entity pattern: "entity:0:LOBSTER->1" or "entity:0:LOBSTER->1,2,3"
            val entityPattern = Regex("^entity:(\\d+):([^:]+)->(\\S+)$")
            val entityMatch = entityPattern.find(msg.source)

            // Detect cross-device pattern: "xdevice:ABC123:LOBSTER->XYZ789"
            val xdevicePattern = Regex("^xdevice:([A-Za-z0-9]+):([^:]+)->([A-Za-z0-9]+)$")
            val xdeviceMatch = xdevicePattern.find(msg.source)

            val message = if (msg.source == "scheduled") {
                // Scheduled message — user-side but generated by scheduler
                ChatMessage(
                    text = msg.text,
                    timestamp = timestamp,
                    isFromUser = true,
                    messageType = MessageType.USER_TO_ENTITY,
                    source = "scheduled",
                    targetEntityIds = msg.entity_id?.toString(),
                    fromEntityId = msg.entity_id,
                    deduplicationKey = deduplicationKey,
                    isSynced = true,
                    isDelivered = msg.is_delivered,
                    deliveredTo = msg.delivered_to,
                    mediaType = msg.media_type,
                    mediaUrl = msg.media_url,
                    scheduleLabel = msg.schedule_label,
                    likeCount = msg.like_count,
                    dislikeCount = msg.dislike_count,
                    userReaction = msg.user_reaction,
                    backendId = msg.id
                )
            } else if (msg.source.startsWith("mission_notify")) {
                // Mission Control notification - source format: "mission_notify:0,1"
                val targets = msg.source.substringAfter(":", "")
                ChatMessage(
                    text = msg.text,
                    timestamp = timestamp,
                    isFromUser = true,
                    messageType = MessageType.USER_BROADCAST,
                    source = "mission_notify",
                    targetEntityIds = targets.ifEmpty { null },
                    deduplicationKey = deduplicationKey,
                    isSynced = true,
                    isDelivered = msg.is_delivered,
                    deliveredTo = msg.delivered_to,
                    mediaType = msg.media_type,
                    mediaUrl = msg.media_url,
                    likeCount = msg.like_count,
                    dislikeCount = msg.dislike_count,
                    userReaction = msg.user_reaction
                )
            } else if (msg.is_from_user) {
                // User message from another platform (web_chat, widget, client, etc.)
                ChatMessage(
                    text = msg.text,
                    timestamp = timestamp,
                    isFromUser = true,
                    messageType = MessageType.USER_TO_ENTITY,
                    source = msg.source,
                    targetEntityIds = msg.entity_id?.toString(),
                    fromEntityId = msg.entity_id,
                    deduplicationKey = deduplicationKey,
                    isSynced = true,
                    isDelivered = msg.is_delivered,
                    deliveredTo = msg.delivered_to,
                    mediaType = msg.media_type,
                    mediaUrl = msg.media_url,
                    likeCount = msg.like_count,
                    dislikeCount = msg.dislike_count,
                    userReaction = msg.user_reaction,
                    backendId = msg.id
                )
            } else if (entityMatch != null) {
                val senderEntityId = entityMatch.groupValues[1].toIntOrNull()
                val senderCharacter = entityMatch.groupValues[2]
                val targets = entityMatch.groupValues[3] // "1" or "1,2,3"
                val msgType = if (targets.contains(",")) MessageType.ENTITY_BROADCAST else MessageType.ENTITY_TO_ENTITY

                Timber.d("[A2A_SYNC_BACKEND] type=$msgType from=Entity$senderEntityId($senderCharacter) targets=$targets source=${msg.source} backendId=${msg.id} delivered=${msg.is_delivered} deliveredTo=${msg.delivered_to} text=${msg.text.take(60)}")

                ChatMessage(
                    text = msg.text,
                    timestamp = timestamp,
                    isFromUser = false,
                    messageType = msgType,
                    fromEntityId = senderEntityId,
                    fromEntityCharacter = senderCharacter,
                    targetEntityIds = targets,
                    deduplicationKey = deduplicationKey,
                    isSynced = true,
                    isDelivered = msg.is_delivered,
                    deliveredTo = msg.delivered_to,
                    mediaType = msg.media_type,
                    mediaUrl = msg.media_url,
                    likeCount = msg.like_count,
                    dislikeCount = msg.dislike_count,
                    userReaction = msg.user_reaction,
                    backendId = msg.id
                )
            } else if (xdeviceMatch != null) {
                // Cross-device message: xdevice:SENDER_CODE:CHARACTER->TARGET_CODE
                val senderCode = xdeviceMatch.groupValues[1]
                val senderCharacter = xdeviceMatch.groupValues[2]
                val targetCode = xdeviceMatch.groupValues[3]
                val msgType = if (msg.is_from_user) MessageType.CROSS_DEVICE_SENT else MessageType.CROSS_DEVICE_RECEIVED

                ChatMessage(
                    text = msg.text,
                    timestamp = timestamp,
                    isFromUser = msg.is_from_user,
                    messageType = msgType,
                    fromEntityCharacter = senderCharacter,
                    deduplicationKey = deduplicationKey,
                    isSynced = true,
                    isDelivered = msg.is_delivered,
                    deliveredTo = msg.delivered_to,
                    fromPublicCode = senderCode,
                    targetPublicCode = targetCode,
                    likeCount = msg.like_count,
                    dislikeCount = msg.dislike_count,
                    userReaction = msg.user_reaction,
                    backendId = msg.id
                )
            } else if (!msg.is_from_user && !msg.is_from_bot && msg.source == "platform") {
                // Platform slash command response
                ChatMessage(
                    text = msg.text,
                    timestamp = timestamp,
                    isFromUser = false,
                    messageType = MessageType.PLATFORM_RESPONSE,
                    source = "platform",
                    fromEntityId = msg.entity_id,
                    fromEntityName = "E-Claw",
                    deduplicationKey = deduplicationKey,
                    isSynced = true,
                    likeCount = msg.like_count,
                    dislikeCount = msg.dislike_count,
                    userReaction = msg.user_reaction,
                    backendId = msg.id
                )
            } else {
                ChatMessage(
                    text = msg.text,
                    timestamp = timestamp,
                    isFromUser = false,
                    messageType = MessageType.ENTITY_RESPONSE,
                    fromEntityId = msg.entity_id,
                    fromEntityName = msg.source,
                    deduplicationKey = deduplicationKey,
                    isSynced = true,
                    mediaType = msg.media_type,
                    mediaUrl = msg.media_url,
                    likeCount = msg.like_count,
                    dislikeCount = msg.dislike_count,
                    userReaction = msg.user_reaction,
                    backendId = msg.id
                )
            }

            chatDao.insert(message)
            addedCount++
            Timber.d("Synced backend message from entity ${message.fromEntityId}: ${msg.text.take(30)}...")
        }

        if (addedCount > 0) {
            pruneOldMessages()
            Timber.d("Synced $addedCount new messages from backend")
        }

        return addedCount
    }

    // ===== Cloud Sync Recovery =====

    /**
     * Check if local DB is empty (post-update/fresh install) and perform
     * a full history sync from the backend. Returns true if sync was triggered.
     */
    suspend fun performFullSyncIfNeeded(
        api: ClawApiService,
        deviceId: String,
        deviceSecret: String
    ): Boolean {
        val localCount = chatDao.getMessageCount()
        if (localCount >= FULL_SYNC_THRESHOLD) return false

        Timber.i("Local DB has only $localCount messages — triggering full cloud sync")
        try {
            val response = api.getChatHistory(
                deviceId = deviceId,
                deviceSecret = deviceSecret,
                since = null,
                limit = 500
            )
            if (response.success && response.messages.isNotEmpty()) {
                val added = syncFromBackend(response.messages)
                Timber.i("Full cloud sync complete: restored $added messages from ${response.messages.size} server records")
            }
        } catch (e: Exception) {
            Timber.e(e, "Full cloud sync failed")
        }
        return true
    }

    private fun parseIsoTimestamp(isoString: String): Long {
        return try {
            val format = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
            format.timeZone = TimeZone.getTimeZone("UTC")
            format.parse(isoString)?.time ?: System.currentTimeMillis()
        } catch (e: Exception) {
            try {
                val format = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", Locale.US)
                format.timeZone = TimeZone.getTimeZone("UTC")
                format.parse(isoString)?.time ?: System.currentTimeMillis()
            } catch (e2: Exception) {
                Timber.w("Failed to parse timestamp: $isoString")
                System.currentTimeMillis()
            }
        }
    }

    // ============================================
    // BOT POLLING
    // ============================================

    /**
     * Poll bot pending messages and add to chat history
     * Called by StateRepository during multi-entity polling
     */
    suspend fun pollBotMessages(
        deviceId: String,
        entityId: Int,
        botSecret: String,
        getPendingMessages: suspend (deviceId: String, entityId: Int, botSecret: String) -> com.hank.clawlive.data.model.PendingMessagesResponse
    ): Int {
        return try {
            val response = getPendingMessages(deviceId, entityId, botSecret)
            
            if (!response.success || response.messages.isEmpty()) {
                0
            } else {
                var addedCount = 0
                response.messages.forEach { msg ->
                    // Skip entity-to-entity messages: these are handled by processMessageQueue
                    // and syncFromBackend with correct sender/target/type information.
                    // pollBotMessages polls by TARGET entity, so fromEntityId != entityId
                    // means this is a speak-to from another entity — not a direct bot response.
                    if (msg.fromEntityId != entityId) {
                        Timber.d("[A2A_POLL_SKIP] Skipping entity-to-entity msg in pollBotMessages: from=Entity${msg.fromEntityId} polled=Entity$entityId text=${msg.text.take(60)}")
                        return@forEach
                    }

                    // Create deduplication key
                    val deduplicationKey = "bot_${entityId}_${msg.timestamp}"

                    if (!chatDao.existsByDeduplicationKey(deduplicationKey)) {
                        val message = ChatMessage(
                            text = msg.text,
                            timestamp = msg.timestamp,
                            isFromUser = false,
                            messageType = MessageType.ENTITY_RESPONSE,
                            fromEntityId = entityId,
                            fromEntityCharacter = msg.fromCharacter,
                            deduplicationKey = deduplicationKey,
                            isSynced = true,
                            mediaType = msg.mediaType,
                            mediaUrl = msg.mediaUrl
                        )
                        chatDao.insert(message)
                        addedCount++
                        Timber.d("[A2A_POLL_BOT] Saved bot response from Entity $entityId: ${msg.text.take(30)}...")
                    }
                }
                
                if (addedCount > 0) {
                    pruneOldMessages()
                }
                
                Timber.d("Polled ${response.messages.size} bot messages, added $addedCount new messages")
                addedCount
            }
        } catch (e: Exception) {
            Timber.e(e, "Error polling bot messages")
            0
        }
    }
}
