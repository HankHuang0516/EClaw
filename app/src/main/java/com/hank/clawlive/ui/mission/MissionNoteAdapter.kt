package com.hank.clawlive.ui.mission

import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.ListAdapter
import androidx.recyclerview.widget.RecyclerView
import com.hank.clawlive.R
import com.hank.clawlive.data.model.MissionNote
class MissionNoteAdapter(
    private val onNoteClick: (MissionNote) -> Unit,
    private val onNoteLongClick: (MissionNote) -> Unit,
    private val onPageBadgeClick: (MissionNote) -> Unit = {}
) : ListAdapter<MissionNote, MissionNoteAdapter.ViewHolder>(DiffCallback()) {

    var notePageIds: Set<String> = emptySet()
        set(value) {
            if (field != value) {
                field = value
                notifyDataSetChanged()
            }
        }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): ViewHolder {
        val view = LayoutInflater.from(parent.context)
            .inflate(R.layout.item_mission_note, parent, false)
        return ViewHolder(view)
    }

    override fun onBindViewHolder(holder: ViewHolder, position: Int) {
        holder.bind(getItem(position))
    }

    inner class ViewHolder(itemView: View) : RecyclerView.ViewHolder(itemView) {
        private val tvTitle: TextView = itemView.findViewById(R.id.tvTitle)
        private val tvContent: TextView = itemView.findViewById(R.id.tvContent)
        private val tvCategory: TextView = itemView.findViewById(R.id.tvCategory)
        private val tvPageBadge: TextView = itemView.findViewById(R.id.tvPageBadge)

        fun bind(note: MissionNote) {
            tvTitle.text = note.title
            // Truncate content preview to 80 chars (aligned with Web Portal)
            val preview = (note.content ?: "").take(80)
            tvContent.maxLines = 1
            tvContent.text = preview
            tvCategory.text = note.category ?: ""

            val hasPage = notePageIds.contains(note.id)
            tvPageBadge.visibility = if (hasPage) View.VISIBLE else View.GONE
            tvPageBadge.setOnClickListener { onPageBadgeClick(note) }

            itemView.setOnClickListener { onNoteClick(note) }
            itemView.setOnLongClickListener {
                onNoteLongClick(note)
                true
            }
        }
    }

    class DiffCallback : DiffUtil.ItemCallback<MissionNote>() {
        override fun areItemsTheSame(oldItem: MissionNote, newItem: MissionNote) =
            oldItem.id == newItem.id

        override fun areContentsTheSame(oldItem: MissionNote, newItem: MissionNote) =
            oldItem == newItem
    }
}
