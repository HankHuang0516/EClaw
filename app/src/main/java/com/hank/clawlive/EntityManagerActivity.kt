package com.hank.clawlive

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
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
import com.hank.clawlive.data.model.AgentCard
import com.hank.clawlive.data.model.AgentCardCapability
import com.hank.clawlive.data.model.EntityStatus
import com.hank.clawlive.data.model.MultiEntityResponse
import android.text.InputType
import android.widget.EditText
import android.widget.ScrollView
import com.google.android.material.textfield.TextInputEditText
import com.google.android.material.textfield.TextInputLayout
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

        // Public code (cross-device messaging)
        val tvPublicCode = cardView.findViewById<TextView>(R.id.tvPublicCode)
        if (!entity.publicCode.isNullOrBlank()) {
            tvPublicCode.visibility = View.VISIBLE
            tvPublicCode.text = getString(R.string.entity_public_code, entity.publicCode)
            tvPublicCode.setOnClickListener {
                val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                clipboard.setPrimaryClip(ClipData.newPlainText("Public Code", entity.publicCode))
                Toast.makeText(this, R.string.code_copied, Toast.LENGTH_SHORT).show()
            }
        }

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

        // Agent Card button
        val btnAgentCard = cardView.findViewById<MaterialButton>(R.id.btnAgentCard)
        btnAgentCard.setOnClickListener {
            showAgentCardDialog(entity.entityId)
        }

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

    // ── Agent Card Dialog ──

    private fun showAgentCardDialog(entityId: Int) {
        lifecycleScope.launch {
            try {
                val response = api.getAgentCard(
                    deviceId = deviceManager.deviceId,
                    deviceSecret = deviceManager.deviceSecret,
                    entityId = entityId
                )
                val card = response.agentCard
                showAgentCardEditDialog(entityId, card)
            } catch (e: Exception) {
                // No existing card — show empty form
                Timber.w(e, "No agent card found, showing empty form")
                showAgentCardEditDialog(entityId, null)
            }
        }
    }

    private fun showAgentCardEditDialog(entityId: Int, card: AgentCard?) {
        val dp = { px: Int -> (px * resources.displayMetrics.density).toInt() }

        val scrollView = ScrollView(this).apply {
            setPadding(dp(16), dp(8), dp(16), dp(8))
        }
        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
        }
        scrollView.addView(layout)

        // Description
        val descLayout = TextInputLayout(this).apply {
            hint = "Description"
            boxBackgroundMode = TextInputLayout.BOX_BACKGROUND_OUTLINE
            counterMaxLength = 500
            isCounterEnabled = true
        }
        val descEdit = TextInputEditText(this).apply {
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE
            maxLines = 4
            setText(card?.description ?: "")
        }
        descLayout.addView(descEdit)
        layout.addView(descLayout, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT
        ).apply { bottomMargin = dp(12) })

        // Capabilities (simplified: comma-separated names)
        val capsLayout = TextInputLayout(this).apply {
            hint = "Capabilities (comma-separated names)"
            boxBackgroundMode = TextInputLayout.BOX_BACKGROUND_OUTLINE
            helperText = "e.g. chat, search, translate"
        }
        val capsEdit = TextInputEditText(this).apply {
            inputType = InputType.TYPE_CLASS_TEXT
            setText(card?.capabilities?.joinToString(", ") { it.name } ?: "")
        }
        capsLayout.addView(capsEdit)
        layout.addView(capsLayout, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT
        ).apply { bottomMargin = dp(12) })

        // Protocols
        val protosLayout = TextInputLayout(this).apply {
            hint = "Protocols (comma-separated)"
            boxBackgroundMode = TextInputLayout.BOX_BACKGROUND_OUTLINE
            helperText = "e.g. A2A, REST, gRPC"
        }
        val protosEdit = TextInputEditText(this).apply {
            inputType = InputType.TYPE_CLASS_TEXT
            setText(card?.protocols?.joinToString(", ") ?: "")
        }
        protosLayout.addView(protosEdit)
        layout.addView(protosLayout, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT
        ).apply { bottomMargin = dp(12) })

        // Tags
        val tagsLayout = TextInputLayout(this).apply {
            hint = "Tags (comma-separated)"
            boxBackgroundMode = TextInputLayout.BOX_BACKGROUND_OUTLINE
            helperText = "e.g. IoT, claw-machine, automation"
        }
        val tagsEdit = TextInputEditText(this).apply {
            inputType = InputType.TYPE_CLASS_TEXT
            setText(card?.tags?.joinToString(", ") ?: "")
        }
        tagsLayout.addView(tagsEdit)
        layout.addView(tagsLayout, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT
        ).apply { bottomMargin = dp(12) })

        // Version
        val versionLayout = TextInputLayout(this).apply {
            hint = "Version"
            boxBackgroundMode = TextInputLayout.BOX_BACKGROUND_OUTLINE
        }
        val versionEdit = TextInputEditText(this).apply {
            inputType = InputType.TYPE_CLASS_TEXT
            setText(card?.version ?: "")
        }
        versionLayout.addView(versionEdit)
        layout.addView(versionLayout, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT
        ).apply { bottomMargin = dp(12) })

        // Website
        val websiteLayout = TextInputLayout(this).apply {
            hint = "Website"
            boxBackgroundMode = TextInputLayout.BOX_BACKGROUND_OUTLINE
        }
        val websiteEdit = TextInputEditText(this).apply {
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            setText(card?.website ?: "")
        }
        websiteLayout.addView(websiteEdit)
        layout.addView(websiteLayout, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT
        ).apply { bottomMargin = dp(12) })

        // Contact Email
        val emailLayout = TextInputLayout(this).apply {
            hint = "Contact Email"
            boxBackgroundMode = TextInputLayout.BOX_BACKGROUND_OUTLINE
        }
        val emailEdit = TextInputEditText(this).apply {
            inputType = InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS
            setText(card?.contactEmail ?: "")
        }
        emailLayout.addView(emailEdit)
        layout.addView(emailLayout)

        val dialog = AlertDialog.Builder(this)
            .setTitle("Agent Card — Entity #$entityId")
            .setView(scrollView)
            .setPositiveButton("Save") { _, _ ->
                saveAgentCard(
                    entityId,
                    descEdit.text.toString().trim(),
                    capsEdit.text.toString().trim(),
                    protosEdit.text.toString().trim(),
                    tagsEdit.text.toString().trim(),
                    versionEdit.text.toString().trim(),
                    websiteEdit.text.toString().trim(),
                    emailEdit.text.toString().trim()
                )
            }
            .setNegativeButton("Cancel", null)
            .setNeutralButton("Delete") { _, _ ->
                deleteAgentCard(entityId)
            }
            .create()

        dialog.show()
    }

    private fun saveAgentCard(
        entityId: Int,
        description: String,
        capsText: String,
        protosText: String,
        tagsText: String,
        version: String,
        website: String,
        email: String
    ) {
        if (description.isEmpty()) {
            Toast.makeText(this, "Description is required", Toast.LENGTH_SHORT).show()
            return
        }

        val capabilities = capsText.split(",")
            .map { it.trim() }
            .filter { it.isNotEmpty() }
            .take(10)
            .map { mapOf("id" to it.lowercase().replace(" ", "-"), "name" to it, "description" to "") }

        val protocols = protosText.split(",").map { it.trim() }.filter { it.isNotEmpty() }.take(10)
        val tags = tagsText.split(",").map { it.trim() }.filter { it.isNotEmpty() }.take(20)

        val agentCard = mapOf<String, Any>(
            "description" to description,
            "capabilities" to capabilities,
            "protocols" to protocols,
            "tags" to tags,
            "version" to version,
            "website" to website,
            "contactEmail" to email
        )

        lifecycleScope.launch {
            try {
                val body = mapOf<String, Any>(
                    "deviceId" to deviceManager.deviceId,
                    "deviceSecret" to deviceManager.deviceSecret,
                    "entityId" to entityId,
                    "agentCard" to agentCard
                )
                val response = api.updateAgentCard(body)
                if (response.success) {
                    Toast.makeText(this@EntityManagerActivity, "Agent Card saved", Toast.LENGTH_SHORT).show()
                } else {
                    Toast.makeText(this@EntityManagerActivity, response.message ?: "Save failed", Toast.LENGTH_SHORT).show()
                }
            } catch (e: Exception) {
                Timber.e(e, "Failed to save agent card")
                Toast.makeText(this@EntityManagerActivity, "Save failed: ${e.message}", Toast.LENGTH_SHORT).show()
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
                    Toast.makeText(this@EntityManagerActivity, "Agent Card deleted", Toast.LENGTH_SHORT).show()
                } else {
                    Toast.makeText(this@EntityManagerActivity, response.message ?: "Delete failed", Toast.LENGTH_SHORT).show()
                }
            } catch (e: Exception) {
                Timber.e(e, "Failed to delete agent card")
                Toast.makeText(this@EntityManagerActivity, "Delete failed: ${e.message}", Toast.LENGTH_SHORT).show()
            }
        }
    }

}
