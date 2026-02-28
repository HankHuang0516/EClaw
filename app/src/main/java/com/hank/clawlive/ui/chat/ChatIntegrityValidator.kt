package com.hank.clawlive.ui.chat

import com.hank.clawlive.data.local.database.ChatMessage
import com.hank.clawlive.data.remote.ChatHistoryMessage
import com.hank.clawlive.data.remote.NetworkModule
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import timber.log.Timber
import java.util.concurrent.ConcurrentHashMap

/**
 * Chat Integrity Validator — validates chat display consistency.
 *
 * DATA layer:  local Room DB list vs. backend API response
 * DISPLAY layer: submitted list vs. adapter state after DiffUtil commit
 *
 * All checks run on Dispatchers.IO. Never blocks UI.
 */
object ChatIntegrityValidator {

    private const val COOLDOWN_MS = 30 * 60 * 1000L // 30 min per fingerprint
    private val reportedTs = ConcurrentHashMap<String, Long>()

    // ── Data Layer ──────────────────────────────────────────────────────────

    fun validateDataLayer(
        localMessages: List<ChatMessage>,
        backendMessages: List<ChatHistoryMessage>,
        deviceId: String,
        deviceSecret: String
    ) {
        CoroutineScope(Dispatchers.IO).launch {
            try {
                checkDataLayer(localMessages, backendMessages, deviceId, deviceSecret)
            } catch (e: Exception) {
                Timber.w(e, "ChatIntegrityValidator data layer check failed")
            }
        }
    }

    private suspend fun checkDataLayer(
        localMessages: List<ChatMessage>,
        backendMessages: List<ChatHistoryMessage>,
        deviceId: String,
        deviceSecret: String
    ) {
        val localDedupKeys = localMessages.mapNotNull { it.deduplicationKey }.toSet()
        // Filter out user messages from Android — these are saved locally by saveOutgoingMessage()
        // without a backend_ dedup key, so syncFromBackend() intentionally skips them (not missing)
        val androidLocalSources = setOf("android_chat", "android_widget")
        val backendKeys = backendMessages
            .filter { !(it.is_from_user && it.source in androidLocalSources) }
            .map { "backend_${it.id}" }

        // CHECK 1: Missing messages
        val missingKeys = backendKeys.filter { it !in localDedupKeys }
        if (missingKeys.size > 2) {
            sendReport(deviceId, deviceSecret, mapOf(
                "layer" to "data",
                "checkType" to "message_count",
                "description" to "Local DB missing ${missingKeys.size} messages from backend",
                "expected" to mapOf("count" to backendKeys.size),
                "actual" to mapOf("count" to localDedupKeys.size, "missingCount" to missingKeys.size),
                "affectedIds" to missingKeys.take(5)
            ))
            return
        }

        // CHECK 2 & 3: Content + field consistency for last 50
        for (bMsg in backendMessages.takeLast(50)) {
            val dedupKey = "backend_${bMsg.id}"
            val lMsg = localMessages.firstOrNull { it.deduplicationKey == dedupKey } ?: continue

            if (lMsg.text != bMsg.text) {
                sendReport(deviceId, deviceSecret, mapOf(
                    "layer" to "data",
                    "checkType" to "content_mismatch",
                    "description" to "Message ${bMsg.id} text differs",
                    "expected" to mapOf("text" to bMsg.text.take(80)),
                    "actual" to mapOf("text" to lMsg.text.take(80)),
                    "affectedIds" to listOf(bMsg.id)
                ))
                break
            }
            if (lMsg.isFromUser != bMsg.is_from_user) {
                sendReport(deviceId, deviceSecret, mapOf(
                    "layer" to "data",
                    "checkType" to "field_is_from_user",
                    "description" to "Message ${bMsg.id} direction differs",
                    "expected" to mapOf("is_from_user" to bMsg.is_from_user),
                    "actual" to mapOf("is_from_user" to lMsg.isFromUser),
                    "affectedIds" to listOf(bMsg.id)
                ))
                break
            }
            if (lMsg.mediaType != bMsg.media_type) {
                sendReport(deviceId, deviceSecret, mapOf(
                    "layer" to "data",
                    "checkType" to "field_media_type",
                    "description" to "Message ${bMsg.id} media_type differs",
                    "expected" to mapOf("media_type" to bMsg.media_type),
                    "actual" to mapOf("media_type" to lMsg.mediaType),
                    "affectedIds" to listOf(bMsg.id)
                ))
                break
            }
        }
    }

    // ── Display Layer ───────────────────────────────────────────────────────

    fun validateDisplayLayer(
        adapter: ChatAdapter,
        submittedList: List<ChatMessage>,
        deviceId: String,
        deviceSecret: String
    ) {
        CoroutineScope(Dispatchers.IO).launch {
            try {
                checkDisplayLayer(adapter, submittedList, deviceId, deviceSecret)
            } catch (e: Exception) {
                Timber.w(e, "ChatIntegrityValidator display layer check failed")
            }
        }
    }

    private suspend fun checkDisplayLayer(
        adapter: ChatAdapter,
        submittedList: List<ChatMessage>,
        deviceId: String,
        deviceSecret: String
    ) {
        // CHECK 1: Adapter count vs submitted
        val adapterCount = adapter.itemCount
        if (adapterCount != submittedList.size) {
            sendReport(deviceId, deviceSecret, mapOf(
                "layer" to "display",
                "checkType" to "bubble_count",
                "description" to "Adapter has $adapterCount items but submitted ${submittedList.size}",
                "expected" to mapOf("count" to submittedList.size),
                "actual" to mapOf("count" to adapterCount)
            ))
            return
        }

        // CHECK 2 & 3: Direction + ordering for items
        val adapterList = adapter.currentList
        for (i in submittedList.indices.take(100)) {
            val submitted = submittedList[i]
            val inAdapter = adapterList.getOrNull(i) ?: break

            // Direction (view type)
            val expectedType = if (submitted.isFromUser) 0 else 1
            val actualType = adapter.getItemViewType(i)
            if (expectedType != actualType) {
                sendReport(deviceId, deviceSecret, mapOf(
                    "layer" to "display",
                    "checkType" to "direction",
                    "description" to "Item $i wrong view type",
                    "expected" to mapOf("isFromUser" to submitted.isFromUser, "viewType" to expectedType),
                    "actual" to mapOf("viewType" to actualType),
                    "affectedIds" to listOf(submitted.id.toString())
                ))
                break
            }

            // Identity
            if (inAdapter.id != submitted.id) {
                sendReport(deviceId, deviceSecret, mapOf(
                    "layer" to "display",
                    "checkType" to "ordering",
                    "description" to "Item $i ID mismatch",
                    "expected" to mapOf("id" to submitted.id),
                    "actual" to mapOf("id" to inAdapter.id),
                    "affectedIds" to listOf(submitted.id.toString(), inAdapter.id.toString())
                ))
                break
            }
        }
    }

    // ── Report sender ───────────────────────────────────────────────────────

    private suspend fun sendReport(
        deviceId: String,
        deviceSecret: String,
        body: Map<String, Any?>
    ) {
        val checkType = body["checkType"] as? String ?: "unknown"
        val firstId = (body["affectedIds"] as? List<*>)?.firstOrNull()?.toString() ?: "none"
        val fp = "$checkType:$firstId"
        val now = System.currentTimeMillis()
        val lastTs = reportedTs[fp] ?: 0L
        if (now - lastTs < COOLDOWN_MS) return
        reportedTs[fp] = now

        try {
            val payload = body.toMutableMap().apply {
                put("deviceId", deviceId)
                put("deviceSecret", deviceSecret)
                put("platform", "android")
                put("appVersion", android.os.Build.VERSION.RELEASE)
            }
            NetworkModule.api.reportChatIntegrity(payload)
            Timber.w("ChatIntegrity reported: $fp")
        } catch (e: Exception) {
            Timber.w(e, "ChatIntegrity report failed (non-critical)")
        }
    }
}
