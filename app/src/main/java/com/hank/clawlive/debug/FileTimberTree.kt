package com.hank.clawlive.debug

import android.content.Context
import android.util.Log
import timber.log.Timber
import java.io.BufferedWriter
import java.io.File
import java.io.FileWriter
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class FileTimberTree(context: Context) : Timber.Tree() {

    private val logFile = File(context.filesDir, "debug_log.txt")
    private val maxFileSize = 512 * 1024L // 512 KB
    private val dateFormat = SimpleDateFormat("HH:mm:ss.SSS", Locale.US)
    private val lock = Any()

    companion object {
        @Volatile
        var instance: FileTimberTree? = null
            private set
    }

    init {
        instance = this
    }

    override fun log(priority: Int, tag: String?, message: String, t: Throwable?) {
        if (priority < Log.DEBUG) return
        val level = when (priority) {
            Log.DEBUG -> "D"
            Log.INFO -> "I"
            Log.WARN -> "W"
            Log.ERROR -> "E"
            Log.ASSERT -> "A"
            else -> "V"
        }
        val timestamp = dateFormat.format(Date())
        val line = "[$timestamp] [$level/${tag ?: "?"}] $message"

        synchronized(lock) {
            try {
                if (logFile.length() > maxFileSize) {
                    trimLogFile()
                }
                BufferedWriter(FileWriter(logFile, true)).use { writer ->
                    writer.write(line)
                    writer.newLine()
                }
            } catch (_: Exception) {
                // Swallow — file logging must not crash the app
            }
        }
    }

    /**
     * Read the most recent lines from the log file.
     * Called by CrashLogManager during crash — must be safe.
     */
    fun getRecentLines(maxLines: Int = 200): List<String> {
        synchronized(lock) {
            return try {
                if (!logFile.exists()) return emptyList()
                val lines = logFile.readLines()
                if (lines.size <= maxLines) lines else lines.takeLast(maxLines)
            } catch (_: Exception) {
                emptyList()
            }
        }
    }

    fun clear() {
        synchronized(lock) {
            try {
                logFile.writeText("")
            } catch (_: Exception) {}
        }
    }

    private fun trimLogFile() {
        try {
            val lines = logFile.readLines()
            // Keep the second half
            val keepFrom = lines.size / 2
            logFile.writeText(lines.drop(keepFrom).joinToString("\n") + "\n")
        } catch (_: Exception) {}
    }
}
