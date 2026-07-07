package com.hank.clawlive.fcm

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import com.hank.clawlive.ChatActivity
import com.hank.clawlive.FeedbackHistoryActivity
import com.hank.clawlive.MainActivity
import com.hank.clawlive.MissionControlActivity
import com.hank.clawlive.R
import com.hank.clawlive.data.local.DeviceManager
import com.hank.clawlive.data.remote.NetworkModule
import com.hank.clawlive.data.repository.ActionRequestBadgeSync
import com.hank.clawlive.location.LocationHelper
import com.hank.clawlive.ui.nav.EClawNativeNavBridge
import org.json.JSONObject
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import timber.log.Timber

class ClawFcmService : FirebaseMessagingService() {

    companion object {
        const val CHANNEL_CHAT = "eclaw_chat"
        const val CHANNEL_SYSTEM = "eclaw_system"
        const val CHANNEL_FEEDBACK = "eclaw_feedback"
        const val CHANNEL_ACTION_REQUESTS = "eclaw_action_requests"

        fun createChannels(context: Context) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
            val nm = context.getSystemService(NotificationManager::class.java)
            nm.createNotificationChannel(NotificationChannel(
                CHANNEL_CHAT, context.getString(R.string.fcm_channel_chat_name), NotificationManager.IMPORTANCE_HIGH
            ).apply { description = context.getString(R.string.fcm_channel_chat_desc) })
            nm.createNotificationChannel(NotificationChannel(
                CHANNEL_SYSTEM, context.getString(R.string.fcm_channel_system_name), NotificationManager.IMPORTANCE_DEFAULT
            ).apply { description = context.getString(R.string.fcm_channel_system_desc) })
            nm.createNotificationChannel(NotificationChannel(
                CHANNEL_FEEDBACK, context.getString(R.string.fcm_channel_feedback_name), NotificationManager.IMPORTANCE_DEFAULT
            ).apply { description = context.getString(R.string.fcm_channel_feedback_desc) })
            nm.createNotificationChannel(NotificationChannel(
                CHANNEL_ACTION_REQUESTS,
                context.getString(R.string.fcm_channel_action_requests_name),
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = context.getString(R.string.fcm_channel_action_requests_desc)
                setShowBadge(true)
            })
        }
    }

    override fun onNewToken(token: String) {
        Timber.d("[FCM] New token: ${token.take(20)}...")
        val dm = DeviceManager.getInstance(this)
        CoroutineScope(Dispatchers.IO).launch {
            try {
                NetworkModule.api.registerFcmToken(
                    mapOf(
                        "deviceId" to dm.deviceId,
                        "deviceSecret" to dm.deviceSecret,
                        "fcmToken" to token
                    )
                )
            } catch (e: Exception) {
                Timber.e(e, "[FCM] Failed to register token")
            }
        }
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val data = message.data

        // Handle location request silently — no notification, just fetch and report GPS
        if (data["type"] == "location_request" || data["category"] == "location_request") {
            val requestId = try {
                org.json.JSONObject(data["metadata"] ?: "{}").optString("requestId", null)
            } catch (_: Exception) { null }
            Timber.d("[FCM] Location request received, requestId=$requestId")
            LocationHelper.fetchAndReportAsync(applicationContext, requestId)
            return
        }

        val title = data["title"] ?: message.notification?.title ?: "E-Claw"
        val body = data["body"] ?: message.notification?.body ?: ""
        val category = data["category"] ?: "system"
        if (data["type"] == "action_request" || data["metadata"]?.contains("\"ownerDecision\":true") == true) {
            ActionRequestBadgeSync.refreshAsync(applicationContext)
        }

        // TTS category: start TtsService to speak aloud instead of showing notification
        if (category == "tts") {
            val ttsIntent = Intent(this, com.hank.clawlive.service.TtsService::class.java).apply {
                putExtra("tts_text", body)
                putExtra("tts_entity_name", title)
            }
            // BLK-FGS (card_f9b2cc2d): on Android 12+ a background-restricted app
            // throws ForegroundServiceStartNotAllowedException at THIS call site —
            // and FCM is delivered precisely while the app is backgrounded (e.g.
            // user just switched to home). The exception is thrown back to the
            // caller BEFORE TtsService runs, so TtsService's own try/catch cannot
            // catch it; uncaught here it kills the shared process and takes the
            // live wallpaper down with it (pure black, needs app restart). Guard it
            // and fall through to a normal notification so the message is never lost.
            var ttsStarted = false
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    startForegroundService(ttsIntent)
                } else {
                    startService(ttsIntent)
                }
                ttsStarted = true
            } catch (t: Throwable) {
                Timber.e(t, "[FCM] tts startForegroundService refused (${t.javaClass.simpleName}); falling back to notification")
                try { com.google.firebase.crashlytics.FirebaseCrashlytics.getInstance().recordException(t) } catch (_: Throwable) {}
            }
            if (ttsStarted) return  // spoke via service; no notification needed
            // else: fall through to show a normal notification carrying the body
        }

        // Keep the foreground channel consistent with the channel the backend
        // names in its android.notification block (sendFcm hardcodes
        // channelId="eclaw_chat" for every non-silent category). Routing
        // kanban_done/kanban_done_auto here to CHANNEL_SYSTEM previously meant
        // a foreground "task completed" landed on eclaw_system while the same
        // event in the background landed on eclaw_chat — two different user
        // toggles / importances for one event. Use CHANNEL_CHAT for these so
        // foreground and background display identically (card_caa6307).
        val channelId = when (category) {
            "bot_reply", "broadcast", "speak_to",
            "kanban_done", "kanban_done_auto", "scheduled" -> CHANNEL_CHAT
            "feedback_reply", "feedback_resolved" -> CHANNEL_FEEDBACK
            else -> CHANNEL_SYSTEM
        }

        // Persist force update flag for MainActivity to show blocking dialog on next launch
        if (category == "app_update") {
            val forceUpdate = data["forceUpdate"] == "true"
            val version = data["version"]
            if (forceUpdate && version != null) {
                getSharedPreferences("update_prefs", Context.MODE_PRIVATE)
                    .edit()
                    .putBoolean("force_update_pending", true)
                    .putString("force_update_version", version)
                    .apply()
            }
        }

        val targetIntent = when (category) {
            "bot_reply", "broadcast", "speak_to", "scheduled" ->
                Intent(this, ChatActivity::class.java)
            "feedback_reply", "feedback_resolved" ->
                Intent(this, FeedbackHistoryActivity::class.java)
            // Task-completed pushes deep-link straight to the finished card
            // instead of dumping the user on the home screen (card_92c17b66).
            // The backend carries the card id in data.metadata.cardId (and,
            // redundantly, in data.link=/portal/kanban.html?card=<id>). We hand
            // it to MissionControlActivity as a native-nav intent extra; that
            // Activity loads mission.html then replays the intent via
            // window.eclawHandleNativeNavigateIntent once the WebView is ready,
            // which opens the specific kanban card. Works on cold start
            // (onCreate reads the extra) and warm resume (onNewIntent) because
            // the intent also clears-top + single-top the running instance.
            "kanban_done", "kanban_done_auto" -> {
                val cardId = extractCardId(data)
                Intent(this, MissionControlActivity::class.java).apply {
                    if (cardId != null) {
                        putExtra(EClawNativeNavBridge.EXTRA_NAV_INTENT, buildCardNavIntentJson(cardId))
                    }
                }
            }
            "app_update" -> {
                val storeUrl = data["link"]
                    ?: "https://play.google.com/store/apps/details?id=com.hank.clawlive"
                Intent(Intent.ACTION_VIEW, Uri.parse(storeUrl))
            }
            else ->
                Intent(this, MainActivity::class.java)
        }.apply {
            // CLEAR_TOP + SINGLE_TOP so a running MissionControl/Chat instance is
            // reused and receives the deep-link extra via onNewIntent rather than
            // being recreated (neither Activity declares a singleTop launchMode;
            // the in-app nav bridge relies on the same per-intent flags).
            flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or
                Intent.FLAG_ACTIVITY_NEW_TASK or
                Intent.FLAG_ACTIVITY_SINGLE_TOP
        }

        val pi = PendingIntent.getActivity(
            this, System.currentTimeMillis().toInt(), targetIntent,
            PendingIntent.FLAG_ONE_SHOT or PendingIntent.FLAG_IMMUTABLE
        )

        val nm = getSystemService(NotificationManager::class.java)
        val notif = NotificationCompat.Builder(this, channelId)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setContentTitle(title)
            .setContentText(body)
            .setAutoCancel(true)
            .setContentIntent(pi)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .build()

        nm.notify(System.currentTimeMillis().toInt(), notif)
    }

    /**
     * Pull the kanban card id out of an FCM data payload. The backend puts it in
     * `metadata.cardId` (JSON-encoded string) and, redundantly, in the deep-link
     * `link=/portal/kanban.html?card=<id>`. Prefer metadata; fall back to parsing
     * the link so a payload shape change on one side doesn't break the deep link.
     * Returns null when neither is present (caller then just opens Mission
     * Control without a card focus — still better than the home screen).
     */
    private fun extractCardId(data: Map<String, String>): String? {
        // 1) metadata JSON → cardId
        data["metadata"]?.let { raw ->
            try {
                val id = JSONObject(raw).optString("cardId", "").trim()
                if (id.isNotEmpty()) return id
            } catch (e: Exception) {
                Timber.w(e, "[FCM] kanban_done metadata parse failed: $raw")
            }
        }
        // 2) link → ?card=<id> (value may be url-encoded but card ids are safe chars)
        data["link"]?.let { link ->
            try {
                val id = Uri.parse(link).getQueryParameter("card")?.trim()
                if (!id.isNullOrEmpty()) return id
            } catch (e: Exception) {
                Timber.w(e, "[FCM] kanban_done link parse failed: $link")
            }
        }
        return null
    }

    /**
     * Build the native-nav intent JSON that the portal pages understand. mission.html
     * (loaded by MissionControlActivity) requires BOTH `target=="card"` and `cardId`;
     * kanban.html only needs `cardId`. Emitting both keeps either page working.
     */
    private fun buildCardNavIntentJson(cardId: String): String =
        JSONObject()
            .put("targetTab", "mission")
            .put("target", "card")
            .put("cardId", cardId)
            .toString()
}
