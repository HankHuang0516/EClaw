package com.hank.clawlive.ui

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.util.AttributeSet
import android.view.MotionEvent
import android.view.ScaleGestureDetector
import android.view.View
import com.hank.clawlive.R
import com.hank.clawlive.data.local.LayoutPreferences
import com.hank.clawlive.data.model.EntityStatus
import kotlin.math.ceil
import kotlin.math.sqrt

/**
 * Custom View for drag-and-drop entity positioning with pinch-to-resize.
 * Users can drag entities to custom positions and pinch to resize them.
 * 
 * Gestures:
 * - 1 finger drag: Move entity position
 * - 2 finger pinch: Resize entity
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
    
    // Scale gesture state
    private var scalingEntityIndex: Int = -1
    private var isScaling = false

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
    
    // Scale gesture detector
    private val scaleGestureDetector = ScaleGestureDetector(context,
        object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
            override fun onScaleBegin(detector: ScaleGestureDetector): Boolean {
                // Find entity at scale focus point
                scalingEntityIndex = findEntityAtPosition(detector.focusX, detector.focusY)
                if (scalingEntityIndex >= 0 && scalingEntityIndex < entities.size) {
                    isScaling = true
                    // Cancel any ongoing drag
                    draggingEntityIndex = -1
                    return true
                }
                return false
            }
            
            override fun onScale(detector: ScaleGestureDetector): Boolean {
                if (scalingEntityIndex >= 0 && scalingEntityIndex < entities.size) {
                    val entityId = entities[scalingEntityIndex].entityId
                    // Use cumulative multiplication (Android recommended pattern)
                    val currentScale = entityScales[entityId] ?: 1.0f
                    val newScale = (currentScale * detector.scaleFactor).coerceIn(0.3f, 2.5f)
                    entityScales[entityId] = newScale
                    layoutPrefs.setEntityScale(entityId, newScale)
                    enableCustomLayoutForGesture()
                    invalidate()
                    return true
                }
                return false
            }
            
            override fun onScaleEnd(detector: ScaleGestureDetector) {
                if (scalingEntityIndex >= 0 && scalingEntityIndex < entities.size) {
                    val entityId = entities[scalingEntityIndex].entityId
                    entityScales[entityId]?.let { scale ->
                        layoutPrefs.setEntityScale(entityId, scale)
                    }
                }
                scalingEntityIndex = -1
                isScaling = false
            }
        }
    )

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
            indicatorPaint.color = when {
                isScalingThis -> Color.CYAN  // Scaling
                isDragging -> Color.YELLOW   // Dragging
                else -> Color.WHITE
            }
            indicatorPaint.strokeWidth = if (isDragging || isScalingThis) 6f else 3f
            val indicatorRadius = width * hitRadiusFactor * entityScale
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

    override fun onTouchEvent(event: MotionEvent): Boolean {
        // Let scale detector handle multi-touch first
        scaleGestureDetector.onTouchEvent(event)
        
        // If we're in the middle of a scale gesture, don't process single-touch
        if (scaleGestureDetector.isInProgress || isScaling) {
            return true
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
                    val entity = entities[draggingEntityIndex]
                    val pos = entityPositions[entity.entityId] ?: Pair(0.5f, 0.5f)
                    dragOffsetX = pos.first * width - x
                    dragOffsetY = pos.second * height - y
                    invalidate()
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
