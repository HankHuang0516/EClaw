package com.hank.clawlive.service

import android.graphics.Canvas
import android.os.Handler
import android.os.Looper
import android.service.wallpaper.WallpaperService
import android.view.SurfaceHolder
import timber.log.Timber
import com.hank.clawlive.engine.ClawRenderer
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

        override fun onCreate(surfaceHolder: SurfaceHolder?) {
            super.onCreate(surfaceHolder)
            Timber.d("ClawEngine onCreate")
            setTouchEventsEnabled(true)
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
            if (visible) {
                // Restart pollers if they were cancelled while hidden. Without
                // this, the wallpaper would only repaint stale state until the
                // user re-enters the live wallpaper preview. Bug
                // card_a7baa3b0b1151099d4523428 close-out.
                if (statusJob?.isActive != true) observeStatus()
                if (usageJob?.isActive != true) observeUsage()
                if (kanbanJob?.isActive != true) observeKanban()
                draw()
            } else {
                // Stop hitting /api/status while the wallpaper isn't on
                // screen (screen off, app covering, dock visible). Without
                // this gate the service kept polling every 5s indefinitely,
                // saturating CF rate-limits → 429 storms. The companion
                // jobs are tied to the same lifecycle.
                handler.removeCallbacks(drawRunnable)
                cancelAllPollers()
            }
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

        override fun onSurfaceDestroyed(holder: SurfaceHolder?) {
            super.onSurfaceDestroyed(holder)
            visible = false
            handler.removeCallbacks(drawRunnable)
            companionJobs.values.forEach { it.cancel() }
            companionJobs.clear()
            engineScope.cancel()
            renderer.release()
            companionRepository.release()
            Timber.d("onSurfaceDestroyed")
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
            if (visible) {
                handler.postDelayed(drawRunnable, 33)
            }
        }
    }
}
