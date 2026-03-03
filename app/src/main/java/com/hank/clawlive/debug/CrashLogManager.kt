package com.hank.clawlive.debug

import android.content.Context
import android.os.Build
import java.io.File
import java.io.PrintWriter
import java.io.StringWriter
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

object CrashLogManager {

    private const val CRASH_DIR = "crash_logs"
    private const val MAX_CRASH_FILES = 20

    private var crashDir: File? = null
    private var appVersion: String = "unknown"
    private var appVersionCode: Long = 0
    private var deviceId: String = "unknown"

    fun init(context: Context) {
        crashDir = File(context.filesDir, CRASH_DIR).also { it.mkdirs() }
        try {
            val pInfo = context.packageManager.getPackageInfo(context.packageName, 0)
            appVersion = pInfo.versionName ?: "unknown"
            appVersionCode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                pInfo.longVersionCode
            } else {
                @Suppress("DEPRECATION")
                pInfo.versionCode.toLong()
            }
        } catch (_: Exception) {}

        try {
            val prefs = context.getSharedPreferences("claw_prefs", Context.MODE_PRIVATE)
            deviceId = prefs.getString("device_id", "unknown") ?: "unknown"
        } catch (_: Exception) {}
    }

    /**
     * Write crash log synchronously. Safe to call from UncaughtExceptionHandler.
     */
    fun writeCrashLog(thread: Thread, throwable: Throwable, recentLogLines: List<String>? = null) {
        val dir = crashDir ?: return
        try {
            val now = Date()
            val fileDateFmt = SimpleDateFormat("yyyyMMdd_HHmmss_SSS", Locale.US)
            val displayDateFmt = SimpleDateFormat("yyyy-MM-dd HH:mm:ss.SSS Z", Locale.US)
            val fileName = "crash_${fileDateFmt.format(now)}.txt"
            val file = File(dir, fileName)

            val sw = StringWriter()
            throwable.printStackTrace(PrintWriter(sw))
            val stackTrace = sw.toString()

            val report = buildString {
                appendLine("=== CRASH REPORT ===")
                appendLine("Time: ${displayDateFmt.format(now)}")
                appendLine("App Version: $appVersion ($appVersionCode)")
                appendLine("Android: ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})")
                appendLine("Device: ${Build.MANUFACTURER} ${Build.MODEL}")
                appendLine("Thread: ${thread.name} (id=${thread.id})")
                appendLine("DeviceId: $deviceId")
                appendLine()
                appendLine("--- Exception ---")
                append(stackTrace)
                appendLine()

                if (!recentLogLines.isNullOrEmpty()) {
                    appendLine("--- Recent Debug Log (last ${recentLogLines.size} lines) ---")
                    recentLogLines.forEach { appendLine(it) }
                    appendLine()
                }

                appendLine("--- Device State ---")
                val runtime = Runtime.getRuntime()
                val freeMB = runtime.freeMemory() / (1024 * 1024)
                val totalMB = runtime.totalMemory() / (1024 * 1024)
                val maxMB = runtime.maxMemory() / (1024 * 1024)
                appendLine("Memory: ${freeMB}MB free / ${totalMB}MB total / ${maxMB}MB max")
                appendLine("Supported ABIs: ${Build.SUPPORTED_ABIS.joinToString()}")
            }

            file.writeText(report)
            pruneOldLogs()
        } catch (_: Exception) {
            // Swallow — must not throw in crash handler
        }
    }

    fun getCrashLogs(): List<File> {
        val dir = crashDir ?: return emptyList()
        return dir.listFiles()
            ?.filter { it.name.startsWith("crash_") && it.name.endsWith(".txt") }
            ?.sortedByDescending { it.lastModified() }
            ?: emptyList()
    }

    fun readCrashLog(file: File): String {
        return try {
            file.readText()
        } catch (_: Exception) {
            "(Unable to read crash log)"
        }
    }

    fun deleteCrashLog(file: File): Boolean {
        return try {
            file.delete()
        } catch (_: Exception) {
            false
        }
    }

    fun deleteAllCrashLogs(): Int {
        val logs = getCrashLogs()
        var deleted = 0
        logs.forEach { if (it.delete()) deleted++ }
        return deleted
    }

    /**
     * Parse the exception class name from a crash log file name or content.
     */
    fun parseExceptionSummary(file: File): String {
        return try {
            val content = file.readText()
            val exLine = content.lineSequence()
                .firstOrNull { it.isNotBlank() && it != "--- Exception ---" &&
                    content.indexOf("--- Exception ---") < content.indexOf(it) &&
                    (it.contains("Exception") || it.contains("Error")) }
            exLine?.take(120) ?: file.name
        } catch (_: Exception) {
            file.name
        }
    }

    /**
     * Parse the timestamp from a crash log file name.
     */
    fun parseTimestamp(file: File): String {
        return try {
            // crash_20260303_142345_123.txt -> 2026-03-03 14:23:45
            val name = file.nameWithoutExtension.removePrefix("crash_")
            val parts = name.split("_")
            if (parts.size >= 2) {
                val date = parts[0] // 20260303
                val time = parts[1] // 142345
                "${date.substring(0, 4)}-${date.substring(4, 6)}-${date.substring(6, 8)} " +
                    "${time.substring(0, 2)}:${time.substring(2, 4)}:${time.substring(4, 6)}"
            } else {
                file.name
            }
        } catch (_: Exception) {
            file.name
        }
    }

    private fun pruneOldLogs() {
        val logs = getCrashLogs()
        if (logs.size > MAX_CRASH_FILES) {
            logs.drop(MAX_CRASH_FILES).forEach { it.delete() }
        }
    }
}
