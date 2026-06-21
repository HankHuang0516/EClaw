package com.hank.clawlive

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import com.hank.clawlive.R
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import com.hank.clawlive.billing.BillingManager
import com.hank.clawlive.data.local.DeviceManager
import com.hank.clawlive.data.remote.TelemetryHelper
import com.hank.clawlive.ui.BottomNavHelper
import com.hank.clawlive.ui.NavItem
import com.hank.clawlive.ui.RecordingIndicatorHelper
import com.hank.clawlive.ui.reconnect.ReconnectBackoff
import com.hank.clawlive.ui.reconnect.ReconnectOverlayController
import timber.log.Timber

/**
 * Generic WebView host activity for portal pages (Wallet, Rentals, Invite, etc.).
 *
 * Launch via [WebViewActivity.launch] with a URL and title.
 * Credentials are injected via query params and localStorage.
 *
 * Exposes `window.AndroidBridge.launchTopupPurchase(productId)` so wallet.html
 * can hand a tier tap back to the native Play Billing flow.
 */
class WebViewActivity : AppCompatActivity() {

    companion object {
        const val EXTRA_URL = "extra_url"
        const val EXTRA_TITLE = "extra_title"
        const val EXTRA_NAV_ITEM = "extra_nav_item"
        private const val BRIDGE_NAME = "AndroidBridge"

        fun launch(context: Context, url: String, title: String, navItem: NavItem = NavItem.SETTINGS) {
            context.startActivity(Intent(context, WebViewActivity::class.java).apply {
                putExtra(EXTRA_URL, url)
                putExtra(EXTRA_TITLE, title)
                putExtra(EXTRA_NAV_ITEM, navItem.name)
            })
        }
    }

    private val deviceManager: DeviceManager by lazy { DeviceManager.getInstance(this) }
    private lateinit var billingManager: BillingManager
    private var webView: WebView? = null
    private var reconnectOverlay: ReconnectOverlayController? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        setContentView(R.layout.activity_webview)

        val navItem = intent.getStringExtra(EXTRA_NAV_ITEM)?.let {
            runCatching { NavItem.valueOf(it) }.getOrNull()
        } ?: NavItem.SETTINGS
        BottomNavHelper.setup(this, navItem)
        setupWindowInsets()

        val title = intent.getStringExtra(EXTRA_TITLE) ?: ""
        findViewById<TextView>(R.id.tvWebviewTitle).text = title
        findViewById<ImageView>(R.id.btnWebviewBack).setOnClickListener { onBackPressedCompat() }

        billingManager = BillingManager.getInstance(this)
        billingManager.onTopupComplete = { productId, success ->
            // Hand result back to wallet.html if it wired up a listener.
            val js = "window.onTopupComplete && window.onTopupComplete(" +
                "\"${productId.replace("\"", "\\\"")}\", $success);"
            webView?.evaluateJavascript(js, null)
        }

        setupWebView()
    }

    override fun onResume() {
        super.onResume()
        val title = intent.getStringExtra(EXTRA_TITLE) ?: getString(R.string.unknown_error)
        TelemetryHelper.trackPageView(this, title.lowercase().replace(" ", "_"))
        RecordingIndicatorHelper.attach(this)
        billingManager.refreshState()
    }

    override fun onPause() {
        super.onPause()
        RecordingIndicatorHelper.detach()
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupWebView() {
        val container = findViewById<FrameLayout>(R.id.webviewContainer)
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

            addJavascriptInterface(WebViewBridge(), BRIDGE_NAME)

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
                        Timber.e(e, "[WebView] Failed to open external URL: $url")
                    }
                    return true
                }

                override fun onPageFinished(view: WebView?, url: String?) {
                    super.onPageFinished(view, url)
                    Timber.d("[WebView] Page loaded: $url")
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
                    Timber.w("[WebView] main-frame transport error code=$code url=$failingUrl — showing reconnect overlay")
                    reconnectOverlay?.onTransportError(failingUrl)
                }
            }
            webChromeClient = WebChromeClient()
        }

        container.addView(wv)
        webView = wv
        reconnectOverlay = ReconnectOverlayController(this, container, wv, tag = "WebView")

        val baseUrl = intent.getStringExtra(EXTRA_URL) ?: return
        val deviceId = deviceManager.deviceId
        val deviceSecret = deviceManager.deviceSecret
        val sep = if (baseUrl.contains("?")) "&" else "?"
        val withCreds = if (deviceId != null && deviceSecret != null)
            "$baseUrl${sep}deviceId=$deviceId&deviceSecret=$deviceSecret&embed=1"
        else "$baseUrl${sep}embed=1"
        wv.loadUrl(com.hank.clawlive.util.PortalUrlHelper.withAppLang(this, withCreds))
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
        val topBar = findViewById<android.widget.LinearLayout>(R.id.webviewTopBar)
        ViewCompat.setOnApplyWindowInsetsListener(topBar) { v, insets ->
            val systemBars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            v.setPadding(v.paddingLeft, systemBars.top, v.paddingRight, v.paddingBottom)
            insets
        }
    }

    private fun onBackPressedCompat() {
        if (webView?.canGoBack() == true) {
            webView?.goBack()
            return
        }
        finish()
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        onBackPressedCompat()
    }

    override fun onDestroy() {
        if (::billingManager.isInitialized) {
            billingManager.onTopupComplete = null
        }
        reconnectOverlay?.destroy()
        reconnectOverlay = null
        webView?.destroy()
        webView = null
        super.onDestroy()
    }

    /**
     * JavaScript bridge exposed as `window.AndroidBridge`. Scope is intentionally
     * narrow — only methods the portal pages hosted here need for native escape.
     */
    private inner class WebViewBridge {
        @JavascriptInterface
        fun launchTopupPurchase(productId: String) {
            Timber.d("[WebView] launchTopupPurchase productId=$productId")
            runOnUiThread {
                billingManager.launchTopupPurchaseFlow(this@WebViewActivity, productId)
            }
        }
    }
}
