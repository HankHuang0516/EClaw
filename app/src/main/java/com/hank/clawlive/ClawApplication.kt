package com.hank.clawlive

import android.app.Application
import android.content.Context
import android.os.Build
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

    override fun onCreate() {
        super.onCreate()

        // 1. Plant Timber trees FIRST
        if (BuildConfig.DEBUG) {
            Timber.plant(Timber.DebugTree())
        }
        val fileTree = FileTimberTree(this)
        Timber.plant(fileTree)

        // card_f9b2cc2d: TtsService now runs in an isolated ":tts" process (see
        // AndroidManifest) so an FGS-deadline kill can never take the main process
        // (and the live wallpaper) down. The Application object is instantiated in
        // EVERY process, but the heavy main-process bootstrap below — Telemetry,
        // FCM token self-heal, Play Integrity, pending-crash upload, FCM channels —
        // must run ONLY in the main process. Re-running it in :tts would double-
        // register the FCM token and waste startup. Bail out after Timber so the
        // :tts process keeps just enough for TtsService's own logging.
        if (isTtsProcess()) {
            Timber.i("ClawApplication: running in :tts process — minimal init only")
            return
        }

        // 2. Initialize crash log manager
        CrashLogManager.init(this)

        // 3. Install UncaughtExceptionHandler
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
            // app crash. The call sites are now guarded, but as belt-and-braces: if
            // one still reaches here, letting the default handler run would kill this
            // shared process and take the live wallpaper down with it (pure black,
            // needs app restart). Swallow ONLY this narrow class so the process — and
            // the wallpaper engine — survive; it was already logged + recorded above.
            if (isRecoverableForegroundServiceCrash(throwable)) {
                try {
                    com.google.firebase.crashlytics.FirebaseCrashlytics.getInstance().recordException(throwable)
                } catch (_: Throwable) {}
                Timber.e(throwable, "[App] swallowed recoverable FGS crash (${throwable.javaClass.simpleName}) — keeping process + wallpaper alive")
                return@setDefaultUncaughtExceptionHandler
            }
            defaultHandler?.uncaughtException(thread, throwable)
        }

        // 4. Initialize TelemetryHelper early (centralized here)
        TelemetryHelper.init(this)

        // 5. Upload any pending crash logs from previous session
        uploadPendingCrashLogs()

        // 5b. Create notification channels at process startup (card_caa6307).
        // CRITICAL for "task completed" pushes: the backend sends a HYBRID FCM
        // message (android.notification block + data block) with
        // channelId="eclaw_chat". When the app is backgrounded or killed, the
        // Android system tray auto-displays the android.notification block
        // WITHOUT calling ClawFcmService.onMessageReceived(). On Android O+,
        // posting to a channel that does NOT exist at delivery time is silently
        // dropped — no error, no display. An FCM push can cold-start the app
        // process (which is why the token re-registers below), running
        // Application.onCreate but NOT MainActivity.onCreate, where channels
        // used to be created exclusively. That left "eclaw_chat" missing on the
        // exact code path the system uses to display the notification → silent.
        // createNotificationChannel is idempotent, so MainActivity's call (kept
        // for safety) is a harmless no-op once this has run.
        ClawFcmService.createChannels(this)

        // 6. Self-heal FCM token registration on every launch.
        // onNewToken() only fires when the token changes (install / clear-data / reinstall).
        // If the very first registration failed (e.g. before deviceSecret was provisioned),
        // the device would stay unregistered forever. Pulling the current token at startup
        // and POSTing it unconditionally fixes that class of silent failures.
        refreshAndRegisterFcmToken()

        // 7. Report a Play Integrity startup signal in release builds so Play
        // Console can monitor genuine installs without adding user-visible work.
        reportPlayIntegrityStartup()

        Timber.i("ClawApplication initialized")
    }

    /** True when this Application instance is hosting the isolated ":tts" process. */
    private fun isTtsProcess(): Boolean {
        val name = currentProcessName() ?: return false
        return name.endsWith(":tts")
    }

    /**
     * Current process name. Uses the framework API on P+ and falls back to
     * /proc/self/cmdline on API 24–27 (minSdk is 24). Returns null if it cannot
     * be determined — callers treat null as "assume main process".
     */
    private fun currentProcessName(): String? {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            return try { getProcessName() } catch (_: Throwable) { null }
        }
        return try {
            java.io.File("/proc/self/cmdline").readText()
                .substringBefore('\u0000')
                .trim()
                .ifEmpty { null }
        } catch (_: Throwable) {
            null
        }
    }

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
