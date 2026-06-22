package com.hank.clawlive

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.lifecycle.lifecycleScope
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.hank.clawlive.data.local.DeviceManager
import com.hank.clawlive.data.remote.NetworkModule
import com.hank.clawlive.data.remote.TelemetryHelper
import com.hank.clawlive.fcm.ClawFcmService
import com.hank.clawlive.ui.AiChatFabHelper
import com.hank.clawlive.ui.BottomNavHelper
import com.hank.clawlive.ui.NavItem
import com.hank.clawlive.ui.NavResumeController
import com.hank.clawlive.ui.RecordingIndicatorHelper
import com.hank.clawlive.ui.reconnect.ReconnectBackoff
import com.hank.clawlive.ui.reconnect.ReconnectOverlayController
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import timber.log.Timber

/**
 * Home — WebView host for portal/dashboard.html.
 *
 * Replaces the previous native home UI (entity cards, binding code, borrow card).
 * The web page provides the entity grid, add-entity flow, borrow card, channel
 * promo and edit-mode reorder — kept in sync between web + Android automatically.
 */
class MainActivity : AppCompatActivity() {

    private val deviceManager: DeviceManager by lazy { DeviceManager.getInstance(this) }
    private var webView: WebView? = null
    private var reconnectOverlay: ReconnectOverlayController? = null

    /** Persists and restores the last-active tab across process-death restarts. */
    private val navResume: NavResumeController by lazy {
        val prefs = getSharedPreferences("nav_resume_prefs", MODE_PRIVATE)
        NavResumeController(object : NavResumeController.Store {
            override fun readLastNav(): String? = prefs.getString("last_nav", null)
            override fun writeLastNav(name: String) { prefs.edit().putString("last_nav", name).apply() }
            override fun clearLastNav() { prefs.edit().remove("last_nav").apply() }
        })
    }

    private val notifPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        Timber.d("[FCM] POST_NOTIFICATIONS permission granted=$granted")
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        TelemetryHelper.init(this)
        com.hank.clawlive.data.remote.SocketManager.connect(this)

        // TTS foreground service (bot voice replies)
        val ttsIntent = Intent(this, com.hank.clawlive.service.TtsService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(ttsIntent)
        } else {
            startService(ttsIntent)
        }

        observeLocationRequests()

        ClawFcmService.createChannels(this)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED
            ) {
                notifPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
            }
        }

        WindowCompat.setDecorFitsSystemWindows(window, false)
        setContentView(R.layout.activity_main)

        // Process-death restore: if the user was on a non-HOME tab when the OS
        // killed the process, re-launch that tab Activity so they land back there
        // instead of the dashboard. Skip when a deep-link intent is present — the
        // App Link target always takes priority over the saved tab.
        if (intent?.data == null) {
            restoreLastNavIfNeeded()
        }

        BottomNavHelper.setup(this, NavItem.HOME)
        AiChatFabHelper.setup(this, "home")
        setupWindowInsets()
        registerDeviceThenLoadWebView()
        checkForAppUpdate()
    }

    /**
     * On process-death restart, re-launch the last-active tab Activity so the
     * user is not always dropped onto the dashboard (card_489a8836).
     * Uses FLAG_ACTIVITY_REORDER_TO_FRONT to avoid duplicating the Activity if
     * Android already has a saved instance in the back-stack restoration path.
     */
    private fun restoreLastNavIfNeeded() {
        val item = navResume.restoredNavItem() ?: return
        val targetClass: Class<*> = when (item) {
            NavItem.CHAT -> ChatActivity::class.java
            NavItem.MISSION -> MissionControlActivity::class.java
            NavItem.SETTINGS -> SettingsActivity::class.java
            NavItem.CARDS -> {
                // CARDS uses WebViewActivity with a specific URL; handled by BottomNavHelper.
                // Re-route to home for CARDS since there is no standalone CARDS Activity class.
                return
            }
            NavItem.HOME -> return
        }
        Timber.d("[NavResume] Process-death restore → re-launching $item")
        val intent = Intent(this, targetClass).apply {
            flags = Intent.FLAG_ACTIVITY_REORDER_TO_FRONT
        }
        startActivity(intent)
        @Suppress("DEPRECATION")
        overridePendingTransition(0, 0)
    }

    private fun registerDeviceThenLoadWebView() {
        // Fresh installs auto-generate deviceId/deviceSecret in DeviceManager, but those UUIDs
        // are NOT yet known to the backend's devices[] map. dashboard.html's checkAuth() calls
        // /api/auth/device-login, which 401s on unrecognized credentials and redirects the
        // WebView to portal/index.html (the public login page). Calling /api/device/register
        // up-front inserts the auto-generated UUID into devices[] so device-login succeeds and
        // the user lands on the entity grid. No-op on devices already registered.
        lifecycleScope.launch {
            try {
                withContext(Dispatchers.IO) {
                    NetworkModule.api.registerDevice(
                        com.hank.clawlive.data.model.RegisterRequest(
                            entityId = 0,
                            deviceId = deviceManager.deviceId,
                            deviceSecret = deviceManager.deviceSecret,
                            appVersion = deviceManager.appVersion
                        )
                    )
                }
                Timber.d("[Home] Device registered with backend (or already known)")
            } catch (e: Exception) {
                // Already-registered devices may return non-2xx; non-fatal. WebView still loads.
                Timber.d(e, "[Home] registerDevice non-critical error (likely already registered)")
            }
            setupWebView()
        }
    }

    override fun onResume() {
        super.onResume()
        TelemetryHelper.trackPageView(this, "main")
        RecordingIndicatorHelper.attach(this)
        // Record HOME as the current tab so process-death restart doesn't jump
        // to a stale non-home tab when the user deliberately navigated back here.
        navResume.onNavigatedTo(NavItem.HOME)
    }

    override fun onPause() {
        super.onPause()
        RecordingIndicatorHelper.detach()
    }

    private fun observeLocationRequests() {
        lifecycleScope.launch {
            com.hank.clawlive.data.remote.SocketManager.locationRequestFlow.collect { json ->
                val requestId = json.optString("requestId", null)
                Timber.d("[Location] Socket location_request, requestId=$requestId")
                com.hank.clawlive.location.LocationHelper.fetchAndReportAsync(
                    applicationContext, requestId
                )
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
                    getSharedPreferences("update_prefs", MODE_PRIVATE)
                        .edit().remove("force_update_pending").remove("force_update_version").apply()
                    return@launch
                }

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

        TelemetryHelper.trackAction(
            "update_dialog_shown",
            mapOf(
                "latestVersion" to latestVersion,
                "isForceUpdate" to isForceUpdate.toString()
            )
        )
    }

    // ── WebView ──────────────────────────────────────────────────────────

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupWebView() {
        val container = findViewById<FrameLayout>(R.id.homeWebViewContainer)
        val wv = WebView(this).apply {
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            )
            setBackgroundColor(Color.parseColor("#0D0D1A"))

            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.defaultTextEncodingName = "UTF-8"
            settings.loadWithOverviewMode = false
            settings.useWideViewPort = false
            settings.userAgentString = settings.userAgentString + " EClawAndroid"

            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(
                    view: WebView?,
                    request: WebResourceRequest?
                ): Boolean {
                    val url = request?.url?.toString() ?: return false
                    if (url.contains("eclawbot.com")) return false
                    try {
                        startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
                    } catch (e: Exception) {
                        Timber.e(e, "[Home] Failed to open external URL: $url")
                    }
                    return true
                }

                override fun onPageFinished(view: WebView?, url: String?) {
                    super.onPageFinished(view, url)
                    Timber.d("[Home] WebView page loaded: $url")
                    injectCredentials(view)
                    reconnectOverlay?.onPageFinished()
                }

                override fun onReceivedError(
                    view: WebView?,
                    request: WebResourceRequest?,
                    error: WebResourceError?
                ) {
                    super.onReceivedError(view, request, error)
                    if (request?.isForMainFrame != true) return
                    val code = error?.errorCode ?: WebViewClient.ERROR_UNKNOWN
                    if (!ReconnectBackoff.isTransportError(code)) return
                    val failingUrl = request.url?.toString()
                    Timber.w("[Home] main-frame transport error code=$code url=$failingUrl — showing reconnect overlay")
                    reconnectOverlay?.onTransportError(failingUrl)
                }
            }
            webChromeClient = WebChromeClient()
        }

        container.addView(wv)
        webView = wv
        reconnectOverlay = ReconnectOverlayController(this, container, wv, tag = "Home")

        // DeviceManager auto-generates these on first access — they are never null.
        // registerDeviceThenLoadWebView() already inserted them into the backend's
        // devices[] map so dashboard.html's /api/auth/device-login can succeed.
        val deviceId = deviceManager.deviceId
        val deviceSecret = deviceManager.deviceSecret
        // App Links (/r/ universal entry, spec §3) land here — route the
        // WebView to the deep-link target; plain launches keep the dashboard.
        val url = com.hank.clawlive.util.RedirectLinkParser
            .buildPortalUrl(intent?.data, deviceId, deviceSecret)
        wv.loadUrl(com.hank.clawlive.util.PortalUrlHelper.withAppLang(this, url))
    }

    // singleTask relaunch from a verified App Link while already running.
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        val data = intent.data ?: return
        if (!com.hank.clawlive.util.RedirectLinkParser.isRedirectLink(data)) return
        val deviceId = deviceManager.deviceId ?: return
        val deviceSecret = deviceManager.deviceSecret ?: return
        val url = com.hank.clawlive.util.RedirectLinkParser
            .buildPortalUrl(data, deviceId, deviceSecret)
        webView?.loadUrl(com.hank.clawlive.util.PortalUrlHelper.withAppLang(this, url))
    }

    private fun injectCredentials(webView: WebView?) {
        val deviceId = deviceManager.deviceId ?: return
        val deviceSecret = deviceManager.deviceSecret ?: return
        val js = """
            (function() {
                try {
                    if (!localStorage.getItem('deviceId')) {
                        localStorage.setItem('deviceId', '$deviceId');
                        localStorage.setItem('deviceSecret', '$deviceSecret');
                    }
                } catch(e) {}
            })();
        """.trimIndent()
        webView?.evaluateJavascript(js, null)
    }

    private fun setupWindowInsets() {
        val container = findViewById<FrameLayout>(R.id.homeWebViewContainer)
        ViewCompat.setOnApplyWindowInsetsListener(container) { v, insets ->
            val systemBars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            v.setPadding(v.paddingLeft, systemBars.top, v.paddingRight, v.paddingBottom)
            insets
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (webView?.canGoBack() == true) {
            webView?.goBack()
            return
        }
        @Suppress("DEPRECATION")
        super.onBackPressed()
    }

    override fun onDestroy() {
        reconnectOverlay?.destroy()
        reconnectOverlay = null
        webView?.destroy()
        webView = null
        Timber.d("[Home] onDestroy: WebView cleaned up")
        super.onDestroy()
    }
}
