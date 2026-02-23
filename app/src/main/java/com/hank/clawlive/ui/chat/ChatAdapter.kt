package com.hank.clawlive.ui.chat

import android.content.ClipData
import android.content.ClipboardManager
import android.media.MediaPlayer
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
import java.io.File
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

    fun getEntityDisplayName(entityId: Int): String {
        return entityNames[entityId]?.let { "$it (#$entityId)" } ?: "Entity $entityId"
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
        private val layoutVoice: LinearLayout = itemView.findViewById(R.id.layoutVoice)
        private val btnPlay: ImageButton = itemView.findViewById(R.id.btnPlay)
        private val progressVoice: ProgressBar = itemView.findViewById(R.id.progressVoice)
        private val tvDuration: TextView = itemView.findViewById(R.id.tvDuration)

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
            if (targets.isNotEmpty() && (targets.size > 1 || isMissionNotify)) {
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
        }

        private fun bindMedia(message: ChatMessage) {
            when (message.mediaType) {
                "photo" -> {
                    ivPhoto.visibility = View.VISIBLE
                    layoutVoice.visibility = View.GONE
                    tvMessage.visibility = if (message.text == "[Photo]") View.GONE else View.VISIBLE
                    if (message.text != "[Photo]") tvMessage.text = message.text
                    Glide.with(itemView.context)
                        .load(message.mediaUrl)
                        .centerCrop()
                        .into(ivPhoto)
                }
                "voice" -> {
                    ivPhoto.visibility = View.GONE
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
        private val layoutVoice: LinearLayout = itemView.findViewById(R.id.layoutVoice)
        private val btnPlay: ImageButton = itemView.findViewById(R.id.btnPlay)
        private val progressVoice: ProgressBar = itemView.findViewById(R.id.progressVoice)
        private val tvDuration: TextView = itemView.findViewById(R.id.tvDuration)

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
            val entityId = message.fromEntityId ?: 0
            val avatarManager = EntityAvatarManager.getInstance(itemView.context)
            tvAvatar.text = avatarManager.getAvatar(entityId)
            tvEntityName.text = adapter.getEntityDisplayName(entityId)

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
        }

        private fun bindMedia(message: ChatMessage) {
            when (message.mediaType) {
                "photo" -> {
                    ivPhoto.visibility = View.VISIBLE
                    layoutVoice.visibility = View.GONE
                    tvMessage.visibility = if (message.text == "[Photo]") View.GONE else View.VISIBLE
                    if (message.text != "[Photo]") tvMessage.text = message.text
                    Glide.with(itemView.context)
                        .load(message.mediaUrl)
                        .centerCrop()
                        .into(ivPhoto)
                }
                "voice" -> {
                    ivPhoto.visibility = View.GONE
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
