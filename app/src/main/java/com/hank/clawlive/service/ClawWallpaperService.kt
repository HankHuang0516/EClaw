package com.hank.clawlive.service

import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.os.Handler
import android.os.Looper
import android.service.wallpaper.WallpaperService
import android.view.SurfaceHolder
import timber.log.Timber
import com.hank.clawlive.R
import com.hank.clawlive.engine.ClawRenderer
import com.hank.clawlive.engine.EngineLifecycleController
import com.hank.clawlive.data.model.AgentStatus
import com.hank.clawlive.data.model.CharacterState
import com.hank.clawlive.data.model.EntityStatus
import com.hank.clawlive.data.model.UsageSnapshotLatest
import com.hank.clawlive.data.model.WallpaperKanbanCard
import kotlinx.coroutines.launch
import kotlinx.coroutines.cancel

class ClawWallpaperService : WallpaperService() {

    override fun onCreate() {
        super.onCreate()
        Timber.d("ClawWallpaperService Created")
    }

    override fun onCreateEngine(): Engine {
        Timber.d("Creating ClawEngine")
        return ClawEngine()
    }

    override fun onDestroy() {
        super.onDestroy()
        Timber.d("ClawWallpaperService Destroyed")
    }

    inner class ClawEngine : WallpaperService.Engine() {

        private val handler = Handler(Looper.getMainLooper())
        private var visible = false
        private val companionRepository = com.hank.clawlive.data.repository.CompanionRepository(
            com.hank.clawlive.data.remote.NetworkModule.api,
            this@ClawWallpaperService
        )
        private val walkConfigRepository = com.hank.clawlive.data.repository.WalkConfigRepository(
            this@ClawWallpaperService
        )
        private val renderer = ClawRenderer(this@ClawWallpaperService, companionRepository)
        private val repository = com.hank.clawlive.data.repository.StateRepository(
            com.hank.clawlive.data.remote.NetworkModule.api,
            this@ClawWallpaperService
        )

        // Live drag-to-reposition (HARD PIN). The pure-Kotlin state machine owns
        // the hit-test / long-press / drag / commit decisions; this Engine is the
        // Android glue (Handler timer, renderer redraw, prefs persistence).
        private val layoutPrefs =
            com.hank.clawlive.data.local.LayoutPreferences.getInstance(this@ClawWallpaperService)
        private val dragController = com.hank.clawlive.engine.WallpaperDragController()
        private var pendingLongPress: Runnable? = null

        private val engineScope = kotlinx.coroutines.CoroutineScope(
            kotlinx.coroutines.Dispatchers.Main + kotlinx.coroutines.SupervisorJob()
        )

        // Multi-entity mode flag (true = use multi-entity API)
        private val multiEntityMode = true

        // Single entity status (backward compatible)
        private var currentStatus = AgentStatus(
            state = CharacterState.IDLE,
            message = "Connecting..."
        )

        // Multi-entity status list (start empty - only show bound entities)
        private var currentEntities: List<EntityStatus> = emptyList()

        private var currentUsageSnapshot: UsageSnapshotLatest? = null
        private var currentKanbanCards: List<WallpaperKanbanCard> = emptyList()

        // Tracks whether observeStatus has received its first response. Until
        // then, draw() shows "Loading entities…" instead of the permanent
        // "No entities connected" placeholder — prevents the Live Wallpaper
        // chooser preview from flashing that message while the first network
        // call is still in flight.
        private var hasFirstResponse = false

        private val drawRunnable = Runnable { draw() }

        // card_f9b2cc2d diagnostic+mitigation: paint for the multi-level loading
        // markers. Each black-screen-prone entry point paints a DISTINCT labelled
        // "Loading… (<where>)" frame DIRECTLY (independent of the draw loop), so
        // (a) the user never sees raw black on resume, and (b) which label shows
        // tells us exactly which path was hit (vs still-pure-black = the Engine
        // never even got the callback → deepest surface/GL level).
        private val loadingPaint = Paint().apply {
            color = Color.WHITE
            textAlign = Paint.Align.CENTER
            isAntiAlias = true
            textSize = 38f
        }

        /**
         * Lock the surface and paint ONE labelled loading frame immediately,
         * bypassing the draw loop. Safe to call from any lifecycle callback —
         * if the real draw loop then runs it simply overwrites this; if it does
         * NOT (the bug), this stays on screen instead of black. `where` is the
         * diagnostic marker (surface / resume / changed).
         */
        private fun paintLoadingMarker(where: String, holder: SurfaceHolder? = surfaceHolder) {
            val h = holder ?: return
            var canvas: Canvas? = null
            try {
                canvas = h.lockCanvas() ?: return
                canvas.drawColor(0xFF0B1220.toInt()) // dark navy — deliberate surface, not black
                val cx = canvas.width / 2f
                val cy = canvas.height / 2f
                val label = this@ClawWallpaperService.getString(
                    R.string.claw_wallpaper_loading_marker, where
                )
                canvas.drawText(label, cx, cy, loadingPaint)
            } catch (e: Exception) {
                Timber.e(e, "paintLoadingMarker($where) failed")
            } finally {
                if (canvas != null) {
                    try { h.unlockCanvasAndPost(canvas) } catch (e: Exception) { Timber.e(e, "marker unlock failed") }
                }
            }
        }

        /**
         * Authoritative check of whether the current surface is actually
         * drawable, independent of the surfacePresent flag (which depends on
         * onSurfaceCreated/Changed having fired). Used as the draw-loop gate and
         * by the resume watchdog so a missed/late surface callback can no longer
         * leave the wallpaper permanently black. (card_f9b2cc2d)
         */
        private fun surfaceValid(): Boolean =
            try { surfaceHolder?.surface?.isValid == true } catch (e: Exception) { false }

        // card_f9b2cc2d resume watchdog. A brief app-switch return can deliver
        // onVisibilityChanged(true) WITHOUT a paired onSurfaceCreated, or the
        // surface becomes valid a few hundred ms AFTER the callback. The 33ms
        // draw loop only (re)schedules itself from inside draw(); if nothing
        // kicks the first draw once the surface is valid, the loop stays dead →
        // permanent black. This bounded retry burst re-attempts draw() at
        // increasing delays after every resume entry point; the first attempt
        // that finds a valid surface restarts the self-sustaining 33ms loop. If
        // the whole window elapses while visible but the surface never becomes
        // valid, it records a Crashlytics non-fatal so the genuinely-stuck case
        // (deepest GL/surface level) is captured in the field.
        private val resumeRetryDelaysMs = longArrayOf(100, 300, 600, 1200, 2500)
        private var resumeWatchdogToken = 0

        private fun kickDrawLoop(reason: String) {
            // Supersede any in-flight watchdog burst.
            val token = ++resumeWatchdogToken
            if (visible && surfaceValid()) draw()
            for (delay in resumeRetryDelaysMs) {
                handler.postDelayed({
                    if (token != resumeWatchdogToken || !visible) return@postDelayed
                    if (surfaceValid()) {
                        draw()
                    } else if (delay == resumeRetryDelaysMs.last()) {
                        reportStuckBlack(reason)
                    }
                }, delay)
            }
        }

        private fun reportStuckBlack(reason: String) {
            val msg = "wallpaper resume stuck black: reason=$reason visible=$visible " +
                "surfaceValid=${surfaceValid()} surfacePresent=${lifecycle.surfacePresent}"
            Timber.e(msg)
            try {
                com.google.firebase.crashlytics.FirebaseCrashlytics.getInstance()
                    .recordException(IllegalStateException(msg))
            } catch (e: Exception) {
                Timber.e(e, "crashlytics report failed")
            }
        }

        // Pure-JVM lifecycle state machine (card_f9b2cc2d). Source of truth for
        // whether engine-lifetime resources are still alive. Surface
        // destroy→recreate (an app-switch) must NOT tear down engineScope /
        // renderer / companionRepository — only Engine.onDestroy does.
        private val lifecycle = EngineLifecycleController(object : EngineLifecycleController.Hooks {
            override fun stopDrawLoop() {
                handler.removeCallbacks(drawRunnable)
            }

            override fun restartInactivePollersAndDraw() {
                if (statusJob?.isActive != true) observeStatus()
                if (usageJob?.isActive != true) observeUsage()
                if (kanbanJob?.isActive != true) observeKanban()
                draw()
            }

            override fun cancelAllPollers() {
                this@ClawEngine.cancelAllPollers()
            }

            override fun releaseEngineResources() {
                engineScope.cancel()
                renderer.release()
                companionRepository.release()
                walkConfigRepository.release()
            }
        })

        override fun onCreate(surfaceHolder: SurfaceHolder?) {
            super.onCreate(surfaceHolder)
            Timber.d("ClawEngine onCreate")
            setTouchEventsEnabled(true)
            lifecycle.onEngineCreate()
            observeStatus()
            observeUsage()
            observeKanban()
            // Start the lifetime self-healing heartbeat (card_f9b2cc2d).
            handler.postDelayed(healthHeartbeat, 1000L)
        }

        // Tracks which entityIds already have a companion-poller flow running so
        // we don't spawn duplicate jobs each time getMultiEntityStatusFlow emits.
        private val companionJobs = mutableMapOf<Int, kotlinx.coroutines.Job>()
        private val walkConfigJobs = mutableMapOf<Int, kotlinx.coroutines.Job>()

        // Held references so visibility transitions can cancel/restart pollers
        // rather than letting them burn API quota while the wallpaper is
        // covered/screen-off. Bug card_a7baa3b0b1151099d4523428: previously
        // these flows ran unconditionally from onCreate, hitting /api/status
        // every 5s × 6 entities → 72 calls/min → CF rate limit 429 storms.
        private var statusJob: kotlinx.coroutines.Job? = null
        private var usageJob: kotlinx.coroutines.Job? = null
        private var kanbanJob: kotlinx.coroutines.Job? = null

        private fun observeStatus() {
            statusJob?.cancel()
            statusJob = engineScope.launch {
                if (multiEntityMode) {
                    // Multi-entity mode: fetch all entities
                    repository.getMultiEntityStatusFlow(intervalMs = 30000)
                        .collect { response ->
                            Timber.d("Multi-entity status: ${response.activeCount} entities")
                            // Debug: log first entity's name
                            response.entities.firstOrNull()?.let { e ->
                                Timber.d("First entity: id=${e.entityId}, name=${e.name}, state=${e.state}")
                            }
                            currentEntities = response.entities
                            hasFirstResponse = true
                            ensureCompanionPollers(response.entities)
                            ensureWalkConfigPollers(response.entities)
                            if (visible) draw()
                        }
                } else {
                    // Single entity mode (backward compatible)
                    repository.getStatusFlow(intervalMs = 30000)
                        .collect { newStatus ->
                            Timber.d("Single status: ${newStatus.state}")
                            currentStatus = newStatus
                            if (visible) draw()
                        }
                }
            }
        }

        private fun observeUsage() {
            usageJob?.cancel()
            usageJob = engineScope.launch {
                repository.getUsageSnapshotFlow(intervalMs = 30000)
                    .collect { snapshot ->
                        currentUsageSnapshot = snapshot
                        if (visible) draw()
                    }
            }
        }

        private fun observeKanban() {
            kanbanJob?.cancel()
            kanbanJob = engineScope.launch {
                repository.getWallpaperKanbanCardsFlow(intervalMs = 60000)
                    .collect { cards ->
                        currentKanbanCards = cards
                        if (visible) draw()
                    }
            }
        }

        private fun cancelAllPollers() {
            statusJob?.cancel()
            statusJob = null
            usageJob?.cancel()
            usageJob = null
            kanbanJob?.cancel()
            kanbanJob = null
            companionJobs.values.forEach { it.cancel() }
            companionJobs.clear()
            walkConfigJobs.values.forEach { it.cancel() }
            walkConfigJobs.clear()
        }

        private fun ensureCompanionPollers(entities: List<EntityStatus>) {
            // Start a flow per entity that has a botSecret; cancel any pollers
            // for entities that have disappeared since last emission.
            val active = entities.mapNotNull { e ->
                e.botSecret?.let { secret -> e.entityId to secret }
            }
            val activeIds = active.map { it.first }.toSet()
            companionJobs.keys.toList().forEach { id ->
                if (id !in activeIds) {
                    companionJobs.remove(id)?.cancel()
                }
            }
            for ((id, secret) in active) {
                if (companionJobs[id]?.isActive == true) continue
                companionJobs[id] = engineScope.launch {
                    companionRepository.getCompanionFlow(id, secret).collect {
                        if (visible) draw()
                    }
                }
            }
        }

        private fun ensureWalkConfigPollers(entities: List<EntityStatus>) {
            val active = entities.mapNotNull { e ->
                e.botSecret?.let { secret -> e.entityId to secret }
            }
            val activeIds = active.map { it.first }.toSet()
            walkConfigRepository.pruneTo(activeIds)
            renderer.setWalkActionConfigs(walkConfigRepository.cachedMap())

            walkConfigJobs.keys.toList().forEach { id ->
                if (id !in activeIds) {
                    walkConfigJobs.remove(id)?.cancel()
                }
            }
            for ((id, secret) in active) {
                if (walkConfigJobs[id]?.isActive == true) continue
                walkConfigJobs[id] = engineScope.launch {
                    walkConfigRepository.getWalkConfigFlow(id, secret).collect {
                        renderer.setWalkActionConfigs(walkConfigRepository.cachedMap())
                        if (visible) draw()
                    }
                }
            }
        }

        override fun onVisibilityChanged(visible: Boolean) {
            this.visible = visible
            Timber.d("onVisibilityChanged: $visible")
            // Becoming visible (returning to the home screen) is the moment the
            // app-switch black is reported. Paint "Loading… (resume)" directly so
            // the very first visible frame is never raw black; the draw loop (if
            // it resumes via the controller below) overwrites it immediately.
            if (visible) paintLoadingMarker("resume")
            // Delegate to the lifecycle controller. When shown it restarts any
            // poller that was cancelled while hidden (card_a7baa3b0b1151099d4523428
            // close-out) and redraws. When hidden it stops the draw loop and
            // cancels all pollers — the quota gate that prevents the /api/status
            // 429 storm. Engine-lifetime resources are untouched either way.
            lifecycle.onVisibilityChanged(visible)
            // Resume watchdog: kick the draw loop independently of whether a
            // paired onSurfaceCreated arrives, so a missed/late surface callback
            // can't leave us black. (card_f9b2cc2d)
            if (visible) kickDrawLoop("visibility")
        }

        override fun onTouchEvent(event: android.view.MotionEvent?) {
            if (event == null) {
                super.onTouchEvent(event)
                return
            }
            when (event.actionMasked) {
                android.view.MotionEvent.ACTION_DOWN -> {
                    if (handleDragDown(event)) return
                }
                android.view.MotionEvent.ACTION_MOVE -> {
                    if (handleDragMove(event)) return
                }
                android.view.MotionEvent.ACTION_UP -> {
                    if (handleDragUp(event)) return
                    // Not a drag — original tap = wake-entity-0 behavior.
                    handleTapWake()
                }
                android.view.MotionEvent.ACTION_CANCEL -> {
                    cancelPendingLongPress()
                    if (dragController.isDragging) {
                        dragController.cancel()
                        renderer.endDrag()
                        if (visible) draw()
                    }
                }
            }
            super.onTouchEvent(event)
        }

        /** Hit radius for grabbing an entity (scaled with screen + a min target). */
        private fun hitRadiusPx(): Float {
            val w = renderer.lastDrawWidth().takeIf { it > 0f }
                ?: surfaceHolder?.surfaceFrame?.width()?.toFloat()
                ?: return 0f
            val minRadius = 96f * resources.displayMetrics.density
            return maxOf(
                w * com.hank.clawlive.engine.WallpaperDragController.DEFAULT_HIT_RADIUS_FACTOR,
                minRadius
            )
        }

        private fun cancelPendingLongPress() {
            pendingLongPress?.let { handler.removeCallbacks(it) }
            pendingLongPress = null
        }

        /**
         * ACTION_DOWN: if the touch lands on a rendered entity, arm a long-press
         * that promotes the press to a drag. Returns true when the press was
         * captured (an entity is under the finger), so the Engine waits for the
         * long-press instead of treating it as a plain tap.
         */
        private fun handleDragDown(event: android.view.MotionEvent): Boolean {
            if (currentEntities.isEmpty()) return false
            val result = dragController.onDown(
                event.x,
                event.y,
                renderer.lastRenderedPositions(),
                hitRadiusPx()
            )
            if (!result.hitEntity) return false
            val x = event.x
            val y = event.y
            cancelPendingLongPress()
            val runnable = Runnable {
                pendingLongPress = null
                val id = dragController.onLongPress() ?: return@Runnable
                renderer.beginDrag(id, x, y)
                if (visible) draw()
            }
            pendingLongPress = runnable
            handler.postDelayed(
                runnable,
                com.hank.clawlive.engine.WallpaperDragController.LONG_PRESS_MS
            )
            return true
        }

        private fun handleDragMove(event: android.view.MotionEvent): Boolean {
            val slop = android.view.ViewConfiguration
                .get(this@ClawWallpaperService).scaledTouchSlop.toFloat()
            return when (val r = dragController.onMove(event.x, event.y, slop)) {
                is com.hank.clawlive.engine.WallpaperDragController.MoveResult.Drag -> {
                    renderer.updateDragPosition(r.x, r.y)
                    if (visible) draw()
                    true
                }
                com.hank.clawlive.engine.WallpaperDragController.MoveResult.PendingCancelled -> {
                    // Treat as a page swipe: drop the long-press, do not consume.
                    cancelPendingLongPress()
                    false
                }
                com.hank.clawlive.engine.WallpaperDragController.MoveResult.Ignored -> false
            }
        }

        /**
         * ACTION_UP: if a drag was in progress, persist the drop point as the
         * entity's pinned custom position and stop the gesture. Returns true when
         * a drag was committed (so the Engine skips tap=wake).
         */
        private fun handleDragUp(event: android.view.MotionEvent): Boolean {
            cancelPendingLongPress()
            val commit = dragController.onUp(
                renderer.lastDrawWidth(),
                renderer.lastDrawHeight()
            )
            renderer.endDrag()
            if (commit == null) return false
            // HARD PIN: custom_pos + pinned + useCustomLayout in one write.
            layoutPrefs.pinAt(commit.entityId, commit.xPercent, commit.yPercent)
            Timber.d("Pinned entity ${commit.entityId} at ${commit.xPercent},${commit.yPercent}")
            if (visible) draw()
            return true
        }

        private fun handleTapWake() {
            // Only wake up if there are bound entities
            if (multiEntityMode) {
                if (currentEntities.isEmpty()) return
                // Wake up entity 0 on tap
                currentEntities = currentEntities.mapIndexed { index, entity ->
                    if (index == 0) entity.copy(message = "Waking up...", state = CharacterState.EXCITED)
                    else entity
                }
            } else {
                currentStatus = currentStatus.copy(message = "Waking up...", state = CharacterState.EXCITED)
            }
            if (visible) draw()

            engineScope.launch {
                try {
                    repository.wakeUp()
                    if (multiEntityMode && currentEntities.isNotEmpty()) {
                        currentEntities = currentEntities.mapIndexed { index, entity ->
                            if (index == 0) entity.copy(message = "I'm Awake!")
                            else entity
                        }
                    } else {
                        currentStatus = currentStatus.copy(message = "I'm Awake!")
                    }
                    if (visible) draw()
                    kotlinx.coroutines.delay(2000)
                } catch (e: Exception) {
                    Timber.e(e, "Wake up failed")
                }
            }
        }

        override fun onSurfaceCreated(holder: SurfaceHolder?) {
            super.onSurfaceCreated(holder)
            Timber.d("onSurfaceCreated")
            // Paint a labelled loading frame on the FRESH surface immediately,
            // before the draw loop is asked to resume. If the loop resumes it
            // overwrites this within ~33ms; if it does NOT (the persistent-black
            // bug) the user sees "Loading… (surface)" instead of raw black, and
            // the label tells us the surface WAS recreated but the loop stalled.
            paintLoadingMarker("surface", holder)
            // Surface is back (e.g. returning from an app-switch). The framework
            // has already pointed `surfaceHolder` at the new surface. Resume
            // rendering if visible — restart any poller that went inactive and
            // redraw. Engine-lifetime resources were preserved by
            // onSurfaceDestroyed, so this recovers without a process restart.
            // (card_f9b2cc2d)
            lifecycle.onSurfaceCreated()
            kickDrawLoop("surfaceCreated")
        }

        override fun onSurfaceChanged(holder: SurfaceHolder?, format: Int, width: Int, height: Int) {
            super.onSurfaceChanged(holder, format, width, height)
            Timber.d("onSurfaceChanged ${width}x$height")
            paintLoadingMarker("changed", holder)
            // Geometry/format change (rotation, etc.). Treat like a recreate for
            // resume purposes so the very next frame repaints onto the new
            // surface. (card_f9b2cc2d)
            lifecycle.onSurfaceChanged()
            kickDrawLoop("surfaceChanged")
        }

        override fun onSurfaceDestroyed(holder: SurfaceHolder?) {
            super.onSurfaceDestroyed(holder)
            // PAUSE ONLY. card_f9b2cc2d: an app-switch destroys then recreates
            // the surface. Tearing down engine-lifetime resources here (the old
            // bug) permanently cancelled engineScope so every later
            // engineScope.launch{} was a no-op and draw() used a released
            // renderer → black until a full process restart. We now only stop
            // the draw loop and mark not-visible; engineScope / renderer /
            // companionRepository survive for the next onSurfaceCreated.
            //
            // RESIDUAL black (card_f9b2cc2d, still reported after the engineScope
            // fix): this used to also do `visible = false`. A BRIEF app-switch
            // destroys→recreates the surface with NO onVisibilityChanged toggle,
            // so that spurious visible=false was never restored — the next
            // onSurfaceCreated's resume + the draw-loop reschedule (both gated on
            // `visible`) never ran → permanent black until a process restart,
            // exactly matching "even the loading-entities text never appears".
            // Visibility is owned SOLELY by onVisibilityChanged; do NOT clear it
            // here. The loop is halted by stopDrawLoop() (lifecycle hook) and is
            // additionally gated on lifecycle.surfacePresent so it cannot spin
            // while the surface is gone.
            lifecycle.onSurfaceDestroyed()
            Timber.d("onSurfaceDestroyed (paused, engine-lifetime preserved)")
        }

        override fun onDestroy() {
            // The ONE place engine-lifetime resources are torn down. Reached when
            // the Engine itself is being destroyed (wallpaper deselected /
            // service stopped), not on a transient surface destroy. (card_f9b2cc2d)
            // Invalidate any in-flight resume-watchdog burst so its pending
            // posted lambdas become no-ops instead of firing against a dead engine.
            resumeWatchdogToken++
            handler.removeCallbacks(healthHeartbeat)
            cancelPendingLongPress()
            lifecycle.onEngineDestroy()
            Timber.d("ClawEngine onDestroy — engine-lifetime resources released")
            super.onDestroy()
        }

        private var drawCount = 0
        private var drawFailureCount = 0
        private var lastGoodFrameMs = 0L

        // card_f9b2cc2d self-healing heartbeat. The strongest reproduction of the
        // black screen ("pure black, no marker text, only a full app restart
        // recovers") is consistent with the 33ms draw loop having stopped while
        // the wallpaper is actually on-screen, with NO lifecycle callback
        // (onVisibilityChanged/onSurfaceCreated) arriving to restart it. Neither
        // the resume watchdog (callback-triggered) nor the surfacePresent flag can
        // recover that. This heartbeat runs for the engine's whole lifetime,
        // independent of any callback and of the cached `visible` flag: every ~1s
        // it consults the framework's authoritative isVisible and, if we should be
        // showing and the surface is drawable but no frame has been posted for
        // ~1s, it kicks draw() — which restarts the self-sustaining loop. Cost is
        // one no-op handler tick/sec while healthy (the loop keeps lastGoodFrameMs
        // fresh, so the kick only fires when the loop is genuinely dead).
        private val healthHeartbeat = object : Runnable {
            override fun run() {
                try {
                    val showing = try { isVisible } catch (e: Exception) { visible }
                    if (showing && surfaceValid() &&
                        android.os.SystemClock.uptimeMillis() - lastGoodFrameMs > 1000L) {
                        Timber.w("healthHeartbeat: stale frame, kicking draw loop")
                        draw()
                    }
                } catch (e: Exception) {
                    Timber.e(e, "healthHeartbeat error")
                } finally {
                    if (lifecycle.engineAlive) handler.postDelayed(this, 1000L)
                }
            }
        }

        private fun draw() {
            val holder = surfaceHolder
            var canvas: Canvas? = null
            drawCount++
            if (drawCount <= 5 || drawCount % 100 == 0) {
            }

            try {
                canvas = holder.lockCanvas()
                if (canvas != null) {
                    if (drawCount <= 3) {
                    }
                    if (multiEntityMode) {
                        renderer.drawMultiEntity(
                            canvas,
                            currentEntities,
                            loading = !hasFirstResponse,
                            usageSnapshot = currentUsageSnapshot,
                            kanbanCards = currentKanbanCards
                        )
                    } else {
                        renderer.draw(canvas, currentStatus)
                    }
                } else if (drawCount <= 5) {
                }
            } catch (e: Throwable) {
                // card_f9b2cc2d ROOT-CAUSE CAPTURE + visible fallback. catch THROWABLE
                // (not just Exception) so a render-thread OutOfMemoryError [BLK-RENDER]
                // (an Error) also paints the visible error frame below instead of
                // escaping to the process-killing uncaught handler → pure black.
                // The reported "pure black, no text" on resume is consistent with
                // drawMultiEntity drawing the black background and then THROWING
                // while rendering entities (e.g. a recycled/released bitmap after
                // an app-switch). The old code only Timber.e'd and the `finally`
                // posted the half-drawn black canvas — silent black every 33ms,
                // overwriting the loading markers, until a process restart. Now:
                // (1) record the real exception to Crashlytics so the exact stack
                // is captured in the field, and (2) overpaint a DISTINCT, visible
                // error frame so the user never sees silent black and can report
                // what they see.
                drawFailureCount++
                Timber.e(e, "Error during drawing (failure #$drawFailureCount)")
                if (drawFailureCount <= 3 || drawFailureCount % 100 == 0) {
                    try {
                        com.google.firebase.crashlytics.FirebaseCrashlytics.getInstance().apply {
                            setCustomKey("draw_failure_count", drawFailureCount)
                            setCustomKey("entities", currentEntities.size)
                            setCustomKey("hasFirstResponse", hasFirstResponse)
                            setCustomKey("surfaceValid", surfaceValid())
                            recordException(e)
                        }
                    } catch (ce: Exception) { Timber.e(ce, "crashlytics draw report failed") }
                }
                try {
                    canvas?.let { c ->
                        c.drawColor(0xFF2A0E0E.toInt()) // distinct dark red = render error (NOT black)
                        c.drawText(
                            this@ClawWallpaperService.getString(R.string.claw_wallpaper_render_error),
                            c.width / 2f, c.height / 2f, loadingPaint
                        )
                    }
                } catch (fe: Exception) { Timber.e(fe, "error-frame paint failed") }
            } finally {
                if (canvas != null) {
                    try {
                        holder.unlockCanvasAndPost(canvas)
                        // Record a successful posted frame so the self-healing
                        // heartbeat can tell a live loop from a dead one. (card_f9b2cc2d)
                        lastGoodFrameMs = android.os.SystemClock.uptimeMillis()
                    } catch (e: Exception) {
                        Timber.e(e, "Error unlocking canvas")
                    }
                }
            }

            handler.removeCallbacks(drawRunnable)
            // Loop only while shown AND the REAL surface is valid. card_f9b2cc2d
            // residual-black root cause: the gate used to read the
            // `lifecycle.surfacePresent` FLAG, which is only set true by
            // onSurfaceCreated/Changed. On a brief app-switch the framework can
            // deliver onVisibilityChanged(true) WITHOUT a paired
            // onSurfaceCreated (surface re-validated late, or the callback never
            // re-fires), leaving the flag stuck false → the loop never
            // rescheduled → permanent black until a process kill. Gating on the
            // authoritative surfaceHolder.surface.isValid makes the loop
            // self-heal: it runs whenever we are visible and the surface is
            // actually drawable, regardless of which lifecycle callback fired.
            if (visible && surfaceValid()) {
                handler.postDelayed(drawRunnable, 33)
            }
        }
    }
}
