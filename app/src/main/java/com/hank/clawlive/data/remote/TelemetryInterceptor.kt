package com.hank.clawlive.data.remote

import okhttp3.Interceptor
import okhttp3.Response
import okio.Buffer
import timber.log.Timber

/**
 * OkHttp interceptor that auto-captures every API request/response
 * into the device telemetry buffer via [TelemetryHelper].
 *
 * Inserted into the OkHttp chain in [NetworkModule].
 * Sensitive fields (deviceSecret, botSecret, etc.) are stripped automatically.
 */
class TelemetryInterceptor : Interceptor {

    companion object {
        private val SENSITIVE_KEYS = listOf(
            "deviceSecret", "botSecret", "password", "secret", "token", "jwt"
        )
        private const val MAX_BODY_LOG = 512 // truncate large bodies
    }

    override fun intercept(chain: Interceptor.Chain): Response {
        val request = chain.request()
        val start = System.currentTimeMillis()

        // Capture request summary
        val method = request.method
        val path = request.url.encodedPath
        val inputSummary = summarizeRequestBody(request)

        val response: Response
        try {
            response = chain.proceed(request)
        } catch (e: Exception) {
            val duration = System.currentTimeMillis() - start
            TelemetryHelper.enqueue(
                type = "api_call",
                action = "$method $path",
                input = inputSummary,
                output = mapOf("success" to false, "error" to (e.message?.take(200) ?: "unknown")),
                duration = duration
            )
            throw e
        }

        val duration = System.currentTimeMillis() - start
        val outputSummary = mutableMapOf<String, Any?>(
            "status" to response.code,
            "success" to (response.code in 200..299)
        )
        if (!response.isSuccessful) {
            outputSummary["error"] = response.message.take(200)
        }

        TelemetryHelper.enqueue(
            type = "api_call",
            action = "$method $path",
            input = inputSummary,
            output = outputSummary,
            duration = duration
        )

        return response
    }

    private fun summarizeRequestBody(request: okhttp3.Request): Map<String, Any?>? {
        val body = request.body ?: return null
        if (body.contentLength() > MAX_BODY_LOG) return mapOf("_truncated" to true, "size" to body.contentLength())

        return try {
            val buffer = Buffer()
            body.writeTo(buffer)
            val raw = buffer.readUtf8()
            // Simple JSON key extraction + redaction
            val summary = mutableMapOf<String, Any?>()
            // Match "key": "value" or "key": number
            val regex = Regex(""""(\w+)"\s*:\s*("(?:[^"\\]|\\.)*"|\d+(?:\.\d+)?|true|false|null)""")
            for (match in regex.findAll(raw)) {
                val key = match.groupValues[1]
                val value = match.groupValues[2].removeSurrounding("\"")
                if (SENSITIVE_KEYS.any { key.contains(it, ignoreCase = true) }) {
                    summary[key] = "[REDACTED]"
                } else if (value.length > 100) {
                    summary[key] = value.take(100) + "..."
                } else {
                    summary[key] = value
                }
            }
            summary.ifEmpty { null }
        } catch (e: Exception) {
            Timber.w(e, "TelemetryInterceptor: failed to read request body")
            null
        }
    }
}
