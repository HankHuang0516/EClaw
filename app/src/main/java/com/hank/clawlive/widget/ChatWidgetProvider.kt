package com.hank.clawlive.widget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.view.View
import android.widget.RemoteViews
import com.hank.clawlive.ChatActivity
import com.hank.clawlive.R
import com.hank.clawlive.data.local.ChatPreferences
import com.hank.clawlive.data.local.NeedYouIndicatorPrefs
import com.hank.clawlive.needyou.NeedYouIndicatorSync

/**
 * Simple 1x1 resizable chat widget
 * Clicking opens ChatActivity as a floating dialog
 */
class ChatWidgetProvider : AppWidgetProvider() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == AppWidgetManager.ACTION_APPWIDGET_UPDATE &&
            !intent.getBooleanExtra(EXTRA_SKIP_REMOTE_REFRESH, false)
        ) {
            NeedYouIndicatorSync.refreshAsync(context, "widget_update")
        }
        super.onReceive(context, intent)
    }

    override fun onUpdate(
        context: Context,
        appWidgetManager: AppWidgetManager,
        appWidgetIds: IntArray
    ) {
        val chatPrefs = ChatPreferences.getInstance(context)
        val needYouPrefs = NeedYouIndicatorPrefs.getInstance(context)

        appWidgetIds.forEach { appWidgetId ->
            updateAppWidget(context, appWidgetManager, appWidgetId, chatPrefs, needYouPrefs)
        }
    }

    private fun updateAppWidget(
        context: Context,
        appWidgetManager: AppWidgetManager,
        appWidgetId: Int,
        chatPrefs: ChatPreferences,
        needYouPrefs: NeedYouIndicatorPrefs
    ) {
        // Create intent to launch ChatActivity as floating dialog
        val intent = Intent(context, ChatActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val pendingIntent = PendingIntent.getActivity(
            context,
            0,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val views = RemoteViews(context.packageName, R.layout.widget_claw_chat)

        val pendingCount = needYouPrefs.pendingCount
        val hasPendingNeedsYou = pendingCount > 0

        val displayText = if (hasPendingNeedsYou) {
            context.resources.getQuantityString(R.plurals.widget_needyou_pending, pendingCount, pendingCount)
        } else {
            chatPrefs.getWidgetDisplayText()
        }
        views.setTextViewText(R.id.widget_text, displayText)
        views.setTextViewText(R.id.widget_needyou_badge, formatBadgeCount(pendingCount))
        views.setViewVisibility(R.id.widget_needyou_badge, if (hasPendingNeedsYou) View.VISIBLE else View.GONE)
        views.setContentDescription(
            R.id.widget_needyou_badge,
            context.getString(R.string.widget_needyou_badge_content_description)
        )

        val textColor = if (hasPendingNeedsYou) {
            0xFFFFFFFF.toInt()
        } else if (chatPrefs.lastMessage.isNullOrEmpty()) {
            0xFFAAAAAA.toInt()
        } else {
            0xFFFFFFFF.toInt()
        }
        views.setTextColor(R.id.widget_text, textColor)

        // On Click -> Launch ChatActivity floating dialog
        views.setOnClickPendingIntent(R.id.widget_root, pendingIntent)
        views.setOnClickPendingIntent(R.id.widget_send_btn, pendingIntent)

        appWidgetManager.updateAppWidget(appWidgetId, views)
    }

    companion object {
        private const val EXTRA_SKIP_REMOTE_REFRESH = "com.hank.clawlive.widget.SKIP_REMOTE_REFRESH"

        fun updateWidgets(context: Context) {
            val intent = Intent(context, ChatWidgetProvider::class.java).apply {
                action = AppWidgetManager.ACTION_APPWIDGET_UPDATE
                putExtra(EXTRA_SKIP_REMOTE_REFRESH, true)
            }

            val widgetManager = AppWidgetManager.getInstance(context)
            val widgetIds = widgetManager.getAppWidgetIds(
                ComponentName(context, ChatWidgetProvider::class.java)
            )

            intent.putExtra(AppWidgetManager.EXTRA_APPWIDGET_IDS, widgetIds)
            context.sendBroadcast(intent)
        }

        private fun formatBadgeCount(count: Int): String =
            if (count > 99) "99+" else count.coerceAtLeast(0).toString()
    }
}
