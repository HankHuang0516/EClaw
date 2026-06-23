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
import timber.log.Timber
import java.util.Locale
import java.util.concurrent.atomic.AtomicInteger

/**
 * Foreground service that speaks text aloud using Android's built-in TextToSpeech
 * engine. Works even when the app is in background.
 *
 * BLK-FGS process isolation (card_f9b2cc2d, v1.1.11): this service runs in its own
 * ":tts" process (AndroidManifest android:process=":tts"). That keeps its main looper
 * separate from the live-wallpaper engine's process, so the wallpaper-resume burst can
 * never starve this service's startForeground() past the OS deadline; and even if a
 * foreground-service crash ever did occur, only the ":tts" process dies — the
 * wallpaper's process and engine are untouched (never goes black).
 *
 * Because SocketManager.ttsFlow is a MAIN-process singleton (invisible from ":tts"),
 * this service no longer collects it directly. It speaks ONLY from onStartCommand
 * intent extras (tts_text / tts_lang / tts_speed / tts_pitch / tts_entity_name). Two
 * callers supply those extras:
 *   1) ClawFcmService — FCM category=tts push fallback.
 *   2) MainActivity — a main-process coroutine that collects SocketManager.ttsFlow and
 *      forwards each event to this service as a startService Intent.
 */
class TtsService : Service(), TextToSpeech.OnInitListener {

    companion object {
        private const val CHANNEL_ID = "eclaw_tts"
        private const val NOTIFICATION_ID = 9001
    }

    private var tts: TextToSpeech? = null
    private var ttsReady = false
    private var isForeground = false
    private val utteranceCounter = AtomicInteger(0)

    override fun onCreate() {
        super.onCreate()
        Timber.d("[TTS] Service created")
        createNotificationChannel()
        if (!ensureForeground()) return
        tts = TextToSpeech(this, this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // card_f9b2cc2d: a service launched via startForegroundService() MUST call
        // startForeground() within the OS deadline (~5s) on EVERY start command —
        // not just the first. If it doesn't, the system kills the WHOLE app process
        // with RemoteServiceException$ForegroundServiceDidNotStartInTimeException,
        // which takes the live-wallpaper engine (same process) down with it: the
        // wallpaper goes pure-black and only relaunching the app recovers it.
        // onCreate covers the first start; this covers sticky/redelivered restarts
        // (app backgrounded / memory pressure) where onCreate does not re-run.
        if (!ensureForeground()) return START_NOT_STICKY

        // Handle FCM fallback: when the app receives an FCM with category=tts,
        // it can start this service with extras
        intent?.getStringExtra("tts_text")?.let { text ->
            val lang = intent.getStringExtra("tts_lang") ?: "zh-TW"
            val speed = intent.getFloatExtra("tts_speed", 1.0f)
            val pitch = intent.getFloatExtra("tts_pitch", 1.0f)
            val entityName = intent.getStringExtra("tts_entity_name") ?: "Bot"
            speak(text, lang, speed, pitch, entityName)
        }
        // START_NOT_STICKY: do NOT let the system auto-restart this FGS with a null
        // intent — a sticky restart re-arms the startForeground() deadline and is the
        // path that produced the DidNotStartInTime process-kill. It is recreated on
        // the next app launch / TTS event, which is sufficient for voice playback.
        return START_NOT_STICKY
    }

    /**
     * Promote to foreground, fulfilling the startForegroundService() contract.
     * Idempotent. Returns false (and stops the service) if the platform refuses
     * the promotion (e.g. ForegroundServiceStartNotAllowedException when started
     * background-restricted). Crucially it never lets a foreground-service
     * exception propagate — an uncaught one would crash the process and kill the
     * live wallpaper too. card_f9b2cc2d.
     */
    private fun ensureForeground(): Boolean {
        if (isForeground) return true
        return try {
            startForeground(NOTIFICATION_ID, buildNotification("TTS 語音服務就緒"))
            isForeground = true
            true
        } catch (e: Exception) {
            Timber.e(e, "[TTS] startForeground failed (${e.javaClass.simpleName}); stopping service instead of crashing the process")
            try { stopSelf() } catch (_: Exception) {}
            false
        }
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
        tts?.stop()
        tts?.shutdown()
        tts = null
        ttsReady = false
        Timber.d("[TTS] Service destroyed")
        super.onDestroy()
    }
}
