package com.hank.clawlive

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Typeface
import android.net.Uri
import android.os.Bundle
import android.text.Html
import android.text.method.LinkMovementMethod
import android.util.Base64
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ImageButton
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.updatePadding
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.google.android.material.button.MaterialButton
import com.google.android.material.textfield.TextInputEditText
import com.hank.clawlive.data.local.DeviceManager
import com.hank.clawlive.data.remote.NetworkModule
import com.hank.clawlive.data.remote.TelemetryHelper
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import retrofit2.HttpException
import java.io.ByteArrayOutputStream
import java.util.UUID

class AiChatActivity : AppCompatActivity() {

    private val api by lazy { NetworkModule.api }
    private val deviceManager by lazy { DeviceManager.getInstance(this) }

    private lateinit var recyclerChat: RecyclerView
    private lateinit var editMessage: TextInputEditText
    private lateinit var btnSend: MaterialButton
    private lateinit var btnAttachImage: ImageButton
    private lateinit var btnBack: ImageButton
    private lateinit var btnClearHistory: ImageButton
    private lateinit var emptyState: View
    private lateinit var imagePreviewScroll: View
    private lateinit var imagePreviewContainer: LinearLayout
    private lateinit var topBar: View

    private val chatAdapter = AiChatAdapter()
    private val messages = mutableListOf<AiMessage>()
    private val pendingImages = mutableListOf<ImageData>()
    private var isLoading = false
    private var statusJob: Job? = null
    private var pollingJob: Job? = null

    private val imagePickerLauncher = registerForActivityResult(
        ActivityResultContracts.GetMultipleContents()
    ) { uris ->
        for (uri in uris) {
            if (pendingImages.size >= 3) break
            addImageFromUri(uri)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        setContentView(R.layout.activity_ai_chat)

        initViews()
        setupInsets()
        setupListeners()
        loadHistory()
        updateUi()
    }

    override fun onResume() {
        super.onResume()
        TelemetryHelper.trackPageView(this, "ai_chat")
    }

    private fun initViews() {
        recyclerChat = findViewById(R.id.recyclerChat)
        editMessage = findViewById(R.id.editMessage)
        btnSend = findViewById(R.id.btnSend)
        btnAttachImage = findViewById(R.id.btnAttachImage)
        btnBack = findViewById(R.id.btnBack)
        btnClearHistory = findViewById(R.id.btnClearHistory)
        emptyState = findViewById(R.id.emptyState)
        imagePreviewScroll = findViewById(R.id.imagePreviewScroll)
        imagePreviewContainer = findViewById(R.id.imagePreviewContainer)
        topBar = findViewById(R.id.topBar)

        recyclerChat.layoutManager = LinearLayoutManager(this).apply {
            stackFromEnd = true
        }
        recyclerChat.adapter = chatAdapter
    }

    private fun setupInsets() {
        ViewCompat.setOnApplyWindowInsetsListener(findViewById(android.R.id.content)) { _, windowInsets ->
            val insets = windowInsets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
            )
            topBar.updatePadding(
                left = insets.left + dpToPx(8),
                top = insets.top + dpToPx(8),
                right = insets.right + dpToPx(8)
            )
            WindowInsetsCompat.CONSUMED
        }
    }

    private fun setupListeners() {
        btnBack.setOnClickListener { finish() }

        btnClearHistory.setOnClickListener {
            AlertDialog.Builder(this)
                .setTitle(R.string.ai_chat_clear_title)
                .setMessage(R.string.ai_chat_clear_message)
                .setPositiveButton(R.string.ai_chat_clear_confirm) { _, _ ->
                    messages.clear()
                    saveHistory()
                    updateUi()
                }
                .setNegativeButton(android.R.string.cancel, null)
                .show()
        }

        editMessage.addTextChangedListener(object : android.text.TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
            override fun afterTextChanged(s: android.text.Editable?) {
                updateSendButton()
            }
        })

        btnSend.setOnClickListener { sendMessage() }
        btnAttachImage.setOnClickListener { imagePickerLauncher.launch("image/*") }
    }

    // ── Image Handling ──────────────────────

    private fun addImageFromUri(uri: Uri) {
        try {
            val inputStream = contentResolver.openInputStream(uri) ?: return
            val original = BitmapFactory.decodeStream(inputStream)
            inputStream.close()

            // Compress and resize
            val maxDim = 1024
            val scaled = if (original.width > maxDim || original.height > maxDim) {
                val ratio = minOf(maxDim.toFloat() / original.width, maxDim.toFloat() / original.height)
                Bitmap.createScaledBitmap(
                    original,
                    (original.width * ratio).toInt(),
                    (original.height * ratio).toInt(),
                    true
                )
            } else original

            val baos = ByteArrayOutputStream()
            scaled.compress(Bitmap.CompressFormat.JPEG, 85, baos)
            val base64 = Base64.encodeToString(baos.toByteArray(), Base64.NO_WRAP)

            pendingImages.add(ImageData(base64, "image/jpeg"))
            renderImagePreview()
            updateSendButton()
        } catch (e: Exception) {
            Toast.makeText(this, "Failed to load image", Toast.LENGTH_SHORT).show()
        }
    }

    private fun renderImagePreview() {
        imagePreviewContainer.removeAllViews()
        if (pendingImages.isEmpty()) {
            imagePreviewScroll.visibility = View.GONE
            return
        }
        imagePreviewScroll.visibility = View.VISIBLE

        for ((index, img) in pendingImages.withIndex()) {
            val thumbView = LayoutInflater.from(this)
                .inflate(R.layout.item_ai_msg_user, imagePreviewContainer, false)

            // Create a simple thumbnail frame
            val frame = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                layoutParams = LinearLayout.LayoutParams(dpToPx(56), dpToPx(56)).apply {
                    marginEnd = dpToPx(8)
                }
            }

            val imageView = ImageView(this).apply {
                layoutParams = LinearLayout.LayoutParams(dpToPx(56), dpToPx(56))
                scaleType = ImageView.ScaleType.CENTER_CROP
                val bytes = Base64.decode(img.data, Base64.NO_WRAP)
                setImageBitmap(BitmapFactory.decodeByteArray(bytes, 0, bytes.size))
                setOnClickListener {
                    pendingImages.removeAt(index)
                    renderImagePreview()
                    updateSendButton()
                }
            }
            frame.addView(imageView)
            imagePreviewContainer.addView(frame)
        }
    }

    // ── Send Message (async submit/poll) ─────

    private val MAX_BUSY_RETRY = 3
    private val MAX_POLL_ATTEMPTS = 50  // 50 * 3s = 150s
    private val POLL_INTERVAL_MS = 3000L

    private fun sendMessage() {
        val text = editMessage.text?.toString()?.trim() ?: ""
        if (text.isEmpty() && pendingImages.isEmpty()) return
        if (isLoading) return

        val images = if (pendingImages.isNotEmpty()) pendingImages.toList() else null

        messages.add(AiMessage("user", text.ifEmpty { "(image)" }, images))
        saveHistory()
        updateUi()
        scrollToBottom()

        editMessage.setText("")
        pendingImages.clear()
        renderImagePreview()
        updateSendButton()

        val typingText = if (images != null) getString(R.string.ai_chat_uploading) else "..."
        messages.add(AiMessage("typing", typingText))
        updateUi()
        scrollToBottom()

        isLoading = true

        val body = mutableMapOf<String, Any>(
            "requestId" to UUID.randomUUID().toString(),
            "deviceId" to deviceManager.deviceId,
            "deviceSecret" to deviceManager.deviceSecret,
            "message" to (text.ifEmpty { "(user attached image(s) — please analyze them)" }),
            "history" to messages.filter { it.role != "typing" }.takeLast(20).map {
                mapOf("role" to it.role, "content" to it.content)
            },
            "page" to "android_app"
        )
        if (images != null) {
            body["images"] = images.map {
                mapOf("data" to it.data, "mimeType" to it.mimeType)
            }
        }

        lifecycleScope.launch {
            submitAndPoll(body, 0)
        }
    }

    private suspend fun submitAndPoll(body: MutableMap<String, Any>, busyAttempt: Int) {
        try {
            // ── SUBMIT ──
            val submitResponse = try {
                api.aiChatSubmit(body)
            } catch (e: Exception) {
                messages.removeAll { it.role == "typing" }
                messages.add(AiMessage("assistant", resolveHttpError(e)))
                return
            }

            if (!submitResponse.success) {
                messages.removeAll { it.role == "typing" }
                messages.add(AiMessage("assistant",
                    submitResponse.message ?: submitResponse.error ?: "Failed to send message."))
                return
            }

            val requestId = submitResponse.requestId ?: run {
                messages.removeAll { it.role == "typing" }
                messages.add(AiMessage("assistant", "Failed to send message."))
                return
            }

            // ── PROGRESSIVE TYPING INDICATOR ──
            statusJob = lifecycleScope.launch {
                delay(5000)
                if (isFinishing) return@launch
                messages.removeAll { it.role == "typing" }
                messages.add(AiMessage("typing", getString(R.string.ai_chat_analyzing)))
                updateUi()
                delay(10000)
                if (isFinishing) return@launch
                messages.removeAll { it.role == "typing" }
                messages.add(AiMessage("typing", getString(R.string.ai_chat_thinking)))
                updateUi()
                delay(45000)
                if (isFinishing) return@launch
                messages.removeAll { it.role == "typing" }
                messages.add(AiMessage("typing", "This is taking a while..."))
                updateUi()
            }

            // ── POLL ──
            var pollResult: com.hank.clawlive.data.remote.AiChatPollResponse? = null
            pollingJob = lifecycleScope.launch {
                for (attempt in 1..MAX_POLL_ATTEMPTS) {
                    delay(POLL_INTERVAL_MS)
                    if (isFinishing) break
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

            // ── HANDLE RESULT ──
            messages.removeAll { it.role == "typing" }
            val poll = pollResult

            when {
                poll == null -> {
                    messages.add(AiMessage("assistant", "The request is taking too long. Please try again."))
                }
                poll.status == "completed" && poll.busy -> {
                    if (busyAttempt < MAX_BUSY_RETRY) {
                        val waitSec = poll.retry_after ?: 15
                        for (sec in waitSec downTo 1) {
                            messages.removeAll { it.role == "typing" }
                            messages.add(AiMessage("typing",
                                getString(R.string.ai_chat_busy_retry, sec, busyAttempt + 1, MAX_BUSY_RETRY)))
                            updateUi()
                            scrollToBottom()
                            delay(1000)
                        }
                        messages.removeAll { it.role == "typing" }
                        messages.add(AiMessage("typing", "..."))
                        updateUi()
                        scrollToBottom()
                        body["requestId"] = UUID.randomUUID().toString()
                        return submitAndPoll(body, busyAttempt + 1)
                    } else {
                        messages.add(AiMessage("assistant", getString(R.string.ai_chat_busy_exhausted)))
                    }
                }
                poll.status == "completed" && poll.response != null -> {
                    val text = poll.response.trim()
                    val displayText = if (text.startsWith("{") && text.contains("\"type\"")) {
                        getString(R.string.ai_chat_fallback_error)
                    } else text
                    messages.add(AiMessage("assistant", displayText))
                    if (displayText.contains("Feedback #") && displayText.contains("recorded")) {
                        messages.add(AiMessage("action", getString(R.string.ai_chat_view_feedback)))
                    }
                }
                poll.status == "failed" -> {
                    messages.add(AiMessage("assistant",
                        poll.error ?: "AI is temporarily unavailable."))
                }
                poll.status == "expired" -> {
                    messages.add(AiMessage("assistant", "Request expired. Please try again."))
                }
                else -> {
                    messages.add(AiMessage("assistant", "Something went wrong. Please try again."))
                }
            }
        } catch (e: Exception) {
            statusJob?.cancel()
            messages.removeAll { it.role == "typing" }
            messages.add(AiMessage("assistant", resolveHttpError(e)))
        } finally {
            isLoading = false
            saveHistory()
            updateUi()
            scrollToBottom()
        }
    }

    // ── Error Handling ────────────────────────

    private fun resolveHttpError(e: Exception): String {
        if (e !is HttpException) {
            return when (e) {
                is java.net.SocketTimeoutException -> getString(R.string.ai_chat_timeout)
                is java.net.UnknownHostException -> getString(R.string.ai_chat_no_internet)
                is java.io.IOException -> getString(R.string.ai_chat_connection_error)
                else -> getString(R.string.ai_chat_network_error)
            }
        }
        val errorBody = try {
            e.response()?.errorBody()?.string()
        } catch (_: Exception) { null }

        val json = try {
            JSONObject(errorBody ?: "{}")
        } catch (_: Exception) { JSONObject() }

        return when (e.code()) {
            401 -> json.optString("message", "").ifEmpty {
                getString(R.string.ai_chat_device_not_registered)
            }
            413 -> getString(R.string.ai_chat_image_too_large)
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

    override fun onDestroy() {
        super.onDestroy()
        pollingJob?.cancel()
        statusJob?.cancel()
    }

    // ── UI Updates ───────────────────────────

    private fun updateUi() {
        val displayMessages = messages.filter { it.role != "typing" || isLoading }
        chatAdapter.submitList(displayMessages.toList())
        emptyState.visibility = if (messages.isEmpty()) View.VISIBLE else View.GONE
        recyclerChat.visibility = if (messages.isEmpty()) View.GONE else View.VISIBLE
    }

    private fun updateSendButton() {
        val hasText = !editMessage.text.isNullOrBlank()
        val hasImages = pendingImages.isNotEmpty()
        btnSend.isEnabled = (hasText || hasImages) && !isLoading
    }

    private fun scrollToBottom() {
        recyclerChat.postDelayed({
            val count = chatAdapter.itemCount
            if (count > 0) recyclerChat.smoothScrollToPosition(count - 1)
        }, 100)
    }

    // ── Persistence ──────────────────────────

    private fun loadHistory() {
        try {
            val prefs = getSharedPreferences("ai_chat", MODE_PRIVATE)
            val json = prefs.getString("history", null) ?: return
            val arr = JSONArray(json)
            messages.clear()
            for (i in 0 until arr.length()) {
                val obj = arr.getJSONObject(i)
                messages.add(AiMessage(
                    role = obj.getString("role"),
                    content = obj.getString("content")
                ))
            }
        } catch (_: Exception) {}
    }

    private fun saveHistory() {
        try {
            val prefs = getSharedPreferences("ai_chat", MODE_PRIVATE)
            val arr = JSONArray()
            for (msg in messages.filter { it.role != "typing" }.takeLast(20)) {
                arr.put(JSONObject().apply {
                    put("role", msg.role)
                    put("content", msg.content)
                })
            }
            prefs.edit().putString("history", arr.toString()).apply()
        } catch (_: Exception) {}
    }

    private fun dpToPx(dp: Int): Int = (dp * resources.displayMetrics.density).toInt()

    // ── Data Classes ─────────────────────────

    data class ImageData(val data: String, val mimeType: String)

    data class AiMessage(
        val role: String, // "user", "assistant", "typing"
        val content: String,
        val images: List<ImageData>? = null
    )

    // ── RecyclerView Adapter ─────────────────

    inner class AiChatAdapter : RecyclerView.Adapter<RecyclerView.ViewHolder>() {

        private var items = listOf<AiMessage>()

        fun submitList(newList: List<AiMessage>) {
            items = newList
            notifyDataSetChanged()
        }

        override fun getItemCount() = items.size

        override fun getItemViewType(position: Int): Int {
            return if (items[position].role == "user") 0 else 1
        }

        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): RecyclerView.ViewHolder {
            val layoutId = if (viewType == 0) R.layout.item_ai_msg_user else R.layout.item_ai_msg_assistant
            val view = LayoutInflater.from(parent.context).inflate(layoutId, parent, false)
            return MessageViewHolder(view)
        }

        override fun onBindViewHolder(holder: RecyclerView.ViewHolder, position: Int) {
            (holder as MessageViewHolder).bind(items[position])
        }

        inner class MessageViewHolder(view: View) : RecyclerView.ViewHolder(view) {
            private val tvMessage: TextView = view.findViewById(R.id.tvMessage)
            private val imageContainer: LinearLayout? = view.findViewById(R.id.imageContainer)

            fun bind(msg: AiMessage) {
                if (msg.role == "typing") {
                    tvMessage.text = msg.content
                    tvMessage.setTypeface(null, Typeface.ITALIC)
                    return
                }

                tvMessage.setTypeface(null, Typeface.NORMAL)

                if (msg.role == "assistant") {
                    // Simple markdown rendering
                    val html = renderMarkdown(msg.content)
                    tvMessage.text = Html.fromHtml(html, Html.FROM_HTML_MODE_COMPACT)
                    tvMessage.movementMethod = LinkMovementMethod.getInstance()
                } else {
                    tvMessage.text = msg.content
                }

                // Show images for user messages
                imageContainer?.let { container ->
                    container.removeAllViews()
                    if (msg.images != null && msg.images.isNotEmpty()) {
                        container.visibility = View.VISIBLE
                        for (img in msg.images) {
                            val iv = ImageView(container.context).apply {
                                layoutParams = LinearLayout.LayoutParams(dpToPx(64), dpToPx(64)).apply {
                                    marginEnd = dpToPx(4)
                                }
                                scaleType = ImageView.ScaleType.CENTER_CROP
                                try {
                                    val bytes = Base64.decode(img.data, Base64.NO_WRAP)
                                    setImageBitmap(BitmapFactory.decodeByteArray(bytes, 0, bytes.size))
                                } catch (_: Exception) {}
                            }
                            container.addView(iv)
                        }
                    } else {
                        container.visibility = View.GONE
                    }
                }
            }

            private fun renderMarkdown(text: String): String {
                var html = text
                    .replace("&", "&amp;")
                    .replace("<", "&lt;")
                    .replace(">", "&gt;")
                // Bold
                html = html.replace(Regex("\\*\\*(.+?)\\*\\*"), "<b>$1</b>")
                // Inline code
                html = html.replace(Regex("`([^`]+)`"), "<tt>$1</tt>")
                // Code blocks (simplified)
                html = html.replace(Regex("```\\w*\\n([\\s\\S]*?)```"), "<pre>$1</pre>")
                // Links
                html = html.replace(Regex("\\[([^]]+)]\\(([^)]+)\\)"), "<a href=\"$2\">$1</a>")
                // Line breaks
                html = html.replace("\n", "<br>")
                return html
            }
        }
    }
}
