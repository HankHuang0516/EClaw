package com.hank.clawlive

import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.google.android.material.materialswitch.MaterialSwitch
import com.hank.clawlive.data.local.LayoutPreferences
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class WallpaperMoreSettingsUiTest {
    @Test
    fun enhancedWallpaperSettingsDefaultOnAndPersist() {
        ActivityScenario.launch(WallpaperMoreSettingsActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                val prefs = LayoutPreferences.getInstance(activity)
                assertTrue(prefs.wallpaperSpeechBubblesEnabled)
                assertTrue(prefs.wallpaperBubblePulseEnabled)
                assertTrue(prefs.wallpaperBubbleOverlayAvoidanceEnabled)
                assertTrue(prefs.wallpaperStateAuraEnabled)
                assertTrue(prefs.wallpaperGroundShadowEnabled)
                assertTrue(prefs.wallpaperAdaptiveEffectsEnabled)
                assertTrue(prefs.wallpaperOfflineEntityCacheEnabled)

                val root = activity.window.decorView
                val switches = mutableListOf<MaterialSwitch>()
                fun collect(view: android.view.View) {
                    if (view is MaterialSwitch) switches.add(view)
                    if (view is android.view.ViewGroup) {
                        for (i in 0 until view.childCount) collect(view.getChildAt(i))
                    }
                }
                collect(root)
                assertTrue("Expected advanced wallpaper switches", switches.size >= 7)
                switches.forEach { assertTrue("Default-on switch should start checked", it.isChecked) }

                switches.first().isChecked = false
                assertFalse(prefs.wallpaperSpeechBubblesEnabled)
                prefs.wallpaperSpeechBubblesEnabled = true
            }
        }
    }
}
