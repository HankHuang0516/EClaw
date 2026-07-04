package com.hank.clawlive.fcm

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Regression guard for card_92c17b66 — tapping a "task completed" (kanban_done /
 * kanban_done_auto) push on Android opened the app to the HOME screen instead of
 * the specific finished card.
 *
 * Root cause: ClawFcmService's onMessageReceived channel/intent switch had no
 * case for the kanban_done categories, so they fell into `else ->
 * Intent(MainActivity)` with no card extra — the WebView was never told which
 * card to open. The backend was already correct (data.link=
 * /portal/kanban.html?card=<id> and data.metadata.cardId), and the WebView deep
 * link handler already existed (window.eclawHandleNativeNavigateIntent), so the
 * fix lives entirely in the app's notification-tap routing.
 *
 * These are source-assertion tests (no emulator / Robolectric), consistent with
 * FcmChannelCreationTest and the project's existing manifest/source unit tests.
 * Full end-to-end (send push → tap → card opens) requires a device + FCM.
 */
class KanbanDoneDeepLinkTest {

    private val fcmSrc: String by lazy { readSource("com/hank/clawlive/fcm/ClawFcmService.kt") }

    @Test
    fun kanbanDoneTapRoutesToMissionControlActivity() {
        // The kanban_done branch must build an Intent for MissionControlActivity
        // (which hosts the mission/kanban WebView) — not fall through to the
        // MainActivity home screen.
        assertTrue(
            "onMessageReceived must route kanban_done/kanban_done_auto to " +
                "MissionControlActivity so the tap can deep-link to the card.",
            fcmSrc.contains("\"kanban_done\", \"kanban_done_auto\" ->") &&
                fcmSrc.contains("Intent(this, MissionControlActivity::class.java)")
        )
    }

    @Test
    fun kanbanDoneCarriesNativeNavIntentExtra() {
        // The tap PendingIntent must carry the native-nav intent extra so the
        // receiving Activity can replay it into the WebView.
        assertTrue(
            "kanban_done tap intent must put EClawNativeNavBridge.EXTRA_NAV_INTENT " +
                "carrying the card deep link.",
            fcmSrc.contains("EClawNativeNavBridge.EXTRA_NAV_INTENT")
        )
    }

    @Test
    fun cardIdExtractedFromMetadataAndLink() {
        // Resilience: the card id must be pulled from metadata.cardId AND fall
        // back to the ?card= query param on the deep link.
        assertTrue(
            "extractCardId must read metadata.cardId.",
            fcmSrc.contains("optString(\"cardId\"")
        )
        assertTrue(
            "extractCardId must fall back to the ?card= param on data.link.",
            fcmSrc.contains("getQueryParameter(\"card\")")
        )
    }

    @Test
    fun navIntentTargetsMissionCardForBothPortalHandlers() {
        // mission.html requires target=="card" && cardId; kanban.html needs cardId.
        // The built JSON must include all three so either page routes correctly.
        assertTrue(
            "nav intent JSON must set targetTab=mission, target=card, and cardId.",
            fcmSrc.contains("\"targetTab\", \"mission\"") &&
                fcmSrc.contains("\"target\", \"card\"") &&
                fcmSrc.contains("\"cardId\", cardId")
        )
    }

    @Test
    fun deepLinkIntentReusesRunningInstanceViaSingleTop() {
        // Warm-resume correctness: without SINGLE_TOP the running MissionControl
        // instance (no singleTop launchMode in the manifest) is destroyed+
        // recreated instead of receiving the extra via onNewIntent.
        assertTrue(
            "tap intent flags must include FLAG_ACTIVITY_SINGLE_TOP so a running " +
                "instance receives the deep-link extra via onNewIntent.",
            fcmSrc.contains("FLAG_ACTIVITY_SINGLE_TOP")
        )
    }

    @Test
    fun missionControlReplaysNavIntentIntoWebView() {
        // The receiving side must exist and be wired: MissionControlActivity reads
        // the extra on cold start (onCreate) and warm resume (onNewIntent), then
        // replays it into the page once loaded.
        val mc = readSource("com/hank/clawlive/MissionControlActivity.kt")
        assertTrue(
            "MissionControlActivity must read EXTRA_NAV_INTENT in onCreate (cold start).",
            mc.contains("getStringExtra(EClawNativeNavBridge.EXTRA_NAV_INTENT)")
        )
        assertTrue(
            "MissionControlActivity must handle onNewIntent (warm resume).",
            mc.contains("override fun onNewIntent")
        )
        assertTrue(
            "MissionControlActivity must replay the pending nav intent after the page loads.",
            mc.contains("deliverPendingNavIntent()") &&
                mc.contains("buildIntentReplayJs")
        )
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
