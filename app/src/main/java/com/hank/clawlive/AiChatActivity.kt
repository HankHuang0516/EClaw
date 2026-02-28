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
import com.hank.clawlive.data.remote.AiChatResponse
import com.hank.clawlive.data.remote.NetworkModule
import com.hank.clawlive.data.remote.TelemetryHelper
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream

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

    // ── Send Message ─────────────────────────

    private val MAX_RETRY = 3

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

        // Show typing indicator — with upload status if images present
        val typingText = if (images != null) getString(R.string.ai_chat_uploading) else "..."
        messages.add(AiMessage("typing", typingText))
        updateUi()
        scrollToBottom()

        isLoading = true

        val body = mutableMapOf<String, Any>(
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
            callWithRetry(body, 0)
        }
    }

    private suspend fun callWithRetry(body: Map<String, Any>, attempt: Int) {
        // Progressive status for image uploads
        val hasImages = body.containsKey("images")
        var statusJob: kotlinx.coroutines.Job? = null
        if (hasImages && attempt == 0) {
            statusJob = lifecycleScope.launch {
                kotlinx.coroutines.delay(4000)
                messages.removeAll { it.role == "typing" }
                messages.add(AiMessage("typing", getString(R.string.ai_chat_analyzing)))
                updateUi()
                kotlinx.coroutines.delay(11000)
                messages.removeAll { it.role == "typing" }
                messages.add(AiMessage("typing", getString(R.string.ai_chat_thinking)))
                updateUi()
            }
        }

        try {
            val response: AiChatResponse = api.aiChat(body)
            statusJob?.cancel()

            // Handle busy — auto-retry with countdown
            if (response.busy && attempt < MAX_RETRY) {
                val waitSec = response.retry_after ?: 15
                for (sec in waitSec downTo 1) {
                    messages.removeAll { it.role == "typing" }
                    messages.add(AiMessage("typing", getString(R.string.ai_chat_busy_retry, sec, attempt + 1, MAX_RETRY)))
                    updateUi()
                    scrollToBottom()
                    kotlinx.coroutines.delay(1000)
                }
                messages.removeAll { it.role == "typing" }
                messages.add(AiMessage("typing", "..."))
                updateUi()
                scrollToBottom()
                return callWithRetry(body, attempt + 1)
            }

            // Remove typing indicator
            messages.removeAll { it.role == "typing" }

            if (response.busy) {
                messages.add(AiMessage("assistant", getString(R.string.ai_chat_busy_exhausted)))
            } else if (response.success && response.response != null) {
                messages.add(AiMessage("assistant", response.response))
            } else {
                val errorMsg = response.message ?: response.error ?: "AI is temporarily unavailable"
                messages.add(AiMessage("assistant", errorMsg))
            }
        } catch (e: Exception) {
            messages.removeAll { it.role == "typing" }
            messages.add(AiMessage("assistant", "Sorry, something went wrong. Please try again."))
        } finally {
            isLoading = false
            saveHistory()
            updateUi()
            scrollToBottom()
        }
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
                    tvMessage.text = "..."
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
