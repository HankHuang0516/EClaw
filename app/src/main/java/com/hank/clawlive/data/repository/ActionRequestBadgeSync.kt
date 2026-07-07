package com.hank.clawlive.data.repository

import android.Manifest
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.hank.clawlive.ChatActivity
import com.hank.clawlive.R
import com.hank.clawlive.data.local.DeviceManager
import com.hank.clawlive.data.remote.NetworkModule
import com.hank.clawlive.fcm.ClawFcmService
import com.hank.clawlive.widget.ChatWidgetProvider
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import timber.log.Timber

/**
 * Keeps the device-level "需要你" pending count visible outside the app.
 *
 * Android does not expose a universal launcher-badge count API, so the launcher
 * badge is driven through a silent summary notification with setNumber().
 */
object ActionRequestBadgeSync {
    private const val PREFS_NAME = "action_request_badge_prefs"
    private const val KEY_PENDING_COUNT = "pending_count"
    private const val SUMMARY_NOTIFICATION_ID = 61006

    fun getCachedCount(context: Context): Int =
        context.applicationContext
            .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .getInt(KEY_PENDING_COUNT, 0)
            .coerceAtLeast(0)

    fun refreshAsync(context: Context) {
        val appContext = context.applicationContext
        CoroutineScope(Dispatchers.IO).launch {
            refresh(appContext)
        }
    }

    suspend fun refresh(context: Context): Int? {
        val appContext = context.applicationContext
        return try {
            val dm = DeviceManager.getInstance(appContext)
            val response = withContext(Dispatchers.IO) {
                NetworkModule.api.getActionRequestPendingCount(
                    deviceId = dm.deviceId,
                    deviceSecret = dm.deviceSecret
                )
            }
            if (!response.success) {
                Timber.w("[NeedYouBadge] pending-count returned success=false: ${response.error}")
                return null
            }
            val count = response.count.coerceAtLeast(0)
            applyCount(appContext, count)
            count
        } catch (e: Exception) {
            Timber.w(e, "[NeedYouBadge] pending-count refresh failed")
            null
        }
    }

    fun applyCount(context: Context, count: Int) {
        val appContext = context.applicationContext
        val safeCount = count.coerceAtLeast(0)
        appContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .putInt(KEY_PENDING_COUNT, safeCount)
            .apply()

        ChatWidgetProvider.updateWidgets(appContext)
        updateLauncherBadge(appContext, safeCount)
    }

    private fun updateLauncherBadge(context: Context, count: Int) {
        val notificationManager = NotificationManagerCompat.from(context)
        if (count <= 0) {
            notificationManager.cancel(SUMMARY_NOTIFICATION_ID)
            return
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED
        ) {
            Timber.d("[NeedYouBadge] POST_NOTIFICATIONS denied; widget updated but launcher badge cannot be posted")
            return
        }

        ClawFcmService.createChannels(context)

        val openInboxIntent = Intent(context, ChatActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or
                Intent.FLAG_ACTIVITY_CLEAR_TOP or
                Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        val pendingIntent = PendingIntent.getActivity(
            context,
            SUMMARY_NOTIFICATION_ID,
            openInboxIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val displayCount = formatCount(count)
        val notification = NotificationCompat.Builder(context, ClawFcmService.CHANNEL_ACTION_REQUESTS)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(context.getString(R.string.needs_you_badge_notification_title))
            .setContentText(context.getString(R.string.needs_you_badge_notification_body, displayCount))
            .setContentIntent(pendingIntent)
            .setNumber(count)
            .setBadgeIconType(NotificationCompat.BADGE_ICON_SMALL)
            .setOnlyAlertOnce(true)
            .setOngoing(false)
            .setAutoCancel(false)
            .setSilent(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .build()

        try {
            notificationManager.notify(SUMMARY_NOTIFICATION_ID, notification)
        } catch (e: SecurityException) {
            Timber.w(e, "[NeedYouBadge] launcher badge notification blocked")
        }
    }

    fun formatCount(count: Int): String = if (count > 99) "99+" else count.toString()
}
