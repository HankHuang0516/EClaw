package com.hank.clawlive.ui.schedule

import android.graphics.Color
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ImageButton
import android.widget.TextView
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.ListAdapter
import androidx.recyclerview.widget.RecyclerView
import com.hank.clawlive.R
import com.hank.clawlive.data.model.ScheduleItem
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone

class ScheduleAdapter(
    private val showActions: Boolean = true,
    private val onDelete: ((ScheduleItem) -> Unit)? = null,
    var entityNames: Map<Int, String> = emptyMap()
) : ListAdapter<ScheduleItem, ScheduleAdapter.ViewHolder>(DIFF) {

    companion object {
        private val DIFF = object : DiffUtil.ItemCallback<ScheduleItem>() {
            override fun areItemsTheSame(a: ScheduleItem, b: ScheduleItem) = a.id == b.id
            override fun areContentsTheSame(a: ScheduleItem, b: ScheduleItem) = a == b
        }

        private val ENTITY_EMOJIS = mapOf(0 to "\uD83E\uDD9E", 1 to "\uD83D\uDC37", 2 to "\uD83E\uDD9E", 3 to "\uD83D\uDC37")
    }

    inner class ViewHolder(view: View) : RecyclerView.ViewHolder(view) {
        val tvTime: TextView = view.findViewById(R.id.tvTime)
        val tvEntity: TextView = view.findViewById(R.id.tvEntity)
        val tvRepeat: TextView = view.findViewById(R.id.tvRepeat)
        val tvStatus: TextView = view.findViewById(R.id.tvStatus)
        val tvMessage: TextView = view.findViewById(R.id.tvMessage)
        val tvDetail: TextView = view.findViewById(R.id.tvDetail)
        val tvResult: TextView = view.findViewById(R.id.tvResult)
        val btnDelete: ImageButton = view.findViewById(R.id.btnDelete)
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): ViewHolder {
        val view = LayoutInflater.from(parent.context).inflate(R.layout.item_schedule, parent, false)
        return ViewHolder(view)
    }

    override fun onBindViewHolder(holder: ViewHolder, position: Int) {
        val item = getItem(position)
        val ctx = holder.itemView.context

        // Time
        holder.tvTime.text = formatScheduleTime(item)

        // Entity
        val emoji = ENTITY_EMOJIS[item.entityId] ?: "?"
        val name = entityNames[item.entityId] ?: "Entity"
        holder.tvEntity.text = "$emoji $name #${item.entityId}"

        // Repeat badge
        if (item.repeatType != "once") {
            holder.tvRepeat.visibility = View.VISIBLE
            holder.tvRepeat.text = when (item.repeatType) {
                "daily" -> ctx.getString(R.string.schedule_repeat_daily)
                "weekly" -> ctx.getString(R.string.schedule_repeat_weekly)
                "hourly" -> ctx.getString(R.string.schedule_repeat_hourly)
                else -> item.repeatType
            }
        } else {
            holder.tvRepeat.visibility = View.GONE
        }

        // Status
        holder.tvStatus.text = when (item.status) {
            "pending" -> ctx.getString(R.string.schedule_status_pending)
            "active" -> ctx.getString(R.string.schedule_status_active)
            "completed" -> ctx.getString(R.string.schedule_status_completed)
            "failed" -> ctx.getString(R.string.schedule_status_failed)
            else -> item.status
        }
        holder.tvStatus.setTextColor(when (item.status) {
            "pending" -> Color.parseColor("#FFD23F")
            "active" -> Color.parseColor("#4CAF50")
            "completed" -> Color.parseColor("#555555")
            "failed" -> Color.parseColor("#F44336")
            else -> Color.parseColor("#888888")
        })

        // Message
        holder.tvMessage.text = item.message

        // Detail
        val detail = buildString {
            if (!item.label.isNullOrBlank()) append("${item.label} \u00B7 ")
            append("${ctx.getString(R.string.schedule_created)}: ${formatTime(item.createdAt)}")
            if (item.executedAt != null) {
                append(" \u00B7 ${ctx.getString(R.string.schedule_executed)}: ${formatTime(item.executedAt)}")
            }
        }
        holder.tvDetail.text = detail

        // Result
        if (!item.result.isNullOrBlank()) {
            holder.tvResult.visibility = View.VISIBLE
            var resultText = item.result
            try {
                // Try to parse JSON result
                if (resultText.contains("\"pushed\"")) {
                    val pushed = resultText.contains("\"pushed\":true")
                    resultText = if (pushed) "\u2713 ${ctx.getString(R.string.schedule_push_ok)}"
                        else "\u2717 Push failed"
                }
            } catch (_: Exception) { }
            holder.tvResult.text = resultText
            holder.tvResult.setTextColor(
                if (item.resultStatus == "error") Color.parseColor("#F44336")
                else Color.parseColor("#888888")
            )
        } else {
            holder.tvResult.visibility = View.GONE
        }

        // Delete button
        if (showActions && onDelete != null) {
            holder.btnDelete.visibility = View.VISIBLE
            holder.btnDelete.setOnClickListener { onDelete.invoke(item) }
        } else {
            holder.btnDelete.visibility = View.GONE
        }
    }

    private fun formatScheduleTime(item: ScheduleItem): String {
        if (item.scheduledAt != null) return formatTime(item.scheduledAt)
        if (item.cronExpr != null) {
            val parts = item.cronExpr.split(" ")
            if (parts.size >= 2 && parts[0] != "*" && parts[1] != "*") {
                return "${parts[1].padStart(2, '0')}:${parts[0].padStart(2, '0')}"
            }
            return item.cronExpr
        }
        return "-"
    }

    private fun formatTime(isoTime: String?): String {
        if (isoTime == null) return "-"
        return try {
            val sdf = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", Locale.getDefault())
            sdf.timeZone = TimeZone.getTimeZone("UTC")
            val date = sdf.parse(isoTime.substringBefore(".").substringBefore("Z")) ?: return isoTime
            val localFmt = SimpleDateFormat("MM/dd HH:mm", Locale.getDefault())
            localFmt.format(date)
        } catch (_: Exception) {
            isoTime.take(16).replace("T", " ")
        }
    }
}
