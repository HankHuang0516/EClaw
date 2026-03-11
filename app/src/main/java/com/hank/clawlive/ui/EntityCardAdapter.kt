package com.hank.clawlive.ui

import android.graphics.Color
import android.view.LayoutInflater
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.recyclerview.widget.ItemTouchHelper
import androidx.recyclerview.widget.RecyclerView
import com.google.android.material.button.MaterialButton
import com.google.android.material.progressindicator.LinearProgressIndicator
import com.hank.clawlive.R
import com.hank.clawlive.data.model.CharacterState
import com.hank.clawlive.data.model.EntityStatus
import java.text.SimpleDateFormat
import java.util.Collections
import java.util.Date
import java.util.Locale

/**
 * RecyclerView adapter for entity cards with drag-to-reorder support.
 * Edit mode toggles visibility of action buttons and drag handles.
 */
class EntityCardAdapter(
    private val getAvatar: (Int) -> String,
    private val getEntityLabel: (EntityStatus) -> String,
    private val getEntityIdLabel: (Int) -> String,
    private val onAvatarClick: (EntityStatus, TextView) -> Unit,
    private val onNameClick: (EntityStatus) -> Unit,
    private val onRefreshClick: (EntityStatus, MaterialButton) -> Unit,
    private val onRemoveClick: (EntityStatus) -> Unit
) : RecyclerView.Adapter<EntityCardAdapter.ViewHolder>() {

    private val items = mutableListOf<EntityStatus>()
    var isEditMode = false
        set(value) {
            field = value
            notifyDataSetChanged()
        }

    var itemTouchHelper: ItemTouchHelper? = null

    /** Original entity IDs in order, set when data is loaded */
    private var originalOrder = listOf<Int>()

    /** Returns the current order as list of entity IDs (for reorder API) */
    fun getCurrentOrder(): List<Int> = items.map { it.entityId }

    /** Returns true if the order has been changed via drag */
    fun hasOrderChanged(): Boolean = getCurrentOrder() != originalOrder

    fun submitList(entities: List<EntityStatus>) {
        items.clear()
        items.addAll(entities)
        originalOrder = entities.map { it.entityId }
        notifyDataSetChanged()
    }

    /** Called after reorder is persisted to update original order baseline */
    fun markOrderSaved() {
        originalOrder = items.map { it.entityId }
    }

    fun moveItem(from: Int, to: Int) {
        if (from < 0 || to < 0 || from >= items.size || to >= items.size) return
        Collections.swap(items, from, to)
        notifyItemMoved(from, to)
    }

    override fun getItemCount() = items.size

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): ViewHolder {
        val view = LayoutInflater.from(parent.context)
            .inflate(R.layout.item_agent_card, parent, false)
        return ViewHolder(view)
    }

    override fun onBindViewHolder(holder: ViewHolder, position: Int) {
        val entity = items[position]
        holder.bind(entity)
    }

    inner class ViewHolder(itemView: View) : RecyclerView.ViewHolder(itemView) {
        private val tvEntityIcon: TextView = itemView.findViewById(R.id.tvEntityIcon)
        private val tvEntityName: TextView = itemView.findViewById(R.id.tvEntityName)
        private val tvEntityId: TextView = itemView.findViewById(R.id.tvEntityId)
        private val tvStateBadge: TextView = itemView.findViewById(R.id.tvStateBadge)
        private val tvChannelBadge: TextView = itemView.findViewById(R.id.tvChannelBadge)
        private val tvPublicCode: TextView = itemView.findViewById(R.id.tvPublicCode)
        private val tvLastMessage: TextView = itemView.findViewById(R.id.tvLastMessage)
        private val tvMessageTime: TextView = itemView.findViewById(R.id.tvMessageTime)
        private val ivDragHandle: ImageView = itemView.findViewById(R.id.ivDragHandle)
        private val editActionsRow: LinearLayout = itemView.findViewById(R.id.editActionsRow)
        private val btnRefreshEntity: MaterialButton = itemView.findViewById(R.id.btnRefreshEntity)
        private val btnRemoveEntity: MaterialButton = itemView.findViewById(R.id.btnRemoveEntity)
        private val xpBarRow: LinearLayout = itemView.findViewById(R.id.xpBarRow)
        private val tvLevel: TextView = itemView.findViewById(R.id.tvLevel)
        private val xpProgressBar: LinearProgressIndicator = itemView.findViewById(R.id.xpProgressBar)
        private val tvXpText: TextView = itemView.findViewById(R.id.tvXpText)

        private val timeFormat = SimpleDateFormat("HH:mm", Locale.getDefault())

        fun bind(entity: EntityStatus) {
            // Avatar
            tvEntityIcon.text = getAvatar(entity.entityId)
            tvEntityIcon.setOnClickListener { onAvatarClick(entity, tvEntityIcon) }

            // Name
            tvEntityName.text = getEntityLabel(entity)
            tvEntityName.setOnClickListener { onNameClick(entity) }

            // ID
            tvEntityId.text = getEntityIdLabel(entity.entityId)

            // State Badge
            tvStateBadge.text = entity.state.name
            tvStateBadge.setBackgroundColor(getStateBadgeColor(entity.state))

            // Channel Badge
            tvChannelBadge.visibility = if (entity.bindingType == "channel") View.VISIBLE else View.GONE

            // Message
            tvLastMessage.text = entity.message
            tvMessageTime.text = timeFormat.format(Date(entity.lastUpdated))

            // XP/Level bar
            if (entity.isBound) {
                xpBarRow.visibility = View.VISIBLE
                val level = entity.level
                val xp = entity.xp
                val currentThreshold = (level - 1) * (level - 1) * 100
                val nextThreshold = level * level * 100
                val xpInLevel = xp - currentThreshold
                val xpNeeded = nextThreshold - currentThreshold

                tvLevel.text = "Lv.$level"
                tvXpText.text = "$xpInLevel/$xpNeeded XP"
                xpProgressBar.max = if (xpNeeded > 0) xpNeeded else 1
                xpProgressBar.setProgressCompat(xpInLevel.coerceAtLeast(0), true)
            } else {
                xpBarRow.visibility = View.GONE
            }

            // Public code
            if (!entity.publicCode.isNullOrBlank()) {
                tvPublicCode.visibility = View.VISIBLE
                tvPublicCode.text = itemView.context.getString(R.string.entity_public_code, entity.publicCode)
                tvPublicCode.setOnClickListener {
                    val clipboard = itemView.context.getSystemService(android.content.Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
                    clipboard.setPrimaryClip(android.content.ClipData.newPlainText("Public Code", entity.publicCode))
                    android.widget.Toast.makeText(itemView.context, R.string.code_copied, android.widget.Toast.LENGTH_SHORT).show()
                }
            } else {
                tvPublicCode.visibility = View.GONE
            }

            // Edit mode: drag handle + action buttons
            ivDragHandle.visibility = if (isEditMode) View.VISIBLE else View.GONE
            editActionsRow.visibility = if (isEditMode) View.VISIBLE else View.GONE

            // Drag handle touch listener
            ivDragHandle.setOnTouchListener { _, event ->
                if (event.actionMasked == MotionEvent.ACTION_DOWN) {
                    itemTouchHelper?.startDrag(this)
                }
                false
            }

            // Action buttons
            btnRefreshEntity.setOnClickListener { onRefreshClick(entity, btnRefreshEntity) }
            btnRemoveEntity.setOnClickListener { onRemoveClick(entity) }
        }

        private fun getStateBadgeColor(state: CharacterState): Int {
            return when (state) {
                CharacterState.IDLE -> Color.parseColor("#4CAF50")
                CharacterState.BUSY -> Color.parseColor("#2196F3")
                CharacterState.EATING -> Color.parseColor("#FF9800")
                CharacterState.SLEEPING -> Color.parseColor("#607D8B")
                CharacterState.EXCITED -> Color.parseColor("#E91E63")
            }
        }
    }
}
