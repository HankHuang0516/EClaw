package com.hank.clawlive

import android.annotation.SuppressLint
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import com.hank.clawlive.data.local.DeviceManager
import com.hank.clawlive.ui.AiChatFabHelper
import com.hank.clawlive.ui.BottomNavHelper
import com.hank.clawlive.ui.NavItem
import com.hank.clawlive.ui.NavResumeController
import com.hank.clawlive.ui.RecordingIndicatorHelper
import com.hank.clawlive.ui.nav.EClawNativeNavBridge
import com.hank.clawlive.ui.reconnect.ReconnectBackoff
import com.hank.clawlive.ui.reconnect.ReconnectOverlayController
import timber.log.Timber

/**
 * Mission Control — WebView host for portal/mission.html.
 *
 * The web page provides its own sub-tab navigation (Mission | Kanban | Schedule |
 * Env Vars | Remote Control), so no native TabLayout is needed.
 */
class MissionControlActivity : AppCompatActivity() {

    private val deviceManager: DeviceManager by lazy { DeviceManager.getInstance(this) }
    private var webView: WebView? = null
    private var reconnectOverlay: ReconnectOverlayController? = null
    private var pendingNavIntent: String? = null
    private var pageReady: Boolean = false

    private val navResume: NavResumeController by lazy {
        val prefs = getSharedPreferences("nav_resume_prefs", MODE_PRIVATE)
        NavResumeController(object : NavResumeController.Store {
            override fun readLastNav(): String? = prefs.getString("last_nav", null)
            override fun writeLastNav(name: String) { prefs.edit().putString("last_nav", name).apply() }
            override fun clearLastNav() { prefs.edit().remove("last_nav").apply() }
        })
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        setContentView(R.layout.activity_mission_control)

        pendingNavIntent = intent?.getStringExtra(EClawNativeNavBridge.EXTRA_NAV_INTENT)
        BottomNavHelper.setup(this, NavItem.MISSION)
        AiChatFabHelper.setup(this, "mission")
        setupWindowInsets()
        setupWebView()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        val incoming = intent.getStringExtra(EClawNativeNavBridge.EXTRA_NAV_INTENT) ?: return
        pendingNavIntent = incoming
        if (pageReady) deliverPendingNavIntent()
    }

    override fun onResume() {
        super.onResume()
        RecordingIndicatorHelper.attach(this)
        // Persist current tab so process-death restart can restore here (card_489a8836).
        navResume.onNavigatedTo(NavItem.MISSION)
    }

    override fun onPause() {
        super.onPause()
        RecordingIndicatorHelper.detach()
    }

    // ── WebView ──────────────────────────────────────────────────────────

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupWebView() {
        val container = findViewById<FrameLayout>(R.id.missionWebViewContainer)
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
                        Timber.e(e, "[Mission] Failed to open external URL: $url")
                    }
                    return true
                }

                override fun onPageFinished(view: WebView?, url: String?) {
                    super.onPageFinished(view, url)
                    Timber.d("[Mission] WebView page loaded: $url")
                    injectCredentials(view)
                    view?.evaluateJavascript(EClawNativeNavBridge.JS_SHIM, null)
                    pageReady = true
                    deliverPendingNavIntent()
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
                    Timber.w("[Mission] main-frame transport error code=$code url=$failingUrl — showing reconnect overlay")
                    reconnectOverlay?.onTransportError(failingUrl)
                }
            }
            webChromeClient = WebChromeClient()
            addJavascriptInterface(
                EClawNativeNavBridge(this@MissionControlActivity),
                EClawNativeNavBridge.BRIDGE_NAME
            )
        }

        container.addView(wv)
        webView = wv
        reconnectOverlay = ReconnectOverlayController(this, container, wv, tag = "Mission")

        val deviceId = deviceManager.deviceId
        val deviceSecret = deviceManager.deviceSecret
        val baseUrl = "https://eclawbot.com/portal/mission.html"
        val url = if (deviceId != null && deviceSecret != null)
            "$baseUrl?deviceId=$deviceId&deviceSecret=$deviceSecret"
        else baseUrl
        wv.loadUrl(com.hank.clawlive.util.PortalUrlHelper.withAppLang(this, url))
    }

    private fun deliverPendingNavIntent() {
        val nav = pendingNavIntent ?: return
        pendingNavIntent = null
        webView?.evaluateJavascript(EClawNativeNavBridge.buildIntentReplayJs(nav), null)
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

    // ── Window insets ───────────────────────────────────────���────────────

    private fun setupWindowInsets() {
        val container = findViewById<FrameLayout>(R.id.missionWebViewContainer)
        ViewCompat.setOnApplyWindowInsetsListener(container) { v, insets ->
            val systemBars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            v.setPadding(v.paddingLeft, systemBars.top, v.paddingRight, v.paddingBottom)
            insets
        }
    }

    // ── Lifecycle ────────────────────────────────────────────────────────

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
        Timber.d("[Mission] onDestroy: WebView cleaned up")
        super.onDestroy()
    }
}
