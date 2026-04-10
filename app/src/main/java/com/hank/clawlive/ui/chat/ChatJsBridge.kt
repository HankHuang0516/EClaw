package com.hank.clawlive.ui.chat

import android.Manifest
import android.content.pm.PackageManager
import android.webkit.JavascriptInterface
import android.widget.Toast
import androidx.core.content.ContextCompat
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
    private val nativeRecorder = NativeAudioRecorder(activity)

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

    /** Start native audio recording. Returns "ok" or "error:reason". */
    @JavascriptInterface
    fun startRecording(): String {
        val hasPerm = ContextCompat.checkSelfPermission(
            activity, Manifest.permission.RECORD_AUDIO
        ) == PackageManager.PERMISSION_GRANTED
        if (!hasPerm) return "error:permission_denied"
        return nativeRecorder.start()
    }

    /** Stop native recording. Returns JSON {duration, mimeType, data} or empty string. */
    @JavascriptInterface
    fun stopRecording(send: Boolean): String {
        return nativeRecorder.stop(send) ?: ""
    }

    /** Check if native recorder is active. */
    @JavascriptInterface
    fun isRecording(): Boolean = nativeRecorder.isRecording

    /** Get current recording duration in seconds. */
    @JavascriptInterface
    fun getRecordingDuration(): Int = nativeRecorder.getDurationSec()

    fun release() {
        nativeRecorder.release()
    }

    companion object {
        const val BRIDGE_NAME = "AndroidBridge"
    }
}
