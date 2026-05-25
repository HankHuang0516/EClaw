package com.hank.clawlive.ui.chat

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.net.Uri
import android.os.Build
import android.webkit.ConsoleMessage
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.webkit.CookieManager
import android.widget.ProgressBar
import android.view.View
import androidx.core.content.ContextCompat
import timber.log.Timber

/**
 * Configures and manages the WebView that hosts the Web Portal chat page.
 */
class ChatWebViewManager(
    private val webView: WebView,
    private val loadingIndicator: ProgressBar,
    private val offlineView: View,
    private val onFileChooserRequest: (ValueCallback<Array<Uri>>) -> Unit,
    private val onPageFinishedListener: ((WebView?, String?) -> Unit)? = null
) {

    private var fileUploadCallback: ValueCallback<Array<Uri>>? = null
    private var hasLoadedSuccessfully = false
    private var audioFocusRequest: AudioFocusRequest? = null

    @SuppressLint("SetJavaScriptEnabled")
    fun setup() {
        // Cookie management — allow third-party cookies for session persistence
        val cookieManager = CookieManager.getInstance()
        cookieManager.setAcceptCookie(true)
        cookieManager.setAcceptThirdPartyCookies(webView, true)

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            defaultTextEncodingName = "UTF-8"
            mediaPlaybackRequiresUserGesture = false
            mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            allowFileAccess = true
            allowContentAccess = true
            // Enable zooming for accessibility
            setSupportZoom(false)
            builtInZoomControls = false
            // Cache settings
            cacheMode = WebSettings.LOAD_DEFAULT
            databaseEnabled = true
            // User agent — append EClaw identifier for server-side detection
            userAgentString = "${userAgentString} EClawAndroid"
        }

        webView.webViewClient = ChatWebViewClient()
        webView.webChromeClient = ChatWebChromeClient()
    }

    fun loadChatPage(baseUrl: String) {
        offlineView.visibility = View.GONE
        loadingIndicator.visibility = View.VISIBLE
        webView.visibility = View.VISIBLE
        webView.loadUrl(
            com.hank.clawlive.util.PortalUrlHelper.withAppLang(
                webView.context, "$baseUrl/portal/chat.html"
            )
        )
    }

    fun canGoBack(): Boolean = webView.canGoBack()

    fun goBack() = webView.goBack()

    fun destroy() {
        webView.stopLoading()
        webView.destroy()
        // Release audio focus if we acquired it for recording
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            audioFocusRequest?.let {
                val audioManager = webView.context
                    .getSystemService(Context.AUDIO_SERVICE) as AudioManager
                audioManager.abandonAudioFocusRequest(it)
            }
        }
        audioFocusRequest = null
    }

    /**
     * Called from Activity when file chooser result comes back
     */
    fun onFileChooserResult(results: Array<Uri>?) {
        fileUploadCallback?.onReceiveValue(results)
        fileUploadCallback = null
    }

    fun cancelFileChooser() {
        fileUploadCallback?.onReceiveValue(null)
        fileUploadCallback = null
    }

    // ── WebViewClient: page loading, errors, URL filtering ──

    private inner class ChatWebViewClient : WebViewClient() {

        override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
            super.onPageStarted(view, url, favicon)
            loadingIndicator.visibility = View.VISIBLE
        }

        override fun onPageFinished(view: WebView?, url: String?) {
            super.onPageFinished(view, url)
            loadingIndicator.visibility = View.GONE
            hasLoadedSuccessfully = true
            offlineView.visibility = View.GONE
            onPageFinishedListener?.invoke(view, url)
        }

        override fun onReceivedError(
            view: WebView?,
            request: WebResourceRequest?,
            error: WebResourceError?
        ) {
            super.onReceivedError(view, request, error)
            // Only show offline for main frame failures
            if (request?.isForMainFrame == true) {
                Timber.w("WebView main frame error: ${error?.description} (code ${error?.errorCode})")
                loadingIndicator.visibility = View.GONE
                if (!hasLoadedSuccessfully) {
                    webView.visibility = View.GONE
                    offlineView.visibility = View.VISIBLE
                }
            }
        }

        override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
            val url = request?.url?.toString() ?: return false
            // Keep portal URLs in WebView, open external URLs in system browser
            return if (url.contains("eclawbot.com/portal") || url.contains("eclawbot.com/api")) {
                false // load in WebView
            } else if (url.startsWith("http://") || url.startsWith("https://")) {
                val intent = android.content.Intent(android.content.Intent.ACTION_VIEW, Uri.parse(url))
                view?.context?.startActivity(intent)
                true // handled externally
            } else {
                false
            }
        }
    }

    // ── WebChromeClient: file chooser, permissions, console ──

    private inner class ChatWebChromeClient : WebChromeClient() {

        override fun onShowFileChooser(
            webView: WebView?,
            filePathCallback: ValueCallback<Array<Uri>>?,
            fileChooserParams: FileChooserParams?
        ): Boolean {
            // Cancel any existing callback
            fileUploadCallback?.onReceiveValue(null)
            fileUploadCallback = filePathCallback
            onFileChooserRequest(filePathCallback ?: return false)
            return true
        }

        override fun onPermissionRequest(request: PermissionRequest?) {
            request?.let {
                val resources = it.resources
                val needsAudio = resources.contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE)
                val needsVideo = resources.contains(PermissionRequest.RESOURCE_VIDEO_CAPTURE)
                Timber.d("[MIC_DEBUG] onPermissionRequest: resources=${resources.toList()}, needsAudio=$needsAudio, needsVideo=$needsVideo")
                if (needsAudio || needsVideo) {
                    val hasAudioPermission = ContextCompat.checkSelfPermission(
                        webView.context, Manifest.permission.RECORD_AUDIO
                    ) == PackageManager.PERMISSION_GRANTED
                    Timber.d("[MIC_DEBUG] RECORD_AUDIO granted=$hasAudioPermission")
                    if (hasAudioPermission) {
                        // Acquire AudioFocus before granting WebView capture — required on Android
                        // to initialize AudioRecord; without it getUserMedia throws NotReadableError.
                        val audioManager = webView.context
                            .getSystemService(Context.AUDIO_SERVICE) as AudioManager
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                            val focusReq = AudioFocusRequest.Builder(
                                AudioManager.AUDIOFOCUS_GAIN_TRANSIENT
                            ).build()
                            audioFocusRequest = focusReq
                            val focusResult = audioManager.requestAudioFocus(focusReq)
                            Timber.d("[MIC_DEBUG] AudioFocus result=$focusResult (1=GRANTED, 0=FAILED)")
                        } else {
                            @Suppress("DEPRECATION")
                            val focusResult = audioManager.requestAudioFocus(
                                null,
                                AudioManager.STREAM_VOICE_CALL,
                                AudioManager.AUDIOFOCUS_GAIN_TRANSIENT
                            )
                            Timber.d("[MIC_DEBUG] AudioFocus (legacy) result=$focusResult")
                        }
                        Timber.d("[MIC_DEBUG] Granting WebView permission for resources=${resources.toList()}")
                        it.grant(resources)
                    } else {
                        Timber.w("[MIC_DEBUG] DENIED — WebView requested audio capture but RECORD_AUDIO not granted")
                        it.deny()
                    }
                } else {
                    Timber.d("[MIC_DEBUG] Non-audio permission request denied: ${resources.toList()}")
                    it.deny()
                }
            }
        }

        override fun onConsoleMessage(consoleMessage: ConsoleMessage?): Boolean {
            consoleMessage?.let {
                val msg = "[WebView] ${it.sourceId()}:${it.lineNumber()} ${it.message()}"
                when (it.messageLevel()) {
                    ConsoleMessage.MessageLevel.ERROR -> Timber.e(msg)
                    ConsoleMessage.MessageLevel.WARNING -> Timber.w(msg)
                    else -> Timber.d(msg)
                }
            }
            return true
        }
    }
}
