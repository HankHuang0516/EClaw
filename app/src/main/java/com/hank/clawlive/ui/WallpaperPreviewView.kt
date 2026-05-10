package com.hank.clawlive.ui

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.net.Uri
import android.util.AttributeSet
import android.view.MotionEvent
import android.view.ScaleGestureDetector
import android.view.View
import com.hank.clawlive.data.local.LayoutPreferences
import com.hank.clawlive.R
import com.hank.clawlive.data.model.CompanionDetail
import com.hank.clawlive.data.model.EntityStatus
import com.hank.clawlive.engine.ProceduralCreatureDrawer
import kotlin.math.ceil
import kotlin.math.sqrt
import timber.log.Timber

/**
 * Custom View for wallpaper preview with drag-and-drop entity positioning
 * and pinch-to-resize support.
 * 
 * Gestures:
 * - 1 finger drag: Move entity position
 * - 2 finger pinch: Resize entity
 */
class WallpaperPreviewView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
    defStyleAttr: Int = 0
) : View(context, attrs, defStyleAttr) {

    private val layoutPrefs = LayoutPreferences.getInstance(context)

    // Entities to display (only bound entities)
    private var entities: List<EntityStatus> = emptyList()

    // Per-entity selected companion descriptor — drives renderer dispatch
    // (cat/dog/fish via ProceduralCreatureDrawer; null falls back to legacy lobster).
    private var companionsByEntity: Map<Int, CompanionDetail?> = emptyMap()

    // Custom positions (percentage 0.0-1.0)
    private val entityPositions = mutableMapOf<Int, Pair<Float, Float>>()
    
    // Per-entity scales
    private val entityScales = mutableMapOf<Int, Float>()

    // Drag state
    private var draggingEntityIndex: Int = -1
    private var lastTouchX = 0f
    private var lastTouchY = 0f
    
    // Scale gesture state
    private var scalingEntityIndex: Int = -1
    private var isScaling = false

    // Hit test radius (scaled with view size)
    private val hitRadiusFactor = 0.12f

    // Background image cache
    private var cachedBackgroundBitmap: Bitmap? = null
    private var cachedBackgroundUri: String? = null
    private var lastViewWidth: Int = 0
    private var lastViewHeight: Int = 0

    // Paints
    private val backgroundPaint = Paint().apply {
        isFilterBitmap = true
        isAntiAlias = true
    }

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
        setWillNotDraw(false)
    }

    /**
     * Set entities to display. Only bound entities should be passed.
     */
    fun setEntities(boundEntities: List<EntityStatus>) {
        entities = boundEntities

        // Initialize positions and scales from prefs or default
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
     * Set per-entity selected companion. Triggers re-render so creatures
     * (cat / dog / fish / lobster variants) appear immediately.
     */
    fun setCompanions(map: Map<Int, CompanionDetail?>) {
        companionsByEntity = map
        invalidate()
    }

    /**
     * Refresh background image from preferences
     */
    fun refreshBackground() {
        // Force reload on next draw
        cachedBackgroundUri = null
        cachedBackgroundBitmap?.recycle()
        cachedBackgroundBitmap = null
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

        // Draw background (custom image or black)
        drawBackground(canvas)

        if (entities.isEmpty()) {
            labelPaint.textSize = 36f
            labelPaint.color = Color.GRAY
            canvas.drawText(context.getString(R.string.wallpaper_no_bound_entities), width / 2f, height / 2f, labelPaint)
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

            // Draw position indicator
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

            // Draw entity name label
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
     * Draw background image or solid color
     */
    private fun drawBackground(canvas: Canvas) {
        if (layoutPrefs.useBackgroundImage) {
            val bitmap = getBackgroundBitmap()
            if (bitmap != null) {
                canvas.drawBitmap(bitmap, 0f, 0f, backgroundPaint)
                return
            }
        }
        canvas.drawColor(Color.BLACK)
    }

    /**
     * Get cached background bitmap, loading if needed
     */
    private fun getBackgroundBitmap(): Bitmap? {
        val uriString = layoutPrefs.backgroundImageUri ?: return null

        // Check cache
        if (cachedBackgroundBitmap != null &&
            cachedBackgroundUri == uriString &&
            lastViewWidth == width &&
            lastViewHeight == height
        ) {
            return cachedBackgroundBitmap
        }

        try {
            val uri = Uri.parse(uriString)
            val inputStream = context.contentResolver.openInputStream(uri) ?: return null

            // Decode bounds
            val options = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeStream(inputStream, null, options)
            inputStream.close()

            val imageWidth = options.outWidth
            val imageHeight = options.outHeight
            if (imageWidth <= 0 || imageHeight <= 0) return null

            // Calculate sample size
            val sampleSize = calculateSampleSize(imageWidth, imageHeight, width, height)

            // Decode with sample size
            val decodeOptions = BitmapFactory.Options().apply {
                inSampleSize = sampleSize
                inPreferredConfig = Bitmap.Config.RGB_565
            }

            val inputStream2 = context.contentResolver.openInputStream(uri) ?: return null
            val sourceBitmap = BitmapFactory.decodeStream(inputStream2, null, decodeOptions)
            inputStream2.close()

            if (sourceBitmap == null) return null

            // Center-crop scale
            val scaledBitmap = centerCropScale(sourceBitmap, width, height)
            if (scaledBitmap != sourceBitmap) {
                sourceBitmap.recycle()
            }

            // Update cache
            cachedBackgroundBitmap?.recycle()
            cachedBackgroundBitmap = scaledBitmap
            cachedBackgroundUri = uriString
            lastViewWidth = width
            lastViewHeight = height

            return scaledBitmap

        } catch (e: Exception) {
            Timber.e(e, "Failed to load background image")
            return null
        }
    }

    private fun calculateSampleSize(
        imageWidth: Int,
        imageHeight: Int,
        targetWidth: Int,
        targetHeight: Int
    ): Int {
        var sampleSize = 1
        if (imageWidth > targetWidth || imageHeight > targetHeight) {
            val halfWidth = imageWidth / 2
            val halfHeight = imageHeight / 2
            while ((halfWidth / sampleSize) >= targetWidth &&
                   (halfHeight / sampleSize) >= targetHeight
            ) {
                sampleSize *= 2
            }
        }
        return sampleSize
    }

    private fun centerCropScale(source: Bitmap, targetWidth: Int, targetHeight: Int): Bitmap {
        val sourceWidth = source.width
        val sourceHeight = source.height

        val scaleX = targetWidth.toFloat() / sourceWidth
        val scaleY = targetHeight.toFloat() / sourceHeight
        val scale = maxOf(scaleX, scaleY)

        val scaledWidth = (sourceWidth * scale).toInt()
        val scaledHeight = (sourceHeight * scale).toInt()

        val scaledBitmap = Bitmap.createScaledBitmap(source, scaledWidth, scaledHeight, true)

        val x = (scaledWidth - targetWidth) / 2
        val y = (scaledHeight - targetHeight) / 2

        return if (x != 0 || y != 0 || scaledWidth != targetWidth || scaledHeight != targetHeight) {
            val cropped = Bitmap.createBitmap(
                scaledBitmap,
                x.coerceAtLeast(0),
                y.coerceAtLeast(0),
                targetWidth.coerceAtMost(scaledWidth - x),
                targetHeight.coerceAtMost(scaledHeight - y)
            )
            if (cropped != scaledBitmap) {
                scaledBitmap.recycle()
            }
            cropped
        } else {
            scaledBitmap
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

        for (pct in listOf(0.25f, 0.5f, 0.75f)) {
            val x = width * pct
            canvas.drawLine(x, 0f, x, height.toFloat(), gridPaint)
        }

        for (pct in listOf(0.25f, 0.5f, 0.75f)) {
            val y = height * pct
            canvas.drawLine(0f, y, width.toFloat(), y, gridPaint)
        }
    }

    /**
     * Draw entity preview (simplified lobster shape)
     */
    private fun drawEntityPreview(canvas: Canvas, entity: EntityStatus, cx: Float, cy: Float, scale: Float) {
        canvas.save()

        val svgScale = 3f * scale
        canvas.translate(cx - (60 * svgScale), cy - (60 * svgScale))
        canvas.scale(svgScale, svgScale)

        val companion = companionsByEntity[entity.entityId]
        val bodyColor = parseHexColor(companion?.color) ?: when (entity.entityId) {
            0 -> Color.parseColor("#FF7F50")
            1 -> Color.parseColor("#4CAF50")
            2 -> Color.parseColor("#2196F3")
            3 -> Color.parseColor("#FF9800")
            else -> Color.parseColor("#FF7F50")
        }
        val darkColor = darken(bodyColor)

        // Spec §4.3 — cat/dog/fish dispatch. If renderer matches, the procedural
        // drawer paints inside the same 120×120 viewport; otherwise fall through
        // to the legacy lobster preview path so existing companions still render.
        val rendererKey = companion?.proceduralRenderer()
        val drewCreature = ProceduralCreatureDrawer.draw(
            canvas, rendererKey, entity, companion, bodyColor, darkColor,
            System.currentTimeMillis()
        )

        if (!drewCreature) {
            val bodyPaint = Paint().apply {
                style = Paint.Style.FILL
                color = bodyColor
                isAntiAlias = true
            }
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
            val eyePaint = Paint().apply { color = Color.BLACK; style = Paint.Style.FILL; isAntiAlias = true }
            val eyeGlowPaint = Paint().apply { color = Color.CYAN; style = Paint.Style.FILL; isAntiAlias = true }
            canvas.drawCircle(45f, 35f, 6f, eyePaint)
            canvas.drawCircle(46f, 34f, 2f, eyeGlowPaint)
            canvas.drawCircle(75f, 35f, 6f, eyePaint)
            canvas.drawCircle(76f, 34f, 2f, eyeGlowPaint)
        }

        canvas.restore()
    }

    private fun parseHexColor(hex: String?): Int? {
        if (hex.isNullOrBlank()) return null
        return try { Color.parseColor(hex) } catch (_: IllegalArgumentException) { null }
    }

    private fun darken(c: Int, factor: Float = 0.7f): Int {
        val r = (Color.red(c) * factor).toInt().coerceIn(0, 255)
        val g = (Color.green(c) * factor).toInt().coerceIn(0, 255)
        val b = (Color.blue(c) * factor).toInt().coerceIn(0, 255)
        return Color.rgb(r, g, b)
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
                draggingEntityIndex = findEntityAtPosition(x, y)
                lastTouchX = x
                lastTouchY = y
                if (draggingEntityIndex >= 0) {
                    invalidate()
                    return true
                }
            }

            MotionEvent.ACTION_MOVE -> {
                if (event.pointerCount == 1 && draggingEntityIndex >= 0 && draggingEntityIndex < entities.size) {
                    val xPercent = (x / width).coerceIn(0.1f, 0.9f)
                    val yPercent = (y / height).coerceIn(0.1f, 0.9f)
                    val entityId = entities[draggingEntityIndex].entityId
                    entityPositions[entityId] = Pair(xPercent, yPercent)
                    invalidate()
                    return true
                }
            }

            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                if (draggingEntityIndex >= 0 && draggingEntityIndex < entities.size) {
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

    private fun findEntityAtPosition(touchX: Float, touchY: Float): Int {
        entities.forEachIndexed { index, entity ->
            val pos = entityPositions[entity.entityId] ?: return@forEachIndexed
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

    override fun onDetachedFromWindow() {
        super.onDetachedFromWindow()
        cachedBackgroundBitmap?.recycle()
        cachedBackgroundBitmap = null
    }
}
