package com.hank.clawlive

import android.view.View
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

/**
 * UI/UX tests for MainActivity
 * Validates edge-to-edge display and safe insets for system bars
 */
@RunWith(AndroidJUnit4::class)
class MainActivityUiTest {

    @Test
    fun testTopBarHasSafeInsetFromStatusBar() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                val topBar = activity.findViewById<View>(R.id.topBar)
                val rootView = activity.findViewById<View>(android.R.id.content)

                assertNotNull("Top bar should exist", topBar)

                val windowInsets = ViewCompat.getRootWindowInsets(rootView)
                assertNotNull("Window insets should be available", windowInsets)

                val statusBarHeight = windowInsets!!.getInsets(
                    WindowInsetsCompat.Type.statusBars()
                ).top

                val topPadding = topBar.paddingTop
                assertTrue(
                    "Top bar padding ($topPadding) should be >= status bar height ($statusBarHeight)",
                    topPadding >= statusBarHeight
                )
            }
        }
    }

    @Test
    fun testBottomNavHasSafeInsetFromNavigationBar() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                val bottomActions = activity.findViewById<View>(R.id.bottomNav)
                val rootView = activity.findViewById<View>(android.R.id.content)

                assertNotNull("Bottom actions should exist", bottomActions)

                val windowInsets = ViewCompat.getRootWindowInsets(rootView)
                assertNotNull("Window insets should be available", windowInsets)

                val navBarHeight = windowInsets!!.getInsets(
                    WindowInsetsCompat.Type.navigationBars()
                ).bottom

                val bottomPadding = bottomActions.paddingBottom
                assertTrue(
                    "Bottom padding ($bottomPadding) should be >= nav bar height ($navBarHeight)",
                    bottomPadding >= navBarHeight
                )
            }
        }
    }

    @Test
    fun testSettingsNavItemIsAccessible() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                val btnSettings = activity.findViewById<View>(R.id.navSettings)
                val rootView = activity.findViewById<View>(android.R.id.content)

                assertNotNull("Settings button should exist", btnSettings)
                assertTrue("Settings button should be clickable", btnSettings.isClickable)

                val location = IntArray(2)
                btnSettings.getLocationOnScreen(location)

                val windowInsets = ViewCompat.getRootWindowInsets(rootView)
                val statusBarHeight = windowInsets?.getInsets(
                    WindowInsetsCompat.Type.statusBars()
                )?.top ?: 0

                assertTrue(
                    "Settings button top (${location[1]}) should be below status bar ($statusBarHeight)",
                    location[1] >= statusBarHeight
                )
            }
        }
    }

    @Test
    fun testSetWallpaperButtonIsAccessible() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                val btnSetWallpaper = activity.findViewById<View>(R.id.btnSetWallpaper)
                val rootView = activity.findViewById<View>(android.R.id.content)

                assertNotNull("Set Wallpaper button should exist", btnSetWallpaper)
                assertTrue("Set Wallpaper button should be clickable", btnSetWallpaper.isClickable)

                val screenHeight = activity.resources.displayMetrics.heightPixels
                val location = IntArray(2)
                btnSetWallpaper.getLocationOnScreen(location)
                val buttonBottom = location[1] + btnSetWallpaper.height

                val windowInsets = ViewCompat.getRootWindowInsets(rootView)
                val navBarHeight = windowInsets?.getInsets(
                    WindowInsetsCompat.Type.navigationBars()
                )?.bottom ?: 0

                val maxBottomY = screenHeight - navBarHeight + 50
                assertTrue(
                    "Set Wallpaper button bottom ($buttonBottom) should be above nav bar area",
                    buttonBottom <= maxBottomY || navBarHeight == 0
                )
            }
        }
    }

    @Test
    fun testSafeInsetsAppliedCorrectly() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                val topBar = activity.findViewById<View>(R.id.topBar)
                val bottomActions = activity.findViewById<View>(R.id.bottomNav)
                val rootView = activity.findViewById<View>(android.R.id.content)

                val windowInsets = ViewCompat.getRootWindowInsets(rootView)
                assertNotNull("Window insets should be available", windowInsets)

                val systemBarsInsets = windowInsets!!.getInsets(
                    WindowInsetsCompat.Type.systemBars()
                )

                println("=== MainActivity Safe Insets Test ===")
                println("Status bar height: ${systemBarsInsets.top}")
                println("Navigation bar height: ${systemBarsInsets.bottom}")
                println("Top bar padding: top=${topBar.paddingTop}")
                println("Bottom actions padding: bottom=${bottomActions.paddingBottom}")

                assertTrue(
                    "Top bar should have top padding >= status bar",
                    topBar.paddingTop >= systemBarsInsets.top
                )

                assertTrue(
                    "Bottom actions should have bottom padding >= nav bar",
                    bottomActions.paddingBottom >= systemBarsInsets.bottom
                )
            }
        }
    }
}
