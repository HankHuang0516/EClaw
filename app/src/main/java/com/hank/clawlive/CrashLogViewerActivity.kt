package com.hank.clawlive

import android.content.Intent
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.text.method.ScrollingMovementMethod
import android.view.Gravity
import android.view.View
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.updatePadding
import com.hank.clawlive.data.remote.TelemetryHelper
import com.hank.clawlive.debug.CrashLogManager
import com.hank.clawlive.ui.RecordingIndicatorHelper
import java.io.File

class CrashLogViewerActivity : AppCompatActivity() {

    private lateinit var layoutEmpty: LinearLayout
    private lateinit var layoutCrashList: LinearLayout
    private lateinit var topBar: LinearLayout

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        setContentView(R.layout.activity_crash_log_viewer)

        topBar = findViewById(R.id.topBar)
        layoutEmpty = findViewById(R.id.layoutEmpty)
        layoutCrashList = findViewById(R.id.layoutCrashList)

        setupEdgeToEdgeInsets()

        findViewById<ImageButton>(R.id.btnBack).setOnClickListener { finish() }
        findViewById<ImageButton>(R.id.btnDeleteAll).setOnClickListener { confirmDeleteAll() }

        loadCrashLogs()
    }

    override fun onResume() {
        super.onResume()
        TelemetryHelper.trackPageView(this, "crash_logs")
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

    private fun loadCrashLogs() {
        layoutCrashList.removeAllViews()
        val logs = CrashLogManager.getCrashLogs()

        if (logs.isEmpty()) {
            layoutEmpty.visibility = View.VISIBLE
            return
        }

        layoutEmpty.visibility = View.GONE

        for (file in logs) {
            addCrashCard(file)
        }
    }

    private fun addCrashCard(file: File) {
        val card = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            val bg = GradientDrawable().apply {
                setColor(0xFF1A1A1A.toInt())
                cornerRadius = dpToPx(12).toFloat()
                setStroke(1, 0xFF333333.toInt())
            }
            background = bg
            setPadding(dpToPx(16), dpToPx(12), dpToPx(16), dpToPx(12))
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply { bottomMargin = dpToPx(8) }
        }

        // Timestamp
        val tvTimestamp = TextView(this).apply {
            text = CrashLogManager.parseTimestamp(file)
            setTextColor(0xFFFFD23F.toInt())
            textSize = 13f
            typeface = Typeface.MONOSPACE
        }
        card.addView(tvTimestamp)

        // Exception summary
        val tvException = TextView(this).apply {
            text = CrashLogManager.parseExceptionSummary(file)
            setTextColor(0xFFFF6B6B.toInt())
            textSize = 12f
            typeface = Typeface.MONOSPACE
            maxLines = 2
            setPadding(0, dpToPx(4), 0, dpToPx(8))
        }
        card.addView(tvException)

        // Detail text (initially hidden)
        val tvDetail = TextView(this).apply {
            text = CrashLogManager.readCrashLog(file)
            setTextColor(0xCCFFFFFF.toInt())
            textSize = 10f
            typeface = Typeface.MONOSPACE
            visibility = View.GONE
            movementMethod = ScrollingMovementMethod.getInstance()
            setHorizontallyScrolling(true)
        }
        card.addView(tvDetail)

        // Action buttons row
        val btnRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.END
        }

        val btnExpand = createActionButton(getString(R.string.crash_log_expand))
        btnExpand.setOnClickListener {
            if (tvDetail.visibility == View.GONE) {
                tvDetail.visibility = View.VISIBLE
                btnExpand.text = getString(R.string.crash_log_collapse)
            } else {
                tvDetail.visibility = View.GONE
                btnExpand.text = getString(R.string.crash_log_expand)
            }
        }
        btnRow.addView(btnExpand)

        val btnShare = createActionButton(getString(R.string.crash_log_share))
        btnShare.setOnClickListener { shareCrashLog(file) }
        btnRow.addView(btnShare)

        val btnDelete = createActionButton(getString(R.string.crash_log_delete))
        btnDelete.setOnClickListener {
            CrashLogManager.deleteCrashLog(file)
            Toast.makeText(this, getString(R.string.crash_log_deleted), Toast.LENGTH_SHORT).show()
            loadCrashLogs()
        }
        btnRow.addView(btnDelete)

        card.addView(btnRow)
        layoutCrashList.addView(card)
    }

    private fun createActionButton(label: String): TextView {
        return TextView(this).apply {
            text = label
            setTextColor(0xFF82B1FF.toInt())
            textSize = 12f
            setPadding(dpToPx(12), dpToPx(6), dpToPx(12), dpToPx(6))
            setOnClickListener { /* set externally */ }
        }
    }

    private fun shareCrashLog(file: File) {
        val content = CrashLogManager.readCrashLog(file)
        val shareIntent = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_SUBJECT, "Crash Report - ${file.name}")
            putExtra(Intent.EXTRA_TEXT, content)
        }
        startActivity(Intent.createChooser(shareIntent, getString(R.string.crash_log_share)))
    }

    private fun confirmDeleteAll() {
        val count = CrashLogManager.getCrashLogs().size
        if (count == 0) {
            Toast.makeText(this, getString(R.string.crash_logs_empty), Toast.LENGTH_SHORT).show()
            return
        }

        AlertDialog.Builder(this)
            .setTitle(getString(R.string.crash_log_delete_all))
            .setMessage(getString(R.string.crash_log_delete_all_confirm, count))
            .setPositiveButton(getString(R.string.crash_log_delete)) { _, _ ->
                val deleted = CrashLogManager.deleteAllCrashLogs()
                Toast.makeText(this, getString(R.string.crash_logs_all_deleted, deleted), Toast.LENGTH_SHORT).show()
                loadCrashLogs()
            }
            .setNegativeButton(getString(R.string.cancel), null)
            .show()
    }
}
