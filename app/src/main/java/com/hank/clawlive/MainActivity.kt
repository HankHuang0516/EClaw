package com.hank.clawlive

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.os.Bundle
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
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
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
import com.google.android.material.card.MaterialCardView
import com.google.android.material.chip.ChipGroup
import com.hank.clawlive.data.local.DeviceManager
import com.hank.clawlive.data.local.EntityAvatarManager
import com.hank.clawlive.data.local.LayoutPreferences
import com.hank.clawlive.data.local.UsageManager
import com.hank.clawlive.data.model.EntityStatus
import com.hank.clawlive.data.remote.NetworkModule
import com.hank.clawlive.data.remote.TelemetryHelper
import com.hank.clawlive.data.repository.StateRepository
import com.hank.clawlive.ui.EntityCardAdapter
import com.hank.clawlive.ui.MainViewModel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
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
        private const val API_BASE_URL = "https://eclaw.up.railway.app"
        private const val FREE_ENTITY_LIMIT = 4
        private const val PREMIUM_ENTITY_LIMIT = 8
    }

    // UI elements
    private lateinit var btnSettings: ImageButton
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
    private lateinit var btnChat: MaterialButton
    private lateinit var btnSetWallpaper: MaterialButton
    private lateinit var topBar: LinearLayout
    private lateinit var bottomActions: LinearLayout
    private lateinit var tvEntityCount: TextView
    // Phase 9: AI Usage Status Bar
    private lateinit var usageStatusBar: LinearLayout
    private lateinit var tvUsageLabel: TextView
    private lateinit var progressUsage: ProgressBar
    private lateinit var tvUsageStatus: TextView
    private lateinit var btnOfficialBorrow: MaterialButton

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

        // Enable edge-to-edge display
        WindowCompat.setDecorFitsSystemWindows(window, false)

        setContentView(R.layout.activity_main)

        initViews()
        setupEdgeToEdgeInsets()
        setupClickListeners()
        observeUiState()
        startEntityPolling()
    }

    override fun onResume() {
        super.onResume()
        TelemetryHelper.trackPageView(this, "main")
        loadBoundEntities()
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

    private fun initViews() {
        btnSettings = findViewById(R.id.btnSettings)
        btnEditMode = findViewById(R.id.btnEditMode)
        agentCardsContainer = findViewById(R.id.agentCardsContainer)
        emptyStateContainer = findViewById(R.id.emptyStateContainer)
        cardAddEntity = findViewById(R.id.cardAddEntity)
        addEntityHeader = findViewById(R.id.addEntityHeader)
        addEntityContent = findViewById(R.id.addEntityContent)
        ivExpandArrow = findViewById(R.id.ivExpandArrow)
        chipGroupEntity = findViewById(R.id.chipGroupEntity)
        tvBindingCode = findViewById(R.id.tvBindingCode)
        tvCountdown = findViewById(R.id.tvCountdown)
        btnGenerateCode = findViewById(R.id.btnGenerateCode)
        btnCopyCommand = findViewById(R.id.btnCopyCommand)
        progressBar = findViewById(R.id.progressBar)
        btnChat = findViewById(R.id.btnChat)
        btnSetWallpaper = findViewById(R.id.btnSetWallpaper)
        topBar = findViewById(R.id.topBar)
        bottomActions = findViewById(R.id.bottomActions)
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
            onRemoveClick = { entity -> showRemoveConfirmDialog(entity) }
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

            bottomActions.updatePadding(
                left = insets.left + 16.dpToPx(),
                right = insets.right + 16.dpToPx(),
                bottom = insets.bottom + 16.dpToPx()
            )

            WindowInsetsCompat.CONSUMED
        }
    }

    private fun Int.dpToPx(): Int {
        return (this * resources.displayMetrics.density).toInt()
    }

    private fun setupClickListeners() {
        btnEditMode.setOnClickListener {
            toggleEditMode()
        }

        btnSettings.setOnClickListener {
            startActivity(Intent(this, SettingsActivity::class.java))
        }

        btnSetWallpaper.setOnClickListener {
            openWallpaperPicker()
        }

        btnChat.setOnClickListener {
            startActivity(Intent(this, ChatActivity::class.java))
        }

        findViewById<MaterialButton>(R.id.btnMission).setOnClickListener {
            startActivity(Intent(this, MissionControlActivity::class.java))
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

        btnOfficialBorrow.setOnClickListener {
            startActivity(Intent(this, OfficialBorrowActivity::class.java))
        }

        // Entity selection chips
        chipGroupEntity.setOnCheckedStateChangeListener { _, checkedIds ->
            if (checkedIds.isNotEmpty()) {
                val selectedEntityId = when (checkedIds[0]) {
                    R.id.chipEntity0 -> 0
                    R.id.chipEntity1 -> 1
                    R.id.chipEntity2 -> 2
                    R.id.chipEntity3 -> 3
                    else -> 0
                }
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
                boundEntities = response.entities.filter { it.isBound }
                updateAgentCards()
                updateEntityCount()
                updateUsageStatusBar()  // Phase 9: Update usage bar
            } catch (e: Exception) {
                Timber.e(e, "Failed to load entities")
            }
        }
    }

    private fun updateEntityCount() {
        val maxEntities = if (usageManager.isPremium) PREMIUM_ENTITY_LIMIT else FREE_ENTITY_LIMIT
        tvEntityCount.text = getString(R.string.entity_count_format, boundEntities.size, maxEntities)
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
        return when (chipGroupEntity.checkedChipId) {
            R.id.chipEntity0 -> 0
            R.id.chipEntity1 -> 1
            R.id.chipEntity2 -> 2
            R.id.chipEntity3 -> 3
            else -> 0
        }
    }

    private fun updateAgentCards() {
        // During edit mode, skip ALL UI updates to preserve drag state and prevent
        // transient API responses from hiding entity cards (fixes #16)
        if (isEditMode) return

        if (boundEntities.isEmpty()) {
            agentCardsContainer.visibility = View.GONE
            emptyStateContainer.visibility = View.VISIBLE
            btnEditMode.visibility = View.GONE
            // Auto-expand add entity section when empty
            if (!isAddEntityExpanded) {
                toggleAddEntitySection()
            }
        } else {
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
        // We need to map: for each of 4 slots, which old slot goes there
        val order = IntArray(FREE_ENTITY_LIMIT) { it } // identity
        for (i in currentOrder.indices) {
            order[i] = currentOrder[i]
        }
        // Fill remaining slots with identity mapping
        val usedSlots = currentOrder.toSet()
        var fillIdx = currentOrder.size
        for (slot in 0 until FREE_ENTITY_LIMIT) {
            if (slot !in usedSlots && fillIdx < FREE_ENTITY_LIMIT) {
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
                    // Update local avatar mappings to match new order
                    val oldAvatars = mutableMapOf<Int, String>()
                    for (i in currentOrder.indices) {
                        oldAvatars[currentOrder[i]] = avatarManager.getAvatar(currentOrder[i])
                    }
                    for (i in currentOrder.indices) {
                        avatarManager.setAvatar(i, oldAvatars[currentOrder[i]] ?: avatarManager.getAvatar(currentOrder[i]))
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
                }
            }
            grid.addView(tv)
        }

        dialog.show()
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
                val body = mapOf<String, Any>(
                    "deviceId" to deviceManager.deviceId,
                    "deviceSecret" to deviceManager.deviceSecret,
                    "entityId" to entity.entityId
                )
                val response = api.removeEntityByDevice(body)

                if (response.success) {
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
                    Toast.makeText(
                        this@MainActivity,
                        getString(R.string.failed_format, response.message),
                        Toast.LENGTH_SHORT
                    ).show()
                }
            } catch (e: Exception) {
                Timber.e(e, "Failed to remove entity")
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
        val selectedChipId = when (state.selectedEntityId) {
            0 -> R.id.chipEntity0
            1 -> R.id.chipEntity1
            2 -> R.id.chipEntity2
            3 -> R.id.chipEntity3
            else -> R.id.chipEntity0
        }
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

    private fun openWallpaperPicker() {
        startActivity(Intent(this, WallpaperPreviewActivity::class.java))
    }
}
