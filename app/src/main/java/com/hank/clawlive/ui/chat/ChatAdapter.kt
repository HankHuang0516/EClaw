package com.hank.clawlive.ui.chat

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.media.MediaPlayer
import android.net.Uri
import android.util.Base64
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ImageButton
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.ListAdapter
import androidx.recyclerview.widget.RecyclerView
import com.bumptech.glide.Glide
import com.hank.clawlive.R
import com.hank.clawlive.data.local.EntityAvatarManager
import com.hank.clawlive.data.local.database.ChatMessage
import com.hank.clawlive.data.local.database.MessageType
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.launch
import java.io.File
import java.net.URL
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Adapter for chat messages with dual ViewHolder types (sent/received)
 * Supports text, photo, and voice messages
 */
class ChatAdapter : ListAdapter<ChatMessage, RecyclerView.ViewHolder>(ChatDiffCallback()) {

    /** Entity name lookup map (entityId -> name), set from Activity */
    var entityNames: Map<Int, String> = emptyMap()

    /** Callback for reaction button clicks: (messageId, reaction: "like"|"dislike"|null) */
    var onReactionClick: ((Long, String?) -> Unit)? = null

    /** Cross-device contact label cache (publicCode -> display name), set from Activity */
    var xdeviceLabels: Map<String, String> = emptyMap()

    fun getEntityDisplayName(entityId: Int): String {
        return entityNames[entityId]?.let { "$it (#$entityId)" } ?: "Entity $entityId"
    }

    fun getXDeviceLabel(code: String): String {
        return xdeviceLabels[code] ?: "\uD83C\uDF10 $code"
    }

    companion object {
        private const val VIEW_TYPE_SENT = 0
        private const val VIEW_TYPE_RECEIVED = 1
    }

    override fun getItemViewType(position: Int): Int {
        return if (getItem(position).isFromUser) VIEW_TYPE_SENT else VIEW_TYPE_RECEIVED
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): RecyclerView.ViewHolder {
        return when (viewType) {
            VIEW_TYPE_SENT -> {
                val view = LayoutInflater.from(parent.context)
                    .inflate(R.layout.item_message_sent, parent, false)
                SentMessageViewHolder(view)
            }
            else -> {
                val view = LayoutInflater.from(parent.context)
                    .inflate(R.layout.item_message_received, parent, false)
                ReceivedMessageViewHolder(view)
            }
        }
    }

    override fun onBindViewHolder(holder: RecyclerView.ViewHolder, position: Int) {
        val message = getItem(position)
        when (holder) {
            is SentMessageViewHolder -> holder.bind(message, this)
            is ReceivedMessageViewHolder -> holder.bind(message, this)
        }
    }

    override fun onViewRecycled(holder: RecyclerView.ViewHolder) {
        super.onViewRecycled(holder)
        when (holder) {
            is SentMessageViewHolder -> holder.stopAudio()
            is ReceivedMessageViewHolder -> holder.stopAudio()
        }
    }

    /**
     * ViewHolder for sent messages (right-aligned, green bubble)
     */
    class SentMessageViewHolder(itemView: View) : RecyclerView.ViewHolder(itemView) {
        private val tvScheduleTag: TextView = itemView.findViewById(R.id.tvScheduleTag)
        private val tvMessage: TextView = itemView.findViewById(R.id.tvMessage)
        private val tvTime: TextView = itemView.findViewById(R.id.tvTime)
        private val tvTargets: TextView = itemView.findViewById(R.id.tvTargets)
        private val tvDeliveryStatus: TextView = itemView.findViewById(R.id.tvDeliveryStatus)
        private val ivPhoto: ImageView = itemView.findViewById(R.id.ivPhoto)
        private val layoutFile: LinearLayout = itemView.findViewById(R.id.layoutFile)
        private val tvFileName: TextView = itemView.findViewById(R.id.tvFileName)
        private val layoutVoice: LinearLayout = itemView.findViewById(R.id.layoutVoice)
        private val btnPlay: ImageButton = itemView.findViewById(R.id.btnPlay)
        private val progressVoice: ProgressBar = itemView.findViewById(R.id.progressVoice)
        private val tvDuration: TextView = itemView.findViewById(R.id.tvDuration)
        private val layoutLinkPreview: LinearLayout = itemView.findViewById(R.id.layoutLinkPreview)
        private val ivLinkPreview: ImageView = itemView.findViewById(R.id.ivLinkPreview)
        private val tvLinkTitle: TextView = itemView.findViewById(R.id.tvLinkTitle)
        private val tvLinkDesc: TextView = itemView.findViewById(R.id.tvLinkDesc)
        private val tvLinkDomain: TextView = itemView.findViewById(R.id.tvLinkDomain)

        private var mediaPlayer: MediaPlayer? = null
        private var tempFile: File? = null

        fun bind(message: ChatMessage, adapter: ChatAdapter) {
            tvTime.text = formatTime(message.timestamp)

            // Long-press to copy message text
            itemView.setOnLongClickListener {
                copyToClipboard(it, message.text)
                true
            }

            // Show schedule tag for scheduled messages
            if (message.source == "scheduled") {
                val label = if (!message.scheduleLabel.isNullOrBlank()) {
                    "\uD83D\uDCC5 ${itemView.context.getString(R.string.schedule_tag)}: ${message.scheduleLabel}"
                } else {
                    "\uD83D\uDCC5 ${itemView.context.getString(R.string.schedule_tag)}"
                }
                tvScheduleTag.text = label
                tvScheduleTag.visibility = View.VISIBLE
            } else {
                tvScheduleTag.visibility = View.GONE
            }

            // Handle media types
            bindMedia(message)

            // Show target entities
            val targets = message.getTargetEntityIdList()
            val isMissionNotify = message.source == "mission_notify"

            if (message.messageType == MessageType.CROSS_DEVICE_SENT && message.targetPublicCode != null) {
                val label = adapter.getXDeviceLabel(message.targetPublicCode)
                tvTargets.text = itemView.context.getString(R.string.to_contact_cross_device, label)
                tvTargets.visibility = View.VISIBLE
            } else if (targets.isNotEmpty() && (targets.size > 1 || isMissionNotify)) {
                tvTargets.text = itemView.context.getString(
                    R.string.to_entities,
                    targets.joinToString(", ") { adapter.getEntityDisplayName(it) }
                )
                tvTargets.visibility = View.VISIBLE
            } else {
                tvTargets.visibility = View.GONE
            }

            // Show per-entity delivery status
            val deliveredIds = message.deliveredTo?.split(",")
                ?.mapNotNull { it.trim().toIntOrNull() }?.toSet() ?: emptySet()
            if (isMissionNotify && targets.isNotEmpty()) {
                tvDeliveryStatus.text = targets.joinToString("  ") { id ->
                    val name = adapter.getEntityDisplayName(id)
                    if (id in deliveredIds) "$name \u2713\u5DF2\u8B80" else "$name ..."
                }
                tvDeliveryStatus.visibility = View.VISIBLE
            } else if (message.isDelivered && deliveredIds.isNotEmpty()) {
                tvDeliveryStatus.text = deliveredIds.joinToString(", ") { adapter.getEntityDisplayName(it) } + " \u5DF2\u8B80"
                tvDeliveryStatus.visibility = View.VISIBLE
            } else {
                tvDeliveryStatus.visibility = View.GONE
            }

            // Link preview
            bindLinkPreview(message)
        }

        private fun bindLinkPreview(message: ChatMessage) {
            val url = LinkPreviewHelper.extractFirstUrl(message.text)
            if (url == null || message.mediaType != null) {
                layoutLinkPreview.visibility = View.GONE
                return
            }
            layoutLinkPreview.visibility = View.GONE // hide until loaded
            val holder = this
            MainScope().launch {
                val data = LinkPreviewHelper.fetch(url) ?: return@launch
                @Suppress("DEPRECATION")
                if (holder.adapterPosition == RecyclerView.NO_POSITION) return@launch
                tvLinkTitle.text = data.title
                tvLinkDesc.text = data.description
                tvLinkDesc.visibility = if (data.description.isNotEmpty()) View.VISIBLE else View.GONE
                try { tvLinkDomain.text = URL(data.url).host } catch (_: Exception) { tvLinkDomain.text = "" }
                if (data.image.isNotEmpty()) {
                    ivLinkPreview.visibility = View.VISIBLE
                    Glide.with(itemView.context).load(data.image).centerCrop().into(ivLinkPreview)
                } else {
                    ivLinkPreview.visibility = View.GONE
                }
                layoutLinkPreview.visibility = View.VISIBLE
                layoutLinkPreview.setOnClickListener {
                    val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url))
                    itemView.context.startActivity(intent)
                }
            }
        }

        private fun bindMedia(message: ChatMessage) {
            when (message.mediaType) {
                "photo" -> {
                    ivPhoto.visibility = View.VISIBLE
                    layoutFile.visibility = View.GONE
                    layoutVoice.visibility = View.GONE
                    tvMessage.visibility = if (message.text == "[Photo]") View.GONE else View.VISIBLE
                    if (message.text != "[Photo]") tvMessage.text = message.text
                    Glide.with(itemView.context)
                        .load(message.mediaUrl)
                        .centerCrop()
                        .into(ivPhoto)
                }
                "video" -> {
                    ivPhoto.visibility = View.VISIBLE
                    layoutFile.visibility = View.GONE
                    layoutVoice.visibility = View.GONE
                    tvMessage.visibility = if (message.text == "[Video]") View.GONE else View.VISIBLE
                    if (message.text != "[Video]") tvMessage.text = message.text
                    Glide.with(itemView.context)
                        .load(message.mediaUrl)
                        .centerCrop()
                        .into(ivPhoto)
                    ivPhoto.setOnClickListener {
                        val intent = Intent(Intent.ACTION_VIEW).apply {
                            setDataAndType(Uri.parse(message.mediaUrl), "video/*")
                        }
                        itemView.context.startActivity(intent)
                    }
                }
                "file" -> {
                    ivPhoto.visibility = View.GONE
                    layoutFile.visibility = View.VISIBLE
                    layoutVoice.visibility = View.GONE
                    val isPlaceholder = message.text.startsWith("[File]")
                    tvMessage.visibility = if (isPlaceholder) View.GONE else View.VISIBLE
                    if (!isPlaceholder) tvMessage.text = message.text
                    tvFileName.text = extractFileName(message.text, message.mediaUrl)
                    layoutFile.setOnClickListener {
                        openFileUrl(itemView, message.mediaUrl ?: "")
                    }
                }
                "voice" -> {
                    ivPhoto.visibility = View.GONE
                    layoutFile.visibility = View.GONE
                    layoutVoice.visibility = View.VISIBLE
                    tvMessage.visibility = View.GONE
                    val durationMatch = Regex("\\d+").find(message.text)
                    val seconds = durationMatch?.value?.toIntOrNull() ?: 0
                    tvDuration.text = String.format("%d:%02d", seconds / 60, seconds % 60)
                    progressVoice.progress = 0
                    btnPlay.setImageResource(android.R.drawable.ic_media_play)
                    btnPlay.setOnClickListener { toggleVoicePlayback(message.mediaUrl ?: "") }
                }
                else -> {
                    ivPhoto.visibility = View.GONE
                    layoutFile.visibility = View.GONE
                    layoutVoice.visibility = View.GONE
                    tvMessage.visibility = View.VISIBLE
                    tvMessage.text = message.text
                }
            }
        }

        private fun toggleVoicePlayback(dataUri: String) {
            if (mediaPlayer?.isPlaying == true) {
                stopAudio()
                return
            }
            try {
                val base64Data = dataUri.substringAfter("base64,")
                val audioBytes = Base64.decode(base64Data, Base64.DEFAULT)
                tempFile = File.createTempFile("voice_", ".webm", itemView.context.cacheDir)
                tempFile!!.writeBytes(audioBytes)

                mediaPlayer = MediaPlayer().apply {
                    setDataSource(tempFile!!.absolutePath)
                    prepare()
                    start()
                    btnPlay.setImageResource(android.R.drawable.ic_media_pause)
                    setOnCompletionListener { stopAudio() }
                }
            } catch (e: Exception) {
                Toast.makeText(itemView.context, R.string.playback_failed, Toast.LENGTH_SHORT).show()
            }
        }

        fun stopAudio() {
            mediaPlayer?.release()
            mediaPlayer = null
            tempFile?.delete()
            tempFile = null
            btnPlay.setImageResource(android.R.drawable.ic_media_play)
            progressVoice.progress = 0
        }
    }

    /**
     * ViewHolder for received messages (left-aligned, gray bubble)
     */
    class ReceivedMessageViewHolder(itemView: View) : RecyclerView.ViewHolder(itemView) {
        private val tvAvatar: TextView = itemView.findViewById(R.id.tvAvatar)
        private val tvEntityName: TextView = itemView.findViewById(R.id.tvEntityName)
        private val tvMessage: TextView = itemView.findViewById(R.id.tvMessage)
        private val tvTime: TextView = itemView.findViewById(R.id.tvTime)
        private val tvReadReceipt: TextView = itemView.findViewById(R.id.tvReadReceipt)
        private val ivPhoto: ImageView = itemView.findViewById(R.id.ivPhoto)
        private val layoutFile: LinearLayout = itemView.findViewById(R.id.layoutFile)
        private val tvFileName: TextView = itemView.findViewById(R.id.tvFileName)
        private val layoutVoice: LinearLayout = itemView.findViewById(R.id.layoutVoice)
        private val btnPlay: ImageButton = itemView.findViewById(R.id.btnPlay)
        private val progressVoice: ProgressBar = itemView.findViewById(R.id.progressVoice)
        private val tvDuration: TextView = itemView.findViewById(R.id.tvDuration)
        private val layoutLinkPreview: LinearLayout = itemView.findViewById(R.id.layoutLinkPreview)
        private val ivLinkPreview: ImageView = itemView.findViewById(R.id.ivLinkPreview)
        private val tvLinkTitle: TextView = itemView.findViewById(R.id.tvLinkTitle)
        private val tvLinkDesc: TextView = itemView.findViewById(R.id.tvLinkDesc)
        private val tvLinkDomain: TextView = itemView.findViewById(R.id.tvLinkDomain)

        // Reaction UI
        private val layoutReactions: LinearLayout = itemView.findViewById(R.id.layoutReactions)
        private val btnLike: ImageButton = itemView.findViewById(R.id.btnLike)
        private val tvLikeCount: TextView = itemView.findViewById(R.id.tvLikeCount)
        private val btnDislike: ImageButton = itemView.findViewById(R.id.btnDislike)
        private val tvDislikeCount: TextView = itemView.findViewById(R.id.tvDislikeCount)

        private var mediaPlayer: MediaPlayer? = null
        private var tempFile: File? = null

        fun bind(message: ChatMessage, adapter: ChatAdapter) {
            tvTime.text = formatTime(message.timestamp)

            // Long-press to copy message text
            itemView.setOnLongClickListener {
                copyToClipboard(it, message.text)
                true
            }

            // Entity name and avatar
            val avatarManager = EntityAvatarManager.getInstance(itemView.context)
            if (message.messageType == MessageType.CROSS_DEVICE_RECEIVED && message.fromPublicCode != null) {
                tvAvatar.text = "\uD83C\uDF10"  // 🌐 globe
                tvEntityName.text = adapter.getXDeviceLabel(message.fromPublicCode)
            } else {
                val entityId = message.fromEntityId ?: 0
                tvAvatar.text = avatarManager.getAvatar(entityId)
                tvEntityName.text = adapter.getEntityDisplayName(entityId)
            }

            // Handle media types
            bindMedia(message)

            // Show read receipt footer for entity-to-entity / broadcast messages
            val targets = message.getTargetEntityIdList()
            if (targets.isNotEmpty()) {
                val deliveredIds = message.deliveredTo?.split(",")
                    ?.mapNotNull { it.trim().toIntOrNull() }?.toSet() ?: emptySet()

                val footer = "\u767C\u9001\u81F3: " + targets.joinToString(", ") { id ->
                    val avatar = avatarManager.getAvatar(id)
                    val name = adapter.getEntityDisplayName(id)
                    if (id in deliveredIds) "$avatar $name \u5DF2\u8B80" else "$avatar $name"
                }
                tvReadReceipt.text = footer
                tvReadReceipt.visibility = View.VISIBLE
            } else {
                tvReadReceipt.visibility = View.GONE
            }

            // Reaction buttons (only for bot messages, not entity-to-entity)
            bindReactions(message, adapter)

            // Link preview
            bindLinkPreview(message)
        }

        private fun bindReactions(message: ChatMessage, adapter: ChatAdapter) {
            // Show reactions for all received messages
            layoutReactions.visibility = View.VISIBLE

            // Update like button state
            val isLiked = message.userReaction == "like"
            btnLike.setImageResource(
                if (isLiked) R.drawable.ic_thumb_up_filled else R.drawable.ic_thumb_up_outline
            )
            if (message.likeCount > 0) {
                tvLikeCount.text = message.likeCount.toString()
                tvLikeCount.visibility = View.VISIBLE
            } else {
                tvLikeCount.visibility = View.GONE
            }

            // Update dislike button state
            val isDisliked = message.userReaction == "dislike"
            btnDislike.setImageResource(
                if (isDisliked) R.drawable.ic_thumb_down_filled else R.drawable.ic_thumb_down_outline
            )
            if (message.dislikeCount > 0) {
                tvDislikeCount.text = message.dislikeCount.toString()
                tvDislikeCount.visibility = View.VISIBLE
            } else {
                tvDislikeCount.visibility = View.GONE
            }

            // Click handlers — toggle reaction
            btnLike.setOnClickListener {
                val newReaction = if (isLiked) null else "like"
                adapter.onReactionClick?.invoke(message.id, newReaction)
            }
            btnDislike.setOnClickListener {
                val newReaction = if (isDisliked) null else "dislike"
                adapter.onReactionClick?.invoke(message.id, newReaction)
            }
        }

        private fun bindLinkPreview(message: ChatMessage) {
            val url = LinkPreviewHelper.extractFirstUrl(message.text)
            if (url == null || message.mediaType != null) {
                layoutLinkPreview.visibility = View.GONE
                return
            }
            layoutLinkPreview.visibility = View.GONE // hide until loaded
            val holder = this
            MainScope().launch {
                val data = LinkPreviewHelper.fetch(url) ?: return@launch
                @Suppress("DEPRECATION")
                if (holder.adapterPosition == RecyclerView.NO_POSITION) return@launch
                tvLinkTitle.text = data.title
                tvLinkDesc.text = data.description
                tvLinkDesc.visibility = if (data.description.isNotEmpty()) View.VISIBLE else View.GONE
                try { tvLinkDomain.text = URL(data.url).host } catch (_: Exception) { tvLinkDomain.text = "" }
                if (data.image.isNotEmpty()) {
                    ivLinkPreview.visibility = View.VISIBLE
                    Glide.with(itemView.context).load(data.image).centerCrop().into(ivLinkPreview)
                } else {
                    ivLinkPreview.visibility = View.GONE
                }
                layoutLinkPreview.visibility = View.VISIBLE
                layoutLinkPreview.setOnClickListener {
                    val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url))
                    itemView.context.startActivity(intent)
                }
            }
        }

        private fun bindMedia(message: ChatMessage) {
            when (message.mediaType) {
                "photo" -> {
                    ivPhoto.visibility = View.VISIBLE
                    layoutFile.visibility = View.GONE
                    layoutVoice.visibility = View.GONE
                    tvMessage.visibility = if (message.text == "[Photo]") View.GONE else View.VISIBLE
                    if (message.text != "[Photo]") tvMessage.text = message.text
                    Glide.with(itemView.context)
                        .load(message.mediaUrl)
                        .centerCrop()
                        .into(ivPhoto)
                }
                "video" -> {
                    ivPhoto.visibility = View.VISIBLE
                    layoutFile.visibility = View.GONE
                    layoutVoice.visibility = View.GONE
                    tvMessage.visibility = if (message.text == "[Video]") View.GONE else View.VISIBLE
                    if (message.text != "[Video]") tvMessage.text = message.text
                    Glide.with(itemView.context)
                        .load(message.mediaUrl)
                        .centerCrop()
                        .into(ivPhoto)
                    ivPhoto.setOnClickListener {
                        val intent = Intent(Intent.ACTION_VIEW).apply {
                            setDataAndType(Uri.parse(message.mediaUrl), "video/*")
                        }
                        itemView.context.startActivity(intent)
                    }
                }
                "file" -> {
                    ivPhoto.visibility = View.GONE
                    layoutFile.visibility = View.VISIBLE
                    layoutVoice.visibility = View.GONE
                    val isPlaceholder = message.text.startsWith("[File]")
                    tvMessage.visibility = if (isPlaceholder) View.GONE else View.VISIBLE
                    if (!isPlaceholder) tvMessage.text = message.text
                    tvFileName.text = extractFileName(message.text, message.mediaUrl)
                    layoutFile.setOnClickListener {
                        openFileUrl(itemView, message.mediaUrl ?: "")
                    }
                }
                "voice" -> {
                    ivPhoto.visibility = View.GONE
                    layoutFile.visibility = View.GONE
                    layoutVoice.visibility = View.VISIBLE
                    tvMessage.visibility = View.GONE
                    val durationMatch = Regex("\\d+").find(message.text)
                    val seconds = durationMatch?.value?.toIntOrNull() ?: 0
                    tvDuration.text = String.format("%d:%02d", seconds / 60, seconds % 60)
                    progressVoice.progress = 0
                    btnPlay.setImageResource(android.R.drawable.ic_media_play)
                    btnPlay.setOnClickListener { toggleVoicePlayback(message.mediaUrl ?: "") }
                }
                else -> {
                    ivPhoto.visibility = View.GONE
                    layoutFile.visibility = View.GONE
                    layoutVoice.visibility = View.GONE
                    tvMessage.visibility = View.VISIBLE
                    tvMessage.text = message.text
                }
            }
        }

        private fun toggleVoicePlayback(dataUri: String) {
            if (mediaPlayer?.isPlaying == true) {
                stopAudio()
                return
            }
            try {
                val base64Data = dataUri.substringAfter("base64,")
                val audioBytes = Base64.decode(base64Data, Base64.DEFAULT)
                tempFile = File.createTempFile("voice_", ".webm", itemView.context.cacheDir)
                tempFile!!.writeBytes(audioBytes)

                mediaPlayer = MediaPlayer().apply {
                    setDataSource(tempFile!!.absolutePath)
                    prepare()
                    start()
                    btnPlay.setImageResource(android.R.drawable.ic_media_pause)
                    setOnCompletionListener { stopAudio() }
                }
            } catch (e: Exception) {
                Toast.makeText(itemView.context, R.string.playback_failed, Toast.LENGTH_SHORT).show()
            }
        }

        fun stopAudio() {
            mediaPlayer?.release()
            mediaPlayer = null
            tempFile?.delete()
            tempFile = null
            btnPlay.setImageResource(android.R.drawable.ic_media_play)
            progressVoice.progress = 0
        }
    }

    /**
     * DiffUtil callback for efficient list updates
     */
    class ChatDiffCallback : DiffUtil.ItemCallback<ChatMessage>() {
        override fun areItemsTheSame(oldItem: ChatMessage, newItem: ChatMessage): Boolean {
            return oldItem.id == newItem.id
        }

        override fun areContentsTheSame(oldItem: ChatMessage, newItem: ChatMessage): Boolean {
            return oldItem == newItem
        }
    }
}

/**
 * Format timestamp to readable time string
 */
private fun formatTime(timestamp: Long): String {
    val sdf = SimpleDateFormat("HH:mm", Locale.getDefault())
    return sdf.format(Date(timestamp))
}

/**
 * Copy text to clipboard and show toast
 */
private fun copyToClipboard(view: View, text: String) {
    val context = view.context
    val clipboard = context.getSystemService(android.content.Context.CLIPBOARD_SERVICE) as ClipboardManager
    clipboard.setPrimaryClip(ClipData.newPlainText("chat_message", text))
    Toast.makeText(context, context.getString(R.string.message_copied), Toast.LENGTH_SHORT).show()
}

/**
 * Extract file name from message text or URL
 */
private fun extractFileName(text: String, mediaUrl: String?): String {
    if (text.startsWith("[File] ")) return text.removePrefix("[File] ")
    if (mediaUrl != null) {
        try {
            val path = Uri.parse(mediaUrl).lastPathSegment
            if (!path.isNullOrBlank()) return path
        } catch (_: Exception) {}
    }
    return "File"
}

/**
 * Open a file URL in the browser
 */
private fun openFileUrl(view: View, url: String) {
    try {
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url))
        view.context.startActivity(intent)
    } catch (e: Exception) {
        Toast.makeText(view.context, "Cannot open file", Toast.LENGTH_SHORT).show()
    }
}
