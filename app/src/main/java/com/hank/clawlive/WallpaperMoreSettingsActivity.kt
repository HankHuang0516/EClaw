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
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.google.android.material.materialswitch.MaterialSwitch
import com.google.android.material.slider.Slider
import com.hank.clawlive.data.local.LayoutPreferences
import com.hank.clawlive.data.local.WallpaperKanbanObjectStyle
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
        addBubbleDurationSlider(content)
        addSwitch(
            content,
            title = getString(R.string.wallpaper_setting_conscious_walking),
            description = getString(R.string.wallpaper_setting_conscious_walking_desc),
            checked = layoutPrefs.wallpaperPurposefulWalkingEnabled
        ) { layoutPrefs.wallpaperPurposefulWalkingEnabled = it }
        addSwitch(
            content,
            title = getString(R.string.wallpaper_setting_entity_interactions),
            description = getString(R.string.wallpaper_setting_entity_interactions_desc),
            checked = layoutPrefs.wallpaperEntityInteractionsEnabled
        ) { layoutPrefs.wallpaperEntityInteractionsEnabled = it }
        addCollisionDurationSlider(content)
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
        addSwitch(
            content,
            title = getString(R.string.wallpaper_setting_kanban_tasks),
            description = getString(R.string.wallpaper_setting_kanban_tasks_desc),
            checked = layoutPrefs.wallpaperKanbanTasksEnabled
        ) { layoutPrefs.wallpaperKanbanTasksEnabled = it }
        addKanbanObjectStyleChoice(content)
        addSwitch(
            content,
            title = getString(R.string.wallpaper_setting_kanban_automation_board),
            description = getString(R.string.wallpaper_setting_kanban_automation_board_desc),
            checked = layoutPrefs.wallpaperKanbanAutomationBoardEnabled
        ) { layoutPrefs.wallpaperKanbanAutomationBoardEnabled = it }
        addSwitch(
            content,
            title = getString(R.string.wallpaper_setting_kanban_asset_whiteboard),
            description = getString(R.string.wallpaper_setting_kanban_asset_whiteboard_desc),
            checked = layoutPrefs.wallpaperKanbanAssetWhiteboardEnabled
        ) { layoutPrefs.wallpaperKanbanAssetWhiteboardEnabled = it }
        addSwitch(
            content,
            title = getString(R.string.wallpaper_setting_kanban_handwritten_board_text),
            description = getString(R.string.wallpaper_setting_kanban_handwritten_board_text_desc),
            checked = layoutPrefs.wallpaperKanbanHandwrittenBoardTextEnabled
        ) { layoutPrefs.wallpaperKanbanHandwrittenBoardTextEnabled = it }
        addSwitch(
            content,
            title = getString(R.string.wallpaper_setting_kanban_privacy),
            description = getString(R.string.wallpaper_setting_kanban_privacy_desc),
            checked = layoutPrefs.wallpaperKanbanPrivacyModeEnabled
        ) { layoutPrefs.wallpaperKanbanPrivacyModeEnabled = it }

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

    private fun addBubbleDurationSlider(parent: LinearLayout) {
        addSecondsSlider(
            parent = parent,
            title = getString(R.string.wallpaper_setting_bubble_duration),
            description = getString(R.string.wallpaper_setting_bubble_duration_desc),
            minSeconds = LayoutPreferences.WALLPAPER_BUBBLE_DURATION_MIN_SECONDS,
            maxSeconds = LayoutPreferences.WALLPAPER_BUBBLE_DURATION_MAX_SECONDS,
            currentSeconds = layoutPrefs.wallpaperBubbleDurationSeconds
        ) { layoutPrefs.wallpaperBubbleDurationSeconds = it }
    }

    private fun addCollisionDurationSlider(parent: LinearLayout) {
        addSecondsSlider(
            parent = parent,
            title = getString(R.string.wallpaper_setting_collision_duration),
            description = getString(R.string.wallpaper_setting_collision_duration_desc),
            minSeconds = LayoutPreferences.WALLPAPER_COLLISION_REACTION_DURATION_MIN_SECONDS,
            maxSeconds = LayoutPreferences.WALLPAPER_COLLISION_REACTION_DURATION_MAX_SECONDS,
            currentSeconds = layoutPrefs.wallpaperCollisionReactionDurationSeconds
        ) { layoutPrefs.wallpaperCollisionReactionDurationSeconds = it }
    }

    private fun addKanbanObjectStyleChoice(parent: LinearLayout) {
        val styles = WallpaperKanbanObjectStyle.values()
        addChoice(
            parent = parent,
            title = getString(R.string.wallpaper_setting_kanban_object_style),
            description = getString(R.string.wallpaper_setting_kanban_object_style_desc),
            currentLabel = objectStyleLabel(layoutPrefs.wallpaperKanbanObjectStyle),
            choices = styles.map(::objectStyleLabel).toTypedArray(),
            checkedIndex = styles.indexOf(layoutPrefs.wallpaperKanbanObjectStyle)
        ) { selectedIndex, valueLabel ->
            val selected = styles[selectedIndex]
            layoutPrefs.wallpaperKanbanObjectStyle = selected
            valueLabel.text = objectStyleLabel(selected)
        }
    }

    private fun objectStyleLabel(style: WallpaperKanbanObjectStyle): String {
        return when (style) {
            WallpaperKanbanObjectStyle.SMART_MIX -> getString(R.string.wallpaper_kanban_object_style_smart_mix)
            WallpaperKanbanObjectStyle.FOLDER -> getString(R.string.wallpaper_kanban_object_style_folder)
            WallpaperKanbanObjectStyle.BOOK_NOTEBOOK -> getString(R.string.wallpaper_kanban_object_style_book_notebook)
            WallpaperKanbanObjectStyle.CLIPBOARD -> getString(R.string.wallpaper_kanban_object_style_clipboard)
            WallpaperKanbanObjectStyle.STORAGE_BOX -> getString(R.string.wallpaper_kanban_object_style_storage_box)
            WallpaperKanbanObjectStyle.STICKY_CARD -> getString(R.string.wallpaper_kanban_object_style_sticky_card)
        }
    }

    private fun addSecondsSlider(
        parent: LinearLayout,
        title: String,
        description: String,
        minSeconds: Int,
        maxSeconds: Int,
        currentSeconds: Int,
        onChanged: (Int) -> Unit
    ) {
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
            text = title
            setTextColor(0xFFFFFFFF.toInt())
            textSize = 16f
        }, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        header.addView(helpButton(title, description), LinearLayout.LayoutParams(dp(32), dp(32)))

        val valueLabel = TextView(this).apply {
            text = secondsLabel(currentSeconds)
            setTextColor(0xB3FFFFFF.toInt())
            textSize = 14f
            gravity = Gravity.END
        }
        header.addView(valueLabel)
        container.addView(header)
        container.addView(Slider(this).apply {
            valueFrom = minSeconds.toFloat()
            valueTo = maxSeconds.toFloat()
            stepSize = 1f
            value = currentSeconds.toFloat()
            contentDescription = title
            addOnChangeListener { _, sliderValue, _ ->
                val seconds = sliderValue.roundToInt()
                onChanged(seconds)
                valueLabel.text = secondsLabel(seconds)
            }
        })
        parent.addView(container)
    }

    private fun secondsLabel(seconds: Int): String {
        val minutes = seconds / 60
        val remainingSeconds = seconds % 60
        return when {
            minutes <= 0 -> getString(R.string.wallpaper_setting_bubble_duration_value, seconds)
            remainingSeconds == 0 -> getString(
                R.string.wallpaper_setting_bubble_duration_minutes_value,
                minutes
            )
            else -> getString(
                R.string.wallpaper_setting_bubble_duration_minutes_seconds_value,
                minutes,
                remainingSeconds
            )
        }
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
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        labels.addView(TextView(this).apply {
            text = title
            setTextColor(0xFFFFFFFF.toInt())
            textSize = 16f
        }, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        labels.addView(helpButton(title, description), LinearLayout.LayoutParams(dp(32), dp(32)))
        row.addView(labels, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        row.addView(MaterialSwitch(this).apply {
            isChecked = checked
            setOnCheckedChangeListener { _, isChecked -> onChanged(isChecked) }
        })
        parent.addView(row)
    }

    private fun addChoice(
        parent: LinearLayout,
        title: String,
        description: String,
        currentLabel: String,
        choices: Array<String>,
        checkedIndex: Int,
        onSelected: (Int, TextView) -> Unit
    ) {
        val density = resources.displayMetrics.density
        fun dp(value: Int): Int = (value * density).toInt()

        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(0, dp(18), 0, dp(10))
            isClickable = true
            isFocusable = true
        }
        val labels = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        labels.addView(TextView(this).apply {
            text = title
            setTextColor(0xFFFFFFFF.toInt())
            textSize = 16f
        }, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        labels.addView(helpButton(title, description), LinearLayout.LayoutParams(dp(32), dp(32)))
        row.addView(labels, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))

        val valueLabel = TextView(this).apply {
            text = currentLabel
            setTextColor(0xB3FFFFFF.toInt())
            textSize = 14f
            gravity = Gravity.END
            maxLines = 2
        }
        row.addView(valueLabel, LinearLayout.LayoutParams(dp(132), LinearLayout.LayoutParams.WRAP_CONTENT))
        row.setOnClickListener {
            MaterialAlertDialogBuilder(this)
                .setTitle(title)
                .setSingleChoiceItems(choices, checkedIndex) { dialog, which ->
                    onSelected(which, valueLabel)
                    dialog.dismiss()
                }
                .show()
        }
        parent.addView(row)
    }

    private fun helpButton(title: String, description: String): TextView {
        return TextView(this).apply {
            text = "?"
            setTextColor(0xFFFFFFFF.toInt())
            textSize = 14f
            gravity = Gravity.CENTER
            isClickable = true
            isFocusable = true
            contentDescription = getString(R.string.wallpaper_setting_help_content_description, title)
            setOnClickListener {
                MaterialAlertDialogBuilder(this@WallpaperMoreSettingsActivity)
                    .setTitle(title)
                    .setMessage(description)
                    .setPositiveButton(android.R.string.ok, null)
                    .show()
            }
        }
    }
}
