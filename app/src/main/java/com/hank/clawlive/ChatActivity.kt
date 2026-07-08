package com.hank.clawlive

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.view.View
import android.webkit.ValueCallback
import android.webkit.WebView
import android.widget.ProgressBar
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.updateLayoutParams
import com.google.android.material.button.MaterialButton
import com.hank.clawlive.data.local.ChatPreferences
import com.hank.clawlive.data.local.DeviceManager
import com.hank.clawlive.data.remote.TelemetryHelper
import com.hank.clawlive.ui.AiChatFabHelper
import com.hank.clawlive.ui.BottomNavHelper
import com.hank.clawlive.ui.NavItem
import com.hank.clawlive.ui.NavResumeController
import com.hank.clawlive.ui.RecordingIndicatorHelper
import com.hank.clawlive.ui.chat.ChatJsBridge
import com.hank.clawlive.ui.chat.ChatWebViewManager
import com.hank.clawlive.ui.nav.EClawNativeNavBridge
import timber.log.Timber

class ChatActivity : AppCompatActivity() {

    private val deviceManager: DeviceManager by lazy { DeviceManager.getInstance(this) }
    private val chatPrefs: ChatPreferences by lazy { ChatPreferences.getInstance(this) }

    private val navResume: NavResumeController by lazy {
        val prefs = getSharedPreferences("nav_resume_prefs", MODE_PRIVATE)
        NavResumeController(object : NavResumeController.Store {
            override fun readLastNav(): String? = prefs.getString("last_nav", null)
            override fun writeLastNav(name: String) { prefs.edit().putString("last_nav", name).apply() }
            override fun clearLastNav() { prefs.edit().remove("last_nav").apply() }
        })
    }

    private lateinit var webView: WebView
    private lateinit var loadingIndicator: ProgressBar
    private lateinit var offlineView: View
    private lateinit var webViewManager: ChatWebViewManager
    private var jsBridge: ChatJsBridge? = null
    private var pendingNavIntent: String? = null
    private var pageReady: Boolean = false

    companion object {
        private const val CHAT_URL = "https://eclawbot.com"
    }

    // File chooser handling
    private var pendingFileCallback: ValueCallback<Array<Uri>>? = null

    private val fileChooserLauncher = registerForActivityResult(
        ActivityResultContracts.GetMultipleContents()
    ) { uris ->
        val result = if (uris.isNullOrEmpty()) null else uris.toTypedArray()
        webViewManager.onFileChooserResult(result)
    }

    private val recordAudioPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        Timber.d("[MIC_DEBUG] Permission result callback: granted=$granted")
        if (!granted) {
            Timber.w("[MIC_DEBUG] Microphone permission DENIED by user")
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        setContentView(R.layout.activity_chat)

        pendingNavIntent = intent?.getStringExtra(EClawNativeNavBridge.EXTRA_NAV_INTENT)
        initViews()
        setupEdgeToEdge()
        setupWebView()

        BottomNavHelper.setup(this, NavItem.CHAT)
        AiChatFabHelper.setup(this, "chat")

        webViewManager.loadChatPage(CHAT_URL)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        val incoming = intent.getStringExtra(EClawNativeNavBridge.EXTRA_NAV_INTENT) ?: return
        pendingNavIntent = incoming
        if (pageReady) deliverPendingNavIntent()
    }

    private fun deliverPendingNavIntent() {
        val nav = pendingNavIntent ?: return
        pendingNavIntent = null
        webView.evaluateJavascript(EClawNativeNavBridge.buildIntentReplayJs(nav), null)
    }

    override fun onResume() {
        super.onResume()
        TelemetryHelper.trackPageView(this, "chat")
        RecordingIndicatorHelper.attach(this)
        // Persist current tab so process-death restart can restore here (card_489a8836).
        navResume.onNavigatedTo(NavItem.CHAT)
    }

    override fun onPause() {
        super.onPause()
        RecordingIndicatorHelper.detach()
    }

    override fun onDestroy() {
        super.onDestroy()
        jsBridge?.release()
        webViewManager.destroy()
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (webViewManager.canGoBack()) {
            webViewManager.goBack()
        } else {
            @Suppress("DEPRECATION")
            super.onBackPressed()
        }
    }

    private fun initViews() {
        webView = findViewById(R.id.webViewChat)
        loadingIndicator = findViewById(R.id.loadingIndicator)
        offlineView = findViewById(R.id.offlineView)

        // Retry button
        findViewById<MaterialButton>(R.id.btnRetry)?.setOnClickListener {
            webViewManager.loadChatPage(CHAT_URL)
        }
    }

    private fun setupEdgeToEdge() {
        val statusBarSpacer = findViewById<View>(R.id.statusBarSpacer)
        ViewCompat.setOnApplyWindowInsetsListener(statusBarSpacer) { v, insets ->
            val systemBars = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
            )
            v.updateLayoutParams { height = systemBars.top }
            insets
        }
    }

    private fun setupWebView() {
        webViewManager = ChatWebViewManager(
            webView = webView,
            loadingIndicator = loadingIndicator,
            offlineView = offlineView,
            onFileChooserRequest = { callback ->
                pendingFileCallback = callback
                fileChooserLauncher.launch("*/*")
            },
            onPageFinishedListener = { view, _ ->
                view?.evaluateJavascript(EClawNativeNavBridge.JS_SHIM, null)
                pageReady = true
                deliverPendingNavIntent()
            }
        )
        webViewManager.setup()

        // Inject JS Bridge
        jsBridge = ChatJsBridge(this, deviceManager, chatPrefs)
        val bridge = jsBridge!!
        webView.addJavascriptInterface(bridge, ChatJsBridge.BRIDGE_NAME)
        webView.addJavascriptInterface(
            EClawNativeNavBridge(this),
            EClawNativeNavBridge.BRIDGE_NAME
        )

        // Request microphone permission proactively for voice recording
        val micPerm = ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
        Timber.d("[MIC_DEBUG] setupWebView: RECORD_AUDIO permission=${if (micPerm == PackageManager.PERMISSION_GRANTED) "GRANTED" else "DENIED"}")
        if (micPerm != PackageManager.PERMISSION_GRANTED) {
            Timber.d("[MIC_DEBUG] Launching runtime permission request for RECORD_AUDIO")
            recordAudioPermissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
        }
    }
}
