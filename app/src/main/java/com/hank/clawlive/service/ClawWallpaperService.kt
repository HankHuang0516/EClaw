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
        private val renderer = ClawRenderer(this@ClawWallpaperService)
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

        private val drawRunnable = Runnable { draw() }

        override fun onCreate(surfaceHolder: SurfaceHolder?) {
            super.onCreate(surfaceHolder)
            Timber.d("ClawEngine onCreate")
            setTouchEventsEnabled(true)
            observeStatus()
        }

        private fun observeStatus() {
            engineScope.launch {
                if (multiEntityMode) {
                    // Multi-entity mode: fetch all entities
                    repository.getMultiEntityStatusFlow(intervalMs = 5000)
                        .collect { response ->
                            Timber.d("Multi-entity status: ${response.activeCount} entities")
                            // Debug: log first entity's name
                            response.entities.firstOrNull()?.let { e ->
                                Timber.d("First entity: id=${e.entityId}, name=${e.name}, state=${e.state}")
                            }
                            currentEntities = response.entities
                            if (visible) draw()
                        }
                } else {
                    // Single entity mode (backward compatible)
                    repository.getStatusFlow(intervalMs = 5000)
                        .collect { newStatus ->
                            Timber.d("Single status: ${newStatus.state}")
                            currentStatus = newStatus
                            if (visible) draw()
                        }
                }
            }
        }

        override fun onVisibilityChanged(visible: Boolean) {
            this.visible = visible
            Timber.d("onVisibilityChanged: $visible")
            if (visible) {
                draw()
            } else {
                handler.removeCallbacks(drawRunnable)
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
            engineScope.cancel()
            renderer.release()
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
                        renderer.drawMultiEntity(canvas, currentEntities)
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
