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
import com.hank.clawlive.ui.RecordingIndicatorHelper
import com.hank.clawlive.ui.chat.ChatJsBridge
import com.hank.clawlive.ui.chat.ChatWebViewManager
import timber.log.Timber

class ChatActivity : AppCompatActivity() {

    private val deviceManager: DeviceManager by lazy { DeviceManager.getInstance(this) }
    private val chatPrefs: ChatPreferences by lazy { ChatPreferences.getInstance(this) }

    private lateinit var webView: WebView
    private lateinit var loadingIndicator: ProgressBar
    private lateinit var offlineView: View
    private lateinit var webViewManager: ChatWebViewManager

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
        if (!granted) {
            Timber.w("Microphone permission denied")
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        setContentView(R.layout.activity_chat)

        initViews()
        setupEdgeToEdge()
        setupWebView()

        BottomNavHelper.setup(this, NavItem.CHAT)
        AiChatFabHelper.setup(this, "chat")

        webViewManager.loadChatPage(CHAT_URL)
    }

    override fun onResume() {
        super.onResume()
        TelemetryHelper.trackPageView(this, "chat")
        RecordingIndicatorHelper.attach(this)
    }

    override fun onPause() {
        super.onPause()
        RecordingIndicatorHelper.detach()
    }

    override fun onDestroy() {
        super.onDestroy()
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
            }
        )
        webViewManager.setup()

        // Inject JS Bridge
        val bridge = ChatJsBridge(this, deviceManager, chatPrefs)
        webView.addJavascriptInterface(bridge, ChatJsBridge.BRIDGE_NAME)

        // Request microphone permission proactively for voice recording
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
            != PackageManager.PERMISSION_GRANTED
        ) {
            recordAudioPermissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
        }
    }
}
