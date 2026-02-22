package com.hank.clawlive

import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import com.hank.clawlive.data.local.EntityAvatarManager
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.updatePadding
import androidx.lifecycle.lifecycleScope
import com.google.android.material.button.MaterialButton
import com.hank.clawlive.data.local.DeviceManager
import com.hank.clawlive.data.local.LayoutPreferences
import com.hank.clawlive.data.model.EntityStatus
import com.hank.clawlive.data.model.MultiEntityResponse
import com.hank.clawlive.data.remote.NetworkModule
import com.hank.clawlive.ui.RecordingIndicatorHelper
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import timber.log.Timber
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class EntityManagerActivity : AppCompatActivity() {

    private lateinit var btnBack: ImageButton
    private lateinit var tvEntityCount: TextView
    private lateinit var entityListContainer: LinearLayout
    private lateinit var tvEmptyState: TextView
    private lateinit var btnRefresh: MaterialButton
    private lateinit var topBar: LinearLayout
    private lateinit var bottomBar: LinearLayout

    private lateinit var layoutPrefs: LayoutPreferences
    private lateinit var deviceManager: DeviceManager

    private val api = NetworkModule.api
    private var currentEntities: List<EntityStatus> = emptyList()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Enable edge-to-edge display
        WindowCompat.setDecorFitsSystemWindows(window, false)

        setContentView(R.layout.activity_entity_manager)

        initViews()
        setupEdgeToEdgeInsets()
        setupListeners()
        loadEntities()
    }

    override fun onResume() {
        super.onResume()
        RecordingIndicatorHelper.attach(this)
    }

    override fun onPause() {
        super.onPause()
        RecordingIndicatorHelper.detach()
    }

    private fun setupEdgeToEdgeInsets() {
        ViewCompat.setOnApplyWindowInsetsListener(findViewById(android.R.id.content)) { _, windowInsets ->
            val insets = windowInsets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
            )

            // Apply top inset to top bar (status bar + cutout)
            topBar.updatePadding(
                left = insets.left + dpToPx(8),
                top = insets.top + dpToPx(8),
                right = insets.right + dpToPx(8)
            )

            // Apply bottom inset to bottom bar (navigation bar)
            bottomBar.updatePadding(
                left = insets.left + dpToPx(16),
                right = insets.right + dpToPx(16),
                bottom = insets.bottom + dpToPx(16)
            )

            WindowInsetsCompat.CONSUMED
        }
    }

    private fun dpToPx(dp: Int): Int {
        return (dp * resources.displayMetrics.density).toInt()
    }

    private fun initViews() {
        btnBack = findViewById(R.id.btnBack)
        tvEntityCount = findViewById(R.id.tvEntityCount)
        entityListContainer = findViewById(R.id.entityListContainer)
        tvEmptyState = findViewById(R.id.tvEmptyState)
        btnRefresh = findViewById(R.id.btnRefresh)
        topBar = findViewById(R.id.topBar)
        bottomBar = findViewById(R.id.bottomBar)

        layoutPrefs = LayoutPreferences.getInstance(this)
        deviceManager = DeviceManager.getInstance(this)
    }

    private fun setupListeners() {
        btnBack.setOnClickListener {
            finish()
        }

        btnRefresh.setOnClickListener {
            loadEntities()
        }
    }

    private fun loadEntities() {
        tvEmptyState.text = getString(R.string.loading_entities)
        tvEmptyState.visibility = View.VISIBLE

        lifecycleScope.launch {
            try {
                // v5: Filter by this device's ID
                val response = api.getAllEntities(deviceId = deviceManager.deviceId)
                currentEntities = response.entities
                updateEntityList(response)
            } catch (e: Exception) {
                Timber.e(e, "Failed to load entities")
                tvEmptyState.text = getString(R.string.failed_format, e.message)
                tvEmptyState.visibility = View.VISIBLE
            }
        }
    }

    private fun updateEntityList(response: MultiEntityResponse) {
        // Update count
        tvEntityCount.text = "${response.activeCount}/${response.maxEntities}"

        // Clear existing entity cards (except empty state)
        val childCount = entityListContainer.childCount
        for (i in childCount - 1 downTo 0) {
            val child = entityListContainer.getChildAt(i)
            if (child.id != R.id.tvEmptyState) {
                entityListContainer.removeViewAt(i)
            }
        }

        if (response.entities.isEmpty()) {
            tvEmptyState.text = getString(R.string.no_agents_connected)
            tvEmptyState.visibility = View.VISIBLE
            return
        }

        tvEmptyState.visibility = View.GONE

        // Add entity cards
        response.entities.forEach { entity ->
            addEntityCard(entity)
        }
    }

    private fun addEntityCard(entity: EntityStatus) {
        val cardView = LayoutInflater.from(this)
            .inflate(R.layout.item_entity_card, entityListContainer, false)

        // Character icon (from avatar manager)
        val avatarManager = EntityAvatarManager.getInstance(this)
        val tvCharacterIcon = cardView.findViewById<TextView>(R.id.tvCharacterIcon)
        tvCharacterIcon.text = avatarManager.getAvatar(entity.entityId)

        // Entity label
        val tvEntityLabel = cardView.findViewById<TextView>(R.id.tvEntityLabel)
        val labelText = if (entity.entityId == 0) {
            "${getString(R.string.entity_format, entity.entityId)} (Main)"
        } else {
            getString(R.string.entity_format, entity.entityId)
        }
        tvEntityLabel.text = labelText

        // Character type
        val tvCharacterType = cardView.findViewById<TextView>(R.id.tvCharacterType)
        tvCharacterType.text = entity.character

        // State badge
        val tvStateBadge = cardView.findViewById<TextView>(R.id.tvStateBadge)
        tvStateBadge.text = entity.state.name
        tvStateBadge.setBackgroundResource(getStateBadgeBackground(entity.state.name))

        // Message
        val tvMessage = cardView.findViewById<TextView>(R.id.tvMessage)
        tvMessage.text = entity.message.ifEmpty { "(No message)" }

        // Update time
        val tvMessageTime = cardView.findViewById<TextView>(R.id.tvMessageTime)
        val timeFormat = SimpleDateFormat("HH:mm:ss", Locale.getDefault())
        tvMessageTime.text = "Updated: ${timeFormat.format(Date(entity.lastUpdated))}"

        // Message bubble style (LOBSTER only)
        val messageBubble = cardView.findViewById<LinearLayout>(R.id.messageBubble)
        messageBubble.setBackgroundResource(R.drawable.chat_bubble_lobster)

        // Talk button - hidden (moved to MainActivity)
        val btnTalk = cardView.findViewById<MaterialButton>(R.id.btnTalk)
        btnTalk.visibility = View.GONE

        // Remove button (hide for entity 0)
        val btnRemove = cardView.findViewById<MaterialButton>(R.id.btnRemove)
        if (entity.entityId == 0) {
            btnRemove.visibility = View.GONE
        } else {
            btnRemove.visibility = View.VISIBLE
            btnRemove.setOnClickListener {
                showRemoveConfirmDialog(entity)
            }
        }

        entityListContainer.addView(cardView, 0) // Add at top
    }

    private fun getStateBadgeBackground(state: String): Int {
        return when (state) {
            "EXCITED" -> R.drawable.badge_excited
            "BUSY" -> R.drawable.badge_busy
            "SLEEPING" -> R.drawable.badge_sleeping
            "EATING" -> R.drawable.badge_eating
            else -> R.drawable.badge_idle
        }
    }

    private fun showRemoveConfirmDialog(entity: EntityStatus) {
        val title = "${getString(R.string.entity_format, entity.entityId)}?"
        AlertDialog.Builder(this)
            .setTitle(title)
            .setMessage("This will remove the ${entity.character} from the wallpaper.")
            .setPositiveButton(getString(R.string.send)) { _, _ ->
                removeEntity(entity.entityId)
            }
            .setNegativeButton(getString(R.string.cancel), null)
            .show()
    }

    private fun removeEntity(entityId: Int) {
        lifecycleScope.launch {
            try {
                // Use device endpoint with deviceSecret (not botSecret)
                val body = mapOf<String, Any>(
                    "deviceId" to deviceManager.deviceId,
                    "deviceSecret" to deviceManager.deviceSecret,
                    "entityId" to entityId
                )
                val response = api.removeEntityByDevice(body)

                if (response.success) {
                    // Also remove from local registered entities
                    layoutPrefs.removeRegisteredEntity(entityId)

                    Toast.makeText(
                        this@EntityManagerActivity,
                        "${getString(R.string.entity_format, entityId)} removed",
                        Toast.LENGTH_SHORT
                    ).show()
                    delay(500)
                    loadEntities()
                } else {
                    Toast.makeText(
                        this@EntityManagerActivity,
                        getString(R.string.failed_format, response.message),
                        Toast.LENGTH_SHORT
                    ).show()
                }
            } catch (e: Exception) {
                Timber.e(e, "Failed to remove entity")
                Toast.makeText(
                    this@EntityManagerActivity,
                    getString(R.string.failed_format, e.message),
                    Toast.LENGTH_LONG
                ).show()
            }
        }
    }

}
