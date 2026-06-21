package com.hank.clawlive.engine

import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.text.TextPaint
import com.hank.clawlive.data.local.LayoutPreferences
import com.hank.clawlive.data.model.CharacterState
import com.hank.clawlive.data.model.EntityStatus
import com.hank.clawlive.data.model.WallpaperKanbanCard
import com.hank.clawlive.data.model.WallpaperKanbanSchedule
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.min
import kotlin.math.sin

class WallpaperKanbanRenderer(
    private val layoutPrefs: LayoutPreferences
) {
    private data class VisualCardState(
        val id: String,
        var title: String,
        var priority: String,
        var displayStatus: String,
        var actualStatus: String,
        var assignedBots: List<Int>,
        var archived: Boolean,
        var updatedAt: Long?,
        var isAutomation: Boolean,
        var schedule: WallpaperKanbanSchedule?,
        var reviewUntilMs: Long = 0L,
        var removalUntilMs: Long = 0L,
        var removalStartedAtMs: Long = 0L,
        var lastSeenAtMs: Long = 0L
    ) {
        val terminal: Boolean
            get() = archived || actualStatus == "done" || actualStatus == "archived"
    }

    private data class AutomationBoardSpec(
        val base: Pair<Float, Float>,
        val unit: Float,
        val cards: List<VisualCardState>,
        val height: Float,
        val rowHeight: Float,
        val top: Float,
        var width: Float,
        var left: Float
    )

    private val states = mutableMapOf<String, VisualCardState>()
    private val boardPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
    private val boardStrokePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = 2.5f
        color = Color.argb(155, 30, 41, 59)
    }
    private val standPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = 4f
        strokeCap = Paint.Cap.ROUND
        color = Color.argb(165, 51, 65, 85)
    }
    private val folderPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
    private val folderStrokePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = 2.2f
        color = Color.argb(190, 15, 23, 42)
    }
    private val textPaint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.argb(220, 15, 23, 42)
        textAlign = Paint.Align.LEFT
    }
    private val accentPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
    private val dateFormat = SimpleDateFormat("MM/dd HH:mm", Locale.getDefault())

    fun update(cards: List<WallpaperKanbanCard>, nowMs: Long): Map<Int, CharacterState> {
        val reviewActions = mutableMapOf<Int, CharacterState>()
        val incomingIds = cards.mapNotNull { it.id.takeIf(String::isNotBlank) }.toSet()

        states.values.forEach { state ->
            if (state.id !in incomingIds && state.removalUntilMs == 0L) {
                beginRemoval(state, nowMs, reviewActions)
            }
        }

        cards.forEach { card ->
            if (card.id.isBlank()) return@forEach
            val terminal = card.archived || card.status == "done" || card.status == "archived"
            val existing = states[card.id]
            if (existing == null) {
                if (!terminal) {
                    states[card.id] = VisualCardState(
                        id = card.id,
                        title = card.title,
                        priority = card.priority,
                        displayStatus = card.status,
                        actualStatus = card.status,
                        assignedBots = card.assignedBots,
                        archived = card.archived,
                        updatedAt = card.updatedAt,
                        isAutomation = card.isAutomation,
                        schedule = card.schedule,
                        lastSeenAtMs = nowMs
                    )
                }
                return@forEach
            }

            existing.title = card.title
            existing.priority = card.priority
            existing.assignedBots = card.assignedBots
            existing.archived = card.archived
            existing.updatedAt = card.updatedAt
            existing.isAutomation = card.isAutomation
            existing.schedule = card.schedule
            existing.lastSeenAtMs = nowMs

            if (terminal) {
                existing.actualStatus = if (card.archived) "archived" else card.status
                if (existing.removalUntilMs == 0L) beginRemoval(existing, nowMs, reviewActions)
                return@forEach
            }

            if (existing.actualStatus != card.status || existing.removalUntilMs != 0L) {
                existing.actualStatus = card.status
                existing.reviewUntilMs = nowMs + REVIEW_DELAY_MS
                existing.removalUntilMs = 0L
                existing.removalStartedAtMs = 0L
                existing.assignedBots.forEach { reviewActions[it] = CharacterState.REVIEW }
            }
        }

        states.values.forEach { state ->
            if (state.reviewUntilMs > nowMs) {
                state.assignedBots.forEach { reviewActions[it] = CharacterState.REVIEW }
            } else if (!state.terminal) {
                state.displayStatus = state.actualStatus
            }
        }

        states.keys.toList().forEach { id ->
            val state = states[id] ?: return@forEach
            if (state.removalUntilMs > 0L && nowMs >= state.removalUntilMs) {
                states.remove(id)
            }
        }

        return reviewActions
    }

    private fun beginRemoval(
        state: VisualCardState,
        nowMs: Long,
        reviewActions: MutableMap<Int, CharacterState>
    ) {
        state.reviewUntilMs = nowMs + REVIEW_DELAY_MS
        state.removalStartedAtMs = nowMs + REVIEW_DELAY_MS
        state.removalUntilMs = nowMs + REVIEW_DELAY_MS + REMOVAL_ANIMATION_MS
        state.assignedBots.forEach { reviewActions[it] = CharacterState.REVIEW }
    }

    fun drawBackground(
        canvas: Canvas,
        entities: List<EntityStatus>,
        basePositions: List<Pair<Float, Float>>,
        baseScale: Float,
        nowMs: Long
    ) {
        if (states.isEmpty()) return
        val baseById = entities.mapIndexedNotNull { index, entity ->
            basePositions.getOrNull(index)?.let { entity.entityId to it }
        }.toMap()

        if (layoutPrefs.wallpaperKanbanAutomationBoardEnabled) {
            val boardSpecs = baseById.mapNotNull { (entityId, base) ->
                val unit = 300f * baseScale * layoutPrefs.getEntityScale(entityId)
                val automations = states.values
                    .filter { it.isAutomation && !it.terminal && entityId in it.assignedBots }
                    .sortedBy { it.schedule?.nextRunAt ?: Long.MAX_VALUE }
                if (automations.isEmpty()) {
                    null
                } else {
                    createAutomationBoardSpec(canvas, base, unit, automations)
                }
            }
            layoutAutomationBoards(canvas, boardSpecs)
            boardSpecs.forEach { spec ->
                drawAutomationBoard(canvas, spec)
            }
        }

        if (layoutPrefs.wallpaperKanbanTasksEnabled) {
            baseById.forEach { (entityId, base) ->
                val unit = 300f * baseScale * layoutPrefs.getEntityScale(entityId)
                val tasks = states.values
                    .filter { !it.isAutomation && entityId in it.assignedBots }
                    .sortedWith(compareBy<VisualCardState> { it.terminal }.thenBy { it.priority }.thenByDescending { it.updatedAt ?: 0L })
                tasks.forEachIndexed { index, state ->
                    drawTaskFolder(canvas, base, unit, index, tasks.size, state, nowMs)
                }
            }
        }
    }

    private fun createAutomationBoardSpec(
        canvas: Canvas,
        base: Pair<Float, Float>,
        unit: Float,
        cards: List<VisualCardState>
    ): AutomationBoardSpec {
        val rowHeight = (unit * 0.13f).coerceIn(18f, 30f)
        val height = (unit * 0.5f + rowHeight * cards.take(MAX_BOARD_ROWS).size).coerceIn(unit * 0.62f, unit * 1.05f)
        val width = preferredBoardWidth(unit, cards)
        val left = clampedBoardLeft(canvas, base.first, width)
        val top = (base.second - unit * 1.75f - height / 2f).coerceIn(18f, canvas.height - height - 18f)
        return AutomationBoardSpec(
            base = base,
            unit = unit,
            cards = cards,
            height = height,
            rowHeight = rowHeight,
            top = top,
            width = width,
            left = left
        )
    }

    private fun layoutAutomationBoards(canvas: Canvas, specs: List<AutomationBoardSpec>) {
        if (specs.isEmpty()) return
        val availableWidth = (canvas.width - BOARD_MARGIN * 2f - BOARD_GAP * (specs.size - 1))
            .coerceAtLeast(BOARD_MIN_WIDTH)
        val maxWidthForCount = (availableWidth / specs.size).coerceAtLeast(BOARD_MIN_WIDTH)

        specs.forEach { spec ->
            spec.width = spec.width.coerceIn(BOARD_MIN_WIDTH, maxWidthForCount)
            spec.left = clampedBoardLeft(canvas, spec.base.first, spec.width)
        }

        val sorted = specs.sortedBy { it.left + it.width / 2f }
        for (i in 1 until sorted.size) {
            val previous = sorted[i - 1]
            val current = sorted[i]
            val minLeft = previous.left + previous.width + BOARD_GAP
            if (current.left < minLeft) current.left = minLeft
        }

        val overflow = sorted.last().left + sorted.last().width + BOARD_MARGIN - canvas.width
        if (overflow > 0f) {
            sorted.forEach { it.left -= overflow }
        }
        if (sorted.first().left < BOARD_MARGIN) {
            val shift = BOARD_MARGIN - sorted.first().left
            sorted.forEach { it.left += shift }
        }
    }

    private fun clampedBoardLeft(canvas: Canvas, centerX: Float, width: Float): Float {
        val maxLeft = (canvas.width - width - BOARD_MARGIN).coerceAtLeast(BOARD_MARGIN)
        return (centerX - width / 2f).coerceIn(BOARD_MARGIN, maxLeft)
    }

    private fun drawAutomationBoard(
        canvas: Canvas,
        spec: AutomationBoardSpec
    ) {
        val unit = spec.unit
        val left = spec.left
        val top = spec.top
        val rect = RectF(left, top, left + spec.width, top + spec.height)

        drawWhiteboardStand(canvas, rect, unit)

        boardPaint.color = Color.argb(205, 248, 250, 252)
        canvas.drawRoundRect(rect, 8f, 8f, boardPaint)
        canvas.drawRoundRect(rect, 8f, 8f, boardStrokePaint)
        accentPaint.color = Color.argb(125, 148, 163, 184)
        canvas.drawRoundRect(
            RectF(
                rect.left + unit * 0.08f,
                rect.bottom - unit * 0.045f,
                rect.right - unit * 0.08f,
                rect.bottom - unit * 0.025f
            ),
            4f,
            4f,
            accentPaint
        )

        textPaint.textSize = (unit * 0.09f).coerceIn(13f, 18f)
        textPaint.isFakeBoldText = true
        textPaint.color = Color.argb(225, 15, 23, 42)
        canvas.drawText("Automation", left + unit * 0.08f, top + unit * 0.16f, textPaint)
        textPaint.isFakeBoldText = false
        textPaint.textSize = (unit * 0.075f).coerceIn(11f, 15f)

        val titleLeft = left + unit * 0.14f
        val dateRight = rect.right - unit * 0.08f
        val titleMaxWidth = (dateRight - titleLeft - unit * 0.36f).coerceAtLeast(unit * 0.45f)
        spec.cards.take(MAX_BOARD_ROWS).forEachIndexed { index, card ->
            val y = top + unit * 0.28f + spec.rowHeight * (index + 1)
            accentPaint.color = colorForStatus(card.displayStatus, card.priority, 210)
            canvas.drawCircle(left + unit * 0.09f, y - textPaint.textSize * 0.3f, unit * 0.022f, accentPaint)
            textPaint.color = Color.argb(220, 15, 23, 42)
            val title = if (layoutPrefs.wallpaperKanbanPrivacyModeEnabled) {
                "Task ${index + 1}"
            } else {
                ellipsizeToWidth(card.title, titleMaxWidth, textPaint)
            }
            canvas.drawText(title, titleLeft, y, textPaint)
            val next = if (layoutPrefs.wallpaperKanbanPrivacyModeEnabled) {
                "hidden"
            } else {
                formatNext(card.schedule)
            }
            textPaint.color = Color.argb(165, 71, 85, 105)
            textPaint.textAlign = Paint.Align.RIGHT
            canvas.drawText(ellipsizeToWidth(next, unit * 0.34f, textPaint), dateRight, y, textPaint)
            textPaint.textAlign = Paint.Align.LEFT
        }
    }

    private fun drawWhiteboardStand(canvas: Canvas, rect: RectF, unit: Float) {
        standPaint.strokeWidth = (unit * 0.014f).coerceIn(2.5f, 5.5f)
        standPaint.color = Color.argb(150, 51, 65, 85)
        val legTopY = rect.bottom - unit * 0.03f
        val legBottomY = rect.bottom + (unit * 0.34f).coerceIn(34f, 72f)
        val leftLegX = rect.left + rect.width() * 0.22f
        val rightLegX = rect.right - rect.width() * 0.22f
        canvas.drawLine(leftLegX, legTopY, leftLegX - unit * 0.08f, legBottomY, standPaint)
        canvas.drawLine(rightLegX, legTopY, rightLegX + unit * 0.08f, legBottomY, standPaint)
        canvas.drawLine(leftLegX + unit * 0.04f, legTopY, rightLegX - unit * 0.04f, legTopY, standPaint)
        canvas.drawLine(leftLegX - unit * 0.17f, legBottomY, leftLegX + unit * 0.06f, legBottomY, standPaint)
        canvas.drawLine(rightLegX - unit * 0.06f, legBottomY, rightLegX + unit * 0.17f, legBottomY, standPaint)
    }

    private fun drawTaskFolder(
        canvas: Canvas,
        base: Pair<Float, Float>,
        unit: Float,
        index: Int,
        totalCount: Int,
        state: VisualCardState,
        nowMs: Long
    ) {
        val removalProgress = removalProgress(state, nowMs)
        if (state.terminal && removalProgress >= 1f) return
        val seed = abs(state.id.hashCode())
        val maxColumns = min(totalCount.coerceAtLeast(1), 4)
        val row = index / maxColumns
        val col = index % maxColumns
        val visibleColumns = min(maxColumns, (totalCount - row * maxColumns).coerceAtLeast(1))
        val colOffset = col - (visibleColumns - 1) / 2f
        val rowDepth = row.coerceAtMost(5)
        val naturalJitterX = (((seed / 7) % 7) - 3) * unit * 0.008f
        val naturalJitterY = (((seed / 13) % 5) - 2) * unit * 0.007f
        val pileLean = if ((seed and 1) == 0) -1f else 1f
        val cx = (base.first + colOffset * unit * 0.115f + pileLean * rowDepth * unit * 0.018f + naturalJitterX)
            .coerceIn(unit * 0.18f, canvas.width - unit * 0.18f)
        val cy = (base.second + unit * 0.35f + rowDepth * unit * 0.035f - abs(colOffset) * unit * 0.018f + naturalJitterY)
            .coerceIn(unit * 0.25f, canvas.height - unit * 0.08f)
        val scale = (0.8f - rowDepth * 0.018f + ((seed % 5) * 0.018f)).coerceIn(0.68f, 0.86f)
        val width = unit * 0.38f * scale
        val height = unit * 0.27f * scale
        val alpha = if (state.terminal) ((1f - removalProgress) * 230).toInt() else 230
        val lift = if (state.reviewUntilMs > nowMs) sin(((state.reviewUntilMs - nowMs) / REVIEW_DELAY_MS.toFloat()) * PI).toFloat() * unit * 0.03f else 0f
        val left = cx - width / 2f
        val top = cy - height / 2f - lift - (if (state.terminal) removalProgress * unit * 0.12f else 0f)
        val right = left + width
        val bottom = top + height

        canvas.save()
        canvas.rotate((((seed % 9) - 4) * 1.1f), cx, cy)
        drawFolderShape(canvas, RectF(left, top, right, bottom), state, alpha)
        if (!layoutPrefs.wallpaperKanbanPrivacyModeEnabled && !state.terminal && index < 4) {
            textPaint.textSize = (unit * 0.045f).coerceIn(8f, 12f)
            textPaint.color = Color.argb((alpha * 0.78f).toInt().coerceIn(0, 220), 15, 23, 42)
            textPaint.textAlign = Paint.Align.CENTER
            canvas.drawText(state.title.take(FOLDER_TITLE_MAX_CHARS), cx, bottom + unit * 0.055f, textPaint)
            textPaint.textAlign = Paint.Align.LEFT
        }
        if (state.terminal) {
            drawRemovalSpark(canvas, cx, top, unit, removalProgress, alpha)
        }
        canvas.restore()
    }

    private fun drawFolderShape(canvas: Canvas, rect: RectF, state: VisualCardState, alpha: Int) {
        val color = colorForStatus(state.displayStatus, state.priority, alpha)
        val tabWidth = rect.width() * 0.38f
        val tabHeight = rect.height() * 0.28f
        folderPaint.color = color
        folderStrokePaint.alpha = (alpha * 0.72f).toInt().coerceIn(0, 190)

        val tab = RectF(rect.left + rect.width() * 0.08f, rect.top, rect.left + tabWidth, rect.top + tabHeight)
        canvas.drawRoundRect(tab, 6f, 6f, folderPaint)

        val bodyTop = rect.top + tabHeight * 0.45f
        val body = RectF(rect.left, bodyTop, rect.right, rect.bottom)
        if (state.displayStatus == "in_progress") {
            val back = Path().apply {
                moveTo(body.left + rect.width() * 0.05f, body.top + rect.height() * 0.05f)
                lineTo(body.right - rect.width() * 0.08f, body.top - rect.height() * 0.12f)
                lineTo(body.right, body.bottom - rect.height() * 0.12f)
                lineTo(body.left, body.bottom)
                close()
            }
            folderPaint.color = lighten(color, 1.18f, alpha)
            canvas.drawPath(back, folderPaint)
            folderPaint.color = color
            canvas.drawRoundRect(body, 7f, 7f, folderPaint)
            drawStatusMark(canvas, body, "in_progress", alpha)
        } else {
            canvas.drawRoundRect(body, 7f, 7f, folderPaint)
            drawStatusMark(canvas, body, state.displayStatus, alpha)
        }
        canvas.drawRoundRect(body, 7f, 7f, folderStrokePaint)
        folderStrokePaint.alpha = 255
    }

    private fun drawStatusMark(canvas: Canvas, body: RectF, status: String, alpha: Int) {
        accentPaint.color = Color.argb((alpha * 0.78f).toInt().coerceIn(0, 220), 255, 255, 255)
        val cx = body.right - body.width() * 0.22f
        val cy = body.top + body.height() * 0.48f
        when (status) {
            "todo" -> canvas.drawRect(cx - body.width() * 0.09f, cy - 2f, cx + body.width() * 0.09f, cy + 2f, accentPaint)
            "in_progress" -> canvas.drawCircle(cx, cy, body.width() * 0.08f, accentPaint)
            "review" -> {
                accentPaint.style = Paint.Style.STROKE
                accentPaint.strokeWidth = 2.4f
                canvas.drawCircle(cx - body.width() * 0.025f, cy - body.width() * 0.02f, body.width() * 0.065f, accentPaint)
                canvas.drawLine(cx + body.width() * 0.03f, cy + body.width() * 0.04f, cx + body.width() * 0.1f, cy + body.width() * 0.11f, accentPaint)
                accentPaint.style = Paint.Style.FILL
            }
            "blocked" -> {
                canvas.drawRoundRect(RectF(cx - body.width() * 0.075f, cy, cx + body.width() * 0.075f, cy + body.height() * 0.18f), 3f, 3f, accentPaint)
                accentPaint.style = Paint.Style.STROKE
                accentPaint.strokeWidth = 2f
                canvas.drawArc(RectF(cx - body.width() * 0.06f, cy - body.height() * 0.12f, cx + body.width() * 0.06f, cy + body.height() * 0.08f), 200f, 140f, false, accentPaint)
                accentPaint.style = Paint.Style.FILL
            }
        }
    }

    private fun drawRemovalSpark(canvas: Canvas, cx: Float, top: Float, unit: Float, progress: Float, alpha: Int) {
        accentPaint.color = Color.argb((alpha * (1f - progress)).toInt().coerceIn(0, 220), 74, 222, 128)
        accentPaint.strokeWidth = (unit * 0.012f).coerceAtLeast(2f)
        accentPaint.style = Paint.Style.STROKE
        val size = unit * (0.06f + progress * 0.08f)
        canvas.drawLine(cx - size, top - size * 0.1f, cx - size * 0.25f, top + size * 0.6f, accentPaint)
        canvas.drawLine(cx - size * 0.25f, top + size * 0.6f, cx + size, top - size * 0.75f, accentPaint)
        accentPaint.style = Paint.Style.FILL
    }

    private fun removalProgress(state: VisualCardState, nowMs: Long): Float {
        if (state.removalUntilMs == 0L || state.removalStartedAtMs == 0L || nowMs < state.removalStartedAtMs) return 0f
        val duration = (state.removalUntilMs - state.removalStartedAtMs).coerceAtLeast(1L)
        return ((nowMs - state.removalStartedAtMs).toFloat() / duration.toFloat()).coerceIn(0f, 1f)
    }

    private fun colorForStatus(status: String, priority: String, alpha: Int): Int {
        val base = when (status) {
            "todo" -> if (priority == "P0") Color.rgb(248, 113, 113) else Color.rgb(96, 165, 250)
            "in_progress" -> Color.rgb(45, 212, 191)
            "review" -> Color.rgb(168, 85, 247)
            "blocked" -> Color.rgb(239, 68, 68)
            "done" -> Color.rgb(34, 197, 94)
            "archived" -> Color.rgb(148, 163, 184)
            else -> Color.rgb(250, 204, 21)
        }
        return Color.argb(alpha.coerceIn(0, 255), Color.red(base), Color.green(base), Color.blue(base))
    }

    private fun preferredBoardWidth(unit: Float, cards: List<VisualCardState>): Float {
        textPaint.textSize = (unit * 0.075f).coerceIn(11f, 15f)
        val titleWidth = cards.take(MAX_BOARD_ROWS)
            .maxOfOrNull {
                val title = if (layoutPrefs.wallpaperKanbanPrivacyModeEnabled) "Task 1" else it.title
                textPaint.measureText(title)
            } ?: 0f
        val dateWidth = cards.take(MAX_BOARD_ROWS)
            .maxOfOrNull {
                val next = if (layoutPrefs.wallpaperKanbanPrivacyModeEnabled) "hidden" else formatNext(it.schedule)
                textPaint.measureText(next)
            } ?: 0f
        return (titleWidth + dateWidth + unit * 0.52f)
            .coerceIn(unit * 1.25f, unit * 2.15f)
            .coerceAtLeast(BOARD_MIN_WIDTH)
    }

    private fun ellipsizeToWidth(text: String, maxWidth: Float, paint: Paint): String {
        if (paint.measureText(text) <= maxWidth) return text
        val ellipsis = "..."
        val ellipsisWidth = paint.measureText(ellipsis)
        if (maxWidth <= ellipsisWidth) return ellipsis
        var low = 0
        var high = text.length
        while (low < high) {
            val mid = (low + high + 1) / 2
            if (paint.measureText(text.substring(0, mid)) + ellipsisWidth <= maxWidth) {
                low = mid
            } else {
                high = mid - 1
            }
        }
        return text.take(low).trimEnd() + ellipsis
    }

    private fun lighten(color: Int, factor: Float, alpha: Int): Int {
        return Color.argb(
            alpha.coerceIn(0, 255),
            min((Color.red(color) * factor).toInt(), 255),
            min((Color.green(color) * factor).toInt(), 255),
            min((Color.blue(color) * factor).toInt(), 255)
        )
    }

    private fun formatNext(schedule: WallpaperKanbanSchedule?): String {
        val nextRunAt = schedule?.nextRunAt ?: return "--"
        return dateFormat.format(Date(nextRunAt))
    }

    companion object {
        private const val REVIEW_DELAY_MS = 1_400L
        private const val REMOVAL_ANIMATION_MS = 1_600L
        private const val MAX_BOARD_ROWS = 5
        private const val BOARD_MARGIN = 12f
        private const val BOARD_GAP = 10f
        private const val BOARD_MIN_WIDTH = 148f
        private const val FOLDER_TITLE_MAX_CHARS = 10
    }
}
