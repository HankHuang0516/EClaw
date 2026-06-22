package com.hank.clawlive

import com.hank.clawlive.engine.EngineLifecycleController
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pure-JVM regression tests for card_f9b2cc2d — live wallpaper goes BLACK after
 * an app-switch and only recovers on a full process restart.
 *
 * The bug was that the Engine released engine-lifetime resources (the
 * SupervisorJob scope, renderer, companion repository) inside
 * onSurfaceDestroyed. An app-switch destroys then recreates the surface, so the
 * scope was permanently cancelled and every subsequent poller launch was a
 * no-op with a released renderer → black.
 *
 * These tests assert on the lifecycle decisions:
 *  - a surface destroy/recreate cycle keeps the engine "alive" (no teardown)
 *    and resumes rendering;
 *  - only Engine.onDestroy performs the real teardown.
 *
 * NOTE: this exercises the lifecycle decision logic, not the real Android
 * Engine. The actual black→recover behaviour is build-gated and must be
 * confirmed on an emulator/device.
 */
class EngineLifecycleControllerTest {

    /** Records which hook side-effects fired, in order. */
    private class RecordingHooks : EngineLifecycleController.Hooks {
        var stopDrawLoopCount = 0
        var restartCount = 0
        var cancelAllPollersCount = 0
        var releaseCount = 0

        override fun stopDrawLoop() { stopDrawLoopCount++ }
        override fun restartInactivePollersAndDraw() { restartCount++ }
        override fun cancelAllPollers() { cancelAllPollersCount++ }
        override fun releaseEngineResources() { releaseCount++ }
    }

    private fun controller(hooks: RecordingHooks = RecordingHooks()) =
        EngineLifecycleController(hooks) to hooks

    @Test
    fun surfaceDestroyDoesNotReleaseEngineResources() {
        val (c, hooks) = controller()
        c.onEngineCreate()
        c.onSurfaceCreated()
        c.onVisibilityChanged(true)

        c.onSurfaceDestroyed()

        // The core fix: a surface destroy must NOT tear down engine-lifetime
        // resources. The engine stays alive so it can resume.
        assertTrue("engine must stay alive across a surface destroy", c.engineAlive)
        assertEquals("no engine-lifetime release on surface destroy", 0, hooks.releaseCount)
        assertEquals("no poller cancel on surface destroy (visibility gate already did it)",
            0, hooks.cancelAllPollersCount)
    }

    @Test
    fun appSwitchCycleResumesWithoutTeardown() {
        // Simulate exactly what an app-switch does: visible → hidden,
        // surface destroyed, then surface recreated and visible again.
        val (c, hooks) = controller()
        c.onEngineCreate()
        c.onSurfaceCreated()
        c.onVisibilityChanged(true)
        val restartsAfterShow = hooks.restartCount

        // Leaving the app.
        c.onVisibilityChanged(false)   // quota gate: cancel pollers
        c.onSurfaceDestroyed()         // PAUSE only

        assertTrue("engine alive after leaving app", c.engineAlive)
        assertEquals("released while still alive — regression!", 0, hooks.releaseCount)

        // Returning to the app.
        c.onSurfaceCreated()
        c.onVisibilityChanged(true)

        assertTrue("engine still alive after returning", c.engineAlive)
        assertEquals("must not release across the whole app-switch cycle", 0, hooks.releaseCount)
        assertTrue("must restart pollers + redraw on resume",
            hooks.restartCount > restartsAfterShow)
    }

    @Test
    fun manyDestroyCreateCyclesKeepEngineAlive() {
        val (c, hooks) = controller()
        c.onEngineCreate()
        c.onVisibilityChanged(true)

        repeat(20) {
            c.onSurfaceDestroyed()
            c.onSurfaceCreated()
        }

        assertTrue("engine survives many surface cycles", c.engineAlive)
        assertEquals("never released across 20 cycles", 0, hooks.releaseCount)
    }

    @Test
    fun engineDestroyPerformsRealTeardownExactlyOnce() {
        val (c, hooks) = controller()
        c.onEngineCreate()
        c.onSurfaceCreated()
        c.onVisibilityChanged(true)
        c.onSurfaceDestroyed()

        c.onEngineDestroy()

        assertFalse("engine no longer alive after onDestroy", c.engineAlive)
        assertEquals("teardown releases engine-lifetime resources once", 1, hooks.releaseCount)
        assertEquals("teardown cancels pollers", 1, hooks.cancelAllPollersCount)

        // Idempotent: a second destroy must not double-release.
        c.onEngineDestroy()
        assertEquals("onDestroy is idempotent — no double release", 1, hooks.releaseCount)
    }

    @Test
    fun hiddenVisibilityGatesPollersButKeepsEngineAlive() {
        // The 429-storm quota gate (card_a7baa3b0b1151099d4523428) must remain:
        // hiding cancels pollers, but never tears down the engine.
        val (c, hooks) = controller()
        c.onEngineCreate()
        c.onVisibilityChanged(true)

        c.onVisibilityChanged(false)

        assertEquals("hiding cancels pollers (quota gate preserved)", 1, hooks.cancelAllPollersCount)
        assertEquals("hiding stops the draw loop", 1, hooks.stopDrawLoopCount)
        assertTrue("hiding never tears down the engine", c.engineAlive)
        assertEquals("hiding never releases engine resources", 0, hooks.releaseCount)
    }

    @Test
    fun surfaceCreatedWhileHiddenDoesNotRedraw() {
        // If the surface comes back while not visible, we should not start
        // drawing/polling yet — onVisibilityChanged(true) drives that.
        val (c, hooks) = controller()
        c.onEngineCreate()

        c.onSurfaceCreated() // visible is still false

        assertEquals("no resume while hidden", 0, hooks.restartCount)
        assertTrue(c.surfacePresent)
        assertTrue(c.engineAlive)
    }
}
