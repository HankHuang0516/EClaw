package com.hank.clawlive.ui

import android.app.Application
import android.content.Context
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.hank.clawlive.data.local.DeviceManager
import com.hank.clawlive.data.remote.AiChatPollResponse
import com.hank.clawlive.data.remote.NetworkModule
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import retrofit2.HttpException
import timber.log.Timber
import java.util.UUID

// ── Data Classes ─────────────────────────

data class AiChatUiState(
    val messages: List<AiMessage> = emptyList(),
    val isLoading: Boolean = false,
    val typingText: String? = null
)

data class AiMessage(
    val role: String,       // "user", "assistant", "action"
    val content: String,
    val images: List<AiImageData>? = null
)

data class AiImageData(val data: String, val mimeType: String)

// ── ViewModel ────────────────────────────

class AiChatViewModel(application: Application) : AndroidViewModel(application) {

    private val api = NetworkModule.api
    private val deviceManager = DeviceManager.getInstance(application)
    private val prefs = application.getSharedPreferences("ai_chat", Context.MODE_PRIVATE)

    private val _uiState = MutableStateFlow(AiChatUiState())
    val uiState: StateFlow<AiChatUiState> = _uiState.asStateFlow()

    private var statusJob: Job? = null
    private var pollingJob: Job? = null

    var pageName: String = ""

    companion object {
        private const val MAX_BUSY_RETRY = 3
        private const val MAX_POLL_ATTEMPTS = 50  // 50 * 3s = 150s
        private const val POLL_INTERVAL_MS = 3000L
        private const val MAX_HISTORY = 20
    }

    init {
        loadHistory()
        resumePendingIfNeeded()
    }

    // ── Public API ───────────────────────

    fun sendMessage(text: String, images: List<AiImageData>?) {
        if (text.isBlank() && images.isNullOrEmpty()) return
        if (_uiState.value.isLoading) return

        val userMsg = AiMessage("user", text.ifBlank { "(image)" }, images)
        _uiState.update {
            it.copy(
                messages = it.messages + userMsg,
                isLoading = true,
                typingText = if (images != null) "Uploading image(s)…" else "..."
            )
        }
        saveHistory()

        val body = buildRequestBody(text, images)

        viewModelScope.launch {
            submitAndPoll(body, 0)
        }
    }

    fun clearHistory() {
        _uiState.update { AiChatUiState() }
        saveHistory()
        savePendingRequestId(null)
    }

    // ── Submit + Poll ────────────────────

    private suspend fun submitAndPoll(body: MutableMap<String, Any>, busyAttempt: Int) {
        try {
            // SUBMIT
            val submitResponse = try {
                api.aiChatSubmit(body)
            } catch (e: Exception) {
                finishWithError(resolveHttpError(e))
                return
            }

            if (!submitResponse.success) {
                finishWithError(submitResponse.message ?: submitResponse.error ?: "Failed to send message.")
                return
            }

            val requestId = submitResponse.requestId ?: run {
                finishWithError("Failed to send message.")
                return
            }
            savePendingRequestId(requestId)

            // PROGRESSIVE TYPING
            statusJob?.cancel()
            statusJob = viewModelScope.launch {
                delay(5000)
                _uiState.update { it.copy(typingText = "AI is analyzing your message…") }
                delay(10000)
                _uiState.update { it.copy(typingText = "Still working on it…") }
                delay(45000)
                _uiState.update { it.copy(typingText = "This is taking a while...") }
            }

            // POLL
            var pollResult: AiChatPollResponse? = null
            pollingJob?.cancel()
            pollingJob = viewModelScope.launch {
                for (attempt in 1..MAX_POLL_ATTEMPTS) {
                    delay(POLL_INTERVAL_MS)
                    try {
                        val poll = api.aiChatPoll(
                            requestId,
                            deviceManager.deviceId,
                            deviceManager.deviceSecret
                        )
                        when (poll.status) {
                            "completed", "failed", "expired" -> {
                                pollResult = poll
                                break
                            }
                        }
                    } catch (_: Exception) {
                        // Transient network error — keep polling
                    }
                }
            }
            pollingJob?.join()
            statusJob?.cancel()

            // HANDLE RESULT
            val poll = pollResult
            when {
                poll == null -> {
                    savePendingRequestId(null)
                    finishWithAssistant("The request is taking too long. Please try again.")
                }
                poll.status == "completed" && poll.busy -> {
                    if (busyAttempt < MAX_BUSY_RETRY) {
                        val waitSec = poll.retry_after ?: 15
                        for (sec in waitSec downTo 1) {
                            _uiState.update {
                                it.copy(typingText = "AI is busy, retrying in ${sec}s… (${busyAttempt + 1}/$MAX_BUSY_RETRY)")
                            }
                            delay(1000)
                        }
                        _uiState.update { it.copy(typingText = "...") }
                        body["requestId"] = UUID.randomUUID().toString()
                        return submitAndPoll(body, busyAttempt + 1)
                    } else {
                        savePendingRequestId(null)
                        finishWithAssistant("AI is currently busy with other requests. Please try again in a moment.")
                    }
                }
                poll.status == "completed" && poll.response != null -> {
                    savePendingRequestId(null)
                    val text = poll.response!!.trim()
                    val displayText = if (text.startsWith("{") && text.contains("\"type\"")) {
                        "Sorry, I was unable to process your request. Please try rephrasing your question."
                    } else text
                    finishWithAssistant(displayText)
                    if (displayText.contains("Feedback #") && displayText.contains("recorded")) {
                        _uiState.update {
                            it.copy(messages = it.messages + AiMessage("action", "View Feedback History →"))
                        }
                    }
                }
                poll.status == "failed" -> {
                    savePendingRequestId(null)
                    finishWithAssistant(poll.error ?: "AI is temporarily unavailable.")
                }
                poll.status == "expired" -> {
                    savePendingRequestId(null)
                    finishWithAssistant("Request expired. Please try again.")
                }
                else -> {
                    savePendingRequestId(null)
                    finishWithAssistant("Something went wrong. Please try again.")
                }
            }
        } catch (e: Exception) {
            if (e is kotlinx.coroutines.CancellationException) throw e
            savePendingRequestId(null)
            statusJob?.cancel()
            finishWithError(resolveHttpError(e))
        }
    }

    // ── Result Helpers ───────────────────

    private fun finishWithAssistant(text: String) {
        _uiState.update {
            it.copy(
                messages = it.messages + AiMessage("assistant", text),
                isLoading = false,
                typingText = null
            )
        }
        saveHistory()
    }

    private fun finishWithError(text: String) {
        _uiState.update {
            it.copy(
                messages = it.messages + AiMessage("assistant", text),
                isLoading = false,
                typingText = null
            )
        }
        saveHistory()
    }

    // ── Request Body Builder ─────────────

    private fun buildRequestBody(text: String, images: List<AiImageData>?): MutableMap<String, Any> {
        val msgs = _uiState.value.messages
        val historyForApi = msgs
            .filter { it.role == "user" || it.role == "assistant" }
            .dropLast(1)  // exclude the just-added user message
            .takeLast(MAX_HISTORY)
            .map { mapOf("role" to it.role, "content" to it.content) }

        val body = mutableMapOf<String, Any>(
            "requestId" to UUID.randomUUID().toString(),
            "deviceId" to deviceManager.deviceId,
            "deviceSecret" to deviceManager.deviceSecret,
            "message" to text.ifBlank { "(user attached image(s) — please analyze them)" },
            "history" to historyForApi,
            "page" to "android_app"
        )
        if (!images.isNullOrEmpty()) {
            body["images"] = images.map { mapOf("data" to it.data, "mimeType" to it.mimeType) }
        }
        return body
    }

    // ── Pending Request Persistence ──────

    private fun savePendingRequestId(requestId: String?) {
        try {
            prefs.edit().putString("pending_request_id", requestId).apply()
        } catch (_: Exception) {}
    }

    private fun loadPendingRequestId(): String? =
        try { prefs.getString("pending_request_id", null) } catch (_: Exception) { null }

    private fun resumePendingIfNeeded() {
        val requestId = loadPendingRequestId() ?: return
        if (_uiState.value.isLoading) return

        _uiState.update { it.copy(isLoading = true, typingText = "Still working on it…") }

        viewModelScope.launch {
            var pollResult: AiChatPollResponse? = null
            try {
                for (attempt in 1..MAX_POLL_ATTEMPTS) {
                    delay(POLL_INTERVAL_MS)
                    try {
                        val poll = api.aiChatPoll(requestId, deviceManager.deviceId, deviceManager.deviceSecret)
                        when (poll.status) {
                            "completed", "failed", "expired" -> { pollResult = poll; break }
                        }
                    } catch (_: Exception) {}
                }

                when {
                    pollResult == null ->
                        finishWithAssistant("The request is taking too long. Please try again.")
                    pollResult!!.status == "completed" && pollResult!!.response != null -> {
                        val text = pollResult!!.response!!.trim()
                        val displayText = if (text.startsWith("{") && text.contains("\"type\"")) {
                            "Sorry, I was unable to process your request. Please try rephrasing your question."
                        } else text
                        finishWithAssistant(displayText)
                        if (displayText.contains("Feedback #") && displayText.contains("recorded")) {
                            _uiState.update {
                                it.copy(messages = it.messages + AiMessage("action", "View Feedback History →"))
                            }
                        }
                    }
                    pollResult!!.status == "failed" ->
                        finishWithAssistant(pollResult!!.error ?: "AI is temporarily unavailable.")
                    pollResult!!.status == "expired" ->
                        finishWithAssistant("Request expired. Please try again.")
                    else ->
                        finishWithAssistant("Something went wrong. Please try again.")
                }
            } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                finishWithError(resolveHttpError(e))
            } finally {
                savePendingRequestId(null)
            }
        }
    }

    // ── Error Handling ───────────────────

    private fun resolveHttpError(e: Exception): String {
        if (e !is HttpException) {
            return when (e) {
                is java.net.SocketTimeoutException -> "Response timed out. Trying again…"
                is java.net.UnknownHostException -> "No internet connection. Please check your network."
                is java.io.IOException -> "Connection error. Please try again."
                else -> "Network error. Please try again."
            }
        }
        val errorBody = try { e.response()?.errorBody()?.string() } catch (_: Exception) { null }
        val json = try { JSONObject(errorBody ?: "{}") } catch (_: Exception) { JSONObject() }

        return when (e.code()) {
            401 -> json.optString("message", "").ifEmpty {
                "Device not registered. Please restart the app."
            }
            413 -> "Images are too large. Please try with fewer or smaller images, or describe your issue in text."
            429 -> {
                val retryMs = json.optLong("retry_after_ms", 0)
                if (retryMs > 0) "Message limit reached. Try again in ${retryMs / 1000}s."
                else "Message limit reached. Try again later."
            }
            503 -> "AI assistant is currently unavailable."
            else -> json.optString("message", "").ifEmpty {
                json.optString("error", "").ifEmpty {
                    "Something went wrong. Please try again."
                }
            }
        }
    }

    // ── History Persistence ──────────────

    private fun loadHistory() {
        try {
            val json = prefs.getString("history", null) ?: return
            val arr = JSONArray(json)
            val loaded = mutableListOf<AiMessage>()
            for (i in 0 until arr.length()) {
                val obj = arr.getJSONObject(i)
                val images = if (obj.has("images")) {
                    val imgArr = obj.getJSONArray("images")
                    (0 until imgArr.length()).map { j ->
                        val imgObj = imgArr.getJSONObject(j)
                        AiImageData(imgObj.getString("data"), imgObj.getString("mimeType"))
                    }
                } else null
                loaded.add(AiMessage(
                    role = obj.getString("role"),
                    content = obj.getString("content"),
                    images = images
                ))
            }
            _uiState.update { it.copy(messages = loaded) }
        } catch (e: Exception) {
            Timber.w(e, "Failed to load AI chat history")
        }
    }

    private fun saveHistory() {
        try {
            val arr = JSONArray()
            for (msg in _uiState.value.messages
                .filter { it.role != "typing" }
                .takeLast(MAX_HISTORY)) {
                arr.put(JSONObject().apply {
                    put("role", msg.role)
                    put("content", msg.content)
                    if (msg.images != null) {
                        val imgArr = JSONArray()
                        for (img in msg.images) {
                            imgArr.put(JSONObject().apply {
                                put("data", img.data)
                                put("mimeType", img.mimeType)
                            })
                        }
                        put("images", imgArr)
                    }
                })
            }
            prefs.edit().putString("history", arr.toString()).apply()
        } catch (e: Exception) {
            Timber.w(e, "Failed to save AI chat history")
        }
    }

    override fun onCleared() {
        super.onCleared()
        pollingJob?.cancel()
        statusJob?.cancel()
    }
}
