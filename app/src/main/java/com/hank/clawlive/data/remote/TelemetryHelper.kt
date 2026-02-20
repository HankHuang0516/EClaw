package com.hank.clawlive.data.remote

import android.content.Context
import com.hank.clawlive.data.local.DeviceManager
import kotlinx.coroutines.*
import timber.log.Timber
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL

/**
 * Device telemetry helper — singleton that batches entries and
 * flushes them to `POST /api/device-telemetry` periodically.
 *
 * Usage:
 *   TelemetryHelper.init(context)              // once in Application.onCreate
 *   TelemetryHelper.trackPageView(ctx, "chat") // in Activity.onResume
 *   TelemetryHelper.trackAction("bind_free")   // on user action
 *   TelemetryHelper.trackError(exception)       // in catch blocks
 */
object TelemetryHelper {

    private const val FLUSH_INTERVAL_MS = 30_000L   // 30 seconds
    private const val MAX_BATCH = 50
    private const val MAX_BUFFER = 200
    private const val BASE_URL = "https://eclaw.up.railway.app"

    private val buffer = mutableListOf<Map<String, Any?>>()
    private var deviceManager: DeviceManager? = null
    private var scope: CoroutineScope? = null
    private var flushJob: Job? = null
    private var currentPage: String? = null

    /**
     * Initialize with application context. Call once in Application.onCreate().
     */
    fun init(context: Context) {
        deviceManager = DeviceManager.getInstance(context)
        scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
        startPeriodicFlush()
        Timber.d("TelemetryHelper initialized")
    }

    /**
     * Track a page/screen view. Call in Activity.onResume().
     */
    fun trackPageView(context: Context, page: String) {
        if (deviceManager == null) init(context)
        currentPage = page
        enqueue(type = "page_view", action = page)
    }

    /**
     * Track a user action (button tap, dialog open, etc.).
     */
    fun trackAction(action: String, meta: Map<String, Any?>? = null) {
        enqueue(type = "user_action", action = action, meta = meta)
    }

    /**
     * Track an error.
     */
    fun trackError(error: Throwable, meta: Map<String, Any?>? = null) {
        val errorMeta = mutableMapOf<String, Any?>(
            "message" to (error.message?.take(200) ?: "unknown"),
            "class" to error.javaClass.simpleName
        )
        if (meta != null) errorMeta.putAll(meta)
        enqueue(type = "error", action = error.javaClass.simpleName, meta = errorMeta)
    }

    /**
     * Track a lifecycle event (app foreground, background, push received, etc.).
     */
    fun trackLifecycle(action: String, meta: Map<String, Any?>? = null) {
        enqueue(type = "lifecycle", action = action, meta = meta)
    }

    /**
     * Enqueue a raw telemetry entry. Called by [TelemetryInterceptor] for API calls.
     */
    fun enqueue(
        type: String,
        action: String? = null,
        input: Map<String, Any?>? = null,
        output: Map<String, Any?>? = null,
        duration: Long? = null,
        meta: Map<String, Any?>? = null
    ) {
        val entry = mutableMapOf<String, Any?>(
            "ts" to System.currentTimeMillis(),
            "type" to type,
            "page" to currentPage
        )
        if (action != null) entry["action"] = action
        if (input != null) entry["input"] = input
        if (output != null) entry["output"] = output
        if (duration != null) entry["duration"] = duration
        if (meta != null) entry["meta"] = meta

        synchronized(buffer) {
            if (buffer.size < MAX_BUFFER) {
                buffer.add(entry)
            }
            if (buffer.size >= MAX_BATCH) {
                flush()
            }
        }
    }

    /**
     * Force flush the buffer now.
     */
    fun flush() {
        val dm = deviceManager ?: return
        val batch: List<Map<String, Any?>>
        synchronized(buffer) {
            if (buffer.isEmpty()) return
            batch = buffer.take(MAX_BATCH).toList()
            buffer.subList(0, batch.size.coerceAtMost(buffer.size)).clear()
        }

        scope?.launch {
            try {
                sendBatch(dm.deviceId, dm.deviceSecret, batch)
            } catch (e: Exception) {
                Timber.w(e, "Telemetry flush failed")
                // Re-queue on failure
                synchronized(buffer) {
                    if (buffer.size + batch.size <= MAX_BUFFER) {
                        buffer.addAll(0, batch)
                    }
                }
            }
        }
    }

    private fun startPeriodicFlush() {
        flushJob?.cancel()
        flushJob = scope?.launch {
            while (isActive) {
                delay(FLUSH_INTERVAL_MS)
                flush()
            }
        }
    }

    private fun sendBatch(deviceId: String, deviceSecret: String, entries: List<Map<String, Any?>>) {
        val url = URL("$BASE_URL/api/device-telemetry")
        val conn = url.openConnection() as HttpURLConnection
        try {
            conn.requestMethod = "POST"
            conn.setRequestProperty("Content-Type", "application/json")
            conn.doOutput = true
            conn.connectTimeout = 5000
            conn.readTimeout = 5000

            val json = buildJsonPayload(deviceId, deviceSecret, entries)
            OutputStreamWriter(conn.outputStream).use { it.write(json) }

            val code = conn.responseCode
            if (code !in 200..299) {
                Timber.w("Telemetry POST returned $code")
            }
        } finally {
            conn.disconnect()
        }
    }

    /**
     * Build JSON payload manually to avoid Gson dependency in this helper.
     */
    private fun buildJsonPayload(
        deviceId: String,
        deviceSecret: String,
        entries: List<Map<String, Any?>>
    ): String {
        val sb = StringBuilder()
        sb.append("""{"deviceId":"${escapeJson(deviceId)}","deviceSecret":"${escapeJson(deviceSecret)}","entries":[""")
        entries.forEachIndexed { i, entry ->
            if (i > 0) sb.append(",")
            sb.append(mapToJson(entry))
        }
        sb.append("]}")
        return sb.toString()
    }

    private fun mapToJson(map: Map<String, Any?>): String {
        val sb = StringBuilder("{")
        var first = true
        for ((k, v) in map) {
            if (v == null) continue
            if (!first) sb.append(",")
            first = false
            sb.append("\"${escapeJson(k)}\":")
            sb.append(valueToJson(v))
        }
        sb.append("}")
        return sb.toString()
    }

    @Suppress("UNCHECKED_CAST")
    private fun valueToJson(v: Any?): String = when (v) {
        null -> "null"
        is Number -> v.toString()
        is Boolean -> v.toString()
        is String -> "\"${escapeJson(v)}\""
        is Map<*, *> -> mapToJson(v as Map<String, Any?>)
        is List<*> -> "[${v.joinToString(",") { valueToJson(it) }}]"
        else -> "\"${escapeJson(v.toString())}\""
    }

    private fun escapeJson(s: String): String =
        s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n").replace("\r", "\\r")
}
