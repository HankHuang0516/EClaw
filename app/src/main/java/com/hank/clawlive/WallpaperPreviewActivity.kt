package com.hank.clawlive

import android.app.WallpaperManager
import android.content.ComponentName
import android.content.Intent
import android.os.Bundle
import android.view.View
import android.widget.CheckBox
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.updatePadding
import androidx.lifecycle.lifecycleScope
import com.google.android.material.button.MaterialButton
import com.google.android.material.button.MaterialButtonToggleGroup
import com.google.android.material.materialswitch.MaterialSwitch
import com.hank.clawlive.data.local.DeviceManager
import com.hank.clawlive.data.local.LayoutPreferences
import com.hank.clawlive.data.local.UsageOverlayPosition
import com.hank.clawlive.data.model.CompanionDetail
import com.hank.clawlive.data.remote.NetworkModule
import com.hank.clawlive.service.ClawWallpaperService
import com.hank.clawlive.ui.RecordingIndicatorHelper
import com.hank.clawlive.ui.WallpaperPreviewView
import kotlinx.coroutines.launch
import timber.log.Timber

/**
 * Wallpaper Preview Activity - allows users to:
 * 1. Preview and position entities on wallpaper
 * 2. Select a custom background photo
 * 3. Set the live wallpaper
 */
class WallpaperPreviewActivity : AppCompatActivity() {

    private lateinit var previewView: WallpaperPreviewView
    private lateinit var switchCustomLayout: MaterialSwitch
    private lateinit var switchBackground: MaterialSwitch
    private lateinit var switchUsageOverlay: MaterialSwitch
    private lateinit var toggleUsageOverlayPosition: MaterialButtonToggleGroup
    private lateinit var checkUsageClaude: CheckBox
    private lateinit var checkUsageCodex: CheckBox
    private lateinit var checkUsageSession: CheckBox
    private lateinit var checkUsageWeekly: CheckBox
    private lateinit var btnSelectPhoto: MaterialButton
    private lateinit var btnReset: MaterialButton
    private lateinit var btnSetWallpaper: MaterialButton
    private lateinit var btnBack: ImageButton

    private lateinit var topBar: LinearLayout
    private lateinit var bottomControls: LinearLayout

    private val api = NetworkModule.api
    private val deviceManager by lazy { DeviceManager.getInstance(this) }
    private val layoutPrefs by lazy { LayoutPreferences.getInstance(this) }

    // Photo picker launcher
    private val photoPickerLauncher = registerForActivityResult(
        ActivityResultContracts.OpenDocument()
    ) { uri ->
        if (uri != null) {
            try {
                // Take persistable permission so we can access the image after restart
                contentResolver.takePersistableUriPermission(
                    uri,
                    Intent.FLAG_GRANT_READ_URI_PERMISSION
                )

                // Save URI to preferences
                layoutPrefs.backgroundImageUri = uri.toString()
                layoutPrefs.useBackgroundImage = true
                switchBackground.isChecked = true

                // Refresh preview
                previewView.refreshBackground()

                Toast.makeText(this, getString(R.string.background_set), Toast.LENGTH_SHORT).show()
                Timber.d("Background image set: $uri")

            } catch (e: Exception) {
                Timber.e(e, "Failed to set background image")
                Toast.makeText(this, getString(R.string.background_set_failed), Toast.LENGTH_SHORT).show()
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Enable edge-to-edge display
        WindowCompat.setDecorFitsSystemWindows(window, false)

        setContentView(R.layout.activity_wallpaper_preview)

        initViews()
        setupEdgeToEdgeInsets()
        setupListeners()
        loadBoundEntities()
        loadUsageSnapshot()
    }

    override fun onResume() {
        super.onResume()
        RecordingIndicatorHelper.attach(this)
    }

    override fun onPause() {
        super.onPause()
        RecordingIndicatorHelper.detach()
    }

    private fun initViews() {
        previewView = findViewById(R.id.wallpaperPreviewView)
        switchCustomLayout = findViewById(R.id.switchCustomLayout)
        switchBackground = findViewById(R.id.switchBackground)
        switchUsageOverlay = findViewById(R.id.switchUsageOverlay)
        toggleUsageOverlayPosition = findViewById(R.id.toggleUsageOverlayPosition)
        checkUsageClaude = findViewById(R.id.checkUsageClaude)
        checkUsageCodex = findViewById(R.id.checkUsageCodex)
        checkUsageSession = findViewById(R.id.checkUsageSession)
        checkUsageWeekly = findViewById(R.id.checkUsageWeekly)
        btnSelectPhoto = findViewById(R.id.btnSelectPhoto)
        btnReset = findViewById(R.id.btnReset)
        btnSetWallpaper = findViewById(R.id.btnSetWallpaper)
        btnBack = findViewById(R.id.btnBack)
        topBar = findViewById(R.id.topBar)
        bottomControls = findViewById(R.id.bottomControls)

        // Initialize switch states from preferences
        switchCustomLayout.isChecked = layoutPrefs.useCustomLayout
        switchBackground.isChecked = layoutPrefs.useBackgroundImage
        switchUsageOverlay.isChecked = layoutPrefs.usageOverlayEnabled
        toggleUsageOverlayPosition.check(buttonIdForUsagePosition(layoutPrefs.usageOverlayPosition))
        checkUsageClaude.isChecked = layoutPrefs.usageOverlayShowClaude
        checkUsageCodex.isChecked = layoutPrefs.usageOverlayShowCodex
        checkUsageSession.isChecked = layoutPrefs.usageOverlayShowSession
        checkUsageWeekly.isChecked = layoutPrefs.usageOverlayShowWeekly

        // Show/hide photo button based on background switch
        updatePhotoButtonVisibility()
        updateUsageOverlayControlsEnabled()
        previewView.post { updatePreviewUsageOverlayInsets() }
    }

    /**
     * Apply WindowInsets for edge-to-edge display.
     * Background extends to edges, but interactive UI avoids system bars.
     */
    private fun setupEdgeToEdgeInsets() {
        ViewCompat.setOnApplyWindowInsetsListener(findViewById(android.R.id.content)) { view, windowInsets ->
            val insets = windowInsets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
            )

            // Apply top inset to top bar (status bar + cutout)
            topBar.updatePadding(
                left = insets.left + 16.dpToPx(),
                top = insets.top + 8.dpToPx(),
                right = insets.right + 16.dpToPx()
            )

            // Apply bottom inset to bottom controls (navigation bar)
            bottomControls.updatePadding(
                left = insets.left + 16.dpToPx(),
                right = insets.right + 16.dpToPx(),
                bottom = insets.bottom + 8.dpToPx()
            )

            previewView.post { updatePreviewUsageOverlayInsets() }

            WindowInsetsCompat.CONSUMED
        }
    }

    private fun Int.dpToPx(): Int {
        return (this * resources.displayMetrics.density).toInt()
    }

    private fun setupListeners() {
        btnBack.setOnClickListener {
            finish()
        }

        btnSetWallpaper.setOnClickListener {
            openWallpaperChooser()
        }

        btnReset.setOnClickListener {
            // Reset positions
            previewView.resetPositions()

            // Clear background
            layoutPrefs.clearBackgroundImage()
            switchBackground.isChecked = false
            previewView.refreshBackground()

            Toast.makeText(this, getString(R.string.settings_reset), Toast.LENGTH_SHORT).show()
        }

        btnSelectPhoto.setOnClickListener {
            openPhotoPicker()
        }

        switchCustomLayout.setOnCheckedChangeListener { _, isChecked ->
            layoutPrefs.useCustomLayout = isChecked
            val message = getString(if (isChecked) R.string.custom_layout_enabled else R.string.custom_layout_using_preset)
            Toast.makeText(this, message, Toast.LENGTH_SHORT).show()
        }

        switchBackground.setOnCheckedChangeListener { _, isChecked ->
            layoutPrefs.useBackgroundImage = isChecked
            updatePhotoButtonVisibility()
            previewView.refreshBackground()

            if (!isChecked) {
                Toast.makeText(this, getString(R.string.background_disabled), Toast.LENGTH_SHORT).show()
            }
        }

        switchUsageOverlay.setOnCheckedChangeListener { _, isChecked ->
            layoutPrefs.usageOverlayEnabled = isChecked
            updateUsageOverlayControlsEnabled()
            previewView.invalidate()
        }

        toggleUsageOverlayPosition.addOnButtonCheckedListener { _, checkedId, isChecked ->
            if (!isChecked) return@addOnButtonCheckedListener
            usagePositionForButtonId(checkedId)?.let { position ->
                layoutPrefs.usageOverlayPosition = position
                previewView.invalidate()
            }
        }

        val usageItemListener = android.widget.CompoundButton.OnCheckedChangeListener { button, isChecked ->
            when (button.id) {
                R.id.checkUsageClaude -> layoutPrefs.usageOverlayShowClaude = isChecked
                R.id.checkUsageCodex -> layoutPrefs.usageOverlayShowCodex = isChecked
                R.id.checkUsageSession -> layoutPrefs.usageOverlayShowSession = isChecked
                R.id.checkUsageWeekly -> layoutPrefs.usageOverlayShowWeekly = isChecked
            }
            previewView.invalidate()
        }
        checkUsageClaude.setOnCheckedChangeListener(usageItemListener)
        checkUsageCodex.setOnCheckedChangeListener(usageItemListener)
        checkUsageSession.setOnCheckedChangeListener(usageItemListener)
        checkUsageWeekly.setOnCheckedChangeListener(usageItemListener)
    }

    private fun updatePhotoButtonVisibility() {
        btnSelectPhoto.visibility = if (switchBackground.isChecked) View.VISIBLE else View.GONE
    }

    private fun updateUsageOverlayControlsEnabled() {
        val enabled = switchUsageOverlay.isChecked
        toggleUsageOverlayPosition.isEnabled = enabled
        for (i in 0 until toggleUsageOverlayPosition.childCount) {
            toggleUsageOverlayPosition.getChildAt(i).isEnabled = enabled
        }
        checkUsageClaude.isEnabled = enabled
        checkUsageCodex.isEnabled = enabled
        checkUsageSession.isEnabled = enabled
        checkUsageWeekly.isEnabled = enabled
    }

    private fun updatePreviewUsageOverlayInsets() {
        previewView.setUsageOverlayInsets(
            topInsetPx = topBar.height.toFloat(),
            bottomInsetPx = bottomControls.height.toFloat()
        )
    }

    private fun buttonIdForUsagePosition(position: UsageOverlayPosition): Int = when (position) {
        UsageOverlayPosition.TOP_LEFT -> R.id.btnUsageTopLeft
        UsageOverlayPosition.TOP_RIGHT -> R.id.btnUsageTopRight
        UsageOverlayPosition.BOTTOM_LEFT -> R.id.btnUsageBottomLeft
        UsageOverlayPosition.BOTTOM_RIGHT -> R.id.btnUsageBottomRight
    }

    private fun usagePositionForButtonId(buttonId: Int): UsageOverlayPosition? = when (buttonId) {
        R.id.btnUsageTopLeft -> UsageOverlayPosition.TOP_LEFT
        R.id.btnUsageTopRight -> UsageOverlayPosition.TOP_RIGHT
        R.id.btnUsageBottomLeft -> UsageOverlayPosition.BOTTOM_LEFT
        R.id.btnUsageBottomRight -> UsageOverlayPosition.BOTTOM_RIGHT
        else -> null
    }

    private fun openPhotoPicker() {
        try {
            photoPickerLauncher.launch(arrayOf("image/*"))
        } catch (e: Exception) {
            Timber.e(e, "Failed to open photo picker")
            Toast.makeText(this, getString(R.string.error_open_picker), Toast.LENGTH_SHORT).show()
        }
    }

    private fun openWallpaperChooser() {
        try {
            val intent = Intent(WallpaperManager.ACTION_CHANGE_LIVE_WALLPAPER).apply {
                putExtra(
                    WallpaperManager.EXTRA_LIVE_WALLPAPER_COMPONENT,
                    ComponentName(this@WallpaperPreviewActivity, ClawWallpaperService::class.java)
                )
            }
            startActivity(intent)
        } catch (e: Exception) {
            Timber.e(e, "Failed to open wallpaper chooser")
            Toast.makeText(this, getString(R.string.error_open_settings), Toast.LENGTH_SHORT).show()
        }
    }

    private fun loadBoundEntities() {
        lifecycleScope.launch {
            try {
                val response = api.getAllEntities(deviceId = deviceManager.deviceId, deviceSecret = deviceManager.deviceSecret ?: "")

                // Filter to only bound entities
                val boundEntities = response.entities.filter { it.isBound }

                Timber.d("Loaded ${boundEntities.size} bound entities for preview")

                if (boundEntities.isEmpty()) {
                    Toast.makeText(
                        this@WallpaperPreviewActivity,
                        "No bound entities. Bind an entity first.",
                        Toast.LENGTH_LONG
                    ).show()
                }

                previewView.setEntities(boundEntities)
                loadCompanions(boundEntities)

            } catch (e: Exception) {
                Timber.e(e, "Failed to load entities")
                Toast.makeText(
                    this@WallpaperPreviewActivity,
                    getString(R.string.wallpaper_load_entities_failed, e.message ?: ""),
                    Toast.LENGTH_LONG
                ).show()
            }
        }
    }

    private fun loadUsageSnapshot() {
        lifecycleScope.launch {
            try {
                val response = api.getUsageSnapshot(
                    deviceId = deviceManager.deviceId,
                    deviceSecret = deviceManager.deviceSecret ?: ""
                )
                previewView.setUsageSnapshot(if (response.success) response.latest else null)
            } catch (e: Exception) {
                Timber.w(e, "Failed to load usage snapshot for wallpaper preview")
                previewView.setUsageSnapshot(null)
            }
        }
    }

    /**
     * Fetch each entity's currently-selected companion in parallel and push
     * the resulting map into the preview view so renderer dispatch (cat/dog/fish)
     * runs in the preview as well as the live wallpaper. Spec §4.3.
     */
    private fun loadCompanions(entities: List<com.hank.clawlive.data.model.EntityStatus>) {
        lifecycleScope.launch {
            val map = mutableMapOf<Int, CompanionDetail?>()
            for (entity in entities) {
                val secret = entity.botSecret ?: continue
                try {
                    val resp = api.getCurrentCompanion(
                        deviceId = deviceManager.deviceId,
                        botSecret = secret,
                        entityId = entity.entityId
                    )
                    map[entity.entityId] = resp.selection?.companion
                } catch (e: Exception) {
                    Timber.w(e, "Companion fetch failed for entity ${entity.entityId}")
                }
            }
            previewView.setCompanions(map)
        }
    }
}
