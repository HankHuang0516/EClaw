package com.hank.clawlive.ui

import android.content.Context
import android.graphics.drawable.GradientDrawable
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.recyclerview.widget.RecyclerView
import com.bumptech.glide.Glide
import com.hank.clawlive.R
import com.hank.clawlive.data.local.EntityAvatarManager
import com.hank.clawlive.data.remote.DeviceFile
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class FileCardAdapter(
    private val context: Context,
    private val onFileClick: (DeviceFile, Int) -> Unit
) : RecyclerView.Adapter<FileCardAdapter.FileViewHolder>() {

    companion object {
        const val VIEW_TYPE_GRID = 0
        const val VIEW_TYPE_LIST = 1
    }

    private val files = mutableListOf<DeviceFile>()
    private val avatarManager = EntityAvatarManager.getInstance(context)
    var isListMode: Boolean = false
        set(value) {
            if (field != value) {
                field = value
                notifyDataSetChanged()
            }
        }

    fun setFiles(newFiles: List<DeviceFile>) {
        files.clear()
        files.addAll(newFiles)
        notifyDataSetChanged()
    }

    fun addFiles(moreFiles: List<DeviceFile>) {
        val start = files.size
        files.addAll(moreFiles)
        notifyItemRangeInserted(start, moreFiles.size)
    }

    override fun getItemViewType(position: Int): Int =
        if (isListMode) VIEW_TYPE_LIST else VIEW_TYPE_GRID

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): FileViewHolder {
        val layoutRes = if (viewType == VIEW_TYPE_LIST) R.layout.item_file_list else R.layout.item_file_card
        val view = LayoutInflater.from(parent.context).inflate(layoutRes, parent, false)
        return FileViewHolder(view)
    }

    override fun onBindViewHolder(holder: FileViewHolder, position: Int) {
        holder.bind(files[position], position)
    }

    override fun getItemCount() = files.size

    inner class FileViewHolder(itemView: View) : RecyclerView.ViewHolder(itemView) {
        private val ivThumbnail: ImageView = itemView.findViewById(R.id.ivThumbnail)
        private val tvVoiceIcon: TextView = itemView.findViewById(R.id.tvVoiceIcon)
        private val tvTypeBadge: TextView = itemView.findViewById(R.id.tvTypeBadge)
        private val tvEntity: TextView = itemView.findViewById(R.id.tvEntity)
        private val tvSource: TextView = itemView.findViewById(R.id.tvSource)
        private val tvText: TextView = itemView.findViewById(R.id.tvText)
        private val tvDate: TextView = itemView.findViewById(R.id.tvDate)
        private val layoutEntityBadges: LinearLayout = itemView.findViewById(R.id.layoutEntityBadges)
        private val tvBroadcastBadge: TextView = itemView.findViewById(R.id.tvBroadcastBadge)

        fun bind(file: DeviceFile, position: Int) {
            // Thumbnail
            if (file.type == "photo") {
                ivThumbnail.visibility = View.VISIBLE
                tvVoiceIcon.visibility = View.GONE
                Glide.with(context)
                    .load(file.url)
                    .centerCrop()
                    .placeholder(android.R.color.darker_gray)
                    .into(ivThumbnail)
            } else {
                ivThumbnail.visibility = View.GONE
                tvVoiceIcon.visibility = View.VISIBLE
            }

            // Type badge
            if (file.type == "photo") {
                tvTypeBadge.text = context.getString(R.string.file_type_photo)
                val bg = GradientDrawable().apply {
                    cornerRadius = 20f
                    setColor(0x334CAF50.toInt())
                }
                tvTypeBadge.background = bg
                tvTypeBadge.setTextColor(0xFF4CAF50.toInt())
            } else {
                tvTypeBadge.text = context.getString(R.string.file_type_voice)
                val bg = GradientDrawable().apply {
                    cornerRadius = 20f
                    setColor(0x336C63FF.toInt())
                }
                tvTypeBadge.background = bg
                tvTypeBadge.setTextColor(0xFF6C63FF.toInt())
            }

            // Entity badges (avatar overlays on thumbnail)
            layoutEntityBadges.removeAllViews()
            val entityIds = file.allEntityIds()
            for (eid in entityIds) {
                val badge = TextView(context).apply {
                    text = avatarManager.getAvatar(eid)
                    textSize = 12f
                    setBackgroundResource(R.drawable.bg_entity_badge)
                    setPadding(6, 2, 6, 2)
                    val lp = LinearLayout.LayoutParams(
                        LinearLayout.LayoutParams.WRAP_CONTENT,
                        LinearLayout.LayoutParams.WRAP_CONTENT
                    )
                    lp.marginEnd = 2
                    layoutParams = lp
                }
                layoutEntityBadges.addView(badge)
            }

            // Broadcast badge
            tvBroadcastBadge.visibility = if (file.isBroadcast()) View.VISIBLE else View.GONE

            // Entity names text
            val entityNames = entityIds.joinToString(", ") { eid ->
                "${avatarManager.getAvatar(eid)} Entity $eid"
            }
            tvEntity.text = entityNames

            // Source
            tvSource.text = if (file.isFromUser) {
                context.getString(R.string.you)
            } else {
                file.source ?: "bot"
            }

            // Text preview
            if (!file.text.isNullOrBlank()) {
                tvText.visibility = View.VISIBLE
                tvText.text = file.text
            } else {
                tvText.visibility = View.GONE
            }

            // Date
            tvDate.text = formatDate(file.createdAt)

            // Click
            itemView.setOnClickListener { onFileClick(file, position) }
        }

        private fun formatDate(isoDate: String): String {
            return try {
                val formats = arrayOf(
                    SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.getDefault()),
                    SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSXXX", Locale.getDefault()),
                    SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", Locale.getDefault())
                )
                var date: Date? = null
                for (fmt in formats) {
                    try {
                        date = fmt.parse(isoDate)
                        if (date != null) break
                    } catch (_: Exception) {}
                }
                if (date != null) {
                    val now = Date()
                    val sameDay = SimpleDateFormat("yyyyMMdd", Locale.getDefault()).format(date) ==
                            SimpleDateFormat("yyyyMMdd", Locale.getDefault()).format(now)
                    if (sameDay) {
                        SimpleDateFormat("HH:mm", Locale.getDefault()).format(date)
                    } else {
                        SimpleDateFormat("MMM d, HH:mm", Locale.getDefault()).format(date)
                    }
                } else {
                    isoDate.take(10)
                }
            } catch (_: Exception) {
                isoDate.take(10)
            }
        }
    }
}
