package com.hank.clawlive

import android.os.Bundle
import android.view.Gravity
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.updatePadding
import com.google.android.material.appbar.MaterialToolbar
import com.google.android.material.materialswitch.MaterialSwitch
import com.google.android.material.slider.Slider
import com.hank.clawlive.data.local.LayoutPreferences
import kotlin.math.roundToInt

class WallpaperMoreSettingsActivity : AppCompatActivity() {
    private val layoutPrefs by lazy { LayoutPreferences.getInstance(this) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        title = getString(R.string.wallpaper_more_settings)
        WindowCompat.setDecorFitsSystemWindows(window, false)

        val density = resources.displayMetrics.density
        fun dp(value: Int): Int = (value * density).toInt()

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(0xFF101018.toInt())
        }

        val toolbar = MaterialToolbar(this).apply {
            title = getString(R.string.wallpaper_more_settings)
            setTitleTextColor(0xFFFFFFFF.toInt())
            setNavigationIcon(androidx.appcompat.R.drawable.abc_ic_ab_back_material)
            setNavigationOnClickListener { finish() }
        }
        root.addView(toolbar, LinearLayout.LayoutParams.MATCH_PARENT, dp(56))
        ViewCompat.setOnApplyWindowInsetsListener(root) { _, insets ->
            val systemBars = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
            )
            toolbar.updatePadding(top = systemBars.top)
            toolbar.layoutParams = toolbar.layoutParams.apply {
                height = dp(56) + systemBars.top
            }
            root.updatePadding(bottom = systemBars.bottom)
            insets
        }

        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(16), dp(20), dp(24))
        }

        addDescription(content, getString(R.string.wallpaper_more_settings_desc))
        addSwitch(
            content,
            title = getString(R.string.wallpaper_setting_speech_bubbles),
            description = getString(R.string.wallpaper_setting_speech_bubbles_desc),
            checked = layoutPrefs.wallpaperSpeechBubblesEnabled
        ) { layoutPrefs.wallpaperSpeechBubblesEnabled = it }
        addDurationSlider(content)
        addSwitch(
            content,
            title = getString(R.string.wallpaper_setting_purposeful_walking),
            description = getString(R.string.wallpaper_setting_purposeful_walking_desc),
            checked = layoutPrefs.wallpaperPurposefulWalkingEnabled
        ) { layoutPrefs.wallpaperPurposefulWalkingEnabled = it }
        addSwitch(
            content,
            title = getString(R.string.wallpaper_setting_bubble_pulse),
            description = getString(R.string.wallpaper_setting_bubble_pulse_desc),
            checked = layoutPrefs.wallpaperBubblePulseEnabled
        ) { layoutPrefs.wallpaperBubblePulseEnabled = it }
        addSwitch(
            content,
            title = getString(R.string.wallpaper_setting_bubble_avoidance),
            description = getString(R.string.wallpaper_setting_bubble_avoidance_desc),
            checked = layoutPrefs.wallpaperBubbleOverlayAvoidanceEnabled
        ) { layoutPrefs.wallpaperBubbleOverlayAvoidanceEnabled = it }
        addSwitch(
            content,
            title = getString(R.string.wallpaper_setting_state_aura),
            description = getString(R.string.wallpaper_setting_state_aura_desc),
            checked = layoutPrefs.wallpaperStateAuraEnabled
        ) { layoutPrefs.wallpaperStateAuraEnabled = it }
        addSwitch(
            content,
            title = getString(R.string.wallpaper_setting_ground_shadow),
            description = getString(R.string.wallpaper_setting_ground_shadow_desc),
            checked = layoutPrefs.wallpaperGroundShadowEnabled
        ) { layoutPrefs.wallpaperGroundShadowEnabled = it }
        addSwitch(
            content,
            title = getString(R.string.wallpaper_setting_adaptive_effects),
            description = getString(R.string.wallpaper_setting_adaptive_effects_desc),
            checked = layoutPrefs.wallpaperAdaptiveEffectsEnabled
        ) { layoutPrefs.wallpaperAdaptiveEffectsEnabled = it }
        addSwitch(
            content,
            title = getString(R.string.wallpaper_setting_offline_cache),
            description = getString(R.string.wallpaper_setting_offline_cache_desc),
            checked = layoutPrefs.wallpaperOfflineEntityCacheEnabled
        ) { layoutPrefs.wallpaperOfflineEntityCacheEnabled = it }

        root.addView(
            ScrollView(this).apply { addView(content) },
            LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f)
        )
        setContentView(root)
    }

    private fun addDescription(parent: LinearLayout, text: String) {
        parent.addView(TextView(this).apply {
            this.text = text
            setTextColor(0xB3FFFFFF.toInt())
            textSize = 14f
        })
    }

    private fun addDurationSlider(parent: LinearLayout) {
        val density = resources.displayMetrics.density
        fun dp(value: Int): Int = (value * density).toInt()

        val container = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, dp(10), 0, dp(14))
        }
        val header = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        header.addView(TextView(this).apply {
            text = getString(R.string.wallpaper_setting_bubble_duration)
            setTextColor(0xFFFFFFFF.toInt())
            textSize = 16f
        }, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))

        val valueLabel = TextView(this).apply {
            text = bubbleDurationLabel(layoutPrefs.wallpaperBubbleDurationSeconds)
            setTextColor(0xB3FFFFFF.toInt())
            textSize = 14f
            gravity = Gravity.END
        }
        header.addView(valueLabel)
        container.addView(header)
        container.addView(TextView(this).apply {
            text = getString(R.string.wallpaper_setting_bubble_duration_desc)
            setTextColor(0x99FFFFFF.toInt())
            textSize = 12f
            setPadding(0, dp(4), 0, dp(6))
        })
        container.addView(Slider(this).apply {
            valueFrom = LayoutPreferences.WALLPAPER_BUBBLE_DURATION_MIN_SECONDS.toFloat()
            valueTo = LayoutPreferences.WALLPAPER_BUBBLE_DURATION_MAX_SECONDS.toFloat()
            stepSize = 1f
            value = layoutPrefs.wallpaperBubbleDurationSeconds.toFloat()
            contentDescription = getString(R.string.wallpaper_setting_bubble_duration)
            addOnChangeListener { _, sliderValue, _ ->
                val seconds = sliderValue.roundToInt()
                layoutPrefs.wallpaperBubbleDurationSeconds = seconds
                valueLabel.text = bubbleDurationLabel(seconds)
            }
        })
        parent.addView(container)
    }

    private fun bubbleDurationLabel(seconds: Int): String {
        return getString(R.string.wallpaper_setting_bubble_duration_value, seconds)
    }

    private fun addSwitch(
        parent: LinearLayout,
        title: String,
        description: String,
        checked: Boolean,
        onChanged: (Boolean) -> Unit
    ) {
        val density = resources.displayMetrics.density
        fun dp(value: Int): Int = (value * density).toInt()

        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(0, dp(18), 0, dp(10))
        }
        val labels = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
        }
        labels.addView(TextView(this).apply {
            text = title
            setTextColor(0xFFFFFFFF.toInt())
            textSize = 16f
        })
        labels.addView(TextView(this).apply {
            text = description
            setTextColor(0x99FFFFFF.toInt())
            textSize = 12f
        })
        row.addView(labels, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        row.addView(MaterialSwitch(this).apply {
            isChecked = checked
            setOnCheckedChangeListener { _, isChecked -> onChanged(isChecked) }
        })
        parent.addView(row)
    }
}
