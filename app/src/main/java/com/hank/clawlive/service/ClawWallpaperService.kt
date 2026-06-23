package com.hank.clawlive.service

import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
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
        private val renderer = ClawRenderer(this@ClawWallpaperService, companionRepository)
        private val repository = com.hank.clawlive.data.repository.StateRepository(
            com.hank.clawlive.data.remote.NetworkModule.api,
            this@ClawWallpaperService
        )

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

        // ─────────────────────────────────────────────────────────────────────
        // card_f22e489c / card_f9b2cc2d — THE NEVER-BLACK FLOOR.
        //
        // Owner-mandated structural guarantee (v1.1.9): "even if it black-screens,
        // '桌布加載中…' must appear." Every prior fix chased a specific crash/return
        // path; the wallpaper STILL went pure black because *some* non-crash path
        // (null lockCanvas, a stalled loop, a missed callback, a half-drawn black
        // frame) left the last surface black. This floor removes the entire class
        // of failures by CONSTRUCTION: every posted frame ALWAYS starts as a navy
        // "loading" baseline (visible text + an animated arc + a [BLK-XXX] tag),
        // and the real content is only ever an OVERLAY on top. If content is not
        // ready, or throws, or the loop stalls, the loading baseline is what the
        // surface keeps showing — never raw black.
        // ─────────────────────────────────────────────────────────────────────

        // Deliberate navy surface used by the floor — reads as "loading", not crash.
        private val floorBg = 0xFF0B1220.toInt()

        private val floorTextPaint = Paint().apply {
            color = Color.WHITE
            textAlign = Paint.Align.CENTER
            isAntiAlias = true
            textSize = 44f
        }

        // Animated spinner arc — its sweep phase is driven by SystemClock so it
        // visibly rotates every frame even when no content is drawing, proving the
        // surface is live (not a frozen black screen).
        private val floorArcPaint = Paint().apply {
            color = 0xFF22D3EE.toInt() // cyan accent, matches the in-app health ring
            style = Paint.Style.STROKE
            strokeWidth = 6f
            strokeCap = Paint.Cap.ROUND
            isAntiAlias = true
        }

        // Small, low-opacity bottom-corner diagnostic tag (BLK-LOAD / BLK-RENDER /
        // BLK-SURFACE) so any future near-black state is self-identifying on screen.
        private val floorTagPaint = Paint().apply {
            color = Color.WHITE
            alpha = 90
            textAlign = Paint.Align.RIGHT
            isAntiAlias = true
            textSize = 24f
        }

        private val floorArcRect = RectF()

        /**
         * Paint the always-on loading baseline onto an ALREADY-LOCKED canvas:
         * navy fill, centered localized "桌布加載中…" text, an animated cyan arc
         * spinner, and a small [BLK-XXX] diagnostic tag. This is the floor every
         * frame is built on; content (if any) is overlaid afterwards. Never throws
         * out (best-effort; any sub-step is individually guarded) so it can be the
         * last line of defence.
         *
         * @param tag the on-screen diagnostic code: BLK-LOAD (normal loading),
         *   BLK-RENDER (caught content error), BLK-SURFACE (canvas re-acquire
         *   retries), etc.
         */
        private fun paintLoadingFloor(canvas: Canvas, tag: String) {
            try { canvas.drawColor(floorBg) } catch (_: Throwable) {}
            val cx = canvas.width / 2f
            val cy = canvas.height / 2f
            try {
                val label = this@ClawWallpaperService.getString(R.string.claw_renderer_loading_wallpaper)
                canvas.drawText(label, cx, cy, floorTextPaint)
            } catch (_: Throwable) {}
            // Animated arc above the text. Phase from SystemClock → visibly spins.
            try {
                val r = (minOf(canvas.width, canvas.height) * 0.10f).coerceIn(40f, 160f)
                val top = cy - r - 90f
                floorArcRect.set(cx - r, top - r, cx + r, top + r)
                val startAngle = (SystemClock.uptimeMillis() / 3L % 360L).toFloat()
                canvas.drawArc(floorArcRect, startAngle, 270f, false, floorArcPaint)
            } catch (_: Throwable) {}
            // Bottom-right diagnostic tag.
            try {
                canvas.drawText(tag, canvas.width - 18f, canvas.height - 18f, floorTagPaint)
            } catch (_: Throwable) {}
        }

        /**
         * Lock the surface with a bounded retry burst instead of bailing on the
         * first null. card_f22e489c: the classic "black + NO text" signature is
         * `lockCanvas() ?: return` silently giving up — the surface keeps its last
         * (black) contents and nothing repaints. We re-read the holder and retry a
         * few times with tiny sleeps; if every attempt is null we record it and let
         * the caller reschedule the next frame (we NEVER permanently stop).
         * Returns the locked Canvas or null after exhausting retries.
         */
        private fun lockCanvasWithRetry(holder: SurfaceHolder?, where: String): Pair<Canvas, SurfaceHolder>? {
            var attempt = 0
            while (attempt < 4) {
                val h = holder ?: surfaceHolder
                if (h != null) {
                    val c = try { h.lockCanvas() } catch (e: Throwable) {
                        Timber.e(e, "lockCanvas threw ($where) attempt=$attempt"); null
                    }
                    if (c != null) return c to h
                }
                attempt++
                if (attempt < 4) { try { Thread.sleep(8L) } catch (_: InterruptedException) {} }
            }
            // All retries null — record [BLK-SURFACE] but DO NOT stop the loop.
            val msg = "lockCanvas null after retries ($where) surfaceValid=${surfaceValid()}"
            Timber.e(msg)
            try {
                com.google.firebase.crashlytics.FirebaseCrashlytics.getInstance()
                    .recordException(IllegalStateException("BLK-SURFACE: $msg"))
            } catch (_: Exception) {}
            return null
        }

        /**
         * Lock the surface and paint ONE loading-floor frame immediately,
         * bypassing the draw loop. Safe to call from any lifecycle callback —
         * if the real draw loop then runs it simply overlays content; if it does
         * NOT (the bug), this navy "桌布加載中…" floor stays on screen instead of
         * black. `where` becomes a BLK-XXX-style tag on screen.
         */
        private fun paintLoadingMarker(where: String, holder: SurfaceHolder? = surfaceHolder) {
            val locked = lockCanvasWithRetry(holder, where) ?: return
            val (canvas, h) = locked
            try {
                paintLoadingFloor(canvas, "BLK-LOAD/$where")
            } catch (e: Throwable) {
                Timber.e(e, "paintLoadingMarker($where) failed")
            } finally {
                try {
                    h.unlockCanvasAndPost(canvas)
                    lastGoodFrameMs = SystemClock.uptimeMillis()
                } catch (e: Exception) { Timber.e(e, "marker unlock failed") }
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
            // Start the lifetime self-healing heartbeat (card_f9b2cc2d / card_f22e489c).
            handler.postDelayed(healthHeartbeat, HEARTBEAT_INTERVAL_MS)
        }

        // Tracks which entityIds already have a companion-poller flow running so
        // we don't spawn duplicate jobs each time getMultiEntityStatusFlow emits.
        private val companionJobs = mutableMapOf<Int, kotlinx.coroutines.Job>()

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
            if (event?.action == android.view.MotionEvent.ACTION_UP) {
                // Only wake up if there are bound entities
                if (multiEntityMode) {
                    if (currentEntities.isEmpty()) {
                        // No entities connected, do nothing
                        super.onTouchEvent(event)
                        return
                    }
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
            super.onTouchEvent(event)
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
                    val staleMs = SystemClock.uptimeMillis() - lastGoodFrameMs
                    if (showing && staleMs > STALE_FRAME_MS) {
                        // card_f22e489c WATCHDOG / SELF-HEAL. No frame has been
                        // posted for > ~2s while we should be showing — the loop is
                        // stuck or the render thread is dead. Force a re-kick: paint
                        // the loading floor SYNCHRONOUSLY first (so the user sees
                        // "桌布加載中…" instead of black even if draw() can't run),
                        // then restart the frame scheduler. If the surface is not
                        // currently drawable, run the bounded resume burst which
                        // re-acquires it and repaints once it is valid.
                        Timber.w("healthHeartbeat: stale ${staleMs}ms, force re-kick")
                        if (surfaceValid()) {
                            paintLoadingMarker("heartbeat")
                            handler.removeCallbacks(drawRunnable)
                            draw()
                        } else {
                            kickDrawLoop("heartbeat")
                        }
                    }
                } catch (e: Exception) {
                    Timber.e(e, "healthHeartbeat error")
                } finally {
                    if (lifecycle.engineAlive) handler.postDelayed(this, HEARTBEAT_INTERVAL_MS)
                }
            }
        }

        private fun draw() {
            drawCount++

            // card_f22e489c NEVER-BLACK FLOOR. Acquire the canvas with a bounded
            // retry instead of `lockCanvas() ?: return` (that silent bail is the
            // exact "black + no text" signature — the surface keeps its last black
            // contents and the loop's reschedule below is the only thing that lets
            // it recover). If we still can't get a canvas after retries, we don't
            // post a frame THIS tick, but we still reschedule at the bottom so the
            // next tick tries again — the loop is never permanently stopped.
            val locked = lockCanvasWithRetry(surfaceHolder, "draw")
            if (locked == null) {
                handler.removeCallbacks(drawRunnable)
                if (visible && surfaceValid()) handler.postDelayed(drawRunnable, FRAME_INTERVAL_MS)
                return
            }
            val (canvas, holder) = locked

            // STEP 1 — ALWAYS-PAINT BASELINE. Every single frame starts as the
            // navy "桌布加載中…" loading floor (text + animated arc + [BLK-XXX] tag).
            // Whatever happens to the content overlay below, this is already on the
            // canvas, so the posted frame can never be raw black.
            paintLoadingFloor(canvas, "BLK-LOAD")

            // STEP 2 — overlay the real content ON TOP of the floor, fully guarded.
            // Throwable (not just Exception) so a render-thread OutOfMemoryError
            // also lands here instead of escaping to the process-killing uncaught
            // handler. On any throw we leave the loading floor visible and stamp a
            // BLK-RENDER tag so a content failure shows "loading + code", never
            // black, and is self-identifying on screen.
            try {
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
            } catch (e: Throwable) {
                drawFailureCount++
                Timber.e(e, "Error during content overlay (failure #$drawFailureCount)")
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
                // Re-establish the loading floor (the partial content may have
                // dirtied it) with the render-error code + the localized banner.
                try {
                    paintLoadingFloor(canvas, "BLK-RENDER")
                    canvas.drawText(
                        this@ClawWallpaperService.getString(R.string.claw_wallpaper_render_error),
                        canvas.width / 2f, canvas.height / 2f + 64f, floorTagPaint
                    )
                } catch (fe: Throwable) { Timber.e(fe, "error-frame floor repaint failed") }
            } finally {
                try {
                    holder.unlockCanvasAndPost(canvas)
                    // Record a successful posted frame so the self-healing
                    // heartbeat can tell a live loop from a dead one.
                    lastGoodFrameMs = SystemClock.uptimeMillis()
                } catch (e: Exception) {
                    Timber.e(e, "Error unlocking canvas")
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
                handler.postDelayed(drawRunnable, FRAME_INTERVAL_MS)
            }
        }
    }

    private companion object {
        // ~30fps draw loop.
        const val FRAME_INTERVAL_MS = 33L
        // Self-healing heartbeat tick.
        const val HEARTBEAT_INTERVAL_MS = 1000L
        // card_f22e489c: force a re-kick if no frame posted for > ~2s while visible.
        const val STALE_FRAME_MS = 2000L
    }
}
