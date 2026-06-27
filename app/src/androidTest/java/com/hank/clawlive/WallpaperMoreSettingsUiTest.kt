package com.hank.clawlive

import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.google.android.material.materialswitch.MaterialSwitch
import com.google.android.material.slider.Slider
import com.hank.clawlive.data.local.LayoutPreferences
import org.junit.Assert.assertEquals
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
                assertTrue(prefs.wallpaperPurposefulWalkingEnabled)
                assertTrue(prefs.wallpaperConsciousWalkingEnabled)
                assertTrue(prefs.wallpaperEntityInteractionsEnabled)
                assertTrue(prefs.wallpaperBubblePulseEnabled)
                assertTrue(prefs.wallpaperBubbleOverlayAvoidanceEnabled)
                assertTrue(prefs.wallpaperStateAuraEnabled)
                assertTrue(prefs.wallpaperGroundShadowEnabled)
                assertTrue(prefs.wallpaperAdaptiveEffectsEnabled)
                assertTrue(prefs.wallpaperOfflineEntityCacheEnabled)

                val root = activity.window.decorView
                val switches = mutableListOf<MaterialSwitch>()
                val sliders = mutableListOf<Slider>()
                fun collect(view: android.view.View) {
                    if (view is MaterialSwitch) switches.add(view)
                    if (view is Slider) sliders.add(view)
                    if (view is android.view.ViewGroup) {
                        for (i in 0 until view.childCount) collect(view.getChildAt(i))
                    }
                }
                collect(root)
                assertTrue("Expected advanced wallpaper switches", switches.size >= 10)
                switches.forEach { assertTrue("Default-on switch should start checked", it.isChecked) }
                assertTrue("Expected bubble duration slider", sliders.isNotEmpty())
                val durationSlider = sliders.first()
                assertEquals(LayoutPreferences.WALLPAPER_BUBBLE_DURATION_MIN_SECONDS.toFloat(), durationSlider.valueFrom, 0.001f)
                assertEquals(LayoutPreferences.WALLPAPER_BUBBLE_DURATION_MAX_SECONDS.toFloat(), durationSlider.valueTo, 0.001f)

                switches.first().isChecked = false
                assertFalse(prefs.wallpaperSpeechBubblesEnabled)
                prefs.wallpaperSpeechBubblesEnabled = true

                switches[1].isChecked = false
                assertFalse(prefs.wallpaperPurposefulWalkingEnabled)
                prefs.wallpaperPurposefulWalkingEnabled = true

                switches[2].isChecked = false
                assertFalse(prefs.wallpaperConsciousWalkingEnabled)
                prefs.wallpaperConsciousWalkingEnabled = true

                switches[3].isChecked = false
                assertFalse(prefs.wallpaperEntityInteractionsEnabled)
                prefs.wallpaperEntityInteractionsEnabled = true

                durationSlider.value = 18f
                assertEquals(18, prefs.wallpaperBubbleDurationSeconds)
                durationSlider.value = LayoutPreferences.WALLPAPER_BUBBLE_DURATION_MAX_SECONDS.toFloat()
                assertEquals(LayoutPreferences.WALLPAPER_BUBBLE_DURATION_MAX_SECONDS, prefs.wallpaperBubbleDurationSeconds)
                prefs.wallpaperBubbleDurationSeconds = 0
                assertEquals(1, prefs.wallpaperBubbleDurationSeconds) // clamps up to MIN=1
                prefs.wallpaperBubbleDurationSeconds = 999
                assertEquals(600, prefs.wallpaperBubbleDurationSeconds) // clamps down to MAX=600 (10 min)
                prefs.wallpaperBubbleDurationSeconds = LayoutPreferences.WALLPAPER_BUBBLE_DURATION_DEFAULT_SECONDS
            }
        }
    }
}
