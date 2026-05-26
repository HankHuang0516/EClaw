package com.hank.clawlive

import android.graphics.Rect
import android.os.Build
import android.view.View
import android.view.WindowInsets
import android.widget.CheckBox
import android.widget.LinearLayout
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.google.android.material.button.MaterialButtonToggleGroup
import com.google.android.material.materialswitch.MaterialSwitch
import com.hank.clawlive.data.local.LayoutPreferences
import com.hank.clawlive.data.local.UsageOverlayPosition
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
                    R.id.btnUsageTopLeft,
                    R.id.btnUsageTopRight,
                    R.id.btnUsageBottomLeft,
                    R.id.btnUsageBottomRight,
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
                val toggle = activity.findViewById<MaterialButtonToggleGroup>(R.id.toggleUsageOverlayPosition)
                val checkClaude = activity.findViewById<CheckBox>(R.id.checkUsageClaude)
                val checkCodex = activity.findViewById<CheckBox>(R.id.checkUsageCodex)
                val checkSession = activity.findViewById<CheckBox>(R.id.checkUsageSession)
                val checkWeekly = activity.findViewById<CheckBox>(R.id.checkUsageWeekly)

                switch.isChecked = true
                toggle.check(R.id.btnUsageBottomLeft)
                checkClaude.isChecked = true
                checkCodex.isChecked = false
                checkSession.isChecked = true
                checkWeekly.isChecked = false

                assertTrue(prefs.usageOverlayEnabled)
                assertEquals(UsageOverlayPosition.BOTTOM_LEFT, prefs.usageOverlayPosition)
                assertTrue(prefs.usageOverlayShowClaude)
                assertFalse(prefs.usageOverlayShowCodex)
                assertTrue(prefs.usageOverlayShowSession)
                assertFalse(prefs.usageOverlayShowWeekly)
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
}
