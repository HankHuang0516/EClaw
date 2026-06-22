package com.hank.clawlive.engine

/**
 * Pure-JVM lifecycle decision logic for [com.hank.clawlive.service.ClawWallpaperService.ClawEngine].
 *
 * Bug card_f9b2cc2d: the live wallpaper went ENTIRELY BLACK after a brief
 * app-switch and only recovered on a full process restart. Root cause: the
 * Engine treated `onSurfaceDestroyed` as engine teardown — it cancelled the
 * engine-lifetime `engineScope` (a SupervisorJob), released the renderer and
 * the companion repository. A surface destroy→recreate cycle is *exactly* what
 * an app-switch causes, so after one cycle the scope was permanently cancelled:
 * every `engineScope.launch{}` became a no-op and `draw()` used a released
 * renderer → black. Only killing the process reconstructed the Engine.
 *
 * The correct Android WallpaperService.Engine contract:
 *   - onSurfaceDestroyed  → PAUSE rendering only (stop the draw loop). The
 *     surface can come back; engine-lifetime objects must survive.
 *   - onSurfaceCreated/Changed → resume: restart any poller that is inactive
 *     and redraw, exactly like onVisibilityChanged(true) already does.
 *   - onDestroy (Engine)  → the *only* place engine-lifetime resources
 *     (engineScope, renderer, companionRepository, companion jobs) are torn
 *     down.
 *
 * This controller isolates those decisions so they are unit-testable on the
 * JVM without an Android emulator. The Engine owns the actual coroutine scope,
 * renderer and repository; it delegates the *decision* of whether the scope is
 * still alive (and whether teardown has happened) to this class, and runs the
 * real side-effects through the supplied [Hooks].
 *
 * `engineAlive` is the central invariant the bug fix protects: it must remain
 * true across any number of surface destroy/create cycles and only flip false
 * once [onEngineDestroy] runs.
 */
class EngineLifecycleController(private val hooks: Hooks) {

    /**
     * Side-effects the Engine wires into real coroutine / renderer operations.
     * Kept as a tiny interface so tests can substitute a fake recorder.
     */
    interface Hooks {
        /** Stop the periodic draw loop (handler.removeCallbacks). */
        fun stopDrawLoop()
        /** Restart any poller whose job is not currently active, then draw once. */
        fun restartInactivePollersAndDraw()
        /** Cancel ALL pollers (status/usage/kanban/companion) — quota gate. */
        fun cancelAllPollers()
        /** Real engine-lifetime teardown: cancel scope, release renderer + repo. */
        fun releaseEngineResources()
    }

    /** True until [onEngineDestroy]. The bug was this flipping false on surface destroy. */
    var engineAlive: Boolean = true
        private set

    /** Mirrors the Engine's `visible` flag; resume only redraws when visible. */
    var visible: Boolean = false
        private set

    /** True between a surface being created and destroyed. */
    var surfacePresent: Boolean = false
        private set

    /** Engine.onCreate → pollers are started by the Engine; nothing to tear down yet. */
    fun onEngineCreate() {
        engineAlive = true
    }

    /**
     * Engine.onVisibilityChanged. Resume (restart inactive pollers + draw) when
     * shown; gate off pollers when hidden to avoid the 429 storm that
     * card_a7baa3b0b1151099d4523428 fixed. Does NOT touch engine-lifetime state.
     */
    fun onVisibilityChanged(visible: Boolean) {
        this.visible = visible
        if (visible) {
            hooks.restartInactivePollersAndDraw()
        } else {
            hooks.stopDrawLoop()
            hooks.cancelAllPollers()
        }
    }

    /** Surface (re)created. Resume rendering if visible. Engine-lifetime intact. */
    fun onSurfaceCreated() {
        surfacePresent = true
        if (visible) {
            hooks.restartInactivePollersAndDraw()
        }
    }

    /** Surface geometry changed. Treat like a (re)create for resume purposes. */
    fun onSurfaceChanged() {
        surfacePresent = true
        if (visible) {
            hooks.restartInactivePollersAndDraw()
        }
    }

    /**
     * Surface destroyed. PAUSE ONLY: stop the draw loop and mark not-visible.
     * Crucially does NOT cancel the engine scope or release the renderer —
     * those survive so the next [onSurfaceCreated] can resume. This is the core
     * card_f9b2cc2d fix.
     */
    fun onSurfaceDestroyed() {
        surfacePresent = false
        // Do NOT clear `visible` here — visibility is owned exclusively by
        // onVisibilityChanged. A *brief* app-switch can destroy→recreate the
        // surface with NO visibility toggle (the system never sends
        // onVisibilityChanged(false)/(true)). If we cleared `visible`, the
        // following onSurfaceCreated would skip its draw (visible==false) and
        // nothing would ever repaint until a full process restart — the residual
        // black screen card_f9b2cc2d users still hit after the engineScope fix.
        hooks.stopDrawLoop()
        // engineAlive stays true. No releaseEngineResources() here.
    }

    /**
     * Engine.onDestroy — the real teardown point. Idempotent: a second call is
     * a no-op so a destroy after a surface-destroy can't double-release.
     */
    fun onEngineDestroy() {
        if (!engineAlive) return
        engineAlive = false
        hooks.stopDrawLoop()
        hooks.cancelAllPollers()
        hooks.releaseEngineResources()
    }
}
