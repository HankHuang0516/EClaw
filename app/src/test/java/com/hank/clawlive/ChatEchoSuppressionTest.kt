package com.hank.clawlive

import org.junit.Assert.*
import org.junit.Test

/**
 * Unit tests for entity-to-entity message echo suppression.
 *
 * When the backend processes broadcast or speak-to, it sets the RECEIVING entity's
 * `entity.message` to a format like "entity:{ID}:{CHAR}: {text}".
 * The Android client's processEntityMessage() must SKIP these messages because
 * they are already tracked via syncFromBackend() as a single record under the
 * SENDER entity — with correct fromEntityId and delivery tracking.
 *
 * If processEntityMessage() does NOT skip these, the same message appears
 * multiple times in the Chat page (once per receiving entity + once from backend sync).
 */
class ChatEchoSuppressionTest {

    /**
     * The regex used in ChatRepository.processEntityMessage() to detect
     * entity-to-entity messages that should be skipped.
     */
    private val entityToEntityPattern = Regex("^entity:\\d+:[A-Z]+:.*")

    // ===== Messages that MUST be filtered (echo suppression) =====

    @Test
    fun broadcastEchoMessage_isFiltered() {
        // Backend sets this on receiving entities during broadcast
        val message = "entity:1:LOBSTER: [廣播] 大家好，有人在嗎？"
        assertTrue(
            "Broadcast echo should be filtered: $message",
            message.matches(entityToEntityPattern)
        )
    }

    @Test
    fun speakToEchoMessage_isFiltered() {
        // Backend sets this on receiving entity during speak-to
        val message = "entity:0:PIG: 你好，我想問一個問題"
        assertTrue(
            "Speak-to echo should be filtered: $message",
            message.matches(entityToEntityPattern)
        )
    }

    @Test
    fun broadcastEchoWithMediaCaption_isFiltered() {
        val message = "entity:2:CHICKEN: [廣播] [Photo] Check this out"
        assertTrue(
            "Broadcast with media caption should be filtered: $message",
            message.matches(entityToEntityPattern)
        )
    }

    @Test
    fun speakToEchoWithEmptyMessage_isFiltered() {
        // Edge case: entity:X:CHAR: followed by empty text
        val message = "entity:3:LOBSTER: "
        assertTrue(
            "Speak-to with trailing space should be filtered: $message",
            message.matches(entityToEntityPattern)
        )
    }

    @Test
    fun speakToEchoWithColonOnly_isFiltered() {
        // Minimum pattern: "entity:0:X:" (no space after colon)
        val message = "entity:0:PIG:"
        assertTrue(
            "Minimum entity pattern should be filtered: $message",
            message.matches(entityToEntityPattern)
        )
    }

    @Test
    fun allEntitySlots_areFiltered() {
        // Entity IDs 0-3 should all be caught
        for (id in 0..3) {
            val message = "entity:$id:LOBSTER: test message"
            assertTrue(
                "Entity $id message should be filtered",
                message.matches(entityToEntityPattern)
            )
        }
    }

    @Test
    fun variousCharacterTypes_areFiltered() {
        val characters = listOf("LOBSTER", "PIG", "CHICKEN", "CAT", "DOG", "BEAR")
        for (char in characters) {
            val message = "entity:1:$char: hello"
            assertTrue(
                "Character $char should be filtered",
                message.matches(entityToEntityPattern)
            )
        }
    }

    // ===== Messages that must NOT be filtered (legitimate entity responses) =====

    @Test
    fun regularEntityResponse_isNotFiltered() {
        // Bot's own response displayed on wallpaper — NOT an entity-to-entity echo
        val message = "正在處理您的請求..."
        assertFalse(
            "Regular entity response should NOT be filtered: $message",
            message.matches(entityToEntityPattern)
        )
    }

    @Test
    fun entityResponseWithEntityWord_isNotFiltered() {
        // Contains "entity" but NOT in the echo format
        val message = "The entity system is working correctly"
        assertFalse(
            "Message containing 'entity' word should NOT be filtered: $message",
            message.matches(entityToEntityPattern)
        )
    }

    @Test
    fun systemMessage_isNotFiltered() {
        val message = "[SYSTEM:WEBHOOK_ERROR] Push failed (HTTP 500)"
        assertFalse(
            "System message should NOT be filtered by entity pattern: $message",
            message.matches(entityToEntityPattern)
        )
    }

    @Test
    fun receivedEcho_isNotFiltered() {
        val message = "Received: \"hello\""
        assertFalse(
            "Received echo should NOT be filtered by entity pattern: $message",
            message.matches(entityToEntityPattern)
        )
    }

    @Test
    fun passiveMessage_isNotFiltered() {
        val messages = listOf("Waiting...", "Zzz...", "Loading...", "Idle", "Ready", "Standing by")
        for (msg in messages) {
            assertFalse(
                "Passive message should NOT be filtered: $msg",
                msg.matches(entityToEntityPattern)
            )
        }
    }

    @Test
    fun lowercaseCharacter_isNotFiltered() {
        // Character must be uppercase — lowercase shouldn't match
        val message = "entity:1:lobster: hello"
        assertFalse(
            "Lowercase character should NOT match entity pattern: $message",
            message.matches(entityToEntityPattern)
        )
    }

    @Test
    fun malformedEntityPattern_isNotFiltered() {
        // Missing colon between ID and character
        val messages = listOf(
            "entity:LOBSTER: hello",        // missing ID
            "entity:1LOBSTER: hello",       // missing colon after ID
            "entityX:1:LOBSTER: hello",     // extra char before colon
        )
        for (msg in messages) {
            assertFalse(
                "Malformed entity pattern should NOT be filtered: $msg",
                msg.matches(entityToEntityPattern)
            )
        }
    }

    @Test
    fun fromEntityPrefix_isNotFiltered() {
        // Old format "From Entity X:" used in entity.message line 1929 (overwritten by line 1947)
        val message = "From Entity 1: \"hello\""
        assertFalse(
            "Old 'From Entity' format should NOT be filtered: $message",
            message.matches(entityToEntityPattern)
        )
    }
}
