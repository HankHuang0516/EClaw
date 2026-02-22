package com.hank.clawlive

import android.content.Intent
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.widget.HorizontalScrollView
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.updatePadding
import androidx.lifecycle.lifecycleScope
import com.hank.clawlive.data.local.DeviceManager
import com.hank.clawlive.data.model.FeedbackItem
import com.hank.clawlive.data.remote.NetworkModule
import com.hank.clawlive.data.remote.TelemetryHelper
import com.hank.clawlive.ui.RecordingIndicatorHelper
import kotlinx.coroutines.launch
import timber.log.Timber
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class FeedbackHistoryActivity : AppCompatActivity() {

    private val deviceManager: DeviceManager by lazy { DeviceManager.getInstance(this) }

    private lateinit var progressLoading: ProgressBar
    private lateinit var layoutEmpty: LinearLayout
    private lateinit var layoutFeedbackList: LinearLayout
    private lateinit var topBar: LinearLayout

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        setContentView(R.layout.activity_feedback_history)

        topBar = findViewById(R.id.topBar)
        progressLoading = findViewById(R.id.progressLoading)
        layoutEmpty = findViewById(R.id.layoutEmpty)
        layoutFeedbackList = findViewById(R.id.layoutFeedbackList)

        setupEdgeToEdgeInsets()

        findViewById<ImageButton>(R.id.btnBack).setOnClickListener { finish() }

        loadFeedbackList()
    }

    override fun onResume() {
        super.onResume()
        TelemetryHelper.trackPageView(this, "feedback_history")
        RecordingIndicatorHelper.attach(this)
    }

    override fun onPause() {
        super.onPause()
        RecordingIndicatorHelper.detach()
    }

    private fun setupEdgeToEdgeInsets() {
        ViewCompat.setOnApplyWindowInsetsListener(findViewById(android.R.id.content)) { _, windowInsets ->
            val insets = windowInsets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
            )
            topBar.updatePadding(
                left = insets.left + dpToPx(8),
                top = insets.top + dpToPx(8),
                right = insets.right + dpToPx(8)
            )
            WindowInsetsCompat.CONSUMED
        }
    }

    private fun dpToPx(dp: Int): Int {
        return (dp * resources.displayMetrics.density).toInt()
    }

    private fun loadFeedbackList() {
        progressLoading.visibility = View.VISIBLE
        layoutEmpty.visibility = View.GONE
        layoutFeedbackList.removeAllViews()

        lifecycleScope.launch {
            try {
                val response = NetworkModule.api.getFeedbackList(
                    deviceId = deviceManager.deviceId,
                    deviceSecret = deviceManager.deviceSecret
                )
                progressLoading.visibility = View.GONE

                if (response.feedback.isEmpty()) {
                    layoutEmpty.visibility = View.VISIBLE
                } else {
                    response.feedback.forEach { item ->
                        layoutFeedbackList.addView(createFeedbackCard(item))
                    }
                }
            } catch (e: Exception) {
                Timber.e(e, "Failed to load feedback list")
                TelemetryHelper.trackError(e, mapOf("action" to "load_feedback_list"))
                progressLoading.visibility = View.GONE
                layoutEmpty.visibility = View.VISIBLE
                Toast.makeText(
                    this@FeedbackHistoryActivity,
                    getString(R.string.failed_format, e.message),
                    Toast.LENGTH_SHORT
                ).show()
            }
        }
    }

    private fun createFeedbackCard(item: FeedbackItem): View {
        val cardBg = 0xFF1A1A1A.toInt()
        val borderColor = 0xFF333333.toInt()
        val accentColor = 0xFFFFD23F.toInt()
        val textPrimary = 0xFFFFFFFF.toInt()
        val textSecondary = 0xFF999999.toInt()

        val card = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dpToPx(14), dpToPx(14), dpToPx(14), dpToPx(14))
            val bg = GradientDrawable().apply {
                cornerRadius = dpToPx(12).toFloat()
                setColor(cardBg)
                setStroke(dpToPx(1), borderColor)
            }
            background = bg
            val lp = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            )
            lp.bottomMargin = dpToPx(10)
            layoutParams = lp
        }

        // Top row: category badge + severity + status
        val topRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }

        // Category badge
        val catBadge = TextView(this).apply {
            text = when (item.category) {
                "feature" -> getString(R.string.feedback_cat_feature)
                "question" -> getString(R.string.feedback_cat_question)
                else -> getString(R.string.feedback_cat_bug)
            }
            textSize = 11f
            setTypeface(null, Typeface.BOLD)
            val catColor = when (item.category) {
                "feature" -> 0xFF2196F3.toInt()
                "question" -> 0xFF9C27B0.toInt()
                else -> 0xFFF44336.toInt()
            }
            setTextColor(catColor)
            setPadding(dpToPx(8), dpToPx(3), dpToPx(8), dpToPx(3))
            val bg = GradientDrawable().apply {
                cornerRadius = dpToPx(10).toFloat()
                setStroke(dpToPx(1), catColor)
                setColor(catColor and 0x20FFFFFF)
            }
            background = bg
        }
        topRow.addView(catBadge)

        // Severity
        val severityView = TextView(this).apply {
            val sevColor = when (item.severity) {
                "critical" -> 0xFFF44336.toInt()
                "high" -> 0xFFFF9800.toInt()
                "medium" -> 0xFFFFC107.toInt()
                else -> 0xFF4CAF50.toInt()
            }
            text = item.severity ?: "low"
            textSize = 11f
            setTextColor(sevColor)
            setPadding(dpToPx(8), dpToPx(3), dpToPx(8), dpToPx(3))
            val lp = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            )
            lp.marginStart = dpToPx(6)
            layoutParams = lp
        }
        topRow.addView(severityView)

        // Spacer
        val spacer = View(this).apply {
            layoutParams = LinearLayout.LayoutParams(0, 0, 1f)
        }
        topRow.addView(spacer)

        // Status badge
        val statusView = TextView(this).apply {
            val statusColor = when (item.status) {
                "resolved" -> 0xFF4CAF50.toInt()
                "in_progress" -> 0xFF2196F3.toInt()
                "closed" -> 0xFF666666.toInt()
                else -> accentColor
            }
            text = item.status ?: "open"
            textSize = 11f
            setTextColor(statusColor)
            setPadding(dpToPx(8), dpToPx(3), dpToPx(8), dpToPx(3))
            val bg = GradientDrawable().apply {
                cornerRadius = dpToPx(10).toFloat()
                setStroke(dpToPx(1), statusColor)
                setColor(statusColor and 0x20FFFFFF)
            }
            background = bg
        }
        topRow.addView(statusView)

        card.addView(topRow)

        // Feedback ID + date row
        val dateRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            val lp = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            )
            lp.topMargin = dpToPx(8)
            layoutParams = lp
        }

        val idText = TextView(this).apply {
            text = "#${item.id}"
            textSize = 12f
            setTypeface(null, Typeface.BOLD)
            setTextColor(textSecondary)
        }
        dateRow.addView(idText)

        val dateText = TextView(this).apply {
            text = formatTimestamp(item.created_at)
            textSize = 12f
            setTextColor(textSecondary)
            val lp = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            )
            lp.marginStart = dpToPx(8)
            layoutParams = lp
        }
        dateRow.addView(dateText)
        card.addView(dateRow)

        // Message
        val messageView = TextView(this).apply {
            text = item.message ?: ""
            textSize = 14f
            setTextColor(textPrimary)
            maxLines = 3
            val lp = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            )
            lp.topMargin = dpToPx(6)
            layoutParams = lp
        }
        card.addView(messageView)

        // Tags
        if (!item.tags.isNullOrEmpty()) {
            val tagsScroll = HorizontalScrollView(this).apply {
                isHorizontalScrollBarEnabled = false
                val lp = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT
                )
                lp.topMargin = dpToPx(8)
                layoutParams = lp
            }
            val tagsRow = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
            }
            item.tags.forEach { tag ->
                val tagView = TextView(this).apply {
                    text = tag
                    textSize = 10f
                    setTextColor(accentColor)
                    setPadding(dpToPx(6), dpToPx(2), dpToPx(6), dpToPx(2))
                    val bg = GradientDrawable().apply {
                        cornerRadius = dpToPx(8).toFloat()
                        setStroke(dpToPx(1), accentColor)
                        setColor(0x1AFFD23F)
                    }
                    background = bg
                    val lp = LinearLayout.LayoutParams(
                        LinearLayout.LayoutParams.WRAP_CONTENT,
                        LinearLayout.LayoutParams.WRAP_CONTENT
                    )
                    lp.marginEnd = dpToPx(4)
                    layoutParams = lp
                }
                tagsRow.addView(tagView)
            }
            tagsScroll.addView(tagsRow)
            card.addView(tagsScroll)
        }

        // GitHub issue link
        if (!item.github_issue_url.isNullOrBlank()) {
            val issueLink = TextView(this).apply {
                text = getString(R.string.feedback_view_issue)
                textSize = 13f
                setTextColor(accentColor)
                paintFlags = paintFlags or android.graphics.Paint.UNDERLINE_TEXT_FLAG
                val lp = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.WRAP_CONTENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT
                )
                lp.topMargin = dpToPx(8)
                layoutParams = lp
                setOnClickListener {
                    startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(item.github_issue_url)))
                }
            }
            card.addView(issueLink)
        }

        return card
    }

    private fun formatTimestamp(ts: String?): String {
        if (ts == null) return ""
        return try {
            val millis = ts.toLongOrNull() ?: return ts
            val sdf = SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.getDefault())
            sdf.format(Date(millis))
        } catch (e: Exception) {
            ts
        }
    }
}
