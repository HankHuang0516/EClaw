package com.hank.clawlive.engine

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.LinearGradient
import android.graphics.RadialGradient
import android.graphics.RectF
import android.graphics.Shader
import android.graphics.Typeface
import android.graphics.drawable.Drawable
import android.text.TextPaint
import androidx.core.content.ContextCompat
import androidx.core.content.res.ResourcesCompat
import com.hank.clawlive.R
import com.hank.clawlive.data.local.LayoutPreferences
import com.hank.clawlive.data.local.WallpaperKanbanObjectStyle
import com.hank.clawlive.data.model.CharacterState
import com.hank.clawlive.data.model.EntityStatus
import com.hank.clawlive.data.model.WallpaperKanbanCard
import com.hank.clawlive.data.model.WallpaperKanbanSchedule
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.floor
import kotlin.math.min
import kotlin.math.sin

class WallpaperKanbanRenderer(
    context: Context,
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
        val entityId: Int,
        val base: Pair<Float, Float>,
        val unit: Float,
        val cards: List<VisualCardState>,
        val height: Float,
        val rowHeight: Float,
        val top: Float,
        var width: Float,
        var left: Float
    )

    private enum class TaskObjectKind {
        FOLDER,
        BOOK,
        CLIPBOARD,
        STORAGE_BOX,
        STICKY_CARD
    }

    private data class TaskObjectPlacement(
        val state: VisualCardState,
        val kind: TaskObjectKind,
        val rect: RectF,
        val centerX: Float,
        val centerY: Float,
        val rotation: Float,
        val alpha: Int,
        val column: Int,
        val layer: Int,
        val displayIndex: Int,
        val removalProgress: Float
    )

    private data class TaskOrbitSlot(
        val offsetX: Float,
        val offsetY: Float,
        val scale: Float,
        val rotationBias: Float
    )

    private val states = mutableMapOf<String, VisualCardState>()
    private val handwritingTypeface: Typeface? = ResourcesCompat.getFont(context, R.font.caveat_regular)
    private val whiteboardAsset: Drawable? = ContextCompat.getDrawable(context, R.drawable.wallpaper_whiteboard_asset)?.mutate()
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
    private val shadowPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.FILL
        color = Color.argb(72, 0, 0, 0)
    }
    private val textPaint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.argb(220, 15, 23, 42)
        textAlign = Paint.Align.LEFT
    }
    private val accentPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
    private val dateFormat = SimpleDateFormat("MM/dd HH:mm", Locale.getDefault())
    private val compactDateFormat = SimpleDateFormat("HH:mm", Locale.getDefault())

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
                    createAutomationBoardSpec(canvas, entityId, base, unit, automations)
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
                drawTaskObjectStack(canvas, entityId, base, unit, tasks, nowMs)
            }
        }
    }

    private fun createAutomationBoardSpec(
        canvas: Canvas,
        entityId: Int,
        base: Pair<Float, Float>,
        unit: Float,
        cards: List<VisualCardState>
    ): AutomationBoardSpec {
        val rowHeight = (unit * 0.105f).coerceIn(14f, 22f)
        val targetSurfaceHeight = unit * 0.18f + rowHeight * cards.take(MAX_BOARD_ROWS).size
        val height = (targetSurfaceHeight / BOARD_ASSET_WRITING_HEIGHT_FRACTION)
            .coerceIn(unit * 0.82f, unit * 1.12f)
        val width = preferredBoardWidth(unit, cards)
        val left = clampedBoardLeft(canvas, base.first, width)
        val top = (base.second - unit * 1.55f - height / 2f).coerceIn(18f, canvas.height - height - 18f)
        return AutomationBoardSpec(
            entityId = entityId,
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
        sorted.forEach { spec ->
            val anchorOutside = spec.base.first < spec.left || spec.base.first > spec.left + spec.width
            if (anchorOutside && spec.width > BOARD_MIN_WIDTH) {
                spec.width = (spec.width * 0.88f).coerceAtLeast(BOARD_MIN_WIDTH)
                spec.left = clampedBoardLeft(canvas, spec.base.first, spec.width)
            }
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
        val frameRect = RectF(left, top, left + spec.width, top + spec.height)
        val writingRect = boardWritingRect(frameRect)

        drawBoardOwnerAnchor(canvas, spec, frameRect)
        if (layoutPrefs.wallpaperKanbanAssetWhiteboardEnabled && whiteboardAsset != null) {
            drawWhiteboardAsset(canvas, frameRect)
        } else {
            drawWhiteboardStand(canvas, frameRect, unit)
            drawFallbackWhiteboardSurface(canvas, frameRect, unit)
        }

        canvas.save()
        canvas.clipRect(writingRect)
        textPaint.isFakeBoldText = true
        textPaint.color = Color.argb(225, 15, 23, 42)
        val previousTypeface = textPaint.typeface
        if (layoutPrefs.wallpaperKanbanHandwrittenBoardTextEnabled && handwritingTypeface != null) {
            textPaint.typeface = handwritingTypeface
        }
        textPaint.textAlign = Paint.Align.LEFT
        val headerLabel = if (writingRect.width() < unit * 0.62f) "Auto" else "Automation"
        textPaint.textSize = fitTextSizeToWidth(
            texts = listOf(headerLabel),
            maxWidth = writingRect.width(),
            preferredSize = (unit * 0.09f).coerceIn(13f, 18f),
            minSize = 10f,
            paint = textPaint
        )
        val headerMetrics = textPaint.fontMetrics
        val headerBaseline = writingRect.top - headerMetrics.ascent
        canvas.drawText(headerLabel, writingRect.left, headerBaseline, textPaint)
        textPaint.isFakeBoldText = false

        val rowsTop = headerBaseline + headerMetrics.descent + writingRect.height() * 0.08f
        val rowsHeight = (writingRect.bottom - rowsTop).coerceAtLeast(0f)
        val visibleCards = spec.cards.take(MAX_BOARD_ROWS)
        val maxRowsByHeight = floor(rowsHeight / BOARD_MIN_ROW_HEIGHT).toInt().coerceAtLeast(0)
        val rows = visibleCards.take(maxRowsByHeight.coerceAtMost(MAX_BOARD_ROWS))
        if (rows.isNotEmpty()) {
            val bulletRadius = (unit * 0.012f).coerceIn(1.8f, 3.2f)
            val titleLeft = writingRect.left + bulletRadius * 3.3f
            val dateRight = writingRect.right
            val rowLineHeight = rowsHeight / rows.size
            val rowAvailableWidth = (dateRight - titleLeft).coerceAtLeast(1f)
            val fullDateSamples = rows.map { card ->
                if (layoutPrefs.wallpaperKanbanPrivacyModeEnabled) "hidden" else formatNext(card.schedule)
            }
            val compactDateSamples = rows.map { card ->
                if (layoutPrefs.wallpaperKanbanPrivacyModeEnabled) "hidden" else formatNextCompact(card.schedule)
            }
            val showFullDate = rowAvailableWidth > unit * 0.72f
            val showCompactDate = !showFullDate && rowAvailableWidth > unit * 0.42f
            val dateSamples = when {
                showFullDate -> fullDateSamples
                showCompactDate -> compactDateSamples
                else -> emptyList()
            }
            val dateMaxWidth = when {
                showFullDate -> min(unit * 0.34f, rowAvailableWidth * 0.34f)
                showCompactDate -> min(unit * 0.22f, rowAvailableWidth * 0.27f)
                else -> 0f
            }
            val dateGap = if (dateSamples.isNotEmpty()) unit * 0.035f else 0f
            val titleMaxWidth = (rowAvailableWidth - dateMaxWidth - dateGap).coerceAtLeast(1f)
            val rowPreferredSize = min((unit * 0.068f).coerceIn(8.5f, 13f), rowLineHeight * 0.72f)
            rows.forEachIndexed { index, card ->
                val rawTitle = if (layoutPrefs.wallpaperKanbanPrivacyModeEnabled) {
                    "Task ${index + 1}"
                } else {
                    card.title
                }
                val rawDate = when {
                    layoutPrefs.wallpaperKanbanPrivacyModeEnabled -> "hidden"
                    showFullDate -> formatNext(card.schedule)
                    showCompactDate -> formatNextCompact(card.schedule)
                    else -> ""
                }
                val rowTextSize = min(
                    fitTextSizeToWidth(listOf(rawTitle), titleMaxWidth, rowPreferredSize, 6.5f, textPaint),
                    if (dateSamples.isNotEmpty()) {
                        fitTextSizeToWidth(listOf(rawDate), dateMaxWidth, rowPreferredSize, 6.5f, textPaint)
                    } else {
                        rowPreferredSize
                    }
                )
                textPaint.textSize = rowTextSize
                val rowMetrics = textPaint.fontMetrics
                val rowTextHeight = rowMetrics.descent - rowMetrics.ascent
                val rowTop = rowsTop + rowLineHeight * index
                val y = rowTop + (rowLineHeight - rowTextHeight) / 2f - rowMetrics.ascent
                accentPaint.color = colorForStatus(card.displayStatus, card.priority, 210)
                canvas.drawCircle(writingRect.left + bulletRadius, y - rowTextSize * 0.32f, bulletRadius, accentPaint)
                textPaint.color = Color.argb(220, 15, 23, 42)
                textPaint.textAlign = Paint.Align.LEFT
                val title = ellipsizeToWidth(rawTitle, titleMaxWidth, textPaint)
                canvas.drawText(title, titleLeft, y, textPaint)
                if (dateSamples.isNotEmpty()) {
                    textPaint.color = Color.argb(165, 71, 85, 105)
                    textPaint.textAlign = Paint.Align.RIGHT
                    canvas.drawText(ellipsizeToWidth(rawDate, dateMaxWidth, textPaint), dateRight, y, textPaint)
                    textPaint.textAlign = Paint.Align.LEFT
                }
            }
        }
        textPaint.textAlign = Paint.Align.LEFT
        textPaint.typeface = previousTypeface
        canvas.restore()
    }

    private fun drawBoardOwnerAnchor(canvas: Canvas, spec: AutomationBoardSpec, rect: RectF) {
        val anchorX = spec.base.first
        val boardX = anchorX.coerceIn(rect.left + spec.unit * 0.12f, rect.right - spec.unit * 0.12f)
        val startY = rect.bottom + spec.unit * 0.08f
        val endY = (spec.base.second - spec.unit * 0.58f).coerceAtLeast(startY + spec.unit * 0.08f)
        standPaint.strokeWidth = (spec.unit * 0.006f).coerceIn(1.2f, 2.6f)
        standPaint.color = Color.argb(68, 148, 163, 184)
        canvas.drawLine(boardX, startY, anchorX, endY, standPaint)
        accentPaint.color = Color.argb(100, 148, 163, 184)
        canvas.drawCircle(anchorX, endY, (spec.unit * 0.018f).coerceIn(2.5f, 5.5f), accentPaint)
    }

    private fun boardWritingRect(frameRect: RectF): RectF {
        if (!layoutPrefs.wallpaperKanbanAssetWhiteboardEnabled || whiteboardAsset == null) {
            return RectF(
                frameRect.left + frameRect.width() * 0.1f,
                frameRect.top + frameRect.height() * 0.1f,
                frameRect.right - frameRect.width() * 0.1f,
                frameRect.bottom - frameRect.height() * 0.28f
            )
        }
        return RectF(
            frameRect.left + frameRect.width() * BOARD_ASSET_WRITING_LEFT,
            frameRect.top + frameRect.height() * BOARD_ASSET_WRITING_TOP,
            frameRect.left + frameRect.width() * BOARD_ASSET_WRITING_RIGHT,
            frameRect.top + frameRect.height() * BOARD_ASSET_WRITING_BOTTOM
        )
    }

    private fun drawWhiteboardAsset(canvas: Canvas, rect: RectF) {
        whiteboardAsset?.let { drawable ->
            drawable.setBounds(
                rect.left.toInt(),
                rect.top.toInt(),
                rect.right.toInt(),
                rect.bottom.toInt()
            )
            drawable.alpha = 245
            drawable.draw(canvas)
        }
    }

    private fun drawFallbackWhiteboardSurface(canvas: Canvas, rect: RectF, unit: Float) {
        val panel = RectF(
            rect.left + rect.width() * 0.08f,
            rect.top + rect.height() * 0.12f,
            rect.right - rect.width() * 0.08f,
            rect.bottom - rect.height() * 0.28f
        )
        boardPaint.color = Color.argb(205, 248, 250, 252)
        canvas.drawRoundRect(panel, 8f, 8f, boardPaint)
        canvas.drawRoundRect(panel, 8f, 8f, boardStrokePaint)
        accentPaint.color = Color.argb(125, 148, 163, 184)
        canvas.drawRoundRect(
            RectF(
                panel.left + unit * 0.08f,
                panel.bottom - unit * 0.045f,
                panel.right - unit * 0.08f,
                panel.bottom - unit * 0.025f
            ),
            4f,
            4f,
            accentPaint
        )
    }

    private fun drawWhiteboardStand(canvas: Canvas, rect: RectF, unit: Float) {
        standPaint.strokeWidth = (unit * 0.014f).coerceIn(2.5f, 5.5f)
        standPaint.color = Color.argb(150, 51, 65, 85)
        val panelBottom = rect.top + rect.height() * 0.68f
        val legTopY = panelBottom - unit * 0.03f
        val legBottomY = rect.bottom - rect.height() * 0.04f
        val leftLegX = rect.left + rect.width() * 0.34f
        val rightLegX = rect.right - rect.width() * 0.34f
        canvas.drawLine(leftLegX, legTopY, leftLegX - unit * 0.08f, legBottomY, standPaint)
        canvas.drawLine(rightLegX, legTopY, rightLegX + unit * 0.08f, legBottomY, standPaint)
        canvas.drawLine(leftLegX + unit * 0.04f, legTopY, rightLegX - unit * 0.04f, legTopY, standPaint)
        canvas.drawLine(leftLegX - unit * 0.17f, legBottomY, leftLegX + unit * 0.06f, legBottomY, standPaint)
        canvas.drawLine(rightLegX - unit * 0.06f, legBottomY, rightLegX + unit * 0.17f, legBottomY, standPaint)
    }

    private fun drawTaskObjectStack(
        canvas: Canvas,
        entityId: Int,
        base: Pair<Float, Float>,
        unit: Float,
        tasks: List<VisualCardState>,
        nowMs: Long
    ) {
        if (tasks.isEmpty()) return
        val clusterCount = taskObjectClusterCount(tasks)
        val placements = tasks.mapIndexedNotNull { index, state ->
            createTaskObjectPlacement(canvas, entityId, base, unit, clusterCount, index, state, nowMs)
        }
        if (placements.isEmpty()) return

        placements.groupBy { it.column }.values.forEach { clusterPlacements ->
            val minLeft = clusterPlacements.minOf { it.rect.left }
            val maxRight = clusterPlacements.maxOf { it.rect.right }
            val maxBottom = clusterPlacements.maxOf { it.rect.bottom }
            shadowPaint.color = Color.argb(42, 100, 116, 139)
            canvas.drawOval(
                RectF(minLeft - unit * 0.035f, maxBottom - unit * 0.025f, maxRight + unit * 0.035f, maxBottom + unit * 0.055f),
                shadowPaint
            )
        }

        placements.sortedWith(compareBy<TaskObjectPlacement> { it.centerY }.thenBy { it.layer }).forEach { placement ->
            drawTaskObjectPlacement(canvas, placement, unit)
        }
    }

    private fun taskObjectClusterCount(tasks: List<VisualCardState>): Int {
        val folderCount = tasks.count { resolveTaskObjectKind(it) == TaskObjectKind.FOLDER }
        val folderDominant = folderCount * 2 >= tasks.size
        val maxClusters = if (folderDominant) MAX_FOLDER_GROUND_CLUSTERS else MAX_TASK_ORBIT_CLUSTERS
        return tasks.size.coerceIn(1, maxClusters)
    }

    private fun createTaskObjectPlacement(
        canvas: Canvas,
        entityId: Int,
        base: Pair<Float, Float>,
        unit: Float,
        clusterCount: Int,
        index: Int,
        state: VisualCardState,
        nowMs: Long
    ): TaskObjectPlacement? {
        val removalProgress = removalProgress(state, nowMs)
        if (state.terminal && removalProgress >= 1f) return null
        val seed = abs(state.id.hashCode())
        val kind = resolveTaskObjectKind(state)
        val column = index % clusterCount
        val layer = index / clusterCount
        val slot = taskOrbitSlot(canvas, entityId, base, column, kind)
        val size = taskObjectSize(kind, unit * slot.scale, seed)
        val width = size.first
        val height = size.second
        val layerRise = when (kind) {
            TaskObjectKind.BOOK -> height * 0.46f
            TaskObjectKind.STORAGE_BOX -> height * 0.34f
            TaskObjectKind.CLIPBOARD -> height * 0.18f
            TaskObjectKind.STICKY_CARD -> height * 0.24f
            TaskObjectKind.FOLDER -> height * 0.36f
        }
        val naturalJitterX = (((seed / 7) % 5) - 2) * unit * 0.006f
        val naturalJitterY = (((seed / 13) % 5) - 2) * unit * 0.004f
        val lift = if (state.reviewUntilMs > nowMs) {
            sin(((state.reviewUntilMs - nowMs) / REVIEW_DELAY_MS.toFloat()) * PI).toFloat() * unit * 0.035f
        } else {
            0f
        }
        val removalLift = if (state.terminal) removalProgress * unit * 0.13f else 0f
        val stackLean = (((seed / 19) % 3) - 1) * unit * (if (kind == TaskObjectKind.FOLDER) 0.015f else 0.007f) * layer
        val centerX = (base.first + slot.offsetX * unit + stackLean + naturalJitterX)
            .coerceIn(width * 0.62f, canvas.width - width * 0.62f)
        val centerY = (base.second + unit * slot.offsetY - layer * layerRise + naturalJitterY - lift - removalLift)
            .coerceIn(height * 0.65f, canvas.height - unit * 0.06f)
        val rect = RectF(centerX - width / 2f, centerY - height / 2f, centerX + width / 2f, centerY + height / 2f)
        val alpha = if (state.terminal) ((1f - removalProgress) * 230).toInt() else 230
        val rotation = when (kind) {
            TaskObjectKind.BOOK -> slot.rotationBias + (((seed % 5) - 2) * 0.85f)
            TaskObjectKind.CLIPBOARD -> slot.rotationBias + (((seed % 7) - 3) * 1.1f)
            TaskObjectKind.STICKY_CARD -> slot.rotationBias + (((seed % 9) - 4) * 1.8f)
            else -> slot.rotationBias + (((seed % 7) - 3) * 0.9f)
        }
        return TaskObjectPlacement(
            state = state,
            kind = kind,
            rect = rect,
            centerX = centerX,
            centerY = centerY,
            rotation = rotation,
            alpha = alpha.coerceIn(0, 230),
            column = column,
            layer = layer,
            displayIndex = index,
            removalProgress = removalProgress
        )
    }

    private fun taskOrbitSlot(
        canvas: Canvas,
        entityId: Int,
        base: Pair<Float, Float>,
        cluster: Int,
        kind: TaskObjectKind
    ): TaskOrbitSlot {
        if (kind == TaskObjectKind.FOLDER) {
            return folderGroundSlot(canvas, base, cluster)
        }
        val defaultSlots = arrayOf(
            TaskOrbitSlot(-0.48f, 0.58f, 1.04f, -2.8f),
            TaskOrbitSlot(0.48f, 0.58f, 1.04f, 2.6f),
            TaskOrbitSlot(-0.24f, 1.04f, 0.92f, -1.4f),
            TaskOrbitSlot(0.24f, 1.04f, 0.92f, 1.4f),
            TaskOrbitSlot(-0.36f, 0.25f, 0.9f, -1.2f),
            TaskOrbitSlot(0.36f, 0.25f, 0.9f, 1.2f),
            TaskOrbitSlot(0f, 0.1f, 0.84f, if (entityId % 2 == 0) -0.8f else 0.8f)
        )
        val leftEdgeSlots = arrayOf(
            TaskOrbitSlot(0.46f, 0.54f, 1.04f, 2.2f),
            TaskOrbitSlot(0.72f, 0.52f, 1.02f, 3.0f),
            TaskOrbitSlot(0.30f, 1.04f, 0.92f, -1.4f),
            TaskOrbitSlot(0.58f, 1.04f, 0.92f, 1.4f),
            TaskOrbitSlot(0.30f, 0.22f, 0.9f, 0.8f),
            TaskOrbitSlot(0.20f, 0.58f, 1.08f, -1.4f),
            TaskOrbitSlot(0.52f, 0.08f, 0.84f, 1.0f),
            TaskOrbitSlot(0.78f, 0.42f, 1f, 2.8f)
        )
        val rightEdgeSlots = arrayOf(
            TaskOrbitSlot(-0.46f, 0.54f, 1.04f, -2.2f),
            TaskOrbitSlot(-0.72f, 0.52f, 1.02f, -3.0f),
            TaskOrbitSlot(-0.30f, 1.04f, 0.92f, 1.4f),
            TaskOrbitSlot(-0.58f, 1.04f, 0.92f, -1.4f),
            TaskOrbitSlot(-0.30f, 0.22f, 0.9f, -0.8f),
            TaskOrbitSlot(-0.20f, 0.58f, 1.08f, 1.4f),
            TaskOrbitSlot(-0.52f, 0.08f, 0.84f, -1.0f),
            TaskOrbitSlot(-0.78f, 0.42f, 1f, -2.8f)
        )
        val slots = when {
            base.first < canvas.width * 0.28f -> leftEdgeSlots
            base.first > canvas.width * 0.72f -> rightEdgeSlots
            else -> defaultSlots
        }
        return slots[cluster % slots.size]
    }

    private fun folderGroundSlot(canvas: Canvas, base: Pair<Float, Float>, cluster: Int): TaskOrbitSlot {
        val defaultSlots = arrayOf(
            TaskOrbitSlot(-0.74f, 0.76f, 1.04f, -3.2f),
            TaskOrbitSlot(0.74f, 0.76f, 1.04f, 3.1f),
            TaskOrbitSlot(-0.40f, 1.28f, 0.94f, -1.6f),
            TaskOrbitSlot(0.40f, 1.28f, 0.94f, 1.6f)
        )
        val leftEdgeSlots = arrayOf(
            TaskOrbitSlot(0.68f, 0.72f, 1.04f, 2.6f),
            TaskOrbitSlot(0.98f, 0.74f, 1.02f, 3.3f),
            TaskOrbitSlot(0.46f, 1.24f, 0.94f, -1.3f),
            TaskOrbitSlot(0.82f, 1.24f, 0.94f, 1.6f)
        )
        val rightEdgeSlots = arrayOf(
            TaskOrbitSlot(-0.68f, 0.72f, 1.04f, -2.6f),
            TaskOrbitSlot(-0.98f, 0.74f, 1.02f, -3.3f),
            TaskOrbitSlot(-0.46f, 1.24f, 0.94f, 1.3f),
            TaskOrbitSlot(-0.82f, 1.24f, 0.94f, -1.6f)
        )
        val slots = when {
            base.first < canvas.width * 0.28f -> leftEdgeSlots
            base.first > canvas.width * 0.72f -> rightEdgeSlots
            else -> defaultSlots
        }
        return slots[cluster % slots.size]
    }

    private fun resolveTaskObjectKind(state: VisualCardState): TaskObjectKind {
        return when (layoutPrefs.wallpaperKanbanObjectStyle) {
            WallpaperKanbanObjectStyle.FOLDER -> TaskObjectKind.FOLDER
            WallpaperKanbanObjectStyle.BOOK_NOTEBOOK -> TaskObjectKind.BOOK
            WallpaperKanbanObjectStyle.CLIPBOARD -> TaskObjectKind.CLIPBOARD
            WallpaperKanbanObjectStyle.STORAGE_BOX -> TaskObjectKind.STORAGE_BOX
            WallpaperKanbanObjectStyle.STICKY_CARD -> TaskObjectKind.STICKY_CARD
            WallpaperKanbanObjectStyle.SMART_MIX -> when (state.displayStatus) {
                "todo" -> TaskObjectKind.FOLDER
                "in_progress" -> TaskObjectKind.BOOK
                "review" -> TaskObjectKind.CLIPBOARD
                "blocked" -> TaskObjectKind.STORAGE_BOX
                else -> TaskObjectKind.STICKY_CARD
            }
        }
    }

    private fun taskObjectSize(kind: TaskObjectKind, unit: Float, seed: Int): Pair<Float, Float> {
        val variance = ((seed % 5) - 2) * 0.012f
        return when (kind) {
            TaskObjectKind.BOOK -> unit * (0.55f + variance) to unit * (0.16f + variance * 0.35f)
            TaskObjectKind.FOLDER -> unit * (0.56f + variance) to unit * (0.32f + variance * 0.4f)
            TaskObjectKind.CLIPBOARD -> unit * (0.34f + variance) to unit * (0.43f + variance)
            TaskObjectKind.STORAGE_BOX -> unit * (0.42f + variance) to unit * (0.31f + variance * 0.6f)
            TaskObjectKind.STICKY_CARD -> unit * (0.34f + variance) to unit * (0.25f + variance * 0.4f)
        }
    }

    private fun drawTaskObjectPlacement(canvas: Canvas, placement: TaskObjectPlacement, unit: Float) {
        canvas.save()
        canvas.rotate(placement.rotation, placement.centerX, placement.centerY)
        when (placement.kind) {
            TaskObjectKind.FOLDER -> drawFolderShape(canvas, placement.rect, placement.state, placement.alpha)
            TaskObjectKind.BOOK -> drawBookShape(canvas, placement.rect, placement.state, placement.alpha, placement.layer)
            TaskObjectKind.CLIPBOARD -> drawClipboardShape(canvas, placement.rect, placement.state, placement.alpha)
            TaskObjectKind.STORAGE_BOX -> drawStorageBoxShape(canvas, placement.rect, placement.state, placement.alpha)
            TaskObjectKind.STICKY_CARD -> drawStickyCardShape(canvas, placement.rect, placement.state, placement.alpha)
        }
        if (placement.state.terminal) {
            drawRemovalSpark(canvas, placement.centerX, placement.rect.top, unit, placement.removalProgress, placement.alpha)
        }
        canvas.restore()
    }

    private fun drawBookShape(canvas: Canvas, rect: RectF, state: VisualCardState, alpha: Int, layer: Int) {
        val coverColor = colorForStatus(state.displayStatus, state.priority, alpha)
        val pageAlpha = (alpha * 0.9f).toInt().coerceIn(0, 230)
        val pageEdge = rect.height() * 0.38f
        val cover = RectF(rect.left, rect.top, rect.right, rect.bottom - pageEdge * 0.25f)
        val pages = RectF(rect.left + rect.width() * 0.04f, rect.bottom - pageEdge, rect.right - rect.width() * 0.13f, rect.bottom)
        val spine = RectF(rect.right - rect.width() * 0.16f, rect.top + rect.height() * 0.06f, rect.right, rect.bottom - rect.height() * 0.05f)

        shadowPaint.color = Color.argb((alpha * 0.18f).toInt().coerceIn(0, 70), 0, 0, 0)
        canvas.drawRoundRect(RectF(rect.left, rect.bottom - rect.height() * 0.22f, rect.right, rect.bottom + rect.height() * 0.18f), 7f, 7f, shadowPaint)

        folderPaint.color = Color.argb(pageAlpha, 252, 240, 202)
        canvas.drawRoundRect(pages, 5f, 5f, folderPaint)
        accentPaint.color = Color.argb((alpha * 0.32f).toInt().coerceIn(0, 95), 146, 64, 14)
        accentPaint.strokeWidth = 1.1f
        accentPaint.style = Paint.Style.STROKE
        val pageLines = 3
        repeat(pageLines) { i ->
            val y = pages.top + pages.height() * (i + 1) / (pageLines + 1)
            canvas.drawLine(pages.left + 5f, y, pages.right - 4f, y, accentPaint)
        }
        accentPaint.style = Paint.Style.FILL

        folderPaint.color = coverColor
        canvas.drawRoundRect(cover, 8f, 8f, folderPaint)
        folderPaint.color = darken(coverColor, 0.72f, alpha)
        canvas.drawRoundRect(spine, 8f, 8f, folderPaint)
        accentPaint.color = Color.argb((alpha * 0.75f).toInt().coerceIn(0, 210), 250, 204, 21)
        val lineX = spine.left + spine.width() * 0.35f
        canvas.drawRoundRect(RectF(lineX, spine.top + 4f, lineX + 1.8f, spine.bottom - 4f), 2f, 2f, accentPaint)
        if (layer % 3 == 0) {
            val lineX2 = spine.left + spine.width() * 0.62f
            canvas.drawRoundRect(RectF(lineX2, spine.top + 6f, lineX2 + 1.4f, spine.bottom - 6f), 2f, 2f, accentPaint)
        }
        drawStatusMark(canvas, RectF(rect.left + rect.width() * 0.62f, cover.top, cover.right, cover.bottom), state.displayStatus, alpha)
    }

    private fun drawClipboardShape(canvas: Canvas, rect: RectF, state: VisualCardState, alpha: Int) {
        val statusColor = colorForStatus(state.displayStatus, state.priority, alpha)
        val boardColor = darken(statusColor, 0.78f, alpha)
        folderPaint.color = boardColor
        canvas.drawRoundRect(rect, 9f, 9f, folderPaint)
        folderStrokePaint.alpha = (alpha * 0.62f).toInt().coerceIn(0, 170)
        canvas.drawRoundRect(rect, 9f, 9f, folderStrokePaint)
        folderStrokePaint.alpha = 255

        val paper = RectF(
            rect.left + rect.width() * 0.11f,
            rect.top + rect.height() * 0.18f,
            rect.right - rect.width() * 0.11f,
            rect.bottom - rect.height() * 0.08f
        )
        folderPaint.color = Color.argb((alpha * 0.94f).toInt().coerceIn(0, 240), 248, 250, 252)
        canvas.drawRoundRect(paper, 6f, 6f, folderPaint)

        accentPaint.color = Color.argb((alpha * 0.85f).toInt().coerceIn(0, 220), 100, 116, 139)
        canvas.drawRoundRect(
            RectF(rect.centerX() - rect.width() * 0.18f, rect.top + rect.height() * 0.04f, rect.centerX() + rect.width() * 0.18f, rect.top + rect.height() * 0.18f),
            5f,
            5f,
            accentPaint
        )
        drawStatusMark(canvas, paper, state.displayStatus, alpha)
    }

    private fun drawStorageBoxShape(canvas: Canvas, rect: RectF, state: VisualCardState, alpha: Int) {
        val color = colorForStatus(state.displayStatus, state.priority, alpha)
        val topFace = Path().apply {
            moveTo(rect.left + rect.width() * 0.12f, rect.top)
            lineTo(rect.right - rect.width() * 0.08f, rect.top + rect.height() * 0.08f)
            lineTo(rect.right, rect.top + rect.height() * 0.32f)
            lineTo(rect.left + rect.width() * 0.04f, rect.top + rect.height() * 0.25f)
            close()
        }
        val front = RectF(rect.left + rect.width() * 0.04f, rect.top + rect.height() * 0.25f, rect.right, rect.bottom)
        val side = Path().apply {
            moveTo(rect.right - rect.width() * 0.08f, rect.top + rect.height() * 0.08f)
            lineTo(rect.right, rect.top + rect.height() * 0.32f)
            lineTo(rect.right, rect.bottom)
            lineTo(rect.right - rect.width() * 0.12f, rect.bottom - rect.height() * 0.12f)
            close()
        }
        folderPaint.color = lighten(color, 1.18f, alpha)
        canvas.drawPath(topFace, folderPaint)
        folderPaint.color = color
        canvas.drawRoundRect(front, 7f, 7f, folderPaint)
        folderPaint.color = darken(color, 0.72f, alpha)
        canvas.drawPath(side, folderPaint)
        accentPaint.color = Color.argb((alpha * 0.3f).toInt().coerceIn(0, 90), 120, 53, 15)
        canvas.drawRect(rect.left + rect.width() * 0.14f, rect.top + rect.height() * 0.46f, rect.right - rect.width() * 0.2f, rect.top + rect.height() * 0.52f, accentPaint)
        drawStatusMark(canvas, front, state.displayStatus, alpha)
    }

    private fun drawStickyCardShape(canvas: Canvas, rect: RectF, state: VisualCardState, alpha: Int) {
        val color = lighten(colorForStatus(state.displayStatus, state.priority, alpha), 1.22f, alpha)
        val corner = rect.width() * 0.18f
        val card = Path().apply {
            moveTo(rect.left, rect.top)
            lineTo(rect.right - corner, rect.top)
            lineTo(rect.right, rect.top + corner)
            lineTo(rect.right, rect.bottom)
            lineTo(rect.left, rect.bottom)
            close()
        }
        folderPaint.color = color
        canvas.drawPath(card, folderPaint)
        folderPaint.color = darken(color, 0.84f, alpha)
        val fold = Path().apply {
            moveTo(rect.right - corner, rect.top)
            lineTo(rect.right, rect.top + corner)
            lineTo(rect.right - corner, rect.top + corner)
            close()
        }
        canvas.drawPath(fold, folderPaint)
        folderStrokePaint.alpha = (alpha * 0.52f).toInt().coerceIn(0, 160)
        canvas.drawRoundRect(rect, 4f, 4f, folderStrokePaint)
        folderStrokePaint.alpha = 255
        drawStatusMark(canvas, rect, state.displayStatus, alpha)
    }

    private fun drawFolderShape(canvas: Canvas, rect: RectF, state: VisualCardState, alpha: Int) {
        val color = colorForStatus(state.displayStatus, state.priority, alpha)
        val width = rect.width()
        val height = rect.height()
        val open = state.displayStatus == "in_progress" || state.displayStatus == "review"
        val depth = height * 0.16f
        val frontTop = rect.top + height * if (open) 0.43f else 0.32f
        val frontBottom = rect.bottom - height * 0.08f
        val backTop = rect.top + height * 0.08f
        val backBottom = rect.bottom - height * 0.22f
        folderStrokePaint.alpha = (alpha * 0.72f).toInt().coerceIn(0, 190)

        shadowPaint.shader = RadialGradient(
            rect.centerX(),
            rect.bottom - depth * 0.15f,
            width * 0.58f,
            intArrayOf(Color.argb((alpha * 0.26f).toInt().coerceIn(0, 86), 51, 65, 85), Color.TRANSPARENT),
            floatArrayOf(0.28f, 1f),
            Shader.TileMode.CLAMP
        )
        canvas.drawOval(
            RectF(rect.left + width * 0.04f, rect.bottom - depth * 0.42f, rect.right + width * 0.06f, rect.bottom + depth * 0.56f),
            shadowPaint
        )
        shadowPaint.shader = null

        val bottomFace = Path().apply {
            moveTo(rect.left + width * 0.06f, frontBottom - depth * 0.35f)
            lineTo(rect.right - width * 0.02f, frontBottom - depth * 0.62f)
            lineTo(rect.right - width * 0.1f, frontBottom + depth * 0.3f)
            lineTo(rect.left + width * 0.1f, frontBottom + depth * 0.48f)
            close()
        }
        folderPaint.shader = LinearGradient(
            0f,
            frontBottom - depth,
            0f,
            frontBottom + depth,
            darken(color, 0.82f, alpha),
            darken(color, 0.48f, alpha),
            Shader.TileMode.CLAMP
        )
        canvas.drawPath(bottomFace, folderPaint)
        folderPaint.shader = null

        val backCover = Path().apply {
            moveTo(rect.left + width * 0.08f, backTop + height * 0.08f)
            lineTo(rect.right - width * 0.1f, backTop)
            lineTo(rect.right - width * 0.03f, backBottom)
            lineTo(rect.left + width * 0.02f, backBottom + height * 0.06f)
            close()
        }
        folderPaint.shader = LinearGradient(
            0f,
            backTop,
            0f,
            backBottom,
            lighten(color, 1.22f, alpha),
            lighten(color, 0.92f, alpha),
            Shader.TileMode.CLAMP
        )
        canvas.drawPath(backCover, folderPaint)
        folderPaint.shader = null

        val tab = Path().apply {
            moveTo(rect.left + width * 0.13f, backTop + height * 0.02f)
            lineTo(rect.left + width * 0.42f, backTop - height * 0.01f)
            lineTo(rect.left + width * 0.52f, backTop + height * 0.11f)
            lineTo(rect.left + width * 0.18f, backTop + height * 0.14f)
            close()
        }
        folderPaint.shader = LinearGradient(
            0f,
            backTop,
            0f,
            backTop + height * 0.16f,
            lighten(color, 1.32f, alpha),
            lighten(color, 1.02f, alpha),
            Shader.TileMode.CLAMP
        )
        canvas.drawPath(tab, folderPaint)
        folderPaint.shader = null

        val paperTop = frontTop - height * if (open) 0.2f else 0.08f
        val paperBottom = frontTop + height * if (open) 0.15f else 0.05f
        val paperStack = Path().apply {
            moveTo(rect.left + width * 0.12f, paperTop + height * 0.04f)
            lineTo(rect.right - width * 0.13f, paperTop)
            lineTo(rect.right - width * 0.06f, paperBottom)
            lineTo(rect.left + width * 0.08f, paperBottom + height * 0.03f)
            close()
        }
        folderPaint.shader = LinearGradient(
            0f,
            paperTop,
            0f,
            paperBottom,
            Color.argb((alpha * 0.96f).toInt().coerceIn(0, 245), 255, 248, 225),
            Color.argb((alpha * 0.9f).toInt().coerceIn(0, 235), 226, 214, 184),
            Shader.TileMode.CLAMP
        )
        canvas.drawPath(paperStack, folderPaint)
        folderPaint.shader = null
        accentPaint.shader = null
        accentPaint.style = Paint.Style.STROKE
        accentPaint.strokeWidth = (height * 0.018f).coerceIn(0.8f, 1.8f)
        accentPaint.color = Color.argb((alpha * 0.28f).toInt().coerceIn(0, 86), 120, 53, 15)
        repeat(if (open) 4 else 2) { i ->
            val y = paperTop + (paperBottom - paperTop) * (i + 1) / (if (open) 5f else 3f)
            canvas.drawLine(rect.left + width * 0.13f, y + height * 0.02f, rect.right - width * 0.11f, y - height * 0.02f, accentPaint)
        }
        accentPaint.style = Paint.Style.FILL

        val frontCover = Path().apply {
            moveTo(rect.left + width * 0.02f, frontTop + height * 0.05f)
            lineTo(rect.right - width * 0.08f, frontTop - height * 0.07f)
            lineTo(rect.right, frontBottom - depth * 0.42f)
            lineTo(rect.left + width * 0.07f, frontBottom)
            close()
        }
        folderPaint.shader = LinearGradient(
            rect.left,
            frontTop,
            rect.right,
            frontBottom,
            lighten(color, 1.12f, alpha),
            darken(color, 0.72f, alpha),
            Shader.TileMode.CLAMP
        )
        canvas.drawPath(frontCover, folderPaint)
        folderPaint.shader = null

        val frontLip = Path().apply {
            moveTo(rect.left + width * 0.07f, frontBottom - depth * 0.2f)
            lineTo(rect.right, frontBottom - depth * 0.52f)
            lineTo(rect.right - width * 0.1f, frontBottom + depth * 0.18f)
            lineTo(rect.left + width * 0.11f, frontBottom + depth * 0.36f)
            close()
        }
        folderPaint.shader = LinearGradient(
            0f,
            frontBottom - depth,
            0f,
            frontBottom + depth,
            darken(color, 0.76f, alpha),
            darken(color, 0.52f, alpha),
            Shader.TileMode.CLAMP
        )
        canvas.drawPath(frontLip, folderPaint)
        folderPaint.shader = null

        accentPaint.shader = null
        accentPaint.style = Paint.Style.STROKE
        accentPaint.strokeWidth = (height * 0.018f).coerceIn(0.9f, 1.8f)
        accentPaint.color = Color.argb((alpha * 0.32f).toInt().coerceIn(0, 95), 255, 255, 255)
        canvas.drawLine(
            rect.left + width * 0.11f,
            frontBottom - depth * 0.22f,
            rect.right - width * 0.12f,
            frontBottom - depth * 0.48f,
            accentPaint
        )
        accentPaint.color = Color.argb((alpha * 0.22f).toInt().coerceIn(0, 70), 15, 23, 42)
        canvas.drawLine(
            rect.left + width * 0.1f,
            frontBottom + depth * 0.34f,
            rect.right - width * 0.13f,
            frontBottom + depth * 0.12f,
            accentPaint
        )
        accentPaint.style = Paint.Style.FILL

        folderStrokePaint.strokeWidth = (height * 0.028f).coerceIn(1.1f, 2.4f)
        canvas.drawPath(backCover, folderStrokePaint)
        canvas.drawPath(frontCover, folderStrokePaint)
        canvas.drawPath(frontLip, folderStrokePaint)

        val statusBounds = RectF(
            rect.right - width * 0.34f,
            frontTop + height * 0.08f,
            rect.right - width * 0.08f,
            frontBottom - height * 0.05f
        )
        drawStatusMark(canvas, statusBounds, state.displayStatus, alpha)
        folderPaint.shader = null
        accentPaint.shader = null
        shadowPaint.shader = null
        folderStrokePaint.alpha = 255
        folderStrokePaint.strokeWidth = 2.2f
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
                val next = if (layoutPrefs.wallpaperKanbanPrivacyModeEnabled) "hidden" else formatNextCompact(it.schedule)
                textPaint.measureText(next)
            } ?: 0f
        val desiredWritingWidth = titleWidth + dateWidth + unit * 0.26f
        return (desiredWritingWidth / BOARD_ASSET_WRITING_WIDTH_FRACTION)
            .coerceIn(unit * 1.18f, unit * 2.05f)
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

    private fun fitTextSizeToWidth(
        texts: List<String>,
        maxWidth: Float,
        preferredSize: Float,
        minSize: Float,
        paint: Paint
    ): Float {
        if (texts.isEmpty() || maxWidth <= 0f) return minSize
        var size = preferredSize.coerceAtLeast(minSize)
        paint.textSize = size
        while (size > minSize && texts.any { paint.measureText(it) > maxWidth }) {
            size -= 0.75f
            paint.textSize = size
        }
        return size.coerceAtLeast(minSize)
    }

    private fun lighten(color: Int, factor: Float, alpha: Int): Int {
        return Color.argb(
            alpha.coerceIn(0, 255),
            min((Color.red(color) * factor).toInt(), 255),
            min((Color.green(color) * factor).toInt(), 255),
            min((Color.blue(color) * factor).toInt(), 255)
        )
    }

    private fun darken(color: Int, factor: Float, alpha: Int): Int {
        return Color.argb(
            alpha.coerceIn(0, 255),
            (Color.red(color) * factor).toInt().coerceIn(0, 255),
            (Color.green(color) * factor).toInt().coerceIn(0, 255),
            (Color.blue(color) * factor).toInt().coerceIn(0, 255)
        )
    }

    private fun formatNext(schedule: WallpaperKanbanSchedule?): String {
        val nextRunAt = schedule?.nextRunAt ?: return "--"
        return dateFormat.format(Date(nextRunAt))
    }

    private fun formatNextCompact(schedule: WallpaperKanbanSchedule?): String {
        val nextRunAt = schedule?.nextRunAt ?: return "--"
        return compactDateFormat.format(Date(nextRunAt))
    }

    companion object {
        private const val REVIEW_DELAY_MS = 1_400L
        private const val REMOVAL_ANIMATION_MS = 1_600L
        private const val MAX_BOARD_ROWS = 5
        private const val BOARD_MARGIN = 12f
        private const val BOARD_GAP = 10f
        private const val BOARD_MIN_WIDTH = 148f
        private const val BOARD_MIN_ROW_HEIGHT = 9f
        private const val BOARD_ASSET_WRITING_LEFT = 0.24f
        private const val BOARD_ASSET_WRITING_TOP = 0.24f
        private const val BOARD_ASSET_WRITING_RIGHT = 0.76f
        private const val BOARD_ASSET_WRITING_BOTTOM = 0.58f
        private const val BOARD_ASSET_WRITING_WIDTH_FRACTION = BOARD_ASSET_WRITING_RIGHT - BOARD_ASSET_WRITING_LEFT
        private const val BOARD_ASSET_WRITING_HEIGHT_FRACTION = BOARD_ASSET_WRITING_BOTTOM - BOARD_ASSET_WRITING_TOP
        private const val MAX_TASK_ORBIT_CLUSTERS = 6
        private const val MAX_FOLDER_GROUND_CLUSTERS = 4
    }
}
