package com.hank.clawlive

import com.hank.clawlive.ui.NavItem
import com.hank.clawlive.ui.NavResumeController
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Pure-JVM regression tests for card_489a8836 — app always routes to dashboard
 * (HOME) when the user switches away and then returns, instead of restoring the
 * screen they were on (e.g. Chat, Mission Control, Settings).
 *
 * The [NavResumeController] encapsulates the "save last tab + restore on
 * process-death restart" decision without touching Android APIs, so these tests
 * run on the host JVM with zero instrumentation overhead.
 *
 * ### What we assert
 * - Navigating to a non-HOME tab → `restoredNavItem()` returns that tab.
 * - Navigating to HOME clears the saved tab → `restoredNavItem()` returns null.
 * - After a pause→resume cycle on a non-HOME tab, the restored destination ==
 *   the last tab visited (not HOME).
 * - A fresh store (no prior session) → `restoredNavItem()` returns null
 *   (no redirect, land on dashboard as before).
 * - An unknown/stale value in the store is discarded → null (defensive).
 */
class NavResumeControllerTest {

    /** In-memory stand-in for SharedPreferences used in tests. */
    private class MapStore : NavResumeController.Store {
        val map = mutableMapOf<String, String>()
        override fun readLastNav(): String? = map["last_nav"]
        override fun writeLastNav(name: String) { map["last_nav"] = name }
        override fun clearLastNav() { map.remove("last_nav") }
    }

    private fun controller(store: MapStore = MapStore()) =
        NavResumeController(store) to store

    // ── Basic save/restore ────────────────────────────────────────────────

    @Test
    fun freshStore_returnsNull() {
        val (ctrl, _) = controller()
        assertNull(
            "No prior session should not redirect away from HOME",
            ctrl.restoredNavItem()
        )
    }

    @Test
    fun navigateToChat_restoresChat() {
        val (ctrl, _) = controller()
        ctrl.onNavigatedTo(NavItem.CHAT)
        assertEquals(
            "After navigating to CHAT, restore should return CHAT (not dashboard)",
            NavItem.CHAT,
            ctrl.restoredNavItem()
        )
    }

    @Test
    fun navigateToMission_restoresMission() {
        val (ctrl, _) = controller()
        ctrl.onNavigatedTo(NavItem.MISSION)
        assertEquals(NavItem.MISSION, ctrl.restoredNavItem())
    }

    @Test
    fun navigateToSettings_restoresSettings() {
        val (ctrl, _) = controller()
        ctrl.onNavigatedTo(NavItem.SETTINGS)
        assertEquals(NavItem.SETTINGS, ctrl.restoredNavItem())
    }

    // ── HOME clears the saved tab ─────────────────────────────────────────

    @Test
    fun navigateHomeAfterChat_clearsRestore() {
        val (ctrl, _) = controller()
        ctrl.onNavigatedTo(NavItem.CHAT)
        ctrl.onNavigatedTo(NavItem.HOME)
        assertNull(
            "Navigating back to HOME should clear the saved tab — no redirect on next restart",
            ctrl.restoredNavItem()
        )
    }

    @Test
    fun navigateHome_noPriorTab_returnsNull() {
        val (ctrl, _) = controller()
        ctrl.onNavigatedTo(NavItem.HOME)
        assertNull(ctrl.restoredNavItem())
    }

    // ── Pause → resume cycle (the core bug scenario) ─────────────────────

    @Test
    fun chatTab_pauseResumeCycle_restoresToChat_notDashboard() {
        // Simulates: user opens app, goes to Chat, presses home button (pause),
        // process is killed by OS, user re-opens app.
        // Expected: `restoredNavItem()` returns CHAT, not null (which would show dashboard).
        val store = MapStore()
        val ctrl1 = NavResumeController(store)
        ctrl1.onNavigatedTo(NavItem.CHAT) // "onResume" in ChatActivity

        // Simulate process death: new controller instance reads from same store.
        val ctrl2 = NavResumeController(store)
        assertEquals(
            "After Chat pause→process-death→restart, restored tab must be CHAT not HOME",
            NavItem.CHAT,
            ctrl2.restoredNavItem()
        )
    }

    @Test
    fun missionTab_pauseResumeCycle_restoresToMission() {
        val store = MapStore()
        NavResumeController(store).onNavigatedTo(NavItem.MISSION)
        assertEquals(NavItem.MISSION, NavResumeController(store).restoredNavItem())
    }

    @Test
    fun settingsTab_pauseResumeCycle_restoresToSettings() {
        val store = MapStore()
        NavResumeController(store).onNavigatedTo(NavItem.SETTINGS)
        assertEquals(NavItem.SETTINGS, NavResumeController(store).restoredNavItem())
    }

    // ── Multi-tab navigation history ──────────────────────────────────────

    @Test
    fun multiTabNavigation_lastTabWins() {
        // User: HOME → CHAT → MISSION → process death. Should restore MISSION.
        val store = MapStore()
        val ctrl = NavResumeController(store)
        ctrl.onNavigatedTo(NavItem.HOME)
        ctrl.onNavigatedTo(NavItem.CHAT)
        ctrl.onNavigatedTo(NavItem.MISSION)
        assertEquals(
            "The most recently visited non-HOME tab should be restored",
            NavItem.MISSION,
            NavResumeController(store).restoredNavItem()
        )
    }

    @Test
    fun navigateAwayFromHomeToChat_thenBackHome_thenToChatAgain_restoresChat() {
        val store = MapStore()
        val ctrl = NavResumeController(store)
        ctrl.onNavigatedTo(NavItem.CHAT)
        ctrl.onNavigatedTo(NavItem.HOME)
        ctrl.onNavigatedTo(NavItem.CHAT)
        assertEquals(NavItem.CHAT, NavResumeController(store).restoredNavItem())
    }

    // ── Defensive: stale/unknown store value ─────────────────────────────

    @Test
    fun unknownStoredValue_returnsNull() {
        val store = MapStore()
        store.map["last_nav"] = "NONEXISTENT_TAB"
        val ctrl = NavResumeController(store)
        assertNull(
            "Stale/unknown enum value in store should not crash — return null",
            ctrl.restoredNavItem()
        )
        // Also clears the stale value so next call stays null.
        assertNull("Stale value must be removed from store after detection", ctrl.restoredNavItem())
    }

    @Test
    fun homeStoredDirectly_returnsNull() {
        // Defensive: HOME should never be stored but if it is, return null.
        val store = MapStore()
        store.map["last_nav"] = NavItem.HOME.name
        val ctrl = NavResumeController(store)
        assertNull("Stored HOME must not trigger a HOME→HOME re-route", ctrl.restoredNavItem())
    }
}
