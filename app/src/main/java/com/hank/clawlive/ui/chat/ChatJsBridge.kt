package com.hank.clawlive.ui.chat

import android.webkit.JavascriptInterface
import android.widget.Toast
import com.hank.clawlive.data.local.ChatPreferences
import com.hank.clawlive.data.local.DeviceManager
import com.hank.clawlive.widget.ChatWidgetProvider
import timber.log.Timber

/**
 * JavaScript bridge exposed to the WebView as `window.AndroidBridge`.
 * Provides native capabilities to the Web Portal chat page.
 */
class ChatJsBridge(
    private val activity: android.app.Activity,
    private val deviceManager: DeviceManager,
    private val chatPrefs: ChatPreferences
) {

    @JavascriptInterface
    fun getDeviceId(): String = deviceManager.deviceId

    @JavascriptInterface
    fun getDeviceSecret(): String = deviceManager.deviceSecret

    @JavascriptInterface
    fun getAppVersion(): String = deviceManager.appVersion

    @JavascriptInterface
    fun updateWidget(lastMessage: String) {
        chatPrefs.lastMessage = lastMessage
        chatPrefs.lastMessageTimestamp = System.currentTimeMillis()
        ChatWidgetProvider.updateWidgets(activity)
    }

    @JavascriptInterface
    fun showToast(message: String) {
        activity.runOnUiThread {
            Toast.makeText(activity, message, Toast.LENGTH_SHORT).show()
        }
    }

    @JavascriptInterface
    fun log(level: String, message: String) {
        when (level) {
            "error" -> Timber.e("[ChatWebView] %s", message)
            "warn" -> Timber.w("[ChatWebView] %s", message)
            else -> Timber.d("[ChatWebView] %s", message)
        }
    }

    companion object {
        const val BRIDGE_NAME = "AndroidBridge"
    }
}
