package com.hank.clawlive.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import androidx.core.app.NotificationCompat
import com.hank.clawlive.R
import com.hank.clawlive.data.remote.SocketManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import timber.log.Timber
import java.util.Locale
import java.util.concurrent.atomic.AtomicInteger

/**
 * Foreground service that listens to Socket.IO TTS events and speaks text aloud
 * using Android's built-in TextToSpeech engine. Works even when the app is in background.
 *
 * Receives JSON via SocketManager.ttsFlow:
 *   { "text": "...", "lang": "zh-TW", "speed": 1.0, "pitch": 1.0, "entityId": 0, "entityName": "Bot" }
 */
class TtsService : Service(), TextToSpeech.OnInitListener {

    companion object {
        private const val CHANNEL_ID = "eclaw_tts"
        private const val NOTIFICATION_ID = 9001
    }

    private var tts: TextToSpeech? = null
    private var ttsReady = false
    private val serviceScope = CoroutineScope(Dispatchers.Main + SupervisorJob())
    private val utteranceCounter = AtomicInteger(0)

    override fun onCreate() {
        super.onCreate()
        Timber.d("[TTS] Service created")
        createNotificationChannel()
        startForeground(NOTIFICATION_ID, buildNotification("TTS 語音服務就緒"))
        tts = TextToSpeech(this, this)
        observeTtsFlow()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Handle FCM fallback: when the app receives an FCM with category=tts,
        // it can start this service with extras
        intent?.getStringExtra("tts_text")?.let { text ->
            val lang = intent.getStringExtra("tts_lang") ?: "zh-TW"
            val speed = intent.getFloatExtra("tts_speed", 1.0f)
            val pitch = intent.getFloatExtra("tts_pitch", 1.0f)
            val entityName = intent.getStringExtra("tts_entity_name") ?: "Bot"
            speak(text, lang, speed, pitch, entityName)
        }
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onInit(status: Int) {
        if (status == TextToSpeech.SUCCESS) {
            ttsReady = true
            // Default to Traditional Chinese
            val result = tts?.setLanguage(Locale.TRADITIONAL_CHINESE)
            if (result == TextToSpeech.LANG_MISSING_DATA || result == TextToSpeech.LANG_NOT_SUPPORTED) {
                Timber.w("[TTS] zh-TW not available, falling back to default")
            }
            tts?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                override fun onStart(utteranceId: String?) {
                    Timber.d("[TTS] Speaking: $utteranceId")
                }
                override fun onDone(utteranceId: String?) {
                    Timber.d("[TTS] Done: $utteranceId")
                }
                @Deprecated("Deprecated in Java")
                override fun onError(utteranceId: String?) {
                    Timber.e("[TTS] Error: $utteranceId")
                }
            })
            Timber.d("[TTS] Engine initialized successfully")
        } else {
            Timber.e("[TTS] Engine initialization failed with status: $status")
        }
    }

    private fun observeTtsFlow() {
        serviceScope.launch {
            SocketManager.ttsFlow.collect { json ->
                val text = json.optString("text", "")
                val lang = json.optString("lang", "zh-TW")
                val speed = json.optDouble("speed", 1.0).toFloat()
                val pitch = json.optDouble("pitch", 1.0).toFloat()
                val entityName = json.optString("entityName", "Bot")
                if (text.isNotEmpty()) {
                    speak(text, lang, speed, pitch, entityName)
                }
            }
        }
    }

    private fun speak(text: String, lang: String, speed: Float, pitch: Float, entityName: String) {
        val engine = tts
        if (engine == null || !ttsReady) {
            Timber.w("[TTS] Engine not ready, dropping: $text")
            return
        }

        // Set language
        val locale = parseLocale(lang)
        val langResult = engine.setLanguage(locale)
        if (langResult == TextToSpeech.LANG_MISSING_DATA || langResult == TextToSpeech.LANG_NOT_SUPPORTED) {
            Timber.w("[TTS] Language $lang not supported, using default")
        }

        // Set speed and pitch
        engine.setSpeechRate(speed.coerceIn(0.5f, 2.0f))
        engine.setPitch(pitch.coerceIn(0.5f, 2.0f))

        // Update notification to show who's speaking
        val nm = getSystemService(NotificationManager::class.java)
        nm?.notify(NOTIFICATION_ID, buildNotification("🔊 $entityName 正在說話..."))

        val utteranceId = "eclaw_tts_${utteranceCounter.incrementAndGet()}"
        engine.speak(text, TextToSpeech.QUEUE_ADD, null, utteranceId)

        Timber.d("[TTS] Queued: \"${text.take(80)}\" lang=$lang speed=$speed pitch=$pitch entity=$entityName")
    }

    /**
     * Parse BCP-47 language tag into a Locale.
     * Supports: zh-TW, zh-CN, en-US, ja-JP, ko-KR, etc.
     */
    private fun parseLocale(lang: String): Locale {
        return when (lang.lowercase()) {
            "zh-tw" -> Locale.TRADITIONAL_CHINESE
            "zh-cn" -> Locale.SIMPLIFIED_CHINESE
            "en-us" -> Locale.US
            "en-gb" -> Locale.UK
            "ja-jp", "ja" -> Locale.JAPANESE
            "ko-kr", "ko" -> Locale.KOREAN
            "en" -> Locale.ENGLISH
            "zh" -> Locale.TRADITIONAL_CHINESE
            else -> {
                // Try to parse "xx-YY" format
                val parts = lang.split("-", "_")
                if (parts.size >= 2) Locale(parts[0], parts[1])
                else Locale(parts[0])
            }
        }
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "語音播放",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Bot 語音指令播放通知"
                setShowBadge(false)
            }
            val nm = getSystemService(NotificationManager::class.java)
            nm?.createNotificationChannel(channel)
        }
    }

    private fun buildNotification(contentText: String): Notification {
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setContentTitle("E-Claw TTS")
            .setContentText(contentText)
            .setOngoing(true)
            .setSilent(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    override fun onDestroy() {
        serviceScope.cancel()
        tts?.stop()
        tts?.shutdown()
        tts = null
        ttsReady = false
        Timber.d("[TTS] Service destroyed")
        super.onDestroy()
    }
}
