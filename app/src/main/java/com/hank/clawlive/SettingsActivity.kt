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
import com.hank.clawlive.billing.BillingManager
import com.hank.clawlive.billing.SubscriptionState
import com.hank.clawlive.data.local.DeviceManager
import com.hank.clawlive.data.local.LayoutPreferences
import com.hank.clawlive.data.local.UsageManager
import com.hank.clawlive.data.remote.NetworkModule
import com.hank.clawlive.data.remote.TelemetryHelper
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
    private lateinit var btnMarkBug: MaterialButton
    private lateinit var tvMarkStatus: TextView
    private lateinit var btnPrivacyPolicy: MaterialButton
    private lateinit var btnWebPortal: MaterialButton
    private lateinit var tvViewFeedbackHistory: TextView
    private lateinit var chipGroupLanguage: ChipGroup
    private lateinit var chipLangEn: Chip
    private lateinit var chipLangZh: Chip
    private lateinit var btnBack: ImageButton
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
        billingManager.refreshState()
        updateUsageDisplay()
        updateEntityCount()
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
        btnMarkBug = findViewById(R.id.btnMarkBug)
        tvMarkStatus = findViewById(R.id.tvMarkStatus)
        btnPrivacyPolicy = findViewById(R.id.btnPrivacyPolicy)
        btnWebPortal = findViewById(R.id.btnWebPortal)
        tvViewFeedbackHistory = findViewById(R.id.tvViewFeedbackHistory)
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

        btnMarkBug.setOnClickListener {
            markBugMoment()
        }

        btnPrivacyPolicy.setOnClickListener {
            startActivity(android.content.Intent(this, PrivacyPolicyActivity::class.java))
        }

        btnWebPortal.setOnClickListener {
            showWebPortalDialog()
        }

        tvViewFeedbackHistory.setOnClickListener {
            startActivity(Intent(this, FeedbackHistoryActivity::class.java))
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

    private fun updateEntityCount() {
        val maxEntities = if (usageManager.isPremium) 8 else 4
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

        val msg = "Device ID:\n$deviceId\n\n" +
            "Device Secret:\n$deviceSecret\n\n" +
            "Portal URL:\n$portalUrl"

        AlertDialog.Builder(this)
            .setTitle(getString(R.string.web_portal))
            .setMessage(msg)
            .setPositiveButton("Open Portal") { _, _ ->
                startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, Uri.parse(portalUrl)))
            }
            .setNeutralButton("Copy Credentials") { _, _ ->
                val clip = getSystemService(CLIPBOARD_SERVICE) as ClipboardManager
                clip.setPrimaryClip(ClipData.newPlainText("credentials",
                    "Device ID: $deviceId\nDevice Secret: $deviceSecret"))
                Toast.makeText(this, getString(R.string.confirm_copy), Toast.LENGTH_SHORT).show()
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    private fun markBugMoment() {
        lifecycleScope.launch {
            try {
                val body = mapOf("deviceId" to deviceManager.deviceId)
                NetworkModule.api.markFeedback(body)
                tvMarkStatus.visibility = View.VISIBLE
                tvMarkStatus.text = getString(R.string.feedback_marked,
                    java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.getDefault())
                        .format(java.util.Date()))
                btnMarkBug.text = getString(R.string.feedback_marked_btn)
                btnMarkBug.postDelayed({
                    btnMarkBug.text = getString(R.string.feedback_mark)
                }, 5000)
                TelemetryHelper.trackAction("mark_bug_moment")
            } catch (e: Exception) {
                Timber.e(e, "Failed to mark bug moment")
                TelemetryHelper.trackError(e, mapOf("action" to "mark_bug_moment"))
                Toast.makeText(this@SettingsActivity, "Failed: ${e.message}", Toast.LENGTH_SHORT).show()
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
