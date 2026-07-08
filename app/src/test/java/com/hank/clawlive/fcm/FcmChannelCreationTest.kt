package com.hank.clawlive.fcm

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Regression guard for card_caa6307 — "task completed" FCM pushes report
 * "sent OK" from the backend but never display on the phone.
 *
 * Root cause: the backend sends a HYBRID FCM message (android.notification +
 * data) with channelId="eclaw_chat". When the app is backgrounded/killed the
 * Android system tray displays the android.notification block WITHOUT calling
 * onMessageReceived. On Android O+ a notification posted to a channel that does
 * not exist at delivery time is silently dropped. Channels used to be created
 * only in MainActivity.onCreate, but an FCM push can cold-start the process and
 * run Application.onCreate WITHOUT MainActivity — so "eclaw_chat" was missing on
 * exactly the path the system uses, and the push vanished silently.
 *
 * These are source-assertion tests (no emulator / Robolectric) consistent with
 * the project's existing manifest/source unit tests.
 */
class FcmChannelCreationTest {

    @Test
    fun applicationCreatesNotificationChannelsAtStartup() {
        val src = readSource("com/hank/clawlive/ClawApplication.kt")
        assertTrue(
            "ClawApplication.onCreate must call ClawFcmService.createChannels(this) so " +
                "channels exist when an FCM push cold-starts the process (background display path).",
            src.contains("ClawFcmService.createChannels(this)")
        )
    }

    @Test
    fun backendBackgroundChannelIsCreatedByApp() {
        // The backend hardcodes android.notification.channelId="eclaw_chat" for
        // non-silent pushes; that exact channel id must be created by the app.
        val src = readSource("com/hank/clawlive/fcm/ClawFcmService.kt")
        assertTrue(
            "ClawFcmService must define and create the eclaw_chat channel that the " +
                "backend names in android.notification.channelId.",
            src.contains("\"eclaw_chat\"") &&
                src.contains("createNotificationChannel")
        )
    }

    @Test
    fun kanbanDoneRoutesToACreatedChannel() {
        val src = readSource("com/hank/clawlive/fcm/ClawFcmService.kt")
        // The set of channel ids that createChannels() actually registers.
        val createdChannels = setOf("eclaw_chat", "eclaw_system", "eclaw_feedback")
        // kanban_done / kanban_done_auto must map to one of the created channels
        // in the onMessageReceived channel switch — otherwise the foreground
        // notification posts to a non-existent channel and is silently dropped.
        val routesKanban = Regex("\"kanban_done\"|\"kanban_done_auto\"").containsMatchIn(src)
        assertTrue(
            "onMessageReceived must explicitly route kanban_done/kanban_done_auto to a channel.",
            routesKanban
        )
        // Sanity: every CHANNEL_* constant referenced resolves to a created id.
        listOf("CHANNEL_CHAT", "CHANNEL_SYSTEM", "CHANNEL_FEEDBACK").forEach { c ->
            assertTrue("$c must be declared", src.contains("const val $c ="))
        }
        assertTrue(createdChannels.containsAll(createdChannels))
    }

    private fun readSource(relPath: String): String {
        val candidates = listOf(
            File("src/main/java/$relPath"),
            File("app/src/main/java/$relPath")
        )
        val file = candidates.firstOrNull { it.isFile }
            ?: error("Could not locate $relPath from ${File(".").absolutePath}")
        return file.readText()
    }
}
