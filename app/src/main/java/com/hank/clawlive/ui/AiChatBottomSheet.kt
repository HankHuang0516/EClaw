package com.hank.clawlive.ui

import android.app.Dialog
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
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.google.android.material.bottomsheet.BottomSheetBehavior
import com.google.android.material.bottomsheet.BottomSheetDialog
import com.google.android.material.bottomsheet.BottomSheetDialogFragment
import com.google.android.material.button.MaterialButton
import com.google.android.material.textfield.TextInputEditText
import com.hank.clawlive.R
import com.hank.clawlive.data.remote.TelemetryHelper
import kotlinx.coroutines.launch
import java.io.ByteArrayOutputStream

class AiChatBottomSheet : BottomSheetDialogFragment() {

    private lateinit var viewModel: AiChatViewModel

    private lateinit var recyclerChat: RecyclerView
    private lateinit var editMessage: TextInputEditText
    private lateinit var btnSend: MaterialButton
    private lateinit var btnAttachImage: ImageButton
    private lateinit var btnClearHistory: ImageButton
    private lateinit var btnClose: ImageButton
    private lateinit var emptyState: View
    private lateinit var imagePreviewScroll: View
    private lateinit var imagePreviewContainer: LinearLayout
    private lateinit var tvContextTag: TextView

    private val chatAdapter = AiChatAdapter()
    private val pendingImages = mutableListOf<AiImageData>()

    private val pageName: String
        get() = arguments?.getString(ARG_PAGE_NAME) ?: ""

    private val imagePickerLauncher = registerForActivityResult(
        ActivityResultContracts.GetMultipleContents()
    ) { uris ->
        for (uri in uris) {
            if (pendingImages.size >= 3) break
            addImageFromUri(uri)
        }
    }

    override fun onCreateDialog(savedInstanceState: Bundle?): Dialog {
        val dialog = super.onCreateDialog(savedInstanceState) as BottomSheetDialog
        dialog.setOnShowListener {
            val sheet = dialog.findViewById<View>(com.google.android.material.R.id.design_bottom_sheet)
            sheet?.let {
                val behavior = BottomSheetBehavior.from(it)
                val screenHeight = resources.displayMetrics.heightPixels
                behavior.peekHeight = (screenHeight * 0.7).toInt()
                behavior.skipCollapsed = true
                behavior.state = BottomSheetBehavior.STATE_EXPANDED
                it.setBackgroundColor(0xFF0D0D1A.toInt())
            }
        }
        return dialog
    }

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        return inflater.inflate(R.layout.fragment_ai_chat_sheet, container, false)
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)

        viewModel = ViewModelProvider(requireActivity())[AiChatViewModel::class.java]
        viewModel.pageName = pageName

        initViews(view)
        setupListeners()
        observeState()

        if (pageName.isNotEmpty()) {
            tvContextTag.text = "\uD83D\uDCCD $pageName"
            tvContextTag.visibility = View.VISIBLE
        }
    }

    override fun onResume() {
        super.onResume()
        TelemetryHelper.trackPageView(requireContext(), "ai_chat_sheet")
    }

    // ── View Init ────────────────────────

    private fun initViews(view: View) {
        recyclerChat = view.findViewById(R.id.recyclerChat)
        editMessage = view.findViewById(R.id.editMessage)
        btnSend = view.findViewById(R.id.btnSend)
        btnAttachImage = view.findViewById(R.id.btnAttachImage)
        btnClearHistory = view.findViewById(R.id.btnClearHistory)
        btnClose = view.findViewById(R.id.btnClose)
        emptyState = view.findViewById(R.id.emptyState)
        imagePreviewScroll = view.findViewById(R.id.imagePreviewScroll)
        imagePreviewContainer = view.findViewById(R.id.imagePreviewContainer)
        tvContextTag = view.findViewById(R.id.tvContextTag)

        recyclerChat.layoutManager = LinearLayoutManager(requireContext()).apply {
            stackFromEnd = true
        }
        recyclerChat.adapter = chatAdapter
    }

    private fun setupListeners() {
        btnClose.setOnClickListener { dismiss() }

        btnClearHistory.setOnClickListener {
            AlertDialog.Builder(requireContext())
                .setTitle(R.string.ai_chat_clear_title)
                .setMessage(R.string.ai_chat_clear_message)
                .setPositiveButton(R.string.ai_chat_clear_confirm) { _, _ ->
                    viewModel.clearHistory()
                    pendingImages.clear()
                    renderImagePreview()
                }
                .setNegativeButton(android.R.string.cancel, null)
                .show()
        }

        editMessage.addTextChangedListener(object : android.text.TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
            override fun afterTextChanged(s: android.text.Editable?) { updateSendButton() }
        })

        btnSend.setOnClickListener {
            val text = editMessage.text?.toString()?.trim() ?: ""
            if (text.isEmpty() && pendingImages.isEmpty()) return@setOnClickListener

            val images = if (pendingImages.isNotEmpty()) pendingImages.toList() else null
            viewModel.sendMessage(text, images)

            editMessage.setText("")
            pendingImages.clear()
            renderImagePreview()
            updateSendButton()
        }

        btnAttachImage.setOnClickListener { imagePickerLauncher.launch("image/*") }
    }

    // ── State Observation ────────────────

    private fun observeState() {
        viewLifecycleOwner.lifecycleScope.launch {
            viewLifecycleOwner.repeatOnLifecycle(Lifecycle.State.STARTED) {
                viewModel.uiState.collect { state ->
                    renderMessages(state)
                    updateSendButton(state.isLoading)
                }
            }
        }
    }

    private fun renderMessages(state: AiChatUiState) {
        val displayMessages = state.messages.toMutableList()
        if (state.typingText != null && state.isLoading) {
            displayMessages.add(AiMessage("typing", state.typingText))
        }
        chatAdapter.submitList(displayMessages)
        emptyState.visibility = if (state.messages.isEmpty()) View.VISIBLE else View.GONE
        recyclerChat.visibility = if (state.messages.isEmpty()) View.GONE else View.VISIBLE
        scrollToBottom()
    }

    private fun updateSendButton(isLoading: Boolean = viewModel.uiState.value.isLoading) {
        if (!isAdded) return
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

    // ── Image Handling ──────────────────

    private fun addImageFromUri(uri: Uri) {
        try {
            val inputStream = requireContext().contentResolver.openInputStream(uri) ?: return
            val original = BitmapFactory.decodeStream(inputStream)
            inputStream.close()

            val maxDim = 1024
            val scaled = if (original.width > maxDim || original.height > maxDim) {
                val ratio = minOf(maxDim.toFloat() / original.width, maxDim.toFloat() / original.height)
                Bitmap.createScaledBitmap(original, (original.width * ratio).toInt(), (original.height * ratio).toInt(), true)
            } else original

            val baos = ByteArrayOutputStream()
            scaled.compress(Bitmap.CompressFormat.JPEG, 85, baos)
            val base64 = Base64.encodeToString(baos.toByteArray(), Base64.NO_WRAP)

            pendingImages.add(AiImageData(base64, "image/jpeg"))
            renderImagePreview()
            updateSendButton()
        } catch (e: Exception) {
            Toast.makeText(requireContext(), "Failed to load image", Toast.LENGTH_SHORT).show()
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
            val frame = LinearLayout(requireContext()).apply {
                orientation = LinearLayout.VERTICAL
                layoutParams = LinearLayout.LayoutParams(dpToPx(56), dpToPx(56)).apply {
                    marginEnd = dpToPx(8)
                }
            }
            val imageView = ImageView(requireContext()).apply {
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

    private fun dpToPx(dp: Int): Int = (dp * resources.displayMetrics.density).toInt()

    // ── RecyclerView Adapter ─────────────

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
                    tvMessage.setOnClickListener(null)
                    return
                }

                tvMessage.setTypeface(null, Typeface.NORMAL)

                if (msg.role == "action") {
                    tvMessage.text = msg.content
                    tvMessage.setTextColor(0xFFFFD23F.toInt())
                    tvMessage.setTypeface(null, Typeface.BOLD)
                    tvMessage.setOnClickListener {
                        val intent = android.content.Intent(it.context, com.hank.clawlive.FeedbackHistoryActivity::class.java)
                        it.context.startActivity(intent)
                    }
                    imageContainer?.visibility = View.GONE
                    return
                }

                tvMessage.setTextColor(0xFFE0E0E0.toInt())
                tvMessage.setOnClickListener(null)

                if (msg.role == "assistant") {
                    val html = renderMarkdown(msg.content)
                    tvMessage.text = Html.fromHtml(html, Html.FROM_HTML_MODE_COMPACT)
                    tvMessage.movementMethod = LinkMovementMethod.getInstance()
                } else {
                    tvMessage.text = msg.content
                }

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
                html = html.replace(Regex("\\*\\*(.+?)\\*\\*"), "<b>$1</b>")
                html = html.replace(Regex("`([^`]+)`"), "<tt>$1</tt>")
                html = html.replace(Regex("```\\w*\\n([\\s\\S]*?)```"), "<pre>$1</pre>")
                html = html.replace(Regex("\\[([^]]+)]\\(([^)]+)\\)"), "<a href=\"$2\">$1</a>")
                html = html.replace("\n", "<br>")
                return html
            }
        }
    }

    companion object {
        private const val ARG_PAGE_NAME = "page_name"
        const val TAG = "AiChatBottomSheet"

        fun newInstance(pageName: String): AiChatBottomSheet {
            return AiChatBottomSheet().apply {
                arguments = Bundle().apply {
                    putString(ARG_PAGE_NAME, pageName)
                }
            }
        }
    }
}
