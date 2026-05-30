package com.hank.clawlive.engine

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.os.Build
import android.text.TextPaint
import com.hank.clawlive.R
import com.hank.clawlive.data.local.LayoutPreferences
import com.hank.clawlive.data.local.UsageOverlayPosition
import com.hank.clawlive.data.model.UsageSnapshotLatest
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale
import kotlin.math.roundToInt

class UsageOverlayRenderer(
    private val context: Context,
    private val layoutPrefs: LayoutPreferences = LayoutPreferences.getInstance(context)
) {
    private val density = context.resources.displayMetrics.density
    private val panelRect = RectF()

    private val panelPaint = Paint().apply {
        color = Color.argb(178, 8, 12, 18)
        style = Paint.Style.FILL
        isAntiAlias = true
    }

    private val panelStrokePaint = Paint().apply {
        color = Color.argb(70, 255, 255, 255)
        style = Paint.Style.STROKE
        strokeWidth = 1f * density
        isAntiAlias = true
    }

    private val highlightGlowPaint = Paint().apply {
        color = Color.argb(34, 64, 224, 255)
        style = Paint.Style.FILL
        isAntiAlias = true
    }

    private val highlightStrokePaint = Paint().apply {
        color = Color.argb(230, 64, 224, 255)
        style = Paint.Style.STROKE
        strokeWidth = 3f * density
        isAntiAlias = true
    }

    private val titlePaint = TextPaint().apply {
        color = Color.WHITE
        textSize = 12f * density
        isFakeBoldText = true
        isAntiAlias = true
    }

    private val linePaint = TextPaint().apply {
        color = Color.argb(220, 255, 255, 255)
        textSize = 11f * density
        isAntiAlias = true
    }

    fun draw(
        canvas: Canvas,
        snapshot: UsageSnapshotLatest?,
        topInsetPx: Float = 0f,
        bottomInsetPx: Float = 0f,
        highlighted: Boolean = false
    ) {
        if (!layoutPrefs.usageOverlayEnabled || canvas.width <= 0 || canvas.height <= 0) return

        val lines = buildLines(snapshot)
        if (lines.isEmpty()) return

        val scale = layoutPrefs.usageOverlayScale
        val paddingH = 10f * density * scale
        val paddingV = 8f * density * scale
        val lineGap = 3f * density * scale
        val cornerRadius = 8f * density * scale

        titlePaint.textSize = 12f * density * scale
        linePaint.textSize = 11f * density * scale

        val lineHeight = linePaint.fontMetrics.run { bottom - top }
        val bounds = getBounds(canvas.width, canvas.height, snapshot, topInsetPx, bottomInsetPx)
            ?: return
        val left = bounds.left
        val top = bounds.top

        panelRect.set(bounds)
        if (highlighted) {
            val glowInset = -4f * density
            panelRect.inset(glowInset, glowInset)
            canvas.drawRoundRect(panelRect, cornerRadius + 4f * density, cornerRadius + 4f * density, highlightGlowPaint)
            canvas.drawRoundRect(panelRect, cornerRadius + 4f * density, cornerRadius + 4f * density, highlightStrokePaint)
            panelRect.set(bounds)
        }
        canvas.drawRoundRect(panelRect, cornerRadius, cornerRadius, panelPaint)
        panelStrokePaint.strokeWidth = if (highlighted) 2f * density else 1f * density
        panelStrokePaint.color = if (highlighted) Color.argb(210, 64, 224, 255) else Color.argb(70, 255, 255, 255)
        canvas.drawRoundRect(panelRect, cornerRadius, cornerRadius, panelStrokePaint)

        var baseline = top + paddingV - titlePaint.fontMetrics.top
        canvas.drawText(lines[0], left + paddingH, baseline, titlePaint)
        baseline += lineHeight + lineGap
        for (i in 1 until lines.size) {
            canvas.drawText(lines[i], left + paddingH, baseline, linePaint)
            baseline += lineHeight + lineGap
        }
    }

    fun getBounds(
        width: Int,
        height: Int,
        snapshot: UsageSnapshotLatest?,
        topInsetPx: Float = 0f,
        bottomInsetPx: Float = 0f
    ): RectF? {
        if (!layoutPrefs.usageOverlayEnabled || width <= 0 || height <= 0) return null

        val lines = buildLines(snapshot)
        if (lines.isEmpty()) return null

        val scale = layoutPrefs.usageOverlayScale
        titlePaint.textSize = 12f * density * scale
        linePaint.textSize = 11f * density * scale

        val paddingH = 10f * density * scale
        val paddingV = 8f * density * scale
        val lineGap = 3f * density * scale
        val margin = 16f * density

        var maxTextWidth = 0f
        lines.forEachIndexed { index, line ->
            val paint = if (index == 0) titlePaint else linePaint
            maxTextWidth = maxOf(maxTextWidth, paint.measureText(line))
        }

        val maxPanelWidth = (width - margin * 2).coerceAtLeast(0f)
        val panelWidth = (maxTextWidth + paddingH * 2).coerceAtMost(maxPanelWidth)
        val titleHeight = titlePaint.fontMetrics.run { bottom - top }
        val lineHeight = linePaint.fontMetrics.run { bottom - top }
        val panelHeight = paddingV * 2 +
            titleHeight +
            ((lines.size - 1).coerceAtLeast(0) * (lineHeight + lineGap))

        val minLeft = margin
        val maxLeft = (width - margin - panelWidth).coerceAtLeast(minLeft)
        val minTop = margin + topInsetPx
        val maxTop = (height - margin - bottomInsetPx - panelHeight).coerceAtLeast(minTop)

        val customCenter = layoutPrefs.getUsageOverlayCenter()
        val (rawLeft, rawTop) = if (customCenter != null) {
            (customCenter.first * width - panelWidth / 2f) to
                (customCenter.second * height - panelHeight / 2f)
        } else {
            defaultCornerLeftTop(width, height, panelWidth, panelHeight, margin, topInsetPx, bottomInsetPx)
        }

        val left = rawLeft.coerceIn(minLeft, maxLeft)
        val top = rawTop.coerceIn(minTop, maxTop)
        return RectF(left, top, left + panelWidth, top + panelHeight)
    }

    private fun defaultCornerLeftTop(
        width: Int,
        height: Int,
        panelWidth: Float,
        panelHeight: Float,
        margin: Float,
        topInsetPx: Float,
        bottomInsetPx: Float
    ): Pair<Float, Float> {
        val left = when (layoutPrefs.usageOverlayPosition) {
            UsageOverlayPosition.TOP_LEFT,
            UsageOverlayPosition.BOTTOM_LEFT -> margin
            UsageOverlayPosition.TOP_RIGHT,
            UsageOverlayPosition.BOTTOM_RIGHT -> width - margin - panelWidth
        }

        val top = when (layoutPrefs.usageOverlayPosition) {
            UsageOverlayPosition.TOP_LEFT,
            UsageOverlayPosition.TOP_RIGHT -> margin + topInsetPx
            UsageOverlayPosition.BOTTOM_LEFT,
            UsageOverlayPosition.BOTTOM_RIGHT -> height - margin - bottomInsetPx - panelHeight
        }
        return left to top
    }

    fun buildLines(snapshot: UsageSnapshotLatest?): List<String> {
        val usageSectionVisible =
            (layoutPrefs.usageOverlayShowClaude || layoutPrefs.usageOverlayShowCodex) &&
                (layoutPrefs.usageOverlayShowSession || layoutPrefs.usageOverlayShowWeekly)
        val resetSectionVisible =
            layoutPrefs.wallpaperResetShowFiveHour || layoutPrefs.wallpaperResetShowWeekly
        if (!usageSectionVisible && !resetSectionVisible) return emptyList()

        val lines = mutableListOf<String>()
        if (usageSectionVisible) {
            lines.add(context.getString(R.string.wallpaper_usage_overlay_title))
            if (snapshot == null) {
                lines.add(context.getString(R.string.wallpaper_usage_overlay_syncing))
            } else {
                val usageLineStart = lines.size
                if (layoutPrefs.usageOverlayShowClaude) {
                    formatEngineLine(
                        context.getString(R.string.wallpaper_usage_engine_claude),
                        snapshot.claude?.live?.fiveHourPct
                            ?: snapshot.claude?.live?.rateLimits?.fiveHour?.usedPercentage,
                        snapshot.claude?.live?.sevenDayPct
                            ?: snapshot.claude?.live?.rateLimits?.sevenDay?.usedPercentage
                    )?.let(lines::add)
                }
                if (layoutPrefs.usageOverlayShowCodex) {
                    formatEngineLine(
                        context.getString(R.string.wallpaper_usage_engine_codex),
                        snapshot.codex?.rateLimits?.fiveHourPct,
                        snapshot.codex?.rateLimits?.sevenDayPct
                    )?.let(lines::add)
                }
                if (lines.size == usageLineStart) {
                    lines.add(context.getString(R.string.wallpaper_usage_overlay_syncing))
                }
            }
        }

        lines.addAll(formatResetCountdownLines(snapshot))
        return lines
    }

    private fun formatResetCountdownLines(snapshot: UsageSnapshotLatest?): List<String> {
        val lines = mutableListOf<String>()
        if (layoutPrefs.wallpaperResetShowFiveHour) {
            fiveHourResetCandidates(snapshot)
                .filter { isEngineVisibleForReset(it.engineKey) }
                .forEach { reset ->
                    val hhmm = formatHourMinute((reset.resetsAtSec * 1000.0).toLong())
                    lines.add(context.getString(R.string.wallpaper_reset_window_5h_next, reset.engineLabel, hhmm))
                }
        }
        if (layoutPrefs.wallpaperResetShowWeekly) {
            val rawCandidates = weeklyResetCandidates(snapshot)
            if (snapshot == null || rawCandidates.isEmpty()) {
                val resetsAt = nextWeeklyResetEpochMillis()
                val weeklyTime = formatWeeklyReset(resetsAt)
                lines.add(context.getString(R.string.wallpaper_reset_window_weekly_next, weeklyTime))
            } else {
                rawCandidates
                    .filter { isEngineVisibleForReset(it.engineKey) }
                    .forEach { reset ->
                        val weeklyTime = formatWeeklyReset((reset.resetsAtSec * 1000.0).toLong())
                        lines.add(
                            context.getString(
                                R.string.wallpaper_reset_window_weekly_next_per_engine,
                                reset.engineLabel,
                                weeklyTime
                            )
                        )
                    }
            }
        }
        return lines
    }

    private fun fiveHourResetCandidates(snapshot: UsageSnapshotLatest?): List<ResetCandidate> {
        if (snapshot == null) return emptyList()
        val claudeReset = snapshot.claude?.live?.rateLimits?.fiveHour?.resetsAt
        val codexReset = snapshot.codex?.rateLimits?.fiveHourResetsAt
        val nowSec = System.currentTimeMillis() / 1000.0
        return listOfNotNull(
            claudeReset?.let {
                ResetCandidate(ENGINE_KEY_CLAUDE, context.getString(R.string.wallpaper_usage_engine_claude), it)
            },
            codexReset?.let {
                ResetCandidate(ENGINE_KEY_CODEX, context.getString(R.string.wallpaper_usage_engine_codex), it)
            }
        ).filter { it.resetsAtSec > nowSec }
            .sortedBy { it.resetsAtSec }
    }

    private fun weeklyResetCandidates(snapshot: UsageSnapshotLatest?): List<ResetCandidate> {
        if (snapshot == null) return emptyList()
        val claudeReset = snapshot.claude?.live?.rateLimits?.sevenDay?.resetsAt
        val codexReset = snapshot.codex?.rateLimits?.sevenDayResetsAt
        val nowSec = System.currentTimeMillis() / 1000.0
        return listOfNotNull(
            claudeReset?.let {
                ResetCandidate(ENGINE_KEY_CLAUDE, context.getString(R.string.wallpaper_usage_engine_claude), it)
            },
            codexReset?.let {
                ResetCandidate(ENGINE_KEY_CODEX, context.getString(R.string.wallpaper_usage_engine_codex), it)
            }
        ).filter { it.resetsAtSec > nowSec }
            .sortedBy { it.resetsAtSec }
    }

    private fun isEngineVisibleForReset(engineKey: String): Boolean {
        // When no engine is visible in the usage section, reset countdowns operate in
        // standalone mode (no per-engine filter). This lets the user run reset-only mode
        // — disable both Claude/Codex usage rows but still see the 5h countdown.
        val anyEngineVisible = layoutPrefs.usageOverlayShowClaude || layoutPrefs.usageOverlayShowCodex
        if (!anyEngineVisible) return true
        return when (engineKey) {
            ENGINE_KEY_CLAUDE -> layoutPrefs.usageOverlayShowClaude
            ENGINE_KEY_CODEX -> layoutPrefs.usageOverlayShowCodex
            else -> true
        }
    }

    private fun nextWeeklyResetEpochMillis(): Long {
        val cal = Calendar.getInstance()
        cal.set(Calendar.HOUR_OF_DAY, 0)
        cal.set(Calendar.MINUTE, 0)
        cal.set(Calendar.SECOND, 0)
        cal.set(Calendar.MILLISECOND, 0)
        val daysUntilMonday = ((Calendar.MONDAY - cal.get(Calendar.DAY_OF_WEEK) + 7) % 7).let {
            if (it == 0) 7 else it
        }
        cal.add(Calendar.DAY_OF_YEAR, daysUntilMonday)
        return cal.timeInMillis
    }

    private fun formatHourMinute(epochMillis: Long): String {
        return SimpleDateFormat("HH:mm", currentLocale()).format(Date(epochMillis))
    }

    private fun formatWeeklyReset(epochMillis: Long): String {
        return SimpleDateFormat("EEE HH:mm", currentLocale()).format(Date(epochMillis))
    }

    private fun currentLocale(): Locale {
        val configuration = context.resources.configuration
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            configuration.locales[0]
        } else {
            @Suppress("DEPRECATION")
            configuration.locale ?: Locale.getDefault()
        }
    }

    private fun formatEngineLine(label: String, sessionPct: Double?, weeklyPct: Double?): String? {
        val parts = mutableListOf<String>()
        if (layoutPrefs.usageOverlayShowSession) {
            parts.add("${context.getString(R.string.wallpaper_usage_window_session)} ${formatPct(sessionPct)}")
        }
        if (layoutPrefs.usageOverlayShowWeekly) {
            parts.add("${context.getString(R.string.wallpaper_usage_window_weekly)} ${formatPct(weeklyPct)}")
        }
        if (parts.isEmpty()) return null
        return "$label  ${parts.joinToString("  ")}"
    }

    private fun formatPct(value: Double?): String {
        val pct = value?.takeIf { it.isFinite() }?.roundToInt() ?: return "--"
        return "${pct.coerceIn(0, 999)}%"
    }

    private data class ResetCandidate(
        val engineKey: String,
        val engineLabel: String,
        val resetsAtSec: Double
    )

    companion object {
        private const val ENGINE_KEY_CLAUDE = "claude"
        private const val ENGINE_KEY_CODEX = "codex"
    }
}
