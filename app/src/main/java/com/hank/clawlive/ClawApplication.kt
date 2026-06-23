package com.hank.clawlive

import android.app.Activity
import android.app.Application
import android.content.Context
import android.os.Build
import android.os.Bundle
import java.util.concurrent.atomic.AtomicInteger
import com.google.firebase.messaging.FirebaseMessaging
import com.hank.clawlive.data.local.DeviceManager
import com.hank.clawlive.data.remote.NetworkModule
import com.hank.clawlive.data.remote.TelemetryHelper
import com.hank.clawlive.debug.CrashLogManager
import com.hank.clawlive.fcm.ClawFcmService
import com.hank.clawlive.debug.FileTimberTree
import com.hank.clawlive.integrity.PlayIntegrityReporter
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import timber.log.Timber
import java.io.OutputStreamWriter
import java.io.PrintWriter
import java.io.StringWriter
import java.net.HttpURLConnection
import java.net.URL

class ClawApplication : Application() {

    companion object {
        /** Number of started (visible) Activities. >0 means the app has UI in the foreground. */
        private val startedActivityCount = AtomicInteger(0)

        /**
         * True when the app has at least one started Activity. A visible LIVE WALLPAPER
         * does NOT count as a foreground Activity, so this is precisely false in the
         * home-screen-wallpaper state where a background FGS start would risk killing
         * the wallpaper's process. ClawFcmService gates its TTS foreground-service start
         * on this. card_f9b2cc2d (BLK-FGS).
         */
        fun isAppInForeground(): Boolean = startedActivityCount.get() > 0
    }

    override fun onCreate() {
        super.onCreate()

        // BLK-FGS process-isolation (card_f9b2cc2d, v1.1.11): TtsService now runs in
        // its own ":tts" process (AndroidManifest android:process=":tts"). Application
        // .onCreate runs in EVERY process of the app — including ":tts" — so MAIN-ONLY
        // initialization must NOT double-run there. isMainProcess gates the heavy/
        // main-only init. Crash logging, Timber, the FGS-crash-swallowing uncaught
        // handler, CrashLogManager, and the notification channels run in BOTH processes
        // (the ":tts" process must be able to log/recover and own its TTS channel).
        val isMainProcess = currentProcessName()?.let { it == packageName } ?: true

        // 1. Plant Timber trees FIRST (both processes)
        if (BuildConfig.DEBUG) {
            Timber.plant(Timber.DebugTree())
        }
        val fileTree = FileTimberTree(this)
        Timber.plant(fileTree)

        // 2. Initialize crash log manager (both processes)
        CrashLogManager.init(this)

        // 3. Install UncaughtExceptionHandler (both processes)
        val defaultHandler = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, throwable ->
            try {
                val recentLines = fileTree.getRecentLines(200)
                CrashLogManager.writeCrashLog(thread, throwable, recentLines)
                trySyncFlushCrashToServer(throwable, recentLines)
            } catch (_: Exception) {
                // Must not throw — always let default handler run
            }
            // BLK-FGS recovery (card_f9b2cc2d): a foreground-service-policy throwable
            // (ForegroundServiceStartNotAllowed / DidNotStartInTime / RemoteServiceException
            // with an FGS message) is a recoverable OS policy rejection, NOT a real
            // app crash. With process isolation a DidNotStartInTime now kills only the
            // ":tts" process (the wallpaper engine lives in the main process and is
            // untouched), but we keep this narrow swallow as defense-in-depth so even
            // that isolated process survives where possible; it was already logged +
            // recorded above.
            if (isRecoverableForegroundServiceCrash(throwable)) {
                try {
                    com.google.firebase.crashlytics.FirebaseCrashlytics.getInstance().recordException(throwable)
                } catch (_: Throwable) {}
                Timber.e(throwable, "[App] swallowed recoverable FGS crash (${throwable.javaClass.simpleName}) — keeping process + wallpaper alive")
                return@setDefaultUncaughtExceptionHandler
            }
            defaultHandler?.uncaughtException(thread, throwable)
        }

        // 3b. Create notification channels at process startup (card_caa6307) — BOTH
        // processes. The ":tts" process needs the TTS channel to post its foreground
        // notification, and the main process needs "eclaw_chat" for hybrid FCM pushes.
        // CRITICAL for "task completed" pushes: the backend sends a HYBRID FCM
        // message (android.notification block + data block) with
        // channelId="eclaw_chat". When the app is backgrounded or killed, the
        // Android system tray auto-displays the android.notification block
        // WITHOUT calling ClawFcmService.onMessageReceived(). On Android O+,
        // posting to a channel that does NOT exist at delivery time is silently
        // dropped — no error, no display. An FCM push can cold-start the app
        // process (which is why the token re-registers below), running
        // Application.onCreate but NOT MainActivity.onCreate, where channels
        // used to be created exclusively. createNotificationChannel is idempotent,
        // so MainActivity's call (kept for safety) is a harmless no-op once this
        // has run.
        ClawFcmService.createChannels(this)

        if (isMainProcess) {
            // 0. Track foreground-activity state (MAIN PROCESS ONLY — Activities only
            // exist here). BLK-FGS (card_f9b2cc2d): an FCM-triggered TTS foreground
            // service started while the app has NO foreground Activity (the exact state
            // when the live wallpaper is showing on the home screen) was the residual
            // black-screen trigger. ClawFcmService runs in the main process, so it reads
            // this counter correctly; isAppInForeground() therefore stays accurate.
            registerActivityLifecycleCallbacks(object : ActivityLifecycleCallbacks {
                override fun onActivityStarted(activity: Activity) { startedActivityCount.incrementAndGet() }
                override fun onActivityStopped(activity: Activity) {
                    if (startedActivityCount.get() > 0) startedActivityCount.decrementAndGet()
                }
                override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {}
                override fun onActivityResumed(activity: Activity) {}
                override fun onActivityPaused(activity: Activity) {}
                override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) {}
                override fun onActivityDestroyed(activity: Activity) {}
            })

            // 4. Initialize TelemetryHelper early (centralized here)
            TelemetryHelper.init(this)

            // 5. Upload any pending crash logs from previous session
            uploadPendingCrashLogs()

            // 6. Self-heal FCM token registration on every launch.
            // onNewToken() only fires when the token changes (install / clear-data / reinstall).
            // If the very first registration failed (e.g. before deviceSecret was provisioned),
            // the device would stay unregistered forever. Pulling the current token at startup
            // and POSTing it unconditionally fixes that class of silent failures.
            refreshAndRegisterFcmToken()

            // 7. Report a Play Integrity startup signal in release builds so Play
            // Console can monitor genuine installs without adding user-visible work.
            reportPlayIntegrityStartup()
        }

        Timber.i("ClawApplication initialized (mainProcess=$isMainProcess)")
    }

    /**
     * Resolve the current process name. On Android P+ the framework exposes
     * Application.getProcessName() directly; below P we scan running app processes
     * for our own pid. The main process name equals the package name; the isolated
     * TTS service runs in "<package>:tts". Returns null if it cannot be determined
     * (caller then assumes main process — the safe default).
     */
    private fun currentProcessName(): String? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) getProcessName()
        else try {
            val am = getSystemService(Context.ACTIVITY_SERVICE) as android.app.ActivityManager
            am.runningAppProcesses?.firstOrNull { it.pid == android.os.Process.myPid() }?.processName
        } catch (_: Throwable) { null }

    private fun reportPlayIntegrityStartup() {
        if (BuildConfig.DEBUG) {
            Timber.d("[PlayIntegrity] Skipping startup report in debug build")
            return
        }
        CoroutineScope(Dispatchers.IO).launch {
            PlayIntegrityReporter.getInstance(this@ClawApplication).reportStartup()
        }
    }

    private fun refreshAndRegisterFcmToken() {
        val dm = DeviceManager.getInstance(this)
        if (dm.deviceId.isBlank() || dm.deviceSecret.isBlank()) {
            Timber.d("[FCM] Skipping startup token registration — device not provisioned yet")
            return
        }
        FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
            if (!task.isSuccessful) {
                Timber.w(task.exception, "[FCM] Failed to fetch token at startup")
                return@addOnCompleteListener
            }
            val token = task.result ?: return@addOnCompleteListener
            CoroutineScope(Dispatchers.IO).launch {
                try {
                    NetworkModule.api.registerFcmToken(
                        mapOf(
                            "deviceId" to dm.deviceId,
                            "deviceSecret" to dm.deviceSecret,
                            "fcmToken" to token
                        )
                    )
                    Timber.d("[FCM] Startup token registered: ${token.take(20)}...")
                } catch (e: Exception) {
                    Timber.e(e, "[FCM] Startup token register failed")
                }
            }
        }
    }

    /**
     * Best-effort synchronous crash upload to device telemetry.
     * Runs on the crashing thread — process is dying, so use short timeout.
     * This allows AI support to see crash data immediately.
     */
    private fun trySyncFlushCrashToServer(throwable: Throwable, recentLines: List<String>) {
        try {
            val dm = DeviceManager.getInstance(this)
            val sw = StringWriter()
            throwable.printStackTrace(PrintWriter(sw))
            val stackTrace = sw.toString().take(2000)

            val recentLog = recentLines.takeLast(50).joinToString("\\n") { escapeJson(it) }

            val json = buildString {
                append("{\"deviceId\":\"${escapeJson(dm.deviceId)}\",")
                append("\"deviceSecret\":\"${escapeJson(dm.deviceSecret)}\",")
                append("\"entries\":[{")
                append("\"ts\":${System.currentTimeMillis()},")
                append("\"type\":\"crash\",")
                append("\"action\":\"${escapeJson(throwable.javaClass.simpleName)}\",")
                append("\"meta\":{")
                append("\"message\":\"${escapeJson(throwable.message?.take(300) ?: "unknown")}\",")
                append("\"stack_trace\":\"${escapeJson(stackTrace)}\",")
                append("\"recent_log\":\"$recentLog\",")
                append("\"thread\":\"${escapeJson(Thread.currentThread().name)}\"")
                append("}}]}")
            }

            val url = URL("https://eclawbot.com/api/device-telemetry")
            val conn = url.openConnection() as HttpURLConnection
            try {
                conn.requestMethod = "POST"
                conn.setRequestProperty("Content-Type", "application/json")
                conn.doOutput = true
                conn.connectTimeout = 2000
                conn.readTimeout = 2000
                OutputStreamWriter(conn.outputStream).use { it.write(json) }
                conn.responseCode // trigger the request
            } finally {
                conn.disconnect()
            }
        } catch (_: Exception) {
            // Best effort — if it fails, local crash file still exists
        }
    }

    /**
     * On next launch, upload any crash logs that weren't sent synchronously.
     */
    private fun uploadPendingCrashLogs() {
        val prefs = getSharedPreferences("crash_prefs", Context.MODE_PRIVATE)
        val lastLaunch = prefs.getLong("last_app_launch", 0)
        val now = System.currentTimeMillis()
        prefs.edit().putLong("last_app_launch", now).apply()

        if (lastLaunch == 0L) return // First launch, no crashes to upload

        val recentCrashes = CrashLogManager.getCrashLogs()
            .filter { it.lastModified() > lastLaunch }

        if (recentCrashes.isEmpty()) return

        Timber.w("Detected %d crash(es) since last launch — uploading to telemetry", recentCrashes.size)

        for (file in recentCrashes) {
            val content = CrashLogManager.readCrashLog(file).take(3000)
            TelemetryHelper.enqueue(
                type = "crash",
                action = "crash_report_upload",
                meta = mapOf(
                    "file" to file.name,
                    "content" to content,
                    "source" to "previous_session"
                )
            )
        }
        // Force flush so crash data reaches server quickly
        TelemetryHelper.flush()
    }

    private fun escapeJson(s: String): String =
        s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n").replace("\r", "\\r")

    /**
     * BLK-FGS (card_f9b2cc2d): true only for the narrow class of foreground-service
     * policy rejections that are recoverable — swallowing these keeps the shared
     * process (and the live wallpaper engine) alive instead of dying to a pure-black
     * screen. Walks the cause chain; matches by class name so it works across API
     * levels (ForegroundServiceStartNotAllowedException, RemoteServiceException$
     * ForegroundServiceDidNotStartInTimeException, etc.) without compile-time deps.
     */
    private fun isRecoverableForegroundServiceCrash(t: Throwable?): Boolean {
        var cur = t
        var depth = 0
        while (cur != null && depth < 8) {
            val name = cur.javaClass.name
            val msg = cur.message ?: ""
            if (name.contains("ForegroundServiceStartNotAllowedException") ||
                name.contains("ForegroundServiceDidNotStartInTimeException") ||
                (name.contains("RemoteServiceException") && msg.contains("ForegroundService"))
            ) {
                return true
            }
            cur = cur.cause
            depth++
        }
        return false
    }
}
