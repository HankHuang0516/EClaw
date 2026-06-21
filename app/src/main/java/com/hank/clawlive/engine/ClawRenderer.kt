package com.hank.clawlive.engine

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.net.Uri
import android.text.TextPaint
import com.hank.clawlive.R
import com.hank.clawlive.data.local.EntityLayout
import com.hank.clawlive.data.local.LayoutPreferences
import com.hank.clawlive.data.model.AgentStatus
import com.hank.clawlive.data.model.CharacterState
import com.hank.clawlive.data.model.CompanionDetail
import com.hank.clawlive.data.model.EntityStatus
import com.hank.clawlive.data.model.UsageSnapshotLatest
import com.hank.clawlive.data.repository.CompanionRepository
import timber.log.Timber
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.sin
import kotlin.math.sqrt

class ClawRenderer(
    private val context: Context,
    private val companionRepository: CompanionRepository? = null
) {

    private val layoutPrefs = LayoutPreferences.getInstance(context)
    private val spritesheetDrawer = companionRepository?.let { SpritesheetCompanionDrawer(it) }
    private val usageOverlayRenderer = UsageOverlayRenderer(context, layoutPrefs)
    private val wanderController = WallpaperWanderController()
    private val interactionController = WallpaperInteractionController()
    private val speechBubbleController = SpeechBubbleController()
    private val renderDiagnostics = WallpaperRenderDiagnostics()
    private val lastBubbleMessageByEntity = mutableMapOf<Int, String>()
    private val lastBubbleDurationByEntity = mutableMapOf<Int, Long>()
    private val bubblePulseStartedByEntity = mutableMapOf<Int, Long>()

    // Background image cache
    private var cachedBackgroundBitmap: Bitmap? = null
    private var cachedBackgroundUri: String? = null
    private var lastCanvasWidth: Int = 0
    private var lastCanvasHeight: Int = 0

    private val backgroundPaint = Paint().apply {
        isFilterBitmap = true
        isAntiAlias = true
    }

    private val textPaint = TextPaint().apply {
        color = Color.WHITE
        textSize = 50f
        textAlign = Paint.Align.CENTER
        isAntiAlias = true
    }

    private val characterPaint = Paint().apply {
        style = Paint.Style.FILL
        isAntiAlias = true
    }

    // Bubble paint for message background
    private val bubblePaint = Paint().apply {
        style = Paint.Style.FILL
        isAntiAlias = true
    }

    // Bubble paint for message border
    private val bubbleStrokePaint = Paint().apply {
        style = Paint.Style.STROKE
        color = Color.WHITE
        isAntiAlias = true
        strokeCap = Paint.Cap.ROUND
        strokeJoin = Paint.Join.ROUND
    }

    // Badge paint for entity ID
    private val badgePaint = Paint().apply {
        style = Paint.Style.FILL
        isAntiAlias = true
    }

    private val badgeTextPaint = TextPaint().apply {
        color = Color.WHITE
        textAlign = Paint.Align.CENTER
        isAntiAlias = true
        isFakeBoldText = true
    }

    // State icon paint
    private val stateTextPaint = TextPaint().apply {
        textAlign = Paint.Align.CENTER
        isAntiAlias = true
    }

    // Health-checking pulsing ring paint (parity with Web .health-checking ring)
    private val healthRingPaint = Paint().apply {
        style = Paint.Style.STROKE
        color = Color.parseColor("#22D3EE") // cyan, matches Web health ring accent
        isAntiAlias = true
        strokeCap = Paint.Cap.ROUND
    }

    // Health-checking 「健檢中」label paint
    private val healthLabelPaint = TextPaint().apply {
        color = Color.parseColor("#22D3EE")
        textAlign = Paint.Align.CENTER
        isAntiAlias = true
        isFakeBoldText = true
    }

    private val shadowPaint = Paint().apply {
        style = Paint.Style.FILL
        color = Color.BLACK
        isAntiAlias = true
    }

    private val stateAuraPaint = Paint().apply {
        style = Paint.Style.FILL
        isAntiAlias = true
    }

    private val bubblePulsePaint = Paint().apply {
        style = Paint.Style.STROKE
        isAntiAlias = true
        strokeCap = Paint.Cap.ROUND
    }

    private val interactionTextPaint = TextPaint().apply {
        color = Color.WHITE
        textAlign = Paint.Align.CENTER
        isAntiAlias = true
        isFakeBoldText = true
    }

    // Animation state
    private var startTime = System.currentTimeMillis()

    // Ambient state
    private var isAmbient = false

    fun setAmbient(ambient: Boolean) {
        this.isAmbient = ambient
    }

    /**
     * Get background bitmap, loading and caching as needed.
     * Uses center-crop scaling to fill the canvas.
     */
    private fun getBackgroundBitmap(width: Int, height: Int): Bitmap? {
        if (!layoutPrefs.useBackgroundImage) {
            return null
        }

        val uriString = layoutPrefs.backgroundImageUri ?: return null

        // Check if we can reuse cached bitmap
        if (cachedBackgroundBitmap != null &&
            cachedBackgroundUri == uriString &&
            lastCanvasWidth == width &&
            lastCanvasHeight == height
        ) {
            return cachedBackgroundBitmap
        }

        // Need to load/reload bitmap
        try {
            val uri = Uri.parse(uriString)
            val inputStream = context.contentResolver.openInputStream(uri) ?: return null

            // First, decode bounds only
            val options = BitmapFactory.Options().apply {
                inJustDecodeBounds = true
            }
            BitmapFactory.decodeStream(inputStream, null, options)
            inputStream.close()

            val imageWidth = options.outWidth
            val imageHeight = options.outHeight

            if (imageWidth <= 0 || imageHeight <= 0) {
                Timber.w("Invalid image dimensions: ${imageWidth}x${imageHeight}")
                return null
            }

            // Calculate sample size for memory efficiency
            val sampleSize = calculateSampleSize(imageWidth, imageHeight, width, height)

            // Decode with sample size
            val decodeOptions = BitmapFactory.Options().apply {
                inSampleSize = sampleSize
                inPreferredConfig = Bitmap.Config.RGB_565 // Memory efficient
            }

            val inputStream2 = context.contentResolver.openInputStream(uri) ?: return null
            val sourceBitmap = BitmapFactory.decodeStream(inputStream2, null, decodeOptions)
            inputStream2.close()

            if (sourceBitmap == null) {
                Timber.w("Failed to decode bitmap from URI: $uriString")
                return null
            }

            // Center-crop scale to target dimensions
            val scaledBitmap = centerCropScale(sourceBitmap, width, height)

            // Recycle source if different from result
            if (scaledBitmap != sourceBitmap) {
                sourceBitmap.recycle()
            }

            // Update cache
            cachedBackgroundBitmap?.recycle()
            cachedBackgroundBitmap = scaledBitmap
            cachedBackgroundUri = uriString
            lastCanvasWidth = width
            lastCanvasHeight = height

            Timber.d("Background loaded: ${width}x${height}")
            return scaledBitmap

        } catch (e: Exception) {
            Timber.e(e, "Failed to load background image")
            return null
        }
    }

    /**
     * Calculate sample size for efficient memory usage.
     */
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

    /**
     * Center-crop scale bitmap to fill target dimensions.
     */
    private fun centerCropScale(source: Bitmap, targetWidth: Int, targetHeight: Int): Bitmap {
        val sourceWidth = source.width
        val sourceHeight = source.height

        val scaleX = targetWidth.toFloat() / sourceWidth
        val scaleY = targetHeight.toFloat() / sourceHeight
        val scale = maxOf(scaleX, scaleY) // Center-crop uses max scale

        val scaledWidth = (sourceWidth * scale).toInt()
        val scaledHeight = (sourceHeight * scale).toInt()

        // Create scaled bitmap
        val scaledBitmap = Bitmap.createScaledBitmap(source, scaledWidth, scaledHeight, true)

        // Crop to target size (center)
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
     * Release cached resources. Call when service is destroyed.
     */
    fun release() {
        cachedBackgroundBitmap?.recycle()
        cachedBackgroundBitmap = null
        cachedBackgroundUri = null
        lastCanvasWidth = 0
        lastCanvasHeight = 0
        Timber.d("ClawRenderer resources released")
    }

    // ============================================
    // MULTI-ENTITY RENDERING
    // ============================================

    /**
     * Calculate positions for entities based on count and layout preference.
     * If useCustomLayout is enabled, reads per-entity custom positions from SharedPreferences.
     */
    private fun calculateEntityPositions(
        width: Float,
        height: Float,
        count: Int,
        entities: List<EntityStatus>? = null
    ): List<Pair<Float, Float>> {
        // Check if custom layout mode is enabled and we have entity info
        if (layoutPrefs.useCustomLayout && entities != null) {
            return entities.map { entity ->
                val customPos = layoutPrefs.getCustomPosition(entity.entityId)
                if (customPos != null) {
                    // Convert percentage to actual coordinates
                    Pair(customPos.first * width, customPos.second * height)
                } else {
                    // Fallback to center if no custom position set
                    Pair(width / 2f, height / 2f)
                }
            }
        }

        // Original preset layout logic
        val layout = layoutPrefs.entityLayout
        val verticalPos = layoutPrefs.verticalPosition

        return when (layout) {
            EntityLayout.GRID_2X2 -> calculateGrid2x2(width, height, count, verticalPos)
            EntityLayout.HORIZONTAL -> calculateHorizontal(width, height, count, verticalPos)
            EntityLayout.VERTICAL -> calculateVertical(width, height, count)
            EntityLayout.DIAMOND -> calculateDiamond(width, height, count, verticalPos)
            EntityLayout.CORNERS -> calculateCorners(width, height, count)
        }
    }

    private fun calculateGrid2x2(width: Float, height: Float, count: Int, verticalPos: Float): List<Pair<Float, Float>> {
        if (count <= 0) return emptyList()
        val cols = ceil(sqrt(count.toDouble())).toInt().coerceAtLeast(1)
        val rows = ceil(count.toDouble() / cols).toInt()
        val centerY = height * verticalPos
        val paddingX = width * 0.1f
        val usableW = width - 2 * paddingX
        val colStep = usableW / cols
        // Vertical span: ±0.15h per row gap, capped at ±0.30h total (60% of screen)
        val totalYSpan = (height * 0.3f * (rows - 1)).coerceAtMost(height * 0.6f)
        val rowStep = if (rows > 1) totalYSpan / (rows - 1) else 0f
        val startY = centerY - totalYSpan / 2f
        val itemsInLastRow = count - (rows - 1) * cols
        return (0 until count).map { i ->
            val row = i / cols
            val col = i % cols
            val x = if (row == rows - 1 && itemsInLastRow < cols) {
                paddingX + (usableW - itemsInLastRow * colStep) / 2f + col * colStep + colStep / 2f
            } else {
                paddingX + col * colStep + colStep / 2f
            }
            val y = if (rows <= 1) centerY else startY + row * rowStep
            Pair(x, y)
        }
    }

    private fun calculateHorizontal(width: Float, height: Float, count: Int, verticalPos: Float): List<Pair<Float, Float>> {
        val centerY = height * verticalPos
        val spacing = width / (count + 1)
        return (1..count).map { i ->
            Pair(spacing * i, centerY)
        }
    }

    private fun calculateVertical(width: Float, height: Float, count: Int): List<Pair<Float, Float>> {
        val centerX = width / 2f
        val spacing = height / (count + 1)
        return (1..count).map { i ->
            Pair(centerX, spacing * i)
        }
    }

    private fun calculateDiamond(width: Float, height: Float, count: Int, verticalPos: Float): List<Pair<Float, Float>> {
        val centerX = width / 2f
        val centerY = height * verticalPos
        val offsetX = width * 0.25f
        val offsetY = height * 0.15f

        return when (count) {
            1 -> listOf(Pair(centerX, centerY))
            2 -> listOf(
                Pair(centerX - offsetX, centerY),
                Pair(centerX + offsetX, centerY)
            )
            3 -> listOf(
                Pair(centerX, centerY - offsetY),
                Pair(centerX - offsetX, centerY + offsetY),
                Pair(centerX + offsetX, centerY + offsetY)
            )
            else -> listOf(
                Pair(centerX, centerY - offsetY),        // Top
                Pair(centerX - offsetX, centerY),       // Left
                Pair(centerX + offsetX, centerY),       // Right
                Pair(centerX, centerY + offsetY)        // Bottom
            )
        }
    }

    private fun calculateCorners(width: Float, height: Float, count: Int): List<Pair<Float, Float>> {
        val marginX = width * 0.2f
        val marginY = height * 0.25f

        return when (count) {
            1 -> listOf(Pair(width / 2f, height / 2f))
            2 -> listOf(
                Pair(marginX, marginY),
                Pair(width - marginX, height - marginY)
            )
            3 -> listOf(
                Pair(marginX, marginY),
                Pair(width - marginX, marginY),
                Pair(width / 2f, height - marginY)
            )
            else -> listOf(
                Pair(marginX, marginY),
                Pair(width - marginX, marginY),
                Pair(marginX, height - marginY),
                Pair(width - marginX, height - marginY)
            )
        }
    }

    /**
     * Get scale factor based on entity count.
     * Smaller scale for more entities.
     * Base scale is 1.5x larger than original.
     */
    private fun getScaleFactor(count: Int): Float = when (count) {
        1 -> 1.5f      // 1.0 * 1.5
        2 -> 0.975f    // 0.65 * 1.5
        3 -> 0.825f    // 0.55 * 1.5
        else -> 0.75f  // 0.5 * 1.5
    }

    /**
     * Draw multiple entities on the canvas.
     *
     * @param loading when true, the engine has not yet received its first
     *   getMultiEntityStatusFlow response — render a transient "Loading…"
     *   placeholder instead of the permanent "No entities connected" message.
     *   Prevents the Live Wallpaper chooser preview from flashing the empty
     *   message while the first network call is still in flight.
     */
    private var multiDrawCount = 0
    fun drawMultiEntity(
        canvas: Canvas,
        entities: List<EntityStatus>,
        loading: Boolean = false,
        usageSnapshot: UsageSnapshotLatest? = null
    ) {
        multiDrawCount++
        val width = canvas.width.toFloat()
        val height = canvas.height.toFloat()

        if (multiDrawCount <= 5) {
        }

        // Background: draw custom image or solid black
        val backgroundBitmap = getBackgroundBitmap(width.toInt(), height.toInt())
        if (backgroundBitmap != null) {
            canvas.drawBitmap(backgroundBitmap, 0f, 0f, backgroundPaint)
            if (multiDrawCount <= 3) {
            }
        } else {
            canvas.drawColor(Color.BLACK)
            if (multiDrawCount <= 3) {
            }
        }

        if (entities.isEmpty()) {
            if (loading) {
                textPaint.textSize = 32f
                textPaint.color = Color.WHITE
                canvas.drawText(context.getString(R.string.claw_renderer_loading_entities), width / 2f, height / 2f, textPaint)
                usageOverlayRenderer.draw(canvas, usageSnapshot)
                return
            }
            // Draw "No entities" message with instructions
            textPaint.textSize = 36f
            textPaint.color = Color.WHITE
            canvas.drawText(context.getString(R.string.claw_renderer_no_entities_connected), width / 2f, height / 2f - 40f, textPaint)
            textPaint.textSize = 24f
            textPaint.color = Color.GRAY
            canvas.drawText(context.getString(R.string.claw_renderer_open_app_to_bind), width / 2f, height / 2f + 20f, textPaint)
            textPaint.textSize = 20f
            canvas.drawText(context.getString(R.string.claw_renderer_with_openclaw_bot), width / 2f, height / 2f + 60f, textPaint)
            usageOverlayRenderer.draw(canvas, usageSnapshot)
            return
        }

        val basePositions = calculateEntityPositions(width, height, entities.size, entities)
        val walkingEnabled = layoutPrefs.wallpaperWalkingEnabled
        val positions = wanderController.positionsFor(
            basePositions = basePositions,
            entities = entities,
            width = width,
            height = height,
            enabled = walkingEnabled,
            purposeful = layoutPrefs.wallpaperPurposefulWalkingEnabled
        )
        val baseScale = getScaleFactor(entities.size)
        val nowMs = System.currentTimeMillis()
        val interactionState = interactionController.apply(
            positions = positions,
            entities = entities,
            width = width,
            height = height,
            enabled = layoutPrefs.wallpaperEntityInteractionsEnabled,
            nowMs = nowMs
        )
        if (layoutPrefs.wallpaperSpeechBubblesEnabled) {
            syncSpeechBubbles(entities, nowMs)
        } else {
            clearSpeechBubbles()
        }
        if (layoutPrefs.wallpaperAdaptiveEffectsEnabled) {
            renderDiagnostics.recordFrame(
                walkingEntityCount = entities.count { wanderController.isWalking(it.entityId) },
                activeBubbleCount = speechBubbleController.activeCount(nowMs)
            )
        }
        val bubbleAvoidBounds = if (layoutPrefs.wallpaperBubbleOverlayAvoidanceEnabled) {
            usageOverlayRenderer.getBounds(
                canvas.width,
                canvas.height,
                usageSnapshot
            )
        } else {
            null
        }

        entities.forEachIndexed { index, entity ->
            if (index < interactionState.positions.size) {
                val (cx, cy) = interactionState.positions[index]
                val interactionPose = interactionState.posesByEntity[entity.entityId]
                val drawCy = cy - (interactionPose?.liftPx ?: 0f)
                // Apply per-entity scale multiplier on top of base scale
                val entityScale = layoutPrefs.getEntityScale(entity.entityId)
                val finalScale = baseScale * entityScale
                val spritesheetState = if (
                    wanderController.isWalking(entity.entityId) &&
                    entity.state.canUseAmbientWalkingAnimation
                ) {
                    WallpaperWanderController.WALKING_STATE_ASSET
                } else {
                    entity.state.wallpaperActionKey
                }
                val facingDirection = interactionPose?.facingDirection
                    ?: wanderController.facingDirection(entity.entityId)
                drawSingleEntityAt(
                    canvas,
                    entity,
                    cx,
                    drawCy,
                    finalScale,
                    width,
                    spritesheetState,
                    nowMs,
                    bubbleAvoidBounds,
                    facingDirection,
                    shouldMirrorSpritesheetForFacing(spritesheetState)
                )
            }
        }

        interactionState.effects.forEach { effect ->
            drawInteractionEffect(canvas, effect, baseScale, nowMs)
        }

        usageOverlayRenderer.draw(canvas, usageSnapshot)
    }

    private fun syncSpeechBubbles(entities: List<EntityStatus>, nowMs: Long) {
        val liveEntityIds = entities.map { it.entityId }.toSet()
        val staleEntityIds = lastBubbleMessageByEntity.keys - liveEntityIds
        staleEntityIds.forEach { speechBubbleController.clear(it) }
        lastBubbleMessageByEntity.keys.retainAll(liveEntityIds)
        lastBubbleDurationByEntity.keys.retainAll(liveEntityIds)
        bubblePulseStartedByEntity.keys.retainAll(liveEntityIds)
        val preferredTtlMs = layoutPrefs.wallpaperBubbleDurationMs

        entities.forEach { entity ->
            val displayText = if (isAmbient) getStateEmoji(entity.state) else entity.message.trim()
            if (displayText.isBlank()) {
                lastBubbleMessageByEntity.remove(entity.entityId)
                lastBubbleDurationByEntity.remove(entity.entityId)
                bubblePulseStartedByEntity.remove(entity.entityId)
                speechBubbleController.clear(entity.entityId)
                return@forEach
            }

            val messageChanged = lastBubbleMessageByEntity[entity.entityId] != displayText
            val durationChanged = lastBubbleDurationByEntity[entity.entityId] != preferredTtlMs
            if (messageChanged || durationChanged) {
                speechBubbleController.show(
                    entity.entityId,
                    displayText,
                    nowMs,
                    preferredTtlMs = preferredTtlMs
                )
                lastBubbleMessageByEntity[entity.entityId] = displayText
                lastBubbleDurationByEntity[entity.entityId] = preferredTtlMs
                if (messageChanged) {
                    bubblePulseStartedByEntity[entity.entityId] = nowMs
                }
            }
        }
    }

    private fun clearSpeechBubbles() {
        lastBubbleMessageByEntity.keys.toList().forEach { speechBubbleController.clear(it) }
        lastBubbleMessageByEntity.clear()
        lastBubbleDurationByEntity.clear()
        bubblePulseStartedByEntity.clear()
    }

    private fun shouldMirrorSpritesheetForFacing(spritesheetState: String): Boolean {
        return spritesheetState != CharacterState.RUNNING_LEFT.wallpaperActionKey &&
            spritesheetState != CharacterState.RUNNING_RIGHT.wallpaperActionKey
    }

    /**
     * Draw a single entity at the specified position with scale.
     */
    private fun drawSingleEntityAt(
        canvas: Canvas,
        entity: EntityStatus,
        centerX: Float,
        centerY: Float,
        scale: Float,
        screenWidth: Float,
        spritesheetState: String = entity.state.wallpaperActionKey,
        nowMs: Long = System.currentTimeMillis(),
        bubbleAvoidBounds: RectF? = null,
        facingDirection: WalkFacingDirection = WalkFacingDirection.RIGHT,
        mirrorSpritesheetForFacing: Boolean = true
    ) {
        // Calculate Animation (Bobbing)
        val time = nowMs - startTime
        val bobOffset = if (entity.state.pausesAmbientWander) {
            0f
        } else {
            val speed = if (entity.state.busyLike) 0.01f else 0.003f
            (sin(time * speed) * 30 * scale).toFloat()
        }

        val charY = centerY + bobOffset
        val radius = 150f * scale
        val quietEffects = layoutPrefs.wallpaperAdaptiveEffectsEnabled &&
            renderDiagnostics.shouldReduceEffects(entity.entityId)

        if (layoutPrefs.wallpaperGroundShadowEnabled) {
            drawGroundShadow(canvas, centerX, charY, radius, scale, time)
        }
        if (layoutPrefs.wallpaperStateAuraEnabled && !quietEffects) {
            drawStateAura(canvas, entity, centerX, charY, radius, scale, time)
        }

        // Health-checking: pulsing/glowing ring around the creature while the
        // passive health-check/repair runs (parity with Web .health-checking
        // avatar ring). Time-based sine pulse reuses the per-frame redraw loop
        // (33ms) already driving the bobbing animation.
        if (entity.healthChecking && !isAmbient) {
            drawHealthCheckingRing(canvas, centerX, charY, radius, scale, time)
        }

        // Petdx companion routing — if the entity has a current companion and
        // it's a spritesheet asset, render that. Procedural assets and missing
        // descriptors go to the legacy lobster drawer with optional body-color
        // override. LOADING (sheet decode in flight) deliberately paints
        // nothing this frame: falling back to procedural lobster here is what
        // produced the "switch companion → flash to default lobster" bug
        // (card_9e52c7b405d0fdd3aad0d2e3). A blank gap for one 33 ms tick is
        // invisible; a wrong-character flash is not.
        val companion = companionRepository?.cached(entity.entityId)
        val attemptedSpritesheet = companion != null && companion.assetType == "spritesheet"
        val drawResult = if (attemptedSpritesheet) {
            spritesheetDrawer?.draw(
                canvas,
                companion,
                entity.entityId,
                spritesheetState,
                centerX,
                charY,
                scale,
                facingDirection,
                mirrorSpritesheetForFacing
            ) ?: SpritesheetCompanionDrawer.DrawResult.UNSUPPORTED
        } else SpritesheetCompanionDrawer.DrawResult.UNSUPPORTED
        if (attemptedSpritesheet && layoutPrefs.wallpaperAdaptiveEffectsEnabled) {
            renderDiagnostics.recordCompanionDraw(entity.entityId, drawResult.toDiagnosticsOutcome())
        }

        when (drawResult) {
            SpritesheetCompanionDrawer.DrawResult.DRAWN,
            SpritesheetCompanionDrawer.DrawResult.LOADING -> Unit
            SpritesheetCompanionDrawer.DrawResult.UNSUPPORTED,
            SpritesheetCompanionDrawer.DrawResult.ERROR ->
                drawLobsterAtPosition(canvas, centerX, charY, entity, scale, companion, facingDirection)
        }

        val bubblePlacement = if (layoutPrefs.wallpaperSpeechBubblesEnabled) {
            speechBubbleController.placementFor(
                entityId = entity.entityId,
                entityXPct = (centerX / canvas.width.toFloat()).coerceIn(0f, 1f),
                entityYPct = (charY / canvas.height.toFloat()).coerceIn(0f, 1f),
                spriteHeightPct = ((radius * 2f) / canvas.height.toFloat()).coerceIn(0.02f, 0.9f),
                nowMs = nowMs
            )
        } else {
            null
        }
        if (bubblePlacement != null) {
            val renderBubblePlacement = if (bubblePlacement.flippedBelow && !isAmbient) {
                val labelClearancePct = ((88f * scale) / canvas.height.toFloat()).coerceIn(0f, 0.12f)
                bubblePlacement.copy(
                    anchorYPct = (bubblePlacement.anchorYPct + labelClearancePct).coerceIn(0f, 1f)
                )
            } else {
                bubblePlacement
            }
            val pulseAgeMs = bubblePulseStartedByEntity[entity.entityId]?.let { nowMs - it } ?: Long.MAX_VALUE
            if (layoutPrefs.wallpaperBubblePulseEnabled) {
                drawBubblePulse(canvas, entity, centerX, charY, radius, scale, pulseAgeMs, renderBubblePlacement.alpha)
            }
            drawMessageBubble(canvas, entity, renderBubblePlacement, scale, screenWidth, bubbleAvoidBounds)
        }

        // Draw Name and Status Group BELOW the entity
        if (!isAmbient) {
            val stateEmoji = getStateEmoji(entity.state)
            val statusText = "$stateEmoji ${entity.state}"

            // Configure paints
            stateTextPaint.textSize = (28f * scale).coerceAtLeast(18f)
            stateTextPaint.color = Color.WHITE

            // Base Y position (below entity)
            val baseY = charY + radius + (40f * scale)
            val lineHeight = stateTextPaint.textSize * 1.3f

            // Draw name if exists (at baseY)
            entity.name?.let { name ->
                stateTextPaint.textAlign = Paint.Align.CENTER
                canvas.drawText(name, centerX, baseY, stateTextPaint)
            }

            // Status bar Y: shifted down if name exists
            val statusY = if (entity.name != null) baseY + lineHeight else baseY

            // Measure dimensions for status bar
            val textWidth = stateTextPaint.measureText(statusText)
            val badgeRadius = 12f * scale // Smaller badge for this location
            val badgeDiameter = badgeRadius * 2
            val spacing = 16f * scale

            // Calculate total width of the group (Badge + Spacing + Text)
            val totalWidth = badgeDiameter + spacing + textWidth

            // Calculate starting X to center the whole group
            val groupStartX = centerX - (totalWidth / 2)
            val badgeCenterY = statusY - (stateTextPaint.textSize / 3) // Align roughly with text middle

            // Draw Badge
            drawEntityBadge(canvas, entity.entityId, groupStartX + badgeRadius, badgeCenterY, scale * 0.5f) // Pass smaller scale because function uses it for radius too

            // Draw Text (Left aligned from after the badge)
            stateTextPaint.textAlign = Paint.Align.LEFT
            canvas.drawText(statusText, groupStartX + badgeDiameter + spacing, statusY, stateTextPaint)
            stateTextPaint.textAlign = Paint.Align.CENTER // Restore default

            // 「健檢中」label below the status bar while health-checking. Pulses
            // its alpha in sync with the ring so the two read as one effect.
            if (entity.healthChecking) {
                val pulse = (sin(time * 0.006f) * 0.5f + 0.5f) // 0..1
                healthLabelPaint.textSize = (24f * scale).coerceAtLeast(16f)
                healthLabelPaint.alpha = (140 + 115 * pulse).toInt().coerceIn(0, 255)
                canvas.drawText(
                    context.getString(R.string.health_checking),
                    centerX,
                    statusY + lineHeight,
                    healthLabelPaint
                )
            }
        }

        // Draw "Zzz" if sleeping (Overlay on body/head, maybe slightly adjusted)
        if (entity.state == CharacterState.SLEEPING && !isAmbient) {
            textPaint.textSize = 60f * scale
            // Moving Zzz slightly up so it doesn't overlap too much with the center face features
            canvas.drawText("Zzz...", centerX + radius * 0.7f, charY - radius * 0.8f, textPaint)
        }
    }

    private fun drawGroundShadow(
        canvas: Canvas,
        cx: Float,
        cy: Float,
        radius: Float,
        scale: Float,
        time: Long
    ) {
        val walkPulse = (sin(time * 0.008f) * 0.5f + 0.5f).toFloat()
        val shadowWidth = radius * (0.78f + 0.05f * walkPulse)
        val shadowHeight = (18f * scale).coerceAtLeast(6f)
        shadowPaint.alpha = (52 + 18 * walkPulse).toInt().coerceIn(0, 96)
        canvas.drawOval(
            RectF(
                cx - shadowWidth,
                cy + radius * 0.72f,
                cx + shadowWidth,
                cy + radius * 0.72f + shadowHeight
            ),
            shadowPaint
        )
        shadowPaint.alpha = 255
    }

    private fun drawInteractionEffect(
        canvas: Canvas,
        effect: WallpaperInteractionController.InteractionEffect,
        scale: Float,
        nowMs: Long
    ) {
        if (isAmbient) return
        val alpha = effect.alpha(nowMs)
        if (alpha <= 0f) return
        interactionTextPaint.textSize = (30f * scale * effect.scale(nowMs)).coerceIn(18f, 46f)
        interactionTextPaint.alpha = (alpha * 210f).toInt().coerceIn(0, 230)
        interactionTextPaint.color = when (effect.kind) {
            WallpaperInteractionController.InteractionKind.GREETING -> Color.rgb(96, 165, 250)
            WallpaperInteractionController.InteractionKind.SPARK -> Color.rgb(250, 204, 21)
            WallpaperInteractionController.InteractionKind.BUMP -> Color.rgb(45, 212, 191)
        }
        canvas.drawText(effect.label, effect.centerX, effect.centerY, interactionTextPaint)
        interactionTextPaint.alpha = 255
    }

    private fun drawStateAura(
        canvas: Canvas,
        entity: EntityStatus,
        cx: Float,
        cy: Float,
        radius: Float,
        scale: Float,
        time: Long
    ) {
        if (isAmbient) return
        val accent = when {
            entity.state == CharacterState.IDLE && wanderController.isWalking(entity.entityId) -> Color.rgb(45, 212, 191)
            entity.state.busyLike -> Color.rgb(59, 130, 246)
            entity.state == CharacterState.EATING -> Color.rgb(34, 197, 94)
            entity.state.excitedLike -> Color.rgb(245, 158, 11)
            entity.state == CharacterState.FAILED -> Color.rgb(248, 113, 113)
            entity.state == CharacterState.REVIEW -> Color.rgb(168, 85, 247)
            entity.state.pausesAmbientWander -> Color.rgb(99, 102, 241)
            else -> return
        }
        val pulse = (sin(time * 0.0045f) * 0.5f + 0.5f).toFloat()
        stateAuraPaint.color = accent
        stateAuraPaint.alpha = (18 + 30 * pulse).toInt().coerceIn(0, 72)
        canvas.drawCircle(cx, cy, radius * (1.04f + 0.08f * pulse) + 8f * scale, stateAuraPaint)
        stateAuraPaint.alpha = 255
    }

    private fun drawBubblePulse(
        canvas: Canvas,
        entity: EntityStatus,
        cx: Float,
        cy: Float,
        radius: Float,
        scale: Float,
        ageMs: Long,
        bubbleAlpha: Float
    ) {
        if (isAmbient || ageMs !in 0L..BUBBLE_PULSE_MS) return
        val progress = ageMs.toFloat() / BUBBLE_PULSE_MS.toFloat()
        bubblePulsePaint.color = stateAccentColor(entity.state)
        bubblePulsePaint.strokeWidth = (3f * scale).coerceAtLeast(1.5f)
        bubblePulsePaint.alpha = ((1f - progress) * bubbleAlpha * 130f).toInt().coerceIn(0, 160)
        canvas.drawCircle(cx, cy, radius * (0.92f + 0.22f * progress), bubblePulsePaint)
        bubblePulsePaint.alpha = 255
    }

    private fun stateAccentColor(state: CharacterState): Int = when {
        state == CharacterState.FAILED -> Color.rgb(248, 113, 113)
        state == CharacterState.REVIEW -> Color.rgb(168, 85, 247)
        state.pausesAmbientWander -> Color.rgb(129, 140, 248)
        state.excitedLike -> Color.rgb(251, 146, 60)
        state.busyLike -> Color.rgb(96, 165, 250)
        state == CharacterState.EATING -> Color.rgb(74, 222, 128)
        else -> Color.rgb(45, 212, 191)
    }

    /**
     * Draw a pulsing/glowing ring around a health-checking entity.
     *
     * Uses a time-based sine pulse so the ring radius + opacity breathe in sync
     * with the wallpaper's 33ms redraw loop (parity with the Web avatar
     * `.health-checking` ring). Two concentric strokes give a soft glow.
     */
    private fun drawHealthCheckingRing(
        canvas: Canvas,
        cx: Float,
        cy: Float,
        radius: Float,
        scale: Float,
        time: Long
    ) {
        val pulse = (sin(time * 0.006f) * 0.5f + 0.5f) // 0..1 breathing factor
        val baseRingRadius = radius * 0.95f
        val ringRadius = baseRingRadius + (12f * scale * pulse)

        // Outer glow (wider stroke, lower alpha)
        healthRingPaint.strokeWidth = 10f * scale
        healthRingPaint.alpha = (50 + 60 * pulse).toInt().coerceIn(0, 255)
        canvas.drawCircle(cx, cy, ringRadius + (6f * scale), healthRingPaint)

        // Inner crisp ring (thinner stroke, higher alpha)
        healthRingPaint.strokeWidth = 5f * scale
        healthRingPaint.alpha = (140 + 115 * pulse).toInt().coerceIn(0, 255)
        canvas.drawCircle(cx, cy, ringRadius, healthRingPaint)

        // Restore full alpha so the shared paint doesn't leak state into reuse
        healthRingPaint.alpha = 255
    }

    /**
     * Draw entity ID badge (small circle with number).
     */
    private fun drawEntityBadge(
        canvas: Canvas,
        entityId: Int,
        x: Float,
        y: Float,
        scale: Float
    ) {
        if (isAmbient) return

        val badgeRadius = 24f * scale

        // Badge background color based on entity ID
        badgePaint.color = when (entityId) {
            0 -> Color.parseColor("#4CAF50") // Green
            1 -> Color.parseColor("#2196F3") // Blue
            2 -> Color.parseColor("#FF9800") // Orange
            3 -> Color.parseColor("#9C27B0") // Purple
            4 -> Color.parseColor("#E91E63") // Pink
            5 -> Color.parseColor("#00BCD4") // Cyan
            6 -> Color.parseColor("#FF5722") // Deep Orange
            7 -> Color.parseColor("#3F51B5") // Indigo
            else -> Color.GRAY
        }

        // Draw badge circle
        canvas.drawCircle(x, y, badgeRadius, badgePaint)

        // Draw entity number
        badgeTextPaint.textSize = 28f * scale
        canvas.drawText("#$entityId", x, y + (10f * scale), badgeTextPaint)
    }

    private fun drawMessageBubble(
        canvas: Canvas,
        entity: EntityStatus,
        placement: SpeechBubbleController.BubblePlacement,
        scale: Float,
        screenWidth: Float,
        avoidBounds: RectF? = null
    ) {
        val displayText = placement.text
        if (displayText.isBlank()) return

        textPaint.textSize = (32f * scale).coerceAtLeast(16f)
        textPaint.color = Color.WHITE
        val alpha = (placement.alpha * 255f).toInt().coerceIn(0, 255)
        if (alpha <= 0) return

        val originalAlign = textPaint.textAlign
        val originalTextAlpha = textPaint.alpha
        val originalBubbleAlpha = bubblePaint.alpha
        val originalStrokeAlpha = bubbleStrokePaint.alpha
        textPaint.textAlign = Paint.Align.LEFT
        textPaint.alpha = alpha

        val padH = 16f * scale
        val padV = 16f * scale
        val screenHeight = canvas.height.toFloat()
        val screenMargin = 40f * scale
        val tailHeight = 20f * scale

        val maxAvailableHeight = screenHeight - (screenMargin * 2) - (padV * 2)
        val maxWidth = (screenWidth * 0.8f).coerceIn(200f, 800f)
        val maxTextWidth = (maxWidth - padH * 2).toInt().coerceAtLeast(1)
        val lineHeight = textPaint.fontSpacing
        val maxLines = (maxAvailableHeight / lineHeight).toInt().coerceAtLeast(1)

        val layoutBuilder = android.text.StaticLayout.Builder.obtain(
            displayText, 0, displayText.length, textPaint, maxTextWidth
        )
            .setAlignment(android.text.Layout.Alignment.ALIGN_NORMAL)
            .setLineSpacing(4f, 1.0f)
            .setIncludePad(true)
            .setMaxLines(maxLines)
            .setEllipsize(android.text.TextUtils.TruncateAt.END)

        val layout = layoutBuilder.build()

        var widestLineWidth = 0f
        for (i in 0 until layout.lineCount) {
            val lineWidth = layout.getLineWidth(i)
            if (lineWidth > widestLineWidth) {
                widestLineWidth = lineWidth
            }
        }

        val finalContentWidth = widestLineWidth.coerceAtLeast(40f * scale)
        val bubbleWidth = finalContentWidth + padH * 2
        val bubbleHeight = layout.height.toFloat() + padV * 2
        val anchorX = placement.anchorXPct * screenWidth
        val anchorY = placement.anchorYPct * screenHeight
        val idealTop = if (placement.flippedBelow) {
            anchorY + tailHeight
        } else {
            anchorY - tailHeight - bubbleHeight
        }
        val maxTop = (screenHeight - screenMargin - bubbleHeight).coerceAtLeast(screenMargin)
        var bubbleTop = idealTop.coerceIn(screenMargin, maxTop)
        val maxLeft = (screenWidth - screenMargin - bubbleWidth).coerceAtLeast(screenMargin)
        val bubbleLeft = (anchorX - bubbleWidth / 2f).coerceIn(screenMargin, maxLeft)
        val bubbleRight = bubbleLeft + bubbleWidth
        avoidBounds?.let { avoid ->
            val avoidPadding = 10f * scale
            val paddedAvoid = RectF(avoid).apply {
                inset(-avoidPadding, -avoidPadding)
            }
            val currentRect = RectF(bubbleLeft, bubbleTop, bubbleRight, bubbleTop + bubbleHeight)
            if (RectF.intersects(currentRect, paddedAvoid)) {
                val candidates = listOf(
                    paddedAvoid.bottom + avoidPadding,
                    paddedAvoid.top - avoidPadding - bubbleHeight,
                    maxTop,
                    screenMargin
                )
                    .map { it.coerceIn(screenMargin, maxTop) }
                    .distinct()
                    .filter { candidateTop ->
                        !RectF.intersects(
                            RectF(bubbleLeft, candidateTop, bubbleRight, candidateTop + bubbleHeight),
                            paddedAvoid
                        )
                    }
                bubbleTop = candidates.minByOrNull { abs(it - idealTop) } ?: bubbleTop
            }
        }
        val bubbleBottom = bubbleTop + bubbleHeight
        val isShifted = abs(bubbleTop - idealTop) > tailHeight * 0.6f

        val cornerRadius = 24f * scale
        val tailWidth = 20f * scale
        val tailBaseX = anchorX.coerceIn(bubbleLeft + cornerRadius, bubbleRight - cornerRadius)
        val path = android.graphics.Path()

        path.addRoundRect(
            RectF(bubbleLeft, bubbleTop, bubbleRight, bubbleBottom),
            cornerRadius,
            cornerRadius,
            android.graphics.Path.Direction.CW
        )
        if (!isAmbient && !isShifted) {
            if (placement.flippedBelow) {
                path.moveTo(tailBaseX - tailWidth / 2f, bubbleTop)
                path.quadTo(tailBaseX - tailWidth * 0.2f, bubbleTop - tailHeight * 0.55f, anchorX, anchorY)
                path.quadTo(tailBaseX + tailWidth * 0.2f, bubbleTop - tailHeight * 0.55f, tailBaseX + tailWidth / 2f, bubbleTop)
            } else {
                path.moveTo(tailBaseX + tailWidth / 2f, bubbleBottom)
                path.quadTo(tailBaseX + tailWidth * 0.2f, bubbleBottom + tailHeight * 0.55f, anchorX, anchorY)
                path.quadTo(tailBaseX - tailWidth * 0.2f, bubbleBottom + tailHeight * 0.55f, tailBaseX - tailWidth / 2f, bubbleBottom)
            }
        }
        path.close()

        val bubblesColor = when {
            entity.state == CharacterState.FAILED -> Color.argb(230, 120, 45, 45)
            entity.state == CharacterState.REVIEW -> Color.argb(230, 80, 55, 135)
            entity.state.pausesAmbientWander -> Color.argb(230, 50, 50, 80)
            entity.state.excitedLike -> Color.argb(230, 255, 100, 50)
            entity.state.busyLike -> Color.argb(230, 50, 100, 150)
            entity.state == CharacterState.EATING -> Color.argb(230, 80, 150, 50)
            else -> Color.argb(230, 40, 40, 40)
        }
        bubblePaint.color = bubblesColor
        bubblePaint.alpha = (Color.alpha(bubblesColor) * placement.alpha).toInt().coerceIn(0, 255)
        bubbleStrokePaint.strokeWidth = 4f * scale
        bubbleStrokePaint.color = Color.WHITE
        bubbleStrokePaint.alpha = (210f * placement.alpha).toInt().coerceIn(0, 255)

        canvas.drawPath(path, bubblePaint)
        canvas.drawPath(path, bubbleStrokePaint)

        canvas.save()
        canvas.translate(bubbleLeft + padH, bubbleTop + padV)
        layout.draw(canvas)
        canvas.restore()

        textPaint.textAlign = originalAlign
        textPaint.alpha = originalTextAlpha
        bubblePaint.alpha = originalBubbleAlpha
        bubbleStrokePaint.alpha = originalStrokeAlpha
    }

    /**
     * Get emoji for state.
     */
    private fun getStateEmoji(state: CharacterState): String = when {
        state == CharacterState.IDLE -> "😐"
        state == CharacterState.SLEEPING || state == CharacterState.WAITING -> "😴"
        state == CharacterState.FAILED -> "⚠️"
        state == CharacterState.REVIEW -> "🔎"
        state == CharacterState.WAVING || state == CharacterState.HAPPY -> "👋"
        state.excitedLike -> "🎉"
        state.busyLike -> "💼"
        state == CharacterState.EATING -> "🍽️"
        else -> "😐"
    }

    /**
     * Draw lobster at specific position with scale.
     *
     * Color priority (highest first):
     *   1. entity.parts["COLOR"]   — live state override from /api/transform
     *   2. companion descriptor `asset.params.bodyColor` — companion-level config
     *   3. character-name fallback (golden/diamond)
     */
    private fun drawLobsterAtPosition(
        canvas: Canvas,
        cx: Float,
        cy: Float,
        entity: EntityStatus,
        scale: Float,
        companion: CompanionDetail? = null,
        facingDirection: WalkFacingDirection = WalkFacingDirection.RIGHT
    ) {
        // SVG scale (original is 4x, now multiply by entity scale)
        val svgScale = 4f * scale

        canvas.save()
        canvas.translate(cx, cy)
        if (facingDirection == WalkFacingDirection.LEFT) {
            canvas.scale(-1f, 1f)
        }
        canvas.translate(-(60 * svgScale), -(60 * svgScale))
        canvas.scale(svgScale, svgScale)

        // Colors
        // Dynamic color
        val charString = entity.character.uppercase(java.util.Locale.ROOT)
        // Check for overrides in parts
        val partsColor = (entity.parts?.get("COLOR") as? Double)?.toInt()
        val descriptorColor = proceduralBodyColorOverride(companion)
        val customColor = partsColor ?: descriptorColor
        val metallic = (entity.parts?.get("METALLIC") as? Double)?.toFloat() ?: 0f
        val gloss = (entity.parts?.get("GLOSS") as? Double)?.toFloat() ?: 0f

        val (coralBright, coralDark) = if (customColor != null) {
            // Ensure alpha channel is set (in case only RGB was provided without alpha)
            // If alpha is 0 (transparent), force it to 0xFF (fully opaque)
            val base = if (android.graphics.Color.alpha(customColor) == 0) {
                customColor or 0xFF000000.toInt()
            } else {
                customColor
            }
            // If metallic, dark color is darker (higher contrast)
            // If gloss, bright color is lighter
            val darkFactor = if (metallic > 0.5f) 0.4f else 0.8f // 0.4 = 60% darker
            val r = android.graphics.Color.red(base)
            val g = android.graphics.Color.green(base)
            val b = android.graphics.Color.blue(base)
            
            val dark = android.graphics.Color.rgb(
                (r * darkFactor).toInt(),
                (g * darkFactor).toInt(),
                (b * darkFactor).toInt()
            )
            Pair(base, dark)
        } else {
            // Fallback to name-based logic
            val isGolden = charString.contains("GOLDEN")
            val isDiamond = charString.contains("DIAMOND")
            
            val bright = when {
                isGolden -> Color.parseColor("#FFD700")
                isDiamond -> Color.CYAN
                else -> Color.parseColor("#FF7F50")
            }
            
            val dark = when {
                isGolden -> Color.parseColor("#DAA520")
                isDiamond -> Color.parseColor("#008B8B")
                else -> Color.parseColor("#CD5B45")
            }
            Pair(bright, dark)
        }

        val bodyPaint = Paint().apply {
            style = Paint.Style.FILL
            color = coralBright
            isAntiAlias = true
            // Note: LinearGradient with canvas transforms needs setLocalMatrix
            // For now, using solid color for reliability
        }

        val strokePaint = Paint().apply {
            style = Paint.Style.STROKE
            color = coralBright
            strokeWidth = 2f
            strokeCap = Paint.Cap.ROUND
            isAntiAlias = true
        }

        // Procedural creature dispatch — non-lobster renderers handled by
        // ProceduralCreatureDrawer; default falls through to legacy lobster paths.
        val rendererKey = companion?.proceduralRenderer()
        val drewCreature = ProceduralCreatureDrawer.draw(
            canvas, rendererKey, entity, companion, coralBright, coralDark,
            System.currentTimeMillis() - startTime
        )
        if (drewCreature) {
            canvas.restore()
            return
        }

        // Body
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

        // Left Claw
        canvas.save()
        val leftRotation = (entity.parts?.get("CLAW_LEFT") as? Double)?.toFloat() ?: 0f
        if (leftRotation != 0f) {
            canvas.rotate(leftRotation, 20f, 55f)
        }
        val leftClawPath = android.graphics.Path().apply {
            moveTo(20f, 45f)
            cubicTo(5f, 40f, 0f, 50f, 5f, 60f)
            cubicTo(10f, 70f, 20f, 65f, 25f, 55f)
            cubicTo(28f, 48f, 25f, 45f, 20f, 45f)
            close()
        }
        canvas.drawPath(leftClawPath, bodyPaint)
        canvas.restore()

        // Right Claw
        canvas.save()
        val rightRotation = (entity.parts?.get("CLAW_RIGHT") as? Double)?.toFloat() ?: 0f
        if (rightRotation != 0f) {
            canvas.rotate(rightRotation, 100f, 55f) // Adjusted pivot
        }
        val rightClawPath = android.graphics.Path().apply {
            moveTo(100f, 45f)
            cubicTo(115f, 40f, 120f, 50f, 115f, 60f)
            cubicTo(110f, 70f, 100f, 65f, 95f, 55f)
            cubicTo(92f, 48f, 95f, 45f, 100f, 45f)
            close()
        }
        canvas.drawPath(rightClawPath, bodyPaint)
        canvas.restore()

        // Antenna
        val antennaL = android.graphics.Path().apply {
            moveTo(45f, 15f)
            quadTo(35f, 5f, 30f, 8f)
        }
        canvas.drawPath(antennaL, strokePaint)

        val antennaR = android.graphics.Path().apply {
            moveTo(75f, 15f)
            quadTo(85f, 5f, 90f, 8f)
        }
        canvas.drawPath(antennaR, strokePaint)

        // Eyes (with EYE_LID and EYE_ANGLE support)
        drawLobsterEyesForEntity(canvas, entity, coralBright)

        canvas.restore()
    }

    /**
     * Draw lobster eyes with EYE_LID and EYE_ANGLE support (called within scaled canvas context).
     * Uses cyberpunk style: deep dark blue base + cyan glow pupil + body-colored lid overlay.
     */
    private fun drawLobsterEyesForEntity(canvas: Canvas, entity: EntityStatus, bodyColor: Int) {
        val eyeRadius = 6f
        val leftEyeX = 45f
        val rightEyeX = 75f
        val eyeY = 35f

        val eyePaint = Paint().apply {
            color = Color.parseColor("#1a1a2e")
            style = Paint.Style.FILL
            isAntiAlias = true
        }
        val eyeGlowPaint = Paint().apply {
            color = Color.CYAN
            style = Paint.Style.FILL
            isAntiAlias = true
        }
        val lidPaint = Paint().apply {
            style = Paint.Style.FILL
            color = bodyColor
            isAntiAlias = true
        }

        val defaultLid = if (entity.state == CharacterState.SLEEPING || entity.state == CharacterState.WAITING) 1.0f else 0f
        val lidFactor = (entity.parts?.get("EYE_LID") as? Double)?.toFloat() ?: defaultLid
        val browAngle = (entity.parts?.get("EYE_ANGLE") as? Double)?.toFloat() ?: 0f

        drawSingleEye(canvas, leftEyeX, eyeY, eyeRadius, lidFactor, browAngle, eyePaint, eyeGlowPaint, lidPaint)
        drawSingleEye(canvas, rightEyeX, eyeY, eyeRadius, lidFactor, -browAngle, eyePaint, eyeGlowPaint, lidPaint)
    }

    private fun drawSingleEye(
        canvas: Canvas, cx: Float, cy: Float, radius: Float,
        lidFactor: Float, browAngle: Float,
        eyePaint: Paint, glowPaint: Paint, lidPaint: Paint
    ) {
        // Draw base eye (deep dark blue circle)
        canvas.drawCircle(cx, cy, radius, eyePaint)
        // Draw cyan glow pupil
        canvas.drawCircle(cx + 1f, cy - 1f, 2f, glowPaint)

        // Draw lid overlay if needed
        if (lidFactor > 0.05f || browAngle != 0f) {
            canvas.save()
            canvas.rotate(browAngle, cx, cy)

            val eyePath = android.graphics.Path()
            eyePath.addCircle(cx, cy, radius, android.graphics.Path.Direction.CW)
            canvas.clipPath(eyePath)

            val lidTop = cy - radius - 2f
            val coverage = 2 * radius * lidFactor + 2f
            val lidBottom = (cy - radius) + coverage

            canvas.drawRect(cx - radius - 2f, lidTop, cx + radius + 2f, lidBottom, lidPaint)
            canvas.restore()
        }
    }

    fun diagnosticsSnapshotForTest(): WallpaperRenderDiagnostics.Snapshot {
        return renderDiagnostics.snapshot()
    }

    private fun SpritesheetCompanionDrawer.DrawResult.toDiagnosticsOutcome(): WallpaperRenderDiagnostics.CompanionDrawOutcome {
        return when (this) {
            SpritesheetCompanionDrawer.DrawResult.DRAWN -> WallpaperRenderDiagnostics.CompanionDrawOutcome.DRAWN
            SpritesheetCompanionDrawer.DrawResult.LOADING -> WallpaperRenderDiagnostics.CompanionDrawOutcome.LOADING
            SpritesheetCompanionDrawer.DrawResult.UNSUPPORTED -> WallpaperRenderDiagnostics.CompanionDrawOutcome.UNSUPPORTED
            SpritesheetCompanionDrawer.DrawResult.ERROR -> WallpaperRenderDiagnostics.CompanionDrawOutcome.ERROR
        }
    }

    // ============================================
    // BACKWARD COMPATIBLE SINGLE ENTITY
    // ============================================

    /**
     * Draw single entity (backward compatible).
     */
    fun draw(canvas: Canvas, status: AgentStatus) {
        // Convert to EntityStatus and use multi-entity renderer
        val entityStatus = EntityStatus.fromAgentStatus(status, 0)
        drawMultiEntity(canvas, listOf(entityStatus))
    }

    companion object {
        private const val BUBBLE_PULSE_MS = 720L
    }
}
