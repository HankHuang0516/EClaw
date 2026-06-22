package com.hank.clawlive.service

import android.graphics.Canvas
import android.os.Handler
import android.os.Looper
import android.service.wallpaper.WallpaperService
import android.view.SurfaceHolder
import timber.log.Timber
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
            // Delegate to the lifecycle controller. When shown it restarts any
            // poller that was cancelled while hidden (card_a7baa3b0b1151099d4523428
            // close-out) and redraws. When hidden it stops the draw loop and
            // cancels all pollers — the quota gate that prevents the /api/status
            // 429 storm. Engine-lifetime resources are untouched either way.
            lifecycle.onVisibilityChanged(visible)
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
            // Surface is back (e.g. returning from an app-switch). The framework
            // has already pointed `surfaceHolder` at the new surface. Resume
            // rendering if visible — restart any poller that went inactive and
            // redraw. Engine-lifetime resources were preserved by
            // onSurfaceDestroyed, so this recovers without a process restart.
            // (card_f9b2cc2d)
            lifecycle.onSurfaceCreated()
        }

        override fun onSurfaceChanged(holder: SurfaceHolder?, format: Int, width: Int, height: Int) {
            super.onSurfaceChanged(holder, format, width, height)
            Timber.d("onSurfaceChanged ${width}x$height")
            // Geometry/format change (rotation, etc.). Treat like a recreate for
            // resume purposes so the very next frame repaints onto the new
            // surface. (card_f9b2cc2d)
            lifecycle.onSurfaceChanged()
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
            lifecycle.onEngineDestroy()
            Timber.d("ClawEngine onDestroy — engine-lifetime resources released")
            super.onDestroy()
        }

        private var drawCount = 0
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
            } catch (e: Exception) {
                Timber.e(e, "Error during drawing")
            } finally {
                if (canvas != null) {
                    try {
                        holder.unlockCanvasAndPost(canvas)
                    } catch (e: Exception) {
                        Timber.e(e, "Error unlocking canvas")
                    }
                }
            }

            handler.removeCallbacks(drawRunnable)
            // Loop only while shown AND a surface is present. The surfacePresent
            // gate stops a 30fps no-op draw spin between a surface destroy and
            // recreate now that onSurfaceDestroyed no longer clears `visible`
            // (card_f9b2cc2d residual fix).
            if (visible && lifecycle.surfacePresent) {
                handler.postDelayed(drawRunnable, 33)
            }
        }
    }
}
