package com.hank.clawlive.ui.chat

import android.content.Context
import android.media.MediaRecorder
import android.os.Build
import timber.log.Timber
import java.io.File
import java.util.Base64

/**
 * Native audio recorder for Android WebView fallback.
 * Used when WebView's getUserMedia fails with NotReadableError.
 */
class NativeAudioRecorder(private val context: Context) {

    private var recorder: MediaRecorder? = null
    private var outputFile: File? = null
    private var startTimeMs: Long = 0L

    val isRecording: Boolean get() = recorder != null

    fun start(): String {
        if (recorder != null) return "error:already_recording"
        return try {
            val file = File(context.cacheDir, "voice_${System.currentTimeMillis()}.m4a")
            outputFile = file

            val mr = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                MediaRecorder(context)
            } else {
                @Suppress("DEPRECATION")
                MediaRecorder()
            }
            mr.setAudioSource(MediaRecorder.AudioSource.MIC)
            mr.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
            mr.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
            mr.setAudioSamplingRate(44100)
            mr.setAudioEncodingBitRate(128000)
            mr.setOutputFile(file.absolutePath)
            mr.prepare()
            mr.start()
            recorder = mr
            startTimeMs = System.currentTimeMillis()
            Timber.d("[MIC_DEBUG] Native recording started: ${file.name}")
            "ok"
        } catch (e: Exception) {
            Timber.e(e, "[MIC_DEBUG] Native recording start failed")
            cleanup()
            "error:${e.message}"
        }
    }

    /**
     * Stop recording and return base64-encoded audio data, or null if discarded.
     */
    fun stop(send: Boolean): String? {
        val mr = recorder ?: return null
        val durationSec = ((System.currentTimeMillis() - startTimeMs) / 1000).toInt()
        return try {
            mr.stop()
            mr.release()
            recorder = null

            if (!send || durationSec < 1) {
                Timber.d("[MIC_DEBUG] Native recording discarded (send=$send, dur=${durationSec}s)")
                cleanup()
                return null
            }

            val file = outputFile ?: return null
            val bytes = file.readBytes()
            val b64 = Base64.getEncoder().encodeToString(bytes)
            Timber.d("[MIC_DEBUG] Native recording stopped: ${durationSec}s, ${bytes.size} bytes")
            cleanup()
            // Return JSON with duration and base64 data
            """{"duration":$durationSec,"mimeType":"audio/mp4","data":"$b64"}"""
        } catch (e: Exception) {
            Timber.e(e, "[MIC_DEBUG] Native recording stop failed")
            cleanup()
            null
        }
    }

    fun getDurationSec(): Int {
        if (recorder == null) return 0
        return ((System.currentTimeMillis() - startTimeMs) / 1000).toInt()
    }

    private fun cleanup() {
        try {
            recorder?.release()
        } catch (_: Exception) {}
        recorder = null
        outputFile?.delete()
        outputFile = null
    }

    fun release() {
        cleanup()
    }
}
