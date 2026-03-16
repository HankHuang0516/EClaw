package com.hank.clawlive.ui.mission

import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.TextView
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.ListAdapter
import androidx.recyclerview.widget.RecyclerView
import com.hank.clawlive.R
import com.hank.clawlive.data.model.MissionItem
import com.hank.clawlive.data.model.MissionStatus
import io.noties.markwon.Markwon
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

enum class ListMode { TODO, MISSION, DONE }

class MissionItemAdapter(
    private val mode: ListMode,
    private val onItemClick: (MissionItem) -> Unit,
    private val onItemLongClick: (MissionItem) -> Unit
) : ListAdapter<MissionItem, MissionItemAdapter.ViewHolder>(DiffCallback()) {

    /** Entity name lookup map (entityId string -> display name), set from Activity */
    var entityNames: Map<String, String> = emptyMap()

    private fun getEntityDisplayLabel(entityId: String?): String {
        if (entityId.isNullOrEmpty()) return "-"
        return entityId.split(",").joinToString(", ") { id ->
            val trimmed = id.trim()
            entityNames[trimmed] ?: "Entity $trimmed"
        }
    }

    private var markwon: Markwon? = null

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): ViewHolder {
        if (markwon == null) markwon = Markwon.create(parent.context)
        val view = LayoutInflater.from(parent.context)
            .inflate(R.layout.item_mission, parent, false)
        return ViewHolder(view)
    }

    override fun onBindViewHolder(holder: ViewHolder, position: Int) {
        holder.bind(getItem(position))
    }

    inner class ViewHolder(itemView: View) : RecyclerView.ViewHolder(itemView) {
        private val tvPriority: TextView = itemView.findViewById(R.id.tvPriority)
        private val tvTitle: TextView = itemView.findViewById(R.id.tvTitle)
        private val tvStatus: TextView = itemView.findViewById(R.id.tvStatus)
        private val tvDescription: TextView = itemView.findViewById(R.id.tvDescription)
        private val detailsRow: LinearLayout = itemView.findViewById(R.id.detailsRow)
        private val tvBot: TextView = itemView.findViewById(R.id.tvBot)
        private val tvEta: TextView = itemView.findViewById(R.id.tvEta)
        private val tvCompletedAt: TextView = itemView.findViewById(R.id.tvCompletedAt)

        fun bind(item: MissionItem) {
            tvPriority.text = (item.priority?.label ?: "🟡 中").take(2) // emoji only
            tvTitle.text = item.title
            tvStatus.text = item.status?.label ?: "待處理"

            // Description (Markdown)
            if (item.description.isNotBlank()) {
                markwon?.setMarkdown(tvDescription, item.description)
                tvDescription.visibility = View.VISIBLE
            } else {
                tvDescription.visibility = View.GONE
            }

            when (mode) {
                ListMode.TODO -> {
                    if (item.assignedBot != null) {
                        detailsRow.visibility = View.VISIBLE
                        tvBot.text = itemView.context.getString(R.string.bot_label, getEntityDisplayLabel(item.assignedBot))
                        tvEta.visibility = View.GONE
                    } else {
                        detailsRow.visibility = View.GONE
                    }
                    tvCompletedAt.visibility = View.GONE
                }
                ListMode.MISSION -> {
                    detailsRow.visibility = View.VISIBLE
                    tvBot.text = itemView.context.getString(R.string.bot_label, getEntityDisplayLabel(item.assignedBot))
                    tvEta.visibility = View.VISIBLE
                    tvEta.text = if (item.eta != null) "⏰ ${formatDateTime(item.eta)}" else "⏰ -"
                    tvCompletedAt.visibility = View.GONE
                }
                ListMode.DONE -> {
                    detailsRow.visibility = View.GONE
                    if (item.completedAt != null) {
                        tvCompletedAt.text = itemView.context.getString(R.string.mission_completed_at, formatDateTime(item.completedAt))
                        tvCompletedAt.visibility = View.VISIBLE
                    } else {
                        tvCompletedAt.visibility = View.GONE
                    }
                }
            }

            itemView.setOnClickListener { onItemClick(item) }
            itemView.setOnLongClickListener {
                onItemLongClick(item)
                true
            }
        }
    }

    class DiffCallback : DiffUtil.ItemCallback<MissionItem>() {
        override fun areItemsTheSame(oldItem: MissionItem, newItem: MissionItem) =
            oldItem.id == newItem.id

        override fun areContentsTheSame(oldItem: MissionItem, newItem: MissionItem) =
            oldItem == newItem
    }
}

private val dateTimeFormat = SimpleDateFormat("MM/dd HH:mm", Locale.getDefault())

private fun formatDateTime(timestamp: Long): String {
    return dateTimeFormat.format(Date(timestamp))
}
