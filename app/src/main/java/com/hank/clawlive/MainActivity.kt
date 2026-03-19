package com.hank.clawlive

import android.Manifest
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.text.InputType
import android.view.Gravity
import android.view.ViewGroup
import android.widget.EditText
import android.view.LayoutInflater
import android.view.View
import android.widget.GridLayout
import android.widget.ImageButton
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.activity.viewModels
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.updatePadding
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import androidx.recyclerview.widget.ItemTouchHelper
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.google.android.material.button.MaterialButton
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.google.android.material.card.MaterialCardView
import com.google.android.material.chip.Chip
import com.google.android.material.chip.ChipGroup
import com.hank.clawlive.data.local.database.ChatDatabase
import com.hank.clawlive.data.local.DeviceManager
import com.hank.clawlive.data.local.EntityAvatarManager
import com.hank.clawlive.fcm.ClawFcmService
import com.hank.clawlive.data.local.LayoutPreferences
import com.hank.clawlive.data.local.UsageManager
import com.hank.clawlive.data.model.AvatarUploadResponse
import com.hank.clawlive.data.model.EntityStatus
import com.hank.clawlive.data.model.UpdateAvatarRequest
import com.hank.clawlive.data.remote.NetworkModule
import com.hank.clawlive.data.remote.TelemetryHelper
import com.hank.clawlive.data.repository.StateRepository
import com.hank.clawlive.ui.AiChatFabHelper
import com.hank.clawlive.ui.BottomNavHelper
import com.hank.clawlive.ui.EntityCardAdapter
import com.hank.clawlive.ui.EntityChipHelper
import com.hank.clawlive.ui.MainViewModel
import com.hank.clawlive.ui.NavItem
import com.hank.clawlive.ui.RecordingIndicatorHelper
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import retrofit2.HttpException
import timber.log.Timber

class MainActivity : AppCompatActivity() {

    private val viewModel: MainViewModel by viewModels()
    private val api = NetworkModule.api
    private val deviceManager by lazy { DeviceManager.getInstance(this) }
    private val avatarManager by lazy { EntityAvatarManager.getInstance(this) }
    private val layoutPrefs by lazy { LayoutPreferences.getInstance(this) }
    private val usageManager by lazy { UsageManager.getInstance(this) }
    private val stateRepository by lazy {
        StateRepository(NetworkModule.api, this)
    }
    companion object {
        private const val API_BASE_URL = "https://eclawbot.com"
    }

    // Notification permission launcher (Android 13+)
    private val notifPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        Timber.d("[FCM] POST_NOTIFICATIONS permission granted=$granted")
    }

    // Avatar photo picker state
    private var avatarPickerEntityId: Int = -1
    private var avatarPickerIconView: TextView? = null

    private val avatarPhotoLauncher = registerForActivityResult(
        ActivityResultContracts.GetContent()
    ) { uri ->
        if (uri != null && avatarPickerEntityId >= 0) {
            uploadAvatarPhoto(uri, avatarPickerEntityId, avatarPickerIconView)
        }
    }

    // UI elements
    private lateinit var btnEditMode: ImageButton
    private lateinit var agentCardsContainer: RecyclerView
    private lateinit var emptyStateContainer: LinearLayout
    private lateinit var cardAddEntity: MaterialCardView
    private lateinit var addEntityHeader: LinearLayout
    private lateinit var addEntityContent: LinearLayout
    private lateinit var ivExpandArrow: ImageView
    private lateinit var chipGroupEntity: ChipGroup
    private lateinit var tvBindingCode: TextView
    private lateinit var tvCountdown: TextView
    private lateinit var btnGenerateCode: MaterialButton
    private lateinit var btnCopyCommand: MaterialButton
    private lateinit var progressBar: ProgressBar
    private lateinit var topBar: LinearLayout
    private lateinit var tvEntityCount: TextView
    // Phase 9: AI Usage Status Bar
    private lateinit var usageStatusBar: LinearLayout
    private lateinit var tvUsageLabel: TextView
    private lateinit var progressUsage: ProgressBar
    private lateinit var tvUsageStatus: TextView
    private lateinit var btnOfficialBorrow: MaterialButton

    private var entityChips: Map<Int, Chip> = emptyMap()
    private var boundEntities: List<EntityStatus> = emptyList()
    private var isAddEntityExpanded = false
    private var isEditMode = false

    // RecyclerView adapter + drag helper
    private lateinit var entityAdapter: EntityCardAdapter
    private lateinit var itemTouchHelper: ItemTouchHelper

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Initialize telemetry (safe to call multiple times)
        TelemetryHelper.init(this)

        // Connect Socket.IO for real-time updates
        com.hank.clawlive.data.remote.SocketManager.connect(this)

        // FCM: Create notification channels + request permission (Android 13+)
        ClawFcmService.createChannels(this)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED
            ) {
                notifPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
            }
        }

        // Enable edge-to-edge display
        WindowCompat.setDecorFitsSystemWindows(window, false)

        setContentView(R.layout.activity_main)

        BottomNavHelper.setup(this, NavItem.HOME)
        AiChatFabHelper.setup(this, "home")
        initViews()
        setupEdgeToEdgeInsets()
        setupClickListeners()
        observeUiState()
        startEntityPolling()
        checkForAppUpdate()
    }

    override fun onResume() {
        super.onResume()
        TelemetryHelper.trackPageView(this, "main")
        loadBoundEntities()
        RecordingIndicatorHelper.attach(this)
    }

    override fun onPause() {
        super.onPause()
        RecordingIndicatorHelper.detach()
    }

    private fun startEntityPolling() {
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                while (true) {
                    delay(15_000)
                    loadBoundEntities()
                }
            }
        }
    }

    private fun checkForAppUpdate() {
        lifecycleScope.launch {
            try {
                val currentVersion = deviceManager.appVersion
                if (currentVersion == "unknown") return@launch

                val versionInfo = withContext(Dispatchers.IO) {
                    NetworkModule.api.checkAppVersion(currentVersion)
                }

                val update = versionInfo.update ?: return@launch
                if (!update.available) {
                    // Clear any pending force update if they've already updated
                    getSharedPreferences("update_prefs", MODE_PRIVATE)
                        .edit().remove("force_update_pending").remove("force_update_version").apply()
                    return@launch
                }

                // Also check for force update from FCM push
                val prefs = getSharedPreferences("update_prefs", MODE_PRIVATE)
                val isForceUpdate = update.forceUpdate || prefs.getBoolean("force_update_pending", false)

                showUpdateDialog(
                    latestVersion = update.latestVersion,
                    releaseNotes = update.releaseNotes,
                    storeUrl = update.storeUrl,
                    isForceUpdate = isForceUpdate
                )
            } catch (e: Exception) {
                Timber.d(e, "Version check failed (non-critical)")
            }
        }
    }

    private fun showUpdateDialog(
        latestVersion: String,
        releaseNotes: String?,
        storeUrl: String,
        isForceUpdate: Boolean
    ) {
        val message = buildString {
            append(getString(R.string.update_message, latestVersion))
            if (!releaseNotes.isNullOrBlank()) {
                append("\n\n")
                append(releaseNotes)
            }
        }

        val builder = MaterialAlertDialogBuilder(this)
            .setTitle(getString(R.string.update_title))
            .setMessage(message)
            .setPositiveButton(getString(R.string.update_now)) { _, _ ->
                try {
                    startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(storeUrl)))
                } catch (e: Exception) {
                    Timber.e(e, "Failed to open Play Store")
                }
            }

        if (!isForceUpdate) {
            builder.setNegativeButton(getString(R.string.update_later), null)
        }

        val dialog = builder.create()
        dialog.setCancelable(!isForceUpdate)
        dialog.setCanceledOnTouchOutside(!isForceUpdate)
        dialog.show()

        TelemetryHelper.trackAction("update_dialog_shown", mapOf(
            "latestVersion" to latestVersion,
            "isForceUpdate" to isForceUpdate.toString()
        ))
    }

    private fun initViews() {
        btnEditMode = findViewById(R.id.btnEditMode)
        agentCardsContainer = findViewById(R.id.agentCardsContainer)
        emptyStateContainer = findViewById(R.id.emptyStateContainer)
        cardAddEntity = findViewById(R.id.cardAddEntity)
        addEntityHeader = findViewById(R.id.addEntityHeader)
        addEntityContent = findViewById(R.id.addEntityContent)
        ivExpandArrow = findViewById(R.id.ivExpandArrow)
        chipGroupEntity = findViewById(R.id.chipGroupEntity)
        entityChips = EntityChipHelper.populate(this, chipGroupEntity)
        tvBindingCode = findViewById(R.id.tvBindingCode)
        tvCountdown = findViewById(R.id.tvCountdown)
        btnGenerateCode = findViewById(R.id.btnGenerateCode)
        btnCopyCommand = findViewById(R.id.btnCopyCommand)
        progressBar = findViewById(R.id.progressBar)
        topBar = findViewById(R.id.topBar)
        tvEntityCount = findViewById(R.id.tvEntityCount)
        // Phase 9: AI Usage Status Bar
        usageStatusBar = findViewById(R.id.usageStatusBar)
        tvUsageLabel = findViewById(R.id.tvUsageLabel)
        progressUsage = findViewById(R.id.progressUsage)
        tvUsageStatus = findViewById(R.id.tvUsageStatus)
        btnOfficialBorrow = findViewById(R.id.btnOfficialBorrow)

        // Set up RecyclerView with adapter
        entityAdapter = EntityCardAdapter(
            getAvatar = { entityId -> avatarManager.getAvatar(entityId) },
            getEntityLabel = { entity -> entity.name ?: getString(R.string.entity_format, entity.entityId) },
            getEntityIdLabel = { entityId -> getString(R.string.entity_id_format, entityId) },
            onAvatarClick = { entity, iconView -> showAvatarPicker(entity.entityId, iconView) },
            onNameClick = { entity -> showRenameDialog(entity) },
            onRefreshClick = { entity, btn -> refreshEntity(entity, btn) },
            onRemoveClick = { entity -> showRemoveConfirmDialog(entity) },
            onXdSettingsClick = { entity -> showXdSettingsDialog(entity) },
            onAgentCardClick = { entity -> showAgentCardDialog(entity.entityId) }
        )

        val dragCallback = object : ItemTouchHelper.SimpleCallback(
            ItemTouchHelper.UP or ItemTouchHelper.DOWN, 0
        ) {
            override fun isLongPressDragEnabled() = false // drag only via handle

            override fun onMove(rv: RecyclerView, vh: RecyclerView.ViewHolder, target: RecyclerView.ViewHolder): Boolean {
                entityAdapter.moveItem(vh.adapterPosition, target.adapterPosition)
                return true
            }

            override fun onSwiped(vh: RecyclerView.ViewHolder, direction: Int) {}
        }

        itemTouchHelper = ItemTouchHelper(dragCallback)
        itemTouchHelper.attachToRecyclerView(agentCardsContainer)
        entityAdapter.itemTouchHelper = itemTouchHelper

        agentCardsContainer.layoutManager = LinearLayoutManager(this)
        agentCardsContainer.adapter = entityAdapter
    }

    private fun setupEdgeToEdgeInsets() {
        ViewCompat.setOnApplyWindowInsetsListener(findViewById(android.R.id.content)) { _, windowInsets ->
            val insets = windowInsets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
            )

            topBar.updatePadding(
                left = insets.left + 16.dpToPx(),
                top = insets.top + 12.dpToPx(),
                right = insets.right + 16.dpToPx()
            )

            windowInsets
        }
    }

    private fun Int.dpToPx(): Int {
        return (this * resources.displayMetrics.density).toInt()
    }

    private fun setupClickListeners() {
        btnEditMode.setOnClickListener {
            toggleEditMode()
        }

        // Add Entity expandable section
        addEntityHeader.setOnClickListener {
            toggleAddEntitySection()
        }

        btnGenerateCode.setOnClickListener {
            viewModel.generateBindingCode()
        }

        btnCopyCommand.setOnClickListener {
            copyFullCommand()
        }

        tvBindingCode.setOnClickListener {
            copyFullCommand()
        }

        // Channel promo expandable
        val channelSteps = findViewById<LinearLayout>(R.id.channelPromoSteps)
        val channelArrow = findViewById<TextView>(R.id.tvChannelPromoArrow)
        findViewById<LinearLayout>(R.id.channelPromoHeader).setOnClickListener {
            val visible = channelSteps.visibility == android.view.View.VISIBLE
            channelSteps.visibility = if (visible) android.view.View.GONE else android.view.View.VISIBLE
            channelArrow.animate().rotation(if (visible) 0f else 90f).setDuration(200).start()
        }
        findViewById<TextView>(R.id.tvStep1).setOnClickListener {
            copyToClipboard("openclaw plugins install @eclaw/openclaw-channel")
        }
        findViewById<TextView>(R.id.tvStep2).setOnClickListener {
            copyToClipboard("openclaw configure")
        }
        findViewById<TextView>(R.id.tvChannelLearnMore).setOnClickListener {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://www.npmjs.com/package/@eclaw/openclaw-channel")))
        }

        btnOfficialBorrow.setOnClickListener {
            startActivity(Intent(this, OfficialBorrowActivity::class.java))
        }

        // Entity selection chips
        chipGroupEntity.setOnCheckedStateChangeListener { _, checkedIds ->
            if (checkedIds.isNotEmpty()) {
                val chipId = checkedIds[0]
                val selectedEntityId = entityChips.entries.find { it.value.id == chipId }?.key ?: 0
                viewModel.selectEntity(selectedEntityId)
            }
        }
    }

    private fun toggleAddEntitySection() {
        isAddEntityExpanded = !isAddEntityExpanded
        addEntityContent.visibility = if (isAddEntityExpanded) View.VISIBLE else View.GONE
        ivExpandArrow.rotation = if (isAddEntityExpanded) 180f else 0f
    }

    private fun loadBoundEntities() {
        lifecycleScope.launch {
            try {
                val response = api.getAllEntities(deviceId = deviceManager.deviceId)
                val newEntities = response.entities.filter { it.isBound }

                // #72 fix: Sync serverEntityLimit from API response
                val prevLimit = layoutPrefs.serverEntityLimit
                if (response.totalSlots != prevLimit) {
                    layoutPrefs.serverEntityLimit = response.totalSlots
                    Timber.d("[#72] serverEntityLimit updated: $prevLimit -> ${response.totalSlots}")
                    // Refresh entity chips to show newly available slots
                    chipGroupEntity.removeAllViews()
                    entityChips = EntityChipHelper.populate(this@MainActivity, chipGroupEntity)
                    // Re-attach chip listener after repopulation
                    chipGroupEntity.setOnCheckedStateChangeListener { _, checkedIds ->
                        if (checkedIds.isNotEmpty()) {
                            val chipId = checkedIds[0]
                            val selectedEntityId = entityChips.entries.find { it.value.id == chipId }?.key ?: 0
                            viewModel.selectEntity(selectedEntityId)
                        }
                    }
                }

                // #48 diagnosis: log entity details on every poll
                val prevIds = boundEntities.map { it.entityId }.sorted()
                val newIds = newEntities.map { it.entityId }.sorted()
                val registeredIds = layoutPrefs.getRegisteredEntityIds().sorted()
                if (prevIds != newIds) {
                    Timber.w("[#48] Entity list changed: prev=$prevIds new=$newIds registered=$registeredIds serverReady=${response.serverReady}")
                    TelemetryHelper.trackAction("entity_list_changed", mapOf(
                        "prevIds" to prevIds.toString(),
                        "newIds" to newIds.toString(),
                        "registeredIds" to registeredIds.toString(),
                        "serverReady" to response.serverReady
                    ))
                }

                // #48 fix: Auto-sync registeredEntityIds with server-bound entities.
                // When a new entity is bound (e.g. via OfficialBorrow), the server returns it
                // but the wallpaper's StateRepository filters by registeredEntityIds.
                // Ensure newly bound entities are registered so the wallpaper shows them too.
                val currentRegistered = layoutPrefs.getRegisteredEntityIds()
                newEntities.forEach { entity ->
                    if (entity.entityId !in currentRegistered) {
                        layoutPrefs.addRegisteredEntity(entity.entityId)
                        Timber.d("[#48] Auto-registered entity ${entity.entityId} from server response")
                    }
                }

                // #64 fix: Sync avatars from server → local storage
                newEntities.forEach { entity ->
                    entity.avatar?.let { serverAvatar ->
                        if (serverAvatar != avatarManager.getAvatar(entity.entityId)) {
                            avatarManager.setAvatar(entity.entityId, serverAvatar)
                        }
                    }
                }

                // Guard against transient empty responses (fixes #16, #29):
                // Skip update if the server returned 0 entities BUT we know
                // this device had entities — either from the current session
                // (boundEntities), from persisted registration data
                // (registeredEntityIds survives app updates/restarts),
                // or if the server signals persistence hasn't loaded yet.
                if (newEntities.isEmpty()) {
                    val hadEntitiesInSession = boundEntities.isNotEmpty()
                    val hadEntitiesPersisted = layoutPrefs.getRegisteredEntityIds().isNotEmpty()
                    val serverNotReady = !response.serverReady
                    if (hadEntitiesInSession || hadEntitiesPersisted || serverNotReady) {
                        Timber.w("Skipping empty entity response (session=${boundEntities.size}, persisted=${layoutPrefs.getRegisteredEntityIds().size}, serverReady=${response.serverReady})")
                        TelemetryHelper.trackAction("entity_poll_empty_skipped", mapOf(
                            "previousCount" to boundEntities.size,
                            "persistedCount" to layoutPrefs.getRegisteredEntityIds().size,
                            "responseActiveCount" to response.activeCount,
                            "serverReady" to response.serverReady
                        ))
                        return@launch
                    }
                }

                boundEntities = newEntities
                updateAgentCards()
                updateEntityCount()
                updateUsageStatusBar()  // Phase 9: Update usage bar
            } catch (e: Exception) {
                Timber.e(e, "Failed to load entities")
            }
        }
    }

    private fun updateEntityCount() {
        val totalSlots = LayoutPreferences.getInstance(this).serverEntityLimit
        tvEntityCount.text = getString(R.string.entity_count_format, boundEntities.size, totalSlots)
        tvEntityCount.visibility = View.VISIBLE
    }

    /**
     * Phase 9: Update AI Usage Status Bar
     * Shows the AI resource usage from the bound entities
     */
    private fun updateUsageStatusBar() {
        // Find the first entity with usage data (prefer selected entity)
        val selectedEntityId = getSelectedEntityId()
        val selectedEntity = boundEntities.find { it.entityId == selectedEntityId }
        val usage = selectedEntity?.usage ?: boundEntities.firstOrNull { it.usage != null }?.usage

        if (usage != null) {
            usageStatusBar.visibility = View.VISIBLE
            tvUsageLabel.text = usage.label
            progressUsage.progress = usage.percentage
            tvUsageStatus.text = usage.status.name

            // Set color based on status
            val (progressColor, statusColor) = when (usage.status) {
                com.hank.clawlive.data.model.UsageStatus.NORMAL -> 
                    Pair("#4CAF50", "#4CAF50")  // Green
                com.hank.clawlive.data.model.UsageStatus.WARNING -> 
                    Pair("#FFC107", "#FFC107")  // Yellow
                com.hank.clawlive.data.model.UsageStatus.CRITICAL -> 
                    Pair("#F44336", "#F44336")  // Red
            }
            
            tvUsageStatus.setTextColor(Color.parseColor(statusColor))
        } else {
            usageStatusBar.visibility = View.GONE
        }
    }

    private fun getSelectedEntityId(): Int {
        val checkedId = chipGroupEntity.checkedChipId
        return entityChips.entries.find { it.value.id == checkedId }?.key ?: 0
    }

    private fun updateAgentCards() {
        // During edit mode, skip ALL UI updates to preserve drag state and prevent
        // transient API responses from hiding entity cards (fixes #16)
        if (isEditMode) {
            return
        }

        if (boundEntities.isEmpty()) {
            agentCardsContainer.visibility = View.GONE
            emptyStateContainer.visibility = View.VISIBLE
            btnEditMode.visibility = View.GONE
            // Auto-expand add entity section when empty
            if (!isAddEntityExpanded) {
                toggleAddEntitySection()
            }
        } else {
            // Log when cards become visible again after being hidden
            if (agentCardsContainer.visibility != View.VISIBLE) {
                TelemetryHelper.trackAction("entity_cards_shown", mapOf(
                    "count" to boundEntities.size
                ))
            }
            agentCardsContainer.visibility = View.VISIBLE
            emptyStateContainer.visibility = View.GONE
            btnEditMode.visibility = View.VISIBLE
            entityAdapter.submitList(boundEntities)
        }
    }

    private fun toggleEditMode() {
        if (isEditMode) {
            // Closing edit mode — persist reorder if changed
            if (entityAdapter.hasOrderChanged()) {
                persistReorder()
            }
            isEditMode = false
            // Refresh UI with latest data since updates were skipped during edit mode
            updateAgentCards()
        } else {
            isEditMode = true
        }

        entityAdapter.isEditMode = isEditMode
        // Visual feedback: tint edit button when active
        btnEditMode.setColorFilter(
            if (isEditMode) Color.parseColor("#4FC3F7") else Color.WHITE
        )

        TelemetryHelper.trackAction(
            if (isEditMode) "edit_mode_on" else "edit_mode_off"
        )
    }

    private fun persistReorder() {
        val currentOrder = entityAdapter.getCurrentOrder()

        // Build the permutation array: order[newSlot] = oldSlot
        // currentOrder contains entity IDs in their new visual order
        // We need to map: for each slot, which old slot goes there
        val limit = EntityChipHelper.getEntityLimit(this)
        val order = IntArray(limit) { it } // identity
        for (i in currentOrder.indices) {
            order[i] = currentOrder[i]
        }
        // Fill remaining slots with identity mapping
        val usedSlots = currentOrder.toSet()
        var fillIdx = currentOrder.size
        for (slot in 0 until limit) {
            if (slot !in usedSlots && fillIdx < limit) {
                order[fillIdx] = slot
                fillIdx++
            }
        }

        TelemetryHelper.trackAction("reorder_entities", mapOf("order" to currentOrder.toString()))

        lifecycleScope.launch {
            try {
                Toast.makeText(this@MainActivity, getString(R.string.reorder_saving), Toast.LENGTH_SHORT).show()

                val body = mapOf<String, Any>(
                    "deviceId" to deviceManager.deviceId,
                    "deviceSecret" to deviceManager.deviceSecret,
                    "order" to order.toList()
                )
                val response = api.reorderEntities(body)

                if (response.success) {
                    // Migrate wallpaper positions, scales, and registered entity IDs
                    layoutPrefs.migrateEntityOrder(order)

                    // Update local avatar mappings to match new order
                    val oldAvatars = mutableMapOf<Int, String>()
                    for (i in currentOrder.indices) {
                        oldAvatars[currentOrder[i]] = avatarManager.getAvatar(currentOrder[i])
                    }
                    for (i in currentOrder.indices) {
                        avatarManager.setAvatar(i, oldAvatars[currentOrder[i]] ?: avatarManager.getAvatar(currentOrder[i]))
                    }

                    // Clear local chat cache (server has migrated entity_ids)
                    withContext(Dispatchers.IO) {
                        try {
                            ChatDatabase.getDao(this@MainActivity).clearAll()
                        } catch (e: Exception) {
                            Timber.w(e, "Failed to clear chat cache after reorder")
                        }
                    }

                    entityAdapter.markOrderSaved()
                    Toast.makeText(this@MainActivity, getString(R.string.reorder_success), Toast.LENGTH_SHORT).show()
                    delay(500)
                    loadBoundEntities()
                } else {
                    Toast.makeText(this@MainActivity, getString(R.string.reorder_failed), Toast.LENGTH_SHORT).show()
                    loadBoundEntities() // reload to reset visual order
                }
            } catch (e: Exception) {
                TelemetryHelper.trackError(e, mapOf("action" to "reorder_entities"))
                Timber.e(e, "Failed to reorder entities")
                Toast.makeText(this@MainActivity, getString(R.string.reorder_failed), Toast.LENGTH_SHORT).show()
                loadBoundEntities() // reload to reset visual order
            }
        }
    }

    private fun refreshEntity(entity: EntityStatus, button: MaterialButton) {
        val originalText = button.text
        button.isEnabled = false
        button.text = getString(R.string.refreshing)

        TelemetryHelper.trackAction("refresh_entity", mapOf("entityId" to entity.entityId))

        lifecycleScope.launch {
            try {
                val body = mapOf<String, Any>(
                    "deviceId" to deviceManager.deviceId,
                    "deviceSecret" to deviceManager.deviceSecret,
                    "entityId" to entity.entityId
                )
                val response = api.refreshEntity(body)

                if (response.success) {
                    Toast.makeText(
                        this@MainActivity,
                        getString(R.string.refresh_success),
                        Toast.LENGTH_SHORT
                    ).show()
                    delay(500)
                    loadBoundEntities()
                } else if (response.webhookBroken) {
                    // Webhook is broken — offer to rebind
                    TelemetryHelper.trackAction("refresh_webhook_broken", mapOf(
                        "entityId" to entity.entityId,
                        "error" to (response.error ?: "unknown")
                    ))
                    showWebhookBrokenDialog(entity, response.error)
                } else {
                    Toast.makeText(
                        this@MainActivity,
                        response.error ?: getString(R.string.failed_format, "Unknown"),
                        Toast.LENGTH_SHORT
                    ).show()
                }
            } catch (e: HttpException) {
                if (e.code() == 429) {
                    // Cooldown
                    try {
                        val errorBody = e.response()?.errorBody()?.string() ?: ""
                        val remaining = Regex(""""cooldown_remaining"\s*:\s*(\d+)""")
                            .find(errorBody)?.groupValues?.get(1)?.toIntOrNull() ?: 60
                        Toast.makeText(
                            this@MainActivity,
                            getString(R.string.refresh_cooldown, remaining),
                            Toast.LENGTH_SHORT
                        ).show()
                    } catch (_: Exception) {
                        Toast.makeText(this@MainActivity, getString(R.string.refresh_cooldown, 60), Toast.LENGTH_SHORT).show()
                    }
                } else {
                    TelemetryHelper.trackError(e, mapOf("action" to "refresh_entity"))
                    Toast.makeText(
                        this@MainActivity,
                        getString(R.string.failed_format, e.message),
                        Toast.LENGTH_LONG
                    ).show()
                }
            } catch (e: Exception) {
                TelemetryHelper.trackError(e, mapOf("action" to "refresh_entity"))
                Timber.e(e, "Failed to refresh entity")
                Toast.makeText(
                    this@MainActivity,
                    getString(R.string.failed_format, e.message),
                    Toast.LENGTH_LONG
                ).show()
            } finally {
                button.isEnabled = true
                button.text = originalText
            }
        }
    }

    private fun showWebhookBrokenDialog(entity: EntityStatus, errorMsg: String?) {
        val displayName = entity.name ?: getString(R.string.entity_format, entity.entityId)
        AlertDialog.Builder(this)
            .setTitle(getString(R.string.refresh_webhook_broken_title))
            .setMessage("${getString(R.string.refresh_webhook_broken_message)}\n\n${errorMsg ?: ""}")
            .setPositiveButton(getString(R.string.rebind)) { _, _ ->
                startActivity(Intent(this, OfficialBorrowActivity::class.java))
            }
            .setNegativeButton(getString(R.string.cancel), null)
            .show()
    }

    private fun showAvatarPicker(entityId: Int, iconView: TextView) {
        val dialogView = LayoutInflater.from(this).inflate(R.layout.dialog_avatar_picker, null)
        val grid = dialogView.findViewById<GridLayout>(R.id.avatarGrid)
        val subtitle = dialogView.findViewById<TextView>(R.id.tvAvatarSubtitle)
        subtitle.text = getString(R.string.avatar_subtitle, entityId)

        val dialog = AlertDialog.Builder(this)
            .setView(dialogView)
            .create()

        val currentAvatar = avatarManager.getAvatar(entityId)

        // Show current image avatar preview if applicable
        val imgPreview = dialogView.findViewById<ImageView>(R.id.imgCurrentAvatar)
        if (avatarManager.isImageUrl(currentAvatar)) {
            imgPreview.visibility = android.view.View.VISIBLE
            com.bumptech.glide.Glide.with(this)
                .load(currentAvatar)
                .circleCrop()
                .into(imgPreview)
        }

        // Upload photo button
        val uploadBtn = dialogView.findViewById<com.google.android.material.button.MaterialButton>(R.id.btnUploadAvatar)
        uploadBtn.setOnClickListener {
            avatarPickerEntityId = entityId
            avatarPickerIconView = iconView
            dialog.dismiss()
            avatarPhotoLauncher.launch("image/*")
        }

        EntityAvatarManager.AVATAR_OPTIONS.forEach { avatar ->
            val tv = TextView(this).apply {
                text = avatar
                textSize = 28f
                gravity = android.view.Gravity.CENTER
                val size = (52 * resources.displayMetrics.density).toInt()
                val margin = (4 * resources.displayMetrics.density).toInt()
                layoutParams = GridLayout.LayoutParams().apply {
                    width = size
                    height = size
                    setMargins(margin, margin, margin, margin)
                }
                setBackgroundResource(
                    if (avatar == currentAvatar) R.drawable.badge_background
                    else android.R.color.transparent
                )
                setOnClickListener {
                    avatarManager.setAvatar(entityId, avatar)
                    iconView.text = avatar
                    dialog.dismiss()
                    // #64: Upload avatar to server for cross-device sync
                    lifecycleScope.launch {
                        try {
                            api.updateEntityAvatar(UpdateAvatarRequest(
                                deviceId = deviceManager.deviceId,
                                deviceSecret = deviceManager.deviceSecret,
                                entityId = entityId,
                                avatar = avatar
                            ))
                        } catch (_: Exception) { /* fire-and-forget */ }
                    }
                }
            }
            grid.addView(tv)
        }

        dialog.show()
    }

    private fun uploadAvatarPhoto(uri: android.net.Uri, entityId: Int, iconView: TextView?) {
        lifecycleScope.launch {
            try {
                val inputStream = contentResolver.openInputStream(uri) ?: return@launch
                val bytes = inputStream.readBytes()
                inputStream.close()

                val requestFile = okhttp3.RequestBody.create(
                    okhttp3.MediaType.parse("image/jpeg"), bytes
                )
                val filePart = okhttp3.MultipartBody.Part.createFormData("file", "avatar.jpg", requestFile)
                val deviceIdPart = okhttp3.RequestBody.create(okhttp3.MediaType.parse("text/plain"), deviceManager.deviceId)
                val secretPart = okhttp3.RequestBody.create(okhttp3.MediaType.parse("text/plain"), deviceManager.deviceSecret)
                val entityIdPart = okhttp3.RequestBody.create(okhttp3.MediaType.parse("text/plain"), entityId.toString())

                val response = withContext(Dispatchers.IO) {
                    api.uploadEntityAvatar(filePart, deviceIdPart, secretPart, entityIdPart)
                }

                if (response.success && response.avatar != null) {
                    avatarManager.setAvatar(entityId, response.avatar)
                    android.widget.Toast.makeText(this@MainActivity, R.string.avatar_upload_success, android.widget.Toast.LENGTH_SHORT).show()
                    // Refresh UI
                    viewModel.loadEntities(deviceManager.deviceId, deviceManager.deviceSecret)
                } else {
                    android.widget.Toast.makeText(this@MainActivity, R.string.avatar_upload_failed, android.widget.Toast.LENGTH_SHORT).show()
                }
            } catch (e: Exception) {
                Timber.e(e, "[Avatar] Upload failed")
                android.widget.Toast.makeText(this@MainActivity, R.string.avatar_upload_failed, android.widget.Toast.LENGTH_SHORT).show()
            }
        }
    }

    private fun showRenameDialog(entity: EntityStatus) {
        val currentName = entity.name ?: getString(R.string.entity_format, entity.entityId)
        val editText = android.widget.EditText(this).apply {
            setText(currentName)
            hint = getString(R.string.rename_hint)
            filters = arrayOf(android.text.InputFilter.LengthFilter(20))
            setSingleLine()
            val pad = (16 * resources.displayMetrics.density).toInt()
            setPadding(pad, pad, pad, pad)
        }

        AlertDialog.Builder(this)
            .setTitle(getString(R.string.rename_title))
            .setView(editText)
            .setPositiveButton(android.R.string.ok) { _, _ ->
                val newName = editText.text.toString().trim()
                if (newName.isNotEmpty() && newName != currentName) {
                    renameEntity(entity, newName)
                }
            }
            .setNegativeButton(getString(R.string.cancel), null)
            .show()

        editText.requestFocus()
        editText.selectAll()
    }

    private fun renameEntity(entity: EntityStatus, newName: String) {
        val loadingDialog = android.app.AlertDialog.Builder(this)
            .setMessage(getString(R.string.rename_saving))
            .setCancelable(false)
            .create()
        loadingDialog.show()

        lifecycleScope.launch {
            try {
                val body = mapOf<String, Any>(
                    "deviceId" to deviceManager.deviceId,
                    "deviceSecret" to deviceManager.deviceSecret,
                    "entityId" to entity.entityId,
                    "name" to newName
                )
                val response = api.renameEntity(body)

                if (response.success) {
                    Toast.makeText(
                        this@MainActivity,
                        getString(R.string.rename_success),
                        Toast.LENGTH_SHORT
                    ).show()
                    loadBoundEntities()
                } else {
                    Toast.makeText(
                        this@MainActivity,
                        getString(R.string.failed_format, response.message),
                        Toast.LENGTH_SHORT
                    ).show()
                }
            } catch (e: Exception) {
                Timber.e(e, "Failed to rename entity")
                Toast.makeText(
                    this@MainActivity,
                    getString(R.string.failed_format, e.message),
                    Toast.LENGTH_LONG
                ).show()
            } finally {
                loadingDialog.dismiss()
            }
        }
    }

    private fun showXdSettingsDialog(entity: EntityStatus) {
        val dialogView = LayoutInflater.from(this).inflate(R.layout.dialog_xd_settings, null)
        val etPreInject = dialogView.findViewById<com.google.android.material.textfield.TextInputEditText>(R.id.etPreInject)
        val etForbidden = dialogView.findViewById<com.google.android.material.textfield.TextInputEditText>(R.id.etForbiddenWords)
        val etRateLimit = dialogView.findViewById<com.google.android.material.textfield.TextInputEditText>(R.id.etRateLimit)
        val etBlacklist = dialogView.findViewById<com.google.android.material.textfield.TextInputEditText>(R.id.etBlacklist)
        val switchWhitelist = dialogView.findViewById<com.google.android.material.switchmaterial.SwitchMaterial>(R.id.switchWhitelistEnabled)
        val etWhitelist = dialogView.findViewById<com.google.android.material.textfield.TextInputEditText>(R.id.etWhitelist)
        val etRejectMsg = dialogView.findViewById<com.google.android.material.textfield.TextInputEditText>(R.id.etRejectMessage)
        val cbText = dialogView.findViewById<android.widget.CheckBox>(R.id.cbMediaText)
        val cbPhoto = dialogView.findViewById<android.widget.CheckBox>(R.id.cbMediaPhoto)
        val cbVoice = dialogView.findViewById<android.widget.CheckBox>(R.id.cbMediaVoice)
        val cbVideo = dialogView.findViewById<android.widget.CheckBox>(R.id.cbMediaVideo)
        val cbFile = dialogView.findViewById<android.widget.CheckBox>(R.id.cbMediaFile)

        // Load current settings
        lifecycleScope.launch {
            try {
                val resp = api.getCrossDeviceSettings(
                    deviceManager.deviceId, deviceManager.deviceSecret, entity.entityId
                )
                if (resp.success && resp.settings != null) {
                    val s = resp.settings
                    etPreInject.setText(s.pre_inject)
                    etForbidden.setText(s.forbidden_words.joinToString(", "))
                    etRateLimit.setText(s.rate_limit_seconds.toString())
                    etBlacklist.setText(s.blacklist.joinToString(", "))
                    switchWhitelist.isChecked = s.whitelist_enabled
                    etWhitelist.setText(s.whitelist.joinToString(", "))
                    etRejectMsg.setText(s.reject_message)
                    cbText.isChecked = "text" in s.allowed_media
                    cbPhoto.isChecked = "photo" in s.allowed_media
                    cbVoice.isChecked = "voice" in s.allowed_media
                    cbVideo.isChecked = "video" in s.allowed_media
                    cbFile.isChecked = "file" in s.allowed_media
                }
            } catch (e: Exception) {
                Timber.e(e, "Failed to load cross-device settings")
            }
        }

        val dialog = MaterialAlertDialogBuilder(this)
            .setTitle(getString(R.string.xd_settings_title))
            .setView(dialogView)
            .setPositiveButton(getString(R.string.xd_save), null)
            .setNegativeButton(getString(R.string.cancel), null)
            .setNeutralButton(getString(R.string.xd_reset), null)
            .create()

        dialog.show()

        dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
            val allowedMedia = mutableListOf<String>()
            if (cbText.isChecked) allowedMedia.add("text")
            if (cbPhoto.isChecked) allowedMedia.add("photo")
            if (cbVoice.isChecked) allowedMedia.add("voice")
            if (cbVideo.isChecked) allowedMedia.add("video")
            if (cbFile.isChecked) allowedMedia.add("file")

            val settings = mapOf<String, Any>(
                "pre_inject" to (etPreInject.text?.toString() ?: ""),
                "forbidden_words" to (etForbidden.text?.toString() ?: "").split(",").map { it.trim() }.filter { it.isNotEmpty() },
                "rate_limit_seconds" to (etRateLimit.text?.toString()?.toIntOrNull() ?: 0),
                "blacklist" to (etBlacklist.text?.toString() ?: "").split(",").map { it.trim() }.filter { it.isNotEmpty() },
                "whitelist_enabled" to switchWhitelist.isChecked,
                "whitelist" to (etWhitelist.text?.toString() ?: "").split(",").map { it.trim() }.filter { it.isNotEmpty() },
                "reject_message" to (etRejectMsg.text?.toString() ?: ""),
                "allowed_media" to allowedMedia
            )

            lifecycleScope.launch {
                try {
                    val body = mapOf<String, Any>(
                        "deviceId" to deviceManager.deviceId,
                        "deviceSecret" to deviceManager.deviceSecret,
                        "entityId" to entity.entityId,
                        "settings" to settings
                    )
                    val resp = api.updateCrossDeviceSettings(body)
                    if (resp.success) {
                        Toast.makeText(this@MainActivity, getString(R.string.xd_saved), Toast.LENGTH_SHORT).show()
                        dialog.dismiss()
                    } else {
                        Toast.makeText(this@MainActivity, resp.message ?: "Error", Toast.LENGTH_SHORT).show()
                    }
                } catch (e: Exception) {
                    Timber.e(e, "Failed to save cross-device settings")
                    Toast.makeText(this@MainActivity, getString(R.string.xd_save_failed), Toast.LENGTH_SHORT).show()
                }
            }
            TelemetryHelper.trackAction("xd_settings_save", mapOf("entityId" to entity.entityId.toString()))
        }

        dialog.getButton(AlertDialog.BUTTON_NEUTRAL).setOnClickListener {
            lifecycleScope.launch {
                try {
                    val body = mapOf(
                        "deviceId" to deviceManager.deviceId,
                        "deviceSecret" to deviceManager.deviceSecret,
                        "entityId" to entity.entityId.toString()
                    )
                    val resp = api.resetCrossDeviceSettings(body)
                    if (resp.success) {
                        Toast.makeText(this@MainActivity, getString(R.string.xd_reset_done), Toast.LENGTH_SHORT).show()
                        dialog.dismiss()
                    } else {
                        Toast.makeText(this@MainActivity, resp.message ?: "Error", Toast.LENGTH_SHORT).show()
                    }
                } catch (e: Exception) {
                    Timber.e(e, "Failed to reset cross-device settings")
                }
            }
            TelemetryHelper.trackAction("xd_settings_reset", mapOf("entityId" to entity.entityId.toString()))
        }
    }

    // ── Agent Card Dialog ──

    private fun showAgentCardDialog(entityId: Int) {
        lifecycleScope.launch {
            try {
                val response = api.getAgentCard(
                    deviceId = deviceManager.deviceId,
                    deviceSecret = deviceManager.deviceSecret,
                    entityId = entityId
                )
                showAgentCardEditDialog(entityId, response.agentCard)
            } catch (e: Exception) {
                Timber.w(e, "No agent card found, showing empty form")
                showAgentCardEditDialog(entityId, null)
            }
        }
    }

    private fun showAgentCardEditDialog(entityId: Int, card: com.hank.clawlive.data.model.AgentCard?) {
        val scrollView = android.widget.ScrollView(this).apply {
            setPadding(dp(16), dp(8), dp(16), dp(8))
        }
        val layout = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        scrollView.addView(layout)

        fun addField(hint: String, value: String?, inputType: Int = android.text.InputType.TYPE_CLASS_TEXT,
                     maxLength: Int = 0): com.google.android.material.textfield.TextInputEditText {
            val til = com.google.android.material.textfield.TextInputLayout(this).apply {
                this.hint = hint
                boxBackgroundMode = com.google.android.material.textfield.TextInputLayout.BOX_BACKGROUND_OUTLINE
                if (maxLength > 0) { counterMaxLength = maxLength; isCounterEnabled = true }
            }
            val et = com.google.android.material.textfield.TextInputEditText(this).apply {
                this.inputType = inputType
                setText(value ?: "")
            }
            til.addView(et)
            layout.addView(til, LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply { bottomMargin = dp(12) })
            return et
        }

        // ── Basic Info ──
        val descEdit = addField("Description", card?.description,
            android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_FLAG_MULTI_LINE,
            maxLength = 500)
        val versionEdit = addField("Version", card?.version)
        val websiteEdit = addField("Website", card?.website,
            android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_URI)
        val emailEdit = addField("Contact Email", card?.contactEmail,
            android.text.InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS)

        // ── Capabilities (dynamic rows) ──
        layout.addView(dialogSectionTitle(getString(R.string.card_holder_capabilities)))
        val capsContainer = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        (card?.capabilities ?: emptyList()).forEach { cap ->
            capsContainer.addView(buildCapabilityRowForDialog(cap.name, cap.description, capsContainer))
        }
        layout.addView(capsContainer)
        layout.addView(TextView(this).apply {
            text = "+ ${getString(R.string.card_holder_add_capability)}"
            setTextColor(android.graphics.Color.parseColor("#6C63FF"))
            textSize = 13f
            setPadding(0, dp(4), 0, dp(8))
            setOnClickListener {
                if (capsContainer.childCount < 10) {
                    capsContainer.addView(buildCapabilityRowForDialog("", "", capsContainer))
                } else {
                    Toast.makeText(this@MainActivity, "Maximum 10 capabilities", Toast.LENGTH_SHORT).show()
                }
            }
        })

        // ── Protocols (chip UI) ──
        layout.addView(dialogSectionTitle(getString(R.string.card_holder_protocols)))
        val protosChipContainer = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
        }
        val protosFlow = android.widget.HorizontalScrollView(this).apply {
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
            isHorizontalScrollBarEnabled = false
        }
        protosFlow.addView(protosChipContainer)
        (card?.protocols ?: emptyList()).forEach { p ->
            protosChipContainer.addView(makeChipForDialog(p, protosChipContainer))
        }
        layout.addView(protosFlow)
        layout.addView(makeChipInputForDialog(protosChipContainer, 10))

        // ── Tags (chip UI) ──
        layout.addView(dialogSectionTitle(getString(R.string.card_holder_tags)))
        val tagsChipContainer = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
        }
        val tagsFlow = android.widget.HorizontalScrollView(this).apply {
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
            isHorizontalScrollBarEnabled = false
        }
        tagsFlow.addView(tagsChipContainer)
        (card?.tags ?: emptyList()).forEach { t ->
            tagsChipContainer.addView(makeChipForDialog(t, tagsChipContainer))
        }
        layout.addView(tagsFlow)
        layout.addView(makeChipInputForDialog(tagsChipContainer, 20))

        MaterialAlertDialogBuilder(this)
            .setTitle("Agent Card — Entity #$entityId")
            .setView(scrollView)
            .setPositiveButton("Save") { _, _ ->
                saveAgentCard(entityId,
                    descEdit.text.toString().trim(),
                    collectCapabilitiesFromDialog(capsContainer),
                    collectChipsFromDialog(protosChipContainer),
                    collectChipsFromDialog(tagsChipContainer),
                    versionEdit.text.toString().trim(),
                    websiteEdit.text.toString().trim(),
                    emailEdit.text.toString().trim())
            }
            .setNegativeButton("Cancel", null)
            .setNeutralButton("Delete") { _, _ ->
                MaterialAlertDialogBuilder(this)
                    .setTitle("Delete Agent Card?")
                    .setMessage("This action cannot be undone.")
                    .setPositiveButton("Delete") { _, _ -> deleteAgentCard(entityId) }
                    .setNegativeButton("Cancel", null)
                    .show()
            }
            .show()
    }

    private fun dialogSectionTitle(text: String): TextView {
        return TextView(this).apply {
            this.text = text
            setTextColor(android.graphics.Color.parseColor("#AAAAAA"))
            textSize = 12f
            typeface = android.graphics.Typeface.DEFAULT_BOLD
            setPadding(0, dp(4), 0, dp(4))
        }
    }

    private fun buildCapabilityRowForDialog(name: String, desc: String,
                                             container: LinearLayout): LinearLayout {
        return LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            val lp = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
            lp.setMargins(0, dp(4), 0, 0)
            layoutParams = lp
            background = android.graphics.drawable.GradientDrawable().apply {
                setColor(android.graphics.Color.parseColor("#252540"))
                cornerRadius = dp(6).toFloat()
                setStroke(1, android.graphics.Color.parseColor("#333355"))
            }
            setPadding(dp(8), dp(6), dp(8), dp(6))

            val nameField = EditText(this@MainActivity).apply {
                setText(name)
                hint = "Name"
                setTextColor(android.graphics.Color.WHITE)
                setHintTextColor(android.graphics.Color.parseColor("#555555"))
                textSize = 12f
                maxLines = 1
                inputType = InputType.TYPE_CLASS_TEXT
                background = null
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            }
            val descField = EditText(this@MainActivity).apply {
                setText(desc)
                hint = "Description"
                setTextColor(android.graphics.Color.parseColor("#AAAAAA"))
                setHintTextColor(android.graphics.Color.parseColor("#555555"))
                textSize = 12f
                maxLines = 1
                inputType = InputType.TYPE_CLASS_TEXT
                background = null
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            }
            val removeBtn = TextView(this@MainActivity).apply {
                text = "\u00D7"
                setTextColor(android.graphics.Color.parseColor("#F44336"))
                textSize = 16f
                setPadding(dp(6), 0, dp(2), 0)
                setOnClickListener { container.removeView(this@apply.parent as? View) }
            }
            addView(nameField)
            addView(descField)
            addView(removeBtn)
        }
    }

    private fun makeChipForDialog(text: String, container: LinearLayout): TextView {
        return TextView(this).apply {
            this.text = "$text \u00D7"
            setTextColor(android.graphics.Color.WHITE)
            textSize = 12f
            background = android.graphics.drawable.GradientDrawable().apply {
                setColor(android.graphics.Color.parseColor("#333355"))
                cornerRadius = dp(12).toFloat()
            }
            setPadding(dp(10), dp(4), dp(10), dp(4))
            val lp = LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT)
            lp.setMargins(0, dp(2), dp(4), dp(2))
            layoutParams = lp
            tag = text
            setOnClickListener { container.removeView(this) }
        }
    }

    private fun makeChipInputForDialog(chipContainer: LinearLayout, maxItems: Int): LinearLayout {
        return LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            val lp = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
            lp.setMargins(0, dp(4), 0, dp(8))
            layoutParams = lp

            val input = EditText(this@MainActivity).apply {
                hint = getString(R.string.card_holder_tags_hint)
                setTextColor(android.graphics.Color.WHITE)
                setHintTextColor(android.graphics.Color.parseColor("#555555"))
                textSize = 12f
                maxLines = 1
                inputType = InputType.TYPE_CLASS_TEXT
                background = android.graphics.drawable.GradientDrawable().apply {
                    setColor(android.graphics.Color.parseColor("#252540"))
                    cornerRadius = dp(6).toFloat()
                    setStroke(1, android.graphics.Color.parseColor("#333355"))
                }
                setPadding(dp(10), dp(6), dp(10), dp(6))
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            }
            val addBtn = TextView(this@MainActivity).apply {
                text = "+"
                setTextColor(android.graphics.Color.parseColor("#6C63FF"))
                textSize = 16f
                typeface = android.graphics.Typeface.DEFAULT_BOLD
                gravity = Gravity.CENTER
                setPadding(dp(10), dp(4), dp(10), dp(4))
                setOnClickListener {
                    val v = input.text.toString().trim()
                    if (v.isEmpty()) return@setOnClickListener
                    if (chipContainer.childCount >= maxItems) {
                        Toast.makeText(this@MainActivity, "Maximum $maxItems items", Toast.LENGTH_SHORT).show()
                        return@setOnClickListener
                    }
                    chipContainer.addView(makeChipForDialog(v, chipContainer))
                    input.text.clear()
                }
            }
            addView(input)
            addView(addBtn)
        }
    }

    private fun collectCapabilitiesFromDialog(container: LinearLayout): List<Map<String, String>> {
        val caps = mutableListOf<Map<String, String>>()
        for (i in 0 until container.childCount) {
            val row = container.getChildAt(i) as? LinearLayout ?: continue
            val name = (row.getChildAt(0) as? EditText)?.text?.toString()?.trim() ?: ""
            val desc = (row.getChildAt(1) as? EditText)?.text?.toString()?.trim() ?: ""
            if (name.isNotEmpty()) {
                caps.add(mapOf("id" to name.lowercase().replace(" ", "-"), "name" to name, "description" to desc))
            }
        }
        return caps
    }

    private fun collectChipsFromDialog(container: LinearLayout): List<String> {
        val items = mutableListOf<String>()
        for (i in 0 until container.childCount) {
            val chip = container.getChildAt(i)
            val t = chip.tag as? String
            if (!t.isNullOrEmpty()) items.add(t)
        }
        return items
    }

    private fun saveAgentCard(entityId: Int, description: String,
                              capabilities: List<Map<String, String>>, protocols: List<String>,
                              tags: List<String>, version: String, website: String, email: String) {
        if (description.isEmpty()) {
            Toast.makeText(this, "Description is required", Toast.LENGTH_SHORT).show()
            return
        }

        lifecycleScope.launch {
            try {
                val body = mapOf<String, Any>(
                    "deviceId" to deviceManager.deviceId,
                    "deviceSecret" to deviceManager.deviceSecret,
                    "entityId" to entityId,
                    "agentCard" to mapOf("description" to description, "capabilities" to capabilities,
                        "protocols" to protocols, "tags" to tags, "version" to version,
                        "website" to website, "contactEmail" to email)
                )
                val response = api.updateAgentCard(body)
                if (response.success) {
                    Toast.makeText(this@MainActivity, "Agent Card saved", Toast.LENGTH_SHORT).show()
                } else {
                    Toast.makeText(this@MainActivity, response.message ?: "Save failed", Toast.LENGTH_SHORT).show()
                }
            } catch (e: Exception) {
                Timber.e(e, "Failed to save agent card")
                Toast.makeText(this@MainActivity, "Save failed: ${e.message}", Toast.LENGTH_SHORT).show()
            }
        }
    }

    private fun deleteAgentCard(entityId: Int) {
        lifecycleScope.launch {
            try {
                val body = mapOf<String, Any>(
                    "deviceId" to deviceManager.deviceId,
                    "deviceSecret" to deviceManager.deviceSecret,
                    "entityId" to entityId
                )
                val response = api.deleteAgentCard(body)
                if (response.success) {
                    Toast.makeText(this@MainActivity, "Agent Card deleted", Toast.LENGTH_SHORT).show()
                } else {
                    Toast.makeText(this@MainActivity, response.message ?: "Delete failed", Toast.LENGTH_SHORT).show()
                }
            } catch (e: Exception) {
                Timber.e(e, "Failed to delete agent card")
                Toast.makeText(this@MainActivity, "Delete failed: ${e.message}", Toast.LENGTH_SHORT).show()
            }
        }
    }

    private fun showRemoveConfirmDialog(entity: EntityStatus) {
        val displayName = entity.name ?: getString(R.string.entity_format, entity.entityId)

        AlertDialog.Builder(this)
            .setTitle(getString(R.string.remove_confirm_title))
            .setMessage(getString(R.string.remove_confirm_message, displayName, entity.entityId))
            .setPositiveButton(getString(R.string.remove_entity)) { _, _ ->
                // Second confirmation
                AlertDialog.Builder(this)
                    .setTitle(getString(R.string.remove_confirm_title))
                    .setMessage("⚠️ $displayName (#${entity.entityId})")
                    .setPositiveButton(getString(R.string.remove_entity)) { _, _ ->
                        removeEntity(entity)
                    }
                    .setNegativeButton(getString(R.string.cancel), null)
                    .show()
            }
            .setNegativeButton(getString(R.string.cancel), null)
            .show()
    }

    private fun removeEntity(entity: EntityStatus) {
        lifecycleScope.launch {
            try {
                val body = mapOf(
                    "deviceId" to deviceManager.deviceId,
                    "deviceSecret" to deviceManager.deviceSecret
                )
                val response = api.deleteEntityPermanent(entity.entityId, body)

                if (response.isSuccessful) {
                    layoutPrefs.removeRegisteredEntity(entity.entityId)
                    val displayName = entity.name ?: getString(R.string.entity_format, entity.entityId)
                    Toast.makeText(
                        this@MainActivity,
                        getString(R.string.entity_removed, displayName),
                        Toast.LENGTH_SHORT
                    ).show()
                    delay(500)
                    loadBoundEntities()
                } else {
                    val errorBody = response.errorBody()?.string() ?: "Unknown error"
                    Toast.makeText(
                        this@MainActivity,
                        getString(R.string.failed_format, errorBody),
                        Toast.LENGTH_SHORT
                    ).show()
                }
            } catch (e: Exception) {
                Timber.e(e, "Failed to delete entity")
                Toast.makeText(
                    this@MainActivity,
                    getString(R.string.failed_format, e.message),
                    Toast.LENGTH_LONG
                ).show()
            }
        }
    }

    private fun observeUiState() {
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                viewModel.uiState.collect { state ->
                    updateBindingUi(state)
                }
            }
        }
    }

    private fun updateBindingUi(state: com.hank.clawlive.ui.BindingUiState) {
        // Update chip selection
        val selectedChip = entityChips[state.selectedEntityId] ?: entityChips[0]
        val selectedChipId = selectedChip?.id ?: return
        if (chipGroupEntity.checkedChipId != selectedChipId) {
            chipGroupEntity.check(selectedChipId)
        }

        // Loading state
        if (state.isLoading) {
            progressBar.visibility = View.VISIBLE
            btnGenerateCode.visibility = View.GONE
        } else {
            progressBar.visibility = View.GONE
            btnGenerateCode.visibility = View.VISIBLE
        }

        // Binding code
        if (state.bindingCode != null) {
            tvBindingCode.text = formatBindingCode(state.bindingCode)
            tvCountdown.text = getString(R.string.expires_in, state.remainingSeconds)
            btnGenerateCode.text = getString(R.string.regenerate)
        } else {
            tvBindingCode.text = getString(R.string.code_placeholder)
            tvCountdown.text = getString(R.string.tap_to_generate_code)
            btnGenerateCode.text = getString(R.string.generate)
        }

        // Refresh entities when bound status changes
        if (state.isBound) {
            loadBoundEntities()
        }

        // Error handling
        if (state.error != null) {
            Toast.makeText(this, state.error, Toast.LENGTH_LONG).show()
            viewModel.clearError()
        }
    }

    private fun copyFullCommand() {
        val state = viewModel.uiState.value
        if (state.bindingCode != null) {
            val command = generateOpenClawCommand(state.bindingCode)
            copyToClipboard(command)
            Toast.makeText(this, getString(R.string.command_copied), Toast.LENGTH_SHORT).show()
        }
    }

    private fun generateOpenClawCommand(code: String): String {
        val appVersion = deviceManager.appVersion
        return """
Connect my E-Claw wallpaper device (v$appVersion):
POST $API_BASE_URL/api/bind
Body: {"code": "$code"}

IMPORTANT: The response will contain a 'skills_documentation' field. You MUST read the 'E-claw MCP Skills' documentation within it to understand the interaction protocol (Matrix Architecture, Push Mode, etc.).

After binding, use these tools:
- update_claw_status: Update wallpaper state
- get_claw_status: Check current status
        """.trimIndent()
    }

    private fun formatBindingCode(code: String): String {
        return if (code.length == 6) {
            "${code.substring(0, 3)} ${code.substring(3)}"
        } else {
            code
        }
    }

    private fun copyToClipboard(text: String) {
        val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        val clip = ClipData.newPlainText("OpenClaw Command", text)
        clipboard.setPrimaryClip(clip)
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

}
