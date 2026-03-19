package com.hank.clawlive

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.View
import android.widget.ImageButton
import android.widget.ImageView
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
import com.google.android.material.materialswitch.MaterialSwitch
import com.google.android.material.textfield.TextInputEditText
import com.google.android.material.textfield.TextInputLayout
import com.hank.clawlive.billing.BillingManager
import com.hank.clawlive.billing.SubscriptionState
import com.hank.clawlive.data.local.DeviceManager
import com.hank.clawlive.data.local.LayoutPreferences
import com.hank.clawlive.data.local.UsageManager
import com.hank.clawlive.data.remote.NetworkModule
import com.hank.clawlive.data.remote.TelemetryHelper
import com.hank.clawlive.debug.CrashLogManager
import androidx.credentials.CredentialManager
import androidx.credentials.GetCredentialRequest
import com.google.android.libraries.identity.googleid.GetGoogleIdOption
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential
import com.facebook.CallbackManager
import com.facebook.FacebookCallback
import com.facebook.FacebookException
import com.facebook.login.LoginManager
import com.facebook.login.LoginResult
import com.hank.clawlive.ui.AiChatFabHelper
import com.hank.clawlive.ui.BottomNavHelper
import com.hank.clawlive.ui.EntityChipHelper
import com.hank.clawlive.ui.NavItem
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
    private lateinit var btnDeleteAccount: MaterialButton
    private lateinit var btnCrashLogs: MaterialButton
    private lateinit var btnDebugLogs: MaterialButton
    // Account Status Card views
    private lateinit var cardAccountStatus: MaterialCardView
    private lateinit var accountStatusLoading: LinearLayout
    private lateinit var accountBoundLayout: LinearLayout
    private lateinit var accountUnboundLayout: LinearLayout
    private lateinit var tvAccountEmail: TextView
    private lateinit var tvAccountVerified: TextView
    private lateinit var btnAccountOpenPortal: MaterialButton
    private lateinit var tvAccountCopyCredentials: TextView
    private lateinit var btnAccountBindEmail: MaterialButton
    private lateinit var tvAccountRecoveryLink: TextView
    private lateinit var btnGoogleSignIn: MaterialButton
    private lateinit var btnFacebookSignIn: MaterialButton
    private lateinit var tvConnectedProviders: TextView
    private lateinit var facebookCallbackManager: CallbackManager
    private lateinit var chipGroupLanguage: ChipGroup
    private lateinit var chipLangEn: Chip
    private lateinit var chipLangZh: Chip
    private lateinit var chipLangZhCn: Chip
    private lateinit var chipLangJa: Chip
    private lateinit var chipLangKo: Chip
    private lateinit var chipLangTh: Chip
    private lateinit var chipLangVi: Chip
    private lateinit var chipLangId: Chip
    private lateinit var btnSetWallpaper: MaterialButton
    private lateinit var btnDebugEntityLimit: MaterialButton
    private lateinit var topBar: LinearLayout
    private lateinit var notifPrefsContainer: LinearLayout
    private lateinit var notifHeader: LinearLayout
    private lateinit var notifContentLayout: LinearLayout
    private lateinit var notifExpandArrow: ImageView
    private var isNotifExpanded = false
    private lateinit var broadcastSettingsHeader: LinearLayout
    private lateinit var broadcastSettingsContentLayout: LinearLayout
    private lateinit var broadcastSettingsExpandArrow: ImageView
    private lateinit var broadcastPrefsContainer: LinearLayout
    private var isBroadcastSettingsExpanded = false
    private lateinit var remoteControlHeader: LinearLayout
    private lateinit var remoteControlContentLayout: LinearLayout
    private lateinit var remoteControlExpandArrow: ImageView
    private lateinit var remoteControlContainer: LinearLayout
    private var isRemoteControlExpanded = false
    private lateinit var langHeader: LinearLayout
    private lateinit var langContentLayout: LinearLayout
    private lateinit var langExpandArrow: ImageView
    private var isLangExpanded = false
    // Channel API card
    private lateinit var channelApiHeader: LinearLayout
    private lateinit var channelApiContentLayout: LinearLayout
    private lateinit var channelApiExpandArrow: ImageView
    private lateinit var tvChannelApiKey: TextView
    private lateinit var tvChannelApiSecret: TextView
    private lateinit var tvChannelApiNoKey: TextView
    private lateinit var channelApiActions: LinearLayout
    private lateinit var btnChannelApiToggleSecret: com.google.android.material.button.MaterialButton
    private lateinit var btnChannelApiCopy: com.google.android.material.button.MaterialButton
    private lateinit var tvChannelApiSlotStatus: TextView
    private var isChannelApiExpanded = false
    private var channelApiSecretVisible = false
    private var cachedChannelSecret: String? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Enable edge-to-edge display
        WindowCompat.setDecorFitsSystemWindows(window, false)

        setContentView(R.layout.activity_settings)

        BottomNavHelper.setup(this, NavItem.SETTINGS)
        AiChatFabHelper.setup(this, "settings")
        billingManager = BillingManager.getInstance(this)
        usageManager = UsageManager.getInstance(this)

        initViews()
        setupEdgeToEdgeInsets()
        setupClickListeners()
        loadCurrentLanguage()
        observeSubscriptionState()
        updateEntityCount()
        displayAppVersion()
        setupNotifCollapsible()
        setupBroadcastSettingsCollapsible()
        setupRemoteControlCollapsible()
        setupLangCollapsible()
        setupChannelApiCollapsible()
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

            windowInsets
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
        loadAccountStatus()
        updateCrashLogBadge()
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
        chipLangZhCn = findViewById(R.id.chipLangZhCn)
        chipLangJa = findViewById(R.id.chipLangJa)
        chipLangKo = findViewById(R.id.chipLangKo)
        chipLangTh = findViewById(R.id.chipLangTh)
        chipLangVi = findViewById(R.id.chipLangVi)
        chipLangId = findViewById(R.id.chipLangId)
        topBar = findViewById(R.id.topBar)
        btnSetWallpaper = findViewById(R.id.btnSetWallpaper)
        tvEntityCount = findViewById(R.id.tvEntityCount)
        btnFeedback = findViewById(R.id.btnFeedback)
        btnPrivacyPolicy = findViewById(R.id.btnPrivacyPolicy)
        btnDeleteAccount = findViewById(R.id.btnDeleteAccount)
        btnCrashLogs = findViewById(R.id.btnCrashLogs)
        btnDebugLogs = findViewById(R.id.btnDebugLogs)
        cardAccountStatus = findViewById(R.id.cardAccountStatus)
        accountStatusLoading = findViewById(R.id.accountStatusLoading)
        accountBoundLayout = findViewById(R.id.accountBoundLayout)
        accountUnboundLayout = findViewById(R.id.accountUnboundLayout)
        tvAccountEmail = findViewById(R.id.tvAccountEmail)
        tvAccountVerified = findViewById(R.id.tvAccountVerified)
        btnAccountOpenPortal = findViewById(R.id.btnAccountOpenPortal)
        tvAccountCopyCredentials = findViewById(R.id.tvAccountCopyCredentials)
        btnAccountBindEmail = findViewById(R.id.btnAccountBindEmail)
        tvAccountRecoveryLink = findViewById(R.id.tvAccountRecoveryLink)
        btnGoogleSignIn = findViewById(R.id.btnGoogleSignIn)
        btnFacebookSignIn = findViewById(R.id.btnFacebookSignIn)
        tvConnectedProviders = findViewById(R.id.tvConnectedProviders)
        btnDebugEntityLimit = findViewById(R.id.btnDebugEntityLimit)
        notifPrefsContainer = findViewById(R.id.notifPrefsContainer)
        notifHeader = findViewById(R.id.notifHeader)
        notifContentLayout = findViewById(R.id.notifContentLayout)
        notifExpandArrow = findViewById(R.id.notifExpandArrow)
        broadcastSettingsHeader = findViewById(R.id.broadcastSettingsHeader)
        broadcastSettingsContentLayout = findViewById(R.id.broadcastSettingsContentLayout)
        broadcastSettingsExpandArrow = findViewById(R.id.broadcastSettingsExpandArrow)
        broadcastPrefsContainer = findViewById(R.id.broadcastPrefsContainer)
        remoteControlHeader = findViewById(R.id.remoteControlHeader)
        remoteControlContentLayout = findViewById(R.id.remoteControlContentLayout)
        remoteControlExpandArrow = findViewById(R.id.remoteControlExpandArrow)
        remoteControlContainer = findViewById(R.id.remoteControlContainer)
        langHeader = findViewById(R.id.langHeader)
        langContentLayout = findViewById(R.id.langContentLayout)
        langExpandArrow = findViewById(R.id.langExpandArrow)
        channelApiHeader = findViewById(R.id.channelApiHeader)
        channelApiContentLayout = findViewById(R.id.channelApiContentLayout)
        channelApiExpandArrow = findViewById(R.id.channelApiExpandArrow)
        tvChannelApiKey = findViewById(R.id.tvChannelApiKey)
        tvChannelApiSecret = findViewById(R.id.tvChannelApiSecret)
        tvChannelApiNoKey = findViewById(R.id.tvChannelApiNoKey)
        channelApiActions = findViewById(R.id.channelApiActions)
        btnChannelApiToggleSecret = findViewById(R.id.btnChannelApiToggleSecret)
        btnChannelApiCopy = findViewById(R.id.btnChannelApiCopy)
        tvChannelApiSlotStatus = findViewById(R.id.tvChannelApiSlotStatus)

        // Show debug button only in debug builds
        if (BuildConfig.DEBUG) {
            btnDebugEntityLimit.visibility = View.VISIBLE
            updateDebugEntityLimitButton()
        }

        // Show debug logs button from cached roles (will be updated by network call)
        if (deviceManager.isDeveloperOrAdmin()) {
            btnDebugLogs.visibility = View.VISIBLE
        }
    }

    private fun setupClickListeners() {
        btnSubscribe.setOnClickListener {
            billingManager.launchPurchaseFlow(this)
        }

        btnSetWallpaper.setOnClickListener {
            startActivity(Intent(this, WallpaperPreviewActivity::class.java))
        }

        findViewById<MaterialButton>(R.id.btnFileManager).setOnClickListener {
            startActivity(Intent(this, FileManagerActivity::class.java))
        }

        btnFeedback.setOnClickListener {
            startActivity(Intent(this, FeedbackActivity::class.java))
        }

        btnPrivacyPolicy.setOnClickListener {
            startActivity(android.content.Intent(this, PrivacyPolicyActivity::class.java))
        }

        btnDeleteAccount.setOnClickListener {
            TelemetryHelper.trackAction("settings_delete_account")
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://eclawbot.com/portal/delete-account.html")))
        }

        btnCrashLogs.setOnClickListener {
            startActivity(Intent(this, CrashLogViewerActivity::class.java))
        }

        btnDebugLogs.setOnClickListener {
            startActivity(Intent(this, DebugLogViewerActivity::class.java))
        }

        // Account Status Card listeners
        btnAccountOpenPortal.setOnClickListener {
            TelemetryHelper.trackAction("account_card_open_portal")
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://eclawbot.com/portal/")))
        }

        tvAccountCopyCredentials.setOnClickListener {
            TelemetryHelper.trackAction("account_card_copy_credentials")
            val clip = getSystemService(CLIPBOARD_SERVICE) as ClipboardManager
            clip.setPrimaryClip(ClipData.newPlainText("credentials",
                "Device ID: ${deviceManager.deviceId}\nDevice Secret: ${deviceManager.deviceSecret}"))
            Toast.makeText(this, getString(R.string.confirm_copy), Toast.LENGTH_SHORT).show()
        }

        btnAccountBindEmail.setOnClickListener {
            TelemetryHelper.trackAction("account_card_bind_email")
            showBindEmailDialog(deviceManager.deviceId, deviceManager.deviceSecret)
        }

        tvAccountRecoveryLink.setOnClickListener {
            TelemetryHelper.trackAction("account_card_recovery")
            showAccountLoginDialog()
        }

        btnGoogleSignIn.setOnClickListener {
            TelemetryHelper.trackAction("account_card_google_sign_in")
            startGoogleSignIn()
        }

        btnFacebookSignIn.setOnClickListener {
            TelemetryHelper.trackAction("account_card_facebook_sign_in")
            startFacebookLogin()
        }

        // Initialize Facebook CallbackManager
        facebookCallbackManager = CallbackManager.Factory.create()

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
                val tag = when (checkedIds[0]) {
                    R.id.chipLangZh -> "zh-TW"
                    R.id.chipLangZhCn -> "zh-CN"
                    R.id.chipLangJa -> "ja"
                    R.id.chipLangKo -> "ko"
                    R.id.chipLangTh -> "th"
                    R.id.chipLangVi -> "vi"
                    R.id.chipLangId -> "in"
                    else -> "en"
                }
                val localeList = LocaleListCompat.forLanguageTags(tag)
                val current = AppCompatDelegate.getApplicationLocales()
                if (current.toLanguageTags() != localeList.toLanguageTags()) {
                    AppCompatDelegate.setApplicationLocales(localeList)
                    // Sync language to server for cross-device persistence
                    syncLanguageToServer(tag)
                }
            }
        }
    }

    private fun loadCurrentLanguage() {
        val locales = AppCompatDelegate.getApplicationLocales()
        val tag = if (!locales.isEmpty) {
            locales.toLanguageTags()
        } else {
            LocaleListCompat.getDefault().toLanguageTags()
        }

        when {
            tag.contains("zh-CN") || tag.contains("zh-Hans") -> chipLangZhCn.isChecked = true
            tag.contains("zh") -> chipLangZh.isChecked = true
            tag.contains("ja") -> chipLangJa.isChecked = true
            tag.contains("ko") -> chipLangKo.isChecked = true
            tag.contains("th") -> chipLangTh.isChecked = true
            tag.contains("vi") -> chipLangVi.isChecked = true
            tag.contains("in") || tag.contains("id") -> chipLangId.isChecked = true
            else -> chipLangEn.isChecked = true
        }
    }

    private fun syncLanguageToServer(localeTag: String) {
        val deviceId = deviceManager.deviceId
        val deviceSecret = deviceManager.deviceSecret
        // Map Android locale tags to server language codes
        val serverLang = when (localeTag) {
            "zh-TW" -> "zh"
            "zh-CN" -> "zh-CN"
            "in" -> "id"
            else -> localeTag
        }
        lifecycleScope.launch {
            try {
                NetworkModule.api.updateLanguage(mapOf(
                    "deviceId" to deviceId,
                    "deviceSecret" to deviceSecret,
                    "language" to serverLang
                ))
            } catch (e: Exception) {
                Timber.w(e, "Failed to sync language to server")
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
        val totalSlots = layoutPrefs.serverEntityLimit
        // Show local count first, then update from API
        val localCount = layoutPrefs.getRegisteredEntityIds().size
        tvEntityCount.text = "$localCount/$totalSlots"

        lifecycleScope.launch {
            try {
                val response = NetworkModule.api.getAllEntities(deviceId = deviceManager.deviceId)
                val boundCount = response.entities.size
                // #69: Save server entity limit so it refreshes immediately after payment
                layoutPrefs.serverEntityLimit = response.totalSlots
                tvEntityCount.text = "$boundCount/${response.totalSlots}"
            } catch (e: Exception) {
                Timber.e(e, "Failed to fetch entity count from API")
            }
        }
    }

    private fun updateCrashLogBadge() {
        val count = CrashLogManager.getCrashLogs().size
        btnCrashLogs.text = if (count > 0) {
            getString(R.string.crash_logs_title) + " ($count)"
        } else {
            getString(R.string.crash_logs_title)
        }
    }

    private fun loadAccountStatus() {
        accountStatusLoading.visibility = View.VISIBLE
        accountBoundLayout.visibility = View.GONE
        accountUnboundLayout.visibility = View.GONE

        lifecycleScope.launch {
            try {
                val status = NetworkModule.api.getBindEmailStatus(
                    deviceManager.deviceId,
                    deviceManager.deviceSecret
                )
                if (status.bound && (status.email != null || status.googleLinked || status.facebookLinked)) {
                    showAccountBoundState(
                        status.email ?: status.displayName ?: "",
                        status.emailVerified,
                        status.googleLinked,
                        status.facebookLinked
                    )
                } else {
                    showAccountUnboundState()
                }
                // Save roles and show debug logs button for admin/developer
                status.roles?.let { deviceManager.roles = it }
                btnDebugLogs.visibility = if (deviceManager.isDeveloperOrAdmin()) View.VISIBLE else View.GONE
                updateChannelApiDisplay(status.channelApiKey, status.channelApiSecret)
                loadChannelEntitySlotStatus()
            } catch (e: Exception) {
                Timber.e(e, "Failed to load account status")
                showAccountUnboundState()
            }
        }
    }

    private fun showAccountBoundState(
        email: String,
        verified: Boolean,
        googleLinked: Boolean = false,
        facebookLinked: Boolean = false
    ) {
        accountStatusLoading.visibility = View.GONE
        accountBoundLayout.visibility = View.VISIBLE
        accountUnboundLayout.visibility = View.GONE

        tvAccountEmail.text = email

        if (verified) {
            tvAccountVerified.text = getString(R.string.bind_email_verified)
            tvAccountVerified.setTextColor(0xFF4CAF50.toInt())
        } else {
            tvAccountVerified.text = getString(R.string.bind_email_not_verified)
            tvAccountVerified.setTextColor(0xFFFF9800.toInt())
        }

        // Show connected providers
        val providers = mutableListOf<String>()
        if (googleLinked) providers.add("Google")
        if (facebookLinked) providers.add("Facebook")
        if (providers.isNotEmpty()) {
            tvConnectedProviders.text = "${getString(R.string.connected_accounts)}: ${providers.joinToString(", ")}"
            tvConnectedProviders.visibility = View.VISIBLE
        } else {
            tvConnectedProviders.visibility = View.GONE
        }
    }

    private fun showAccountUnboundState() {
        accountStatusLoading.visibility = View.GONE
        accountBoundLayout.visibility = View.GONE
        accountUnboundLayout.visibility = View.VISIBLE
    }

    private fun startGoogleSignIn() {
        lifecycleScope.launch {
            try {
                val googleIdOption = GetGoogleIdOption.Builder()
                    .setServerClientId(getString(R.string.google_server_client_id))
                    .setFilterByAuthorizedAccounts(false)
                    .build()

                val request = GetCredentialRequest.Builder()
                    .addCredentialOption(googleIdOption)
                    .build()

                val credentialManager = CredentialManager.create(this@SettingsActivity)
                val result = credentialManager.getCredential(this@SettingsActivity, request)
                val credential = result.credential

                val googleIdTokenCredential = GoogleIdTokenCredential.createFrom(credential.data)
                val idToken = googleIdTokenCredential.idToken

                sendOAuthToBackend("google", mapOf(
                    "idToken" to idToken,
                    "deviceId" to deviceManager.deviceId,
                    "deviceSecret" to deviceManager.deviceSecret
                ))
            } catch (e: Exception) {
                Timber.e(e, "Google Sign-In failed")
                Toast.makeText(this@SettingsActivity, getString(R.string.social_login_failed), Toast.LENGTH_SHORT).show()
            }
        }
    }

    private fun startFacebookLogin() {
        LoginManager.getInstance().registerCallback(facebookCallbackManager,
            object : FacebookCallback<LoginResult> {
                override fun onSuccess(result: LoginResult) {
                    val accessToken = result.accessToken.token
                    sendOAuthToBackend("facebook", mapOf(
                        "accessToken" to accessToken,
                        "deviceId" to deviceManager.deviceId,
                        "deviceSecret" to deviceManager.deviceSecret
                    ))
                }

                override fun onCancel() {
                    Timber.d("Facebook login cancelled")
                }

                override fun onError(error: FacebookException) {
                    Timber.e(error, "Facebook login failed")
                    Toast.makeText(this@SettingsActivity, getString(R.string.social_login_failed), Toast.LENGTH_SHORT).show()
                }
            })
        LoginManager.getInstance().logInWithReadPermissions(this, listOf("email", "public_profile"))
    }

    private fun sendOAuthToBackend(provider: String, body: Map<String, String>) {
        lifecycleScope.launch {
            try {
                val response = if (provider == "google") {
                    NetworkModule.api.oauthGoogle(body)
                } else {
                    NetworkModule.api.oauthFacebook(body)
                }

                if (response.success) {
                    // Update device credentials if returned
                    if (response.deviceId != null && response.deviceSecret != null) {
                        deviceManager.setCredentials(response.deviceId, response.deviceSecret)
                    }
                    Toast.makeText(this@SettingsActivity,
                        getString(R.string.account_login_success_title), Toast.LENGTH_SHORT).show()
                    loadAccountStatus()
                } else {
                    Toast.makeText(this@SettingsActivity,
                        response.error ?: getString(R.string.social_login_failed), Toast.LENGTH_SHORT).show()
                }
            } catch (e: Exception) {
                Timber.e(e, "OAuth backend call failed")
                Toast.makeText(this@SettingsActivity,
                    getString(R.string.social_login_failed), Toast.LENGTH_SHORT).show()
            }
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        facebookCallbackManager.onActivityResult(requestCode, resultCode, data)
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
                        loadAccountStatus()
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
                        // Restore language preference from server
                        response.language?.let { lang ->
                            val localeTag = when (lang) {
                                "zh" -> "zh-TW"
                                "zh-CN" -> "zh-CN"
                                "id" -> "in"
                                else -> lang
                            }
                            AppCompatDelegate.setApplicationLocales(
                                LocaleListCompat.forLanguageTags(localeTag)
                            )
                        }
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

    // ============================================
    // LANGUAGE COLLAPSIBLE
    // ============================================

    private fun setupLangCollapsible() {
        langHeader.setOnClickListener {
            isLangExpanded = !isLangExpanded
            langContentLayout.visibility = if (isLangExpanded) View.VISIBLE else View.GONE
            langExpandArrow.animate()
                .rotation(if (isLangExpanded) 180f else 0f)
                .setDuration(200)
                .start()
        }
    }

    // ============================================
    // NOTIFICATION PREFERENCES
    // ============================================

    private var notifPrefsLoaded = false

    private fun setupNotifCollapsible() {
        notifHeader.setOnClickListener {
            isNotifExpanded = !isNotifExpanded
            notifContentLayout.visibility = if (isNotifExpanded) View.VISIBLE else View.GONE
            notifExpandArrow.animate()
                .rotation(if (isNotifExpanded) 180f else 0f)
                .setDuration(200)
                .start()
            // Lazy-load preferences on first expand
            if (isNotifExpanded && !notifPrefsLoaded) {
                notifPrefsLoaded = true
                loadNotificationPreferences()
            }
        }
    }

    private data class NotifPrefCategory(
        val key: String,
        val labelResId: Int
    )

    private val notifCategories = listOf(
        NotifPrefCategory("bot_reply", R.string.notif_pref_bot_reply),
        NotifPrefCategory("broadcast", R.string.notif_pref_broadcast),
        NotifPrefCategory("speak_to", R.string.notif_pref_speak_to),
        NotifPrefCategory("feedback_resolved", R.string.notif_pref_feedback),
        NotifPrefCategory("todo_done", R.string.notif_pref_todo),
        NotifPrefCategory("scheduled", R.string.notif_pref_scheduled)
    )

    private fun loadNotificationPreferences() {
        // Show loading state
        notifPrefsContainer.removeAllViews()
        val loadingText = TextView(this).apply {
            text = getString(R.string.notif_prefs_loading)
            textSize = 13f
            setTextColor(0x99FFFFFF.toInt())
        }
        notifPrefsContainer.addView(loadingText)

        lifecycleScope.launch {
            try {
                val response = NetworkModule.api.getNotificationPreferences(
                    deviceId = deviceManager.deviceId,
                    deviceSecret = deviceManager.deviceSecret
                )
                if (response.success) {
                    buildNotifPrefToggles(response.prefs)
                } else {
                    showNotifPrefsError()
                }
            } catch (e: Exception) {
                Timber.e(e, "Failed to load notification preferences")
                showNotifPrefsError()
            }
        }
    }

    private fun buildNotifPrefToggles(prefs: Map<String, Boolean>) {
        notifPrefsContainer.removeAllViews()

        for (category in notifCategories) {
            val enabled = prefs[category.key] ?: true

            val row = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = android.view.Gravity.CENTER_VERTICAL
                val lp = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT
                )
                lp.bottomMargin = dpToPx(4)
                layoutParams = lp
                setPadding(0, dpToPx(4), 0, dpToPx(4))
            }

            val label = TextView(this).apply {
                text = getString(category.labelResId)
                textSize = 14f
                setTextColor(0xDDFFFFFF.toInt())
                layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
            }

            val toggle = MaterialSwitch(this).apply {
                isChecked = enabled
                setOnCheckedChangeListener { _, isChecked ->
                    updateNotifPref(category.key, isChecked)
                }
            }

            row.addView(label)
            row.addView(toggle)
            notifPrefsContainer.addView(row)
        }
    }

    private fun updateNotifPref(category: String, enabled: Boolean) {
        lifecycleScope.launch {
            try {
                val body = mapOf<String, Any>(
                    "deviceId" to deviceManager.deviceId,
                    "deviceSecret" to deviceManager.deviceSecret,
                    "prefs" to mapOf(category to enabled)
                )
                val response = NetworkModule.api.updateNotificationPreferences(body)
                if (!response.success) {
                    Timber.w("Failed to update notification pref: ${response.message}")
                }
            } catch (e: Exception) {
                Timber.e(e, "Failed to update notification preference")
                TelemetryHelper.trackError(e, mapOf("action" to "update_notif_pref", "category" to category))
            }
        }
    }

    private fun showNotifPrefsError() {
        notifPrefsContainer.removeAllViews()
        val errorText = TextView(this).apply {
            text = getString(R.string.notif_prefs_error)
            textSize = 13f
            setTextColor(0x99FFFFFF.toInt())
        }
        notifPrefsContainer.addView(errorText)
    }

    // ============================================
    // BROADCAST SETTINGS
    // ============================================

    private var broadcastPrefsLoaded = false

    private fun setupBroadcastSettingsCollapsible() {
        broadcastSettingsHeader.setOnClickListener {
            isBroadcastSettingsExpanded = !isBroadcastSettingsExpanded
            broadcastSettingsContentLayout.visibility = if (isBroadcastSettingsExpanded) View.VISIBLE else View.GONE
            broadcastSettingsExpandArrow.animate()
                .rotation(if (isBroadcastSettingsExpanded) 180f else 0f)
                .setDuration(200)
                .start()
            // Lazy-load preferences on first expand
            if (isBroadcastSettingsExpanded && !broadcastPrefsLoaded) {
                broadcastPrefsLoaded = true
                loadBroadcastPreferences()
            }
        }
    }

    private fun loadBroadcastPreferences() {
        // Show loading state
        broadcastPrefsContainer.removeAllViews()
        val loadingText = TextView(this).apply {
            text = getString(R.string.notif_prefs_loading)
            textSize = 13f
            setTextColor(0x99FFFFFF.toInt())
        }
        broadcastPrefsContainer.addView(loadingText)

        lifecycleScope.launch {
            try {
                val response = NetworkModule.api.getDevicePreferences(
                    deviceId = deviceManager.deviceId,
                    deviceSecret = deviceManager.deviceSecret
                )
                if (response.success) {
                    buildBroadcastPrefToggles(response.prefs)
                } else {
                    showBroadcastPrefsError()
                }
            } catch (e: Exception) {
                Timber.e(e, "Failed to load broadcast preferences")
                showBroadcastPrefsError()
            }
        }
    }

    private fun buildBroadcastPrefToggles(prefs: Map<String, Boolean>) {
        broadcastPrefsContainer.removeAllViews()

        val enabled = prefs["broadcast_recipient_info"] ?: true

        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = android.view.Gravity.CENTER_VERTICAL
            val lp = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            )
            lp.bottomMargin = dpToPx(4)
            layoutParams = lp
            setPadding(0, dpToPx(4), 0, dpToPx(4))
        }

        val label = TextView(this).apply {
            text = getString(R.string.broadcast_pref_recipient_info)
            textSize = 14f
            setTextColor(0xDDFFFFFF.toInt())
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        }

        val toggle = MaterialSwitch(this).apply {
            isChecked = enabled
            setOnCheckedChangeListener { _, isChecked ->
                updateBroadcastPref("broadcast_recipient_info", isChecked)
            }
        }

        row.addView(label)
        row.addView(toggle)
        broadcastPrefsContainer.addView(row)
    }

    private fun updateBroadcastPref(key: String, enabled: Boolean) {
        lifecycleScope.launch {
            try {
                val body = mapOf<String, Any>(
                    "deviceId" to deviceManager.deviceId,
                    "deviceSecret" to deviceManager.deviceSecret,
                    "prefs" to mapOf(key to enabled)
                )
                val response = NetworkModule.api.updateDevicePreferences(body)
                if (!response.success) {
                    Timber.w("Failed to update broadcast pref: ${response.message}")
                }
            } catch (e: Exception) {
                Timber.e(e, "Failed to update broadcast preference")
                TelemetryHelper.trackError(e, mapOf("action" to "update_broadcast_pref", "key" to key))
            }
        }
    }

    private fun showBroadcastPrefsError() {
        broadcastPrefsContainer.removeAllViews()
        val errorText = TextView(this).apply {
            text = getString(R.string.notif_prefs_error)
            textSize = 13f
            setTextColor(0x99FFFFFF.toInt())
        }
        broadcastPrefsContainer.addView(errorText)
    }

    // ─── Remote Control ────────────────────────────────────────────────────

    private var remoteControlPrefsLoaded = false

    private fun setupRemoteControlCollapsible() {
        remoteControlHeader.setOnClickListener {
            isRemoteControlExpanded = !isRemoteControlExpanded
            remoteControlContentLayout.visibility = if (isRemoteControlExpanded) View.VISIBLE else View.GONE
            remoteControlExpandArrow.animate()
                .rotation(if (isRemoteControlExpanded) 180f else 0f)
                .setDuration(200)
                .start()
            if (isRemoteControlExpanded && !remoteControlPrefsLoaded) {
                remoteControlPrefsLoaded = true
                loadRemoteControlPrefs()
            }
        }
    }

    private fun loadRemoteControlPrefs() {
        remoteControlContainer.removeAllViews()
        val loadingText = TextView(this).apply {
            text = getString(R.string.notif_prefs_loading)
            textSize = 13f
            setTextColor(0x99FFFFFF.toInt())
        }
        remoteControlContainer.addView(loadingText)

        lifecycleScope.launch {
            try {
                val response = NetworkModule.api.getDevicePreferences(
                    deviceId = deviceManager.deviceId,
                    deviceSecret = deviceManager.deviceSecret
                )
                if (response.success) {
                    buildRemoteControlUi(response.prefs)
                } else {
                    remoteControlContainer.removeAllViews()
                }
            } catch (e: Exception) {
                Timber.e(e, "Failed to load remote control preferences")
            }
        }
    }

    private fun buildRemoteControlUi(prefs: Map<String, Boolean>) {
        remoteControlContainer.removeAllViews()
        val enabled = prefs["remote_control_enabled"] ?: false

        // Accessibility status indicator
        val isActive = isAccessibilityServiceEnabled()
        val statusText = TextView(this).apply {
            text = if (isActive) getString(R.string.remote_control_status_active)
                   else getString(R.string.remote_control_status_inactive)
            textSize = 12f
            setTextColor(if (isActive) 0xFF4CAF50.toInt() else 0xFFFF9800.toInt())
            val lp = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            )
            lp.bottomMargin = dpToPx(8)
            layoutParams = lp
        }
        remoteControlContainer.addView(statusText)

        // Enable/disable toggle row
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = android.view.Gravity.CENTER_VERTICAL
            val lp = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            )
            lp.bottomMargin = dpToPx(4)
            layoutParams = lp
            setPadding(0, dpToPx(4), 0, dpToPx(4))
        }
        val label = TextView(this).apply {
            text = getString(R.string.remote_control_toggle_label)
            textSize = 14f
            setTextColor(0xDDFFFFFF.toInt())
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        }
        val toggle = MaterialSwitch(this).apply {
            isChecked = enabled
            setOnCheckedChangeListener { _, isChecked ->
                TelemetryHelper.trackAction("remote_control_toggle", mapOf("enabled" to isChecked.toString()))
                updateRemoteControlPref(isChecked)
            }
        }
        row.addView(label)
        row.addView(toggle)
        remoteControlContainer.addView(row)

        // Button to open system Accessibility Settings (with mandatory prominent disclosure)
        val btnAccessibility = com.google.android.material.button.MaterialButton(this).apply {
            text = getString(R.string.remote_control_open_accessibility)
            setOnClickListener {
                TelemetryHelper.trackAction("remote_control_open_accessibility")
                com.google.android.material.dialog.MaterialAlertDialogBuilder(this@SettingsActivity)
                    .setTitle(getString(R.string.remote_control_disclosure_title))
                    .setMessage(getString(R.string.remote_control_disclosure_message))
                    .setPositiveButton(getString(R.string.remote_control_disclosure_confirm)) { _, _ ->
                        startActivity(android.content.Intent(android.provider.Settings.ACTION_ACCESSIBILITY_SETTINGS))
                    }
                    .setNegativeButton(getString(R.string.cancel), null)
                    .show()
            }
            val lp = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            )
            lp.topMargin = dpToPx(8)
            layoutParams = lp
        }
        remoteControlContainer.addView(btnAccessibility)
    }

    private fun updateRemoteControlPref(enabled: Boolean) {
        lifecycleScope.launch {
            try {
                val body = mapOf<String, Any>(
                    "deviceId" to deviceManager.deviceId,
                    "deviceSecret" to deviceManager.deviceSecret,
                    "prefs" to mapOf("remote_control_enabled" to enabled)
                )
                val response = NetworkModule.api.updateDevicePreferences(body)
                if (!response.success) {
                    Timber.w("Failed to update remote control pref: ${response.message}")
                }
            } catch (e: Exception) {
                Timber.e(e, "Failed to update remote control preference")
                TelemetryHelper.trackError(e, mapOf("action" to "update_remote_control_pref"))
            }
        }
    }

    private fun isAccessibilityServiceEnabled(): Boolean {
        val am = getSystemService(ACCESSIBILITY_SERVICE) as android.view.accessibility.AccessibilityManager
        return am.getEnabledAccessibilityServiceList(
            android.accessibilityservice.AccessibilityServiceInfo.FEEDBACK_ALL_MASK
        ).any { info ->
            info.resolveInfo.serviceInfo.packageName == packageName &&
            info.resolveInfo.serviceInfo.name.endsWith(".ScreenControlService")
        }
    }

    // ─── Channel API ──────────────────────────────────────────────────────────

    private fun setupChannelApiCollapsible() {
        channelApiHeader.setOnClickListener {
            isChannelApiExpanded = !isChannelApiExpanded
            channelApiContentLayout.visibility = if (isChannelApiExpanded) View.VISIBLE else View.GONE
            channelApiExpandArrow.animate()
                .rotation(if (isChannelApiExpanded) 180f else 0f)
                .setDuration(200)
                .start()
        }

        btnChannelApiToggleSecret.setOnClickListener {
            channelApiSecretVisible = !channelApiSecretVisible
            if (channelApiSecretVisible) {
                tvChannelApiSecret.text = cachedChannelSecret ?: "—"
                btnChannelApiToggleSecret.text = getString(R.string.hide_label)
            } else {
                tvChannelApiSecret.text = "••••••••••••••••"
                btnChannelApiToggleSecret.text = getString(R.string.show_label)
            }
        }

        btnChannelApiCopy.setOnClickListener {
            val key = tvChannelApiKey.text.toString()
            val secret = cachedChannelSecret ?: return@setOnClickListener
            val text = "channel_api_key: $key\nchannel_api_secret: $secret"
            val clip = getSystemService(CLIPBOARD_SERVICE) as ClipboardManager
            clip.setPrimaryClip(ClipData.newPlainText("channel_api", text))
            Toast.makeText(this, getString(R.string.channel_api_copied), Toast.LENGTH_SHORT).show()
            TelemetryHelper.trackAction("channel_api_copy")
        }
    }

    private fun loadChannelEntitySlotStatus() {
        lifecycleScope.launch {
            try {
                val response = NetworkModule.api.getAllEntities(deviceId = deviceManager.deviceId)
                val channelEntities = response.entities.filter { it.bindingType == "channel" }
                if (channelEntities.isNotEmpty()) {
                    val slots = channelEntities.joinToString("  ") { "⚡ #${it.entityId}" }
                    tvChannelApiSlotStatus.text = getString(R.string.channel_api_slots_active, slots)
                    tvChannelApiSlotStatus.visibility = View.VISIBLE
                } else {
                    tvChannelApiSlotStatus.visibility = View.GONE
                }
            } catch (e: Exception) {
                tvChannelApiSlotStatus.visibility = View.GONE
            }
        }
    }

    private fun updateChannelApiDisplay(apiKey: String?, apiSecret: String?) {
        cachedChannelSecret = apiSecret
        if (!apiKey.isNullOrEmpty()) {
            tvChannelApiKey.text = apiKey
            tvChannelApiSecret.text = "••••••••••••••••"
            channelApiSecretVisible = false
            btnChannelApiToggleSecret.text = getString(R.string.show_label)
            tvChannelApiNoKey.visibility = View.GONE
            tvChannelApiKey.visibility = View.VISIBLE
            tvChannelApiSecret.visibility = View.VISIBLE
            channelApiActions.visibility = View.VISIBLE
        } else {
            tvChannelApiNoKey.visibility = View.VISIBLE
            tvChannelApiKey.visibility = View.GONE
            tvChannelApiSecret.visibility = View.GONE
            channelApiActions.visibility = View.GONE
        }
    }
}
