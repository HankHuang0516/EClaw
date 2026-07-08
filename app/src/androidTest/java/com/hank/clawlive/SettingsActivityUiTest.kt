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
 * UI/UX tests for SettingsActivity
 * Validates edge-to-edge display and safe insets for system bars
 */
@RunWith(AndroidJUnit4::class)
class SettingsActivityUiTest {

    @Test
    fun testTopBarHasSafeInsetFromStatusBar() {
        ActivityScenario.launch(SettingsActivity::class.java).use { scenario ->
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
    fun testBackButtonIsAccessible() {
        ActivityScenario.launch(SettingsActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                val btnBack = activity.findViewById<View>(R.id.btnBack)
                val rootView = activity.findViewById<View>(android.R.id.content)

                assertNotNull("Back button should exist", btnBack)
                assertTrue("Back button should be clickable", btnBack.isClickable)

                val location = IntArray(2)
                btnBack.getLocationOnScreen(location)

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

    /**
     * Stage-2 manifest auto-sync: the settings screen must inflate and stay usable
     * regardless of the manifest fetch. The dynamic-rows container exists and — until
     * the async fetch populates it — is hidden (View.GONE). This is the graceful
     * failure-fallback contract: an offline / failed / empty manifest leaves the static
     * settings screen exactly as-is (container hidden), never blank, never crashing.
     */
    @Test
    fun testManifestExtraContainerExistsAndDefaultsHidden() {
        ActivityScenario.launch(SettingsActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                val container = activity.findViewById<View>(R.id.settingsManifestExtraContainer)
                assertNotNull("Manifest extra-rows container should exist in the layout", container)
                // Before any rows are rendered (no network in instrumentation), the
                // container is GONE so the static screen is unchanged.
                assertEquals(
                    "Manifest extra container should be hidden until rows are planned",
                    View.GONE,
                    container.visibility
                )
                // The static screen itself must still be present and functional.
                assertNotNull("Subscription card should still render", activity.findViewById<View>(R.id.cardSubscription))
            }
        }
    }

    @Test
    fun testWallpaperEntryIsSingleSettingsSurface() {
        ActivityScenario.launch(SettingsActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                val setWallpaperButton = activity.findViewById<View>(R.id.btnSetWallpaper)
                assertNotNull("Settings should keep the wallpaper entry point", setWallpaperButton)
                assertTrue("Wallpaper entry point should remain clickable", setWallpaperButton.isClickable)

                assertEquals(
                    "Settings should not expose a duplicate wallpaper walking switch",
                    0,
                    activity.resources.getIdentifier("switchWallpaperWalking", "id", activity.packageName)
                )
                assertEquals(
                    "Settings should not expose duplicate wallpaper walking help",
                    0,
                    activity.resources.getIdentifier("btnWallpaperWalkingHelp", "id", activity.packageName)
                )
            }
        }
    }

    @Test
    fun testSafeInsetsAppliedCorrectly() {
        ActivityScenario.launch(SettingsActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                val topBar = activity.findViewById<View>(R.id.topBar)
                val rootView = activity.findViewById<View>(android.R.id.content)

                val windowInsets = ViewCompat.getRootWindowInsets(rootView)
                assertNotNull("Window insets should be available", windowInsets)

                val systemBarsInsets = windowInsets!!.getInsets(
                    WindowInsetsCompat.Type.systemBars()
                )

                println("=== SettingsActivity Safe Insets Test ===")
                println("Status bar height: ${systemBarsInsets.top}")
                println("Top bar padding: top=${topBar.paddingTop}")

                assertTrue(
                    "Top bar should have top padding >= status bar",
                    topBar.paddingTop >= systemBarsInsets.top
                )
            }
        }
    }
}
