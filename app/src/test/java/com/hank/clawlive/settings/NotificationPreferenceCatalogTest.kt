package com.hank.clawlive.settings

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class NotificationPreferenceCatalogTest {

    @Test
    fun visibleKeysMatchWebNotificationSettings() {
        assertEquals(
            listOf(
                "bot_reply",
                "broadcast",
                "speak_to",
                "user_mention",
                "feedback_resolved",
                "todo_done",
                "scheduled",
                "kanban_done",
                "kanban_done_auto",
                "rich_card_question"
            ),
            NotificationPreferenceCatalog.visibleKeys
        )
    }

    @Test
    fun feedbackToggleAlsoUpdatesFeedbackReplyAlias() {
        val feedback = NotificationPreferenceCatalog.categories.single { it.key == "feedback_resolved" }

        assertEquals(
            mapOf(
                "feedback_resolved" to false,
                "feedback_reply" to false
            ),
            feedback.updatePayload(false)
        )
    }

    @Test
    fun newHighSignalPushCategoriesAreExposed() {
        val keys = NotificationPreferenceCatalog.visibleKeys

        assertTrue(keys.contains("user_mention"))
        assertTrue(keys.contains("rich_card_question"))
    }
}
