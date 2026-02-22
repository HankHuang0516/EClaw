package com.hank.clawlive

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.View
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.updatePadding
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import com.google.android.material.button.MaterialButton
import com.google.android.material.card.MaterialCardView
import com.google.android.material.chip.Chip
import com.google.android.material.chip.ChipGroup
import com.google.android.material.textfield.TextInputEditText
import com.google.android.material.textfield.TextInputLayout
import com.hank.clawlive.billing.BillingManager
import com.hank.clawlive.billing.SubscriptionState
import com.hank.clawlive.data.local.DeviceManager
import com.hank.clawlive.data.local.LayoutPreferences
import com.hank.clawlive.data.local.UsageManager
import com.hank.clawlive.data.remote.NetworkModule
import com.hank.clawlive.data.remote.TelemetryHelper
import com.hank.clawlive.ui.RecordingIndicatorHelper
import androidx.appcompat.app.AppCompatDelegate
import androidx.core.os.LocaleListCompat
import kotlinx.coroutines.launch
import timber.log.Timber

class SettingsActivity : AppCompatActivity() {

    private lateinit var billingManager: BillingManager
    private lateinit var usageManager: UsageManager
    private val layoutPrefs: LayoutPreferences by lazy { LayoutPreferences.getInstance(this) }
    private val deviceManager: DeviceManager by lazy { DeviceManager.getInstance(this) }

    // UI elements
    private lateinit var cardSubscription: MaterialCardView
    private lateinit var layoutPremiumBadge: LinearLayout
    private lateinit var tvUsageCount: TextView
    private lateinit var tvEntityCount: TextView
    private lateinit var progressUsage: ProgressBar
    private lateinit var btnSubscribe: MaterialButton
    private lateinit var btnFeedback: MaterialButton
    private lateinit var btnPrivacyPolicy: MaterialButton
    private lateinit var btnWebPortal: MaterialButton
    private lateinit var btnAccountLogin: MaterialButton
    private lateinit var chipGroupLanguage: ChipGroup
    private lateinit var chipLangEn: Chip
    private lateinit var chipLangZh: Chip
    private lateinit var btnBack: ImageButton
    private lateinit var btnDebugEntityLimit: MaterialButton
    private lateinit var topBar: LinearLayout

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Enable edge-to-edge display
        WindowCompat.setDecorFitsSystemWindows(window, false)

        setContentView(R.layout.activity_settings)

        billingManager = BillingManager.getInstance(this)
        usageManager = UsageManager.getInstance(this)

        initViews()
        setupEdgeToEdgeInsets()
        setupClickListeners()
        loadCurrentLanguage()
        observeSubscriptionState()
        updateEntityCount()
        displayAppVersion()
    }

    private fun setupEdgeToEdgeInsets() {
        ViewCompat.setOnApplyWindowInsetsListener(findViewById(android.R.id.content)) { _, windowInsets ->
            val insets = windowInsets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
            )

            topBar.updatePadding(
                left = insets.left + dpToPx(8),
                top = insets.top + dpToPx(8),
                right = insets.right + dpToPx(8)
            )

            WindowInsetsCompat.CONSUMED
        }
    }

    private fun dpToPx(dp: Int): Int {
        return (dp * resources.displayMetrics.density).toInt()
    }

    override fun onResume() {
        super.onResume()
        TelemetryHelper.trackPageView(this, "settings")
        RecordingIndicatorHelper.attach(this)
        billingManager.refreshState()
        updateUsageDisplay()
        updateEntityCount()
    }

    override fun onPause() {
        super.onPause()
        RecordingIndicatorHelper.detach()
    }

    private fun initViews() {
        cardSubscription = findViewById(R.id.cardSubscription)
        layoutPremiumBadge = findViewById(R.id.layoutPremiumBadge)
        tvUsageCount = findViewById(R.id.tvUsageCount)
        progressUsage = findViewById(R.id.progressUsage)
        btnSubscribe = findViewById(R.id.btnSubscribe)
        chipGroupLanguage = findViewById(R.id.chipGroupLanguage)
        chipLangEn = findViewById(R.id.chipLangEn)
        chipLangZh = findViewById(R.id.chipLangZh)
        btnBack = findViewById(R.id.btnBack)
        topBar = findViewById(R.id.topBar)
        tvEntityCount = findViewById(R.id.tvEntityCount)
        btnFeedback = findViewById(R.id.btnFeedback)
        btnPrivacyPolicy = findViewById(R.id.btnPrivacyPolicy)
        btnWebPortal = findViewById(R.id.btnWebPortal)
        btnAccountLogin = findViewById(R.id.btnAccountLogin)
        btnDebugEntityLimit = findViewById(R.id.btnDebugEntityLimit)

        // Show debug button only in debug builds
        if (BuildConfig.DEBUG) {
            btnDebugEntityLimit.visibility = View.VISIBLE
            updateDebugEntityLimitButton()
        }
    }

    private fun setupClickListeners() {
        btnSubscribe.setOnClickListener {
            billingManager.launchPurchaseFlow(this)
        }

        btnBack.setOnClickListener {
            finish()
        }

        btnFeedback.setOnClickListener {
            startActivity(Intent(this, FeedbackActivity::class.java))
        }

        btnPrivacyPolicy.setOnClickListener {
            startActivity(android.content.Intent(this, PrivacyPolicyActivity::class.java))
        }

        btnWebPortal.setOnClickListener {
            showWebPortalDialog()
        }

        btnAccountLogin.setOnClickListener {
            showAccountLoginDialog()
        }

        btnDebugEntityLimit.setOnClickListener {
            val current = layoutPrefs.debugEntityLimit
            val newLimit = if (current == 8) 4 else 8
            layoutPrefs.debugEntityLimit = newLimit
            updateDebugEntityLimitButton()
            updateEntityCount()
            Toast.makeText(this, "Entity limit: $newLimit", Toast.LENGTH_SHORT).show()
        }

        // Language selection
        chipGroupLanguage.setOnCheckedStateChangeListener { _, checkedIds ->
            if (checkedIds.isNotEmpty()) {
                val localeList = when (checkedIds[0]) {
                    R.id.chipLangZh -> LocaleListCompat.forLanguageTags("zh-TW")
                    else -> LocaleListCompat.forLanguageTags("en")
                }

                val current = AppCompatDelegate.getApplicationLocales()
                if (current.toLanguageTags() != localeList.toLanguageTags()) {
                     AppCompatDelegate.setApplicationLocales(localeList)
                }
            }
        }
    }

    private fun loadCurrentLanguage() {
        val locales = AppCompatDelegate.getApplicationLocales()
        if (!locales.isEmpty) {
            // App has a specific locale set
            val tag = locales.toLanguageTags()
            if (tag.contains("zh")) {
                chipLangZh.isChecked = true
            } else {
                chipLangEn.isChecked = true
            }
        } else {
            // Follow system: Check system locale
            val systemLocale = LocaleListCompat.getDefault()
            val systemTag = systemLocale.toLanguageTags()
            if (systemTag.contains("zh")) {
                chipLangZh.isChecked = true
            } else {
                chipLangEn.isChecked = true
            }
        }
    }

    private fun updateUsageDisplay() {
        tvUsageCount.text = usageManager.getUsageDisplay()
        progressUsage.progress = (usageManager.getUsageProgress() * 100).toInt()

        // Change progress bar color when limit reached
        if (!usageManager.canUseMessage() && !usageManager.isPremium) {
            progressUsage.progressTintList = getColorStateList(android.R.color.holo_red_light)
        } else {
            progressUsage.progressTintList = android.content.res.ColorStateList.valueOf(0xFFFFD23F.toInt())
        }
    }

    private fun observeSubscriptionState() {
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                billingManager.subscriptionState.collect { state ->
                    updateSubscriptionUi(state)
                }
            }
        }
    }

    private fun updateSubscriptionUi(state: SubscriptionState) {
        // Update usage display
        tvUsageCount.text = state.usageDisplay
        progressUsage.progress = (state.usageProgress * 100).toInt()

        // Show/hide premium badge and subscribe button
        if (state.isPremium) {
            layoutPremiumBadge.visibility = View.VISIBLE
            btnSubscribe.visibility = View.GONE
        } else {
            layoutPremiumBadge.visibility = View.GONE
            btnSubscribe.visibility = View.VISIBLE

            // Update button text with price if available
            if (state.subscriptionPrice.isNotEmpty()) {
                btnSubscribe.text = getString(R.string.unlock_unlimited, state.subscriptionPrice)
            }
        }

        // Change progress bar color when limit reached
        if (state.isLimitReached) {
            progressUsage.progressTintList = getColorStateList(android.R.color.holo_red_light)
        } else {
            progressUsage.progressTintList = android.content.res.ColorStateList.valueOf(0xFFFFD23F.toInt())
        }
    }

    private fun updateDebugEntityLimitButton() {
        val limit = layoutPrefs.debugEntityLimit
        btnDebugEntityLimit.text = "[DEBUG] Entity Limit: $limit"
    }

    private fun updateEntityCount() {
        val maxEntities = if (usageManager.isPremium) 8 else if (BuildConfig.DEBUG) layoutPrefs.debugEntityLimit else 4
        // Show local count first, then update from API
        val localCount = layoutPrefs.getRegisteredEntityIds().size
        tvEntityCount.text = "$localCount/$maxEntities"

        lifecycleScope.launch {
            try {
                val response = NetworkModule.api.getAllEntities(deviceId = deviceManager.deviceId)
                val boundCount = response.entities.size
                tvEntityCount.text = "$boundCount/$maxEntities"
            } catch (e: Exception) {
                Timber.e(e, "Failed to fetch entity count from API")
            }
        }
    }

    private fun showWebPortalDialog() {
        val deviceId = deviceManager.deviceId
        val deviceSecret = deviceManager.deviceSecret
        val portalUrl = "https://eclaw.up.railway.app/portal/"

        // Check bind status first, then show appropriate dialog
        lifecycleScope.launch {
            try {
                val status = NetworkModule.api.getBindEmailStatus(deviceId, deviceSecret)
                if (status.bound && status.email != null) {
                    showWebPortalBoundDialog(status.email, status.emailVerified, portalUrl, deviceId, deviceSecret)
                } else {
                    showWebPortalUnboundDialog(portalUrl, deviceId, deviceSecret)
                }
            } catch (e: Exception) {
                Timber.e(e, "Failed to check bind status")
                // Fallback: show unbound dialog
                showWebPortalUnboundDialog(portalUrl, deviceId, deviceSecret)
            }
        }
    }

    private fun showWebPortalBoundDialog(email: String, verified: Boolean, portalUrl: String, deviceId: String, deviceSecret: String) {
        val verifiedText = if (verified) getString(R.string.bind_email_verified) else getString(R.string.bind_email_not_verified)
        val msg = "${getString(R.string.bind_email_linked)}\n$email ($verifiedText)\n\n" +
            if (verified) getString(R.string.bind_email_login_hint) else getString(R.string.bind_email_verify_hint)

        AlertDialog.Builder(this)
            .setTitle(getString(R.string.web_portal))
            .setMessage(msg)
            .setPositiveButton(getString(R.string.bind_email_open_portal)) { _, _ ->
                startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(portalUrl)))
            }
            .setNeutralButton(getString(R.string.bind_email_copy_credentials)) { _, _ ->
                val clip = getSystemService(CLIPBOARD_SERVICE) as ClipboardManager
                clip.setPrimaryClip(ClipData.newPlainText("credentials",
                    "Device ID: $deviceId\nDevice Secret: $deviceSecret"))
                Toast.makeText(this, getString(R.string.confirm_copy), Toast.LENGTH_SHORT).show()
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    private fun showWebPortalUnboundDialog(portalUrl: String, deviceId: String, deviceSecret: String) {
        AlertDialog.Builder(this)
            .setTitle(getString(R.string.web_portal))
            .setMessage(getString(R.string.bind_email_prompt))
            .setPositiveButton(getString(R.string.bind_email_action)) { _, _ ->
                showBindEmailDialog(deviceId, deviceSecret)
            }
            .setNeutralButton(getString(R.string.bind_email_use_device_login)) { _, _ ->
                val clip = getSystemService(CLIPBOARD_SERVICE) as ClipboardManager
                clip.setPrimaryClip(ClipData.newPlainText("credentials",
                    "Device ID: $deviceId\nDevice Secret: $deviceSecret"))
                Toast.makeText(this, getString(R.string.confirm_copy), Toast.LENGTH_SHORT).show()
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    private fun showBindEmailDialog(deviceId: String, deviceSecret: String) {
        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dpToPx(24), dpToPx(16), dpToPx(24), dpToPx(8))
        }

        val emailInput = TextInputLayout(this).apply {
            hint = getString(R.string.bind_email_label)
            boxBackgroundMode = TextInputLayout.BOX_BACKGROUND_OUTLINE
        }
        val emailEdit = TextInputEditText(this)
        emailEdit.inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS
        emailInput.addView(emailEdit)
        layout.addView(emailInput)

        val passwordInput = TextInputLayout(this).apply {
            hint = getString(R.string.bind_email_password_label)
            boxBackgroundMode = TextInputLayout.BOX_BACKGROUND_OUTLINE
            endIconMode = TextInputLayout.END_ICON_PASSWORD_TOGGLE
            val lp = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            )
            lp.topMargin = dpToPx(12)
            layoutParams = lp
        }
        val passwordEdit = TextInputEditText(this)
        passwordEdit.inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD
        passwordInput.addView(passwordEdit)
        layout.addView(passwordInput)

        val confirmInput = TextInputLayout(this).apply {
            hint = getString(R.string.bind_email_confirm_label)
            boxBackgroundMode = TextInputLayout.BOX_BACKGROUND_OUTLINE
            endIconMode = TextInputLayout.END_ICON_PASSWORD_TOGGLE
            val lp = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            )
            lp.topMargin = dpToPx(12)
            layoutParams = lp
        }
        val confirmEdit = TextInputEditText(this)
        confirmEdit.inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD
        confirmInput.addView(confirmEdit)
        layout.addView(confirmInput)

        val hintText = TextView(this).apply {
            text = getString(R.string.bind_email_password_hint)
            setTextColor(0x99FFFFFF.toInt())
            textSize = 12f
            val lp = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            )
            lp.topMargin = dpToPx(8)
            layoutParams = lp
        }
        layout.addView(hintText)

        val dialog = AlertDialog.Builder(this)
            .setTitle(getString(R.string.bind_email_title))
            .setView(layout)
            .setPositiveButton(getString(R.string.bind_email_submit), null) // set below to prevent auto-dismiss
            .setNegativeButton(R.string.cancel, null)
            .create()

        dialog.show()

        // Override positive button to validate before dismissing
        dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
            val email = emailEdit.text?.toString()?.trim() ?: ""
            val password = passwordEdit.text?.toString() ?: ""
            val confirm = confirmEdit.text?.toString() ?: ""

            if (email.isEmpty() || password.isEmpty()) {
                Toast.makeText(this, getString(R.string.bind_email_fill_all), Toast.LENGTH_SHORT).show()
                return@setOnClickListener
            }

            if (password.length < 6 || !password.any { it.isLetter() } || !password.any { it.isDigit() }) {
                Toast.makeText(this, getString(R.string.bind_email_password_invalid), Toast.LENGTH_SHORT).show()
                return@setOnClickListener
            }

            if (password != confirm) {
                Toast.makeText(this, getString(R.string.bind_email_password_mismatch), Toast.LENGTH_SHORT).show()
                return@setOnClickListener
            }

            dialog.getButton(AlertDialog.BUTTON_POSITIVE).isEnabled = false
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).text = getString(R.string.bind_email_submitting)

            lifecycleScope.launch {
                try {
                    val body = mapOf(
                        "deviceId" to deviceId,
                        "deviceSecret" to deviceSecret,
                        "email" to email,
                        "password" to password
                    )
                    val response = NetworkModule.api.bindEmail(body)
                    if (response.success) {
                        dialog.dismiss()
                        Toast.makeText(this@SettingsActivity, getString(R.string.bind_email_success), Toast.LENGTH_LONG).show()
                        TelemetryHelper.trackAction("bind_email_success")
                    } else {
                        Toast.makeText(this@SettingsActivity, response.error ?: getString(R.string.unknown_error), Toast.LENGTH_SHORT).show()
                        dialog.getButton(AlertDialog.BUTTON_POSITIVE).isEnabled = true
                        dialog.getButton(AlertDialog.BUTTON_POSITIVE).text = getString(R.string.bind_email_submit)
                    }
                } catch (e: Exception) {
                    Timber.e(e, "Bind email failed")
                    TelemetryHelper.trackError(e, mapOf("action" to "bind_email"))
                    val errorMsg = try {
                        val errorBody = (e as? retrofit2.HttpException)?.response()?.errorBody()?.string()
                        val json = com.google.gson.JsonParser.parseString(errorBody ?: "").asJsonObject
                        json.get("error")?.asString ?: e.message
                    } catch (_: Exception) { e.message }
                    Toast.makeText(this@SettingsActivity, errorMsg ?: getString(R.string.unknown_error), Toast.LENGTH_SHORT).show()
                    dialog.getButton(AlertDialog.BUTTON_POSITIVE).isEnabled = true
                    dialog.getButton(AlertDialog.BUTTON_POSITIVE).text = getString(R.string.bind_email_submit)
                }
            }
        }
    }

    private fun showAccountLoginDialog() {
        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dpToPx(24), dpToPx(16), dpToPx(24), dpToPx(8))
        }

        val emailInput = TextInputLayout(this).apply {
            hint = getString(R.string.bind_email_label)
            boxBackgroundMode = TextInputLayout.BOX_BACKGROUND_OUTLINE
        }
        val emailEdit = TextInputEditText(this)
        emailEdit.inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS
        emailInput.addView(emailEdit)
        layout.addView(emailInput)

        val passwordInput = TextInputLayout(this).apply {
            hint = getString(R.string.bind_email_password_label)
            boxBackgroundMode = TextInputLayout.BOX_BACKGROUND_OUTLINE
            endIconMode = TextInputLayout.END_ICON_PASSWORD_TOGGLE
            val lp = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            )
            lp.topMargin = dpToPx(12)
            layoutParams = lp
        }
        val passwordEdit = TextInputEditText(this)
        passwordEdit.inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD
        passwordInput.addView(passwordEdit)
        layout.addView(passwordInput)

        val hintText = TextView(this).apply {
            text = getString(R.string.account_login_hint)
            setTextColor(0x99FFFFFF.toInt())
            textSize = 12f
            val lp = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            )
            lp.topMargin = dpToPx(8)
            layoutParams = lp
        }
        layout.addView(hintText)

        val dialog = AlertDialog.Builder(this)
            .setTitle(getString(R.string.account_login))
            .setView(layout)
            .setPositiveButton(getString(R.string.account_login_btn), null)
            .setNegativeButton(R.string.cancel, null)
            .create()

        dialog.show()

        dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
            val email = emailEdit.text?.toString()?.trim() ?: ""
            val password = passwordEdit.text?.toString() ?: ""

            if (email.isEmpty() || password.isEmpty()) {
                Toast.makeText(this, getString(R.string.bind_email_fill_all), Toast.LENGTH_SHORT).show()
                return@setOnClickListener
            }

            dialog.getButton(AlertDialog.BUTTON_POSITIVE).isEnabled = false
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).text = getString(R.string.account_login_logging_in)

            lifecycleScope.launch {
                try {
                    val body = mapOf("email" to email, "password" to password)
                    val response = NetworkModule.api.appLogin(body)
                    if (response.success && response.deviceId != null && response.deviceSecret != null) {
                        // Overwrite local credentials with recovered ones
                        deviceManager.setCredentials(response.deviceId, response.deviceSecret)
                        dialog.dismiss()
                        TelemetryHelper.trackAction("account_login_success")

                        // Show success and prompt restart
                        AlertDialog.Builder(this@SettingsActivity)
                            .setTitle(getString(R.string.account_login_success_title))
                            .setMessage(getString(R.string.account_login_success_msg, response.email ?: email))
                            .setPositiveButton(getString(R.string.account_login_restart)) { _, _ ->
                                // Restart the app to pick up new credentials
                                val intent = packageManager.getLaunchIntentForPackage(packageName)
                                intent?.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
                                startActivity(intent)
                                Runtime.getRuntime().exit(0)
                            }
                            .setCancelable(false)
                            .show()
                    } else {
                        Toast.makeText(this@SettingsActivity, response.error ?: getString(R.string.unknown_error), Toast.LENGTH_SHORT).show()
                        dialog.getButton(AlertDialog.BUTTON_POSITIVE).isEnabled = true
                        dialog.getButton(AlertDialog.BUTTON_POSITIVE).text = getString(R.string.account_login_btn)
                    }
                } catch (e: Exception) {
                    Timber.e(e, "Account login failed")
                    TelemetryHelper.trackError(e, mapOf("action" to "account_login"))
                    val errorMsg = try {
                        val errorBody = (e as? retrofit2.HttpException)?.response()?.errorBody()?.string()
                        val json = com.google.gson.JsonParser.parseString(errorBody ?: "").asJsonObject
                        json.get("error")?.asString ?: e.message
                    } catch (_: Exception) { e.message }
                    Toast.makeText(this@SettingsActivity, errorMsg ?: getString(R.string.unknown_error), Toast.LENGTH_SHORT).show()
                    dialog.getButton(AlertDialog.BUTTON_POSITIVE).isEnabled = true
                    dialog.getButton(AlertDialog.BUTTON_POSITIVE).text = getString(R.string.account_login_btn)
                }
            }
        }
    }

    private fun displayAppVersion() {
        try {
            val pInfo = packageManager.getPackageInfo(packageName, 0)
            val version = pInfo.versionName
            val tvAppVersion = findViewById<TextView>(R.id.tvAppVersion)
            tvAppVersion.text = getString(R.string.app_version, version)
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }
}
