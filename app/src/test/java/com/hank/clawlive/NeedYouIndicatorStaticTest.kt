package com.hank.clawlive

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class NeedYouIndicatorStaticTest {
    @Test
    fun androidApiUsesPendingCountEndpoint() {
        val api = readSource("com/hank/clawlive/data/remote/ClawApiService.kt")
        assertTrue(api.contains("@GET(\"api/action-requests/pending-count\")"))
        assertTrue(api.contains("getActionRequestPendingCount"))
    }

    @Test
    fun syncerUpdatesWidgetAndLauncherBadge() {
        val sync = readSource("com/hank/clawlive/needyou/NeedYouIndicatorSync.kt")
        assertTrue(sync.contains("NetworkModule.api.getActionRequestPendingCount"))
        assertTrue(sync.contains("NeedYouIndicatorPrefs.getInstance"))
        assertTrue(sync.contains("ChatWidgetProvider.updateWidgets"))
        assertTrue(sync.contains("ShortcutBadger.applyCount"))
        assertTrue(sync.contains("ShortcutBadger.removeCount"))
    }

    @Test
    fun widgetRendersCachedNeedsYouCountWithoutRemoteLoop() {
        val provider = readSource("com/hank/clawlive/widget/ChatWidgetProvider.kt")
        val layout = readRes("layout/widget_claw_chat.xml")
        assertTrue(layout.contains("@+id/widget_needyou_badge"))
        assertTrue(provider.contains("NeedYouIndicatorPrefs.getInstance"))
        assertTrue(provider.contains("R.plurals.widget_needyou_pending"))
        assertTrue(provider.contains("EXTRA_SKIP_REMOTE_REFRESH"))
        assertTrue(provider.contains("NeedYouIndicatorSync.refreshAsync(context, \"widget_update\")"))
    }

    @Test
    fun appFcmAndSocketTriggerNeedsYouRefresh() {
        val app = readSource("com/hank/clawlive/ClawApplication.kt")
        val main = readSource("com/hank/clawlive/MainActivity.kt")
        val fcm = readSource("com/hank/clawlive/fcm/ClawFcmService.kt")
        val socket = readSource("com/hank/clawlive/data/remote/SocketManager.kt")
        assertTrue(app.contains("NeedYouIndicatorSync.refreshAsync(this, \"app_start\")"))
        assertTrue(main.contains("actionRequestChangedFlow.collect"))
        assertTrue(main.contains("NeedYouIndicatorSync.refreshAsync(this, \"main_resume\")"))
        assertTrue(fcm.contains("category == \"rich_card_question\" || type == \"action_request\""))
        assertTrue(socket.contains("on(\"action_request:changed\")"))
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

    private fun readRes(relPath: String): String {
        val candidates = listOf(
            File("src/main/res/$relPath"),
            File("app/src/main/res/$relPath")
        )
        val file = candidates.firstOrNull { it.isFile }
            ?: error("Could not locate $relPath from ${File(".").absolutePath}")
        return file.readText()
    }
}
