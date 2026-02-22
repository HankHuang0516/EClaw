package com.hank.clawlive.ui.mission

import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.ListAdapter
import androidx.recyclerview.widget.RecyclerView
import com.google.android.material.switchmaterial.SwitchMaterial
import com.hank.clawlive.R
import com.hank.clawlive.data.model.MissionSoul

class MissionSoulAdapter(
    private val onSoulClick: (MissionSoul) -> Unit,
    private val onSoulLongClick: (MissionSoul) -> Unit,
    private val onToggle: (MissionSoul) -> Unit
) : ListAdapter<MissionSoul, MissionSoulAdapter.ViewHolder>(DiffCallback()) {

    var entityNames: Map<String, String> = emptyMap()

    private fun getEntityDisplayLabel(entityId: String): String {
        return entityNames[entityId] ?: "Entity $entityId"
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): ViewHolder {
        val view = LayoutInflater.from(parent.context)
            .inflate(R.layout.item_mission_soul, parent, false)
        return ViewHolder(view)
    }

    override fun onBindViewHolder(holder: ViewHolder, position: Int) {
        holder.bind(getItem(position))
    }

    inner class ViewHolder(itemView: View) : RecyclerView.ViewHolder(itemView) {
        private val tvTitle: TextView = itemView.findViewById(R.id.tvTitle)
        private val tvEntities: TextView = itemView.findViewById(R.id.tvEntities)
        private val tvDescription: TextView = itemView.findViewById(R.id.tvDescription)
        private val tvTemplate: TextView = itemView.findViewById(R.id.tvTemplate)
        private val switchActive: SwitchMaterial = itemView.findViewById(R.id.switchActive)

        fun bind(soul: MissionSoul) {
            tvTitle.text = soul.name

            if (soul.assignedEntities.isNotEmpty()) {
                tvEntities.text = soul.assignedEntities.joinToString(", ") { getEntityDisplayLabel(it) }
                tvEntities.visibility = View.VISIBLE
            } else {
                tvEntities.visibility = View.GONE
            }

            if (soul.description.isNotBlank()) {
                tvDescription.text = soul.description.take(100)
                tvDescription.visibility = View.VISIBLE
            } else {
                tvDescription.visibility = View.GONE
            }

            if (soul.templateId != null) {
                tvTemplate.text = soul.templateId
                tvTemplate.visibility = View.VISIBLE
            } else {
                tvTemplate.visibility = View.GONE
            }

            switchActive.setOnCheckedChangeListener(null)
            switchActive.isChecked = soul.isActive
            switchActive.setOnCheckedChangeListener { _, _ -> onToggle(soul) }

            itemView.setOnClickListener { onSoulClick(soul) }
            itemView.setOnLongClickListener {
                onSoulLongClick(soul)
                true
            }
        }
    }

    class DiffCallback : DiffUtil.ItemCallback<MissionSoul>() {
        override fun areItemsTheSame(oldItem: MissionSoul, newItem: MissionSoul) =
            oldItem.id == newItem.id

        override fun areContentsTheSame(oldItem: MissionSoul, newItem: MissionSoul) =
            oldItem == newItem
    }
}
