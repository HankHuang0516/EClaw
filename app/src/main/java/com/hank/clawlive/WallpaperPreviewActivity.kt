package com.hank.clawlive

import android.app.WallpaperManager
import android.content.ComponentName
import android.content.Intent
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
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
import com.google.android.material.materialswitch.MaterialSwitch
import com.hank.clawlive.data.local.DeviceManager
import com.hank.clawlive.data.local.LayoutPreferences
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
        btnSelectPhoto = findViewById(R.id.btnSelectPhoto)
        btnReset = findViewById(R.id.btnReset)
        btnSetWallpaper = findViewById(R.id.btnSetWallpaper)
        btnBack = findViewById(R.id.btnBack)
        topBar = findViewById(R.id.topBar)
        bottomControls = findViewById(R.id.bottomControls)

        // Initialize switch states from preferences
        switchCustomLayout.isChecked = layoutPrefs.useCustomLayout
        switchBackground.isChecked = layoutPrefs.useBackgroundImage

        // Show/hide photo button based on background switch
        updatePhotoButtonVisibility()
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
            val message = if (isChecked) "Custom layout enabled" else "Using preset layout"
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
    }

    private fun updatePhotoButtonVisibility() {
        btnSelectPhoto.visibility = if (switchBackground.isChecked) View.VISIBLE else View.GONE
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
                val response = api.getAllEntities(deviceId = deviceManager.deviceId)

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

            } catch (e: Exception) {
                Timber.e(e, "Failed to load entities")
                Toast.makeText(
                    this@WallpaperPreviewActivity,
                    "Failed to load entities: ${e.message}",
                    Toast.LENGTH_LONG
                ).show()
            }
        }
    }
}
