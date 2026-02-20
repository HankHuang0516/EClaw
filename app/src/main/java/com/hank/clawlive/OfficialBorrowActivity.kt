package com.hank.clawlive

import android.graphics.Paint
import android.os.Bundle
import android.view.View
import android.widget.ImageButton
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.updatePadding
import androidx.lifecycle.lifecycleScope
import com.google.android.material.button.MaterialButton
import com.google.android.material.chip.Chip
import com.google.android.material.chip.ChipGroup
import com.hank.clawlive.billing.BillingManager
import com.hank.clawlive.data.local.DeviceManager
import com.hank.clawlive.data.local.LayoutPreferences
import com.hank.clawlive.data.model.BorrowBinding
import com.hank.clawlive.data.model.OfficialBorrowStatusResponse
import com.hank.clawlive.data.remote.NetworkModule
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import timber.log.Timber

class OfficialBorrowActivity : AppCompatActivity() {

    private val api = NetworkModule.api
    private val deviceManager by lazy { DeviceManager.getInstance(this) }
    private val layoutPrefs by lazy { LayoutPreferences.getInstance(this) }
    private val billingManager by lazy { BillingManager.getInstance(this) }

    private lateinit var chipGroupEntity: ChipGroup
    private lateinit var loadingOverlay: View
    private lateinit var progressLoading: ProgressBar
    private lateinit var tvLoadingStatus: TextView
    private lateinit var btnBindFree: MaterialButton
    private lateinit var btnBindPersonal: MaterialButton
    private lateinit var tvAvailability: TextView
    private lateinit var tvPersonalPrice: TextView
    private lateinit var cardFree: View
    private lateinit var cardPersonal: View

    private var selectedEntityId = 0
    private var borrowStatus: OfficialBorrowStatusResponse? = null
    private var pendingBindEntityId: Int? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        setContentView(R.layout.activity_official_borrow)

        setupWindowInsets()
        setupViews()
        loadBorrowStatus()
    }

    override fun onResume() {
        super.onResume()
        billingManager.refreshState()

        // After purchase completes, add paid slot and bind
        val entityId = pendingBindEntityId
        if (entityId != null && billingManager.subscriptionState.value.hasBorrowSubscription) {
            pendingBindEntityId = null
            addPaidSlotAndBind(entityId)
        }
    }

    private fun setupWindowInsets() {
        val topBar = findViewById<View>(R.id.topBar)
        ViewCompat.setOnApplyWindowInsetsListener(topBar) { v, insets ->
            val systemBars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            v.updatePadding(top = systemBars.top + 12)
            insets
        }
    }

    private fun setupViews() {
        findViewById<ImageButton>(R.id.btnBack).setOnClickListener { finish() }

        chipGroupEntity = findViewById(R.id.chipGroupEntity)
        loadingOverlay = findViewById(R.id.loadingOverlay)
        progressLoading = findViewById(R.id.progressLoading)
        tvLoadingStatus = findViewById(R.id.tvLoadingStatus)
        btnBindFree = findViewById(R.id.btnBindFree)
        btnBindPersonal = findViewById(R.id.btnBindPersonal)
        tvAvailability = findViewById(R.id.tvAvailability)
        tvPersonalPrice = findViewById(R.id.tvPersonalPrice)
        cardFree = findViewById(R.id.cardFree)
        cardPersonal = findViewById(R.id.cardPersonal)

        // Entity chip selection
        chipGroupEntity.setOnCheckedStateChangeListener { _, checkedIds ->
            if (checkedIds.isNotEmpty()) {
                val chipId = checkedIds.first()
                selectedEntityId = when (chipId) {
                    R.id.chipEntity0 -> 0
                    R.id.chipEntity1 -> 1
                    R.id.chipEntity2 -> 2
                    R.id.chipEntity3 -> 3
                    else -> 0
                }
                updateButtonStates()
            }
        }

        btnBindFree.setOnClickListener { bindFree() }
        btnBindPersonal.setOnClickListener { bindPersonal() }

        // Apply strikethrough to original price
        findViewById<TextView>(R.id.tvPriceOriginal).paintFlags =
            findViewById<TextView>(R.id.tvPriceOriginal).paintFlags or Paint.STRIKE_THRU_TEXT_FLAG

        // Price is now shown via layout (strikethrough original + discount)
        // Google Play price override is optional - the layout already shows NT$288
        val borrowPrice = billingManager.subscriptionState.value.borrowSubscriptionPrice
        if (borrowPrice.isNotEmpty()) {
            tvPersonalPrice.text = borrowPrice
        }
    }

    private fun showLoading(statusText: String) {
        tvLoadingStatus.text = statusText
        loadingOverlay.visibility = View.VISIBLE
        cardFree.visibility = View.GONE
        cardPersonal.visibility = View.GONE
        btnBindFree.isEnabled = false
        btnBindPersonal.isEnabled = false
    }

    private fun hideLoading() {
        loadingOverlay.visibility = View.GONE
        cardFree.visibility = View.VISIBLE
        cardPersonal.visibility = View.VISIBLE
    }

    private fun loadBorrowStatus() {
        showLoading(getString(R.string.loading_status))

        lifecycleScope.launch {
            try {
                val status = api.getOfficialBorrowStatus(deviceManager.deviceId)
                borrowStatus = status

                // Update availability display
                if (status.personal.available > 0) {
                    tvAvailability.text = getString(R.string.remaining_bots, status.personal.available)
                    tvAvailability.setTextColor(0xFF4CAF50.toInt())
                } else {
                    tvAvailability.text = getString(R.string.sold_out)
                    tvAvailability.setTextColor(0xFFFF5252.toInt())
                }

                hideLoading()
                updateButtonStates()
            } catch (e: Exception) {
                Timber.e(e, "Failed to load borrow status")
                Toast.makeText(this@OfficialBorrowActivity, getString(R.string.failed_format, e.message), Toast.LENGTH_SHORT).show()
                hideLoading()
            }
        }
    }

    private fun updateButtonStates() {
        val status = borrowStatus ?: return

        // Always restore click listeners (override mode)
        btnBindFree.setOnClickListener { bindFree() }
        btnBindPersonal.setOnClickListener { bindPersonal() }

        // Check if selected entity already has an official binding
        val existingBinding = status.bindings.find { it.entityId == selectedEntityId }

        // Free button logic
        val hasFreeBoundElsewhere = status.bindings.any { it.botType == "free" && it.entityId != selectedEntityId }
        if (existingBinding?.botType == "free") {
            // This slot already has free binding - show unbind option
            btnBindFree.text = getString(R.string.already_bound_free)
            btnBindFree.isEnabled = false
            btnBindPersonal.text = getString(R.string.unbind)
            btnBindPersonal.isEnabled = true
            btnBindPersonal.setOnClickListener { confirmUnbind(existingBinding) }
            return
        } else if (existingBinding?.botType == "personal") {
            // This slot has personal binding - show unbind, but also allow re-bind
            btnBindPersonal.text = getString(R.string.unbind)
            btnBindPersonal.isEnabled = true
            btnBindPersonal.setOnClickListener { confirmUnbind(existingBinding) }
            btnBindFree.text = getString(R.string.use_free_version)
            btnBindFree.isEnabled = status.free.available && !hasFreeBoundElsewhere
            return
        }

        // Not officially bound - show normal bind buttons (override any local registration)
        if (hasFreeBoundElsewhere) {
            val boundEntity = status.bindings.first { it.botType == "free" }.entityId
            btnBindFree.text = getString(R.string.bound_on_entity, boundEntity)
            btnBindFree.isEnabled = false
        } else {
            btnBindFree.text = getString(R.string.use_free_version)
            btnBindFree.isEnabled = status.free.available
        }

        if (status.availableSlots > 0) {
            btnBindPersonal.text = getString(R.string.rebind_free)
        } else {
            btnBindPersonal.text = getString(R.string.subscribe_and_bind)
        }
        btnBindPersonal.isEnabled = status.personal.available > 0
    }

    private fun bindFree() {
        // Check if TOS agreement is needed
        val status = borrowStatus
        if (status != null && !status.tosAgreed) {
            showFreeBotTosDialog()
            return
        }
        proceedBindFree()
    }

    private fun showFreeBotTosDialog() {
        lifecycleScope.launch {
            try {
                val lang = resources.configuration.locales[0].language
                val tosLang = if (lang.startsWith("zh")) "zh" else "en"
                val tosResponse = api.getFreeBotTos(tosLang, deviceManager.deviceId)
                val tos = tosResponse.tos ?: return@launch

                // Build TOS content
                val sb = StringBuilder()
                for (section in tos.sections) {
                    sb.appendLine(section.heading)
                    for (item in section.items) {
                        sb.append("  • ").appendLine(item)
                    }
                    sb.appendLine()
                }

                AlertDialog.Builder(this@OfficialBorrowActivity, com.google.android.material.R.style.ThemeOverlay_Material3_MaterialAlertDialog)
                    .setTitle(tos.title)
                    .setMessage(sb.toString().trimEnd())
                    .setPositiveButton(R.string.tos_agree) { _, _ ->
                        agreeAndBindFree(tos.version)
                    }
                    .setNegativeButton(R.string.tos_decline, null)
                    .setCancelable(false)
                    .show()
            } catch (e: Exception) {
                Timber.e(e, "Failed to load free bot TOS")
                Toast.makeText(this@OfficialBorrowActivity, getString(R.string.tos_load_failed), Toast.LENGTH_SHORT).show()
            }
        }
    }

    private fun agreeAndBindFree(tosVersion: String) {
        lifecycleScope.launch {
            try {
                api.agreeFreeBotTos(mapOf(
                    "deviceId" to deviceManager.deviceId,
                    "deviceSecret" to deviceManager.deviceSecret,
                    "tosVersion" to tosVersion
                ))
                borrowStatus = borrowStatus?.copy(tosAgreed = true)
                proceedBindFree()
            } catch (e: Exception) {
                Timber.e(e, "Failed to agree to TOS")
                Toast.makeText(this@OfficialBorrowActivity, getString(R.string.tos_agree_failed), Toast.LENGTH_SHORT).show()
            }
        }
    }

    private fun proceedBindFree() {
        showLoading(getString(R.string.connecting_bot))

        lifecycleScope.launch {
            try {
                tvLoadingStatus.text = getString(R.string.handshaking_bot)

                val response = api.bindFreeBorrow(mapOf(
                    "deviceId" to deviceManager.deviceId,
                    "deviceSecret" to deviceManager.deviceSecret,
                    "entityId" to selectedEntityId
                ))

                if (response.success) {
                    layoutPrefs.addRegisteredEntity(selectedEntityId)
                    // Wait for webhook test to complete
                    waitForWebhookTest(selectedEntityId)
                } else {
                    hideLoading()
                    Toast.makeText(this@OfficialBorrowActivity, getString(R.string.bind_failed, response.error ?: response.message ?: getString(R.string.unknown_error)), Toast.LENGTH_SHORT).show()
                    updateButtonStates()
                }
            } catch (e: Exception) {
                Timber.e(e, "Failed to bind free bot")
                hideLoading()
                Toast.makeText(this@OfficialBorrowActivity, getString(R.string.bind_failed, e.message), Toast.LENGTH_SHORT).show()
                updateButtonStates()
            }
        }
    }

    private fun confirmUnbind(binding: BorrowBinding) {
        val titleRes = if (binding.botType == "personal") R.string.unbind_personal_title else R.string.unbind_free_title
        val messageRes = if (binding.botType == "personal") R.string.unbind_personal_message else R.string.unbind_free_message

        AlertDialog.Builder(this, com.google.android.material.R.style.ThemeOverlay_Material3_MaterialAlertDialog)
            .setTitle(titleRes)
            .setMessage(messageRes)
            .setPositiveButton(R.string.unbind) { _, _ -> unbindEntity() }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    private fun unbindEntity() {
        showLoading(getString(R.string.loading_status))

        lifecycleScope.launch {
            try {
                val response = api.unbindBorrow(mapOf(
                    "deviceId" to deviceManager.deviceId,
                    "deviceSecret" to deviceManager.deviceSecret,
                    "entityId" to selectedEntityId
                ))

                if (response.success) {
                    layoutPrefs.removeRegisteredEntity(selectedEntityId)
                    Toast.makeText(this@OfficialBorrowActivity, getString(R.string.unbind_success), Toast.LENGTH_SHORT).show()
                    setResult(RESULT_OK)
                    // Reload status to refresh UI
                    loadBorrowStatus()
                } else {
                    hideLoading()
                    Toast.makeText(this@OfficialBorrowActivity, getString(R.string.unbind_failed, response.message ?: getString(R.string.unknown_error)), Toast.LENGTH_SHORT).show()
                    updateButtonStates()
                }
            } catch (e: Exception) {
                Timber.e(e, "Failed to unbind official bot")
                hideLoading()
                Toast.makeText(this@OfficialBorrowActivity, getString(R.string.unbind_failed, e.message), Toast.LENGTH_SHORT).show()
                updateButtonStates()
            }
        }
    }

    private fun bindPersonal() {
        showLoading(getString(R.string.connecting_bot))

        lifecycleScope.launch {
            try {
                tvLoadingStatus.text = getString(R.string.handshaking_bot)

                // Step 1: Try to bind - backend will check paid slots
                val response = api.bindPersonalBorrow(mapOf(
                    "deviceId" to deviceManager.deviceId,
                    "deviceSecret" to deviceManager.deviceSecret,
                    "entityId" to selectedEntityId
                ))

                if (response.success) {
                    // Had available slot - bound without payment
                    onBindSuccess(selectedEntityId)
                } else if (response.error == "sold_out") {
                    hideLoading()
                    Toast.makeText(this@OfficialBorrowActivity, getString(R.string.sold_out), Toast.LENGTH_SHORT).show()
                    updateButtonStates()
                } else {
                    hideLoading()
                    Toast.makeText(this@OfficialBorrowActivity, response.error ?: response.message ?: getString(R.string.unknown_error), Toast.LENGTH_SHORT).show()
                    updateButtonStates()
                }
            } catch (e: retrofit2.HttpException) {
                if (e.code() == 402) {
                    // payment_required - need to purchase a new slot
                    hideLoading()
                    launchPaymentFlow(selectedEntityId)
                } else {
                    Timber.e(e, "Failed to bind personal bot")
                    hideLoading()
                    Toast.makeText(this@OfficialBorrowActivity, getString(R.string.bind_failed, e.message), Toast.LENGTH_SHORT).show()
                    updateButtonStates()
                }
            } catch (e: Exception) {
                Timber.e(e, "Failed to bind personal bot")
                hideLoading()
                Toast.makeText(this@OfficialBorrowActivity, getString(R.string.bind_failed, e.message), Toast.LENGTH_SHORT).show()
                updateButtonStates()
            }
        }
    }

    private fun launchPaymentFlow(entityId: Int) {
        if (BuildConfig.DEBUG) {
            // Test mode: skip payment, add slot directly
            addPaidSlotAndBind(entityId)
            return
        }
        // Production: require Google Play payment
        pendingBindEntityId = entityId
        billingManager.launchBorrowPurchaseFlow(this)
    }

    private fun addPaidSlotAndBind(entityId: Int) {
        showLoading(getString(R.string.adding_slot))

        lifecycleScope.launch {
            try {
                // Step 2: Add paid slot after payment
                val slotResponse = api.addPaidSlot(mapOf(
                    "deviceId" to deviceManager.deviceId,
                    "deviceSecret" to deviceManager.deviceSecret
                ))

                if (!slotResponse.success) {
                    hideLoading()
                    Toast.makeText(this@OfficialBorrowActivity, getString(R.string.bind_failed, slotResponse.error ?: getString(R.string.failed_add_slot)), Toast.LENGTH_SHORT).show()
                    updateButtonStates()
                    return@launch
                }

                // Step 3: Retry bind (now has available slot)
                tvLoadingStatus.text = getString(R.string.handshaking_bot)

                val bindResponse = api.bindPersonalBorrow(mapOf(
                    "deviceId" to deviceManager.deviceId,
                    "deviceSecret" to deviceManager.deviceSecret,
                    "entityId" to entityId
                ))

                if (bindResponse.success) {
                    onBindSuccess(entityId)
                } else {
                    hideLoading()
                    Toast.makeText(this@OfficialBorrowActivity, getString(R.string.bind_failed, bindResponse.error ?: bindResponse.message ?: getString(R.string.unknown_error)), Toast.LENGTH_SHORT).show()
                    updateButtonStates()
                }
            } catch (e: Exception) {
                Timber.e(e, "Failed to add slot and bind")
                hideLoading()
                Toast.makeText(this@OfficialBorrowActivity, getString(R.string.bind_failed, e.message), Toast.LENGTH_SHORT).show()
                updateButtonStates()
            }
        }
    }

    private fun onBindSuccess(entityId: Int) {
        layoutPrefs.addRegisteredEntity(entityId)

        // Verify subscription on backend (fire-and-forget)
        lifecycleScope.launch {
            try {
                api.verifyBorrowSubscription(mapOf(
                    "deviceId" to deviceManager.deviceId,
                    "deviceSecret" to deviceManager.deviceSecret,
                    "entityId" to entityId
                ))
            } catch (_: Exception) { }
        }

        // Wait for webhook test to complete
        lifecycleScope.launch {
            waitForWebhookTest(entityId)
        }
    }

    /**
     * Poll entity status to wait for the bot's webhook test to complete.
     * Shows "Webhook testing..." loading status while polling.
     * Finishes after bot confirms (state changes to IDLE) or after timeout.
     */
    private suspend fun waitForWebhookTest(entityId: Int) {
        tvLoadingStatus.text = getString(R.string.webhook_testing)

        val maxAttempts = 20  // Poll up to 20 times (every 1s = ~20s max)
        var webhookConfirmed = false
        var sawBusy = false  // Must see BUSY first (bot started webhook test)

        for (i in 1..maxAttempts) {
            delay(1000)
            try {
                val status = api.getAgentStatus(deviceManager.deviceId, entityId)
                Timber.d("Webhook poll #$i: state=${status.state}, isBound=${status.isBound}")

                if (status.state == com.hank.clawlive.data.model.CharacterState.BUSY) {
                    // Phase 1: Bot received credentials and is testing webhook
                    sawBusy = true
                } else if (sawBusy && status.state == com.hank.clawlive.data.model.CharacterState.IDLE) {
                    // Phase 2: Bot confirmed webhook test passed (BUSY → IDLE)
                    webhookConfirmed = true
                    break
                }
            } catch (e: Exception) {
                Timber.w(e, "Webhook test poll failed, attempt $i")
            }
        }

        if (webhookConfirmed) {
            tvLoadingStatus.text = getString(R.string.webhook_test_success)
        } else {
            tvLoadingStatus.text = getString(R.string.bind_success_returning)
            Timber.w("Webhook test polling timed out for entity $entityId (sawBusy=$sawBusy)")
        }

        setResult(RESULT_OK)
        delay(1200)
        finish()
    }
}
