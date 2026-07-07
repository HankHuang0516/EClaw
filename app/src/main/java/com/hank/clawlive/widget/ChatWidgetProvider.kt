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
import com.hank.clawlive.data.repository.ActionRequestBadgeSync

/**
 * Simple 1x1 resizable chat widget
 * Clicking opens ChatActivity as a floating dialog
 */
class ChatWidgetProvider : AppWidgetProvider() {

    override fun onUpdate(
        context: Context,
        appWidgetManager: AppWidgetManager,
        appWidgetIds: IntArray
    ) {
        val chatPrefs = ChatPreferences.getInstance(context)

        appWidgetIds.forEach { appWidgetId ->
            updateAppWidget(context, appWidgetManager, appWidgetId, chatPrefs)
        }
        ActionRequestBadgeSync.refreshAsync(context)
    }

    override fun onReceive(context: Context, intent: Intent) {
        super.onReceive(context, intent)
        if (intent.action == ACTION_RENDER_BADGE) {
            renderAllWidgets(context)
        }
    }

    private fun updateAppWidget(
        context: Context,
        appWidgetManager: AppWidgetManager,
        appWidgetId: Int,
        chatPrefs: ChatPreferences
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

        // Set dynamic text from last message
        val displayText = chatPrefs.getWidgetDisplayText()
        views.setTextViewText(R.id.widget_text, displayText)

        val textColor = if (chatPrefs.lastMessage.isNullOrEmpty()) {
            0xFFAAAAAA.toInt()
        } else {
            0xFFFFFFFF.toInt()
        }
        views.setTextColor(R.id.widget_text, textColor)

        val pendingCount = ActionRequestBadgeSync.getCachedCount(context)
        if (pendingCount > 0) {
            val displayCount = ActionRequestBadgeSync.formatCount(pendingCount)
            val badgeText = context.getString(R.string.widget_needs_you_count, displayCount)
            views.setViewVisibility(R.id.widget_pending_badge, View.VISIBLE)
            views.setTextViewText(R.id.widget_pending_badge, badgeText)
            views.setContentDescription(
                R.id.widget_pending_badge,
                context.getString(R.string.widget_needs_you_count_desc, displayCount)
            )
        } else {
            views.setViewVisibility(R.id.widget_pending_badge, View.GONE)
        }

        // On Click -> Launch ChatActivity floating dialog
        views.setOnClickPendingIntent(R.id.widget_root, pendingIntent)
        views.setOnClickPendingIntent(R.id.widget_send_btn, pendingIntent)

        appWidgetManager.updateAppWidget(appWidgetId, views)
    }

    companion object {
        private const val ACTION_RENDER_BADGE = "com.hank.clawlive.widget.RENDER_BADGE"

        fun updateWidgets(context: Context) {
            val intent = Intent(context, ChatWidgetProvider::class.java).apply {
                action = ACTION_RENDER_BADGE
            }
            context.sendBroadcast(intent)
        }

        private fun renderAllWidgets(context: Context) {
            val widgetManager = AppWidgetManager.getInstance(context)
            val widgetIds = widgetManager.getAppWidgetIds(
                ComponentName(context, ChatWidgetProvider::class.java)
            )
            val chatPrefs = ChatPreferences.getInstance(context)
            val provider = ChatWidgetProvider()
            widgetIds.forEach { appWidgetId ->
                provider.updateAppWidget(context, widgetManager, appWidgetId, chatPrefs)
            }
        }
    }
}
