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
import com.hank.clawlive.data.model.WallpaperKanbanCard
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
    private val kanbanRenderer = WallpaperKanbanRenderer(context, layoutPrefs)
    private val wanderController = WallpaperWanderController()
    private val interactionController = WallpaperInteractionController()
    private val speechBubbleController = SpeechBubbleController()
    private val renderDiagnostics = WallpaperRenderDiagnostics()
    private val lastBubbleMessageByEntity = mutableMapOf<Int, String>()
    private val lastBubbleDurationByEntity = mutableMapOf<Int, Long>()
    private val bubblePulseStartedByEntity = mutableMapOf<Int, Long>()

    // Last on-screen pixel center each entity was drawn at this frame. Exposed so
    // the wallpaper Engine can hit-test a touch to the nearest entity for the
    // live drag-to-reposition (HARD PIN) gesture. (card wallpaper-drag-pin)
    private val lastRenderedPositionsByEntity = mutableMapOf<Int, Pair<Float, Float>>()
    private var lastDrawWidthPx: Float = 0f
    private var lastDrawHeightPx: Float = 0f

    // Transient live-drag state: while the user drags an entity, it is drawn at
    // the finger and excluded from wander/pin so it follows freely; on lift the
    // Engine persists the drop point as the entity's pinned custom position.
    private var draggingEntityId: Int? = null
    private var dragPosPx: Pair<Float, Float>? = null

    /** Pixel centers each entity was last drawn at (entityId -> x,y). */
    fun lastRenderedPositions(): Map<Int, Pair<Float, Float>> = lastRenderedPositionsByEntity.toMap()

    /** Canvas width/height of the most recent frame (for hit-radius math). */
    fun lastDrawWidth(): Float = lastDrawWidthPx
    fun lastDrawHeight(): Float = lastDrawHeightPx

    /** Begin dragging [entityId]: stop its wander and draw it at the finger. */
    fun beginDrag(entityId: Int, xPx: Float, yPx: Float) {
        draggingEntityId = entityId
        dragPosPx = xPx to yPx
        wanderController.stop(entityId)
    }

    /** Update the in-flight drag position (finger move). */
    fun updateDragPosition(xPx: Float, yPx: Float) {
        if (draggingEntityId != null) dragPosPx = xPx to yPx
    }

    /** End the drag (the Engine has persisted the pin). */
    fun endDrag() {
        draggingEntityId = null
        dragPosPx = null
    }

    // card_f9b2cc2d v1.1.6 regression fix. A spritesheet whose bitmap is not in
    // sheetCache returns DrawResult.LOADING, which historically painted NOTHING
    // (to avoid a companion-switch flash to the default lobster, card_9e52c7b).
    // But after a cold engine (re)create — CompanionRepository restores the
    // spritesheet DESCRIPTOR from snapshot but not the sheet bitmap — or a cache
    // eviction / failed reload, that LOADING persists for many ticks (or forever
    // if the sheet can never be fetched). With no custom background the canvas is
    // solid black, so invisible entities = the "pure black, no text, no
    // exception" resume bug. We keep a short no-paint grace for genuinely brief
    // loads (no flash), but once an entity has been continuously LOADING past the
    // grace window we draw the procedural fallback so an entity is NEVER
    // invisible for more than ~0.75s, regardless of why the sheet is missing.
    private val spritesheetLoadingSinceMs = mutableMapOf<Int, Long>()
    private val spritesheetStuckReported = mutableSetOf<Int>()

    private data class BubbleDrawTarget(
        val entity: EntityStatus,
        val centerX: Float,
        val centerY: Float,
        val scale: Float
    )

    private data class RoutingCandidate(
        val receiverEntityId: Int,
        val fromEntityId: Int,
        val text: String,
        val timestamp: Long,
        val routingMode: String?,
        val routingEventId: String?,
        val broadcastTargetIds: List<Int>
    )

    private data class ActiveConversationGroup(
        val key: String,
        val entityIds: Set<Int>,
        val expiresAtMs: Long
    )

    private val activeConversationGroups = mutableMapOf<String, ActiveConversationGroup>()
    private val seenConversationKeys = linkedSetOf<String>()

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

    // card_f9b2cc2d resilient-render fix. The wallpaper went pure black on resume
    // because drawMultiEntity drew the background and then THREW while rendering an
    // entity/stage (e.g. a recycled bitmap or a transient null after an
    // app-switch); the exception propagated out and the engine posted only the
    // half-drawn black frame. A single bad entity or sub-stage must never blank the
    // whole wallpaper. Each entity and each render stage is now wrapped so a failure
    // is contained (that one entity/stage is skipped this frame) and the rest of the
    // frame still draws. Failures are recorded to Crashlytics once per distinct
    // stage key so we still learn the exact cause without per-frame spam.
    private val reportedRenderErrors = HashSet<String>()
    private fun reportRenderStageError(stage: String, e: Throwable) {
        Timber.e(e, "render stage failed: $stage")
        if (reportedRenderErrors.add(stage)) {
            try {
                com.google.firebase.crashlytics.FirebaseCrashlytics.getInstance().apply {
                    setCustomKey("render_stage", stage)
                    recordException(e)
                }
            } catch (_: Exception) { /* crashlytics unavailable — Timber already logged */ }
        }
    }

    // card_f9b2cc2d v1.1.6: a spritesheet stuck in LOADING past the grace window
    // (sheet genuinely unavailable) fell back to the procedural drawer instead of
    // staying invisible. Record the field cause once per stuck episode (cleared
    // when the entity next draws a real frame) so we learn WHICH sheet/companion
    // is failing without per-frame Crashlytics spam.
    private fun reportSpritesheetStuckLoading(entityId: Int, companion: CompanionDetail?, loadingMs: Long) {
        if (!spritesheetStuckReported.add(entityId)) return
        Timber.w("Spritesheet stuck LOADING ${loadingMs}ms for entity $entityId (companion=${companion?.id}) → procedural fallback")
        try {
            com.google.firebase.crashlytics.FirebaseCrashlytics.getInstance().apply {
                setCustomKey("stuck_entity_id", entityId)
                setCustomKey("stuck_loading_ms", loadingMs)
                setCustomKey("stuck_companion_id", companion?.id ?: "null")
                recordException(
                    IllegalStateException(
                        "wallpaper spritesheet stuck LOADING ${loadingMs}ms entity=$entityId → procedural fallback (card_f9b2cc2d)"
                    )
                )
            }
        } catch (e: Exception) {
            Timber.e(e, "stuck-loading crashlytics report failed")
        }
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
        // Honor custom positions when custom layout is on OR when ANY entity has a
        // saved custom_pos / pin (B2: a pinned/configured position must be honored
        // even if useCustomLayout was never explicitly toggled — otherwise a pin
        // would be silently ignored). An entity with no saved position falls back
        // to the SHARED grid default (B1) — identical to the settings preview —
        // instead of the old screen-center, which made no-custom-pos entities
        // (e.g. entity #10) stack at the center on the live wallpaper while the
        // editor showed them in a grid.
        if (entities != null &&
            (layoutPrefs.useCustomLayout || layoutPrefs.hasAnyCustomOrPinnedPosition())
        ) {
            val count = entities.size
            return entities.mapIndexed { index, entity ->
                val customPos = layoutPrefs.getCustomPosition(entity.entityId)
                if (customPos != null) {
                    Pair(customPos.first * width, customPos.second * height)
                } else {
                    val (px, py) = WallpaperLayoutDefaults.resolveBasePositionPercent(index, count)
                    Pair(px * width, py * height)
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
        usageSnapshot: UsageSnapshotLatest? = null,
        kanbanCards: List<WallpaperKanbanCard> = emptyList()
    ) {
        multiDrawCount++
        val width = canvas.width.toFloat()
        val height = canvas.height.toFloat()

        if (multiDrawCount <= 5) {
        }

        // Background: draw custom image or solid black. card_f9b2cc2d v1.1.5:
        // wrapped — a recycled/failed bg bitmap on resume must NOT throw out of
        // drawMultiEntity (which would hit the caller's red-error fallback). On
        // failure paint a deliberate dark surface and report the stage.
        try {
        val backgroundBitmap = getBackgroundBitmap(width.toInt(), height.toInt())
        if (backgroundBitmap != null) {
            canvas.drawBitmap(backgroundBitmap, 0f, 0f, backgroundPaint)
        } else if (layoutPrefs.useBackgroundImage && layoutPrefs.backgroundImageUri != null) {
            // A background image IS configured but hasn't loaded yet / failed to decode
            // (the brief render gap after a resume, or slow/failed storage access).
            // Show a "Loading wallpaper…" placeholder on a dark surface instead of a
            // confusing pure-black screen (card_43f365e2, Hank-direct). Don't return —
            // fall through so the entities-empty text below still overlays on top.
            canvas.drawColor(0xFF0B1220.toInt()) // dark navy — reads as a deliberate surface, not a black/crash screen
            val prevSize = textPaint.textSize
            val prevColor = textPaint.color
            textPaint.textSize = 32f
            textPaint.color = Color.WHITE
            canvas.drawText(
                context.getString(R.string.claw_renderer_loading_wallpaper),
                width / 2f, height / 2f, textPaint
            )
            textPaint.textSize = prevSize
            textPaint.color = prevColor
        } else {
            // User intentionally chose a solid-black / no-image wallpaper — keep pure black.
            canvas.drawColor(Color.BLACK)
        }
        } catch (e: Exception) {
            try { canvas.drawColor(0xFF0B1220.toInt()) } catch (_: Exception) {}
            reportRenderStageError("background", e)
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

        // card_f9b2cc2d v1.1.5: wrap the whole layout-compute + entity render so a
        // throw in any early stage (positions / wander / interaction) can't escape
        // to the caller's red-error fallback — the background is already painted above.
        try {
        val basePositions = calculateEntityPositions(width, height, entities.size, entities)
        val baseScale = getScaleFactor(entities.size)
        val nowMs = System.currentTimeMillis()
        if (layoutPrefs.wallpaperSpeechBubblesEnabled) {
            syncSpeechBubbles(entities, nowMs)
        } else {
            clearSpeechBubbles()
        }
        val conversationEntityIds = refreshConversationGroups(entities, nowMs)
        val kanbanActionStates = if (
            layoutPrefs.wallpaperKanbanTasksEnabled ||
            layoutPrefs.wallpaperKanbanAutomationBoardEnabled
        ) {
            kanbanRenderer.update(kanbanCards, nowMs)
        } else {
            kanbanRenderer.update(emptyList(), nowMs)
            emptyMap()
        }
        val walkingEnabled = layoutPrefs.wallpaperWalkingEnabled
        val maxEntityScale = entities.maxOfOrNull { layoutPrefs.getEntityScale(it.entityId).toDouble() }?.toFloat() ?: 1f
        // HARD PIN: pinned entities are LOCKED at their configured position. The
        // entity currently being live-dragged is excluded so it follows the
        // finger; its pin is re-applied on drop.
        val pinnedIds = entities.asSequence()
            .map { it.entityId }
            .filter { layoutPrefs.isPinned(it) && it != draggingEntityId }
            .toSet()
        val positions = wanderController.positionsFor(
            basePositions = basePositions,
            entities = entities,
            width = width,
            height = height,
            enabled = walkingEnabled,
            purposeful = layoutPrefs.wallpaperPurposefulWalkingEnabled,
            nowMs = nowMs,
            conversationEntityIds = conversationEntityIds,
            entityUnitPx = 300f * baseScale * maxEntityScale,
            pinnedEntityIds = pinnedIds
        )
        val interactionState = interactionController.apply(
            positions = positions,
            entities = entities,
            width = width,
            height = height,
            enabled = layoutPrefs.wallpaperEntityInteractionsEnabled,
            nowMs = nowMs,
            reactionDurationMs = layoutPrefs.wallpaperCollisionReactionDurationMs
        )
        try {
            kanbanRenderer.drawBackground(
                canvas = canvas,
                entities = entities,
                basePositions = basePositions,
                baseScale = baseScale,
                nowMs = nowMs
            )
        } catch (e: Exception) {
            reportRenderStageError("kanbanBackground", e)
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

        val bubbleDrawTargets = mutableListOf<BubbleDrawTarget>()
        lastRenderedPositionsByEntity.clear()
        lastDrawWidthPx = width
        lastDrawHeightPx = height
        entities.forEachIndexed { index, entity ->
            if (index < interactionState.positions.size) {
                val drag = if (entity.entityId == draggingEntityId) dragPosPx else null
                val (cx, cy) = drag ?: interactionState.positions[index]
                val interactionPose = interactionState.posesByEntity[entity.entityId]
                val drawCy = cy - (if (drag != null) 0f else (interactionPose?.liftPx ?: 0f))
                lastRenderedPositionsByEntity[entity.entityId] = cx to drawCy
                // Apply per-entity scale multiplier on top of base scale
                val entityScale = layoutPrefs.getEntityScale(entity.entityId)
                val finalScale = baseScale * entityScale
                val facingDirection = interactionPose?.facingDirection
                    ?: wanderController.facingDirection(entity.entityId)
                val actionState = kanbanActionStates[entity.entityId]
                    ?: interactionState.actionStatesByEntity[entity.entityId]
                val effectiveState = actionState ?: entity.state
                val spritesheetState = if (
                    wanderController.isWalking(entity.entityId) &&
                    effectiveState.canUseAmbientWalkingAnimation
                ) {
                    walkingSpritesheetStateFor(facingDirection)
                } else {
                    effectiveState.wallpaperActionKey
                }
                try {
                    drawSingleEntityAt(
                        canvas,
                        entity,
                        cx,
                        drawCy,
                        finalScale,
                        spritesheetState,
                        nowMs,
                        facingDirection,
                        shouldMirrorSpritesheetForFacing(spritesheetState)
                    )
                    bubbleDrawTargets.add(BubbleDrawTarget(entity, cx, drawCy, finalScale))
                } catch (e: Exception) {
                    // card_f9b2cc2d: one bad entity must not blank the whole wallpaper.
                    reportRenderStageError("entity:${entity.entityId}", e)
                }
            }
        }

        try {
            interactionState.effects.forEach { effect ->
                drawInteractionEffect(canvas, effect, baseScale, nowMs)
            }
        } catch (e: Exception) {
            reportRenderStageError("interactionEffects", e)
        }

        try {
            usageOverlayRenderer.draw(canvas, usageSnapshot)
        } catch (e: Exception) {
            reportRenderStageError("usageOverlay", e)
        }

        bubbleDrawTargets.forEach { target ->
            try {
                drawSpeechBubbleForEntity(
                    canvas = canvas,
                    entity = target.entity,
                    centerX = target.centerX,
                    centerY = target.centerY,
                    scale = target.scale,
                    screenWidth = width,
                    nowMs = nowMs,
                    avoidBounds = bubbleAvoidBounds
                )
            } catch (e: Exception) {
                reportRenderStageError("bubble:${target.entity.entityId}", e)
            }
        }
        } catch (e: Exception) {
            // card_f9b2cc2d v1.1.5: any uncaught throw in the layout-compute /
            // entity-render section is contained here (background already painted)
            // so draw() never re-throws into the red-error fallback. The stage key
            // names it in Crashlytics for a precise follow-up.
            reportRenderStageError("layout", e)
        }
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

    private fun refreshConversationGroups(entities: List<EntityStatus>, nowMs: Long): Set<Int> {
        activeConversationGroups.keys.toList().forEach { key ->
            if ((activeConversationGroups[key]?.expiresAtMs ?: 0L) <= nowMs) {
                activeConversationGroups.remove(key)
            }
        }
        if (!layoutPrefs.wallpaperPurposefulWalkingEnabled || !layoutPrefs.wallpaperSpeechBubblesEnabled) {
            activeConversationGroups.clear()
            return emptySet()
        }

        val entityIds = entities.map { it.entityId }.toSet()
        val candidates = entities.flatMap { entity ->
            entity.messageQueue.orEmpty().mapNotNull { queueItem ->
                val text = queueItem.text?.trim().orEmpty()
                if (text.isBlank()) return@mapNotNull null
                // Gson can bypass Kotlin null-safety: user/scheduled messages lack
                // fromCharacter (backend only sets it on entity-to-entity messages), so a
                // null slips into this non-null-typed field. Calling .isBlank() directly
                // threw NPE on every draw frame → blank/black wallpaper (card_f22e489c).
                // Mirror the same defensive guard StateRepository already uses.
                @Suppress("SENSELESS_COMPARISON")
                if (queueItem.fromCharacter == null || queueItem.fromCharacter.isBlank()) return@mapNotNull null
                if (queueItem.fromEntityId !in entityIds) return@mapNotNull null
                if (queueItem.fromEntityId == entity.entityId && queueItem.routingMode != "broadcast") {
                    return@mapNotNull null
                }
                val timestamp = queueItem.timestamp.takeIf { it > 0L } ?: nowMs
                if (nowMs - timestamp > CONVERSATION_EVENT_STALE_MS) return@mapNotNull null
                RoutingCandidate(
                    receiverEntityId = entity.entityId,
                    fromEntityId = queueItem.fromEntityId,
                    text = text,
                    timestamp = timestamp,
                    routingMode = queueItem.routingMode,
                    routingEventId = queueItem.routingEventId,
                    broadcastTargetIds = queueItem.broadcastTargetIds.orEmpty()
                )
            }
        }
        candidates
            .groupBy { it.routingEventId ?: fallbackConversationKey(it) }
            .forEach { (key, group) ->
                if (key in seenConversationKeys || group.isEmpty()) return@forEach
                val groupEntityIds = buildSet {
                    group.forEach { candidate ->
                        add(candidate.fromEntityId)
                        add(candidate.receiverEntityId)
                        candidate.broadcastTargetIds.filter { it in entityIds }.forEach { add(it) }
                    }
                }.intersect(entityIds)
                if (groupEntityIds.size < 2) return@forEach
                val expiresAt = group.maxOfOrNull {
                    speechBubbleController.expiresAt(it.receiverEntityId, nowMs) ?: (nowMs + layoutPrefs.wallpaperBubbleDurationMs)
                } ?: (nowMs + layoutPrefs.wallpaperBubbleDurationMs)
                activeConversationGroups[key] = ActiveConversationGroup(
                    key = key,
                    entityIds = groupEntityIds,
                    expiresAtMs = expiresAt
                )
                rememberConversationKey(key)
            }

        return activeConversationGroups.values
            .filter { it.expiresAtMs > nowMs }
            .flatMap { it.entityIds }
            .toSet()
    }

    private fun fallbackConversationKey(candidate: RoutingCandidate): String {
        val bucket = candidate.timestamp / CONVERSATION_GROUP_WINDOW_MS
        return "${candidate.fromEntityId}:${candidate.text.hashCode()}:$bucket:${candidate.routingMode.orEmpty()}"
    }

    private fun rememberConversationKey(key: String) {
        seenConversationKeys.add(key)
        while (seenConversationKeys.size > MAX_SEEN_CONVERSATIONS) {
            val iterator = seenConversationKeys.iterator()
            if (!iterator.hasNext()) return
            iterator.next()
            iterator.remove()
        }
    }

    private fun shouldMirrorSpritesheetForFacing(spritesheetState: String): Boolean {
        return spritesheetState != CharacterState.RUNNING_LEFT.wallpaperActionKey &&
            spritesheetState != CharacterState.RUNNING_RIGHT.wallpaperActionKey
    }

    private fun walkingSpritesheetStateFor(facingDirection: WalkFacingDirection): String {
        return when (facingDirection) {
            WalkFacingDirection.LEFT -> CharacterState.RUNNING_LEFT.wallpaperActionKey
            WalkFacingDirection.RIGHT -> CharacterState.RUNNING_RIGHT.wallpaperActionKey
        }
    }

    private fun characterDrawY(
        entity: EntityStatus,
        centerY: Float,
        scale: Float,
        nowMs: Long
    ): Float {
        val time = nowMs - startTime
        val bobOffset = if (entity.state.pausesAmbientWander) {
            0f
        } else {
            val speed = if (entity.state.busyLike) 0.01f else 0.003f
            (sin(time * speed) * 30 * scale).toFloat()
        }
        return centerY + bobOffset
    }

    private fun drawSpeechBubbleForEntity(
        canvas: Canvas,
        entity: EntityStatus,
        centerX: Float,
        centerY: Float,
        scale: Float,
        screenWidth: Float,
        nowMs: Long,
        avoidBounds: RectF? = null
    ) {
        if (!layoutPrefs.wallpaperSpeechBubblesEnabled) return
        val charY = characterDrawY(entity, centerY, scale, nowMs)
        val radius = 150f * scale
        val bubblePlacement = speechBubbleController.placementFor(
            entityId = entity.entityId,
            entityXPct = (centerX / canvas.width.toFloat()).coerceIn(0f, 1f),
            entityYPct = (charY / canvas.height.toFloat()).coerceIn(0f, 1f),
            spriteHeightPct = ((radius * 2f) / canvas.height.toFloat()).coerceIn(0.02f, 0.9f),
            nowMs = nowMs
        ) ?: return
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
        drawMessageBubble(canvas, entity, renderBubblePlacement, scale, screenWidth, avoidBounds)
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
        spritesheetState: String = entity.state.wallpaperActionKey,
        nowMs: Long = System.currentTimeMillis(),
        facingDirection: WalkFacingDirection = WalkFacingDirection.RIGHT,
        mirrorSpritesheetForFacing: Boolean = true
    ) {
        val time = nowMs - startTime
        val charY = characterDrawY(entity, centerY, scale, nowMs)
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
            SpritesheetCompanionDrawer.DrawResult.DRAWN -> {
                // Healthy frame — clear this entity's LOADING-grace tracker.
                spritesheetLoadingSinceMs.remove(entity.entityId)
                spritesheetStuckReported.remove(entity.entityId)
            }
            SpritesheetCompanionDrawer.DrawResult.LOADING -> {
                // Sheet not yet in cache. A brief load paints nothing this tick
                // (no flash to the default lobster). But a SUSTAINED LOADING —
                // cold snapshot restore, cache eviction, or a reload that never
                // lands — must not leave the entity invisible (the pure-black
                // bug). Once continuously LOADING past the grace window, draw the
                // procedural fallback (color-matched via the companion descriptor)
                // so an entity is never invisible for more than the grace.
                // (card_f9b2cc2d v1.1.6)
                val since = spritesheetLoadingSinceMs.getOrPut(entity.entityId) { nowMs }
                if (shouldFallbackForStuckSpritesheet(since, nowMs)) {
                    reportSpritesheetStuckLoading(entity.entityId, companion, nowMs - since)
                    drawLobsterAtPosition(canvas, centerX, charY, entity, scale, companion, facingDirection)
                }
            }
            SpritesheetCompanionDrawer.DrawResult.UNSUPPORTED,
            SpritesheetCompanionDrawer.DrawResult.ERROR -> {
                spritesheetLoadingSinceMs.remove(entity.entityId)
                drawLobsterAtPosition(canvas, centerX, charY, entity, scale, companion, facingDirection)
            }
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
        private const val CONVERSATION_GROUP_WINDOW_MS = 2_000L
        private const val CONVERSATION_EVENT_STALE_MS = 120_000L
        private const val MAX_SEEN_CONVERSATIONS = 128

        /**
         * card_f9b2cc2d v1.1.6: how long a spritesheet may stay in LOADING (and
         * paint nothing) before the renderer falls back to the procedural drawer
         * so the entity is never invisible. Short enough the user never sees a
         * long black gap; long enough a quick disk-decode load doesn't flash the
         * procedural lobster (preserves the no-flash intent of card_9e52c7b).
         */
        const val SPRITESHEET_LOADING_GRACE_MS = 750L

        /**
         * Pure decision for the LOADING grace window (unit-tested without a
         * Context). Returns true once a spritesheet has been continuously LOADING
         * for at least [graceMs]. [loadingSinceMs] is the wall-clock ms when
         * LOADING first began for this entity (0 means "not currently tracked").
         */
        fun shouldFallbackForStuckSpritesheet(
            loadingSinceMs: Long,
            nowMs: Long,
            graceMs: Long = SPRITESHEET_LOADING_GRACE_MS
        ): Boolean = loadingSinceMs > 0L && nowMs - loadingSinceMs >= graceMs
    }
}
