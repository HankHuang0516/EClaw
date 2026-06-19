package com.hank.clawlive.settings

import com.hank.clawlive.R

data class NotificationPreferenceCategory(
    val key: String,
    val labelResId: Int,
    val writeAliases: List<String> = emptyList()
) {
    fun updatePayload(enabled: Boolean): Map<String, Boolean> {
        return (listOf(key) + writeAliases).associateWith { enabled }
    }
}

object NotificationPreferenceCatalog {
    val categories: List<NotificationPreferenceCategory> = listOf(
        NotificationPreferenceCategory("bot_reply", R.string.notif_pref_bot_reply),
        NotificationPreferenceCategory("broadcast", R.string.notif_pref_broadcast),
        NotificationPreferenceCategory("speak_to", R.string.notif_pref_speak_to),
        NotificationPreferenceCategory("user_mention", R.string.notif_pref_user_mention),
        NotificationPreferenceCategory("feedback_resolved", R.string.notif_pref_feedback, listOf("feedback_reply")),
        NotificationPreferenceCategory("todo_done", R.string.notif_pref_todo),
        NotificationPreferenceCategory("scheduled", R.string.notif_pref_scheduled),
        NotificationPreferenceCategory("kanban_done", R.string.notif_pref_kanban_done),
        NotificationPreferenceCategory("kanban_done_auto", R.string.notif_pref_kanban_done_auto),
        NotificationPreferenceCategory("rich_card_question", R.string.notif_pref_rich_card)
    )

    val visibleKeys: List<String> = categories.map { it.key }
}
