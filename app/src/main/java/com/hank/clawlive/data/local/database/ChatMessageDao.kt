package com.hank.clawlive.data.local.database

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Update
import kotlinx.coroutines.flow.Flow

@Dao
interface ChatMessageDao {

    /**
     * Get all messages ordered by timestamp (newest first)
     * Used for combined chat view
     */
    @Query("SELECT * FROM chat_messages ORDER BY timestamp DESC LIMIT :limit")
    fun getRecentMessages(limit: Int = 100): Flow<List<ChatMessage>>

    /**
     * Get the latest N messages ordered by timestamp ascending (for chat display)
     */
    @Query("SELECT * FROM (SELECT * FROM chat_messages ORDER BY timestamp DESC LIMIT :limit) ORDER BY timestamp ASC")
    fun getMessagesAscending(limit: Int = 500): Flow<List<ChatMessage>>

    /**
     * Get messages for specific entity (both sent to and received from)
     */
    @Query("""
        SELECT * FROM chat_messages
        WHERE targetEntityIds LIKE '%' || :entityId || '%'
           OR fromEntityId = :entityId
        ORDER BY timestamp DESC
        LIMIT :limit
    """)
    fun getMessagesForEntity(entityId: Int, limit: Int = 50): Flow<List<ChatMessage>>

    /**
     * Get only user-sent messages
     */
    @Query("SELECT * FROM chat_messages WHERE isFromUser = 1 ORDER BY timestamp DESC LIMIT :limit")
    fun getUserMessages(limit: Int = 50): Flow<List<ChatMessage>>

    /**
     * Get last N messages for widget display (synchronous)
     */
    @Query("SELECT * FROM chat_messages ORDER BY timestamp DESC LIMIT :limit")
    suspend fun getLastMessages(limit: Int = 10): List<ChatMessage>

    /**
     * Insert new message
     */
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insert(message: ChatMessage): Long

    /**
     * Insert multiple messages
     */
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertAll(messages: List<ChatMessage>)

    /**
     * Check for duplicate by deduplication key
     */
    @Query("SELECT COUNT(*) FROM chat_messages WHERE deduplicationKey = :key")
    suspend fun countByDeduplicationKey(key: String): Int

    /**
     * Check if message with this dedup key already exists
     */
    @Query("SELECT EXISTS(SELECT 1 FROM chat_messages WHERE deduplicationKey = :key)")
    suspend fun existsByDeduplicationKey(key: String): Boolean

    /**
     * Get distinct entity IDs that have messages (for smart filter chips)
     */
    @Query("""
        SELECT DISTINCT fromEntityId FROM chat_messages
        WHERE fromEntityId IS NOT NULL
        ORDER BY fromEntityId
    """)
    fun getDistinctEntityIds(): Flow<List<Int>>

    /**
     * Get the latest entity message for comparison
     */
    @Query("""
        SELECT * FROM chat_messages
        WHERE fromEntityId = :entityId AND messageType = 'ENTITY_RESPONSE'
        ORDER BY timestamp DESC
        LIMIT 1
    """)
    suspend fun getLastEntityMessage(entityId: Int): ChatMessage?

    /**
     * Check if a message with the same content from the same entity already exists
     * within a time window. Used for cross-source deduplication (entity polling vs backend sync).
     */
    @Query("""
        SELECT EXISTS(
            SELECT 1 FROM chat_messages
            WHERE fromEntityId = :entityId
              AND text = :text
              AND isFromUser = 0
              AND timestamp > :sinceTimestamp
        )
    """)
    suspend fun existsByContentAndEntity(entityId: Int, text: String, sinceTimestamp: Long): Boolean

    /**
     * Mark message as synced after API success
     */
    @Query("UPDATE chat_messages SET isSynced = 1 WHERE id = :messageId")
    suspend fun markSynced(messageId: Long)

    /**
     * Mark message as delivered with entity IDs that confirmed receipt
     */
    @Query("UPDATE chat_messages SET isDelivered = 1, deliveredTo = :deliveredTo WHERE id = :messageId")
    suspend fun markDelivered(messageId: Long, deliveredTo: String)

    /**
     * Update delivery status for an existing message matched by deduplication key.
     * Used when backend sync detects updated is_delivered / delivered_to after initial insert.
     */
    @Query("UPDATE chat_messages SET isDelivered = :isDelivered, deliveredTo = :deliveredTo WHERE deduplicationKey = :dedupKey")
    suspend fun updateDeliveryByDedupKey(dedupKey: String, isDelivered: Boolean, deliveredTo: String?)

    /**
     * Get total message count
     */
    @Query("SELECT COUNT(*) FROM chat_messages")
    suspend fun getMessageCount(): Int

    /**
     * Delete old messages, keeping only the last N
     */
    @Query("""
        DELETE FROM chat_messages
        WHERE id NOT IN (SELECT id FROM chat_messages ORDER BY timestamp DESC LIMIT :keepCount)
    """)
    suspend fun pruneOldMessages(keepCount: Int = 500)

    /**
     * Clear all messages
     */
    @Query("DELETE FROM chat_messages")
    suspend fun clearAll()
}
