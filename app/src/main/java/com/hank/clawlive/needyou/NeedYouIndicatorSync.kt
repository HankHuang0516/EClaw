package com.hank.clawlive.needyou

import android.content.Context
import com.hank.clawlive.data.local.DeviceManager
import com.hank.clawlive.data.local.NeedYouIndicatorPrefs
import com.hank.clawlive.data.remote.NetworkModule
import com.hank.clawlive.widget.ChatWidgetProvider
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import me.leolin.shortcutbadger.ShortcutBadger
import timber.log.Timber
import kotlin.math.max

object NeedYouIndicatorSync {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    fun refreshAsync(context: Context, reason: String) {
        val appContext = context.applicationContext
        scope.launch {
            refresh(appContext, reason)
        }
    }

    suspend fun refresh(context: Context, reason: String): Int? {
        val appContext = context.applicationContext
        val dm = DeviceManager.getInstance(appContext)
        val deviceId = dm.deviceId
        val deviceSecret = dm.deviceSecret
        if (deviceId.isBlank() || deviceSecret.isBlank()) return null

        return try {
            val response = NetworkModule.api.getActionRequestPendingCount(deviceId, deviceSecret)
            if (!response.success) {
                Timber.w("[NeedYouIndicator] pending-count failed reason=%s error=%s", reason, response.error)
                return null
            }
            applyCount(appContext, response.count, reason)
            response.count
        } catch (e: Exception) {
            Timber.w(e, "[NeedYouIndicator] pending-count sync failed reason=%s", reason)
            null
        }
    }

    fun applyCount(context: Context, rawCount: Int, reason: String) {
        val appContext = context.applicationContext
        val count = max(0, rawCount)
        NeedYouIndicatorPrefs.getInstance(appContext).pendingCount = count
        updateLauncherBadge(appContext, count, reason)
        ChatWidgetProvider.updateWidgets(appContext)
    }

    private fun updateLauncherBadge(context: Context, count: Int, reason: String) {
        try {
            val ok = if (count > 0) {
                ShortcutBadger.applyCount(context, count)
            } else {
                ShortcutBadger.removeCount(context)
            }
            if (!ok) {
                Timber.d("[NeedYouIndicator] launcher badge unsupported reason=%s count=%d", reason, count)
            }
        } catch (e: Exception) {
            Timber.w(e, "[NeedYouIndicator] launcher badge update failed reason=%s count=%d", reason, count)
        }
    }
}
