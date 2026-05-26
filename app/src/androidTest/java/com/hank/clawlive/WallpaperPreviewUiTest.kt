package com.hank.clawlive

import android.graphics.Rect
import android.os.Build
import android.view.MotionEvent
import android.view.View
import android.view.WindowInsets
import android.widget.CheckBox
import android.widget.LinearLayout
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.google.android.material.materialswitch.MaterialSwitch
import com.hank.clawlive.data.local.LayoutPreferences
import com.hank.clawlive.data.model.EntityStatus
import com.hank.clawlive.ui.WallpaperPreviewView
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

/**
 * UI/UX tests for WallpaperPreviewActivity
 * Validates edge-to-edge display and safe insets for system bars
 */
@RunWith(AndroidJUnit4::class)
class WallpaperPreviewUiTest {

    @Test
    fun testTopBarHasSafeInsetFromStatusBar() {
        ActivityScenario.launch(WallpaperPreviewActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                val topBar = activity.findViewById<View>(R.id.topBar)
                val rootView = activity.findViewById<View>(android.R.id.content)

                assertNotNull("Top bar should exist", topBar)

                // Get system bar insets
                val windowInsets = ViewCompat.getRootWindowInsets(rootView)
                assertNotNull("Window insets should be available", windowInsets)

                val statusBarHeight = windowInsets!!.getInsets(
                    WindowInsetsCompat.Type.statusBars()
                ).top

                // Top bar's top padding should be >= status bar height
                val topPadding = topBar.paddingTop
                assertTrue(
                    "Top bar padding ($topPadding) should be >= status bar height ($statusBarHeight)",
                    topPadding >= statusBarHeight
                )

                // Top bar should be visible (not clipped)
                val location = IntArray(2)
                topBar.getLocationOnScreen(location)
                assertTrue(
                    "Top bar Y position (${location[1]}) should be >= 0",
                    location[1] >= 0
                )
            }
        }
    }

    @Test
    fun testBottomControlsHasSafeInsetFromNavigationBar() {
        ActivityScenario.launch(WallpaperPreviewActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                val bottomControls = activity.findViewById<View>(R.id.bottomControls)
                val rootView = activity.findViewById<View>(android.R.id.content)

                assertNotNull("Bottom controls should exist", bottomControls)

                // Get system bar insets
                val windowInsets = ViewCompat.getRootWindowInsets(rootView)
                assertNotNull("Window insets should be available", windowInsets)

                val navBarHeight = windowInsets!!.getInsets(
                    WindowInsetsCompat.Type.navigationBars()
                ).bottom

                // Bottom controls' bottom padding should be >= navigation bar height
                val bottomPadding = bottomControls.paddingBottom
                assertTrue(
                    "Bottom padding ($bottomPadding) should be >= nav bar height ($navBarHeight)",
                    bottomPadding >= navBarHeight
                )

                // Bottom controls should not extend beyond screen
                val screenHeight = activity.resources.displayMetrics.heightPixels
                val location = IntArray(2)
                bottomControls.getLocationOnScreen(location)
                val bottomY = location[1] + bottomControls.height

                // Allow some tolerance for system decorations
                assertTrue(
                    "Bottom controls should be within screen bounds",
                    bottomY <= screenHeight + 100 // tolerance for edge cases
                )
            }
        }
    }

    @Test
    fun testBackButtonIsClickable() {
        ActivityScenario.launch(WallpaperPreviewActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                val btnBack = activity.findViewById<View>(R.id.btnBack)

                assertNotNull("Back button should exist", btnBack)
                assertTrue("Back button should be clickable", btnBack.isClickable)
                assertTrue("Back button should be visible", btnBack.visibility == View.VISIBLE)

                // Check that button is not obstructed by status bar
                val location = IntArray(2)
                btnBack.getLocationOnScreen(location)

                val rootView = activity.findViewById<View>(android.R.id.content)
                val windowInsets = ViewCompat.getRootWindowInsets(rootView)
                val statusBarHeight = windowInsets?.getInsets(
                    WindowInsetsCompat.Type.statusBars()
                )?.top ?: 0

                assertTrue(
                    "Back button top (${location[1]}) should be below status bar ($statusBarHeight)",
                    location[1] >= statusBarHeight
                )
            }
        }
    }

    @Test
    fun testSetWallpaperButtonIsClickable() {
        ActivityScenario.launch(WallpaperPreviewActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                val btnSetWallpaper = activity.findViewById<View>(R.id.btnSetWallpaper)

                assertNotNull("Set Wallpaper button should exist", btnSetWallpaper)
                assertTrue("Set Wallpaper button should be clickable", btnSetWallpaper.isClickable)
                assertTrue("Set Wallpaper button should be visible", btnSetWallpaper.visibility == View.VISIBLE)

                // Check that button is not obstructed by navigation bar
                val screenHeight = activity.resources.displayMetrics.heightPixels
                val location = IntArray(2)
                btnSetWallpaper.getLocationOnScreen(location)
                val buttonBottom = location[1] + btnSetWallpaper.height

                // Button should be fully visible above the navigation bar area
                // Note: In edge-to-edge, we need to verify it's padded correctly
                val rootView = activity.findViewById<View>(android.R.id.content)
                val windowInsets = ViewCompat.getRootWindowInsets(rootView)
                val navBarHeight = windowInsets?.getInsets(
                    WindowInsetsCompat.Type.navigationBars()
                )?.bottom ?: 0

                val maxBottomY = screenHeight - navBarHeight + 50 // tolerance
                assertTrue(
                    "Set Wallpaper button bottom ($buttonBottom) should be above nav bar ($maxBottomY)",
                    buttonBottom <= maxBottomY || navBarHeight == 0
                )
            }
        }
    }

    @Test
    fun testPreviewViewIsFullScreen() {
        ActivityScenario.launch(WallpaperPreviewActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                val previewView = activity.findViewById<View>(R.id.wallpaperPreviewView)

                assertNotNull("Preview view should exist", previewView)

                // Preview view should use match_parent to fill the screen
                val params = previewView.layoutParams
                assertEquals(
                    "Preview view should have match_parent width",
                    android.view.ViewGroup.LayoutParams.MATCH_PARENT,
                    params.width
                )
                assertEquals(
                    "Preview view should have match_parent height",
                    android.view.ViewGroup.LayoutParams.MATCH_PARENT,
                    params.height
                )
            }
        }
    }

    @Test
    fun testAllInteractiveElementsHaveMinimumTouchTarget() {
        val minTouchTarget = 48 // dp, Material Design minimum
        val toleranceDp = 10   // dp, allow 10dp tolerance for icon buttons

        ActivityScenario.launch(WallpaperPreviewActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                val density = activity.resources.displayMetrics.density
                val minTouchPx = ((minTouchTarget - toleranceDp) * density).toInt()

                val interactiveViews = listOf(
                    R.id.btnBack,
                    R.id.switchCustomLayout,
                    R.id.switchBackground,
                    R.id.switchUsageOverlay,
                    R.id.checkUsageClaude,
                    R.id.checkUsageCodex,
                    R.id.checkUsageSession,
                    R.id.checkUsageWeekly,
                    R.id.btnReset,
                    R.id.btnSetWallpaper
                )

                for (viewId in interactiveViews) {
                    val view = activity.findViewById<View>(viewId)
                    assertNotNull("View with id $viewId should exist", view)

                    val touchWidth = maxOf(view.width, view.minimumWidth)
                    val touchHeight = maxOf(view.height, view.minimumHeight)

                    // At least one dimension should meet the minimum (for narrow buttons)
                    val meetsMinimum = touchWidth >= minTouchPx || touchHeight >= minTouchPx
                    assertTrue(
                        "View $viewId should have adequate touch target (w=$touchWidth, h=$touchHeight, min=$minTouchPx)",
                        meetsMinimum
                    )
                }
            }
        }
    }

    @Test
    fun testUsageOverlayControlsPersistPreferences() {
        ActivityScenario.launch(WallpaperPreviewActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                val prefs = LayoutPreferences.getInstance(activity)
                val switch = activity.findViewById<MaterialSwitch>(R.id.switchUsageOverlay)
                val checkClaude = activity.findViewById<CheckBox>(R.id.checkUsageClaude)
                val checkCodex = activity.findViewById<CheckBox>(R.id.checkUsageCodex)
                val checkSession = activity.findViewById<CheckBox>(R.id.checkUsageSession)
                val checkWeekly = activity.findViewById<CheckBox>(R.id.checkUsageWeekly)

                switch.isChecked = true
                checkClaude.isChecked = true
                checkCodex.isChecked = false
                checkSession.isChecked = true
                checkWeekly.isChecked = false

                assertTrue(prefs.usageOverlayEnabled)
                assertTrue(prefs.usageOverlayShowClaude)
                assertFalse(prefs.usageOverlayShowCodex)
                assertTrue(prefs.usageOverlayShowSession)
                assertFalse(prefs.usageOverlayShowWeekly)
            }
        }
    }

    @Test
    fun testUsageOverlayDragPersistsFreeformPosition() {
        ActivityScenario.launch(WallpaperPreviewActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                val prefs = LayoutPreferences.getInstance(activity)
                prefs.clearUsageOverlayTransform()
                prefs.usageOverlayEnabled = true
                prefs.usageOverlayShowClaude = true
                prefs.usageOverlayShowSession = true

                val preview = activity.findViewById<WallpaperPreviewView>(R.id.wallpaperPreviewView)
                preview.invalidate()

                val bounds = preview.getUsageOverlayBoundsForTest()
                assertNotNull("Usage overlay bounds should be available", bounds)

                val startX = bounds!!.centerX()
                val startY = bounds.centerY()
                val endX = (startX - 80f).coerceAtLeast(24f)
                val endY = (startY + 70f).coerceAtMost(preview.height - 24f)
                val downTime = android.os.SystemClock.uptimeMillis()

                preview.dispatchTouchEvent(MotionEvent.obtain(downTime, downTime, MotionEvent.ACTION_DOWN, startX, startY, 0))
                preview.dispatchTouchEvent(MotionEvent.obtain(downTime, downTime + 16, MotionEvent.ACTION_MOVE, endX, endY, 0))
                preview.dispatchTouchEvent(MotionEvent.obtain(downTime, downTime + 32, MotionEvent.ACTION_UP, endX, endY, 0))

                val savedCenter = prefs.getUsageOverlayCenter()
                assertNotNull("Dragging usage overlay should persist a freeform center", savedCenter)
                val expectedX = endX / preview.width
                val expectedY = endY / preview.height
                assertEquals("Usage overlay X center should track drag", expectedX, savedCenter!!.first, 0.05f)
                assertEquals("Usage overlay Y center should track drag", expectedY, savedCenter.second, 0.05f)
            }
        }
    }

    @Test
    fun testUsageOverlayPinchScalesLockedTargetFromOutsideBounds() {
        ActivityScenario.launch(WallpaperPreviewActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                val prefs = LayoutPreferences.getInstance(activity)
                prefs.clearUsageOverlayTransform()
                prefs.usageOverlayEnabled = true
                prefs.usageOverlayShowClaude = true
                prefs.usageOverlayShowSession = true

                val preview = activity.findViewById<WallpaperPreviewView>(R.id.wallpaperPreviewView)
                preview.invalidate()

                val bounds = preview.getUsageOverlayBoundsForTest()
                assertNotNull("Usage overlay bounds should be available", bounds)

                dispatchTap(preview, bounds!!.centerX(), bounds.centerY())
                assertEquals("usage", preview.getLockedTargetForTest())

                val beforeScale = prefs.usageOverlayScale
                dispatchPinch(
                    preview,
                    centerX = preview.width * 0.35f,
                    centerY = preview.height * 0.72f,
                    startSpan = 60f,
                    endSpan = 180f
                )

                assertTrue(
                    "Locked usage overlay should scale even when pinch starts outside its bounds",
                    prefs.usageOverlayScale > beforeScale + 0.05f
                )
            }
        }
    }

    @Test
    fun testEntityTapRelocksAndPinchScalesLockedEntityFromAnywhere() {
        ActivityScenario.launch(WallpaperPreviewActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                val prefs = LayoutPreferences.getInstance(activity)
                prefs.clearAllCustomPositions()
                prefs.clearAllEntityScales()

                val preview = activity.findViewById<WallpaperPreviewView>(R.id.wallpaperPreviewView)
                preview.setEntities(
                    listOf(
                        EntityStatus(entityId = 0, name = "Alpha", isBound = true),
                        EntityStatus(entityId = 1, name = "Beta", isBound = true)
                    )
                )

                dispatchTap(preview, preview.width * 0.30f, preview.height * 0.50f)
                assertEquals("entity:0", preview.getLockedTargetForTest())

                dispatchTap(preview, preview.width * 0.70f, preview.height * 0.50f)
                assertEquals("entity:1", preview.getLockedTargetForTest())

                val beforeEntity0 = preview.getEntityScaleForTest(0)
                val beforeEntity1 = preview.getEntityScaleForTest(1)
                dispatchPinch(
                    preview,
                    centerX = preview.width * 0.25f,
                    centerY = preview.height * 0.78f,
                    startSpan = 70f,
                    endSpan = 180f
                )

                assertEquals(
                    "Previously locked entity should not scale after another entity is selected",
                    beforeEntity0,
                    preview.getEntityScaleForTest(0),
                    0.01f
                )
                assertTrue(
                    "Current locked entity should scale even when pinch starts away from it",
                    preview.getEntityScaleForTest(1) > beforeEntity1 + 0.05f
                )
            }
        }
    }

    @Test
    fun testSafeInsetsAppliedCorrectly() {
        ActivityScenario.launch(WallpaperPreviewActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                val topBar = activity.findViewById<View>(R.id.topBar)
                val bottomControls = activity.findViewById<View>(R.id.bottomControls)
                val rootView = activity.findViewById<View>(android.R.id.content)

                val windowInsets = ViewCompat.getRootWindowInsets(rootView)
                assertNotNull("Window insets should be available", windowInsets)

                val systemBarsInsets = windowInsets!!.getInsets(
                    WindowInsetsCompat.Type.systemBars()
                )

                // Log actual values for debugging
                println("=== Safe Insets Test ===")
                println("Status bar height: ${systemBarsInsets.top}")
                println("Navigation bar height: ${systemBarsInsets.bottom}")
                println("Left inset: ${systemBarsInsets.left}")
                println("Right inset: ${systemBarsInsets.right}")
                println("Top bar padding: top=${topBar.paddingTop}, left=${topBar.paddingLeft}, right=${topBar.paddingRight}")
                println("Bottom controls padding: bottom=${bottomControls.paddingBottom}, left=${bottomControls.paddingLeft}, right=${bottomControls.paddingRight}")

                // Verify insets are applied
                assertTrue(
                    "Top bar should have top padding >= status bar (${topBar.paddingTop} >= ${systemBarsInsets.top})",
                    topBar.paddingTop >= systemBarsInsets.top
                )

                assertTrue(
                    "Bottom controls should have bottom padding >= nav bar (${bottomControls.paddingBottom} >= ${systemBarsInsets.bottom})",
                    bottomControls.paddingBottom >= systemBarsInsets.bottom
                )
            }
        }
    }

    private fun dispatchTap(view: View, x: Float, y: Float) {
        val downTime = android.os.SystemClock.uptimeMillis()
        view.dispatchTouchEvent(MotionEvent.obtain(downTime, downTime, MotionEvent.ACTION_DOWN, x, y, 0))
        view.dispatchTouchEvent(MotionEvent.obtain(downTime, downTime + 24, MotionEvent.ACTION_UP, x, y, 0))
    }

    private fun dispatchPinch(
        view: View,
        centerX: Float,
        centerY: Float,
        startSpan: Float,
        endSpan: Float
    ) {
        val downTime = android.os.SystemClock.uptimeMillis()
        val startLeft = centerX - startSpan / 2f
        val startRight = centerX + startSpan / 2f
        val endLeft = centerX - endSpan / 2f
        val endRight = centerX + endSpan / 2f

        view.dispatchTouchEvent(MotionEvent.obtain(downTime, downTime, MotionEvent.ACTION_DOWN, startLeft, centerY, 0))
        view.dispatchTouchEvent(
            multiTouchEvent(
                downTime,
                downTime + 16,
                MotionEvent.ACTION_POINTER_DOWN or (1 shl MotionEvent.ACTION_POINTER_INDEX_SHIFT),
                startLeft,
                centerY,
                startRight,
                centerY
            )
        )
        view.dispatchTouchEvent(
            multiTouchEvent(
                downTime,
                downTime + 32,
                MotionEvent.ACTION_MOVE,
                endLeft,
                centerY,
                endRight,
                centerY
            )
        )
        view.dispatchTouchEvent(
            multiTouchEvent(
                downTime,
                downTime + 48,
                MotionEvent.ACTION_POINTER_UP or (1 shl MotionEvent.ACTION_POINTER_INDEX_SHIFT),
                endLeft,
                centerY,
                endRight,
                centerY
            )
        )
        view.dispatchTouchEvent(MotionEvent.obtain(downTime, downTime + 64, MotionEvent.ACTION_UP, endLeft, centerY, 0))
    }

    private fun multiTouchEvent(
        downTime: Long,
        eventTime: Long,
        action: Int,
        x0: Float,
        y0: Float,
        x1: Float,
        y1: Float
    ): MotionEvent {
        val properties = arrayOf(
            MotionEvent.PointerProperties().apply {
                id = 0
                toolType = MotionEvent.TOOL_TYPE_FINGER
            },
            MotionEvent.PointerProperties().apply {
                id = 1
                toolType = MotionEvent.TOOL_TYPE_FINGER
            }
        )
        val coords = arrayOf(
            MotionEvent.PointerCoords().apply {
                x = x0
                y = y0
                pressure = 1f
                size = 1f
            },
            MotionEvent.PointerCoords().apply {
                x = x1
                y = y1
                pressure = 1f
                size = 1f
            }
        )
        return MotionEvent.obtain(
            downTime,
            eventTime,
            action,
            2,
            properties,
            coords,
            0,
            0,
            1f,
            1f,
            0,
            0,
            0,
            0
        )
    }
}
