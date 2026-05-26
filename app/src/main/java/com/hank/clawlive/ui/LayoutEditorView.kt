package com.hank.clawlive.ui

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.util.AttributeSet
import android.view.MotionEvent
import android.view.View
import com.hank.clawlive.R
import com.hank.clawlive.data.local.LayoutPreferences
import com.hank.clawlive.data.model.EntityStatus
import kotlin.math.ceil
import kotlin.math.sqrt

/**
 * Custom View for drag-and-drop entity positioning with two-stage
 * pinch-to-resize.
 * 
 * Gestures:
 * - Tap entity: lock the target
 * - 1 finger drag on locked entity: move it
 * - 2 finger pinch anywhere: resize the locked entity
 */
class LayoutEditorView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
    defStyleAttr: Int = 0
) : View(context, attrs, defStyleAttr) {

    private val layoutPrefs = LayoutPreferences.getInstance(context)

    // Entities to display (only bound entities)
    private var entities: List<EntityStatus> = emptyList()

    // Custom positions (percentage 0.0-1.0)
    private val entityPositions = mutableMapOf<Int, Pair<Float, Float>>()
    
    // Per-entity scales
    private val entityScales = mutableMapOf<Int, Float>()

    // Drag state
    private var draggingEntityIndex: Int = -1
    private var lastTouchX = 0f
    private var lastTouchY = 0f
    private var dragOffsetX = 0f
    private var dragOffsetY = 0f
    private var lockedEntityId: Int? = null
    
    // Scale gesture state
    private var scalingEntityIndex: Int = -1
    private var isScaling = false
    private var lastPinchSpan = 0f

    // Hit test radius (scaled with view size)
    private val hitRadiusFactor = 0.12f

    // Paint for position indicator
    private val indicatorPaint = Paint().apply {
        color = Color.WHITE
        style = Paint.Style.STROKE
        strokeWidth = 4f
        isAntiAlias = true
    }

    private val labelPaint = Paint().apply {
        color = Color.WHITE
        textSize = 40f
        textAlign = Paint.Align.CENTER
        isAntiAlias = true
    }
    
    init {
        // Enable drawing
        setWillNotDraw(false)
    }

    /**
     * Set entities to display. Only bound entities should be passed.
     */
    fun setEntities(boundEntities: List<EntityStatus>) {
        entities = boundEntities

        // Initialize positions and scales from prefs or default to center
        entityPositions.clear()
        entityScales.clear()
        entities.forEach { entity ->
            val customPos = layoutPrefs.getCustomPosition(entity.entityId)
            entityPositions[entity.entityId] = customPos ?: getDefaultPosition(
                entities.indexOf(entity),
                entities.size
            )
            entityScales[entity.entityId] = layoutPrefs.getEntityScale(entity.entityId)
        }
        if (lockedEntityId != null && entities.none { it.entityId == lockedEntityId }) {
            lockedEntityId = null
        }

        invalidate()
    }

    /**
     * Reset all positions and scales to default
     */
    fun resetPositions() {
        entities.forEach { entity ->
            val defaultPos = getDefaultPosition(entities.indexOf(entity), entities.size)
            entityPositions[entity.entityId] = defaultPos
            entityScales[entity.entityId] = 1.0f
            layoutPrefs.setCustomPosition(entity.entityId, defaultPos.first, defaultPos.second)
            layoutPrefs.setEntityScale(entity.entityId, 1.0f)
        }
        invalidate()
    }

    /**
     * Get default position for entity based on index and count.
     * Uses ceil(sqrt(n)) columns to build a grid that adapts to any entity count.
     * The last row is centered when it has fewer items than the column count.
     */
    private fun getDefaultPosition(index: Int, count: Int): Pair<Float, Float> {
        if (count <= 0) return Pair(0.5f, 0.5f)
        val cols = ceil(sqrt(count.toDouble())).toInt().coerceAtLeast(1)
        val rows = ceil(count.toDouble() / cols).toInt()
        val paddingX = 0.1f
        val paddingY = 0.15f
        val usableW = 1f - 2 * paddingX
        val usableH = 1f - 2 * paddingY
        val colStep = usableW / cols
        val rowStep = usableH / rows
        val row = index / cols
        val col = index % cols
        val itemsInLastRow = count - (rows - 1) * cols
        val x = if (row == rows - 1 && itemsInLastRow < cols) {
            paddingX + (usableW - itemsInLastRow * colStep) / 2f + col * colStep + colStep / 2f
        } else {
            paddingX + col * colStep + colStep / 2f
        }
        val y = paddingY + row * rowStep + rowStep / 2f
        return Pair(x, y)
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)

        // Background
        canvas.drawColor(Color.BLACK)

        if (entities.isEmpty()) {
            // Draw empty message
            labelPaint.textSize = 36f
            labelPaint.color = Color.GRAY
            canvas.drawText(context.getString(R.string.no_bound_entities), width / 2f, height / 2f, labelPaint)
            return
        }

        // Draw grid lines for reference
        drawGridLines(canvas)

        // Draw each entity with per-entity scale
        entities.forEachIndexed { index, entity ->
            val pos = entityPositions[entity.entityId] ?: Pair(0.5f, 0.5f)
            val x = pos.first * width
            val y = pos.second * height
            
            // Get per-entity scale
            val entityScale = entityScales[entity.entityId] ?: 1.0f

            // Draw position indicator (circle around entity)
            val isDragging = draggingEntityIndex == index
            val isScalingThis = scalingEntityIndex == index
            val isLocked = lockedEntityId == entity.entityId
            val indicatorRadius = width * hitRadiusFactor * entityScale
            if (isLocked) {
                val highlightColor = when {
                    isScalingThis -> Color.CYAN
                    isDragging -> Color.YELLOW
                    else -> Color.rgb(64, 224, 255)
                }
                drawLockedEntityHalo(canvas, x, y, indicatorRadius, highlightColor)
            }

            indicatorPaint.color = when {
                isScalingThis -> Color.CYAN  // Scaling
                isDragging -> Color.YELLOW   // Dragging
                isLocked -> Color.rgb(64, 224, 255)
                else -> Color.WHITE
            }
            indicatorPaint.strokeWidth = if (isDragging || isScalingThis || isLocked) 7f else 3f
            canvas.drawCircle(x, y, indicatorRadius, indicatorPaint)

            // Draw entity preview with per-entity scale
            drawEntityPreview(canvas, entity, x, y, entityScale)

            // Draw entity name label below
            labelPaint.textSize = 32f * entityScale.coerceAtLeast(0.7f)
            labelPaint.color = Color.WHITE
            val labelY = y + indicatorRadius + 40f
            val displayName = entity.name ?: "#${entity.entityId}"
            canvas.drawText(displayName, x, labelY, labelPaint)
            
            // Show scale indicator when scaling
            if (isScalingThis) {
                labelPaint.textSize = 24f
                labelPaint.color = Color.CYAN
                canvas.drawText("${String.format("%.1f", entityScale)}x", x, labelY + 30f, labelPaint)
            }
        }
    }

    /**
     * Draw light grid lines for positioning reference
     */
    private fun drawGridLines(canvas: Canvas) {
        val gridPaint = Paint().apply {
            color = Color.argb(40, 255, 255, 255)
            strokeWidth = 1f
        }

        // Vertical lines at 25%, 50%, 75%
        for (pct in listOf(0.25f, 0.5f, 0.75f)) {
            val x = width * pct
            canvas.drawLine(x, 0f, x, height.toFloat(), gridPaint)
        }

        // Horizontal lines at 25%, 50%, 75%
        for (pct in listOf(0.25f, 0.5f, 0.75f)) {
            val y = height * pct
            canvas.drawLine(0f, y, width.toFloat(), y, gridPaint)
        }
    }

    /**
     * Draw entity preview (simplified render)
     */
    private fun drawEntityPreview(canvas: Canvas, entity: EntityStatus, cx: Float, cy: Float, scale: Float) {
        canvas.save()

        // Draw character body (simplified - just show lobster shape)
        val svgScale = 3f * scale
        canvas.translate(cx - (60 * svgScale), cy - (60 * svgScale))
        canvas.scale(svgScale, svgScale)

        // Body color based on entity ID
        val bodyColor = when (entity.entityId) {
            0 -> Color.parseColor("#FF7F50") // Coral
            1 -> Color.parseColor("#4CAF50") // Green
            2 -> Color.parseColor("#2196F3") // Blue
            3 -> Color.parseColor("#FF9800") // Orange
            else -> Color.parseColor("#FF7F50")
        }

        val bodyPaint = Paint().apply {
            style = Paint.Style.FILL
            color = bodyColor
            isAntiAlias = true
        }

        // Simple lobster body path
        val bodyPath = android.graphics.Path().apply {
            moveTo(60f, 10f)
            cubicTo(30f, 10f, 15f, 35f, 15f, 55f)
            cubicTo(15f, 75f, 30f, 95f, 45f, 100f)
            lineTo(45f, 110f)
            lineTo(55f, 110f)
            lineTo(55f, 100f)
            cubicTo(55f, 100f, 60f, 102f, 65f, 100f)
            lineTo(65f, 110f)
            lineTo(75f, 110f)
            lineTo(75f, 100f)
            cubicTo(90f, 95f, 105f, 75f, 105f, 55f)
            cubicTo(105f, 35f, 90f, 10f, 60f, 10f)
            close()
        }
        canvas.drawPath(bodyPath, bodyPaint)

        // Eyes
        val eyePaint = Paint().apply { color = Color.BLACK; style = Paint.Style.FILL; isAntiAlias = true }
        val eyeGlowPaint = Paint().apply { color = Color.CYAN; style = Paint.Style.FILL; isAntiAlias = true }
        canvas.drawCircle(45f, 35f, 6f, eyePaint)
        canvas.drawCircle(46f, 34f, 2f, eyeGlowPaint)
        canvas.drawCircle(75f, 35f, 6f, eyePaint)
        canvas.drawCircle(76f, 34f, 2f, eyeGlowPaint)

        canvas.restore()
    }

    private val lockedHaloPaint = Paint().apply {
        style = Paint.Style.FILL
        isAntiAlias = true
    }

    private val lockedHaloStrokePaint = Paint().apply {
        style = Paint.Style.STROKE
        isAntiAlias = true
    }

    private fun drawLockedEntityHalo(canvas: Canvas, x: Float, y: Float, radius: Float, color: Int) {
        lockedHaloPaint.color = Color.argb(46, Color.red(color), Color.green(color), Color.blue(color))
        canvas.drawCircle(x, y, radius + 16f, lockedHaloPaint)

        lockedHaloStrokePaint.color = Color.argb(230, Color.red(color), Color.green(color), Color.blue(color))
        lockedHaloStrokePaint.strokeWidth = 3f * resources.displayMetrics.density
        canvas.drawCircle(x, y, radius + 8f, lockedHaloStrokePaint)
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        if (event.pointerCount > 1 || isScaling) {
            return handlePinchTouch(event)
        }

        val x = event.x
        val y = event.y

        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                // Find which entity was touched
                draggingEntityIndex = findEntityAtPosition(x, y)
                lastTouchX = x
                lastTouchY = y
                if (draggingEntityIndex >= 0) {
                    lockEntity(draggingEntityIndex)
                    val entity = entities[draggingEntityIndex]
                    val pos = entityPositions[entity.entityId] ?: Pair(0.5f, 0.5f)
                    dragOffsetX = pos.first * width - x
                    dragOffsetY = pos.second * height - y
                    invalidate()
                    return true
                }

                if (lockedEntityId != null) {
                    return true
                }
            }

            MotionEvent.ACTION_MOVE -> {
                if (event.pointerCount == 1 && draggingEntityIndex >= 0 && draggingEntityIndex < entities.size) {
                    // Update position (convert to percentage)
                    val xPercent = ((x + dragOffsetX) / width).coerceIn(0.05f, 0.95f)
                    val yPercent = ((y + dragOffsetY) / height).coerceIn(0.05f, 0.95f)
                    val entityId = entities[draggingEntityIndex].entityId
                    entityPositions[entityId] = Pair(xPercent, yPercent)
                    enableCustomLayoutForGesture()
                    layoutPrefs.setCustomPosition(entityId, xPercent, yPercent)
                    invalidate()
                    return true
                }
            }

            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                if (draggingEntityIndex >= 0 && draggingEntityIndex < entities.size) {
                    // Save position to SharedPreferences
                    val entityId = entities[draggingEntityIndex].entityId
                    entityPositions[entityId]?.let { (px, py) ->
                        layoutPrefs.setCustomPosition(entityId, px, py)
                    }
                    draggingEntityIndex = -1
                    invalidate()
                    return true
                }
                draggingEntityIndex = -1
            }
        }

        return super.onTouchEvent(event)
    }

    private fun handlePinchTouch(event: MotionEvent): Boolean {
        when (event.actionMasked) {
            MotionEvent.ACTION_POINTER_DOWN -> {
                if (!beginLockedScale(event)) return false
                lastPinchSpan = pointerSpan(event)
                return true
            }

            MotionEvent.ACTION_MOVE -> {
                if (!isScaling && !beginLockedScale(event)) return false
                val span = pointerSpan(event)
                if (lastPinchSpan > 0f && span > 0f) {
                    applyLockedScale(span / lastPinchSpan)
                }
                lastPinchSpan = span
                return true
            }

            MotionEvent.ACTION_POINTER_UP, MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                finishLockedScale()
                return true
            }
        }
        return isScaling
    }

    private fun beginLockedScale(event: MotionEvent): Boolean {
        draggingEntityIndex = -1

        scalingEntityIndex = lockedEntityIndex()
        if (scalingEntityIndex >= 0 && scalingEntityIndex < entities.size) {
            isScaling = true
            invalidate()
            return true
        }

        val hitEntityIndex = findEntityAtPosition(pointerFocusX(event), pointerFocusY(event))
        if (lockEntity(hitEntityIndex)) {
            scalingEntityIndex = hitEntityIndex
            isScaling = true
            invalidate()
            return true
        }

        return false
    }

    private fun applyLockedScale(scaleFactor: Float) {
        if (!scaleFactor.isFinite() || scaleFactor <= 0f) return
        if (scalingEntityIndex >= 0 && scalingEntityIndex < entities.size) {
            val entityId = entities[scalingEntityIndex].entityId
            val currentScale = entityScales[entityId] ?: 1.0f
            val newScale = (currentScale * scaleFactor).coerceIn(0.3f, 2.5f)
            entityScales[entityId] = newScale
            layoutPrefs.setEntityScale(entityId, newScale)
            enableCustomLayoutForGesture()
            invalidate()
        }
    }

    private fun finishLockedScale() {
        if (scalingEntityIndex >= 0 && scalingEntityIndex < entities.size) {
            val entityId = entities[scalingEntityIndex].entityId
            entityScales[entityId]?.let { scale ->
                layoutPrefs.setEntityScale(entityId, scale)
            }
        }
        scalingEntityIndex = -1
        isScaling = false
        lastPinchSpan = 0f
        invalidate()
    }

    private fun pointerSpan(event: MotionEvent): Float {
        if (event.pointerCount < 2) return 0f
        val dx = event.getX(1) - event.getX(0)
        val dy = event.getY(1) - event.getY(0)
        return kotlin.math.sqrt(dx * dx + dy * dy)
    }

    private fun pointerFocusX(event: MotionEvent): Float {
        if (event.pointerCount < 2) return event.x
        return (event.getX(0) + event.getX(1)) / 2f
    }

    private fun pointerFocusY(event: MotionEvent): Float {
        if (event.pointerCount < 2) return event.y
        return (event.getY(0) + event.getY(1)) / 2f
    }

    /**
     * Find entity at touch position using hit test
     */
    private fun findEntityAtPosition(touchX: Float, touchY: Float): Int {
        for (index in entities.indices.reversed()) {
            val entity = entities[index]
            val pos = entityPositions[entity.entityId] ?: continue
            val entityX = pos.first * width
            val entityY = pos.second * height
            
            // Scale hit radius with entity scale
            val entityScale = entityScales[entity.entityId] ?: 1.0f
            val hitRadius = width * hitRadiusFactor * entityScale

            val dx = touchX - entityX
            val dy = touchY - entityY
            val distance = kotlin.math.sqrt(dx * dx + dy * dy)

            if (distance <= hitRadius) {
                return index
            }
        }

        return -1
    }

    private fun lockEntity(index: Int): Boolean {
        if (index < 0 || index >= entities.size) return false
        lockedEntityId = entities[index].entityId
        return true
    }

    private fun lockedEntityIndex(): Int {
        val entityId = lockedEntityId ?: return -1
        return entities.indexOfFirst { it.entityId == entityId }
    }

    private fun enableCustomLayoutForGesture() {
        if (!layoutPrefs.useCustomLayout) {
            entities.forEach { entity ->
                entityPositions[entity.entityId]?.let { (px, py) ->
                    layoutPrefs.setCustomPosition(entity.entityId, px, py)
                }
            }
        }
        layoutPrefs.useCustomLayout = true
    }
}
