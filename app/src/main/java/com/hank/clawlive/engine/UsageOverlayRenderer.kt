package com.hank.clawlive.engine

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.text.TextPaint
import com.hank.clawlive.R
import com.hank.clawlive.data.local.LayoutPreferences
import com.hank.clawlive.data.local.UsageOverlayPosition
import com.hank.clawlive.data.model.UsageSnapshotLatest
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
        bottomInsetPx: Float = 0f
    ) {
        if (!layoutPrefs.usageOverlayEnabled || canvas.width <= 0 || canvas.height <= 0) return

        val lines = buildLines(snapshot)
        if (lines.isEmpty()) return

        val paddingH = 10f * density
        val paddingV = 8f * density
        val lineGap = 3f * density
        val margin = 16f * density
        val cornerRadius = 8f * density

        var maxTextWidth = 0f
        lines.forEachIndexed { index, line ->
            val paint = if (index == 0) titlePaint else linePaint
            maxTextWidth = maxOf(maxTextWidth, paint.measureText(line))
        }

        val maxPanelWidth = (canvas.width - margin * 2).coerceAtLeast(0f)
        val panelWidth = (maxTextWidth + paddingH * 2).coerceAtMost(maxPanelWidth)
        val titleHeight = titlePaint.fontMetrics.run { bottom - top }
        val lineHeight = linePaint.fontMetrics.run { bottom - top }
        val panelHeight = paddingV * 2 +
            titleHeight +
            ((lines.size - 1).coerceAtLeast(0) * (lineHeight + lineGap))

        val left = when (layoutPrefs.usageOverlayPosition) {
            UsageOverlayPosition.TOP_LEFT,
            UsageOverlayPosition.BOTTOM_LEFT -> margin
            UsageOverlayPosition.TOP_RIGHT,
            UsageOverlayPosition.BOTTOM_RIGHT -> canvas.width - margin - panelWidth
        }.coerceIn(margin, (canvas.width - margin - panelWidth).coerceAtLeast(margin))

        val top = when (layoutPrefs.usageOverlayPosition) {
            UsageOverlayPosition.TOP_LEFT,
            UsageOverlayPosition.TOP_RIGHT -> margin + topInsetPx
            UsageOverlayPosition.BOTTOM_LEFT,
            UsageOverlayPosition.BOTTOM_RIGHT -> canvas.height - margin - bottomInsetPx - panelHeight
        }.coerceIn(margin + topInsetPx, (canvas.height - margin - bottomInsetPx - panelHeight).coerceAtLeast(margin + topInsetPx))

        panelRect.set(left, top, left + panelWidth, top + panelHeight)
        canvas.drawRoundRect(panelRect, cornerRadius, cornerRadius, panelPaint)
        canvas.drawRoundRect(panelRect, cornerRadius, cornerRadius, panelStrokePaint)

        var baseline = top + paddingV - titlePaint.fontMetrics.top
        canvas.drawText(lines[0], left + paddingH, baseline, titlePaint)
        baseline += lineHeight + lineGap
        for (i in 1 until lines.size) {
            canvas.drawText(lines[i], left + paddingH, baseline, linePaint)
            baseline += lineHeight + lineGap
        }
    }

    fun buildLines(snapshot: UsageSnapshotLatest?): List<String> {
        if (!layoutPrefs.usageOverlayShowClaude && !layoutPrefs.usageOverlayShowCodex) return emptyList()
        if (!layoutPrefs.usageOverlayShowSession && !layoutPrefs.usageOverlayShowWeekly) return emptyList()

        val lines = mutableListOf(context.getString(R.string.wallpaper_usage_overlay_title))
        if (snapshot == null) {
            lines.add(context.getString(R.string.wallpaper_usage_overlay_syncing))
            return lines
        }

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

        if (lines.size == 1) {
            lines.add(context.getString(R.string.wallpaper_usage_overlay_syncing))
        }
        return lines
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
}
