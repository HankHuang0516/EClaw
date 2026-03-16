package com.hank.clawlive.ui.mission

import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.ListAdapter
import androidx.recyclerview.widget.RecyclerView
import com.hank.clawlive.R
import com.hank.clawlive.data.model.MissionSkill

class MissionSkillAdapter(
    private val onSkillClick: (MissionSkill) -> Unit,
    private val onSkillLongClick: (MissionSkill) -> Unit
) : ListAdapter<MissionSkill, MissionSkillAdapter.ViewHolder>(DiffCallback()) {

    var entityNames: Map<String, String> = emptyMap()

    private fun getEntityDisplayLabel(entityId: String): String {
        return entityNames[entityId] ?: "Entity $entityId"
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): ViewHolder {
        val view = LayoutInflater.from(parent.context)
            .inflate(R.layout.item_mission_skill, parent, false)
        return ViewHolder(view)
    }

    override fun onBindViewHolder(holder: ViewHolder, position: Int) {
        holder.bind(getItem(position))
    }

    inner class ViewHolder(itemView: View) : RecyclerView.ViewHolder(itemView) {
        private val tvTitle: TextView = itemView.findViewById(R.id.tvTitle)
        private val tvEntities: TextView = itemView.findViewById(R.id.tvEntities)
        private val tvUrl: TextView = itemView.findViewById(R.id.tvUrl)

        fun bind(skill: MissionSkill) {
            tvTitle.text = if (skill.isSystem) "\uD83D\uDD12 ${skill.title}" else skill.title

            if (skill.assignedEntities.isNotEmpty()) {
                tvEntities.text = skill.assignedEntities.joinToString(", ") { getEntityDisplayLabel(it) }
                tvEntities.visibility = View.VISIBLE
            } else {
                tvEntities.visibility = View.GONE
            }

            if (skill.url.isNotBlank()) {
                tvUrl.text = skill.url
                tvUrl.visibility = View.VISIBLE
            } else {
                tvUrl.visibility = View.GONE
            }

            itemView.setOnClickListener { onSkillClick(skill) }
            itemView.setOnLongClickListener {
                if (!skill.isSystem) onSkillLongClick(skill)
                true
            }
        }
    }

    class DiffCallback : DiffUtil.ItemCallback<MissionSkill>() {
        override fun areItemsTheSame(oldItem: MissionSkill, newItem: MissionSkill) =
            oldItem.id == newItem.id

        override fun areContentsTheSame(oldItem: MissionSkill, newItem: MissionSkill) =
            oldItem == newItem
    }
}
