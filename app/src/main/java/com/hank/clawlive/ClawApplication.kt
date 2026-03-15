package com.hank.clawlive

import android.app.Application
import android.content.Context
import com.hank.clawlive.data.local.DeviceManager
import com.hank.clawlive.data.remote.TelemetryHelper
import com.hank.clawlive.debug.CrashLogManager
import com.hank.clawlive.debug.FileTimberTree
import timber.log.Timber
import java.io.OutputStreamWriter
import java.io.PrintWriter
import java.io.StringWriter
import java.net.HttpURLConnection
import java.net.URL

class ClawApplication : Application() {

    override fun onCreate() {
        super.onCreate()

        android.util.Log.d("DEBUG_BLACKSCREEN", "=== ClawApplication.onCreate() START ===")

        // 1. Plant Timber trees FIRST
        if (BuildConfig.DEBUG) {
            Timber.plant(Timber.DebugTree())
        }
        val fileTree = FileTimberTree(this)
        Timber.plant(fileTree)
        android.util.Log.d("DEBUG_BLACKSCREEN", "[App] Timber trees planted")

        // 2. Initialize crash log manager
        CrashLogManager.init(this)
        android.util.Log.d("DEBUG_BLACKSCREEN", "[App] CrashLogManager initialized")

        // 3. Install UncaughtExceptionHandler
        val defaultHandler = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, throwable ->
            android.util.Log.e("DEBUG_BLACKSCREEN", "[App] UNCAUGHT EXCEPTION on thread=${thread.name}: ${throwable.message}", throwable)
            try {
                val recentLines = fileTree.getRecentLines(200)
                CrashLogManager.writeCrashLog(thread, throwable, recentLines)
                trySyncFlushCrashToServer(throwable, recentLines)
            } catch (_: Exception) {
                // Must not throw — always let default handler run
            } finally {
                defaultHandler?.uncaughtException(thread, throwable)
            }
        }
        android.util.Log.d("DEBUG_BLACKSCREEN", "[App] UncaughtExceptionHandler installed")

        // 4. Initialize TelemetryHelper early (centralized here)
        TelemetryHelper.init(this)
        android.util.Log.d("DEBUG_BLACKSCREEN", "[App] TelemetryHelper initialized")

        // 5. Upload any pending crash logs from previous session
        uploadPendingCrashLogs()
        android.util.Log.d("DEBUG_BLACKSCREEN", "[App] Pending crash logs uploaded")

        Timber.i("ClawApplication initialized")
        android.util.Log.d("DEBUG_BLACKSCREEN", "=== ClawApplication.onCreate() END ===")
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
}
