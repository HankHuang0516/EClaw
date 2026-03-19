package com.hank.clawlive

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.style.ForegroundColorSpan
import android.view.View
import android.view.inputmethod.EditorInfo
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.updatePadding
import androidx.core.widget.addTextChangedListener
import com.google.android.material.chip.ChipGroup
import com.google.android.material.textfield.TextInputEditText
import com.hank.clawlive.data.remote.TelemetryHelper
import com.hank.clawlive.debug.FileTimberTree
import com.hank.clawlive.ui.RecordingIndicatorHelper

class DebugLogViewerActivity : AppCompatActivity() {

    private lateinit var topBar: LinearLayout
    private lateinit var layoutEmpty: LinearLayout
    private lateinit var tvLogContent: TextView
    private lateinit var tvLineCount: TextView
    private lateinit var scrollContent: ScrollView
    private lateinit var chipGroupLevel: ChipGroup
    private lateinit var chipGroupCategory: ChipGroup
    private lateinit var etSearch: TextInputEditText

    private var allLines: List<String> = emptyList()
    private var currentLevel: String = "ALL"
    private var currentCategory: String = "ALL"
    private var searchQuery: String = ""

    // Tag patterns for category classification
    private companion object {
        val API_TAGS = listOf("OkHttp", "Retrofit", "Api", "Network", "Http", "Telemetry")
        val SOCKET_TAGS = listOf("Socket", "IO", "WebSocket", "SocketManager")
        val UI_TAGS = listOf("Activity", "Fragment", "View", "Adapter", "Dialog", "RecyclerView", "ViewModel")
        val LIFECYCLE_TAGS = listOf("Lifecycle", "Application", "onCreate", "onResume", "onPause", "onDestroy", "FCM", "Service")
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        setContentView(R.layout.activity_debug_log_viewer)

        topBar = findViewById(R.id.topBar)
        layoutEmpty = findViewById(R.id.layoutEmpty)
        tvLogContent = findViewById(R.id.tvLogContent)
        tvLineCount = findViewById(R.id.tvLineCount)
        scrollContent = findViewById(R.id.scrollContent)
        chipGroupLevel = findViewById(R.id.chipGroupLevel)
        chipGroupCategory = findViewById(R.id.chipGroupCategory)
        etSearch = findViewById(R.id.etSearch)

        setupEdgeToEdgeInsets()

        findViewById<ImageButton>(R.id.btnBack).setOnClickListener { finish() }
        findViewById<ImageButton>(R.id.btnCopy).setOnClickListener { copyLog() }
        findViewById<ImageButton>(R.id.btnShare).setOnClickListener { shareLog() }
        findViewById<ImageButton>(R.id.btnClear).setOnClickListener { confirmClear() }

        // Level filter
        chipGroupLevel.setOnCheckedStateChangeListener { _, checkedIds ->
            currentLevel = when (checkedIds.firstOrNull()) {
                R.id.chipDebug -> "D"
                R.id.chipInfo -> "I"
                R.id.chipWarn -> "W"
                R.id.chipError -> "E"
                else -> "ALL"
            }
            applyFilter()
        }

        // Category filter
        chipGroupCategory.setOnCheckedStateChangeListener { _, checkedIds ->
            currentCategory = when (checkedIds.firstOrNull()) {
                R.id.chipCatApi -> "API"
                R.id.chipCatSocket -> "SOCKET"
                R.id.chipCatUi -> "UI"
                R.id.chipCatLifecycle -> "LIFECYCLE"
                else -> "ALL"
            }
            applyFilter()
        }

        // Search
        etSearch.addTextChangedListener { text ->
            searchQuery = text?.toString()?.trim() ?: ""
            applyFilter()
        }
        etSearch.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_SEARCH) {
                etSearch.clearFocus()
                true
            } else false
        }

        loadLog()
    }

    override fun onResume() {
        super.onResume()
        TelemetryHelper.trackPageView(this, "debug_logs")
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

    private fun loadLog() {
        val tree = FileTimberTree.instance
        allLines = tree?.getRecentLines(500) ?: emptyList()
        applyFilter()
    }

    private fun getFilteredLines(): List<String> {
        var filtered = allLines

        // Level filter
        if (currentLevel != "ALL") {
            filtered = filtered.filter { it.contains("[$currentLevel/") }
        }

        // Category filter by tag patterns
        if (currentCategory != "ALL") {
            val tags = when (currentCategory) {
                "API" -> API_TAGS
                "SOCKET" -> SOCKET_TAGS
                "UI" -> UI_TAGS
                "LIFECYCLE" -> LIFECYCLE_TAGS
                else -> emptyList()
            }
            filtered = filtered.filter { line ->
                tags.any { tag -> line.contains("/$tag", ignoreCase = true) }
            }
        }

        // Keyword search
        if (searchQuery.isNotEmpty()) {
            filtered = filtered.filter { it.contains(searchQuery, ignoreCase = true) }
        }

        return filtered
    }

    private fun applyFilter() {
        val filtered = getFilteredLines()

        if (filtered.isEmpty()) {
            layoutEmpty.visibility = View.VISIBLE
            tvLogContent.visibility = View.GONE
            tvLineCount.text = getString(R.string.debug_log_line_count, 0)
            return
        }

        layoutEmpty.visibility = View.GONE
        tvLogContent.visibility = View.VISIBLE
        tvLineCount.text = getString(R.string.debug_log_line_count, filtered.size)

        tvLogContent.text = colorizeLog(filtered)

        // Auto-scroll to bottom
        scrollContent.post {
            scrollContent.fullScroll(View.FOCUS_DOWN)
        }
    }

    private fun colorizeLog(lines: List<String>): SpannableStringBuilder {
        val ssb = SpannableStringBuilder()
        for ((index, line) in lines.withIndex()) {
            if (index > 0) ssb.append("\n")
            val start = ssb.length
            ssb.append(line)
            val end = ssb.length

            val color = when {
                line.contains("[E/") -> 0xFFFF6B6B.toInt()  // Red for errors
                line.contains("[W/") -> 0xFFFFD23F.toInt()  // Yellow for warnings
                line.contains("[I/") -> 0xFF4CAF50.toInt()  // Green for info
                line.contains("[D/") -> 0xFF82B1FF.toInt()  // Blue for debug
                else -> Color.WHITE
            }
            ssb.setSpan(ForegroundColorSpan(color), start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        }
        return ssb
    }

    private fun copyLog() {
        val filtered = getFilteredLines()
        if (filtered.isEmpty()) {
            Toast.makeText(this, getString(R.string.debug_logs_empty), Toast.LENGTH_SHORT).show()
            return
        }
        val content = filtered.joinToString("\n")
        val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        clipboard.setPrimaryClip(ClipData.newPlainText("Debug Log", content))
        Toast.makeText(this, getString(R.string.debug_log_copied), Toast.LENGTH_SHORT).show()
    }

    private fun shareLog() {
        val filtered = getFilteredLines()
        if (filtered.isEmpty()) {
            Toast.makeText(this, getString(R.string.debug_logs_empty), Toast.LENGTH_SHORT).show()
            return
        }
        val content = filtered.joinToString("\n")
        val shareIntent = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_SUBJECT, "Debug Log - EClawbot")
            putExtra(Intent.EXTRA_TEXT, content)
        }
        startActivity(Intent.createChooser(shareIntent, getString(R.string.debug_log_share)))
    }

    private fun confirmClear() {
        if (allLines.isEmpty()) {
            Toast.makeText(this, getString(R.string.debug_logs_empty), Toast.LENGTH_SHORT).show()
            return
        }
        AlertDialog.Builder(this)
            .setTitle(getString(R.string.debug_log_clear))
            .setMessage(getString(R.string.debug_log_clear_confirm))
            .setPositiveButton(getString(R.string.debug_log_clear)) { _, _ ->
                FileTimberTree.instance?.clear()
                allLines = emptyList()
                applyFilter()
                Toast.makeText(this, getString(R.string.debug_log_cleared), Toast.LENGTH_SHORT).show()
            }
            .setNegativeButton(getString(R.string.cancel), null)
            .show()
    }
}
